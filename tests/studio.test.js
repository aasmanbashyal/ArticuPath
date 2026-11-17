import { afterAll, beforeAll, expect, test } from 'bun:test';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { cueCards } from '../public/cue-cards.js';

const project = join(import.meta.dir, '..');
mkdirSync(join(project,'.cadence'),{ recursive:true });
const folder = mkdtempSync(join(project,'.cadence','verify-'));
process.env.CADENCE_DATA = join(folder,'sessions');
const native = process.env.REHEARSE_NATIVE_EXE;
async function startServer() {
  if (!native) return (await import('../server.js')).startServer(0);
  const child = Bun.spawn([native, '--serve'], { stdout:'pipe', stderr:'inherit', env:{
    ...process.env, CADENCE_HOME:process.env.CADENCE_HOME || join(project, '.cadence'), CADENCE_PORT:'0',
  } });
  const reader = child.stdout.getReader();
  const stop = async () => { child.kill(); await child.exited; };
  try {
    const decoder = new TextDecoder();
    let line = '';
    while (!line.includes('\n')) {
      const { done, value } = await reader.read();
      if (done) throw new Error('The Rust backend exited before returning its URL.');
      line += decoder.decode(value, { stream:true });
    }
    return { url:new URL(line.split('\n')[0].trim()), stop };
  } catch (error) {
    await stop();
    throw error;
  } finally { reader.releaseLock(); }
}
let server, state;
const request = (path, options={}) => fetch(new URL(path,server.url),{
  ...options, headers:{ ...(options.method && options.method !== 'GET' ? { origin:server.url.origin } : {}), ...options.headers },
});
const json = async (path, method, body) => request(path,{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const upload = (media, details) => request('/api/sessions', { method:'POST',
  body:new Blob([JSON.stringify(details) + '\n', media], { type:'application/octet-stream' }),
});
const importMedia = async (file, compress = false, captureMode, script, cueId) => {
  const res = await upload(await Bun.file(file).arrayBuffer(), { filename:file.split(/[\\/]/).at(-1), title:'Practice fixture',
    compress, captureMode, script, cueId });
  const result = await res.json();
  if(res.status!==201) throw new Error(`Import ${res.status}: ${JSON.stringify(result)}`);
  return result;
};
beforeAll(async()=>{
  server=await startServer();
  state=await (await request('/api/state')).json();
});
afterAll(async()=>{ await server?.stop(true);rmSync(folder,{ recursive:true, force:true }); });

test('serves the example with seekable media and rejects cross-site mutations',async()=>{
  expect((await request('/', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(200);
  expect((await request('/api/state', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  expect(state.models.filter(m=>m.recommended).map(m=>m.id)).toEqual(['parakeet-110m']);
  expect(state.models.find(m=>m.id==='parakeet-110m').wordErrorRate).toBeGreaterThan(0);
  expect(state.models.some(m=>m.id==='parakeet-unified')).toBe(true);
  expect(state.models.map(m => m.id)).toEqual(expect.arrayContaining(['whisper-tiny.en', 'whisper-small.en']));
  const asset=await request(state.sample.media,{ headers:{ Range:'bytes=120-159' } });
  expect(asset.status).toBe(206);
  expect(asset.headers.get('Content-Range')).toMatch(/^bytes 120-159\//);
  expect((await asset.arrayBuffer()).byteLength).toBe(40);
  const forbidden=await request('/api/feedback',{method:'POST',headers:{origin:'https://example.org'}});
  expect(forbidden.status).toBe(403);
});

test('serves background assets only when background replacement is available', async () => {
  const path = '/assets/vision_wasm_internal.wasm';
  const compressed = await request(path, { method:'HEAD', headers:{ 'Accept-Encoding':'gzip' } });
  if (state.lightMedia) {
    expect(compressed.status).toBe(404);
    expect((await request('/background.js')).status).toBe(404);
    return;
  }
  expect(compressed.headers.get('Content-Type')).toBe('application/wasm');
  expect(compressed.headers.get('Content-Encoding')).toBe('gzip');
  expect(Number(compressed.headers.get('Content-Length'))).toBeLessThan(4 * 1024 ** 2);
  const asset = await request(path, { headers:{ Range:'bytes=0-7' } });
  expect(asset.status).toBe(206);
  expect(new Uint8Array(await asset.arrayBuffer())).toEqual(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
});

test('rejects invalid streaming uploads without leaving a session folder', async () => {
  const invalid = await upload('not audio', { filename:'take.wav' });
  expect(invalid.status).toBe(400);
  expect((await upload('', { filename:'take.wav' })).status).toBe(400);
  expect((await upload('', { filename:'x'.repeat(64 * 1024) + '.wav' })).status).toBe(413);
  expect(await Array.fromAsync(new Bun.Glob('*').scan({ cwd:process.env.CADENCE_DATA, onlyFiles:false }))).toEqual([]);
});

test('streams original media with matching GET, HEAD and download byte ranges', async () => {
  const sample = Bun.file(join(project, 'public/assets/example.mp3'));
  const saved = await importMedia(sample.name);
  const last = new Uint8Array(await sample.slice(sample.size - 37).arrayBuffer());
  const range = { Range: 'bytes=-37' };
  const media = await request(saved.media, { headers: range });
  const head = await request(saved.media, { method: 'HEAD', headers: range });
  for (const response of [media, head]) {
    expect(response.status).toBe(206);
    expect(response.headers.get('Content-Length')).toBe('37');
    expect(response.headers.get('Content-Range')).toBe(`bytes ${sample.size - 37}-${sample.size - 1}/${sample.size}`);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  }
  expect(new Uint8Array(await media.arrayBuffer())).toEqual(last);
  expect((await head.arrayBuffer()).byteLength).toBe(0);
  const start = sample.size - last.length;
  const download = await request(`${saved.media}?download=1`, { headers: { Range: `bytes=${start}-` } });
  expect(download.status).toBe(206);
  expect(download.headers.get('Content-Disposition')).toBe('attachment; filename="recording.mp3"');
  expect(new Uint8Array(await download.arrayBuffer())).toEqual(last);
  const invalid = await request(saved.media, { headers: { Range: `bytes=${sample.size}-` } });
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get('Content-Range')).toBe(`bytes */${sample.size}`);
  expect((await request(`/api/sessions/${saved.id}`, { method: 'DELETE' })).status).toBe(200);
});

test('reports transcription status without a session library payload', async () => {
  const response = await request('/api/transcription');
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(await response.json()).toEqual({ running: null });
  expect((await request('/api/transcription', { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
});

test.skipIf(!native)('finishes an accepted transcription after the client disconnects', async () => {
  const model = state.models.find(model => model.installed && state.engineReady);
  if (!model) return; // The shared suite also runs on fresh installations.
  const saved = await importMedia(join(project, 'public/assets/example.mp3'));
  const session = `/api/sessions/${saved.id}`;
  const body = JSON.stringify({ modelId: model.id });
  const socket = connect({ host: server.url.hostname, port: Number(server.url.port) });
  const waitForStatus = async expected => {
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      const status = await (await request('/api/transcription')).json();
      if (status.running === expected) return;
      await Bun.sleep(20);
    }
    throw new Error(`Transcription did not report ${expected ?? 'idle'}.`);
  };
  try {
    await once(socket, 'connect');
    socket.write([
      `POST ${session}/transcribe HTTP/1.1`,
      `Host: ${server.url.host}`,
      `Origin: ${server.url.origin}`,
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '', body,
    ].join('\r\n'));
    await waitForStatus(saved.id);
    const closed = once(socket, 'close');
    socket.destroy();
    await closed;
    expect((await json(session, 'PATCH', { title: 'Title edited after disconnect' })).status).toBe(200);
    await waitForStatus(null);
    const transcript = (await (await request('/api/state')).json()).sessions.find(take => take.id === saved.id);
    expect(transcript.title).toBe('Title edited after disconnect');
    expect(transcript.modelId).toBe(model.id);
    expect(transcript.transcriptDone).toBe(true);
    expect(transcript.segments.map(segment => segment.text).join(' ')).toMatch(/without looking at my notes/i);
    expect(await Bun.file(join(process.env.CADENCE_DATA, saved.id, 'temporary.pcm')).exists()).toBe(false);
    expect((await request(session, { method: 'DELETE' })).status).toBe(200);
  } finally {
    socket.destroy();
  }
}, 65_000);

test.skipIf(Boolean(native))('returns provider feedback and sends only the chosen model and prompt',async()=>{
  const originalFetch=globalThis.fetch;
  let outgoing;
  globalThis.fetch=async (url,options)=>{
    if(String(url)!=='https://api.openai.com/v1/chat/completions') return originalFetch(url,options);
    outgoing=JSON.parse(options.body);
    expect(options.headers.Authorization).toBe('Bearer example-key');
    return Response.json({choices:[{message:{content:'[00:04] Lead with the main idea.'}}]});
  };
  try {
    const result=await json('/api/feedback','POST',{provider:'openai',model:'test-model',key:'example-key',prompt:'[00:04] My opening line.',recording:'not sent'});
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({text:'[00:04] Lead with the main idea.'});
    expect(outgoing).toEqual({model:'test-model',messages:[{role:'user',content:'[00:04] My opening line.'}],stream:false,store:false});
  } finally { globalThis.fetch=originalFetch; }
});

test('saves voice and video, transcribes installed models, and keeps session edits across restart', async()=>{
  if (!(state.mediaReady ?? state.ffmpegReady)) throw new Error('The recording backend is unavailable.');
  const sample=join(project,'public/assets/example.mp3');
  const script='This is a line from my original practice script.';
  const cueId = cueCards[1].id;
  const saved=await importMedia(sample, false, undefined, script, cueId);
  expect(saved.kind).toBe('audio');
  expect(saved.script).toBe(script);
  expect(saved.cueId).toBe(cueId);
  expect(saved.duration).toBeGreaterThan(30);
  const sessionPath = `/api/sessions/${saved.id}`;
  const tagged = await json(sessionPath, 'PATCH', { tags: [' Work   practice ', 'work practice', 'Warm-up'] });
  expect(tagged.status).toBe(200);
  expect((await tagged.json()).tags).toEqual(['Work practice', 'Warm-up']);
  expect((await json(sessionPath, 'PATCH', { cueId: 'missing-cue', tags: [] })).status).toBe(400);
  for (const model of state.models.filter(m=>m.installed && state.engineReady)) {
    const result=await json(`/api/sessions/${saved.id}/transcribe`,'POST',{modelId:model.id});
    const transcript=await result.json();
    if(!result.ok) throw new Error(`${model.name}: ${JSON.stringify(transcript)}`);
    expect(transcript.modelId).toBe(model.id);
    expect(transcript.script).toBe(script);
    expect(transcript.segments.map(s=>s.text).join(' ')).toMatch(/without looking at my notes/i);
    expect(transcript.segments.some(s=>s.start>20)).toBe(true);
    expect(transcript.segments.every(s=>s.start>=0 && s.end>s.start && s.end<=saved.duration)).toBe(true);
    if (model.id.startsWith('whisper-')) {
      expect(transcript.segments.every(segment => !segment.words)).toBe(true);
    } else {
      expect(transcript.segments.every(segment => segment.words?.[0].start === segment.start)).toBe(true);
    }
  }
  const videoFile=join(folder,'recording.webm');
  const ffmpeg=process.env.FFMPEG_BIN || 'ffmpeg';
  const encode=Bun.spawnSync([ffmpeg,'-v','error','-y','-f','lavfi','-i','color=0x1b5040:s=240x144:r=15','-i',sample,'-t','4','-c:v','libvpx','-c:a','libopus','-live','1',videoFile],{stderr:'pipe'});
  if(encode.exitCode!==0) throw new Error(encode.stderr.toString());
  const video=await importMedia(videoFile, false, 'screen-camera');
  expect(video.kind).toBe('video');
  expect(video.captureMode).toBe('screen-camera');
  expect(video.duration).toBeCloseTo(4,0);
  const [playback, part, download] = await Promise.all([
    request(video.media),
    request(video.media, { headers:{ Range:'bytes=0-99' } }),
    request(`${video.media}?download`),
  ]);
  expect(playback.status).toBe(200);
  const playbackBytes = await playback.arrayBuffer();
  expect(part.status).toBe(206);
  expect(await part.arrayBuffer()).toEqual(playbackBytes.slice(0, 100));
  expect(await download.arrayBuffer()).toEqual(await Bun.file(videoFile).arrayBuffer());
  const ffprobe = process.env.FFPROBE_BIN || 'ffprobe';
  if (state.lightMedia) {
    expect(playbackBytes).toEqual(await Bun.file(videoFile).arrayBuffer());
    if (state.engineReady && state.models.some(model => model.recommended && model.installed)) {
      const result = await json(`/api/sessions/${video.id}/transcribe`, 'POST', { modelId:'parakeet-110m' });
      const transcript = await result.json();
      expect(result.status).toBe(200);
      expect(transcript.segments.map(segment => segment.text).join(' ')).toMatch(/experiment|last week/i);
    }
  } else {
    const playbackPath = join(folder, 'playback.webm');
    await Bun.write(playbackPath, playbackBytes);
    const probe = Bun.spawnSync([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', playbackPath]);
    expect(probe.exitCode).toBe(0);
    expect(Number(probe.stdout.toString().trim())).toBeCloseTo(4, 0);
  }
  const live = await upload(await Bun.file(videoFile).arrayBuffer(), { filename:'take.webm', recorded:true });
  expect(live.status).toBe(201);
  const captured = await live.json();
  const capturedPlayback = await (await request(captured.media)).arrayBuffer();
  expect(capturedPlayback).toEqual(await (await request(`${captured.media}?download`)).arrayBuffer());
  const capturedFolder = join(process.env.CADENCE_DATA, captured.id);
  expect(await Array.fromAsync(new Bun.Glob('*').scan({ cwd:capturedFolder }))).toEqual(expect.arrayContaining(['session.json', 'recording.webm']));
  expect(await Bun.file(join(capturedFolder, 'playback.webm')).exists()).toBe(false);
  if (!state.lightMedia) {
    const indexedProbe = Bun.spawnSync([ffprobe, '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0',
      join(capturedFolder, 'recording.webm')]);
    expect(Number(indexedProbe.stdout.toString().trim())).toBeCloseTo(4, 0);
  }
  const edited=await json(`/api/sessions/${saved.id}`,'PATCH',{title:'A better take'});
  expect(edited.status).toBe(200);
  await server.stop(true); server=await startServer();
  const reloaded=await (await request('/api/state')).json();
  const reloadedAudio = reloaded.sessions.find(s => s.id === saved.id);
  expect(reloadedAudio.title).toBe('A better take');
  expect(reloadedAudio.script).toBe(script);
  expect(reloadedAudio.cueId).toBe(cueId);
  expect(reloadedAudio.tags).toEqual(['Work practice', 'Warm-up']);
  const cleared = await json(sessionPath, 'PATCH', { cueId: null, tags: [] });
  expect(cleared.status).toBe(200);
  expect(await cleared.json()).toMatchObject({ tags: [] });
  const reloadedVideo = reloaded.sessions.find(s => s.id === video.id);
  expect(reloadedVideo.media).toBe(video.media);
  expect(reloadedVideo.captureMode).toBe('screen-camera');
  expect((await request(video.media,{ headers:{Range:'bytes=0-99'} })).status).toBe(206);
  expect((await request(`/api/sessions/${video.id}`,{method:'DELETE'})).status).toBe(200);
  expect((await request(video.media)).status).toBe(404);
}, 90_000);

test('handles voice and video imports with the media features available in the build', async () => {
  const sample = join(project, 'public/assets/example.mp3');
  const ffmpeg = process.env.FFMPEG_BIN || 'ffmpeg';
  const wav = join(folder, 'large-voice.wav');
  const mp4 = join(folder, 'large-video.mp4');
  const commands = [
    [ffmpeg, '-v', 'error', '-y', '-i', sample, '-t', '3', '-c:a', 'pcm_s16le', wav],
    [ffmpeg, '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24', '-i', sample,
      '-t', '2', '-c:v', 'libx264', '-crf', '0', '-c:a', 'aac',
      ...(state.lightMedia ? ['-movflags', '+dash', '-frag_duration', '250000'] : []), mp4],
  ];
  for (const cmd of commands) {
    const encoded = Bun.spawnSync(cmd, { stderr: 'pipe' });
    if (encoded.exitCode !== 0) throw new Error(encoded.stderr.toString());
  }
  for (const [file, kind, duration] of [[wav, 'audio', 3], [mp4, 'video', 2]]) {
    const saved = await importMedia(file, true);
    expect(saved.kind).toBe(kind);
    expect(saved.duration).toBeCloseTo(duration, 0);
    const media = await request(saved.media);
    const bytes = await media.arrayBuffer();
    if (state.lightMedia) {
      expect(saved.storage).toBeUndefined();
      expect(bytes).toEqual(await Bun.file(file).arrayBuffer());
      if (kind === 'video' && state.engineReady && state.models.some(model => model.recommended && model.installed)) {
        const result = await json(`/api/sessions/${saved.id}/transcribe`, 'POST', { modelId:'parakeet-110m' });
        expect(result.status).toBe(200);
        expect((await result.json()).transcriptDone).toBe(true);
      }
    } else {
      expect(saved.storage.savedBytes).toBeLessThan(Bun.file(file).size);
      expect(media.headers.get('Content-Type')).toBe(`${kind}/webm`);
      expect(bytes.byteLength).toBe(saved.storage.savedBytes);
    }
    expect((await request(saved.media, { headers: { Range: 'bytes=10-19' } })).status).toBe(206);
  }
  const unchanged = await importMedia(sample, true);
  expect(unchanged.storage).toBeUndefined();
  expect(unchanged.mime).toBe('audio/mpeg');
}, 30_000);

test('keeps earlier folders accessible and prunes oldest takes only after an opted-in save', async () => {
  const initial = (await (await request('/api/state')).json()).storage;
  const newFolder = mkdtempSync(join(folder, 'chosen-'));
  const untouched = join(newFolder, 'unrelated');
  mkdirSync(untouched);
  expect(initial.keep).toBeNull();
  expect((await json('/api/storage', 'PATCH', { folder:'relative', keep:null })).status).toBe(400);
  expect((await json('/api/storage', 'PATCH', { folder:newFolder, keep:-1 })).status).toBe(400);
  const audio = join(project, 'public/assets/example.mp3');
  const oldTake = await importMedia(audio);
  const moved = await json('/api/storage', 'PATCH', { folder:newFolder, keep:2 });
  expect(moved.status).toBe(200);
  const settings = await moved.json();
  expect(settings.storage.keep).toBe(2);
  expect(settings.sessions.some(take => take.id === oldTake.id)).toBe(true);
  expect((await request(oldTake.media)).status).toBe(200);
  const newerTake = await importMedia(audio);
  expect(existsSync(join(newFolder, newerTake.id, 'session.json'))).toBe(true);
  expect(existsSync(join(initial.folder, oldTake.id, 'session.json'))).toBe(true);
  const newestTake = await importMedia(audio);
  expect(newestTake.pruned).toContain(oldTake.id);
  expect(existsSync(join(initial.folder, oldTake.id))).toBe(false);
  expect(existsSync(untouched)).toBe(true);
  await server.stop(true);
  server = await startServer();
  const restored = await (await request('/api/state')).json();
  expect(restored.storage).toEqual(settings.storage);
  expect(restored.sessions.map(take => take.id)).toEqual([newestTake.id, newerTake.id]);
  expect((await request(newerTake.media)).status).toBe(200);
}, 20_000);
