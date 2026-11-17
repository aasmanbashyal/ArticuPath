import { prefs } from './preferences.js';
import { $, button, escape, heading, icon, iconButton } from './ui.js';
import { state } from './state.js';
import { scriptMaxLength } from './script-review.js';
import { canShareScreen, captureModes, permissionStatus, prompterMode, usesCamera, usesScreen } from './capture-options.js';
import { capturePreviewHTML, recordButton, retryControlsHTML } from './recorder-view.js';

const prompterSpeed = () => prefs.prompterSpeed >= 60 && prefs.prompterSpeed <= 250 ? Number(prefs.prompterSpeed) : 130;

const prompterSize = () => prefs.prompterSize >= 18 && prefs.prompterSize <= 56 ? Number(prefs.prompterSize) : 32;

function teleprompterPageHTML() {
  return `${heading('Teleprompter', 'Read at your own pace and record a take when you’re ready.')}
    ${teleprompterHTML()}
    <div id="prompter-capture-extras">${prompterCaptureExtrasHTML()}</div>`;
}

function teleprompterHTML() {
  return `<section id="prompter-panel" class="teleprompter${state.activeScript ? ' has-script' : ''}" aria-label="Script reader">
    <div class="prompter-toolbar">
      <div class="prompter-actions prompter-playback">
        <button type="button" class="button primary prompter-play" data-action="prompter-toggle" aria-label="Play script">${icon('play')}${icon('pause')}<span>Play</span></button>
        ${iconButton('restart', 'Restart script', 'prompter-restart')}
      </div>
      <h2 class="prompter-editor-title">Edit script</h2>
      <div class="prompter-actions prompter-tools">
        ${button('edit', 'Edit script', 'edit-script', 'secondary prompter-edit')}
        ${document.fullscreenEnabled ? iconButton('expand', 'Full screen', 'prompter-fullscreen') : ''}
      </div>
    </div>
    <div class="prompter-stage">
      <div class="prompter-viewport" tabindex="0" role="region" aria-label="Scrolling script">
        <div class="prompter-text">${readingScriptHTML(state.activeScript)}</div>
        <div class="prompter-empty"><span class="row-icon">${icon('file')}</span><h2>No script yet</h2><p>Paste or write a script to get started.</p>${button('plus', 'Add script', 'edit-script', 'secondary')}</div>
      </div>
      <progress class="prompter-progress" max="1" value="0" aria-label="Script scroll position"></progress>
    </div>
    <form id="script-form" class="prompter-editor" hidden>
      <label class="visually-hidden" for="script-input">Script</label>
      <textarea id="script-input" maxlength="${scriptMaxLength}" placeholder="Paste or write your script here…" required></textarea>
      <p id="script-error" role="status" hidden></p>
      <div class="prompter-editor-foot">
        <label class="script-auto"><input id="prompter-auto" type="checkbox"> Start scrolling when recording begins</label>
        <div class="prompter-actions">${button(null, 'Cancel', 'cancel-script', 'secondary')}<button type="submit" class="button primary">Save script</button></div>
      </div>
    </form>
    <div class="prompter-controls" role="group" aria-label="Reading settings">
      <label class="prompter-pace">Pace <span><input id="prompter-speed" type="number" min="60" max="250" step="1" value="${prompterSpeed()}" aria-label="Pace in words per minute"> <abbr title="Words per minute">WPM</abbr></span></label>
      <label class="prompter-size">Text size <input id="prompter-size" type="range" min="18" max="56" value="${prompterSize()}" aria-label="Text size"><output id="script-size" for="prompter-size" aria-hidden="true"></output></label>
      <label class="prompter-mirror"><input id="prompter-mirror" type="checkbox" ${prefs.prompterMirror ? 'checked' : ''}> Mirror text</label>
      <p id="script-estimate"></p>
    </div>
    <div id="prompter-capture" class="prompter-capture" role="group" aria-label="Teleprompter recording">${prompterCaptureHTML()}</div>
    <div id="prompter-notice" class="toast" role="status" hidden></div>
  </section>`;
}

function readingScriptHTML(script) {
  // Format pasted headings and bold text while keeping the original script for review.
  const inline = line => escape(line).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const blocks = [], paragraph = [];
  const flush = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.splice(0).map(inline).join('\n')}</p>`);
  };
  for (const line of script.trim().split(/\r?\n/)) {
    const heading = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (!line.trim() || heading) flush();
    if (heading) {
      const level = Math.min(6, heading[1].length + 1);
      blocks.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (line.trim()) paragraph.push(line);
  }
  flush();
  return blocks.join('');
}

function prompterCaptureHTML() {
  const mode = prompterMode();
  const locked = state.phase !== 'idle', live = state.phase === 'recording';
  const status = live ? 'Recording' : state.phase === 'permission' ? permissionStatus(mode) : state.phase === 'saving' ? 'Saving take…' : captureModes[mode][2];
  const hasScreen = canShareScreen();
  return `<div class="prompter-capture-info">
    <h2>Record a take${live ? ' <time id="prompter-timer" datetime="PT0S">00:00</time>' : ''}</h2>
    <p id="capture-status" role="status">${status}</p>
  </div>
  <div class="prompter-capture-actions">
    <label class="visually-hidden" for="prompter-mode">Teleprompter recording mode</label>
    <select id="prompter-mode" ${locked ? 'disabled' : ''}>${Object.entries(captureModes).map(([value, [, label]]) =>
      `<option value="${value}" ${mode === value ? 'selected' : ''} ${usesScreen(value) && !hasScreen ? 'disabled' : ''}>${label}</option>`).join('')}</select>
    ${recordButton(true)}
  </div>
  <label id="prompter-background-control" class="camera-option" ${state.app.lightMedia || !usesCamera(mode) ? 'hidden' : ''}>
    <input id="prompter-hide-background" type="checkbox" ${prefs.prompterHideBackground ? 'checked' : ''} ${locked ? 'disabled' : ''}>Replace background
  </label>`;
}

function prompterCaptureExtrasHTML() {
  const mode = prompterMode();
  return (state.phase === 'recording' && mode !== 'audio' ? capturePreviewHTML(mode) : '') + retryControlsHTML();
}

function editScript() {
  if (state.phase !== 'idle') return;
  state.prompter?.pause();
  const input = $('#script-input');
  input.value = state.activeScript;
  $('#prompter-auto').checked = prefs.prompterAuto !== false;
  $('#script-error').hidden = true;
  $('#script-form').hidden = false;
  $('#prompter-panel').classList.add('is-editing');
  input.focus({ preventScroll: true });
  input.setSelectionRange(0, 0);
  input.scrollTop = 0;
}

function closeScriptEditor(focus) {
  $('#script-form').hidden = true;
  $('#prompter-panel').classList.remove('is-editing');
  $(focus).focus({ preventScroll: true });
}

export { closeScriptEditor, editScript, prompterCaptureExtrasHTML, prompterCaptureHTML, readingScriptHTML, teleprompterPageHTML };
