use anyhow::{Context, Result, bail};
use libloading::Library;
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString, c_char, c_void};
use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::ptr;

#[derive(Deserialize, Serialize)]
pub struct Word {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

#[derive(Deserialize, Serialize)]
pub struct Transcript {
    pub text: String,
    pub words: Vec<Word>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub segments: Vec<Word>,
}

pub fn run(library: &Path, model: &Path, audio: &Path) -> Result<Transcript> {
    let mut input = File::open(audio)?;
    let bytes = input.metadata()?.len() as usize;
    if bytes == 0 || bytes % 4 != 0 || bytes > 900 * 16_000 * 4 {
        bail!("Invalid PCM audio.");
    }
    let mut pcm = vec![0_f32; bytes / 4];
    // The worker runs on little-endian Windows. Every bit pattern is valid for f32.
    input.read_exact(unsafe {
        std::slice::from_raw_parts_mut(pcm.as_mut_ptr().cast::<u8>(), bytes)
    })?;
    let backends = c_path(library.parent().context("Missing engine directory.")?)?;
    let model = c_path(model)?;
    unsafe { recognize(library, &backends, &model, &pcm) }
}

fn c_path(path: &Path) -> Result<CString> {
    Ok(CString::new(path.to_string_lossy().as_bytes())?)
}

type Pointer = *mut c_void;
type Free = unsafe extern "C" fn(Pointer);

struct Session {
    pointer: Pointer,
    free: Free,
}

impl Drop for Session {
    fn drop(&mut self) {
        unsafe { (self.free)(self.pointer) };
    }
}

unsafe fn recognize(
    library: &Path,
    backends: &CStr,
    model: &CStr,
    pcm: &[f32],
) -> Result<Transcript> {
    unsafe {
        #[cfg(windows)]
        let library: Library =
            libloading::os::windows::Library::load_with_flags(library, 0x0000_0100 | 0x0000_1000)?
                .into();
        #[cfg(not(windows))]
        let library = Library::new(library)?;
        macro_rules! symbol {
            ($name:literal, $type:ty) => {
                *library.get::<$type>(concat!("transcribe_", $name, "\0").as_bytes())?
            };
        }
        let version = symbol!("version", unsafe extern "C" fn() -> *const c_char);
        if !string(version()).starts_with("0.4.") {
            bail!("Rehearsal requires the transcribe.cpp 0.4 library.");
        }
        let describe = symbol!("status_string", unsafe extern "C" fn(i32) -> *const c_char);
        let check = |code| -> Result<()> {
            if code != 0 {
                bail!("{}", string(describe(code)));
            }
            Ok(())
        };
        let sizes = symbol!("abi_struct_size", unsafe extern "C" fn(i32) -> u64);
        let structure = |id, minimum| -> Result<Vec<u64>> {
            let size = sizes(id) as usize;
            if !(minimum..=4096).contains(&size) {
                bail!("Unsupported transcribe.cpp ABI.");
            }
            Ok(vec![0_u64; size.div_ceil(8)])
        };
        let mut load = structure(0, 32)?;
        let mut parameters = structure(2, 16)?;
        let load = load.as_mut_ptr().cast::<u8>();
        let parameters = parameters.as_mut_ptr().cast::<u8>();
        symbol!("model_load_params_init", unsafe extern "C" fn(Pointer))(load.cast());
        symbol!("run_params_init", unsafe extern "C" fn(Pointer))(parameters.cast());
        // Keep the default AUTO timestamps: Whisper can return segments but not words.
        if !cfg!(target_os = "macos") {
            load.add(8).cast::<i32>().write_unaligned(1);
        }
        check(symbol!(
            "init_backends",
            unsafe extern "C" fn(*const c_char) -> i32
        )(backends.as_ptr()))?;
        let mut pointer = ptr::null_mut();
        check(symbol!(
            "open",
            unsafe extern "C" fn(*const c_char, Pointer, Pointer, *mut Pointer) -> i32
        )(
            model.as_ptr(), load.cast(), ptr::null_mut(), &mut pointer
        ))?;
        if pointer.is_null() {
            bail!("The engine did not open a session.");
        }
        let session = Session {
            pointer,
            free: symbol!("session_free", Free),
        };
        check(symbol!(
            "run",
            unsafe extern "C" fn(Pointer, *const f32, i32, Pointer) -> i32
        )(
            session.pointer,
            pcm.as_ptr(),
            pcm.len() as i32,
            parameters.cast(),
        ))?;
        let kind = symbol!(
            "returned_timestamp_kind",
            unsafe extern "C" fn(Pointer) -> i32
        )(session.pointer);
        type GetRow = unsafe extern "C" fn(Pointer, i32, Pointer) -> i32;
        let (abi, init, get, count) = if kind >= 3 {
            (
                7,
                symbol!("word_init", unsafe extern "C" fn(Pointer)),
                symbol!("get_word", GetRow),
                symbol!("n_words", unsafe extern "C" fn(Pointer) -> i32)(session.pointer),
            )
        } else {
            (
                6,
                symbol!("segment_init", unsafe extern "C" fn(Pointer)),
                symbol!("get_segment", GetRow),
                symbol!("n_segments", unsafe extern "C" fn(Pointer) -> i32)(session.pointer),
            )
        };
        let mut buffer = structure(abi, 48)?;
        let row = buffer.as_mut_ptr().cast::<u8>();
        init(row.cast());
        let mut results = Vec::new();
        for index in 0..count {
            check(get(session.pointer, index, row.cast()))?;
            // Both word and segment rows use these offsets in the 64-bit 0.4 ABI.
            let text = string(row.add(40).cast::<*const c_char>().read_unaligned());
            if !text.trim().is_empty() {
                results.push(Word {
                    start: row.add(8).cast::<i64>().read_unaligned() as f64 / 1000.0,
                    end: row.add(16).cast::<i64>().read_unaligned() as f64 / 1000.0,
                    text: text.trim().to_owned(),
                });
            }
        }
        let text = string(symbol!(
            "full_text",
            unsafe extern "C" fn(Pointer) -> *const c_char
        )(session.pointer));
        let (words, segments) = if kind >= 3 {
            (results, Vec::new())
        } else {
            (Vec::new(), results)
        };
        Ok(Transcript {
            words,
            segments,
            text,
        })
    }
}

unsafe fn string(pointer: *const c_char) -> String {
    if pointer.is_null() {
        String::new()
    } else {
        unsafe { CStr::from_ptr(pointer) }
            .to_string_lossy()
            .into_owned()
    }
}
