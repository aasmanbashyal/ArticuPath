# Practice with ArticuPath

[Back to ArticuPath](../README.md)

## Cue cards and the recorder

Filter the 90 cue cards by category or difficulty, or choose **Shuffle**. You can take a minute to prepare and set a speaking target. **Record this topic** keeps the prompt and talking points beside the controls. The target is a guide; recording stops when you choose.

Choose **Voice**, **Camera**, **Screen**, or **Screen + camera**. For screen capture, choose a screen or window from the sharing dialog. **Screen + camera** puts the camera in a lower-right inset. Your camera preview is mirrored; the saved video keeps the original orientation. Press `Alt+R` to start or stop a take while Recorder is open.

Browser mode and the Windows full-media build can replace the camera background with a solid color using the local [MediaPipe Selfie Segmenter](https://developers.google.com/edge/mediapipe/solutions/vision/image_segmenter).

## Teleprompter and script review

Choose **Add script** or **Edit script**, then **Save script**. Adjust the pace and text size, mirror the text, or go full screen. The teleprompter has its own recording mode and starts in Voice mode.

After transcription, open the take and select **Practice this take**. Listen to missing passages, different words, and extra words. Mark each item as practiced or dismiss it. **Show full comparison** puts the differences back in context. Listen to the recording before treating a transcription difference as a speaking mistake.

## Transcription and feedback

The recommended Parakeet 110M model is 129 MiB. **Settings → Transcription models** also lists larger Parakeet and Whisper options. Parakeet can provide word timings for script review; Whisper timestamps each transcript line. To retry with the selected model, open a saved take's action menu and choose **Transcribe again**.

The first model download also installs the [Handy transcribe.cpp](https://github.com/handy-computer/transcribe.cpp) runtime. ArticuPath verifies both downloads against upstream SHA-256 hashes. Desktop setup supports Windows and Linux x64. The Bun backend can also install the runtime on Linux arm64 and macOS x64 or arm64. **Refresh model list** checks the [Handy catalog](https://github.com/cjpais/Handy/blob/main/src-tauri/src/catalog/catalog.json) when the local copy is more than a day old.

Open **Feedback** to see approximate pace and fillers found in the transcript. You can copy a feedback prompt or configure OpenAI or Ollama in **Settings**. If you enter an OpenAI key in the UI, it lasts until the app closes or reloads. Set `OPENAI_API_KEY` in the environment for persistent configuration, or in an ignored `.env` file when starting the Bun backend.

## Storage and backups

| Mode | Default data folder |
| --- | --- |
| Windows | `%LOCALAPPDATA%\Rehearse` |
| Linux | `${XDG_DATA_HOME:-$HOME/.local/share}/rehearse` |
| Browser | `.cadence` in the checkout |

Back up your recording folders to preserve takes, scripts, and feedback. The latest script draft, appearance, and per-take practice marks live in the browser or webview profile.

Each take can be up to 15 minutes and 160 MiB. **Settings → Storage** lets you choose where new takes go, reduce their bitrate, and set a retention limit. Earlier takes stay in their original folders. If you set a limit, saving a new take permanently deletes the oldest takes above that limit. Browser mode and the Windows full-media build can also recompress imports.
