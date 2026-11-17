const digits = [
  ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '10000', '11110', '00001', '00001', '11110'],
  ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
];
const colon = ['0', '0', '1', '0', '1', '0', '0'];

function addDot(context, x, y, radius) {
  context.moveTo(x + radius, y);
  context.arc(x, y, radius, 0, Math.PI * 2);
}

export function drawClock(canvas, value) {
  const context = canvas.getContext('2d');
  if (!context) return false;
  const glyphs = [...value].map(character => character === ':' ? colon : digits[Number(character)]);
  const pitch = 12;
  const gap = 2;
  const columns = glyphs.reduce((sum, glyph) => sum + glyph[0].length, 0) + gap * (glyphs.length - 1);
  const startX = (canvas.width - (columns - 1) * pitch) / 2;
  const startY = (canvas.height - 6 * pitch) / 2;
  const lit = new Path2D();
  const unlit = new Path2D();
  let offset = 0;
  for (const glyph of glyphs) {
    glyph.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const path = row[x] === '1' ? lit : unlit;
        addDot(path, startX + (offset + x) * pitch, startY + y * pitch, 3.8);
      }
    });
    offset += glyph[0].length + gap;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#383838';
  context.fill(unlit);
  context.fillStyle = '#f4f4f4';
  context.fill(lit);
  return true;
}

export const meterColumns = 35;

export function drawMeter(canvas, { levels, signal, baseline, pixel } = {}) {
  const context = canvas.getContext('2d');
  if (!context) return;
  const middle = canvas.height / 2;
  const pitchX = canvas.width / meterColumns;
  context.clearRect(0, 0, canvas.width, canvas.height);
  if (!pixel) {
    const width = pitchX * .46;
    for (let col = 0; col < meterColumns; col++) {
      const height = 3 + (levels?.[col] || 0) * 11;
      context.fillStyle = height > 3 ? signal : baseline;
      context.fillRect((col + .5) * pitchX - width / 2, middle - height / 2, width, height);
    }
    return;
  }
  context.beginPath();
  for (let col = 0; col < meterColumns; col++) addDot(context, (col + .5) * pitchX, middle, 2.1);
  context.fillStyle = baseline;
  context.fill();
  if (!levels) return;

  context.beginPath();
  levels.forEach((level, col) => {
    if (!level) return;
    const x = (col + .5) * pitchX;
    for (let row = -level; row <= level; row++) addDot(context, x, middle + row * 6, 2.1);
  });
  context.fillStyle = signal;
  context.fill();
}
