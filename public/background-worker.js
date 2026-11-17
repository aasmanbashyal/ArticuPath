let segmenter;

self.onmessage = async ({ data: { frame, now } }) => {
  try {
    if (!segmenter) {
      // The MediaPipe WASM loader uses importScripts inside a classic worker.
      const { createMaskSegmenter } = await import('./background.js');
      segmenter = await createMaskSegmenter();
    }
    const pixels = segmenter.segment(frame, now);
    self.postMessage({ pixels }, [pixels.buffer]);
  } catch (error) {
    self.postMessage({ error: error.message || String(error) });
  } finally {
    frame.close();
  }
};
