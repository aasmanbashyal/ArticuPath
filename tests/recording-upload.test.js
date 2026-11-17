import { test, expect } from 'bun:test';
import { beginRecording } from '../public/recording-upload.js';

test('preview preserves queued bytes after a lost acknowledgment without duplicating committed bytes', async () => {
  const original = globalThis.fetch;
  const disk = [];
  let loseResponse = true, stopped = 0;
  globalThis.fetch = async (url, options = {}) => {
    if (url === '/api/recordings') return Response.json({ id:'take' });
    if (url.endsWith('/media')) return new Response(new Blob(disk));
    if (url.endsWith('/finish')) return Response.json({ id:'take', saved:true });
    const sequence = Number(url.split('/').at(-1));
    disk[sequence] = options.body;
    if (loseResponse) { loseResponse = false; return Response.json({ error:'Lost acknowledgment' }, { status:503 }); }
    return Response.json({ sequence });
  };
  try {
    const capture = await beginRecording({ filename:'take.webm', mime:'audio/webm' }, () => stopped++);
    capture.append(new Blob(['first chunk']));
    await expect(capture.finish()).rejects.toThrow('Lost acknowledgment');
    capture.append(new Blob(['final chunk']));
    const preview = await capture.preview();
    expect(preview.name).toBe('take.webm');
    expect(await preview.text()).toBe('first chunkfinal chunk');
    expect(stopped).toBe(1);
    expect(await capture.finish(true)).toEqual({ id:'take', saved:true });
    expect(await new Blob(disk).text()).toBe('first chunkfinal chunk');
  } finally { globalThis.fetch = original; }
});
