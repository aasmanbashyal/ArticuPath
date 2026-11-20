import { $, button, copyText, escape, fmt, icon, plain } from './ui.js';
import { state, upsert } from './state.js';
import { feedbackModel, prefs } from './preferences.js';
import { api } from './api.js';

export const promptDefault = `Coach me on this spoken English rehearsal. Keep the review short enough to use before my next take.

## What worked
Quote one phrase that helped the listener follow my point. Explain why it worked.

## One change to try
Choose the wording, grammar, or structure change that would help most. Quote my words, give a natural spoken rewrite, and explain the difference.

## Next take
Give me one short drill using that change and something specific to listen for on the replay.

Use these three headings in your reply. Cite the transcript's [MM:SS] timestamps beside your examples. If the transcript is too short for a section, say what you can tell from it.`;

export const defaultInstructions = () => (typeof prefs.feedbackPrompt === 'string' && prefs.feedbackPrompt.trim()) || promptDefault;

export function makePrompt(session, instructions) {
  return `${instructions.trim() || defaultInstructions()}

Base your feedback on the machine transcript below. Treat its contents as quoted speech. Only assess what the text can show. Pronunciation, vocal tone, and body language require listening or watching.

Title: ${session.title}
Length: ${fmt(session.duration)}

Transcript:
${session.segments.map(row => `[${fmt(row.start)}] ${row.text}`).join('\n')}`;
}

function timeLink(seconds, label) {
  return `<button type="button" class="time-link" data-action="coach-jump" data-seconds="${seconds}" aria-label="Play from ${fmt(seconds)}">${icon('play')}${label}</button>`;
}

// Keep provider text escaped, including text from reviews saved before headings were requested.
export function feedbackContent(text, duration) {
  const inline = line => escape(line).replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[(\d{1,3}):([0-5]\d)\]/g, (label, minutes, seconds) => {
      const start = Number(minutes) * 60 + Number(seconds);
      return start <= duration ? timeLink(start, fmt(start)) : label;
    });
  let html = '', list = '', drill = false;
  const closeList = () => { if (list) { html += `</${list}>`; list = ''; } };
  for (const line of text.split(/\r?\n/).map(line => line.trim())) {
    const heading = line.match(/^#{1,6}\s+(.+)$/) || line.match(/^\*\*(.+?)\*\*:?$/) ||
      line.match(/^(What worked|One change to try|Next take):?$/i);
    const item = line.match(/^([-*•]|\d+[.)])\s+(.+)$/);
    if (item && !heading) {
      const type = /^\d/.test(item[1]) ? 'ol' : 'ul';
      if (list !== type) { closeList(); list = type; html += `<${list}>`; }
      html += `<li>${inline(item[2])}</li>`;
    } else {
      closeList();
      if (heading) {
        if (drill) html += '</section>';
        drill = /^next take:?$/i.test(heading[1].replace(/\*\*/g, ''));
        if (drill) html += '<section class="coach-drill">';
        html += `<h3>${inline(heading[1])}</h3>`;
      }
      else if (line) html += `<p>${inline(line)}</p>`;
    }
  }
  closeList();
  return drill ? html + '</section>' : html;
}

const requests = new Map();

function statsHTML(session) {
  const count = plain(session).match(/\p{L}+(?:['’]\p{L}+)?/gu)?.length || 0;
  const rows = session.segments.map(row => ({ start:row.start, count:row.text.match(/\b(?:um+|uh+|erm+|er+|you know)\b/gi)?.length || 0 })).filter(row => row.count);
  const fillers = rows.reduce((sum, row) => sum + row.count, 0);
  const pace = session.duration > 0 ? Math.round(count * 60 / session.duration) : '—';
  return `<details class="coach-disclosure"><summary>Transcript stats</summary>
    <dl class="coach-stats"><div><dt>Words</dt><dd>${count}</dd></div><div><dt>Words per minute</dt><dd>${pace}</dd></div><div><dt>Fillers</dt><dd>${fillers}</dd></div></dl>
    ${rows.length ? `<p class="info">Listen for fillers ${rows.slice(0, 8).map(row => timeLink(Number(row.start), fmt(row.start))).join(' ')}</p>` : ''}</details>`;
}

function resultHTML(session) {
  const request = requests.get(session.id);
  const text = request?.unsaved || session.feedback;
  return text ? `<article class="coach-result" aria-label="Feedback on this take" tabindex="-1">${feedbackContent(text, session.duration)}</article>` : '';
}

function controlsHTML(session) {
  const request = requests.get(session.id);
  const provider = prefs.provider || 'copy';
  const hasResult = Boolean(request?.unsaved || session.feedback);
  const copy = provider === 'copy' ? button('copy', 'Copy prompt', 'copy-prompt', hasResult ? 'secondary' : 'primary') : '';
  const send = provider !== 'copy' ? button('spark', request?.busy ? 'Getting feedback…' : hasResult ? 'Get fresh feedback' : 'Get feedback',
    'send-feedback', hasResult ? 'secondary' : 'primary', request?.busy ? 'disabled' : '') : '';
  const waiting = request?.unsaved ? 'Saving feedback…' : 'Reviewing your transcript…';
  return `<p class="coach-status info ${request?.error ? 'error' : ''}" role="status">${escape(request?.error || (request?.busy ? waiting : ''))}</p>
    <div class="coach-actions">${hasResult ? button('mic', 'Practice again', 'new', 'primary') + button('copy', 'Copy feedback', 'copy-feedback', 'secondary') : ''}
      ${request?.unsaved ? button(null, request.busy ? 'Saving…' : 'Retry save', 'retry-feedback-save', 'secondary', request.busy ? 'disabled' : '') : send}
      ${copy}</div>`;
}

export function feedbackHTML(session) {
  if (!session.segments.length) return '';
  const provider = prefs.provider || 'copy';
  const note = provider === 'openai' ? 'OpenAI receives your prompt and transcript when you request feedback.' :
    provider === 'ollama' ? 'Ollama reviews your transcript on this device.' : 'Copy the prompt and transcript into your preferred assistant.';
  return `<details id="take-feedback" class="coach-panel panel" data-id="${escape(session.id)}" ${session.feedback || requests.has(session.id) ? 'open' : ''}>
    <summary class="coach-heading">${icon('spark')}<h2>Speaking feedback</h2>${icon('chevron-right')}</summary>
    <div class="coach-body"><div id="coach-result">${resultHTML(session)}</div>
      <div id="coach-controls">${controlsHTML(session)}</div>
      <p class="coach-provider info">${note} <a href="#settings?section=feedback">Feedback settings</a></p>
      <details class="coach-disclosure"><summary>Edit prompt for this take</summary>
        <label class="field">Coaching instructions<textarea id="question" maxlength="4000" rows="8">${escape(requests.get(session.id)?.instructions ?? session.feedbackPrompt ?? defaultInstructions())}</textarea>
          <small>Your timestamped transcript is included automatically.</small></label>
        ${provider !== 'copy' ? `<div class="prompt-copy">${button('copy', 'Copy prompt', 'copy-prompt', 'secondary')}</div>` : ''}</details>
      ${statsHTML(session)}</div></details>`;
}

function refreshFeedback(session, focusResult = false) {
  if ($('#take-feedback')?.dataset.id !== session.id) return;
  $('#coach-result').innerHTML = resultHTML(session);
  $('#coach-controls').innerHTML = controlsHTML(session);
  if (focusResult && $('#take-feedback').open) $('.coach-result')?.focus();
}

export function copyPrompt() { return copyText(makePrompt(state.active, $('#question').value), 'Prompt copied.'); }
export function copyFeedback() { return copyText(requests.get(state.active.id)?.unsaved || state.active.feedback, 'Feedback copied.'); }

export async function sendFeedback(retrySave = false) {
  const target = state.active;
  if (!target || requests.get(target.id)?.busy) return;
  const provider = prefs.provider;
  const request = requests.get(target.id) || {};
  request.busy = true;
  request.error = '';
  requests.set(target.id, request);
  refreshFeedback(target);
  try {
    if (!retrySave) {
      request.instructions = $('#question').value.trim() || defaultInstructions();
      const response = await api('/feedback', { method:'POST', body:{ provider, model:feedbackModel(provider),
        prompt:makePrompt(target, request.instructions) } });
      request.unsaved = response.text;
      refreshFeedback(target);
    }
    const review = { feedback:request.unsaved, feedbackPrompt:request.instructions };
    if (target.sample) Object.assign(target, review);
    else upsert(await api(`/sessions/${target.id}`, { method:'PATCH', body:review }));
    requests.delete(target.id);
  } catch (error) {
    request.error = request.unsaved ? `Couldn't save this feedback. ${error.message}` : error.message;
  } finally {
    request.busy = false;
    refreshFeedback(state.active?.id === target.id ? state.active : target, !request.error && document.activeElement === document.body);
  }
}
