import { $, button, escape, heading, icon, notifyError, toast } from './ui.js';
import { appearanceHTML } from './appearance.js';
import { modelsHTML } from './models-view.js';
import { state } from './state.js';
import { feedbackModel, prefs, replacePreferences } from './preferences.js';
import { defaultInstructions, promptDefault } from './feedback.js';
import { readTopicList, setCustomTopics } from './cue-cards.js';
import { api } from './api.js';
import { prepSeconds, targetOptionsHTML } from './topics.js';

const sections = [
  ['appearance', 'Appearance', 'settings'], ['feedback', 'Feedback', 'spark'],
  ['topics', 'Cue cards', 'layers'], ['models', 'Transcription', 'waveform'], ['storage', 'Storage', 'file'],
];

function selectSettingsSection() {
  const requested = new URLSearchParams(location.hash.split('?')[1]).get('section');
  const active = sections.some(([id]) => id === requested) ? requested : 'appearance';
  $('#settings-section').value = active;
  for (const [id] of sections) {
    $(`#settings-${id}`).hidden = id !== active;
    const link = $(`[data-settings-section="${id}"]`);
    if (id === active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (active === 'feedback' && $('#provider').value === 'openai') void loadKeyStatus();
}

function settingsHTML() {
  return `${heading('Settings', '')}
    <nav class="settings-nav" aria-label="Settings sections">${sections.map(([id, name, symbol]) =>
      `<a data-settings-section="${id}" href="#settings?section=${id}">${icon(symbol)}${name}</a>`).join('')}</nav>
    <div class="settings-picker field"><label class="visually-hidden" for="settings-section">Settings section</label>
      <select id="settings-section">${sections.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></div>
    <div class="settings-content">
      <div id="settings-appearance" hidden>${appearanceHTML()}</div>
      <section id="settings-models" class="panel large-panel" hidden><h2>Transcription models</h2><div id="models">${modelsHTML()}</div></section>
      <div id="settings-storage" hidden>${storageHTML()}</div>
      <section id="settings-topics" class="panel large-panel" hidden>${topicsSettingsHTML()}</section>
      <section id="settings-feedback" class="panel large-panel" hidden><h2>Speaking feedback</h2>
          <p class="info section-intro">Choose who reviews your transcript and what you want to work on.</p>
          <label class="field">Provider<select id="provider"><option value="copy">Copy prompt only</option><option value="ollama">Ollama (local)</option><option value="openai">OpenAI (cloud)</option></select></label>
          <label class="field" id="model-field" hidden>Model<input id="coach-model" maxlength="100"><small id="model-help"></small></label>
          <div id="key-field" hidden>
            <div class="field"><label for="coach-key">OpenAI API key</label>
              <input id="coach-key" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="1024" aria-describedby="key-help">
              <small id="key-help" role="status"></small></div>
            ${button('trash', 'Remove saved key', 'remove-openai-key', 'quiet', 'hidden')}
            ${button('restart', 'Check key storage again', 'check-key-storage', 'quiet', 'hidden')}</div>
          <details class="coach-disclosure"><summary>Default coaching prompt</summary>
            <label class="field">Instructions for new reviews<textarea id="default-question" rows="9" maxlength="4000">${escape(defaultInstructions())}</textarea></label>
            ${button('restart','Use original prompt','reset-coach-prompt','quiet')}</details>
          <div class="dialog-actions">${button(null,'Save feedback settings','save-coach','primary')}</div>
      </section>
    </div>`;
}

function topicsSettingsHTML() {
  const count = state.app.customTopics?.length || 0;
  return `<h2>Cue card library</h2><p class="info section-intro">Add your own speaking topics to the cue card picker.</p>
    <div class="settings-row"><div><h3>My topics</h3><p class="info" id="custom-count">${count} imported</p></div>
      <a id="practice-imported" href="#topics?collection=custom" ${count ? '' : 'hidden'}>Practice my topics ${icon('arrow')}</a></div>
    <div class="import-area"><h3>Import a topic list</h3>
      <p class="info">Use a TXT file with one topic per line, or a CSV with a <code>topic</code> column. Repeated topics are skipped.</p>
      ${button('upload', 'Choose file', 'import-topics', 'secondary')}
      <input id="topics-file" type="file" accept=".csv,.txt,text/csv,text/plain" hidden>
      <p id="import-status" class="info" role="status"></p></div>
    <h3 class="settings-subheading">Practice timers</h3>
    <div class="settings-fields"><label class="field">Preparation time (seconds)<input id="default-prep" type="number" min="1" max="3600" required value="${prepSeconds()}"></label>
    <label class="field">Speaking target<select id="default-target">${targetOptionsHTML()}</select></label></div>`;
}

export async function importTopics(file) {
  const choose = $('[data-action="import-topics"]');
  if (choose.disabled) return;
  const status = $('#import-status');
  choose.disabled = true;
  status.classList.remove('error');
  status.textContent = 'Reading topics…';
  try {
    if (file.size > 512 * 1024) throw new Error('Choose a topic list smaller than 512 KiB.');
    const prompts = readTopicList(file.name, await file.text());
    const result = await api('/topics/import', { method:'POST', body:prompts });
    state.app.customTopics = result.topics;
    setCustomTopics(result.topics);
    if ($('#custom-count')) {
      $('#custom-count').textContent = `${result.topics.length} imported`;
      $('#practice-imported').hidden = !result.topics.length;
    }
    status.textContent = `Added ${result.added} ${result.added === 1 ? 'topic' : 'topics'}. Skipped ${result.skipped} ${result.skipped === 1 ? 'duplicate' : 'duplicates'}.`;
  } catch (err) {
    status.classList.add('error');
    status.textContent = err.message;
  } finally { choose.disabled = false; }
}

function storageHTML() {
  const { folder, keep } = state.app.storage || {};
  const limits = [10, 20, 50, 100, 200, 500];
  const custom = keep && !limits.includes(keep);
  return `<section class="panel large-panel"><h2>Storage</h2>
    ${folder ? `<form id="storage-form"><label class="field" for="recording-folder">Recording folder</label>
      <div class="folder-field"><input id="recording-folder" name="folder" value="${escape(folder)}" aria-describedby="folder-help" spellcheck="false" required>
      ${window.ipc ? button(null, 'Browse…', 'choose-folder', 'secondary') : ''}</div>
      <p id="folder-help" class="info">New takes go here. Older takes stay in their original folders and remain in Sessions.</p>
      <label class="field">Automatic deletion<select id="retention-limit" name="limit" aria-describedby="retention-help">
        <option value="">Keep all sessions</option>${limits.map(limit => `<option value="${limit}" ${keep === limit ? 'selected' : ''}>Keep the latest ${limit}</option>`).join('')}
        <option value="custom" ${custom ? 'selected' : ''}>Custom limit</option></select></label>
      <label id="retention-custom-field" class="field" ${custom ? '' : 'hidden'}>Number of sessions<input type="number" name="custom" min="1" max="10000" step="1" value="${custom ? keep : 100}" ${custom ? 'required' : 'disabled'}></label>
      <p id="retention-help" class="info">With a limit set, saving a take permanently deletes the oldest sessions over that limit.</p>
      <div class="dialog-actions"><button class="button primary" type="submit">Save storage settings</button></div>
    </form>` : ''}
    <label class="check-field storage-compression"><input id="compact-recordings" type="checkbox" ${prefs.compactRecordings ? 'checked' : ''}>${state.app.lightMedia ? 'Use smaller recordings' : 'Compress new recordings and imports'}</label>
    <h3>Practice backup</h3>
    <p class="info">Save your script draft, appearance, preferences, and practice marks. Back up recording folders separately.</p>
    <div class="dialog-actions">${button('download', 'Export practice backup', 'export-preferences', 'secondary')}${button('upload', 'Restore practice backup', 'import-preferences', 'secondary')}</div>
    <input id="preferences-file" type="file" accept="application/json,.json" hidden>
  </section>`;
}

function fillSettingsFields() {
  $('#provider').value=prefs.provider || 'copy';
  showSettingsFields();
  selectSettingsSection();
}

function showSettingsFields() {
  const provider=$('#provider').value;
  $('#model-field').hidden=provider === 'copy'; $('#key-field').hidden=provider !== 'openai';
  $('#coach-model').value=feedbackModel(provider);
  $('#model-help').textContent=provider === 'ollama' ? 'Use the name of a model already installed in Ollama.' : 'Use a chat model available to your API key.';
  if (provider !== 'openai') $('#coach-key').value = '';
  else if (!$('#settings-feedback').hidden) void loadKeyStatus();
}

function drawKeyStatus(field, status) {
  const input = field.querySelector('input');
  field.dataset.status = 'ready';
  input.placeholder = status.saved ? '••••••••••••' : 'Enter API key';
  const help = field.querySelector('#key-help');
  if (!status.available) help.textContent = 'Secure storage is unavailable. Unlock your system keyring and try again.';
  else if (status.saved) help.textContent = 'Saved in your system credential store. Enter a new key to replace it.';
  else help.textContent = 'Save your OpenAI API key so you don’t have to enter it again when you reopen Rehearsal';
  if (status.environment && !status.saved) help.textContent += `${status.available ? '.' : ''} Rehearsal can use the key from OPENAI_API_KEY.`;
  field.querySelector('[data-action="remove-openai-key"]').hidden = !status.saved;
  field.querySelector('[data-action="check-key-storage"]').hidden = status.available;
}

export async function loadKeyStatus(recheck = false) {
  const field = $('#key-field');
  if (!field || (field.dataset.status && !recheck)) return;
  field.dataset.status = 'checking';
  field.querySelector('#key-help').textContent = 'Checking secure storage…';
  try {
    const status = await api('/credentials/openai');
    if (field.dataset.status === 'checking') drawKeyStatus(field, status);
  } catch {
    if (field.dataset.status === 'checking') drawKeyStatus(field, { available:false });
  }
}

export async function saveFeedbackSettings(save) {
  const providerField = $('#provider'), provider = providerField.value;
  const model = $('#coach-model').value.trim();
  if (provider !== 'copy' && !model) { $('#coach-model').focus(); toast('Enter a model name.', true); return; }
  const field = $('#key-field'), input = field.querySelector('input');
  const prompt = $('#default-question'), instructions = prompt.value.trim();
  const key = provider === 'openai' ? input.value.trim() : '';
  save.disabled = providerField.disabled = input.disabled = true;
  try {
    if (key) {
      drawKeyStatus(field, await api('/credentials/openai', { method:'PUT', body:{ key } }));
      input.value = '';
    }
    const next = { ...prefs, provider };
    if (provider !== 'copy') next[`model-${provider}`] = model;
    if (!instructions || instructions === promptDefault) delete next.feedbackPrompt;
    else next.feedbackPrompt = instructions;
    replacePreferences(next);
    prompt.value = instructions || promptDefault;
    toast('Feedback settings saved.');
  } catch (err) { notifyError(err); }
  finally { save.disabled = providerField.disabled = input.disabled = false; }
}

export async function removeSavedKey(confirm) {
  const field = $('#key-field'), modal = $('#dialog');
  confirm.disabled = true;
  try {
    const status = await api('/credentials/openai', { method:'DELETE' });
    if (field) { field.querySelector('input').value = ''; drawKeyStatus(field, status); }
    if (confirm.isConnected) modal.close();
    toast('Saved OpenAI key removed.');
  } catch (err) { confirm.disabled = false; notifyError(err); }
}

export { fillSettingsFields, selectSettingsSection, settingsHTML, showSettingsFields };
