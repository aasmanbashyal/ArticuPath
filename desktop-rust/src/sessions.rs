use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock, Weak},
};
use std::io::Write;
use tokio::{
    fs,
    sync::{Mutex as AsyncMutex, OwnedMutexGuard},
};
use uuid::Uuid;

/// Session JSON stays the source of truth. A lock protects each take while its
/// metadata is changed, its playback file is prepared/opened, or it is deleted.
pub(super) struct Sessions {
    settings_file: Option<PathBuf>,
    storage: RwLock<Storage>,
    pub(super) commit: AsyncMutex<()>,
    locks: Mutex<HashMap<String, Weak<AsyncMutex<()>>>>,
}

#[derive(Clone, Serialize, Deserialize)]
pub(super) struct Storage {
    folder: PathBuf,
    pub(super) folders: Vec<PathBuf>,
    pub(super) keep: Option<usize>,
}

impl Storage {
    pub(super) fn preferences(&self) -> Value {
        let folder = self.folder.to_string_lossy();
        #[cfg(windows)]
        let folder = if let Some(path) = folder.strip_prefix(r"\\?\UNC\") {
            std::borrow::Cow::Owned(format!(r"\\{path}"))
        } else if let Some(path) = folder.strip_prefix(r"\\?\") {
            std::borrow::Cow::Borrowed(path)
        } else {
            folder
        };
        serde_json::json!({ "folder": folder, "keep": self.keep })
    }
}

impl Sessions {
    #[cfg(test)]
    pub(super) fn new(root: PathBuf) -> Self {
        Self::open(root, None)
    }

    pub(super) fn open(root: PathBuf, settings_file: Option<PathBuf>) -> Self {
        let initial = Storage {
            folder: root.clone(),
            folders: vec![root],
            keep: None,
        };
        let storage = settings_file
            .as_ref()
            .and_then(|path| {
                let config: Storage = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
                (config.folder.is_absolute()
                    && config.folders.contains(&config.folder)
                    && config.folders.iter().all(|path| path.is_absolute())
                    && config.keep.is_none_or(|keep| (1..=10_000).contains(&keep)))
                .then_some(config)
            })
            .unwrap_or(initial);
        Self {
            settings_file,
            storage: RwLock::new(storage),
            commit: Default::default(),
            locks: Mutex::default(),
        }
    }

    pub(super) fn storage(&self) -> Storage {
        self.storage.read().unwrap().clone()
    }

    pub(super) fn configure(&self, folder: &Path, keep: Option<usize>) -> Result<Storage> {
        ensure!(
            folder.is_absolute(),
            "Enter the full path to an existing folder."
        );
        let folder = folder
            .canonicalize()
            .context("Choose an existing folder.")?;
        let mut storage = self.storage();
        if folder != storage.folder {
            let probe = folder.join(format!(".rehearse-write-check-{}", Uuid::new_v4()));
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&probe)
                .and_then(|file| {
                    drop(file);
                    std::fs::remove_file(probe)
                })
                .context("Choose a folder ArticuPath can write to.")?;
        }
        if !storage.folders.contains(&folder) {
            storage.folders.push(folder.clone());
        }
        storage.folder = folder;
        storage.keep = keep;
        let config = self
            .settings_file
            .as_ref()
            .context("Storage settings are unavailable.")?;
        let temporary = config.with_extension(format!("{}.partial", Uuid::new_v4()));
        if let Err(err) = std::fs::write(&temporary, serde_json::to_vec(&storage)?)
            .and_then(|()| std::fs::rename(&temporary, config))
        {
            let _ = std::fs::remove_file(temporary);
            return Err(err).context("Could not save storage settings.");
        }
        *self.storage.write().unwrap() = storage.clone();
        Ok(storage)
    }

    pub(super) fn new_folder(&self, id: &str) -> PathBuf {
        self.storage.read().unwrap().folder.join(id)
    }

    pub(super) fn folder(&self, id: &str) -> PathBuf {
        let storage = self.storage.read().unwrap();
        storage
            .folders
            .iter()
            .map(|path| path.join(id))
            .find(|path| plain_path(path, true))
            .unwrap_or_else(|| storage.folder.join(id))
    }

    pub(super) async fn lock(&self, id: &str) -> OwnedMutexGuard<()> {
        let lock = {
            let mut locks = self.locks.lock().unwrap();
            if let Some(lock) = locks.get(id).and_then(Weak::upgrade) {
                lock
            } else {
                locks.retain(|_, lock| lock.strong_count() > 0);
                let lock = Arc::new(AsyncMutex::new(()));
                locks.insert(id.to_owned(), Arc::downgrade(&lock));
                lock
            }
        };
        lock.lock_owned().await
    }

    pub(super) async fn list(&self) -> Result<Vec<Value>> {
        Ok(self.scan().await?.0)
    }

    pub(super) async fn scan(&self) -> Result<(Vec<Value>, bool)> {
        let folders = self.storage().folders;
        // Keep the directory walk, small file reads and JSON parsing in one
        // blocking task instead of switching to the blocking pool for each file.
        tokio::task::spawn_blocking(move || {
            let mut values = Vec::<Value>::new();
            let mut complete = true;
            let mut seen = HashSet::new();
            for root in folders {
                let Ok(entries) = std::fs::read_dir(root) else {
                    complete = false;
                    continue;
                };
                for entry in entries {
                    let Ok(entry) = entry else {
                        complete = false;
                        continue;
                    };
                    let name = entry.file_name();
                    let Some(id) = name.to_str().filter(|id| Uuid::parse_str(id).is_ok()) else {
                        continue;
                    };
                    let path = entry.path();
                    let file = metadata(&path);
                    if plain_path(&path, true)
                        && plain_path(&file, false)
                        && let Ok(bytes) = std::fs::read(file)
                        && let Ok(session) = serde_json::from_slice::<Value>(&bytes)
                        && session["id"] == id
                        && seen.insert(id.to_owned())
                    {
                        values.push(session);
                    }
                }
            }
            let date = |row: &Value| {
                time::OffsetDateTime::parse(
                    row["createdAt"].as_str().unwrap_or_default(),
                    &time::format_description::well_known::Rfc3339,
                )
                .ok()
            };
            values.sort_by_cached_key(|row| std::cmp::Reverse(date(row)));
            Ok((values, complete))
        })
        .await?
    }

    pub(super) async fn read<T: DeserializeOwned>(&self, id: &str) -> Result<Option<T>> {
        let folder = self.folder(id);
        let file = metadata(&folder);
        if !plain_path(&folder, true) || !plain_path(&file, false) {
            return Ok(None);
        }
        let bytes = match fs::read(file).await {
            Ok(bytes) => bytes,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(err) => return Err(err.into()),
        };
        Ok(Some(serde_json::from_slice(&bytes)?))
    }

    pub(super) async fn save(
        &self,
        id: &str,
        value: Value,
        guard: OwnedMutexGuard<()>,
    ) -> Result<Value> {
        let folder = self.folder(id);
        // The write and rename own the lock until they finish, even if the
        // request awaiting this task is dropped.
        while_locked(guard, move || {
            let bytes = serde_json::to_vec(&value)?;
            let temp = folder.join(format!(".session-{}.partial", Uuid::new_v4()));
            let write = || -> std::io::Result<()> {
                let mut file = std::fs::File::create(&temp)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                drop(file);
                std::fs::rename(&temp, metadata(&folder))?;
                #[cfg(unix)]
                std::fs::File::open(&folder)?.sync_all()?;
                Ok(())
            };
            if let Err(err) = write()
            {
                let _ = std::fs::remove_file(temp);
                return Err(err.into());
            }
            Ok(value)
        })
        .await
    }

    pub(super) async fn delete(&self, id: &str, guard: OwnedMutexGuard<()>) -> Result<()> {
        let folder = self.folder(id);
        while_locked(guard, move || Ok(std::fs::remove_dir_all(folder)?)).await
    }
}

pub(super) fn plain_path(path: &Path, directory: bool) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|metadata| {
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            // Reject reparse points, including junctions, inside session folders.
            if metadata.file_attributes() & 0x400 != 0 {
                return false;
            }
        }
        if directory {
            metadata.is_dir()
        } else {
            metadata.is_file()
        }
    })
}

async fn while_locked<T: Send + 'static>(
    guard: OwnedMutexGuard<()>,
    operation: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(move || {
        let _guard = guard;
        operation()
    })
    .await?
}

fn metadata(folder: &Path) -> PathBuf {
    folder.join("session.json")
}

#[cfg(test)]
mod tests {
    use super::{Sessions, while_locked};
    use futures_util::FutureExt;
    use std::time::Duration;

    #[tokio::test]
    async fn session_work_blocks_only_requests_for_the_same_take() {
        let sessions = Sessions::new(Default::default());
        let preparing = sessions.lock("take-1").await;
        assert!(sessions.lock("take-2").now_or_never().is_some());
        assert!(sessions.lock("take-1").now_or_never().is_none());
        drop(preparing);
        assert!(sessions.lock("take-1").now_or_never().is_some());
    }

    #[tokio::test]
    async fn cancelling_the_waiter_does_not_unlock_a_disk_mutation() {
        let sessions = Sessions::new(Default::default());
        let guard = sessions.lock("take").await;
        let (started, entered) = tokio::sync::oneshot::channel();
        let (release, finish) = std::sync::mpsc::channel();
        let waiter = tokio::spawn(while_locked(guard, move || {
            started.send(()).unwrap();
            finish.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        }));
        entered.await.unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        assert!(sessions.lock("take").now_or_never().is_none());
        release.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(5), sessions.lock("take"))
                .await
                .is_ok()
        );
    }
}
