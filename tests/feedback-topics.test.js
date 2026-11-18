import { expect, test } from 'bun:test';
import { feedbackContent, makePrompt } from '../public/feedback.js';
import { readTopicList } from '../public/cue-cards.js';

test('reads plain text, single-column CSV and named CSV columns with escaped quotes', () => {
  expect(readTopicList('list.TXT', '\uFEFFAn idea, with a comma\r\n\r\n Second ')).toEqual(['An idea, with a comma', 'Second']);
  expect(readTopicList('list.csv', '"An idea, with a comma"\nSecond')).toEqual(['An idea, with a comma', 'Second']);
  expect(readTopicList('list.csv', '\uFEFFname,Prompt\r\na,"Say ""hello"", then\r\nintroduce yourself."')).toEqual(['Say "hello", then\nintroduce yourself.']);
  for (const text of ['topic\r\n', '"unclosed', '"ok"extra', 'a,b\nx,y', 'topic,notes\n,missing']) {
    expect(() => readTopicList('list.csv', text)).toThrow();
  }
});

test('renders old and new feedback as safe text with playable timestamps', () => {
  const html = feedbackContent('## What worked\n- **Good** [00:04]\n- <img src=x> [00:51]\n\nA plain note.', 30);
  expect(html).toContain('<h3>What worked</h3><ul><li><strong>Good</strong>');
  expect(html).toContain('data-seconds="4"');
  expect(html).not.toContain('data-seconds="51"');
  expect(html).toContain('&lt;img src=x&gt; [00:51]</li></ul><p>A plain note.</p>');
  expect(feedbackContent('Old feedback', 2)).toBe('<p>Old feedback</p>');
  expect(makePrompt({ title:'Example', duration:7, segments:[{ start:3, text:'My example.' }] }, 'Focus on the ending.'))
    .toContain('[00:03] My example.');
});
