import { buildBackend } from './backend.js';
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const desktop = process.argv.includes('--desktop');
const native = await buildBackend();
if (desktop && !native) throw new Error('Set REHEARSE_NATIVE_EXE to a freshly built Windows desktop executable.');
const root = resolve(import.meta.dirname, '..');
mkdirSync(join(root, '.cadence'), { recursive:true });
const output = mkdtempSync(join(root, '.cadence', 'ui-check-'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const socket = createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
async function waitForURL(url) {
  for (let attempt = 0; attempt < 150; attempt++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await pause(100);
  }
  throw new Error(`The test app did not start at ${url}`);
}
const port = await freePort(), debugPort = desktop ? await freePort() : null;
const origin = `http://127.0.0.1:${desktop ? 4318 : port}`;
const fakeDevices = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'];
const started = performance.now();
const child = spawn(native, desktop ? [] : ['--serve'], {
  cwd:root, windowsHide:true, stdio:['ignore', 'ignore', 'pipe'],
  env:{ ...process.env, CADENCE_HOME:output, CADENCE_DATA:join(output, 'sessions'), CADENCE_PORT:String(port),
    ...(desktop ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:`--remote-debugging-port=${debugPort} ${fakeDevices.join(' ')}` } : {}) },
});
child.stderr.pipe(process.stderr);
let browser, page;
const results = { mode:desktop ? 'Windows WebView2' : 'Rust server in Chromium',
  syntheticDevices:true, recordings:[], notes:[
    'Fresh isolated profile and session folder; transcription models are not loaded.',
    'Launch timing includes test-browser startup or the WebView2 debugging connection.',
    'Camera and screen use generated canvas frames; microphone input uses the browser fake device. Physical devices and the sharing picker are not tested.',
    'JavaScript heap measurements exclude native codecs, browser processes, and transcription models.',
  ] };
try {
  if (desktop) {
    await waitForURL(`http://127.0.0.1:${debugPort}/json/version`);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    for (let attempt = 0; attempt < 100 && !page; attempt++) {
      page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith(origin));
      if (!page) await pause(100);
    }
    assert.ok(page, 'The desktop WebView did not open');
  } else {
    await waitForURL(`${origin}/api/state`);
    browser = await chromium.launch({ args:fakeDevices,
      ...(process.env.BROWSER_EXECUTABLE ? { executablePath:process.env.BROWSER_EXECUTABLE } : {}),
      ...(process.env.BROWSER_CHANNEL ? { channel:process.env.BROWSER_CHANNEL } : {}) });
    page = await browser.newPage({ viewport:{ width:1200, height:850 }, permissions:['microphone', 'camera'], acceptDownloads:true });
    await page.goto(origin);
  }
  page.setDefaultTimeout(15_000);
  const errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Page error:', error.message); });
  page.on('console', message => { if (message.type() === 'warning') console.warn(message.text()); });
  const button = name => page.getByRole('button', { name, exact:true }).click();
  const appearance = name => page.locator('.appearance-choice').filter({ has:page.getByRole('radio', { name, exact:true }) }).click();
  const open = name => page.getByRole('navigation').getByRole('link', { name, exact:true }).click();
  const prefs = () => page.evaluate(() => JSON.parse(localStorage.getItem('cadence-settings') || '{}'));
  const appState = () => page.evaluate(async () => (await fetch('/api/state')).json());
  await page.getByRole('heading', { name:'Recorder', exact:true }).waitFor();
  results.launchToRecorderMs = Math.round(performance.now() - started);
  const skip = page.getByRole('button', { name:'Skip for now', exact:true });
  if (await skip.isVisible()) await skip.click();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    return Math.round(metrics.find(metric => metric.name === 'JSHeapUsedSize').value / 1024 ** 2 * 100) / 100;
  };
  results.idleJSHeapMiB = await heap();
  if (desktop) {
    results.processMemory = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-File', join(root, 'scripts/process-memory.ps1'), '-RootProcessId', String(child.pid)], { encoding:'utf8', windowsHide:true }));
    await button('Maximize'); await button('Restore');
  }
  // Keep media tests deterministic and avoid recording a person's devices or screen.
  await page.addInitScript(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      const stream = constraints.audio ? await getUserMedia({ audio:constraints.audio }) : new MediaStream();
      if (constraints.video) {
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d');
        let position = 0;
        const draw = () => {
          context.fillStyle = '#28332b'; context.fillRect(0, 0, 640, 360);
          context.fillStyle = '#ffffff'; context.fillRect(position++ % 600, 100, 40, 40);
        };
        draw();
        const [track] = canvas.captureStream(30).getVideoTracks();
        const frames = setInterval(draw, 33);
        const stop = track.stop.bind(track);
        track.stop = () => { clearInterval(frames); stop(); };
        stream.addTrack(track);
      }
      return stream;
    };
    navigator.mediaDevices.getDisplayMedia = () => navigator.mediaDevices.getUserMedia({ video:true });
    const Recorder = MediaRecorder;
    window.MediaRecorder = class extends Recorder {
      constructor(...args) {
        super(...args);
        this.addEventListener('error', event => console.warn('MediaRecorder:', event.error?.message));
      }
    };
  });
  await page.reload();
  await page.getByRole('heading', { name:'Recorder', exact:true }).waitFor();
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'dotted');
  await open('Cue cards');
  await page.getByLabel('Category', { exact:true }).selectOption('creative');
  await page.getByLabel('Difficulty', { exact:true }).selectOption('hard');
  await button('Shuffle');
  await button('Start preparation timer');
  await button('Reset preparation timer');
  await page.getByLabel('Speaking target').selectOption('60');
  await button('Record this topic');
  assert.ok(await page.locator('.active-cue').isVisible());
  await button('Remove cue card');

  const script = '# My presentation\n\nHello **everyone**.\n\n' + 'Today I am practicing a clear explanation. '.repeat(80) + '\n\n<script>unsafe()</script>';
  await open('Teleprompter'); await button('Add script');
  await page.getByLabel('Script', { exact:true }).fill(script);
  await button('Save script');
  assert.equal(await page.locator('.prompter-text script').count(), 0);
  await button('Play script'); await button('Pause script');
  await page.getByLabel('Mirror text').check();
  await page.getByLabel('Pace in words per minute').fill('145');
  await page.getByLabel('Pace in words per minute').press('Tab');
  assert.equal((await prefs()).prompterSpeed, 145);
  await page.screenshot({ path:join(output, 'teleprompter.png') });

  async function recordTake(label, inPrompter = false) {
    console.log('Recording', inPrompter ? 'Teleprompter' : label);
    if (!inPrompter) { await open('Recorder'); await button(label); }
    await button('Start recording');
    await page.getByRole('button', { name:'Stop and save', exact:true }).waitFor();
    assert.equal(await page.getByRole('navigation').getByRole('link', { name:'Sessions', exact:true }).getAttribute('aria-disabled'), 'true');
    await pause(1500);
    const recordingHeapMiB = await heap();
    const saveStarted = performance.now();
    await button('Stop and save');
    await page.locator('main[data-view="review"]').waitFor();
    const state = await appState();
    const id = new URL(page.url()).hash.slice('#review/'.length).split('?')[0];
    const take = state.sessions.find(take => take.id === id);
    assert.ok(take?.duration > 1, 'The saved duration must include the recording, not just its first fragment');
    assert.ok(readFileSync(join(state.storage.folder, id, take.file)).length > 0);
    results.recordings.push({ mode:inPrompter ? 'Teleprompter' : label, duration:take.duration, mime:take.mime,
      saveToReviewMs:Math.round(performance.now() - saveStarted), recordingJSHeapMiB:recordingHeapMiB });
    return take;
  }
  const scripted = await recordTake('Voice', true);
  assert.equal(scripted.script, script);
  for (const mode of ['Voice', 'Camera', 'Screen', 'Screen + camera']) {
    const take = await recordTake(mode);
    if (mode === 'Screen + camera') assert.equal(take.captureMode, 'screen-camera');
  }
  if (!(await appState()).lightMedia) {
    await open('Recorder'); await button('Camera');
    await page.getByLabel('Replace background', { exact:true }).check();
    await recordTake('Camera');
    results.recordings.at(-1).backgroundReplacement = true;
    await open('Recorder'); await button('Camera');
    await page.getByLabel('Replace background', { exact:true }).uncheck();
  }
  console.log('Recorded and saved all four modes and a teleprompter take.');

  // WebView2's host resource interception bypasses Playwright network routes.
  // Inject one failed fetch at the application boundary in both environments.
  const failNextRequest = part => page.evaluate(part => {
    const original = window.fetch;
    window.fetch = function(url, options) {
      if (String(url).includes('/api/recordings/') && String(url).includes(part)) {
        window.fetch = original;
        return Promise.resolve(Response.json({ error:'Temporary disk write failure.' }, { status:503 }));
      }
      return original.call(this, url, options);
    };
  }, part);

  await open('Recorder'); await button('Voice');
  await failNextRequest('/finish');
  await button('Start recording'); await page.getByRole('button', { name:'Stop and save' }).waitFor();
  await pause(1100); await button('Stop and save');
  await page.getByRole('button', { name:'Retry save', exact:true }).waitFor();
  await button('Retry save'); await page.locator('main[data-view="review"]').waitFor();

  // A failed chunk stops capture, retains the unsent data, and retries the
  // same sequence number rather than appending duplicate audio.
  await open('Recorder');
  await failNextRequest('/chunks/');
  await button('Start recording');
  await page.getByRole('button', { name:'Retry save', exact:true }).waitFor();
  await button('Preview unsaved take');
  await page.waitForFunction(() => document.querySelector('#dialog audio,#dialog video')?.readyState > 0);
  await button('Close dialog');
  await button('Retry save'); await page.locator('main[data-view="review"]').waitFor();

  // Reload while recording, before MediaRecorder emits its final footer.
  await open('Recorder'); await button('Start recording');
  await page.getByRole('button', { name:'Stop and save' }).waitFor();
  let interrupted;
  for (let attempt = 0; attempt < 60; attempt++) {
    // Fragmented MP4 may deliver a header-only first chunk. Wait for audio.
    interrupted = (await appState()).recordings.find(take => take.bytes > 4096);
    if (interrupted) break;
    await pause(100);
  }
  assert.ok(interrupted, 'Recording chunks must reach disk before Stop');
  page.once('dialog', dialog => void dialog.accept());
  await page.reload();
  await page.getByRole('region', { name:'Interrupted recordings' }).waitFor();
  await page.screenshot({ path:join(output, 'recovery.png'), fullPage:true });
  await button('Recover take'); await page.locator('main[data-view="review"]').waitFor();
  assert.equal(new URL(page.url()).hash, `#review/${interrupted.id}`);
  assert.ok((await appState()).sessions.find(take => take.id === interrupted.id).duration > 0);
  results.interruptedRecordingRecovered = true;

  await open('Sessions');
  await page.locator('#import-file').setInputFiles(join(root, 'public/assets/example.mp3'));
  await page.locator('main[data-view="review"]').waitFor();
  let current = await appState();
  const id = new URL(page.url()).hash.slice('#review/'.length);
  const take = current.sessions.find(take => take.id === id);
  const file = join(current.storage.folder, id, 'session.json');
  const example = JSON.parse(readFileSync(join(root, 'public/assets/example.json'), 'utf8'));
  // A deterministic transcript fixture tests review controls without downloading a model.
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file,'utf8')), segments:example.segments,
    transcriptDone:true, script:'Hello everyone. Last week I tried a small experiment. This passage was skipped.' }));
  await page.reload(); await page.locator('.segment').first().waitFor();
  await page.getByPlaceholder('Find a phrase').fill('no-such-phrase-923');
  assert.ok(await page.locator('#no-matches').isVisible());
  await page.getByPlaceholder('Find a phrase').fill('');
  results.transcriptSeekMs = await page.evaluate(() => new Promise((resolve, reject) => {
    const media = document.querySelector('#media'), start = performance.now();
    const timeout = setTimeout(() => reject(new Error('Transcript seek timed out')), 5000);
    media.addEventListener('seeked', () => { clearTimeout(timeout); media.pause(); resolve(Math.round(performance.now() - start)); }, { once:true });
    document.querySelectorAll('.segment')[1].click();
  }));
  await page.getByRole('button', { name:'Mark practiced', exact:true }).first().click();
  assert.ok(Object.keys((await prefs()).takePractice[id]).length > 0);
  await button('Undo');
  await page.getByRole('button', { name:'Dismiss', exact:true }).first().click();
  await button('Feedback'); await button('Copy prompt');
  assert.match(await page.locator('#prompt-text').inputValue(), /Transcript:/);
  await button('Close dialog');
  await button('Edit tags'); await page.getByLabel('Tags', { exact:true }).fill('UI check, Presentation');
  await button('Save tags');
  await page.getByRole('link', { name:'Show this take on the calendar' }).click();
  await page.getByRole('button', { name:/example/ }).click();
  await page.locator('.take-menu summary').click(); await button('Rename');
  await page.getByLabel('Name', { exact:true }).fill('UI regression take'); await button('Save name');
  await page.getByRole('heading', { name:'UI regression take', exact:true }).waitFor();
  await page.screenshot({ path:join(output, 'review.png'), fullPage:true });

  await open('Sessions'); await button('List');
  await page.locator('#session-filter').selectOption('type:Voice');
  const beforeDelete = (await appState()).sessions;
  assert.equal(await page.locator('[data-session-select]').count(), 0);
  assert.equal(await page.getByRole('button', { name:'Select all', exact:true }).count(), 0);
  await button('Select');
  const visibleIds = await page.locator('[data-session-select]').evaluateAll(inputs => inputs.map(input => input.dataset.sessionSelect));
  assert.ok(visibleIds.length > 1 && visibleIds.length < beforeDelete.length);
  await page.locator('.session-row').first().click();
  assert.equal(await page.locator('[data-session-select]:checked').count(), 1);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('[data-session-select]:checked').count(), 0);
  await button('Done');
  assert.equal(await page.locator('[data-session-select]').count(), 0);
  await button('Select'); await button('Select all'); await page.keyboard.press('Escape');
  assert.equal(await page.locator('[data-session-select]').count(), 0);
  await button('Select');
  await button('Select all');
  assert.equal(await page.locator('[data-session-select]:checked').count(), visibleIds.length);
  await button('Delete selected'); await button('Cancel');
  assert.equal((await appState()).sessions.length, beforeDelete.length);
  await page.locator('#session-filter').selectOption('type:Video');
  assert.equal(await page.locator('[data-session-select]').count(), 0);
  await button('Calendar'); await button('Select'); await button('Select all');
  assert.equal(await page.locator('#calendar-agenda .selection-toolbar').count(), 0);
  assert.equal(await page.locator('[data-session-select]:checked').count(), await page.locator('#calendar-agenda .session-row').count());
  await page.screenshot({ path:join(output, 'calendar.png'), fullPage:true });
  await button('List');
  await page.locator('#session-filter').selectOption('type:Voice');
  await button('Select'); await button('Select all');
  // One busy take must remain selected when the other deletions succeed.
  await page.evaluate(id => {
    const original = window.fetch;
    window.fetch = function(url, options) {
      if (options?.method === 'DELETE' && String(url).endsWith(`/sessions/${id}`)) {
        window.fetch = original;
        return Promise.resolve(Response.json({ error:'Wait for transcription to finish.' }, { status:409 }));
      }
      return original.call(this, url, options);
    };
  }, visibleIds[0]);
  await button('Delete selected'); await button('Delete selected takes');
  await page.locator('#dialog').waitFor({ state:'hidden' });
  assert.equal((await appState()).sessions.length, beforeDelete.length - visibleIds.length + 1);
  assert.deepEqual(await page.locator('[data-session-select]:checked').evaluateAll(inputs => inputs.map(input => input.dataset.sessionSelect)), [visibleIds[0]]);
  await button('Delete selected'); await button('Delete selected takes');
  await page.locator('#dialog').waitFor({ state:'hidden' });
  assert.equal(await page.locator('[data-session-select]').count(), 0);
  const remainingIds = (await appState()).sessions.map(take => take.id).sort();
  assert.deepEqual(remainingIds, beforeDelete.filter(take => !visibleIds.includes(take.id)).map(take => take.id).sort());
  results.bulkSelectionAndDeletion = true;

  await open('Settings'); await appearance('Light');
  await appearance('Teal');
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
  const expected = await prefs();
  if (!desktop) {
    const downloaded = page.waitForEvent('download'); await button('Export practice backup');
    const backupFile = join(output, 'practice-backup.json'); await (await downloaded).saveAs(backupFile);
    const backup = JSON.parse(readFileSync(backupFile, 'utf8'));
    assert.equal(backup.preferences.scriptDraft, script);
    await appearance('Dark');
    await page.locator('#preferences-file').setInputFiles(backupFile);
    await button('Cancel'); assert.equal((await prefs()).theme, 'dark');
    await page.locator('#preferences-file').setInputFiles(backupFile);
    await button('Restore backup');
    assert.deepEqual(await prefs(), expected);
    await page.reload(); await page.getByRole('heading', { name:'Settings', exact:true }).waitFor();
    assert.deepEqual(await prefs(), expected);
  } else {
    // Native download dialogs are not driven by this check; restore uses the same file input.
    const { serializePreferencesBackup } = await import('../public/preferences-backup.js');
    await appearance('Dark');
    await page.locator('#preferences-file').setInputFiles({ name:'backup.json', mimeType:'application/json', buffer:Buffer.from(serializePreferencesBackup(expected)) });
    await button('Restore backup'); assert.deepEqual(await prefs(), expected);
  }
  await page.locator('#preferences-file').setInputFiles({ name:'bad.json', mimeType:'application/json', buffer:Buffer.from('{"wrong":true}') });
  await page.getByText('Choose an ArticuPath practice backup with version 1.', { exact:true }).waitFor();
  assert.deepEqual(await prefs(), expected);
  await page.screenshot({ path:join(output, 'settings.png'), fullPage:true });
  assert.deepEqual(errors, []);
  results.finalJSHeapMiB = await heap();
  writeFileSync(join(output, 'measurements.json'), JSON.stringify(results, null, 2));
  console.log(`UI checks passed. Measurements and screenshots: ${output}`);
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  if (page) {
    console.error('Failed at', page.url());
    await page.screenshot({ path:join(output, 'failure.png'), fullPage:true }).catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
}
