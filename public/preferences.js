const prefs = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('cadence-settings'));
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  } catch { return {}; }
})();

const savePrefs = () => localStorage.setItem('cadence-settings', JSON.stringify(prefs));

const feedbackModel = provider => prefs[`model-${provider}`] || (provider === 'openai' ? 'gpt-6.1-terra' : 'gemma3:1b');

function replacePreferences(next) {
  // Write first so a storage failure leaves the current settings intact.
  localStorage.setItem('cadence-settings', JSON.stringify(next));
  for (const key of Object.keys(prefs)) delete prefs[key];
  Object.assign(prefs, next);
}

export { feedbackModel, prefs, replacePreferences, savePrefs };
