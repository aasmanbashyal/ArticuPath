export const scriptMaxLength = 12_000;
export const scriptMaxWords = 1_600;
const transcriptMaxWords = 6_000;
const wordPattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu;
const fillerWord = /^(?:um+|uh+|erm+|hmm+)$/i;

function tokens(text) {
  return Array.from(text.matchAll(wordPattern), match => ({
    text: match[0], index: match.index,
    key: match[0].normalize('NFKC').replaceAll('’', "'").toLowerCase(),
  }));
}

export function countScriptWords(text) {
  return tokens(text).length;
}

const comparisons = new WeakMap();

export function compareScript(session) {
  if (!session.script || !session.segments?.length) return null;
  if (comparisons.has(session)) return comparisons.get(session);
  const expected = tokens(session.script);
  const heard = session.segments.flatMap(segment => (segment.words || [segment]).flatMap(part =>
    tokens(part.text).map(word => ({ ...word, start: part.start }))));
  if (!expected.length || !heard.length || expected.length > scriptMaxWords || heard.length > transcriptMaxWords) return null;

  // Store the path through the edit grid, but keep only two cost rows.
  const columns = heard.length + 1;
  const path = new Uint8Array((expected.length + 1) * columns);
  const extraCosts = Uint8Array.from(heard, word => fillerWord.test(word.key) ? 1 : 2);
  // Compare normalized words once up front, rather than comparing strings in
  // every cell of the grid. Zero marks words that do not occur in the script.
  const keys = new Map();
  const expectedIds = Uint16Array.from(expected, ({ key }) => {
    if (!keys.has(key)) keys.set(key, keys.size + 1);
    return keys.get(key);
  });
  const heardIds = Uint16Array.from(heard, ({ key }) => keys.get(key) ?? 0);
  let previous = new Uint16Array(columns);
  let current = new Uint16Array(columns);
  for (let j = 1; j <= heard.length; j++) previous[j] = previous[j - 1] + extraCosts[j - 1];
  for (let i = 1; i <= expected.length; i++) {
    current[0] = 2 * i;
    const expectedId = expectedIds[i - 1];
    const row = i * columns;
    for (let j = 1; j <= heard.length; j++) {
      const equal = expectedId === heardIds[j - 1];
      const extraCost = extraCosts[j - 1];
      const diagonal = previous[j - 1] + (equal ? 0 : extraCost === 1 ? 4 : 3);
      const skip = previous[j] + 2;
      const extra = current[j - 1] + extraCost;
      const best = Math.min(diagonal, skip, extra);
      current[j] = best;
      path[row + j] = best === diagonal ? 0 : best === skip ? 1 : 2;
    }
    [previous, current] = [current, previous];
  }

  const words = Array(expected.length);
  const extras = [];
  let matched = 0, skipped = 0, changed = 0;
  for (let i = expected.length, j = heard.length; i || j;) {
    const step = !j ? 1 : !i ? 2 : path[i * columns + j];
    if (step === 2) {
      const spoken = heard[--j];
      extras.push({ text: spoken.text, start: spoken.start, before: i, heardIndex: j });
    } else if (step === 1) {
      const nearby = heard[j - 1] || heard[j];
      i--;
      words[i] = { ...expected[i], type: 'skipped', start: nearby.start };
      skipped++;
    } else {
      const spoken = heard[--j];
      const word = expected[--i];
      const type = word.key === spoken.key ? 'matched' : 'changed';
      if (type === 'matched') matched++;
      else changed++;
      words[i] = { ...word, type, heard: spoken.text, start: spoken.start };
    }
  }
  const result = { words, matched, skipped, changed, extra: extras.length, extras: extras.reverse() };
  comparisons.set(session, result);
  return result;
}

const practiceItems = new WeakMap();

export function collectPracticeItems(session) {
  const comparison = compareScript(session);
  if (!comparison) return [];
  if (practiceItems.has(comparison)) return practiceItems.get(comparison);
  const { words, extras } = comparison;
  const items = [];
  for (let i = 0; i < words.length; i++) {
    const first = words[i];
    if (first.type === 'matched') continue;
    if (first.type === 'changed') {
      items.push({ ...first, legacyKeys: [first.key] });
      continue;
    }
    const legacyKeys = [first.key];
    while (words[i + 1]?.type === 'skipped') legacyKeys.push(words[++i].key);
    const last = words[i];
    const text = session.script.slice(first.index, last.index + last.text.length).replace(/\s+/g, ' ');
    items.push({ type: 'skipped', text, index: first.index, start: first.start, legacyKeys });
  }
  for (const word of extras) {
    items.push({ ...word, type: 'extra', index: words[word.before]?.index ?? session.script.length });
  }
  // Prefer spoken differences for the first few items. Large omissions are grouped below them.
  items.sort((a, b) => Number(a.type === 'skipped') - Number(b.type === 'skipped') ||
    a.index - b.index || Number(b.type === 'extra') - Number(a.type === 'extra'));
  for (const item of items) {
    item.id = JSON.stringify([item.type, item.index, item.heardIndex, item.text, item.heard]);
  }
  practiceItems.set(comparison, items);
  return items;
}
