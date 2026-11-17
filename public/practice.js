import { state } from './state.js';
import { collectPracticeItems, compareScript } from './script-review.js';
import { $, button, escape, fmt } from './ui.js';
import { prefs, savePrefs } from './preferences.js';

const practicePageSize = 5;

const practiceTypes = { changed:'Different', skipped:'Missing', extra:'Extra' };

const practiceStatuses = { pending:'To review', practiced:'Practiced', dismissed:'Dismissed' };

function scriptReviewHTML() {
  if (!state.active.script) return '';
  const comparison = compareScript(state.active);
  const header = '<h2 id="practice-title">Practice this take</h2>';
  if (!comparison) {
    const busy = state.currentJob === state.active.id || state.app.running === state.active.id;
    const message = busy ? 'The comparison will appear when transcription finishes.' :
      state.active.segments.length ? 'This transcript is too long or contains no comparable words.' :
        state.active.transcriptDone ? 'No clear speech was detected to compare with your script.' :
          'Transcribe this take to compare it with your script.';
    return `<section class="comparison panel" aria-labelledby="practice-title">${header}<p class="info">${message}</p></section>`;
  }
  const { words, matched, skipped, changed, extra, extras } = comparison;
  let cursor = 0;
  let nextExtra = 0;
  const mark = (word, type, description) => `<button type="button" class="script-mark ${type}" data-action="script-jump" data-seconds="${Number(word.start) || 0}" aria-label="${escape(description)}. Listen nearby." title="${escape(description)}">${escape(word.text)}</button>`;
  const extraWords = before => {
    let markup = '';
    while (extras[nextExtra]?.before === before) {
      const word = extras[nextExtra++];
      markup += `${mark(word, 'extra', `${word.text}: extra word in transcript`)} `;
    }
    return markup;
  };
  const markedScript = words.map((word, index) => {
    const space = escape(state.active.script.slice(cursor, word.index));
    cursor = word.index + word.text.length;
    const prefix = space + extraWords(index);
    if (word.type === 'matched') return prefix + escape(word.text);
    const description = word.type === 'skipped' ? `${word.text}: missing from the transcript` : `${word.text}: transcribed as ${word.heard}`;
    return prefix + mark(word, word.type, description);
  }).join('') + escape(state.active.script.slice(cursor));
  const trailingExtras = extraWords(words.length);
  return `<section class="comparison panel" aria-labelledby="practice-title">${header}
    ${skipped || changed || extra ? '<p class="info">Listen to check whether a difference is worth practicing.</p>' : ''}
    <p id="practice-status-message" class="visually-hidden" role="status"></p>
    ${practiceQueueHTML()}
    <details class="full-comparison"><summary>Show full comparison</summary>
      <div class="comparison-stats"><span><strong>${matched}/${words.length}</strong> matched</span><span class="skipped"><strong>${skipped}</strong> missing</span><span class="changed"><strong>${changed}</strong> different</span><span class="extra"><strong>${extra}</strong> extra</span></div>
      <div class="marked-script" tabindex="0" role="region" aria-label="Script with differences">${markedScript}${trailingExtras ? ` ${trailingExtras}` : ''}</div>
    </details>
  </section>`;
}

function migratePracticeMarks(session) {
  if (!prefs.legacyPracticeTakes?.includes(session.id)) return;
  const legacy = new Set(prefs.practicedWords);
  const marks = Object.fromEntries(collectPracticeItems(session)
    .filter(item => item.legacyKeys?.every(key => legacy.has(key)))
    .map(item => [item.id, 'practiced']));
  savePracticeMarks(session.id, marks);
  prefs.legacyPracticeTakes = prefs.legacyPracticeTakes.filter(id => id !== session.id);
  if (!prefs.legacyPracticeTakes.length) {
    delete prefs.legacyPracticeTakes;
    delete prefs.practicedWords;
  }
  savePrefs();
}

function savePracticeMarks(id, marks) {
  if (Object.keys(marks).length) (prefs.takePractice ??= {})[id] = marks;
  else if (prefs.takePractice) delete prefs.takePractice[id];
}

function practiceQueueHTML() {
  const items = collectPracticeItems(state.active);
  if (!items.length) return '<p class="info practice-empty">The transcript matches the script.</p>';
  const marks = prefs.takePractice?.[state.active.id] || {};
  const { status, type, limit, undo } = state.practiceView;
  const byStatus = { pending:[], practiced:[], dismissed:[] };
  for (const item of items) byStatus[marks[item.id] || 'pending'].push(item);
  const visible = byStatus[status].filter(item => !type || item.type === type);
  const empty = status === 'pending' && !byStatus.pending.length ? 'No differences left to review.' : 'No differences match these filters.';
  const option = (value, label, selected) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`;
  return `<div id="practice-queue">
    <div class="practice-toolbar">
      <div class="practice-filters">
        <label class="visually-hidden" for="practice-status">Practice status</label><select id="practice-status">${Object.entries(practiceStatuses).map(([value, label]) => option(value, `${label} (${byStatus[value].length})`, status)).join('')}</select>
        <label class="visually-hidden" for="practice-type">Difference type</label><select id="practice-type">${option('', 'All types', type)}${Object.entries(practiceTypes).map(([value, label]) => option(value, label, type)).join('')}</select>
      </div>
      ${status === 'pending' && byStatus.pending.length ? button(null, 'Clear remaining', 'practice-clear', 'quiet', 'title="Dismiss all remaining differences in this take"') : ''}
    </div>
    ${undo ? `<div class="practice-undo"><p>${undo.message}</p>${button(null, 'Undo', 'practice-undo', 'quiet')}</div>` : ''}
    ${visible.length ? `<ul class="practice-list">${visible.slice(0, limit).map(practiceItemHTML).join('')}</ul>` : `<p class="info practice-empty">${empty}</p>`}
    ${visible.length > limit ? button(null, `Show ${Math.min(practicePageSize, visible.length - limit)} more`, 'practice-more', 'quiet') : ''}
  </div>`;
}

function practiceItemHTML(item) {
  const { id, type, text, heard, start } = item;
  const attrs = `data-item="${escape(id)}"`;
  const pending = state.practiceView.status === 'pending';
  return `<li><div class="practice-item-text">
    <span class="difference-tag ${type}">${practiceTypes[type]}</span>
    <strong class="practice-phrase">${escape(text)}</strong>${type === 'changed' ? `<p>Transcript: “${escape(heard)}”</p>` : ''}</div>
    <div class="practice-actions">
      ${button('headphones', `Listen at ${fmt(start)}`, 'script-jump', 'secondary', `data-seconds="${Number(start) || 0}" aria-label="Listen at ${fmt(start)}: ${escape(text)}"`)}
      ${pending ? `${button(null, 'Mark practiced', 'practice-mark', 'quiet', attrs)}${button(null, 'Dismiss', 'practice-dismiss', 'quiet', attrs)}` : button(null, 'Restore', 'practice-restore', 'quiet', attrs)}
    </div></li>`;
}

function updatePracticeMarks(ids, status, message) {
  if (!ids.length) return;
  const marks = { ...prefs.takePractice?.[state.active.id] };
  const previous = ids.map(id => [id, marks[id]]);
  for (const id of ids) {
    if (status) marks[id] = status;
    else delete marks[id];
  }
  savePracticeMarks(state.active.id, marks);
  savePrefs();
  state.practiceView.undo = { previous, message };
}

function renderPractice(focus, message = '') {
  $('#practice-queue').outerHTML = practiceQueueHTML();
  $('#practice-status-message').textContent = message;
  (focus() || $('#practice-status')).focus({ preventScroll:true });
}

function managePracticeItem(control, status, message) {
  const selector = `[data-action="${control.dataset.action}"]`;
  const index = [...document.querySelectorAll(selector)].indexOf(control);
  updatePracticeMarks([control.dataset.item], status, message);
  renderPractice(() => {
    const controls = document.querySelectorAll(selector);
    return controls[Math.min(index, controls.length - 1)] || $('[data-action="practice-undo"]');
  }, message);
}

export { managePracticeItem, migratePracticeMarks, practicePageSize, renderPractice, savePracticeMarks, scriptReviewHTML, updatePracticeMarks };
