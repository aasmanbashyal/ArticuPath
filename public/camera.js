import { prefs } from './preferences.js';
import { state } from './state.js';

// The preview owns the camera until recording takes over the same tracks.
export function createCamera(onInterrupted) {
  let current;

  function release(request) {
    request.effect?.close();
    request.effect = null;
    request.source?.getTracks().forEach(track => track.stop());
    request.source = null;
  }

  function close() {
    if (current) release(current);
    current = null;
  }

  function open(mode, replace, retry = false) {
    const width = mode === 'screen-camera' ? 640 : prefs.compactRecordings ? 960 : 1280;
    const background = !state.app.lightMedia && Boolean(replace);
    if (current?.width === width && current.background === background && !(retry && current.failed)) return current.ready;
    close();
    const request = { width, background };
    current = request;
    function interrupted(error) {
      if (current !== request || request.failed) return;
      request.failed = true;
      release(request);
      onInterrupted(error);
    }
    request.ready = (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access is unavailable in this browser.');
        request.source = await navigator.mediaDevices.getUserMedia({ audio:false, video:{
          facingMode:{ ideal:'user' }, width:{ ideal:width }, height:{ ideal:width * 9 / 16 }, frameRate:{ ideal:30, max:30 },
        } });
        if (current !== request) throw new Error('Camera preview closed.');
        const raw = request.source.getVideoTracks()[0];
        if (raw?.readyState !== 'live') throw new Error('No camera track is available.');
        raw.addEventListener('ended', () => interrupted(new Error('The camera disconnected.')), { once:true });
        if (background) {
          const { replaceBackground } = await import('./background.js');
          if (current !== request) throw new Error('Camera preview closed.');
          try {
            request.effect = await replaceBackground(request.source, () => interrupted(new Error('Background replacement stopped.')));
          } catch {
            throw new Error('Could not load background replacement. Turn it off or try again.');
          }
        }
        if (current !== request || request.failed) throw new Error('Camera preview closed.');
        return (request.effect?.stream || request.source).getVideoTracks()[0];
      } catch (error) {
        request.failed = true;
        release(request);
        throw error;
      }
    })();
    return request.ready;
  }

  return { open, close };
}
