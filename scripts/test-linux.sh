#!/bin/sh
set -eu

if [ "${1:-}" != "--desktop" ]; then
    dbus-run-session -- xvfb-run -a --server-args="-screen 0 1280x960x24" \
        /bin/sh "$0" --desktop
    REHEARSE_NATIVE_EXE=/usr/bin/rehearse bun test
    exit
fi

profile=$(mktemp -d)
export CADENCE_HOME="$profile" CADENCE_PORT=4318
# Docker restricts the namespaces that the WebKit sandbox needs.
export WEBKIT_DISABLE_SANDBOX_THIS_IS_DANGEROUS=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
export GTK_MODULES=atk-bridge
openbox >"$profile/window-manager.log" 2>&1 &
manager=$!
pulseaudio --start --exit-idle-time=-1
pactl load-module module-null-sink sink_name=rehearse >/dev/null
pactl load-module module-remap-source master=rehearse.monitor source_name=rehearse_mic >/dev/null
pactl set-default-source rehearse_mic
rehearse >"$profile/rehearse.log" 2>&1 &
app=$!
trap 'kill "$app" "$manager" 2>/dev/null || true' EXIT
if ! python3 tests/linux-desktop.py; then
    cat "$profile/rehearse.log"
    exit 1
fi
wait "$app"
