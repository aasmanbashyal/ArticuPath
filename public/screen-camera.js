function videoFor(track) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = new MediaStream([track]);
  return video;
}

export async function composeScreenCamera(screenTrack, cameraTrack, compact) {
  const canvas = document.createElement('canvas');
  if (!canvas.captureStream) throw new Error('Combined recording is unavailable in this browser.');
  const screen = videoFor(screenTrack);
  const camera = videoFor(cameraTrack);
  const context = canvas.getContext('2d', { alpha: false });
  const frameRate = 30;
  let outputTrack, interval;

  function close() {
    clearInterval(interval);
    outputTrack?.stop();
    for (const video of [screen, camera]) {
      video.pause();
      video.srcObject = null;
    }
  }

  try {
    await Promise.all([screen.play(), camera.play()]);
    const scale = Math.min(1, (compact ? 1280 : 1920) / screen.videoWidth, (compact ? 720 : 1080) / screen.videoHeight);
    const width = Math.max(2, Math.floor(screen.videoWidth * scale / 2) * 2);
    const height = Math.max(2, Math.floor(screen.videoHeight * scale / 2) * 2);
    canvas.width = width;
    canvas.height = height;

    const insetRatio = 16 / 9;
    const insetWidth = Math.min(width * .27, height * .3 * insetRatio);
    const insetHeight = insetWidth / insetRatio;
    const margin = Math.min(width, height) * .035;
    const insetX = width - insetWidth - margin;
    const insetY = height - insetHeight - margin;

    const draw = () => {
      if (screen.readyState < 2 || camera.readyState < 2) return;
      context.drawImage(screen, 0, 0, width, height);
      const cropWidth = Math.min(camera.videoWidth, camera.videoHeight * insetRatio);
      const cropHeight = Math.min(camera.videoHeight, camera.videoWidth / insetRatio);
      const cropX = (camera.videoWidth - cropWidth) / 2;
      const cropY = (camera.videoHeight - cropHeight) / 2;
      context.fillStyle = '#202620';
      context.fillRect(insetX - 2, insetY - 2, insetWidth + 4, insetHeight + 4);
      context.drawImage(camera, cropX, cropY, cropWidth, cropHeight, insetX, insetY, insetWidth, insetHeight);
    };
    [outputTrack] = canvas.captureStream().getVideoTracks();
    draw();
    interval = setInterval(draw, 1000 / frameRate);
    return { track: outputTrack, close };
  } catch (error) {
    close();
    throw error;
  }
}
