import json
import os
import subprocess
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import Request, urlopen

import pyatspi


ADDRESS = "http://127.0.0.1:4318"


def state():
    with urlopen(ADDRESS + "/api/state", timeout=2) as response:
        return json.load(response)


def wait_for(probe, description, timeout=25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            result = probe()
            if result:
                return result
        except (RuntimeError, URLError):
            pass
        time.sleep(0.15)
    raise AssertionError(f"Timed out waiting for {description}")


def widget(role, name):
    desktop = pyatspi.Registry.getDesktop(0)
    pending = [desktop]
    while pending:
        item = pending.pop()
        if item is None:
            continue
        if (
            item.getRole() == role
            and item.name == name
            and item.getState().contains(pyatspi.STATE_SHOWING)
        ):
            return item
        pending.extend(item.getChildAtIndex(i) for i in range(item.childCount))
    return None


def click(name):
    assert wait_for(lambda: widget(pyatspi.ROLE_PUSH_BUTTON, name), name).queryAction().doAction(0)


def post(path, payload, content_type):
    request = Request(
        ADDRESS + path, data=payload, headers={"Origin": ADDRESS, "Content-Type": content_type}
    )
    with urlopen(request, timeout=60) as response:
        return json.load(response)


initial = wait_for(state, "the desktop app")
assert initial["desktop"] and initial["mediaReady"] and initial["canInstall"], initial
assert not initial["ffmpegReady"] and not initial["engineReady"], initial
click("Skip for now")
microphone = subprocess.Popen(
    ["/opt/ffmpeg", "-v", "error", "-re", "-i", "public/assets/example.mp3",
     "-f", "pulse", "rehearse"]
)
try:
    click("Start recording")
    wait_for(lambda: widget(pyatspi.ROLE_PUSH_BUTTON, "Stop and save"), "the recorder to start")
    # The encoder can take time to start under a loaded virtual display.
    # Wait for actual media on disk before measuring the recording interval.
    wait_for(lambda: any(take["bytes"] > 4096 for take in state()["recordings"]), "audio chunks on disk")
    time.sleep(2)
    click("Stop and save")
    time.sleep(1)
finally:
    microphone.terminate()
    microphone.wait(timeout=5)
take = wait_for(lambda: (state()["sessions"] or [None])[0], "the saved voice take")
assert take["kind"] == "audio" and 1.5 <= take["duration"] < 10, take
with urlopen(Request(ADDRESS + take["media"], headers={"Range": "bytes=0-7"})) as media:
    assert media.status == 206 and len(media.read()) == 8, take
print(f'WebKitGTK saved a {take["duration"]:.2f}s {take["mime"]} voice recording.', flush=True)
click("Play recording")
wait_for(lambda: widget(pyatspi.ROLE_PUSH_BUTTON, "Pause recording"), "playback to start")
timeline = wait_for(lambda: widget(pyatspi.ROLE_SLIDER, "Playback timeline"), "the timeline")
assert timeline.queryValue().maximumValue >= take["duration"] - 0.05, take

fixture = Path("/fixtures/parakeet-tdt_ctc-110m-Q8_0.gguf")
if fixture.is_file():
    models = Path(os.environ["CADENCE_HOME"]) / "models"
    models.mkdir(exist_ok=True)
    (models / fixture.name).symlink_to(fixture)
    post("/api/models/parakeet-110m/install", b"", "application/json")

    def engine_ready():
        status = state()
        download = status["download"]
        if download and download["stage"] == "error":
            raise AssertionError(download["message"])
        return status["engineReady"] and download is None

    wait_for(engine_ready, "the verified speech engine download", timeout=300)
    audio = Path("public/assets/example.mp3").read_bytes()
    sample = post("/api/sessions", b'{"filename":"sample.mp3"}\n' + audio, "application/octet-stream")
    transcript = post(
        f'/api/sessions/{sample["id"]}/transcribe',
        b'{"modelId":"parakeet-110m"}',
        "application/json",
    )
    assert transcript["transcriptDone"] and transcript["segments"], transcript
    print("Downloaded the x64 engine and transcribed a voice fixture.", flush=True)

# The window manager centers Rehearse on the fixed Xvfb display used by this test.
subprocess.run(["xdotool", "mousemove", "1190", "67", "click", "1"], check=True, timeout=10)


def app_closed():
    try:
        state()
    except URLError:
        return True
    return False


wait_for(app_closed, "the desktop window and service to close")
