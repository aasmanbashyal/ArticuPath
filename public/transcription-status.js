const pause = delay => new Promise(resolve => setTimeout(resolve, delay));

export async function watchTranscription(running, readStatus, refreshLibrary, wait = pause) {
  let delay = 2000;
  while (running) {
    await wait(delay);
    try {
      const status = await readStatus();
      if (status.running !== running) running = await refreshLibrary();
      delay = 2000;
    } catch {
      delay = 5000;
    }
  }
}
