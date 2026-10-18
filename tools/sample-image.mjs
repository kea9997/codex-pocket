// Generated raster for isolated UI/tests only. No local files or external fetches.
import { deflateSync } from 'node:zlib';

export function sampleImage() {
  const chunk = (name, data) => {
    const type = Buffer.from(name), payload = Buffer.concat([type, data]); let crc = 0xffffffff;
    for (const byte of payload) { crc ^= byte; for (let n = 0; n < 8; n++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
    const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); payload.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result;
  };
  const width = 320, height = 180, header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const on = y > 45 && y < 135 && x > 40 && x < 280 && (x < 70 || x > 250 || y < 65 || y > 115);
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    pixels.set(on ? [121, 187, 145] : [41, 41, 41], offset);
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
