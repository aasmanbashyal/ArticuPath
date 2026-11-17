//! In-progress takes use immutable, numbered chunks. A retry either confirms
//! identical bytes or fails; it never appends the same audio twice.
use super::*;
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Recording {
    details: Upload,
    created_at: String,
}

pub(super) async fn route(studio: &Arc<Studio>, req: Request, path: &str) -> Result<Response> {
    let studio = Arc::clone(studio);
    let path = path.to_owned();
    // Own the disk operation until completion, including after a client closes
    // its request. A subsequent retry must not race a pending filesystem write.
    tokio::spawn(async move { dispatch(&studio, req, &path).await }).await?
}

async fn dispatch(studio: &Arc<Studio>, req: Request, path: &str) -> Result<Response> {
    if path == "/api/recordings" && req.method() == Method::POST {
        let details: Upload = serde_json::from_value(read_json(req).await?)
            .map_err(|_| error(400, "Could not read the recording details."))?;
        details.validate()?;
        if !studio.media.ready() { return Err(error(503, "Media support is unavailable.")); }
        let id = Uuid::new_v4().to_string();
        let folder = studio.sessions.new_folder(&id);
        fs::create_dir(&folder).await.map_err(|_| error(409, "Could not write to the recording folder. Check Storage in Settings."))?;
        let recording = Recording { details, created_at: time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)? };
        fs::create_dir(folder.join("chunks")).await?;
        let mut file = fs::File::create(folder.join("capture.json.partial")).await?;
        file.write_all(&serde_json::to_vec(&recording)?).await?;
        file.sync_all().await?;
        drop(file);
        fs::rename(folder.join("capture.json.partial"), folder.join("capture.json")).await?;
        sync_directory(&folder).await?;
        sync_directory(folder.parent().context("Missing recording parent")?).await?;
        return Ok(respond(StatusCode::CREATED, json!({"id": id})));
    }
    let (id, action) = path.strip_prefix("/api/recordings/")
        .and_then(|suffix| suffix.split_once('/')).unwrap_or(("", ""));
    let id = Uuid::parse_str(id).map_err(|_| error(404, "Recording not found."))?.to_string();
    // Distinct from the final session lock: finalization also takes the commit
    // lock used by retention and storage changes.
    let _guard = studio.sessions.lock(&format!("capture-{id}")).await;
    let folder = studio.sessions.folder(&id);
    if action == "finish" && req.method() == Method::POST {
        if let Some(session) = studio.sessions.read::<Value>(&id).await? {
            return Ok(respond(StatusCode::OK, session));
        }
    }
    let recording = read(&folder).await?;
    match (action, req.method()) {
        ("finish", &Method::POST) => {
            let studio = Arc::clone(studio);
            // Finalization must commit even if the browser reloads or closes.
            let task = tokio::spawn(async move {
                let _guard = _guard;
                let extension = recording.details.validate()?;
                let size = assemble(&folder, &format!("recording.{extension}")).await?;
                let value = studio.finish_media(&id, &folder, &recording.details, size).await?;
                // session.json is the commit point. Leftover chunks after a
                // crash are ignored and cannot cause a duplicate session.
                let _ = fs::remove_file(folder.join("capture.json")).await;
                let _ = fs::remove_dir_all(folder.join("chunks")).await;
                Ok::<_, anyhow::Error>(value)
            });
            Ok(respond(StatusCode::OK, task.await??))
        }
        ("discard", &Method::DELETE) => {
            let session_guard = studio.sessions.lock(&id).await;
            if studio.sessions.read::<Value>(&id).await?.is_some() {
                return Err(error(409, "This take is already saved. Delete it from the library."));
            }
            studio.sessions.delete(&id, session_guard).await?;
            Ok(respond(StatusCode::OK, json!({"deleted": true})))
        }
        ("media", method) if method == Method::GET || method == Method::HEAD => {
            let extension = recording.details.validate()?;
            let name = format!("recovery.{extension}");
            assemble(&folder, &name).await?;
            let file = fs::File::open(folder.join(&name)).await?;
            let mut response = file_body(file, req.headers(), method == Method::HEAD,
                media_type(&extension).unwrap(), studio.transport).await?;
            response.headers_mut().insert("Content-Disposition", format!("attachment; filename=\"{name}\"").parse()?);
            Ok(response)
        }
        (_, &Method::PUT) if action.starts_with("chunks/") => {
            if studio.sessions.read::<Value>(&id).await?.is_some() {
                return Err(error(409, "This recording has already been saved."));
            }
            let sequence: usize = action[7..].parse().ok().filter(|n| *n < 4096)
                .ok_or_else(|| error(400, "Invalid recording chunk."))?;
            let chunks = chunks(&folder).await?;
            if sequence > chunks.len() { return Err(error(409, "Send recording chunks in order.")); }
            let replacing = chunks.get(sequence).map(|(_, size)| *size).unwrap_or(0);
            let previous: u64 = chunks.iter().map(|(_, size)| size).sum::<u64>() - replacing;
            let target = folder.join("chunks").join(format!("{sequence:04}.chunk"));
            let temporary = folder.join("chunks").join(format!("{sequence:04}.partial"));
            let mut file = fs::File::create(&temporary).await?;
            let mut stream = req.into_body().into_data_stream();
            let mut size = 0_u64;
            let mut hash = Sha256::new();
            let received = async {
                while let Some(bytes) = stream.next().await {
                    let bytes = bytes?;
                    size += bytes.len() as u64;
                    if previous + size > MAX_BYTES { return Err(error(413, "Recordings must be smaller than 160 MiB.")); }
                    file.write_all(&bytes).await?;
                    hash.update(&bytes);
                }
                Ok(())
            }.await;
            // Tokio files may still have a blocking write in flight after
            // write_all returns. Drain it before releasing the capture lock.
            let flushed = file.flush().await;
            if let Err(err) = received {
                drop(file);
                let _ = fs::remove_file(temporary).await;
                return Err(err);
            }
            flushed?;
            if size == 0 { return Err(error(400, "Empty recording chunk.")); }
            file.sync_all().await?;
            drop(file);
            if replacing != 0 {
                let mut existing = fs::File::open(&target).await?;
                let mut existing_hash = Sha256::new();
                let mut buffer = vec![0; MEDIA_BUFFER];
                loop {
                    let count = existing.read(&mut buffer).await?;
                    if count == 0 { break; }
                    existing_hash.update(&buffer[..count]);
                }
                let _ = fs::remove_file(temporary).await;
                if existing_hash.finalize() != hash.finalize() {
                    return Err(error(409, "A different chunk was already saved at this position."));
                }
            } else {
                fs::rename(temporary, target).await?;
                sync_directory(&folder.join("chunks")).await?;
            }
            Ok(respond(StatusCode::OK, json!({"sequence": sequence, "bytes": previous + size})))
        }
        _ => Err(error(404, "Not found.")),
    }
}

impl Studio {
    pub(super) async fn recordings(&self) -> Result<Value> {
        let mut recordings = Vec::new();
        for root in self.sessions.storage().folders {
            let Ok(mut folders) = fs::read_dir(root).await else { continue };
            while let Some(entry) = folders.next_entry().await? {
                let name = entry.file_name().to_string_lossy().into_owned();
                if Uuid::parse_str(&name).is_err() || !plain_path(&entry.path(), true) { continue; }
                let folder = entry.path();
                if folder.join("session.json").exists() { continue; }
                if let Ok(recording) = read(&folder).await {
                    let bytes: u64 = chunks(&folder).await.unwrap_or_default().iter().map(|(_, size)| size).sum();
                    recordings.push(json!({"id": name, "title": title(recording.details.title.as_deref(), "recording"),
                        "createdAt": recording.created_at, "bytes": bytes}));
                }
            }
        }
        Ok(json!(recordings))
    }
}

async fn read(folder: &Path) -> Result<Recording> {
    let path = folder.join("capture.json");
    if !plain_path(folder, true) || !plain_path(&path, false) {
        return Err(error(404, "Recording not found."));
    }
    Ok(serde_json::from_slice(&fs::read(path).await?)?)
}

async fn chunks(folder: &Path) -> Result<Vec<(PathBuf, u64)>> {
    let directory = folder.join("chunks");
    if !plain_path(&directory, true) { return Err(error(404, "Recording chunks not found.")); }
    let mut result = Vec::new();
    // Only consecutive committed chunks form a playable recording. .partial
    // files from an interrupted write are deliberately excluded.
    for sequence in 0..4096 {
        let path = directory.join(format!("{sequence:04}.chunk"));
        if !plain_path(&path, false) { break; }
        result.push((path.clone(), fs::metadata(path).await?.len()));
    }
    Ok(result)
}

async fn assemble(folder: &Path, name: &str) -> Result<u64> {
    let chunks = chunks(folder).await?;
    if chunks.is_empty() { return Err(error(400, "No complete recording chunks reached disk.")); }
    let mut file = fs::File::create(folder.join(name)).await?;
    let mut size = 0;
    for (path, _) in chunks {
        let mut chunk = fs::File::open(path).await?;
        size += tokio::io::copy(&mut chunk, &mut file).await?;
    }
    file.sync_all().await?;
    Ok(size)
}

async fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    fs::File::open(path).await?.sync_all().await?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}
