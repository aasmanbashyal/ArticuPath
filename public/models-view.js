import { selectedModel, state } from './state.js';
import { button, dialog, escape, formatStorage } from './ui.js';
import { prefs, savePrefs } from './preferences.js';

function modelsHTML() {
  if (!state.app.models.length) return '<p class="info">Checking installed models…</p>';
  const current = state.app.download;
  const choice = selectedModel();
  const catalogNotice = state.catalogRequest ? 'Checking Handy…' : state.app.catalogCurrent === false ? 'Handy is unavailable. Showing the models already listed.' : state.app.catalogCurrent ? 'Model list is up to date.' : '';
  return `${!(state.app.mediaReady ?? state.app.ffmpegReady) ? '<p class="warning">Install FFmpeg and add it to PATH to save and transcribe recordings.</p>' : ''}${!state.app.canInstall ? '<p class="warning">This platform needs a manually installed transcribe.cpp library. See README.</p>' : ''}
  <p class="info model-intro">Download a model to transcribe and jump to lines in your recordings offline.</p>
  <div id="model-options" role="group" aria-label="English transcription models">${state.app.models.map(m=>{
    const chosen = m.id === choice, downloading = current?.id === m.id && current.stage !== 'error';
    const ready = m.installed && state.app.engineReady;
    return `<article class="model-card">
      <div class="model-heading"><label class="model-main"><input type="radio" name="asr" value="${m.id}" ${chosen ? 'checked' : (ready ? '' : 'disabled')}><strong>${escape(m.name)}</strong></label>
      ${m.recommended ? '<span class="model-recommended">Recommended</span>' : ''}</div>
      <div class="model-actions"><span>${Math.round(m.size / (1024 ** 2))} MiB</span>
        ${Number.isFinite(m.wordErrorRate) ? `<span title="Handy’s English word error rate on FLEURS. Lower is better.">${m.wordErrorRate.toFixed(2)}% word error</span>` : ''}
        ${ready ? '<span class="installed">Installed</span>' : downloading ? `<progress ${current.total ? `value="${current.loaded}" max="${current.total}"` : ''} aria-label="Download progress"></progress><span>${current.stage === 'engine' ? 'Downloading engine' : current.stage === 'model' ? `Downloading model · ${Math.floor(current.loaded / 1024 ** 2)} MiB` : 'Starting download'}</span>` : button('download', 'Download', 'install', 'secondary', `aria-label="Download ${escape(m.name)}" data-id="${m.id}"${(current && current.stage !== 'error') || !state.app.canInstall ? ' disabled' : ''}`)}</div>
      ${current?.id === m.id && current.stage === 'error' ? `<p class="model-error">${escape(current.message)} Check your connection and retry.</p>` : ''}
    </article>`;
  }).join('')}</div>
  <div class="catalog-footer">${button('restart', 'Refresh model list', 'refresh-models', 'secondary', 'aria-controls="model-options"')}
    <p class="info">English benchmark · Lower word error is better. <a href="https://github.com/cjpais/Handy/blob/main/src-tauri/src/catalog/catalog.json" target="_blank" rel="noreferrer">Handy catalog</a></p><p class="info" role="status">${catalogNotice}</p>
  </div>`;
}

function offerTranscriptionSetup() {
  const model = state.app.models.find(entry => entry.recommended);
  if (!state.app.desktop || !state.app.canInstall || !model || state.app.download ||
      state.app.models.some(entry => entry.installed) || prefs.transcriptionSetupSeen) return;
  const modal = dialog('Set up transcription',
    `<p class="info">Download a speech model to transcribe your takes offline. You can record and play back takes without it.</p>
    <div class="dialog-actions">${button(null, 'Skip for now', 'close', 'secondary')}
    ${button('download', `Download model (${formatStorage(model.size)})`, 'install', 'primary', `data-id="${model.id}" data-first-run`)}</div>`);
  modal.addEventListener('close', () => {
    prefs.transcriptionSetupSeen = true;
    savePrefs();
  }, { once: true });
}

export { modelsHTML, offerTranscriptionSetup };
