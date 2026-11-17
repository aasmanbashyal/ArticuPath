import { $, button, escape, heading } from './ui.js';
import { appearanceHTML } from './appearance.js';
import { modelsHTML } from './models-view.js';
import { state } from './state.js';
import { prefs } from './preferences.js';

function settingsHTML() {
  return `${heading('Settings', '')}
    <div class="settings-grid">${appearanceHTML()}
      <section class="panel large-panel"><h2>Transcription models</h2><div id="models">${modelsHTML()}</div></section>
      <div class="settings-stack">${storageHTML()}
        <section class="panel large-panel"><h2>Feedback</h2>
          <label class="field">Provider<select id="provider"><option value="copy">Copy prompt only</option><option value="ollama">Ollama (local)</option><option value="openai">OpenAI (cloud)</option></select></label>
          <label class="field" id="model-field" hidden>Model<input id="coach-model" maxlength="100"><small id="model-help"></small></label>
          <label class="field" id="key-field" hidden>OpenAI API key<input id="coach-key" type="password" autocomplete="off" spellcheck="false"><small>${state.app.keyConfigured ? 'A key is configured on this device.' : 'Stored for this tab. For reuse, set OPENAI_API_KEY in .env.'}</small></label>
          <div class="dialog-actions">${button(null,'Save','save-coach','primary','aria-label="Save feedback settings"')}</div>
        </section>
      </div>
    </div>`;
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
  $('#coach-key').value=state.key;
  showSettingsFields();
}

function showSettingsFields() {
  const provider=$('#provider').value;
  $('#model-field').hidden=provider === 'copy'; $('#key-field').hidden=provider !== 'openai';
  $('#coach-model').value=prefs[`model-${provider}`] || (provider === 'openai' ? 'gpt-4.1-mini' : 'gemma3:1b');
  $('#model-help').textContent=provider === 'ollama' ? 'Use the name of a model already installed in Ollama.' : 'Use a chat model available to your API key.';
}

export { fillSettingsFields, settingsHTML, showSettingsFields };
