use crate::media::{MAX_SECONDS, Probe};
use anyhow::{Context, Result, bail};
use rubato::{FftFixedInOut, Resampler};
use std::{
    fs::File,
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::LazyLock,
};
use symphonia::core::{
    codecs::{audio::AudioDecoderOptions, registry::CodecRegistry},
    common::Tier,
    errors::Error,
    formats::{FormatReader, TrackType, probe::Hint},
    io::MediaSourceStream,
    packet::Packet,
};

const OUTPUT_HZ: u32 = 16_000;
const MAX_SAMPLES: usize = MAX_SECONDS as usize * OUTPUT_HZ as usize;

static CODECS: LazyLock<CodecRegistry> = LazyLock::new(|| {
    let mut codecs = CodecRegistry::new();
    symphonia::default::register_enabled_codecs(&mut codecs);
    codecs.register_audio_decoder_at_tier::<symphonia_opus::OpusDecoder>(Tier::Fallback);
    codecs
});

fn open(path: &Path) -> Result<Box<dyn FormatReader>> {
    let stream = MediaSourceStream::new(Box::new(File::open(path)?), Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|extension| extension.to_str()) {
        hint.with_extension(extension);
    }
    Ok(symphonia::default::get_probe().probe(
        &hint,
        stream,
        Default::default(),
        Default::default(),
    )?)
}

fn next_packet(format: &mut dyn FormatReader) -> Result<Option<Packet>> {
    match format.next_packet() {
        Err(Error::IoError(err)) if err.kind() == std::io::ErrorKind::UnexpectedEof => Ok(None),
        result => Ok(result?),
    }
}

pub(super) fn fragmented_mp4(path: &Path) -> std::io::Result<bool> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let mut offset = 0;
    // Read top-level box headers and seek over media payloads.
    while length - offset >= 8 {
        let mut header = [0; 8];
        file.read_exact(&mut header)?;
        let size = u32::from_be_bytes(header[..4].try_into().unwrap());
        if &header[4..] == b"moof" {
            return Ok(true);
        }
        let (size, header_length) = if size == 1 && length - offset >= 16 {
            let mut extended = [0; 8];
            file.read_exact(&mut extended)?;
            (u64::from_be_bytes(extended), 16)
        } else {
            (u64::from(size), 8)
        };
        if size < header_length || size > length - offset {
            break;
        }
        offset += size;
        file.seek(SeekFrom::Start(offset))?;
    }
    Ok(false)
}

#[cfg(windows)]
fn use_windows_reader(path: &Path, error: &anyhow::Error) -> bool {
    matches!(
        path.extension().and_then(|ext| ext.to_str()),
        Some("mp4" | "m4a" | "mov")
    ) && matches!(
        error.downcast_ref(),
        Some(Error::DecodeError(
            "common (mp4): missing sl config descriptor"
        ))
    )
}

pub fn probe(path: &Path) -> Result<Probe> {
    let mut format = match open(path) {
        #[cfg(windows)]
        Err(error) if use_windows_reader(path, &error) => return crate::windows_media::probe(path),
        result => result.context("Could not read the media header.")?,
    };
    let audio = format
        .default_track(TrackType::Audio)
        .context("This file has no audio track to transcribe.")?;
    let parameters = audio
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .context("Unsupported audio codec.")?;
    CODECS
        .make_audio_decoder(parameters, &AudioDecoderOptions::default())
        .context("Unsupported audio codec.")?;
    let video = format.default_track(TrackType::Video).is_some();
    let tracks: Vec<_> = format
        .tracks()
        .iter()
        .filter_map(|track| Some((track.id, track.time_base?, track.start_ts)))
        .collect();
    let duration_from_headers = format
        .tracks()
        .iter()
        .filter_map(|track| {
            Some(
                track
                    .time_base?
                    .calc_duration(track.duration?)?
                    .as_secs_f64(),
            )
        })
        .filter(|duration| duration.is_finite())
        .fold(0.0, f64::max);
    let mut duration = duration_from_headers;
    // Fragmented MP4 and live WebM headers may omit or understate the duration.
    if duration < 0.1 || (format.format_info().short_name == "isomp4" && fragmented_mp4(path)?) {
        let mut packets = 0;
        while let Some(packet) = next_packet(format.as_mut())? {
            if let Some((_, base, start)) = tracks.iter().find(|(id, _, _)| *id == packet.track_id)
            {
                let timestamp =
                    |value| base.calc_time(value).map_or(0.0, |time| time.as_secs_f64());
                let length = base
                    .calc_duration(packet.dur)
                    .map_or(0.0, |time| time.as_secs_f64());
                duration = duration.max(timestamp(packet.pts) - timestamp(*start) + length);
                if duration > MAX_SECONDS + 0.5 {
                    break;
                }
            }
            packets += 1;
            if packets >= 1_000_000 {
                bail!("Unable to determine the recording duration.");
            }
        }
    }
    Ok(Probe {
        video,
        duration,
        container_duration: duration_from_headers,
    })
}

pub fn decode_audio(path: &Path, output: &Path) -> Result<()> {
    let mut format = match open(path) {
        #[cfg(windows)]
        Err(error) if use_windows_reader(path, &error) => {
            return crate::windows_media::decode(path, output);
        }
        result => result?,
    };
    let track = format
        .default_track(TrackType::Audio)
        .context("This file has no audio track to transcribe.")?;
    let id = track.id;
    let parameters = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .context("Unsupported audio codec.")?;
    let mut decoder = CODECS.make_audio_decoder(parameters, &AudioDecoderOptions::default())?;
    let mut decoded = Vec::<f32>::new();
    let mut writer = None;
    while let Some(packet) = next_packet(format.as_mut())? {
        if packet.track_id != id {
            continue;
        }
        let audio = match decoder.decode(&packet) {
            Ok(audio) => audio,
            Err(Error::DecodeError(_)) => continue,
            Err(error) => return Err(error.into()),
        };
        let rate = audio.spec().rate();
        let channels = audio.spec().channels().count();
        if channels == 0 || channels > 32 {
            bail!("Unsupported audio channel layout.");
        }
        let writer = match &mut writer {
            Some(writer) => writer,
            None => writer.insert(Pcm::new(output, rate)?),
        };
        if writer.rate != rate {
            bail!("Recording changes sample rate.");
        }
        audio.copy_to_vec_interleaved(&mut decoded);
        let limit = writer.rate as usize * MAX_SECONDS as usize;
        for frame in decoded
            .chunks_exact(channels)
            .take(limit - writer.source_samples)
        {
            let frame = frame.iter().copied().sum::<f32>() / channels as f32;
            writer.push(if frame.is_finite() { frame } else { 0.0 })?;
        }
        if writer.source_samples >= limit {
            break;
        }
    }
    writer
        .context("Could not decode the recording audio.")?
        .finish()
}

pub(crate) struct Pcm {
    file: BufWriter<File>,
    rate: u32,
    source_samples: usize,
    written: usize,
    pending: Vec<f32>,
    resampler: Option<FftFixedInOut<f32>>,
    resampled: Vec<Vec<f32>>,
    delay: usize,
}

impl Pcm {
    pub(crate) fn new(path: &Path, rate: u32) -> Result<Self> {
        if !(8_000..=192_000).contains(&rate) {
            bail!("Unsupported audio sample rate.");
        }
        let resampler = if rate == OUTPUT_HZ {
            None
        } else {
            Some(FftFixedInOut::new(
                rate as usize,
                OUTPUT_HZ as usize,
                1024,
                1,
            )?)
        };
        let resampled = resampler
            .as_ref()
            .map(|filter| filter.output_buffer_allocate(true))
            .unwrap_or_default();
        let delay = resampler.as_ref().map_or(0, Resampler::output_delay);
        Ok(Self {
            file: BufWriter::new(File::create(path)?),
            rate,
            source_samples: 0,
            written: 0,
            pending: Vec::new(),
            resampler,
            resampled,
            delay,
        })
    }

    pub(crate) fn push(&mut self, sample: f32) -> Result<()> {
        self.source_samples += 1;
        if let Some(filter) = self.resampler.as_ref() {
            self.pending.push(sample);
            if self.pending.len() == filter.input_frames_next() {
                self.write_block(MAX_SAMPLES)?;
            }
        } else {
            self.file.write_all(&sample.to_le_bytes())?;
            self.written += 1;
        }
        Ok(())
    }

    fn write_block(&mut self, limit: usize) -> Result<()> {
        let filter = self
            .resampler
            .as_mut()
            .context("Missing audio resampler.")?;
        self.pending.resize(filter.input_frames_next(), 0.0);
        let (_, frames) =
            filter.process_into_buffer(&[&self.pending], &mut self.resampled, None)?;
        self.pending.clear();
        let start = frames.min(self.delay);
        self.delay -= start;
        let count = (frames - start).min(limit.saturating_sub(self.written));
        for sample in &self.resampled[0][start..start + count] {
            self.file.write_all(&sample.to_le_bytes())?;
        }
        self.written += count;
        Ok(())
    }

    pub(crate) fn finish(mut self) -> Result<()> {
        if self.resampler.is_some() {
            let expected =
                (self.source_samples as u64 * u64::from(OUTPUT_HZ) / u64::from(self.rate)) as usize;
            let expected = expected.min(MAX_SAMPLES);
            while self.written < expected {
                self.write_block(expected)?;
            }
        }
        if self.written == 0 {
            bail!("Could not decode the recording audio.");
        }
        self.file.flush()?;
        Ok(())
    }
}
