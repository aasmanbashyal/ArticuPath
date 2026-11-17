import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { buildBackend, project } from './backend.js';

const dev = process.argv.includes('--watch');
let child, rebuilding, dirty = false, closing = false, timer;
const watchers = [];
async function stop() {
  const previous = child;
  child = null;
  if (previous && previous.exitCode === null) {
    previous.kill();
    await once(previous, 'exit');
  }
}
async function restart() {
  if (rebuilding || closing) { dirty = true; return; }
  rebuilding = true;
  try {
    await stop();
    const executable = await buildBackend({ dev });
    if (closing) return;
    child = spawn(executable, ['--serve'], { cwd:project, windowsHide:true, stdio:'inherit', env:{
      ...process.env, CADENCE_HOME:process.env.CADENCE_HOME || join(project, '.cadence'),
      CADENCE_PORT:process.env.CADENCE_PORT || '4317',
    } });
    child.once('error', error => { console.error(error.message); process.exitCode = 1; });
    child.once('exit', code => { if (!dev && !closing) process.exitCode = code || 0; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { rebuilding = false; if (dirty && !closing) { dirty = false; void restart(); } }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  closing = true; clearTimeout(timer); watchers.forEach(watcher => watcher.close()); await stop();
});
if (dev) {
  const changed = () => { clearTimeout(timer); timer = setTimeout(() => void restart(), 200); };
  for (const folder of ['public', 'desktop-rust/src']) watchers.push(watch(join(project, folder), { recursive:true }, changed));
  for (const file of ['desktop-rust/Cargo.toml', 'desktop-rust/Cargo.lock']) watchers.push(watch(join(project, file), changed));
}
await restart();
