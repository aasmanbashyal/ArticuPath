// Runs in a dedicated subprocess so a native failure cannot interrupt recording or storage.
import { CString, dlopen, ptr } from 'bun:ffi';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function transcribeAudio(library, model, audio) {
  const fn = (args, returns = 'i32') => ({ args, returns });
  const { symbols: n } = dlopen(library, {
    transcribe_version: fn([], 'cstring'), transcribe_status_string: fn(['i32'], 'cstring'),
    transcribe_init_backends: fn(['ptr']), transcribe_abi_struct_size: fn(['i32'], 'u64'),
    transcribe_model_load_params_init: fn(['ptr'], 'void'), transcribe_open: fn(['ptr','ptr','ptr','ptr']),
    transcribe_session_free: fn(['ptr'], 'void'), transcribe_run_params_init: fn(['ptr'], 'void'),
    transcribe_run: fn(['ptr','ptr','i32','ptr']), transcribe_n_words: fn(['ptr']),
    transcribe_word_init: fn(['ptr'], 'void'), transcribe_get_word: fn(['ptr','i32','ptr']),
    transcribe_returned_timestamp_kind: fn(['ptr']), transcribe_n_segments: fn(['ptr']),
    transcribe_segment_init: fn(['ptr'], 'void'), transcribe_get_segment: fn(['ptr','i32','ptr']),
    transcribe_full_text: fn(['ptr'], 'cstring'),
  });
  const check = code => { if (code !== 0) throw new Error(String(n.transcribe_status_string(code))); };
  const cstr = value => Buffer.from(`${value}\0`, 'utf8');
  // Offsets are from the v0.4.x 64-bit transcribe.h ABI. Init and size come from the library.
  if (!String(n.transcribe_version()).startsWith('0.4.')) throw new Error('ArticuPath requires the transcribe.cpp 0.4 native library.');
  const struct = (id, minimum) => {
    const size = Number(n.transcribe_abi_struct_size(id));
    if (size < minimum || size > 4096) throw new Error('Unsupported transcribe.cpp ABI.');
    return Buffer.alloc(size);
  };
  const load = struct(0, 32), params = struct(2, 16);
  n.transcribe_model_load_params_init(ptr(load));
  if (process.platform !== 'darwin') load.writeInt32LE(1, 8); // CPU: predictable on Windows/Linux.
  n.transcribe_run_params_init(ptr(params));
  // AUTO lets each model return the most precise timestamps it supports.
  check(n.transcribe_init_backends(ptr(cstr(dirname(library)))));
  const result = Buffer.alloc(8), file = readFileSync(audio);
  if (file.length === 0 || file.length % 4) throw new Error('Could not decode the recording audio.');
  check(n.transcribe_open(ptr(cstr(model)), ptr(load), null, ptr(result)));
  const session = Number(result.readBigUInt64LE());
  try {
    check(n.transcribe_run(session, ptr(file), file.length / 4, ptr(params)));
    const hasWords = n.transcribe_returned_timestamp_kind(session) >= 3;
    const row = struct(hasWords ? 7 : 6, 48);
    const init = hasWords ? n.transcribe_word_init : n.transcribe_segment_init;
    const count = hasWords ? n.transcribe_n_words : n.transcribe_n_segments;
    const get = hasWords ? n.transcribe_get_word : n.transcribe_get_segment;
    init(ptr(row));
    const rows = [];
    for (let i = 0, length = count(session); i < length; i++) {
      check(get(session, i, ptr(row)));
      const text = Number(row.readBigUInt64LE(40));
      const value = text ? String(new CString(text)).trim() : '';
      if (value) rows.push({ start: Number(row.readBigInt64LE(8)) / 1000, end: Number(row.readBigInt64LE(16)) / 1000, text: value });
    }
    return { ...(hasWords ? { words: rows } : { segments: rows }), text: String(n.transcribe_full_text(session)) };
  } finally { n.transcribe_session_free(session); }
}

if (import.meta.main) console.log(JSON.stringify(transcribeAudio(...process.argv.slice(2))));
