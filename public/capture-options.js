import { state } from './state.js';
import { $ } from './ui.js';
import { prefs } from './preferences.js';

const usesScreen = kind => kind === 'screen' || kind === 'screen-camera';

const usesCamera = kind => kind === 'video' || kind === 'screen-camera';

const captureOpen = () => state.view === 'studio' || (state.view === 'teleprompter' && Boolean(state.activeScript) && $('#script-form')?.hidden);

const captureModes = {
  audio: ['mic', 'Voice', 'Record with your microphone.'],
  video: ['video', 'Camera', 'Record yourself on camera with microphone audio.'],
  screen: ['screen', 'Screen', 'Share a screen or window and narrate with your microphone.'],
  'screen-camera': ['layers', 'Screen + camera', 'Share your screen with your camera in the corner.'],
};

const canShareScreen = () => typeof navigator.mediaDevices?.getDisplayMedia === 'function';

function chooseScreen(mode) {
  const combined = mode === 'screen-camera';
  const options = { video: { frameRate: { ideal: combined ? 30 : 24, max: 30 } }, audio: false };
  if (combined && window.CaptureController?.prototype.setFocusBehavior) {
    options.controller = new CaptureController();
    options.controller.setFocusBehavior('focus-capturing-application');
  }
  return navigator.mediaDevices.getDisplayMedia(options);
}

const prompterMode = () => Object.hasOwn(captureModes, prefs.prompterMode) && (!usesScreen(prefs.prompterMode) || canShareScreen())
  ? prefs.prompterMode : 'audio';

const permissionStatus = mode => state.app.desktop
  ? (usesScreen(mode) ? 'Waiting for screen selection…' : 'Opening recording devices…')
  : 'Waiting for device access…';

export { canShareScreen, captureModes, captureOpen, chooseScreen, permissionStatus, prompterMode, usesCamera, usesScreen };
