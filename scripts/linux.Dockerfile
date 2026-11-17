# syntax=docker/dockerfile:1
ARG RUNTIME_IMAGE=ubuntu:24.04
ARG TEST_RUNTIME=test-runtime
ARG RUNTIME_DEPENDS="libc6 (>= 2.36), libgtk-3-0 | libgtk-3-0t64, libwebkit2gtk-4.1-0, libssl3 | libssl3t64, ca-certificates, gstreamer1.0-plugins-good, gstreamer1.0-plugins-bad, gstreamer1.0-pulseaudio, gstreamer1.0-libav, libvulkan1, libgomp1"
FROM rust:1.95-bookworm AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev libgtk-3-dev libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY desktop-rust/ desktop-rust/
COPY public/ public/
RUN --mount=type=cache,id=rehearse-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=rehearse-linux-target,target=/src/desktop-rust/target \
    cargo build --locked --release --manifest-path desktop-rust/Cargo.toml \
    && install -Dm755 desktop-rust/target/release/rehearse /pkg/usr/bin/rehearse
RUN install -Dm644 public/assets/mark.svg /pkg/usr/share/icons/hicolor/scalable/apps/rehearse.svg \
    && install -Dm644 /dev/stdin /pkg/usr/share/applications/rehearse.desktop <<'EOF'
[Desktop Entry]
Type=Application
Name=ArticuPath
Comment=Clearer speaking, one take at a time.
Exec=rehearse
Icon=rehearse
Terminal=false
Categories=Education;AudioVideo;
EOF
ARG RUNTIME_DEPENDS
RUN install -Dm644 /dev/stdin /pkg/DEBIAN/control <<EOF
Package: rehearse
Version: 0.2.0-1
Architecture: amd64
Maintainer: ArticuPath
Section: education
Priority: optional
Depends: $RUNTIME_DEPENDS
Recommends: xdg-desktop-portal
Description: ArticuPath speaking practice studio
 Record voice or video, review takes, and optionally transcribe offline.
EOF
RUN install -Dm644 /dev/stdin /pkg/usr/share/doc/rehearse/copyright <<'EOF'
ArticuPath includes the following media libraries:
Symphonia (MPL-2.0), https://github.com/pdeljanov/Symphonia
Symphonia Opus (MPL-2.0), https://crates.io/crates/symphonia-opus
Rubato (MIT), https://github.com/HEnquist/rubato
EOF
RUN mkdir /out && dpkg-deb --root-owner-group --build -Zxz /pkg /out/articupath_0.2.0-1_amd64.deb

FROM scratch AS package
COPY --from=build /out/ /

FROM oven/bun:1.3.10-debian AS bun
FROM ${RUNTIME_IMAGE} AS test-runtime
ARG RUNTIME_DEPENDS
RUN apt-get update && apt-get satisfy -y --no-install-recommends "$RUNTIME_DEPENDS" \
    && ! command -v ffmpeg \
    && apt-get install -y --no-install-recommends \
        at-spi2-core dbus-x11 ffmpeg openbox pulseaudio python3-pyatspi xauth xdotool xvfb \
    && mv /usr/bin/ffmpeg /usr/bin/ffprobe /opt/ \
    && rm -rf /var/lib/apt/lists/*

FROM ${TEST_RUNTIME} AS test
COPY --from=package /articupath_0.2.0-1_amd64.deb /tmp/articupath.deb
RUN dpkg -i /tmp/articupath.deb
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN useradd --create-home tester && mkdir -p /test/.cadence && chown tester /test/.cadence
WORKDIR /test
COPY package.json ./
COPY public/ public/
COPY tests/ tests/
COPY scripts/backend.js scripts/backend.js
COPY scripts/test-linux.sh /test/test-linux.sh
USER tester
ENV FFMPEG_BIN=/opt/ffmpeg FFPROBE_BIN=/opt/ffprobe
ENTRYPOINT ["/bin/sh", "/test/test-linux.sh"]
