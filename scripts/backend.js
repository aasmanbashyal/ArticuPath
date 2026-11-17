import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const project = resolve(import.meta.dirname, '..');

// Bun remains a launcher and test runner. All HTTP and speech processing live
// in Rust, including browser mode. Cargo handles incremental rebuilds.
export async function buildBackend({ dev = false } = {}) {
  if (process.env.REHEARSE_NATIVE_EXE) return resolve(process.env.REHEARSE_NATIVE_EXE);
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const localCargo = join(project, '.rust', 'cargo', 'bin', `cargo${suffix}`);
  const env = { ...process.env, CARGO_TARGET_DIR:join(project, 'desktop-rust', 'target', 'browser') };
  if (existsSync(localCargo)) {
    env.CARGO_HOME = join(project, '.rust', 'cargo');
    env.RUSTUP_HOME = join(project, '.rust', 'rustup');
  }
  const command = existsSync(localCargo) ? localCargo : 'cargo';
  const args = ['build', '--locked', '--features', 'full-media', '--manifest-path', 'desktop-rust/Cargo.toml'];
  if (!dev) args.push('--release');
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd:project, env, windowsHide:true, stdio:'inherit' });
    child.once('error', error => reject(new Error(`Could not start Rust. Install its toolchain and platform build prerequisites. ${error.message}`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Rust build failed (${code}).`)));
  });
  return join(env.CARGO_TARGET_DIR, process.env.CARGO_BUILD_TARGET || '', dev ? 'debug' : 'release', `rehearse${suffix}`);
}
