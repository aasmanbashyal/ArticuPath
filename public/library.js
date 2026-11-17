import { categories, cueCards } from './cue-cards.js';
import { $, button, dateKey, dialog, escape, fmt, heading, icon, iconButton, niceDate, sessionDay } from './ui.js';
import { state } from './state.js';
import { usesScreen } from './capture-options.js';

const sessionCue = session => cueCards.find(card => card.id === session?.cueId);

const libraryParams = () => new URLSearchParams(location.hash.split('?')[1]);

function libraryRoute(filter, params = new URLSearchParams()) {
  if (filter) params.set('filter', filter); else params.delete('filter');
  return params.size ? `library?${params}` : 'library';
}

function libraryReturnRoute() {
  const params = libraryParams();
  return libraryRoute(params.get('filter'), params);
}

const tagFilter = tag => `tag:${tag.toLowerCase()}`;

function sessionLabels(session) {
  const kind = sessionKind(session);
  return [[`type:${kind}`, kind], ...(session.script ? [['type:Scripted', 'Scripted']] : [])];
}

function tagChip(label, filter, cue = false) {
  const classes = `session-tag${cue ? ' cue-tag' : ''}`;
  const text = `${cue ? icon('link') : ''}${escape(label)}`;
  return filter ? `<a class="${classes}" href="#${escape(libraryRoute(filter))}" aria-label="Filter sessions by ${escape(label)}">${text}</a>` :
    `<span class="${classes}">${text}</span>`;
}

function sessionMetadataHTML(session) {
  const cue = sessionCue(session);
  const day = sessionDay(session);
  return `<div class="session-metadata">
    ${day ? `<a class="session-tag cue-tag" href="#library?view=calendar&amp;month=${day.slice(0,7)}&amp;day=${day}" aria-label="Show this take on the calendar">${icon('calendar')}${niceDate(session.createdAt)}</a>` : ''}
    ${cue ? `<a class="session-tag cue-tag" href="#topics/${cue.id}" aria-label="Open cue card: ${escape(cue.label)}">${icon('link')}${escape(cue.label)}</a>` : ''}
    ${sessionLabels(session).map(([filter, label]) => tagChip(label, filter)).join('')}
    ${(session.tags || []).map(tag => tagChip(tag, tagFilter(tag))).join('')}
    ${button('edit', 'Edit tags', 'edit-tags', 'quiet')}
  </div>`;
}

function editSessionTags() {
  state.dialogTarget = state.active;
  const options = Object.entries(categories).map(([category, label]) =>
    `<optgroup label="${escape(label)}">${cueCards.filter(card => card.category === category).map(card =>
      `<option value="${card.id}" ${card.id === state.active.cueId ? 'selected' : ''}>${escape(card.label)}</option>`).join('')}</optgroup>`).join('');
  dialog('Edit tags', `<form id="session-tags-form">
    <label class="field">Tags<input name="tags" value="${escape((state.active.tags || []).join(', '))}" aria-describedby="tag-help"></label>
    <p class="info" id="tag-help">Separate tags with commas. Add up to 10 tags.</p>
    <label class="field"><span id="cue-tag-label">Cue card</span><select name="cueId" aria-labelledby="cue-tag-label"><option value="">No cue card</option>${options}</select></label>
    <div class="dialog-actions">${button(null, 'Cancel', 'close', 'secondary')}<button class="button primary" type="submit">Save tags</button></div>
  </form>`);
  $('#session-tags-form input').focus();
}

function sessionKind(session) {
  if (session.captureMode === 'screen-camera') return 'Screen + camera';
  if (session.captureMode === 'screen') return 'Screen';
  return session.kind === 'video' ? 'Video' : 'Voice';
}

function sessionRow(session, detail = session.sample ? 'Example' : niceDate(session.createdAt), compact = false) {
  const symbol = usesScreen(session.captureMode) ? 'screen' : session.kind === 'video' ? 'video' : 'mic';
  const cue = sessionCue(session);
  const labels = sessionLabels(session).map(([, label]) => label);
  const tags = [...(compact ? [] : labels), ...(session.tags || [])];
  const content = `
    <span class="row-icon">${icon(symbol)}</span>
    <span class="row-text"><strong>${escape(session.title)}</strong><small>${detail}${compact ? ` · ${labels.map(escape).join(' · ')}` : ''}</small></span>
    ${tags.length || cue ? `<span class="session-row-tags">${tags.map(tag => tagChip(tag)).join('')}${cue ? tagChip(cue.label, '', true) : ''}</span>` : ''}
    <time>${fmt(session.duration)}</time>${state.selectingSessions ? '' : icon('chevron-right')}`;
  if (state.selectingSessions) {
    const selected = state.selectedSessionIds.has(session.id);
    return `<label class="session-entry is-selecting${selected ? ' is-selected' : ''}">
      <span class="session-select"><input type="checkbox" data-session-select="${session.id}" aria-label="Select ${escape(session.title)}" ${selected ? 'checked' : ''}></span>
      <span class="session-row">${content}</span>
    </label>`;
  }
  return `<div class="session-entry"><button type="button" class="session-row" data-action="open-session" data-id="${session.id}">${content}</button></div>`;
}

function libraryHTML() {
  if (state.sessionSelectionRoute !== location.hash) {
    state.selectingSessions = false;
    state.selectedSessionIds.clear();
    state.sessionSelectionRoute = location.hash;
  }
  const types = new Map();
  const tags = new Map();
  const cues = new Map();
  for (const session of state.app.sessions) {
    for (const [value, label] of sessionLabels(session)) types.set(value, label);
    for (const tag of session.tags || []) tags.set(tagFilter(tag), tag);
    const cue = sessionCue(session);
    if (cue) cues.set(`cue:${cue.id}`, cue.label);
  }
  const params = libraryParams(), requested = params.get('filter');
  const calendar = params.get('view') === 'calendar';
  const filter = types.has(requested) || tags.has(requested) || cues.has(requested) ? requested : '';
  const sessions = filter ? state.app.sessions.filter(session => sessionLabels(session).some(([value]) => value === filter) ||
    `cue:${session.cueId}` === filter || session.tags?.some(tag => tagFilter(tag) === filter)) : state.app.sessions;
  const options = (label, values) => values.size ? `<optgroup label="${label}">${[...values].sort((a, b) => a[1].localeCompare(b[1])).map(([value, name]) =>
    `<option value="${escape(value)}" ${filter === value ? 'selected' : ''}>${escape(name)}</option>`).join('')}</optgroup>` : '';
  const filters = types.size ? `<label class="session-filter">Filter sessions<select id="session-filter">
    <option value="">All sessions</option>${options('Take type', types)}${options('Cue cards', cues)}${options('Custom tags', tags)}</select></label>` : '';
  const content = calendar ? calendarHTML(sessions, params) : sessionList(sessions, filter ? 'No matching sessions' : 'No sessions yet', filter ? 'Choose another tag to see more takes.' : 'Record or import a take to save it here.');
  const select = state.visibleSessionIds.length ? button(null, state.selectingSessions ? 'Done' : 'Select', 'toggle-session-selection', 'secondary', `aria-pressed="${state.selectingSessions}"`) : '';
  return `${heading('Sessions', '', button('upload', 'Import audio or video', 'import', 'secondary'))}
    <div class="library-toolbar"><div class="view-options" role="group" aria-label="Session view">
      ${button('list', 'List', 'library-view', 'quiet', `data-view="list" aria-pressed="${!calendar}"`)}
      ${button('calendar', 'Calendar', 'library-view', 'quiet', `data-view="calendar" aria-pressed="${calendar}"`)}</div><div class="library-tools">${filters}${select}</div></div>
    ${selectionControls()}${content}
    <input id="import-file" type="file" accept="audio/*,video/*,.m4a,.mkv,.webm" hidden>`;
}

function setVisibleSessions(sessions) {
  state.visibleSessionIds = sessions.map(take => take.id);
  const visible = new Set(state.visibleSessionIds);
  for (const id of state.selectedSessionIds) if (!visible.has(id)) state.selectedSessionIds.delete(id);
  if (!sessions.length) state.selectingSessions = false;
}

function selectionControls() {
  if (!state.selectingSessions) return '';
  const count = state.selectedSessionIds.size;
  return `<div class="selection-toolbar" role="group" aria-label="Session selection">
    <div class="selection-summary">${button(null, count === state.visibleSessionIds.length ? 'Deselect all' : 'Select all', 'select-all-sessions', 'quiet')}
    <span role="status">${count ? `${count} selected` : 'Choose takes to delete'}</span></div>
    ${button('trash', 'Delete selected', 'delete-selected-sessions', 'danger', count ? '' : 'disabled')}
  </div>`;
}

function sessionList(sessions, title, detail = '') {
  setVisibleSessions(sessions);
  return sessions.length
    ? `<div class="session-list panel">${sessions.map(session => sessionRow(session)).join('')}</div>`
    : `<div class="panel empty-state"><h2>${title}</h2>${detail ? `<p>${detail}</p>` : ''}</div>`;
}

const monthFormat = new Intl.DateTimeFormat(undefined, { month:'long', year:'numeric' });

const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday:'short' });

const fullDayFormat = new Intl.DateTimeFormat(undefined, { weekday:'long', month:'long', day:'numeric' });

const shortTimeFormat = new Intl.DateTimeFormat(undefined, { timeStyle:'short' });

const takeCount = count => `${count} ${count === 1 ? 'take' : 'takes'}`;

function calendarHTML(sessions, params) {
  const today = dateKey(new Date());
  const requested = params.get('month');
  const [year, month] = (/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(requested || '') ? requested : today.slice(0,7)).split('-').map(Number);
  const first = new Date(year, month - 1, 1);
  const last = new Date(year, month, 0);
  const key = dateKey(first).slice(0,7);
  const byDay = new Map();
  let monthTotal = 0;
  for (const session of sessions) {
    const day = sessionDay(session);
    if (!day.startsWith(`${key}-`)) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(session);
    monthTotal++;
  }
  const requestedDay = params.get('day');
  const selected = requestedDay && /^\d{4}-\d{2}-\d{2}$/.test(requestedDay) && requestedDay.startsWith(`${key}-`)
      && Number(requestedDay.slice(8)) >= 1 && Number(requestedDay.slice(8)) <= last.getDate() ? requestedDay :
    (byDay.has(today) ? today : [...byDay.keys()].sort().at(-1));
  const offset = (first.getDay() + 6) % 7;
  const weeks = Math.ceil((offset + last.getDate()) / 7);
  const cells = Array.from({ length: weeks * 7 }, (_, index) => {
    const day = index - offset + 1;
    if (day < 1 || day > last.getDate()) return '<span class="calendar-outside" aria-hidden="true"></span>';
    const date = `${key}-${String(day).padStart(2, '0')}`;
    const count = byDay.get(date)?.length ?? 0;
    const current = date === today ? ' aria-current="date"' : '';
    const dayNumber = `<span class="calendar-number">${day}</span>`;
    if (!count) return `<span class="calendar-day${date === selected ? ' is-selected' : ''}"${current}>${dayNumber}</span>`;
    const activity = '<i></i>'.repeat(Math.min(count, 5));
    return `<button type="button" class="calendar-day has-takes" data-action="calendar-day" data-day="${date}"
      aria-controls="calendar-agenda" aria-pressed="${date === selected}"${current} aria-label="${escape(niceDate(`${date}T00:00`))}, ${takeCount(count)}">
      ${dayNumber}<span class="calendar-count" aria-hidden="true">${count}</span>
      <span class="calendar-activity" aria-hidden="true">${activity}</span>
    </button>`;
  }).join('');
  const weekdays = Array.from({ length: 7 }, (_, index) => `<span>${escape(weekdayFormat.format(new Date(2024, 0, index + 1)))}</span>`).join('');
  const monthKey = number => dateKey(new Date(year, number, 1)).slice(0,7);
  return `<div class="calendar-browser">
    <section class="calendar panel" aria-labelledby="calendar-month">
      <header class="calendar-header">
        <div><h2 id="calendar-month">${escape(monthFormat.format(first))}</h2>
          ${monthTotal ? `<p>${takeCount(monthTotal)} across ${byDay.size} ${byDay.size === 1 ? 'day' : 'days'}</p>` : ''}
        </div>
        <div class="calendar-controls">
          ${button(null, 'Today', 'calendar-today', 'quiet', `data-day="${today}"`)}
          <div class="calendar-arrows" role="group" aria-label="Change month">
            ${iconButton('chevron-left', 'Previous month', 'calendar-month', `data-month="${monthKey(month - 2)}" data-direction="previous"`)}
            ${iconButton('chevron-right', 'Next month', 'calendar-month', `data-month="${monthKey(month)}" data-direction="next"`)}
          </div>
        </div>
      </header>
      <div class="calendar-weekdays" aria-hidden="true">${weekdays}</div>
      <div class="calendar-grid">${cells}</div>
    </section>
    ${calendarAgenda(selected, byDay.get(selected) || [])}
  </div>`;
}

function calendarAgenda(day, sessions) {
  const title = day ? escape(fullDayFormat.format(new Date(`${day}T00:00`))) : 'No takes this month';
  setVisibleSessions(sessions);
  const rows = sessions.map(session => sessionRow(session, shortTimeFormat.format(new Date(session.createdAt)), true)).join('');
  return `<section class="calendar-agenda panel" id="calendar-agenda" aria-labelledby="calendar-results">
    <header class="calendar-agenda-header">
      <div><h2 id="calendar-results" tabindex="-1">${title}</h2>${day ? `<p>${takeCount(sessions.length)}</p>` : ''}</div>
    </header>
    ${rows ? `<div class="session-list">${rows}</div>` : `<p class="calendar-agenda-empty">${day ? 'No takes on this day.' : 'Use the arrows to browse other months.'}</p>`}
  </section>`;
}

export { editSessionTags, libraryHTML, libraryParams, libraryReturnRoute, libraryRoute, sessionCue, sessionMetadataHTML };
