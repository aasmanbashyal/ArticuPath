use crate::{
    media::{MAX_SECONDS, Probe},
    native_audio::Pcm,
};
use anyhow::{Context, Result, bail};
use std::{os::windows::ffi::OsStrExt, path::Path};
use windows::{
    Win32::{
        Media::MediaFoundation as mf,
        System::Com::{
            COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize,
            StructuredStorage::{PropVariantClear, PropVariantToInt64},
        },
    },
    core::PCWSTR,
};

const AUDIO: u32 = mf::MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
const VIDEO: u32 = mf::MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
const TICKS_PER_SECOND: f64 = 10_000_000.0;

struct Platform;

impl Platform {
    fn start() -> Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
            if let Err(error) = mf::MFStartup(mf::MF_VERSION, mf::MFSTARTUP_LITE) {
                CoUninitialize();
                return Err(error.into());
            }
        }
        Ok(Self)
    }
}

impl Drop for Platform {
    fn drop(&mut self) {
        unsafe {
            let _ = mf::MFShutdown();
            CoUninitialize();
        }
    }
}

fn reader(path: &Path) -> Result<mf::IMFSourceReader> {
    let wide: Vec<u16> = path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    unsafe {
        let stream = mf::MFCreateFile(
            mf::MF_ACCESSMODE_READ,
            mf::MF_OPENMODE_FAIL_IF_NOT_EXIST,
            mf::MF_FILEFLAGS_NONE,
            PCWSTR(wide.as_ptr()),
        )?;
        Ok(mf::MFCreateSourceReaderFromByteStream(
            &stream,
            None::<&mf::IMFAttributes>,
        )?)
    }
}

pub fn probe(path: &Path) -> Result<Probe> {
    let _platform = Platform::start()?;
    let reader = reader(path)?;
    unsafe { reader.GetNativeMediaType(AUDIO, 0) }
        .context("This file has no audio track to transcribe.")?;
    let video = unsafe { reader.GetNativeMediaType(VIDEO, 0) }.is_ok();
    let declared = unsafe {
        reader
            .GetPresentationAttribute(
                mf::MF_SOURCE_READER_MEDIASOURCE.0 as u32,
                &mf::MF_PD_DURATION,
            )
            .ok()
            .and_then(|mut value| {
                let ticks = PropVariantToInt64(&value).ok();
                let _ = PropVariantClear(&mut value);
                ticks
            })
            .filter(|ticks| *ticks > 0)
            .map_or(0.0, |ticks| ticks as f64 / TICKS_PER_SECOND)
    };
    let mut duration = declared;
    if duration < 0.1 {
        select_audio(&reader)?;
        for _ in 0..1_000_000 {
            let (flags, timestamp, sample) = read_sample(&reader)?;
            if let Some(sample) = sample {
                let length = unsafe { sample.GetSampleDuration() }.unwrap_or(0);
                duration = duration.max(timestamp.saturating_add(length) as f64 / TICKS_PER_SECOND);
            }
            if end(flags) || duration > MAX_SECONDS + 0.5 {
                break;
            }
        }
    }
    Ok(Probe {
        video,
        duration,
        container_duration: declared,
    })
}

pub fn decode(path: &Path, output: &Path) -> Result<()> {
    let _platform = Platform::start()?;
    let reader = reader(path)?;
    select_audio(&reader)?;
    let (rate, channels) = unsafe {
        let pcm = mf::MFCreateMediaType()?;
        pcm.SetGUID(&mf::MF_MT_MAJOR_TYPE, &mf::MFMediaType_Audio)?;
        pcm.SetGUID(&mf::MF_MT_SUBTYPE, &mf::MFAudioFormat_PCM)?;
        pcm.SetUINT32(&mf::MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
        reader.SetCurrentMediaType(AUDIO, None, &pcm)?;
        let format = reader.GetCurrentMediaType(AUDIO)?;
        if format.GetUINT32(&mf::MF_MT_AUDIO_BITS_PER_SAMPLE)? != 16 {
            bail!("Expected 16-bit PCM.");
        }
        (
            format.GetUINT32(&mf::MF_MT_AUDIO_SAMPLES_PER_SECOND)?,
            format.GetUINT32(&mf::MF_MT_AUDIO_NUM_CHANNELS)? as usize,
        )
    };
    if channels == 0 || channels > 32 {
        bail!("Unsupported audio channel layout.");
    }
    let mut writer = Pcm::new(output, rate)?;
    let mut remaining = rate as usize * MAX_SECONDS as usize;
    while remaining > 0 {
        let (flags, _, sample) = read_sample(&reader)?;
        if flags & mf::MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED.0 as u32 != 0 {
            bail!("Recording changes audio format.");
        }
        if let Some(sample) = sample {
            let buffer = unsafe { sample.ConvertToContiguousBuffer()? };
            let mut raw = std::ptr::null_mut();
            let mut bytes = 0;
            unsafe { buffer.Lock(&mut raw, None, Some(&mut bytes))? };
            let result = (|| -> Result<()> {
                if bytes == 0 {
                    return Ok(());
                }
                if raw.is_null() {
                    bail!("Audio buffer has no samples.");
                }
                let samples = unsafe { std::slice::from_raw_parts(raw, bytes as usize) };
                for frame in samples.chunks_exact(channels * 2).take(remaining) {
                    let sum: i32 = frame
                        .chunks_exact(2)
                        .map(|sample| i32::from(i16::from_le_bytes([sample[0], sample[1]])))
                        .sum();
                    writer.push(sum as f32 / (32768.0 * channels as f32))?;
                    remaining -= 1;
                }
                Ok(())
            })();
            unsafe { buffer.Unlock()? };
            result?;
        }
        if end(flags) {
            break;
        }
    }
    writer.finish()
}

fn select_audio(reader: &mf::IMFSourceReader) -> Result<()> {
    unsafe {
        reader.SetStreamSelection(mf::MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)?;
        reader.SetStreamSelection(AUDIO, true)?;
    }
    Ok(())
}

fn read_sample(reader: &mf::IMFSourceReader) -> Result<(u32, i64, Option<mf::IMFSample>)> {
    let (mut flags, mut timestamp, mut sample) = (0, 0, None);
    unsafe {
        reader.ReadSample(
            AUDIO,
            0,
            None,
            Some(&mut flags),
            Some(&mut timestamp),
            Some(&mut sample),
        )?
    };
    if flags & mf::MF_SOURCE_READERF_ERROR.0 as u32 != 0 {
        bail!("Windows could not read the audio stream.");
    }
    Ok((flags, timestamp, sample))
}

fn end(flags: u32) -> bool {
    flags & mf::MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0
}
