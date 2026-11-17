use anyhow::{Context, Result, bail};
#[cfg(feature = "full-media")]
use serde_json::Value;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;

pub const MAX_BYTES: u64 = 160 * 1024 * 1024;
pub const MAX_SECONDS: f64 = 900.0;
#[cfg(windows)]
pub const LIBRARY_SEARCH_PATH: &str = "PATH";
#[cfg(target_os = "macos")]
pub const LIBRARY_SEARCH_PATH: &str = "DYLD_LIBRARY_PATH";
#[cfg(not(any(windows, target_os = "macos")))]
pub const LIBRARY_SEARCH_PATH: &str = "LD_LIBRARY_PATH";

pub fn command(program: &Path) -> Command {
    let mut command = Command::new(program);
    command.kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    command
}

pub struct Media {
    #[cfg(feature = "full-media")]
    ffmpeg: PathBuf,
    #[cfg(feature = "full-media")]
    ffprobe: PathBuf,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Savings {
    pub original_bytes: u64,
    pub saved_bytes: u64,
}

pub struct Probe {
    pub video: bool,
    pub duration: f64,
    pub container_duration: f64,
}

#[cfg(not(feature = "full-media"))]
impl Media {
    pub fn new(_resources: &Path) -> Self {
        Self {}
    }

    pub fn ready(&self) -> bool {
        true
    }

    pub async fn probe(&self, input: &Path) -> Result<Probe> {
        let input = input.to_path_buf();
        tokio::task::spawn_blocking(move || crate::native_audio::probe(&input)).await?
    }

    pub async fn decode_audio(&self, input: &Path, target: &Path) -> Result<()> {
        let (input, target) = (input.to_path_buf(), target.to_path_buf());
        tokio::task::spawn_blocking(move || crate::native_audio::decode_audio(&input, &target))
            .await?
    }
}

#[cfg(feature = "full-media")]
impl Media {
    pub fn new(resources: &Path) -> Self {
        let locate = |name: &str, setting| {
            let bundled = resources.join("media").join(format!("{name}.exe"));
            if bundled.is_file() {
                bundled
            } else {
                std::env::var_os(setting).map_or_else(|| PathBuf::from(name), PathBuf::from)
            }
        };
        Self {
            ffmpeg: locate("ffmpeg", "FFMPEG_BIN"),
            ffprobe: locate("ffprobe", "FFPROBE_BIN"),
        }
    }

    pub fn ready(&self) -> bool {
        let available = |program: &Path| {
            program.is_file()
                || std::env::var_os("PATH").is_some_and(|path| {
                    std::env::split_paths(&path).any(|folder| {
                        let path = folder.join(program);
                        path.is_file()
                            || (cfg!(windows)
                                && path.extension().is_none()
                                && path.with_extension("exe").is_file())
                    })
                })
        };
        available(&self.ffmpeg) && available(&self.ffprobe)
    }

    pub async fn probe(&self, input: &Path) -> Result<Probe> {
        let value: Value = serde_json::from_str(&self.probe_output(input, &[
            "-show_entries", "format=duration:stream=codec_type,duration:stream_disposition=attached_pic", "-of", "json",
        ]).await?)?;
        let streams = value["streams"]
            .as_array()
            .context("No media streams found.")?;
        if !streams.iter().any(|stream| stream["codec_type"] == "audio") {
            bail!("This file has no audio track to transcribe.");
        }
        let video = streams.iter().any(|stream| {
            stream["codec_type"] == "video"
                && stream["disposition"]["attached_pic"].as_i64() != Some(1)
        });
        let container_duration = seconds(&value["format"]["duration"]);
        let duration = streams.iter().fold(container_duration, |duration, stream| {
            duration.max(seconds(&stream["duration"]))
        });
        Ok(Probe {
            video,
            duration,
            container_duration,
        })
    }

    pub async fn webm_duration(&self, input: &Path) -> Result<f64> {
        Ok(self
            .probe_output(
                input,
                &["-show_entries", "format=duration", "-of", "csv=p=0"],
            )
            .await?
            .trim()
            .parse()
            .unwrap_or(0.0))
    }

    pub async fn packet_duration(&self, input: &Path) -> Result<f64> {
        let output = self
            .probe_output(
                input,
                &[
                    "-show_entries",
                    "packet=pts_time,duration_time",
                    "-of",
                    "csv=p=0",
                ],
            )
            .await?;
        Ok(output.lines().fold(0.0_f64, |duration, line| {
            let mut parts = line.split(',');
            let mut seconds = || {
                parts
                    .next()
                    .and_then(|value| value.parse::<f64>().ok())
                    .unwrap_or(0.0)
            };
            duration.max(seconds() + seconds())
        }))
    }

    async fn probe_output(&self, input: &Path, options: &[&str]) -> Result<String> {
        let mut command = command(&self.ffprobe);
        command
            .args(["-v", "error", "-protocol_whitelist", "file"])
            .args(options)
            .arg(input);
        output(command, 30).await
    }

    fn convert(&self, input: &Path) -> Command {
        let mut command = command(&self.ffmpeg);
        command
            .args([
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-protocol_whitelist",
                "file",
                "-i",
            ])
            .arg(input);
        command
    }

    pub async fn index_video(&self, input: &Path, target: &Path) -> Result<()> {
        let mut command = self.convert(input);
        command.args(["-map", "0", "-c", "copy"]).arg(target);
        output(command, 30).await.map(|_| ())
    }

    pub async fn decode_audio(&self, input: &Path, target: &Path) -> Result<()> {
        let mut command = self.convert(input);
        command
            .args([
                "-map", "0:a:0", "-vn", "-t", "900", "-ac", "1", "-ar", "16000", "-f", "f32le",
            ])
            .arg(target);
        output(command, 30).await.map(|_| ())
    }

    pub async fn compress(
        &self,
        input: &Path,
        target: &Path,
        video: bool,
        duration: f64,
        original_bytes: u64,
    ) -> Option<Savings> {
        let minimum = if video { 640_000.0 } else { 46_000.0 };
        if original_bytes as f64 * 8.0 / duration < minimum {
            return None;
        }
        let mut command = self.convert(input);
        command.args([
            "-map",
            "0:a:0",
            "-map_metadata",
            "-1",
            "-map_chapters",
            "-1",
        ]);
        if video {
            command.args([
                "-map", "0:V:0", "-vf", "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,fps=24",
                "-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "35", "-deadline", "realtime", "-cpu-used", "6", "-row-mt", "1", "-threads", "4",
            ]);
        } else {
            command.arg("-vn");
        }
        command
            .args(["-c:a", "libopus", "-ac", "1", "-b:a", "32k"])
            .arg(target);
        if output(command, 300).await.is_ok()
            && let Ok(file) = tokio::fs::metadata(target).await
            && (1..original_bytes).contains(&file.len())
        {
            return Some(Savings {
                original_bytes,
                saved_bytes: file.len(),
            });
        }
        let _ = tokio::fs::remove_file(target).await;
        None
    }
}

pub async fn output(mut command: Command, timeout: u64) -> Result<String> {
    let result = tokio::time::timeout(Duration::from_secs(timeout), command.output()).await??;
    if !result.status.success() {
        let message = String::from_utf8_lossy(&result.stderr);
        bail!(
            "{}: {}",
            result.status,
            message.chars().take(1000).collect::<String>()
        );
    }
    Ok(String::from_utf8(result.stdout)?)
}

pub fn executable() -> Result<PathBuf> {
    Ok(std::env::current_exe()?)
}

pub fn library_path(library: &Path) -> Result<OsString> {
    let path = std::env::var_os(LIBRARY_SEARCH_PATH);
    Ok(std::env::join_paths(
        std::iter::once(
            library
                .parent()
                .context("Missing engine directory.")?
                .to_path_buf(),
        )
        .chain(path.iter().flat_map(std::env::split_paths)),
    )?)
}

#[cfg(feature = "full-media")]
fn seconds(value: &Value) -> f64 {
    value
        .as_f64()
        .or_else(|| value.as_str()?.parse().ok())
        .filter(|number| number.is_finite())
        .unwrap_or(0.0)
}
