import { expect, test } from 'bun:test';
import { watchTranscription } from '../public/transcription-status.js';

test('resumes an interrupted status check and refreshes the library once the job finishes', async () => {
  const delays = [];
  const refreshes = [];
  let checks = 0;
  const readStatus = async () => {
    checks++;
    if (checks === 1) throw new Error('Temporary connection failure');
    if (checks === 2) return { running: 'take-1' };
    return { running: null };
  };
  const refreshLibrary = async () => {
    refreshes.push(checks);
    return null;
  };
  await watchTranscription('take-1', readStatus, refreshLibrary, async delay => { delays.push(delay); });
  expect(refreshes).toEqual([3]);
  expect(delays).toEqual([2000, 5000, 2000]);
});
