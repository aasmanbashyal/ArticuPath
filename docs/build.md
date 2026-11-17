# Build from source

[Back to ArticuPath](../README.md)

## Browser mode

Install Bun, Rust, FFmpeg, and ffprobe, then run:

```sh
bun start
```

Open [127.0.0.1:4317](http://127.0.0.1:4317/) in a recent browser. The launcher builds the Rust backend with full media support. The first build takes longer; Cargo reuses compiled dependencies on later starts. Browser and desktop mode now use the same backend.

On Windows, install the MSVC build prerequisites listed below. On Ubuntu, install `build-essential`, `pkg-config`, `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, and `libssl-dev`. On macOS, install the Xcode command line tools. Browser mode supports macOS; the desktop window supports Windows and Linux.

Run `bun run dev` to rebuild and restart after frontend or Rust changes. This uses a debug build and does not reload browser tabs automatically. Finish a take before editing code; interrupted takes appear in the recovery list after a restart.

Optional environment overrides:

| Variable | Purpose |
| --- | --- |
| `CADENCE_PORT` | Loopback port. Defaults to 4317 through `bun start` and 4318 when running the executable directly. |
| `CADENCE_HOME` | Folder for models and settings. |
| `CADENCE_DATA` | Folder for takes. |
| `FFMPEG_BIN`, `FFPROBE_BIN` | Paths to the media tools, when the build uses them. |
| `TRANSCRIBE_LIB` | Path to a matching 64-bit transcribe.cpp 0.4 library. Keep its native dependencies beside it. |
| `OPENAI_API_KEY` | Optional key for feedback. Transcription does not use it. |

Bun can read these settings from a local `.env` file. Keep any keys out of version control.

## Windows 11 x64

Use Rust's Windows x64 MSVC toolchain and Visual Studio Build Tools with the Windows SDK and x64 C++ redistributable files:

```powershell
./scripts/build-desktop.ps1
```

The script writes the standalone ZIP to `dist`. The compact build uses Windows media APIs and the WebView2 runtime included with Windows 11. To include FFmpeg for background replacement, broader import codec support, and import recompression, add `-FullMedia`.

To package the standalone ZIP as one installer, install [Inno Setup 6](https://jrsoftware.org/inno-setup/downloads) and run:

```powershell
./scripts/build-windows-installer.ps1 -CompilerPath 'C:\Program Files (x86)\Inno Setup 6\ISCC.exe'
```

The script writes `ArticuPath-Setup-windows-x64.exe` to `dist`. The installer adds ArticuPath to the current user's Start menu.

The Windows desktop window serves its UI directly through WebView2. Browser mode, Linux desktop, and the Rust `--serve` mode use loopback.

## Ubuntu 24.04 x64

Docker builds the package into `dist`. It uses WebKitGTK and GStreamer on the target system:

```sh
docker build --platform linux/amd64 -f scripts/linux.Dockerfile --target package --output type=local,dest=dist .
```

## Verification

```sh
bun test
docker build --platform linux/amd64 -f scripts/linux.Dockerfile --target test -t articupath-linux-test .
docker run --rm articupath-linux-test
```

`bun test` builds the Rust browser backend before the API tests. Set `REHEARSE_NATIVE_EXE` to a freshly built executable to test a compact desktop build instead. The suite checks local request guards, media playback and import, session persistence, durable capture and recovery, and transcription when models are installed. See [frontend verification](frontend.md) for browser and Windows WebView2 checks.
