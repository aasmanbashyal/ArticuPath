const backgroundColor = '#28332b';
const maskWidth = 256;
const maskHeight = 144;
const frameRate = 30;

function makeCanvas(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export async function createMaskSegmenter() {
  const { FilesetResolver, ImageSegmenter } = await import('./assets/vision_bundle.mjs');
  if (!(await FilesetResolver.isSimdSupported())) throw new Error('This browser does not support the background model.');
  const files = await FilesetResolver.forVisionTasks('/assets');
  const segmenter = await ImageSegmenter.createFromOptions(files, {
    baseOptions: { modelAssetPath: '/assets/selfie-segmenter.tflite', delegate: 'CPU' },
    runningMode: 'VIDEO',
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
  return {
    segment(frame, now) {
      const pixels = new Uint8ClampedArray(maskWidth * maskHeight * 4);
      segmenter.segmentForVideo(frame, now, result => {
        // Binary variants can return only the foreground probability mask.
        const masks = result.confidenceMasks;
        const person = (masks[1] ?? masks[0]).getAsFloat32Array();
        for (let i = 0; i < person.length; i++) {
          pixels[i * 4 + 3] = Math.min(1, Math.max(0, (person[i] - .24) / .52)) * 255;
        }
      });
      return pixels;
    },
    close: () => segmenter.close(),
  };
}

function segmentInWorker(worker, frame, now) {
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.error) reject(new Error(data.error));
      else resolve(data.pixels);
    };
    worker.onerror = event => {
      event.preventDefault();
      reject(new Error(event.message || 'The background worker stopped.'));
    };
    try { worker.postMessage({ frame, now }, [frame]); }
    catch (error) { frame.close(); reject(error); }
  });
}

export async function replaceBackground(source, onError) {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = source;
  let worker, segmenter, interval, outputTrack;
  let closed = false;

  const close = () => {
    closed = true;
    clearInterval(interval);
    outputTrack?.stop();
    worker?.terminate();
    segmenter?.close();
    video.pause();
    video.srcObject = null;
  };

  try {
    if (!HTMLCanvasElement.prototype.captureStream) {
      throw new Error('This browser does not support the background model.');
    }
    await video.play();
    const scale = Math.min(1, 1280 / video.videoWidth, 720 / video.videoHeight);
    const width = Math.max(2, Math.floor(video.videoWidth * scale / 2) * 2);
    const height = Math.max(2, Math.floor(video.videoHeight * scale / 2) * 2);
    const output = makeCanvas(width, height), outputContext = output.getContext('2d');
    const offscreen = typeof Worker === 'function' && typeof OffscreenCanvas !== 'undefined';
    const input = offscreen ? new OffscreenCanvas(maskWidth, maskHeight) : makeCanvas(maskWidth, maskHeight);
    const inputContext = input.getContext('2d');
    const mask = makeCanvas(maskWidth, maskHeight), maskContext = mask.getContext('2d');

    async function updateMask(now) {
      inputContext.drawImage(video, 0, 0, maskWidth, maskHeight);
      const pixels = worker ? await segmentInWorker(worker, input.transferToImageBitmap(), now) : segmenter.segment(input, now);
      if (!closed) maskContext.putImageData(new ImageData(pixels, maskWidth, maskHeight), 0, 0);
    }

    if (offscreen) {
      try {
        worker = new Worker(new URL('./background-worker.js', import.meta.url));
        await updateMask(performance.now());
      } catch {
        worker?.terminate();
        worker = null;
      }
    }
    if (!worker) {
      segmenter = await createMaskSegmenter();
      await updateMask(performance.now());
    }

    let lastFrame = -1, lastMask = performance.now();
    let updatingMask = false;
    const maskInterval = worker ? 60 : 85;
    const fail = error => {
      if (closed) return;
      clearInterval(interval);
      onError?.(error);
    };

    function draw(now) {
      if (video.currentTime === lastFrame) return;
      lastFrame = video.currentTime;
      if (!updatingMask && now - lastMask >= maskInterval) {
        lastMask = now;
        updatingMask = true;
        void updateMask(now).catch(fail).finally(() => {
          updatingMask = false;
        });
      }
      outputContext.drawImage(video, 0, 0, width, height);
      outputContext.globalCompositeOperation = 'destination-in';
      outputContext.drawImage(mask, 0, 0, width, height);
      outputContext.globalCompositeOperation = 'destination-over';
      outputContext.fillStyle = backgroundColor;
      outputContext.fillRect(0, 0, width, height);
      outputContext.globalCompositeOperation = 'source-over';
    }

    [outputTrack] = output.captureStream().getVideoTracks();
    draw(performance.now());
    interval = setInterval(() => {
      try { draw(performance.now()); }
      catch (error) { fail(error); }
    }, 1000 / frameRate);
    return { stream: new MediaStream([outputTrack, ...source.getAudioTracks()]), close };
  } catch (err) {
    close();
    throw err;
  }
}
