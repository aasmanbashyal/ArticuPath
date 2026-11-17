import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { engine, isInstalled, modelFile, modelRoot, models, modelStatus, installModel, refreshCatalog } from './models.js';
import { countScriptWords, scriptMaxLength, scriptMaxWords } from './public/script-review.js';
import { cueCards } from './public/cue-cards.js';
import example from './public/assets/example.json';

const port = Number(process.env.CADENCE_PORT || 4317);
const root = resolve(import.meta.dir, 'public');
const defaultFolder = process.env.CADENCE_DATA ? resolve(process.env.CADENCE_DATA) : join(modelRoot, 'sessions');
const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
const maxSize = 160 * 1024 ** 2, maxDuration = 900;
const formats = {
  '.webm':'video/webm', '.mp4':'video/mp4', '.mov':'video/quicktime', '.mkv':'video/x-matroska',
  '.mp3':'audio/mpeg', '.wav':'audio/wav', '.ogg':'audio/ogg', '.oga':'audio/ogg', '.opus':'audio/ogg',
  '.m4a':'audio/mp4', '.aac':'audio/aac', '.flac':'audio/flac',
};
const mime = {
  ...formats,
  '.svg':'image/svg+xml', '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'text/javascript; charset=utf-8', '.mjs':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.woff2':'font/woff2', '.wasm':'application/wasm', '.tflite':'application/octet-stream', '.txt':'text/plain; charset=utf-8',
};
const safe = { 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" };
const sample = { ...example, id:'example', title:'A short practice talk', kind:'audio', mime:'audio/mpeg', media:'/assets/example.mp3', sample:true };
const backgroundWasm = '/assets/vision_wasm_internal.wasm';
const maxUploadHeader = 64 * 1024;
let running = null;
const videoPlaybackFiles = new Map();
mkdirSync(defaultFolder, { recursive: true });
const data = realpathSync(defaultFolder);
const storageFile = process.env.CADENCE_DATA ? join(data, '.rehearse-storage.json') : join(modelRoot, 'storage.json');
let storage = { folder: data, folders: [data], keep: null };
const validLimit = keep => keep === null || (Number.isInteger(keep) && keep >= 1 && keep <= 10_000);
try {
  const saved = JSON.parse(readFileSync(storageFile, 'utf8'));
  if (Array.isArray(saved.folders) && saved.folders.includes(saved.folder) && saved.folders.every(isAbsolute) && validLimit(saved.keep)) storage = saved;
} catch { /* Use the default folder. */ }
class RequestError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
const json = (obj, status = 200) => Response.json(obj, { status, headers: { ...safe, 'Cache-Control': 'no-store' } });
const sessionKey = id => /^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(id);
const plainDir = path => lstatSync(path, { throwIfNoEntry: false })?.isDirectory();
const plainFile = path => lstatSync(path, { throwIfNoEntry: false })?.isFile();
const folder = id => storage.folders.map(path => join(path, id)).find(plainDir) || join(storage.folder, id);
const meta = path => join(path, 'session.json');
const storagePreferences = () => ({ folder: storage.folder, keep: storage.keep });
const recordingName = name => typeof name === 'string' && /^recording(?:-small)?\.[a-z0-9]+$/.test(name) && Object.hasOwn(formats, extname(name));
function readSaved(id, path) {
  if (!plainDir(path) || !plainFile(meta(path))) return null;
  const session = JSON.parse(readFileSync(meta(path), 'utf8'));
  return session?.id === id ? session : null;
}
function readSession(id) {
  if (id === 'example') return sample;
  const session = sessionKey(id) && readSaved(id, folder(id));
  if (!session) throw new RequestError('Session not found.', 404);
  return session;
}
function saveSession(session, path = folder(session.id)) {
  const tmp = join(path, `.session-${crypto.randomUUID()}.partial`);
  writeFileSync(tmp, JSON.stringify(session, null, 2));
  try { renameSync(tmp, meta(path)); }
  finally { rmSync(tmp, { force: true }); }
  return session;
}
function scanSessions() {
  const sessions = new Map();
  let complete = true;
  for (const root of storage.folders) {
    let ids;
    try { ids = readdirSync(root); } catch { complete = false; continue; }
    for (const id of ids) {
      if (!sessionKey(id) || sessions.has(id)) continue;
      try {
        const session = readSaved(id, join(root, id));
        if (session) sessions.set(id, session);
      } catch { complete = false; }
    }
  }
  return { sessions: [...sessions.values()].sort((a,b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0)), complete };
}
function configureStorage({ folder: path, keep = null }) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new RequestError('Enter the full path to an existing folder.');
  if (!validLimit(keep)) throw new RequestError('Choose a limit between 1 and 10,000 sessions.');
  let next;
  try {
    path = realpathSync(path);
    if (path !== storage.folder) {
      const probe = join(path, `.rehearse-write-check-${crypto.randomUUID()}`);
      writeFileSync(probe, '', { flag:'wx' });
      rmSync(probe);
    }
    next = { folder: path, folders: [...new Set([...storage.folders, path])], keep };
  } catch { throw new RequestError('Choose an existing folder ArticuPath can write to.'); }
  const temporary = `${storageFile}.${crypto.randomUUID()}.partial`;
  try {
    writeFileSync(temporary, JSON.stringify(next));
    renameSync(temporary, storageFile);
  } finally { rmSync(temporary, { force:true }); }
  storage = next;
  return { storage: storagePreferences(), sessions: scanSessions().sessions };
}
function pruneSessions(saved) {
  if (storage.keep === null) return;
  const { sessions, complete } = scanSessions();
  const pruned = [];
  let pending = !complete;
  if (complete) for (const session of sessions.slice(storage.keep)) {
    const { id, file, createdAt } = session;
    if (!recordingName(file) || !Number.isFinite(Date.parse(createdAt))) continue;
    if (id === saved.id || id === running || videoPlaybackFiles.has(id)) { pending = true; continue; }
    try {
      const path = folder(id);
      if (!plainFile(join(path,file))) continue;
      rmSync(path, { recursive:true });
      pruned.push(id);
    } catch { pending = true; }
  }
  if (pruned.length) saved.pruned = pruned;
  if (pending) saved.cleanupPending = true;
}
const titleFor = (value, mode) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 110) : `${mode === 'video' ? 'Video' : 'Voice'} practice`;
function sessionCue(value) {
  if (value == null) return undefined;
  if (typeof value === 'string' && cueCards.some(card => card.id === value)) return value;
  throw new RequestError('Choose a cue card from the list.');
}
function sessionTags(values) {
  const message = 'Use up to 10 tags, each between 1 and 32 characters.';
  if (!Array.isArray(values) || values.length > 10) throw new RequestError(message);
  const tags = new Map();
  for (const value of values) {
    if (typeof value !== 'string') throw new RequestError(message);
    const tag = value.trim().replace(/\s+/g, ' ');
    if (!tag || tag.length > 32 || /[,\p{Cc}]/u.test(tag)) throw new RequestError(message);
    const key = tag.toLowerCase();
    if (!tags.has(key)) tags.set(key, tag);
  }
  return [...tags.values()];
}
async function readJSON(req) {
  const text = await req.text();
  if (text.length > 60_000) throw new RequestError('The request is too long.', 413);
  try { const result = JSON.parse(text); if (!result || typeof result !== 'object') throw new Error(); return result; }
  catch { throw new RequestError('The request could not be read.'); }
}
async function processOutput(cmd, { timeout = 30_000, env } = {}) {
  const proc = Bun.spawn(cmd, { stdout:'pipe', stderr:'pipe', env, timeout });
  const [stdout, stderr, status] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (status !== 0) throw new Error(stderr.trim().slice(-1200) || `Process exited with status ${status}.`);
  return stdout;
}

async function compressImport(input, output, kind, duration, originalBytes) {
  // Skip an encode when the source is already around the target bitrate.
  const originalBitrate = originalBytes * 8 / duration;
  const minimumBitrate = kind === 'video' ? 640_000 : 46_000;
  if (originalBitrate < minimumBitrate) return null;

  const video = kind === 'video' ? [
    '-map', '0:V:0', '-vf', "scale=w='min(1280,iw)':h='min(720,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,fps=24",
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '35', '-deadline', 'realtime', '-cpu-used', '6', '-row-mt', '1', '-threads', '4',
  ] : ['-vn'];
  try {
    await processOutput([ffmpeg, '-nostdin', '-v', 'error', '-y', '-protocol_whitelist', 'file', '-i', input,
      '-map', '0:a:0', '-map_metadata', '-1', '-map_chapters', '-1', ...video,
      '-c:a', 'libopus', '-ac', '1', '-b:a', '32k', output,
    ], { timeout: 300_000 });
    const size = statSync(output).size;
    if (size > 0 && size < originalBytes) return { originalBytes, savedBytes: size };
  } catch (error) {
    console.warn('Could not compress import:', error.message);
  }
  rmSync(output, { force: true });
  return null;
}

export function groupWords(words, duration, includeWordTimes = false) {
  const segments = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const start = current[0].start, end = Math.min(duration, Math.max(start + .08, current.at(-1).end));
    const text = current.map(w => w.text.trim()).join(' ').replace(/\s+([,.;:!?])/g, '$1');
    if (end > start && text) segments.push({
      start, end, text,
      ...(includeWordTimes ? { words: current.map(word => ({ text: word.text.trim(), start: word.start })) } : {}),
    });
    current = [];
  };
  for (const w of words) {
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.start >= duration || w.end < w.start || !w.text?.trim()) continue;
    const word = { ...w, start: Math.max(0, w.start), end: Math.max(0, w.end) };
    if (current.length >= 3 && word.start - current.at(-1).end >= .72) flush();
    current.push(word);
    if (/[.!?]["')]*$/.test(word.text.trim()) || current.length >= 19 || word.end - current[0].start >= 11) flush();
  }
  flush();
  return segments;
}

async function uploadHeader(reader) {
  // Uploads start with one JSON line, followed by the untouched media bytes.
  const parts = [];
  let length = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new RequestError('Could not read the recording.');
    const newline = value.indexOf(10);
    const head = newline < 0 ? value : value.subarray(0, newline);
    length += head.byteLength;
    if (length > maxUploadHeader) throw new RequestError('The recording details are too long.', 413);
    parts.push(head);
    if (newline < 0) continue;
    let details;
    try { details = JSON.parse(Buffer.concat(parts, length).toString('utf8')); } catch {}
    if (!details || typeof details.filename !== 'string') throw new RequestError('Could not read the recording.');
    return { details, first: value.subarray(newline + 1) };
  }
}

async function createSession(req) {
  if (!Bun.which(ffprobe) && !existsSync(ffprobe)) throw new RequestError('Install FFmpeg, including ffprobe, and restart ArticuPath.', 503);
  if (!req.body || req.headers.get('content-type') !== 'application/octet-stream') throw new RequestError('Could not read the recording.');
  const reader = req.body.getReader();
  const id = crypto.randomUUID();
  let created;
  try {
    const { details, first } = await uploadHeader(reader);
    const ext = extname(details.filename).toLowerCase();
    if (!Object.hasOwn(formats, ext)) throw new RequestError('Choose a supported audio or video file.');
    const inputScript = details.script;
    const script = typeof inputScript === 'string' ? inputScript.trim() : '';
    const wordCount = inputScript == null ? 0 : countScriptWords(script);
    if (inputScript != null && (typeof inputScript !== 'string' || inputScript.length > scriptMaxLength || !wordCount || wordCount > scriptMaxWords)) {
      throw new RequestError(`Use a script with 1–${scriptMaxWords} words and at most ${scriptMaxLength} characters.`);
    }
    const cueId = sessionCue(details.cueId);
    const name = `recording${ext}`;
    const destination = join(storage.folder, id);
    const input = join(destination, name);
    try { mkdirSync(destination); }
    catch { throw new RequestError('Could not save to the recording folder. Check Storage in Settings.', 409); }
    created = destination;
    let size = 0;
    await pipeline(async function* () {
      let chunk = first;
      while (chunk) {
        size += chunk.byteLength;
        if (size > maxSize) throw new RequestError('Choose a recording smaller than 160 MiB.', 413);
        if (chunk.byteLength) yield chunk;
        chunk = (await reader.read()).value;
      }
    }, createWriteStream(input));
    if (!size) throw new RequestError('Choose a supported audio or video file.');
    let probe;
    try { probe = JSON.parse(await processOutput([ffprobe, '-v', 'error', '-protocol_whitelist', 'file', '-show_entries', 'format=duration:stream=codec_type,duration:stream_disposition=attached_pic', '-of','json', input])); }
    catch { throw new RequestError('This file could not be read as audio or video.'); }
    if (!probe.streams?.some(stream => stream.codec_type === 'audio')) throw new RequestError('This file has no audio track to transcribe.');
    const formatDuration = Number(probe.format?.duration) || 0;
    const kind = probe.streams.some(s => s.codec_type === 'video' && !s.disposition?.attached_pic) ? 'video' : 'audio';
    let indexed = ext === '.webm' && formatDuration > 0;
    let candidate = Math.max(0, formatDuration, ...probe.streams.map(s => Number(s.duration) || 0));
    if (kind === 'video' && ext === '.webm' && !indexed && details.recorded === true) {
      const temporary = join(destination, 'indexed.webm');
      try {
        await remuxWebM(input, temporary);
        const duration = await webmDuration(temporary);
        if (duration > 0 && Number.isFinite(duration)) {
          renameSync(temporary, input);
          candidate = Math.max(candidate, duration);
          indexed = true;
        }
      } catch (error) {
        console.warn('Could not index new video:', error.message);
      } finally { rmSync(temporary, { force: true }); }
    }
    // MediaRecorder WebM may not include a duration header. Read packet timestamps in that case.
    const duration = candidate || await packetDuration(input);
    if (!Number.isFinite(duration) || duration < .1 || duration > maxDuration + .5) throw new RequestError('Use a recording between 0.1 seconds and 15 minutes.');
    const compactName = 'recording-small.webm';
    const compression = details.compress === true ? await compressImport(input, join(destination, compactName), kind, duration, size) : null;
    const types = { '.webm':'audio/webm', '.mp4':'audio/mp4' };
    const recordingExtension = compression ? '.webm' : ext;
    const mime = kind === 'audio' ? types[recordingExtension] || formats[recordingExtension] : formats[recordingExtension];
    const requestedMode = details.captureMode;
    const captureMode = kind === 'video' && ['screen', 'screen-camera'].includes(requestedMode) ? requestedMode : undefined;
    const session = saveSession({ id, title:titleFor(details.title, kind), kind, duration, file:compression ? compactName : name,
      mime, captureMode, cueId, media:`/api/sessions/${id}/media`, createdAt:new Date().toISOString(), segments:[], ...(indexed ? { indexed } : {}), ...(compression ? { storage: compression } : {}), ...(script ? { script } : {}),
    }, destination);
    if (compression) {
      try { rmSync(input, { force: true }); }
      catch (error) { console.warn('Could not remove temporary import:', error.message); }
    }
    pruneSessions(session);
    return session;
  } catch (err) {
    if (created) rmSync(created, { recursive: true, force: true });
    throw err;
  } finally { void reader.cancel().catch(() => {}); }
}
async function packetDuration(input) {
  let total = 0;
  try {
    const out = await processOutput([ffprobe,'-v','error','-protocol_whitelist','file','-show_entries','packet=pts_time,duration_time','-of','csv=p=0',input]);
    for (const line of out.split('\n')) { const [ts, d] = line.split(','); total = Math.max(total, (Number(ts) || 0) + (Number(d) || 0)); }
  } catch { /* missing or invalid duration */ }
  return total;
}

function videoPlaybackFile(id, input) {
  if (!videoPlaybackFiles.has(id)) {
    videoPlaybackFiles.set(id, finalizeWebM(id, input).catch(error => {
      console.warn('Could not prepare video playback:', error.message);
      return input;
    }).finally(() => videoPlaybackFiles.delete(id)));
  }
  return videoPlaybackFiles.get(id);
}

async function webmDuration(input) {
  return Number((await processOutput([ffprobe, '-v', 'error', '-protocol_whitelist', 'file',
    '-show_entries', 'format=duration', '-of', 'csv=p=0', input])).trim());
}

function remuxWebM(input, output) {
  return processOutput([ffmpeg, '-nostdin', '-v', 'error', '-protocol_whitelist', 'file',
    '-i', input, '-map', '0', '-c', 'copy', output]);
}

async function finalizeWebM(id, input) {
  const output = join(folder(id), 'playback.webm');
  if (plainFile(output)) return output;
  if (await webmDuration(input) > 0) return input;

  // Live WebM can lack the duration and seek index needed for browser playback.
  const temporary = join(folder(id), `playback-${crypto.randomUUID()}.webm`);
  try {
    await remuxWebM(input, temporary);
    renameSync(temporary, output);
    return output;
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function transcribe(id, modelId) {
  const model = models.find(m => m.id === modelId);
  const lib = engine();
  if (!model || !lib || !isInstalled(model)) throw new RequestError('Install your selected transcription model in Settings first.', 409);
  if (!Bun.which(ffmpeg) && !existsSync(ffmpeg)) throw new RequestError('Install FFmpeg and restart ArticuPath.', 503);
  if (running) throw new RequestError('ArticuPath is already transcribing a take. Try again when it finishes.', 409);
  const session = readSession(id), takeFolder = folder(id);
  if (!recordingName(session.file) || !plainFile(join(takeFolder, session.file))) throw new RequestError('Recording not found.',404);
  const pcm = join(takeFolder, `transcribe-${crypto.randomUUID()}.pcm`);
  running = id;
  try {
    await processOutput([ffmpeg,'-nostdin','-v','error','-y','-protocol_whitelist','file','-i',join(takeFolder, session.file),'-map','0:a:0','-vn','-t',String(maxDuration),'-ac','1','-ar','16000','-f','f32le',pcm]);
    const output = await processOutput([process.execPath, join(import.meta.dir, 'asr.js'), lib, modelFile(model), pcm], { timeout: 10 * 60_000, env: {
      ...process.env,
      ...(process.platform === 'win32' ? { Path:`${dirname(lib)}${delimiter}${process.env.Path || process.env.PATH || ''}` } : {}),
    } });
    const { words, segments: timedLines, text } = JSON.parse(output);
    const segments = timedLines ? timedLines.flatMap(row => {
      const start = Math.max(0, Math.min(session.duration, row.start));
      const end = Math.min(session.duration, row.end);
      return end > start ? [{ ...row, start, end }] : [];
    }) : groupWords(words, session.duration, Boolean(session.script));
    if (!segments.length && text.trim()) throw new Error('The engine returned text without usable timestamps.');
    return saveSession({ ...readSession(id), segments, modelId, transcriptDone:true, feedback:null });
  } catch (err) {
    console.error('Transcription failed:', err.message);
    throw new RequestError('Transcription did not finish. The recording is still saved. Check Settings and try again.', 502);
  } finally { running = null; rmSync(pcm, { force: true }); }
}

async function feedback(req) {
  const body = await readJSON(req);
  const provider = body.provider;
  if (!['openai','ollama'].includes(provider)) throw new RequestError('Choose a coaching provider in Settings.');
  if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 48_000) throw new RequestError('The coaching prompt is missing or too long.');
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  if (!model || model.length > 100) throw new RequestError('Enter a model name in Settings.');
  const key = typeof body.key === 'string' && body.key.trim() || process.env.OPENAI_API_KEY;
  if (provider === 'openai' && !key) throw new RequestError('Add an OpenAI API key in Settings.');
  const target = provider === 'openai' ? 'https://api.openai.com/v1/chat/completions' : 'http://127.0.0.1:11434/api/chat';
  let response;
  try { response = await fetch(target, { method:'POST', redirect:'error', signal:AbortSignal.timeout(150_000), headers:{ 'Content-Type':'application/json', ...(provider === 'openai' ? { Authorization:`Bearer ${key}` } : {}) }, body:JSON.stringify({ model, messages:[{ role:'user', content:body.prompt }], stream:false, ...(provider === 'openai' ? {store:false} : {}) }) }); }
  catch { throw new RequestError(provider === 'ollama' ? 'Could not reach Ollama. Start Ollama on this device and try again.' : 'Could not reach OpenAI. Check your connection and try again.', 502); }
  if (!response.ok) throw new RequestError(response.status === 401 ? 'OpenAI rejected the API key.' : `The provider could not answer (HTTP ${response.status}). Check the model and account.`, 502);
  const payload = await response.json();
  const result = provider === 'openai' ? payload.choices?.[0]?.message?.content : payload.message?.content;
  if (typeof result !== 'string' || !result.trim()) throw new RequestError('The provider returned no feedback.', 502);
  return { text:result.trim().slice(0, 50_000) };
}

export function fileResponse(req, file, type, filename, extraHeaders) {
  const headers = { ...safe, 'Content-Type': type, 'Accept-Ranges':'bytes', 'Cache-Control':'no-store', ...extraHeaders };
  if (filename) headers['Content-Disposition'] = `attachment; filename="${filename}"`;
  const range = req.headers.get('range');
  if (!range) return new Response(req.method === 'HEAD' ? null : file, { headers:{ ...headers,'Content-Length':String(file.size) } });
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (match && (match[1] || match[2])) {
    const start = match[1] ? Number(match[1]) : Math.max(0,file.size - Number(match[2]));
    const end = Math.min(file.size - 1, match[1] && match[2] ? Number(match[2]) : file.size - 1);
    if (start >= 0 && end >= start) return new Response(req.method === 'HEAD' ? null : file.slice(start,end + 1), { status:206, headers:{ ...headers, 'Content-Range':`bytes ${start}-${end}/${file.size}`, 'Content-Length':String(end-start+1) } });
  }
  return new Response(null,{ status:416, headers:{ ...headers, 'Content-Range':`bytes */${file.size}` } });
}

async function handle(req, server) {
  const url = new URL(req.url), path = url.pathname, method = req.method;
  if (![`127.0.0.1:${server.port}`,`localhost:${server.port}`].includes(url.host)) return json({ error:'Open ArticuPath from its local address.' },403);
  if (path.startsWith('/api/') && req.headers.get('sec-fetch-site') === 'cross-site') return json({ error:'Open ArticuPath from its local address.' },403);
  if (!['GET','HEAD'].includes(method) && req.headers.get('origin') !== url.origin) return json({ error:'Open ArticuPath from its local address.' },403);
  if (path === '/api/state' && method === 'GET') {
    return json({ ...modelStatus(), ffmpegReady:Boolean((Bun.which(ffmpeg) || existsSync(ffmpeg)) && (Bun.which(ffprobe) || existsSync(ffprobe))), desktop:process.env.CADENCE_DESKTOP === '1', sessions:scanSessions().sessions, storage:storagePreferences(), sample, running, keyConfigured:Boolean(process.env.OPENAI_API_KEY) });
  }
  if (path === '/api/storage' && method === 'PATCH') return json(configureStorage(await readJSON(req)));
  if (path === '/api/models' && method === 'GET') return json(modelStatus());
  if (path === '/api/transcription' && method === 'GET') return json({ running });
  if (path === '/api/models/catalog' && method === 'GET') {
    const catalogCurrent = await refreshCatalog();
    return json({ ...modelStatus(), catalogCurrent });
  }
  const modelMatch = /^\/api\/models\/([\w.-]+)\/install$/.exec(path);
  if (modelMatch && method === 'POST') {
    const model = models.find(m => m.id === modelMatch[1]);
    if (!model) throw new RequestError('Model not found.',404);
    const status = modelStatus();
    if (!status.canInstall) throw new RequestError('Automatic setup is unavailable for this system.',409);
    if (status.download && status.download.stage !== 'error') throw new RequestError('Another download is in progress.',409);
    void installModel(model).catch(err => console.error('Model setup:',err.message));
    return json(modelStatus(),202);
  }
  if (path === '/api/feedback' && method === 'POST') { server.timeout(req, 165); return json(await feedback(req)); }
  if (path === '/api/sessions' && method === 'POST') {
    server.timeout(req, 350);
    return json(await createSession(req), 201);
  }
  const match = /^\/api\/sessions\/([a-f\d-]+)(?:\/(media|transcribe))?$/i.exec(path);
  if (match) {
    const [,id,action] = match;
    const session = readSession(id);
    if (action === 'media' && ['GET','HEAD'].includes(method)) {
      const download = url.searchParams.has('download');
      const takeFolder = folder(id);
      if (!recordingName(session.file) || !plainFile(join(takeFolder, session.file))) throw new RequestError('Recording not found.',404);
      let file = join(takeFolder, session.file);
      if (!download && session.kind === 'video' && session.mime === 'video/webm' && !session.storage && !session.indexed) {
        file = await videoPlaybackFile(id, file);
      }
      return fileResponse(req, Bun.file(file), session.mime, download ? session.file : null);
    }
    if (action === 'transcribe' && method === 'POST') { server.timeout(req, 650); return json(await transcribe(id,(await readJSON(req)).modelId)); }
    if (!action && method === 'PATCH') {
      const form = await readJSON(req);
      const previous = session;
      if (typeof form.title === 'string') return json(saveSession({ ...previous, title:titleFor(form.title,previous.kind) }));
      if (typeof form.feedback === 'string' && form.feedback.length <= 50_000) return json(saveSession({ ...previous, feedback:form.feedback }));
      if (Object.hasOwn(form, 'tags') || Object.hasOwn(form, 'cueId')) {
        if (Object.hasOwn(form, 'tags')) previous.tags = sessionTags(form.tags);
        if (Object.hasOwn(form, 'cueId')) previous.cueId = sessionCue(form.cueId);
        return json(saveSession(previous));
      }
      throw new RequestError('Nothing to update.');
    }
    if (!action && method === 'DELETE') {
      await videoPlaybackFiles.get(id);
      if (running === id) throw new RequestError('Wait for transcription to finish before deleting this take.',409);
      rmSync(folder(id),{ recursive:true, force:true });
      videoPlaybackFiles.delete(id);
      return json({ deleted:true });
    }
  }
  const publicPath = path === '/' ? '/index.html' : path;
  if (['GET','HEAD'].includes(method) && /^\/(?:assets\/)?[a-z0-9._-]+$/i.test(publicPath) && !publicPath.endsWith('/..')) {
    if (publicPath === backgroundWasm) {
      const file = Bun.file(join(root, `${publicPath}.gz`));
      if (await file.exists()) {
        const accepts = req.headers.get('accept-encoding')?.split(',').some(value => {
          const [encoding, quality] = value.trim().split(';');
          return encoding.toLowerCase() === 'gzip' && (!quality || Number(quality.split('=')[1]) > 0);
        });
        const vary = { Vary: 'Accept-Encoding' };
        if (accepts && !req.headers.has('range')) {
          return fileResponse(req, file, mime['.wasm'], null, { ...vary, 'Content-Encoding': 'gzip' });
        }
        const bytes = Bun.gunzipSync(new Uint8Array(await file.arrayBuffer()));
        return fileResponse(req, new Blob([bytes]), mime['.wasm'], null, vary);
      }
    }
    const type = mime[extname(publicPath)];
    const file = typeof type === 'string' && Bun.file(join(root, publicPath));
    if (file && await file.exists()) return fileResponse(req, file, type);
  }
  return json({ error:'Not found.' },404);
}

export function startServer(listenPort = port) {
  return Bun.serve({ hostname:'127.0.0.1', port:listenPort, idleTimeout:120, maxRequestBodySize:maxSize + 1024 ** 2,
    async fetch(req,server) {
      try { return await handle(req,server); }
      catch (err) {
        if (err instanceof RequestError) return json({ error:err.message }, err.status);
        console.error(err);
        return json({ error:'Something went wrong. Try again.' },500);
      }
    },
  });
}
if (import.meta.main) console.log(`ArticuPath  ${startServer().url}`);

