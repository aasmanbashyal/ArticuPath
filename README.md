<p align="center">
  <img src="public/assets/mark.svg" width="64" height="64" alt="">
</p>
<h1 align="center">ArticuPath</h1>
<p align="center">A local studio for practicing spoken English and rehearsing presentations.</p>
<p align="center">
  <a href="https://github.com/aasmanbashyal/ArticuPath/releases/tag/v0.1.0"><strong>Download v0.1.0</strong></a>
  · <a href="#watch-the-demo">Demo</a>
  · <a href="#your-first-take">Your first take</a>
  · <a href="docs/build.md">Build from source</a>
</p>

## Watch the demo

![ArticuPath demo: pick a cue card, record a voice take, and select a transcript line to hear that moment again.](docs/media/articupath-demo.gif)

[Download the 22-second demo with sound (MP4)](https://github.com/aasmanbashyal/ArticuPath/releases/download/v0.1.0/articupath-demo.mp4)

## Get ArticuPath

| Platform | Install |
| --- | --- |
| Windows 11 x64 | [Download the ZIP](https://github.com/aasmanbashyal/ArticuPath/releases/download/v0.1.0/ArticuPath-windows-x64-standalone.zip). Extract it and open `ArticuPath.exe` inside the `ArticuPath` folder. Keep the extracted files together. |
| Ubuntu 24.04 x64 | [Download the DEB](https://github.com/aasmanbashyal/ArticuPath/releases/download/v0.1.0/articupath_0.1.0-1_amd64.deb). Run `sudo apt install ./articupath_0.1.0-1_amd64.deb`, then open **ArticuPath** from the app menu. |
| Browser | With Bun, FFmpeg, and ffprobe installed, run `bun start` from the checkout and open [127.0.0.1:4317](http://127.0.0.1:4317/). |

Recording works without a transcription model. For transcripts, install the suggested Parakeet 110M model from the first-launch prompt or **Settings → Transcription models**. The model takes 129 MiB and runs offline after setup.

## Your first take

1. **Choose what to say.** Draw from 90 prompts in **Cue cards**, or paste a presentation into **Teleprompter** and set the scroll speed.
2. **Record a take.** Choose voice, camera, screen, or screen with a camera inset. You can also import a recording from **Sessions**.
3. **Listen back.** Select a transcript line to jump to that moment. Search for a phrase, export captions, or compare a scripted take with what you planned to say.

Use **Sessions** to tag takes and browse them by date. The [practice guide](docs/practice.md) covers recording limits, script review, and optional feedback.

## Where your data goes

ArticuPath saves recordings and transcripts on your computer and transcribes locally. If you choose OpenAI feedback in **Settings** and request feedback, ArticuPath sends the prompt and transcript text to OpenAI. You can also use local Ollama or copy the prompt to use elsewhere.

See the [practice guide](docs/practice.md#storage-and-backups) for data locations and backup tips.
