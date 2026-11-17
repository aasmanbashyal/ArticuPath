import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const modelRoot = process.env.CADENCE_HOME ? resolve(process.env.CADENCE_HOME) : resolve(import.meta.dir, '.cadence');
const version = '0.4.2';
const packages = {
  'win32-x64': ['windows-x86_64-cpu-vulkan', '6094102cf57b404b050707ceb258b12ce647b92e801b5d46077214e5b030c8aa'],
  'linux-x64': ['linux-x86_64-cpu-vulkan', '4fe87db8919ea34e461db7987713b580f54e6f3ed610457c5d8fb8eac1a15046'],
  'linux-arm64': ['linux-aarch64-cpu-vulkan', '5e9cc7b244949fc686d1272e796e965411e80cc768533f1704c3c53e4c7d695e'],
  'darwin-arm64': ['macos-arm64-metal', '75ea3a705f3edec09942fdbb1b2b5509d7ecd75bda55158a47a3ab1e2d1105b3'],
  'darwin-x64': ['macos-x86_64-cpu', 'ca414e5b28706a2f2ecea1479b3e1c5f47d0f11f43aba86e289ae5c10b1ca40c'],
};
export const catalogURL = 'https://raw.githubusercontent.com/cjpais/Handy/main/src-tauri/src/catalog/catalog.json';
const catalogFile = join(modelRoot, 'handy-catalog.json');
const preferredIds = { 'parakeet-tdt_ctc-110m': 'parakeet-110m', 'parakeet-unified-en-0.6b': 'parakeet-unified' };
const builtInModels = [
  { id: 'parakeet-110m', name: 'Parakeet TDT-CTC 110M', wordErrorRate: 6.11, size: 135373280, sha: '7dd44c74a331d788a4e5f8b16913b3feb29ced22cf5613aad0e0f6cd30516296', revision: '9d66d34f9e1594075c5dd72c90c0f4c321b29f21', stem: 'parakeet-tdt_ctc-110m' },
  { id: 'parakeet-unified', name: 'Parakeet Unified English 0.6B', wordErrorRate: 3.99, size: 731357568, sha: '4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795', revision: '7e948f21b7bdbac698d3318db9d350f1096f3b6c', stem: 'parakeet-unified-en-0.6b' },
  { id: 'whisper-tiny.en', name: 'Whisper Tiny English', wordErrorRate: 10.72, size: 45904544, sha: 'e8c9b73c06344307d8b346e07fbe93dd88d894627854bcff31523f1ce44394fa', revision: 'becb8bcb804405dc97b380a523d9975888820986', stem: 'whisper-tiny.en' },
  { id: 'whisper-small.en', name: 'Whisper Small English', wordErrorRate: null, size: 269674144, sha: '9614e6b7fda2d26018e4f268aece8ca25a83296ea0b534169a585b740bfd71ef', revision: '41b0f75fd44415ba127a5356c5ba9ed450c1debd', stem: 'whisper-small.en' },
].map(({ stem, ...model }) => ({
  ...model, repo: `handy-computer/${stem}-gguf`, filename: `${stem}-Q8_0.gguf`,
}));
const library = { win32: 'transcribe.dll', darwin: 'libtranscribe.dylib', linux: 'libtranscribe.so' }[process.platform];
const platform = packages[`${process.platform}-${process.arch}`];
const engineFolder = join(modelRoot, `engine-${version}`);
export const modelFile = model => join(modelRoot, 'models', model.filename);
function findLibrary(folder) {
  if (!existsSync(folder)) return null;
  const children = readdirSync(folder, { withFileTypes: true });
  if (children.some(child => child.name === library && (child.isFile() || child.isSymbolicLink()))) return join(folder, library);
  for (const child of children) {
    if (!child.isDirectory()) continue;
    const found = findLibrary(join(folder, child.name));
    if (found) return found;
  }
  return null;
}
export const engine = () => (process.env.TRANSCRIBE_LIB ? resolve(process.env.TRANSCRIBE_LIB) : null) || findLibrary(engineFolder);
export const isInstalled = model => statSync(modelFile(model), { throwIfNoEntry: false })?.size === model.size;
const sameArtifact = (a, b) => a?.sha === b.sha && a.filename === b.filename;
export let downloadState = null;
export let models = builtInModels;
let catalog = null, triedAt = 0, refreshing = null;

function supportsEngine(minimum) {
  if (typeof minimum !== 'string' || !/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(minimum)) return false;
  const required = minimum.split('.').map(Number);
  const supported = version.split('.').map(Number);
  const difference = required.findIndex((part, i) => part !== supported[i]);
  return difference === -1 || required[difference] < supported[difference];
}

function catalogModel(entry, source) {
  if (!['parakeet', 'whisper'].includes(entry?.family) || entry.role !== 'asr' || entry.curated !== true || entry.capabilities?.timestamps !== true ||
      !Array.isArray(entry.languages) || !entry.languages.includes('en') || !supportsEngine(entry.minEngine)) return null;
  const { id, name, repository: repo, revision } = entry;
  const { filename, sha256: sha, size } = entry.files?.Q8_0 || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 120 ||
      typeof id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,70}$/.test(id) || Object.values(preferredIds).includes(id) ||
      typeof repo !== 'string' || !/^handy-computer\/[a-z0-9][a-z0-9._-]*-gguf$/.test(repo) ||
      typeof revision !== 'string' || !/^[a-f0-9]{40}$/.test(revision) ||
      typeof filename !== 'string' || !/^[a-z0-9][a-z0-9._-]*-Q8_0\.gguf$/.test(filename) ||
      typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha) ||
      !Number.isSafeInteger(size) || size <= 0 || size > 2 * 1024 ** 3) return null;
  const measuredError = source.results?.[id]?.accuracy?.en?.error;
  const wordErrorRate = source.benchmarks?.quant === 'Q8_0' && source.benchmarks?.accuracy?.dataset === 'fleurs' &&
    source.benchmarks.accuracy.split === 'test' && Number.isFinite(measuredError) && measuredError >= 0 ? measuredError : null;
  return { id: Object.hasOwn(preferredIds, id) ? preferredIds[id] : id, name, repo, revision, filename, sha, size, wordErrorRate };
}

function updateCatalog(next) {
  if (next?.schema !== 2 || !Array.isArray(next.models)) throw new Error('Unsupported Handy catalog.');
  // Keep a cached entry for every model already downloaded, even if Handy replaces or removes it.
  const previous = new Map(catalog?.models.map(entry => [entry.id, entry]));
  const entries = new Map();
  const byId = new Map(builtInModels.map(model => [model.id, model]));
  for (const entry of next.models) {
    const model = catalogModel(entry, next);
    if (!model || entries.has(entry.id)) continue;
    entries.set(entry.id, entry);
    const builtIn = byId.get(model.id);
    if (!builtIn || !isInstalled(builtIn) || sameArtifact(model, builtIn)) byId.set(model.id, model);
  }
  if (!entries.size) throw new Error('Handy returned no compatible models.');
  const results = { ...next.results };
  for (const model of models) {
    const oldEntry = previous.get(Object.keys(preferredIds).find(id => preferredIds[id] === model.id) || model.id);
    if (oldEntry && (isInstalled(model) || downloadState?.id === model.id) && !sameArtifact(byId.get(model.id), model)) {
      byId.set(model.id, model);
      entries.set(oldEntry.id, oldEntry);
      results[oldEntry.id] = catalog.results?.[oldEntry.id];
    }
  }
  models = [...byId.values()];
  catalog = { ...next, models: [...entries.values()], results };
}

try {
  updateCatalog(JSON.parse(readFileSync(catalogFile, 'utf8')));
  triedAt = statSync(catalogFile).mtimeMs;
} catch { /* Start with the built-in models if this is the first launch. */ }

export async function refreshCatalog() {
  if (refreshing) return refreshing;
  if (Date.now() - triedAt < 24 * 60 * 60_000) return true;
  refreshing = (async () => {
    try {
      const response = await fetch(catalogURL, { signal: AbortSignal.timeout(7000), redirect: 'error' });
      if (!response.ok) return false;
      updateCatalog(await response.json());
      triedAt = Date.now();
      try {
        mkdirSync(modelRoot, { recursive: true });
        writeFileSync(`${catalogFile}.partial`, JSON.stringify(catalog));
        renameSync(`${catalogFile}.partial`, catalogFile);
      } catch (err) { console.warn('Could not cache the Handy catalog:', err.message); }
      return true;
    } catch { return false; }
    finally { refreshing = null; }
  })();
  return refreshing;
}

export function modelStatus() {
  const engineReady = Boolean(engine());
  return { engineReady, canInstall: Boolean(platform || engineReady), download: downloadState, models: models.map(model => ({
    id: model.id, name: model.name, size: model.size, wordErrorRate: model.wordErrorRate, installed: isInstalled(model),
    recommended: model.id === 'parakeet-110m',
  })) };
}

async function download(url, target, checksum, stage) {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.partial`;
  downloadState = { id: downloadState.id, stage, loaded: 0, total: 0 };
  const signal = AbortSignal.timeout(20 * 60_000);
  try {
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`The download returned HTTP ${res.status}.`);
    downloadState.total = Number(res.headers.get('content-length')) || 0;
    const hash = createHash('sha256');
    const meter = new Transform({ transform(chunk, _enc, done) {
      hash.update(chunk);
      downloadState.loaded += chunk.length;
      done(null, chunk);
    } });
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(temp), { signal });
    if (hash.digest('hex') !== checksum) throw new Error('The download did not match the published checksum.');
    renameSync(temp, target);
  } finally {
    rmSync(temp, { force: true });
  }
}

export async function installModel(model) {
  if (downloadState && downloadState.stage !== 'error') throw new Error('Another model is already downloading.');
  downloadState = { id: model.id, stage: 'starting', loaded: 0, total: 0 };
  try {
    if (!engine()) {
      if (!platform) throw new Error('Install the transcribe.cpp native library for this platform and set TRANSCRIBE_LIB.');
      const [suffix, sha] = platform;
      const name = `transcribe-native-${version}-${suffix}.tar.gz`;
      const archive = join(modelRoot, name);
      const unpack = `${engineFolder}.incoming`;
      try {
        await download(`https://github.com/handy-computer/transcribe.cpp/releases/download/v${version}/${name}`, archive, sha, 'engine');
        mkdirSync(unpack, { recursive: true });
        const tar = Bun.spawnSync(['tar', '-xf', archive, '-C', unpack], { stderr: 'pipe' });
        if (tar.exitCode !== 0 || !findLibrary(unpack)) throw new Error('Could not extract the engine. Install it manually and set TRANSCRIBE_LIB.');
        renameSync(unpack, engineFolder);
      } finally {
        rmSync(archive, { force: true });
        rmSync(unpack, { force: true, recursive: true });
      }
    }
    if (!isInstalled(model)) await download(`https://huggingface.co/${model.repo}/resolve/${model.revision}/${model.filename}`, modelFile(model), model.sha, 'model');
    downloadState = null;
  } catch (err) {
    downloadState = { id: model.id, stage: 'error', message: err instanceof Error ? err.message : String(err) };
    throw err;
  }
}

