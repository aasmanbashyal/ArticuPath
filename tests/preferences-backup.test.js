import { expect, test } from 'bun:test';
import { parsePreferencesBackup, serializePreferencesBackup } from '../public/preferences-backup.js';

test('round-trips saved practice data without exporting secrets or recording settings', () => {
  const preferences = { theme:'dark', accent:'teal', scriptDraft:'My script\nwith another line.',
    prompterSpeed:125, prompterMirror:true, provider:'openai', 'model-openai':'configured-model',
    takePractice:{ take1:{ item1:'practiced', item2:'dismissed' } },
    legacyPracticeTakes:['take2'], practicedWords:['earlier mark'] };
  const text = serializePreferencesBackup({ ...preferences, key:'secret', apiKey:'secret', folder:'C:/Recordings', keep:10 });
  expect(text).not.toContain('secret');
  expect(text).not.toContain('C:/Recordings');
  expect(parsePreferencesBackup(text)).toEqual(preferences);
});

test('rejects unrelated, unsupported, malformed, and oversized backups', () => {
  for (const text of ['not json', 'null', '[]', '{}', JSON.stringify({ format:'articupath-practice', version:2, preferences:{} }),
    JSON.stringify({ format:'articupath-practice', version:1, preferences:{ takePractice:{ take:{ item:'unknown' } } } }),
    JSON.stringify({ format:'articupath-practice', version:1, preferences:{ scriptDraft:42 } }), ' '.repeat(5 * 1024 * 1024 + 1)]) {
    expect(() => parsePreferencesBackup(text)).toThrow();
  }
});

test('rejects prototype keys in practice marks and ignores unknown settings', () => {
  const prefix = '{"format":"articupath-practice","version":1,"preferences":';
  expect(() => parsePreferencesBackup(prefix + '{"takePractice":{"__proto__":{"item":"practiced"}}}}')).toThrow();
  expect(() => parsePreferencesBackup(prefix + '{"takePractice":{"take":{"constructor":"practiced"}}}}')).toThrow();
  expect(parsePreferencesBackup(prefix + '{"__proto__":{"polluted":true},"theme":"light"}}')).toEqual({ theme:'light' });
  expect({}.polluted).toBeUndefined();
});
