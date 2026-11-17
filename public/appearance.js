import { prefs } from './preferences.js';
import { $ } from './ui.js';
import { state } from './state.js';
import { drawMeter } from './recorder-display.js';
import { meterStyle } from './recorder-view.js';

const themeOptions = { dotted: 'Dotted', light: 'Light', dark: 'Dark', system: 'System' };

const accentOptions = { blue: 'Blue', red: 'Red', graphite: 'Graphite', lime: 'Lime', sky: 'Sky', teal: 'Teal', amber: 'Amber', rose: 'Rose', lavender: 'Lavender' };

const systemTheme = matchMedia('(prefers-color-scheme: dark)');

const windowsChrome = window.articuPathWindow === true;

const themePreference = () => Object.hasOwn(themeOptions, prefs.theme) ? prefs.theme : 'dotted';

const accentPreference = () => Object.hasOwn(accentOptions, prefs.accent) ? prefs.accent : 'red';

function applyAppearance() {
  const theme = themePreference();
  const dark = theme === 'dotted' || theme === 'dark' || (theme === 'system' && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.palette = theme === 'dotted' ? 'dotted' : 'standard';
  document.documentElement.dataset.accent = accentPreference();
  const style = getComputedStyle(document.documentElement);
  const color = prop => style.getPropertyValue(prop).trim();
  $('meta[name="theme-color"]').content = color('--canvas');
  if (windowsChrome) window.ipc.postMessage(`appearance:${dark ? 'dark' : 'light'}:${color('--line')}`);
}

function appearanceHTML() {
  const theme = themePreference(), accent = accentPreference();
  return `<section class="panel large-panel appearance-panel" aria-labelledby="appearance-title">
    <h2 id="appearance-title">Appearance</h2>
    <div class="appearance-grid">
      <fieldset>
        <legend>Theme</legend>
        <div class="theme-options">${Object.entries(themeOptions).map(([value, label]) => `
          <label class="appearance-choice"><input class="visually-hidden" type="radio" name="theme" value="${value}" ${theme === value ? 'checked' : ''}><span>${label}</span></label>`).join('')}
        </div>
      </fieldset>
      <fieldset>
        <legend>Accent color</legend>
        <div class="accent-options">${Object.entries(accentOptions).map(([value, label]) => `
          <label class="appearance-choice" title="${label}"><input class="visually-hidden" type="radio" name="accent" value="${value}" aria-label="${label}" ${accent === value ? 'checked' : ''}><span><i class="accent-swatch" data-swatch="${value}" aria-hidden="true"></i></span></label>`).join('')}
        </div>
      </fieldset>
    </div>
  </section>`;
}

function initializeAppearance() {
  if (windowsChrome) {
    document.documentElement.dataset.window = 'windows';
    const controls = $('#window-controls');
    controls.hidden = false;
    controls.addEventListener('click', event => {
      const button = event.target.closest('button[data-window-command]');
      if (button) window.ipc.postMessage(button.dataset.windowCommand);
    });
    window.addEventListener('articupath-window-state', event => {
      const maximized = event.detail === true;
      const button = controls.querySelector('[data-window-command="window-toggle-maximize"]');
      document.documentElement.toggleAttribute('data-maximized', maximized);
      button.title = maximized ? 'Restore' : 'Maximize';
      button.setAttribute('aria-label', button.title);
    });
    // On runtimes without native drag regions, the blank header still moves the window.
    $('.header-inner').addEventListener('mousedown', event => {
      if (event.button === 0 && !event.target.closest('.brand, .window-controls')) {
        if (event.detail === 2) window.ipc.postMessage('window-toggle-maximize');
        else window.ipc.postMessage('window-drag');
      }
    });
    window.ipc.postMessage('window-state');
  }
  applyAppearance();
  systemTheme.addEventListener('change', () => {
    applyAppearance();
    if (state.view === 'studio' && state.phase !== 'recording') drawMeter($('#wave'), meterStyle());
  });
}

export { accentOptions, accentPreference, appearanceHTML, applyAppearance, initializeAppearance, themeOptions };
