// Draws the toolbar icons (a check mark on a teal rounded square) as PNG files.
// Run once with `node scripts/icons.mjs`; the output is committed in public/icons/.
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};

function segmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function icon(size) {
  const rows = [];
  const r = size * 0.22;
  const stroke = size * 0.1;
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      const cx = x + 0.5, cy = y + 0.5;
      // Rounded square coverage.
      const qx = Math.max(r - cx, 0, cx - (size - r)), qy = Math.max(r - cy, 0, cy - (size - r));
      const inside = Math.hypot(qx, qy) <= r;
      // Check mark: two strokes.
      const u = cx / size, v = cy / size;
      const d = Math.min(segmentDistance(u, v, 0.26, 0.53, 0.43, 0.7), segmentDistance(u, v, 0.43, 0.7, 0.76, 0.32)) * size;
      if (!inside) row.push(0, 0, 0, 0);
      else if (d <= stroke / 2) row.push(255, 255, 255, 255);
      else row.push(0x0f, 0x76, 0x6e, 255);
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

const dir = new URL("../public/icons/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const s of [16, 32, 48, 128]) writeFileSync(new URL(`icon-${s}.png`, dir), icon(s));
