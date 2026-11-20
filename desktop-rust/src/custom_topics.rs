use super::{CUE_DATA, error};
use anyhow::{Context, Result};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::ErrorKind, path::PathBuf, sync::Mutex};

#[derive(Clone, Serialize)]
pub(super) struct Topic {
    id: String,
    prompt: String,
}

impl Topic {
    fn new(prompt: String) -> Self {
        // Reimporting the same list on another device reconnects its sessions.
        let id = format!(
            "custom-{:x}",
            Sha256::digest(prompt.to_lowercase().as_bytes())
        );
        Self { id, prompt }
    }
}

pub(super) struct TopicLibrary {
    file: PathBuf,
    topics: Mutex<Vec<Topic>>,
}

impl TopicLibrary {
    pub(super) fn open(file: PathBuf) -> Result<Self> {
        let prompts: Vec<String> = match fs::read(&file) {
            Ok(bytes) => {
                serde_json::from_slice(&bytes).context("Could not read imported topics.")?
            }
            Err(err) if err.kind() == ErrorKind::NotFound => Vec::new(),
            Err(err) => return Err(err.into()),
        };
        Ok(Self {
            file,
            topics: Mutex::new(prompts.into_iter().map(Topic::new).collect()),
        })
    }

    pub(super) fn list(&self) -> Vec<Topic> {
        self.topics.lock().unwrap().clone()
    }

    pub(super) fn contains(&self, id: &str) -> bool {
        self.topics
            .lock()
            .unwrap()
            .iter()
            .any(|topic| topic.id == id)
    }

    pub(super) fn import(&self, prompts: Vec<String>) -> Result<serde_json::Value> {
        let mut topics = self.topics.lock().unwrap();
        let mut known: HashSet<String> = CUE_DATA["cueCards"]
            .as_array()
            .unwrap()
            .iter()
            .map(|card| card["prompt"].as_str().unwrap().to_lowercase())
            .chain(topics.iter().map(|topic| topic.prompt.to_lowercase()))
            .collect();
        let mut added = Vec::new();
        let count = prompts.len();
        if count == 0 {
            return Err(error(400, "The file contains no topics."));
        }
        for prompt in prompts {
            let prompt = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
            if prompt.is_empty() || prompt.chars().count() > 400 {
                return Err(error(400, "Each topic must contain 1 to 400 characters."));
            }
            if known.insert(prompt.to_lowercase()) {
                added.push(Topic::new(prompt));
            }
        }
        if topics.len() + added.len() > 2000 {
            return Err(error(
                400,
                "Your library can hold up to 2,000 imported topics.",
            ));
        }
        let n = added.len();
        if n > 0 {
            let prompts: Vec<_> = topics
                .iter()
                .chain(&added)
                .map(|topic| &topic.prompt)
                .collect();
            let temp = self.file.with_extension("json.partial");
            fs::write(&temp, serde_json::to_vec(&prompts)?)?;
            fs::rename(temp, &self.file)?;
            topics.extend(added);
        }
        Ok(serde_json::json!({ "topics": *topics, "added": n, "skipped": count - n }))
    }
}
