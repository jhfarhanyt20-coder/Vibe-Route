// Generates app/icon.png (256x256) without any image dependency.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const S = 256;
const px = Buffer.alloc(S * S * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  const A = a / 255, B = px[i + 3] / 255;
  const out = A + B * (1 - A);
  px[i] = Math.round((r * A + px[i] * B * (1 - A)) / out);
  px[i + 1] = Math.round((g * A + px[i + 1] * B * (1 - A)) / out);
  px[i + 2] = Math.round((b * A + px[i + 2] * B * (1 - A)) / out);
  px[i + 3] = Math.round(out * 255);
}

// background: rounded square
const rad = 56;
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cx = Math.min(Math.max(x, rad), S - 1 - rad);
    const cy = Math.min(Math.max(y, rad), S - 1 - rad);
    const d = Math.hypot(x - cx, y - cy);
    const inside = d <= rad ? 1 : 0;
    if (inside) set(x, y, 13, 17, 23);
  }
}

// three nodes connected by a route line (dark theme accent)
const nodes = [[78, 92], [178, 128], [78, 178]];
const accent = [63, 185, 80];

function line(x0, y0, x1, y1, w, col) {
  const steps = Math.hypot(x1 - x0, y1 - y0) * 2;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    for (let dy = -w; dy <= w; dy++) {
      for (let dx = -w; dx <= w; dx++) {
        const d = Math.hypot(dx, dy);
        if (d <= w) blend(Math.round(x + dx), Math.round(y + dy), col[0], col[1], col[2], Math.round(255 * (1 - d / (w + 1))));
      }
    }
  }
}

line(nodes[0][0], nodes[0][1], nodes[1][0], nodes[1][1], 9, accent);
line(nodes[1][0], nodes[1][1], nodes[2][0], nodes[2][1], 9, accent);

for (const [nx, ny] of nodes) {
  for (let dy = -22; dy <= 22; dy++) {
    for (let dx = -22; dx <= 22; dx++) {
      const d = Math.hypot(dx, dy);
      if (d <= 22) blend(nx + dx, ny + dy, 230, 237, 243, Math.round(255 * Math.min(1, (23 - d) / 2)));
    }
  }
}

// PNG encode
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.join(__dirname, "icon.png");
fs.writeFileSync(out, png);
console.log("wrote " + out + " (" + png.length + " bytes)");
