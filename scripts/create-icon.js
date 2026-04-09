// Generates icon.png (128x128) using only Node.js built-ins — no npm packages needed.
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

// ── CRC32 ─────────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len  = Buffer.alloc(4);  len.writeUInt32BE(data.length, 0);
  const typ  = Buffer.from(type, 'ascii');
  const crc  = Buffer.alloc(4);  crc.writeUInt32BE(crc32(Buffer.concat([typ, data])), 0);
  return Buffer.concat([len, typ, data, crc]);
}

// ── Draw ──────────────────────────────────────────────────────────────────────
const SIZE = 128;

// pixel(x, y) → [r, g, b]
function pixel(x, y) {
  const cx = SIZE / 2, cy = SIZE / 2;

  // Rounded-rect mask (corner radius 20)
  const rx = 20, ry = 20;
  const inside =
    (x >= rx && x < SIZE - rx) ||
    (y >= ry && y < SIZE - ry) ||
    (Math.hypot(x - rx, y - ry) < rx && x < rx && y < ry) ||
    (Math.hypot(x - (SIZE - rx), y - ry) < rx && x >= SIZE - rx && y < ry) ||
    (Math.hypot(x - rx, y - (SIZE - ry)) < rx && x < rx && y >= SIZE - ry) ||
    (Math.hypot(x - (SIZE - rx), y - (SIZE - ry)) < rx && x >= SIZE - rx && y >= SIZE - ry);

  if (!inside) return [0, 0, 0]; // transparent → black bg outside (ignored with alpha)

  // Background gradient: deep navy → indigo
  const t  = y / SIZE;
  const bg = [
    Math.round(15 + t * 10),
    Math.round(15 + t * 8),
    Math.round(40 + t * 30),
  ];

  // "Q" ring  (Qwen / Queue of models)
  const qx = cx, qy = cy - 6;
  const outer = 36, inner = 22;
  const d = Math.hypot(x - qx, y - qy);

  if (d <= outer && d >= inner) {
    const blend = Math.min(1, (outer - d) * 2, (d - inner) * 2);
    return [
      Math.round(bg[0] + blend * (80 - bg[0])),
      Math.round(bg[1] + blend * (180 - bg[1])),
      Math.round(bg[2] + blend * (255 - bg[2])),
    ];
  }

  // Tail of the Q
  const tailX = cx + 20, tailY = cy + 18;
  if (Math.hypot(x - tailX, y - tailY) < 8) {
    return [80, 180, 255];
  }

  // Dot accent (bottom-right)
  if (Math.hypot(x - (cx + 28), y - (cy + 30)) < 5) {
    return [120, 220, 180];
  }

  return bg;
}

// ── Build raw scanlines ───────────────────────────────────────────────────────
const raw = Buffer.alloc(SIZE * (1 + SIZE * 3));
for (let y = 0; y < SIZE; y++) {
  raw[y * (1 + SIZE * 3)] = 0; // filter: None
  for (let x = 0; x < SIZE; x++) {
    const [r, g, b] = pixel(x, y);
    const off = y * (1 + SIZE * 3) + 1 + x * 3;
    raw[off] = r; raw[off + 1] = g; raw[off + 2] = b;
  }
}

// ── Assemble PNG ──────────────────────────────────────────────────────────────
const sig  = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

const idat = zlib.deflateSync(raw, { level: 9 });
const png  = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);

const out = path.join(__dirname, '..', 'icon.png');
fs.writeFileSync(out, png);
console.log(`✓ icon.png written (${png.length} bytes)`);
