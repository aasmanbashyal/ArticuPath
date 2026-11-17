import { prefs } from './preferences.js';

// Shared state used by the page modules. Device handles and timers stay with their owners.
const state = {
  key: '', view: '', active: null, recorderMode: 'audio', phase: 'idle',
  app: { models: [], sessions: [] }, pending: undefined, mirroredCamera: true,
  recordingCue: null, activeScript: typeof prefs.scriptDraft === 'string' ? prefs.scriptDraft : '',
  prompter: undefined, practiceView: undefined, catalogRequest: null,
  player: undefined, currentJob: undefined, dialogTarget: undefined,
  syncPlayback: undefined, shownRoute: '',
  selectedSessionIds: new Set(), visibleSessionIds: [], selectingSessions: false, sessionSelectionRoute: '',
};

const defaultModel = 'parakeet-110m';

const selectedModel = () => state.app.models.some(model => model.id === prefs.asr) ? prefs.asr : defaultModel;

const modelReady = () => state.app.engineReady && state.app.models.some(m => m.id === selectedModel() && m.installed);

function upsert(session) {
  const index=state.app.sessions.findIndex(s=>s.id===session.id);
  if (index===-1) state.app.sessions.unshift(session); else state.app.sessions[index]=session;
  if(state.active?.id===session.id) state.active=session;
}

export { modelReady, selectedModel, state, upsert };
