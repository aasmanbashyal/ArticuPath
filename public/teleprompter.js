export function bindTeleprompter(panel, wordCount) {
  const viewport = panel.querySelector('.prompter-viewport');
  const toggle = panel.querySelector('[data-action="prompter-toggle"]');
  const speed = panel.querySelector('#prompter-speed');
  const size = panel.querySelector('#prompter-size');
  const sizeLabel = panel.querySelector('#script-size');
  const estimate = panel.querySelector('#script-estimate');
  const mirror = panel.querySelector('#prompter-mirror');
  const progress = panel.querySelector('.prompter-progress');
  let frame = 0, last, offset = 0;
  const wpm = () => Math.max(60, Math.min(250, Number(speed.value) || 130));

  function drawToggle(playing) {
    const label = playing ? 'Pause' : 'Play';
    toggle.querySelector('span').textContent = label;
    toggle.setAttribute('aria-label', `${label} script`);
    toggle.classList.toggle('is-playing', playing);
  }

  function pause() {
    cancelAnimationFrame(frame);
    frame = 0;
    last = undefined;
    drawToggle(false);
  }

  function tick(now) {
    const distance = viewport.scrollHeight - viewport.clientHeight;
    const position = viewport.scrollTop;
    if (position >= distance - 1) {
      pause();
      return;
    }
    // Keep fractional movement so even slow speeds work at high refresh rates.
    const pixelsPerMs = distance * wpm() / (60_000 * wordCount);
    if (last !== undefined) {
      offset = Math.abs(position - Math.round(offset)) > 1 ? position : offset;
      offset = Math.min(distance, offset + pixelsPerMs * Math.min(100, now - last));
      viewport.scrollTop = offset;
    }
    last = now;
    frame = requestAnimationFrame(tick);
  }

  function play() {
    if (frame || !wordCount) return;
    if (viewport.scrollTop >= viewport.scrollHeight - viewport.clientHeight - 1) viewport.scrollTop = 0;
    offset = viewport.scrollTop;
    drawToggle(true);
    frame = requestAnimationFrame(tick);
  }

  function drawEstimate() {
    const seconds = Math.ceil(60 * wordCount / wpm());
    estimate.textContent = `${wordCount} ${wordCount === 1 ? 'word' : 'words'} · ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
  function drawSize() {
    viewport.style.setProperty('--script-size', `${size.value}px`);
    sizeLabel.value = `${size.value} px`;
    drawProgress();
  }
  function drawMirror() {
    viewport.classList.toggle('is-mirrored', mirror.checked);
  }
  function drawProgress() {
    const distance = viewport.scrollHeight - viewport.clientHeight;
    progress.value = distance > 0 ? viewport.scrollTop / distance : 0;
  }
  function restart() {
    pause();
    viewport.scrollTop = 0;
    drawProgress();
  }

  toggle.addEventListener('click', () => frame ? pause() : play());
  panel.querySelector('[data-action="prompter-restart"]').addEventListener('click', restart);
  for (const event of ['input', 'change']) speed.addEventListener(event, drawEstimate);
  size.addEventListener('input', drawSize);
  mirror.addEventListener('change', drawMirror);
  viewport.addEventListener('scroll', drawProgress, { passive: true });
  const resize = new ResizeObserver(drawProgress);
  resize.observe(viewport);
  drawSize();
  drawMirror();
  drawEstimate();
  return {
    play,
    pause,
    updateScript(count) {
      wordCount = count;
      restart();
      drawEstimate();
    },
    dispose() {
      pause();
      resize.disconnect();
    },
  };
}
