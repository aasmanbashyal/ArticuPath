// Export only saved practice data. API keys and recording-folder settings are not included.
const strings = new Set(['theme', 'accent', 'asr', 'scriptDraft', 'prompterMode', 'provider',
  'model-openai', 'model-ollama', 'cueCategory', 'cueDifficulty']);
const booleans = new Set(['prompterAuto', 'prompterMirror', 'prompterHideBackground', 'hideBackground',
  'hideSessionVideo', 'compactRecordings', 'transcriptionSetupSeen']);
const numbers = new Set(['prompterSpeed', 'prompterSize', 'practicePrompt', 'targetSeconds', 'prepSeconds']);
const lists = new Set(['legacyPracticeTakes', 'practicedWords']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeKey = key => !['__proto__', 'constructor', 'prototype'].includes(key);
export const maxBackupBytes = 5 * 1024 * 1024;

function checkedPreferences(source) {
  if (!object(source)) throw new Error('The backup does not contain practice settings.');
  const result = {};
  for (const [key, value] of Object.entries(source)) {
    let valid;
    if (key === 'feedbackPrompt') valid = typeof value === 'string' && value.length <= 4000;
    else if (strings.has(key)) valid = typeof value === 'string';
    else if (booleans.has(key)) valid = typeof value === 'boolean';
    else if (numbers.has(key)) valid = Number.isFinite(value);
    else if (lists.has(key)) valid = Array.isArray(value) && value.every(item => typeof item === 'string');
    else if (key === 'takePractice') {
      valid = object(value) && Object.entries(value).every(([id, marks]) => safeKey(id) && object(marks)
        && Object.entries(marks).every(([item, status]) => safeKey(item) && ['practiced', 'dismissed'].includes(status)));
    } else continue;
    if (!valid) throw new Error(`The backup contains invalid ${key} data.`);
    result[key] = value;
  }
  return result;
}

export function serializePreferencesBackup(preferences) {
  const text = JSON.stringify({ format:'articupath-practice', version:1, exportedAt:new Date().toISOString(),
    preferences:checkedPreferences(preferences) }, null, 2);
  if (new TextEncoder().encode(text).length > maxBackupBytes) throw new Error('The practice backup exceeds 5 MiB.');
  return text;
}

export function parsePreferencesBackup(text) {
  if (new TextEncoder().encode(text).length > maxBackupBytes) throw new Error('Choose a practice backup smaller than 5 MiB.');
  let backup;
  try { backup = JSON.parse(text); }
  catch { throw new Error('This file is not a valid JSON backup.'); }
  if (!object(backup) || backup.format !== 'articupath-practice' || backup.version !== 1) {
    throw new Error('Choose a Rehearsal practice backup with version 1.');
  }
  return checkedPreferences(backup.preferences);
}
