// Generates public/icon-192.png and public/icon-512.png with no image dependencies:
// a white "H" on black, written as a minimal PNG (RGBA, one IDAT, zlib from node core).

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "public");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function png(size) {
  const bg = [17, 17, 17, 255];
  const fg = [255, 255, 255, 255];

  // "H" geometry as fractions of the canvas.
  const barW = size * 0.13;
  const left = size * 0.28;
  const right = size * 0.72 - barW;
  const top = size * 0.27;
  const bottom = size * 0.73;
  const crossTop = size * 0.46;
  const crossBottom = size * 0.54;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  let p = 0;
  for (let y = 0; y < size; y++) {
    raw[p++] = 0; // filter type: none
    for (let x = 0; x < size; x++) {
      const inVertical = y >= top && y < bottom && ((x >= left && x < left + barW) || (x >= right && x < right + barW));
      const inCross = x >= left && x < right + barW && y >= crossTop && y < crossBottom;
      const c = inVertical || inCross ? fg : bg;
      raw[p++] = c[0];
      raw[p++] = c[1];
      raw[p++] = c[2];
      raw[p++] = c[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const size of [192, 512]) {
  const file = join(outDir, `icon-${size}.png`);
  writeFileSync(file, png(size));
  console.log(`wrote ${file}`);
}
