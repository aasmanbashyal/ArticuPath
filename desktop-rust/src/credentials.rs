use anyhow::Result;
use keyring::{Entry, Error as KeyringError};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(crate) struct OpenAiCredentials {
    account: String,
}

impl OpenAiCredentials {
    pub(crate) fn new(settings_path: &Path) -> Self {
        // A second app profile and isolated test runs must have separate entries.
        let profile = Sha256::digest(settings_path.as_os_str().as_encoded_bytes());
        Self {
            account: format!("OpenAI-{profile:x}"),
        }
    }

    async fn access<T: Send + 'static>(
        &self,
        operation: impl FnOnce(Entry) -> keyring::Result<T> + Send + 'static,
    ) -> Result<T> {
        let account = self.account.clone();
        tokio::task::spawn_blocking(move || operation(Entry::new("Rehearsal", &account)?))
            .await?
            .map_err(|_| anyhow::anyhow!("Could not access the system credential store. Unlock your keyring and try again."))
    }

    pub(crate) async fn read(&self) -> Result<Option<String>> {
        self.access(|entry| match entry.get_password() {
            Ok(key) => Ok(Some(key)),
            Err(KeyringError::NoEntry) => Ok(None),
            Err(err) => Err(err),
        })
        .await
    }

    pub(crate) async fn save(&self, key: String) -> Result<()> {
        self.access(move |entry| entry.set_password(&key)).await
    }

    pub(crate) async fn remove(&self) -> Result<()> {
        self.access(|entry| match entry.delete_credential() {
            Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
            Err(err) => Err(err),
        })
        .await
    }
}
