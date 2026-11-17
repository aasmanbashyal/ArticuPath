import { categories, cueCards, difficulties } from './cue-cards.js';
import { prefs, savePrefs } from './preferences.js';
import { $, button, escape, fmt, heading } from './ui.js';
import { state } from './state.js';
import { libraryRoute } from './library.js';

let prepDeadline = 0;

let prepTimer = null;

let prepRemaining = 60;

const cueCategory = () => Object.hasOwn(categories, prefs.cueCategory) ? prefs.cueCategory : '';

const cueDifficulty = () => Object.hasOwn(difficulties, prefs.cueDifficulty) ? prefs.cueDifficulty : '';

const matchingTopics = () => cueCards.flatMap((card, index) =>
  (!cueCategory() || card.category === cueCategory()) && (!cueDifficulty() || card.difficulty === cueDifficulty()) ? [index] : []);

const promptIndex = () => {
  const matches = matchingTopics();
  return matches.includes(prefs.practicePrompt) ? prefs.practicePrompt : matches[0];
};

const drawnTopics = new Set();

const targetOptions = [0, 60, 120, 180, 300];

const targetSeconds = () => targetOptions.includes(prefs.targetSeconds) ? prefs.targetSeconds : 120;

const cueHints = card => `<ul class="cue-hints">${card.hints.map(hint => `<li>${escape(hint)}</li>`).join('')}</ul>`;

function resetPreparation() {
  clearInterval(prepTimer);
  prepTimer = null;
  prepDeadline = 0;
  prepRemaining = 60;
}

function drawTopic(updateOptions = true) {
  const index = promptIndex();
  const card = cueCards[index];
  const list = $('#topic-select');
  if (updateOptions) {
    const matches = matchingTopics();
    list.innerHTML = Object.entries(categories).map(([value, label]) => {
      const inCategory = matches.filter(id => cueCards[id].category === value);
      return inCategory.length ? `<optgroup label="${escape(label)}">${inCategory.map(id =>
        `<option value="${id}">${escape(cueCards[id].label)}</option>`).join('')}</optgroup>` : '';
    }).join('');
    $('#topic-count').textContent = `${matches.length} ${matches.length === 1 ? 'topic' : 'topics'}`;
  }
  list.value = String(index);
  drawnTopics.add(index);
  $('#practice-prompt').innerHTML = `<div class="cue-badges"><span>${escape(categories[card.category])}</span><span>${difficulties[card.difficulty]}</span></div>
    <h2>${escape(card.prompt)}</h2><div class="cue-guide"><h3>Points to cover</h3>${cueHints(card)}</div>`;
  const related = $('#topic-sessions');
  related.hidden = !state.app.sessions.some(session => session.cueId === card.id);
  related.href = `#${libraryRoute(`cue:${card.id}`)}`;
}

function selectTopic(index, updateOptions = false) {
  if (state.shownRoute.startsWith('#topics/')) {
    state.shownRoute = '#topics';
    history.replaceState(null, '', state.shownRoute);
  }
  prefs.practicePrompt = index;
  savePrefs();
  drawTopic(updateOptions);
  resetPreparation();
  drawPreparation();
}

function drawPreparation() {
  const clock = $('#prep-clock');
  if (!clock) return;
  clock.textContent = fmt(prepRemaining);
  clock.dateTime = `PT${prepRemaining}S`;
  $('#prep-progress').value = 60 - prepRemaining;
  $('#prep-button').textContent = prepTimer ? 'Reset' : prepRemaining ? 'Start' : 'Restart';
  $('#prep-button').setAttribute('aria-label', prepTimer ? 'Reset preparation timer' : 'Start preparation timer');
  $('#prep-status').textContent = prepRemaining ? '' : 'Preparation finished.';
}

function togglePreparation() {
  if (prepTimer) {
    resetPreparation();
    drawPreparation();
    return;
  }
  prepRemaining = 60;
  prepDeadline = performance.now() + 60_000;
  prepTimer = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((prepDeadline - performance.now()) / 1000));
    if (remaining === prepRemaining) return;
    prepRemaining = remaining;
    if (!remaining) {
      clearInterval(prepTimer);
      prepTimer = null;
    }
    drawPreparation();
  }, 160);
  drawPreparation();
}

function topicsHTML() {
  const options = (values, selected) => Object.entries(values).map(([value, label]) =>
    `<option value="${value}" ${value === selected ? 'selected' : ''}>${escape(label)}</option>`).join('');
  return `${heading('Cue cards', 'Pick a topic and practice speaking without a script.')}
    <section class="topic-filters panel" aria-label="Choose a topic">
      <div class="topic-field"><label for="cue-category">Category</label><select id="cue-category">${options({ '': 'All categories', ...categories }, cueCategory())}</select></div>
      <div class="topic-field"><label for="cue-difficulty">Difficulty</label><select id="cue-difficulty">${options({ '': 'All levels', ...difficulties }, cueDifficulty())}</select></div>
      <div class="topic-picker">
        <div class="topic-field"><div class="topic-label"><label for="topic-select">Topic</label><span id="topic-count"></span></div><select id="topic-select" aria-describedby="topic-count"></select></div>
        ${button('shuffle', 'Shuffle', 'next-prompt', 'secondary')}
      </div>
    </section>
    <div class="topics-grid">
      <section class="prompt-panel" aria-label="Speaking topic">
        <div id="practice-prompt" class="prompt-content" aria-live="polite"></div>
      </section>
      <section class="prompt-timers panel" aria-label="Practice timers">
        <h2>Practice setup</h2>
        <div class="prep-block"><span>Preparation</span><div class="prep-controls"><time id="prep-clock" datetime="PT60S">01:00</time><button type="button" id="prep-button" class="button secondary" data-action="prep">Start</button></div>
          <progress id="prep-progress" max="60" value="0" aria-label="Preparation timer progress"></progress><p id="prep-status" class="prep-status" role="status"></p>
        </div>
        <div class="topic-field"><label for="target">Speaking target</label><select id="target"><option value="0">Off</option><option value="60">1 minute</option><option value="120">2 minutes</option><option value="180">3 minutes</option><option value="300">5 minutes</option></select></div>
        <p class="prep-status">The target is a guide. You choose when to stop.</p>
        ${button('arrow', 'Record this topic', 'use-topic', 'primary')}
        <a id="topic-sessions" class="topic-sessions" href="#library" hidden>Sessions for this topic</a>
      </section>
    </div>`;
}

export { cueCategory, cueDifficulty, cueHints, drawPreparation, drawTopic, drawnTopics, matchingTopics, promptIndex, resetPreparation, selectTopic, targetSeconds, togglePreparation, topicsHTML };
