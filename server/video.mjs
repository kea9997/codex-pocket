import { pipeline } from 'node:stream';
import { BridgeError } from './rpc.mjs';

export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
const invalid = () => { throw new BridgeError('MEDIA_SIGNATURE_INVALID', 415); };

// Walk bounded box headers, skipping payloads (including mdat). Never buffer a movie.
export function validateMp4(io, fd, size) {
  let budget = 2048;
  const read = (length, offset) => {
    const data = Buffer.alloc(length); let used = 0;
    while (used < length) { const n = io.readSync(fd, data, used, length - used, offset + used); if (!n) invalid(); used += n; }
    return data;
  };
  const box = (offset, end) => {
    if (--budget < 0 || end - offset < 8) invalid();
    const header = read(8, offset), type = header.toString('ascii', 4, 8); let length = header.readUInt32BE(), bytes = 8;
    if (length === 1) { if (end - offset < 16) invalid(); const n = read(8, offset + 8).readBigUInt64BE(); if (n > BigInt(MAX_VIDEO_BYTES)) invalid(); length = Number(n); bytes = 16; }
    else if (length === 0) length = end - offset;
    if (length < bytes || offset + length > end) invalid();
    return { type, length, bytes };
  };
  let offset = 0, ftyp = false, moov = false, mdat = false;
  while (offset < size) {
    const b = box(offset, size);
    if (offset === 0 && b.type !== 'ftyp') invalid();
    if (b.type === 'ftyp') {
      if (ftyp || b.length < b.bytes + 8 || b.length > 4096 || (b.length - b.bytes) % 4) invalid();
      const brands = read(b.length - b.bytes, offset + b.bytes), allowed = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ']);
      ftyp = allowed.has(brands.toString('ascii', 0, 4));
      for (let p = 8; p < brands.length; p += 4) ftyp ||= allowed.has(brands.toString('ascii', p, p + 4));
      if (!ftyp) invalid();
    } else if (b.type === 'moov') {
      if (moov) invalid(); let child = offset + b.bytes, track = false, header = false;
      while (child < offset + b.length) { const c = box(child, offset + b.length); if (c.type === 'trak' && c.length > c.bytes) track = true; if (c.type === 'mvhd' && c.length > c.bytes) header = true; child += c.length; }
      if (!track || !header) invalid(); moov = true;
    } else if (b.type === 'mdat' && b.length > b.bytes) mdat = true;
    offset += b.length;
  }
  if (!ftyp || !moov || !mdat) invalid();
}

export function videoRange(value, size) {
  if (value === undefined) return { status: 200, start: 0, end: size - 1 };
  const match = typeof value === 'string' && value.length <= 128 && /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  const fail = () => { throw new BridgeError('MEDIA_RANGE_INVALID', 416); };
  if (!match || (!match[1] && !match[2])) fail();
  const number = s => { const n = Number(s); if (!Number.isSafeInteger(n) || n < 0) fail(); return n; };
  let start, end;
  if (!match[1]) { const count = number(match[2]); if (!count) fail(); start = Math.max(0, size - count); end = size - 1; }
  else { start = number(match[1]); end = match[2] ? number(match[2]) : size - 1; if (start >= size || end < start) fail(); end = Math.min(end, size - 1); }
  return { status: 206, start, end };
}

export function serveVideo(media, session, token, req, res) {
  const video = media.openVideo(session, token); let stream;
  try {
    let range;
    try { range = videoRange(req.headers.range, video.size); }
    catch (e) {
      if (e.code !== 'MEDIA_RANGE_INVALID') throw e;
      res.writeHead(416, { 'Content-Range': `bytes */${video.size}`, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: e.code }));
    }
    if (req.aborted || res.destroyed) return;
    stream = video.stream(range.start, range.end);
    const abort = () => stream.destroy();
    req.once('aborted', abort); res.once('close', abort);
    res.writeHead(range.status, { 'Content-Type': 'video/mp4', 'Content-Length': range.end - range.start + 1,
      'Accept-Ranges': 'bytes', 'Content-Disposition': 'inline', ...(range.status === 206 ? { 'Content-Range': `bytes ${range.start}-${range.end}/${video.size}` } : {}) });
    pipeline(stream, res, () => { req.off('aborted', abort); res.off('close', abort); });
  } catch (e) { stream?.destroy(); throw e; }
  finally { if (!stream) video.close(); }
}
