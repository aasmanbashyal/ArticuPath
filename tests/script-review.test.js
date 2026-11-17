import { expect, test } from 'bun:test';
import { compareScript, collectPracticeItems } from '../public/script-review.js';

test('aligns words across a skipped word, a substitute and an aside', () => {
  const result = compareScript({
    script: 'Let’s carefully review the schedule before lunch.',
    segments: [
      { text: "Let's review the agenda,", start: 0, words: [
        { text: "Let's", start: 0 }, { text: 'review', start: .4 },
        { text: 'the', start: .7 }, { text: 'agenda', start: 1.1 },
      ] },
      { text: 'uh, before lunch!', start: 3 },
    ],
  });
  expect(result.matched).toBe(5);
  expect(result.skipped).toBe(1);
  expect(result.changed).toBe(1);
  expect(result.extra).toBe(1);
  expect(result.extras).toEqual([{ text: 'uh', start: 3, before: 5, heardIndex: 4 }]);
  expect(result.words.filter(word => word.type !== 'matched').map(({ text, type, heard, start }) => ({ text, type, heard, start }))).toEqual([
    { text: 'carefully', type: 'skipped', heard: undefined, start: 0 },
    { text: 'schedule', type: 'changed', heard: 'agenda', start: 1.1 },
  ]);
});

test('groups skipped passages and keeps repeated extra words independently playable', () => {
  const session = {
    script: 'Start with a slow, steady rhythm. Then stop.',
    segments: [
      { start: 0, text: 'um' },
      { start: 1, text: 'Start' },
      { start: 4, text: 'Then' },
      { start: 4.4, text: 'um' },
      { start: 4.8, text: 'stop' },
      { start: 5.2, text: 'um' },
    ],
  };
  const { words, extras } = compareScript(session);
  expect(extras.map(extra => [extra.before, extra.start])).toEqual([[0, 0], [words.length - 1, 4.4], [words.length, 5.2]]);
  const items = collectPracticeItems(session);
  expect(new Set(items.map(item => item.id)).size).toBe(4);
  expect(items.map(({ type, text, start }) => [type, text, start])).toEqual([
    ['extra', 'um', 0], ['extra', 'um', 4.4], ['extra', 'um', 5.2],
    ['skipped', 'with a slow, steady rhythm', 1],
  ]);
  const silent = { script: 'A silent take.', segments: [] };
  expect(compareScript(silent)).toBeNull();
  expect(collectPracticeItems(silent)).toEqual([]);
});
