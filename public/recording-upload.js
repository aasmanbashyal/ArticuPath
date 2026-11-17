import { api } from './api.js';

// Only unacknowledged chunks stay in memory. Sequence numbers make retries
// safe even when the server saved a chunk but its response was lost.
export async function beginRecording(details, stopOnFailure) {
  const { id } = await api('/recordings', { method:'POST', body:details });
  const queue = [];
  let sequence = 0, uploading, failure, bufferedBytes = 0, acknowledgedBytes = 0;
  const pump = () => {
    if (uploading) return uploading;
    uploading = (async () => {
      while (queue.length && !failure) {
        const chunk = queue[0];
        try {
          await api(`/recordings/${id}/chunks/${sequence}`, {
            method:'PUT', body:chunk, signal:AbortSignal.timeout(15_000),
          });
          queue.shift(); bufferedBytes -= chunk.size; acknowledgedBytes += chunk.size; sequence++;
        } catch (error) {
          failure = error;
          stopOnFailure('Writing the recording stopped. Keep this page open and retry saving.');
        }
      }
    })().finally(() => { uploading = null; });
    return uploading;
  };
  return {
    id, filename:details.filename,
    append(chunk) {
      if (!chunk.size) return;
      queue.push(chunk); bufferedBytes += chunk.size;
      // A blocked disk or connection must not turn a long recording into an
      // unbounded memory buffer. Keep the outstanding data available for Retry.
      if (bufferedBytes > 8 * 1024 * 1024) stopOnFailure('Saving is falling behind. Recording stopped so you can retry saving.');
      void pump();
    },
    async finish(retry = false) {
      if (uploading) await uploading;
      if (retry) failure = null;
      await pump();
      if (failure) throw failure;
      return api(`/recordings/${id}/finish`, { method:'POST' });
    },
    async preview() {
      if (uploading) await uploading;
      const response = await fetch(`/api/recordings/${id}/media`);
      let saved = new Blob();
      if (response.ok) saved = await response.blob();
      else if (response.status !== 400 || acknowledgedBytes) throw new Error('Could not read the saved portion. Reconnect to the app and retry.');
      if (saved.size < acknowledgedBytes) throw new Error('The saved portion is incomplete. Keep this page open and retry saving.');
      // A lost acknowledgment can leave the first queued chunk on disk too.
      // Append only the bytes the backend has not already persisted.
      const waiting = new Blob(queue).slice(saved.size - acknowledgedBytes);
      return new File([saved, waiting], details.filename, { type:details.mime });
    },
  };
}
