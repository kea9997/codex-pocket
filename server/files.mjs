import path from 'node:path';
import { pipeline } from 'node:stream';
import { Media, imagePath, imageMime, MAX_IMAGE_BYTES } from './media.mjs';
import { MAX_VIDEO_BYTES, validateMp4, videoRange } from './video.mjs';
import { hash } from './security.mjs';
import { BridgeError } from './rpc.mjs';

const types = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.mp4', 'video/mp4'], ['.pdf', 'application/pdf'], ['.zip', 'application/zip'], ['.apk', 'application/vnd.android.package-archive']]);
export const FILE_LIMITS = { image: MAX_IMAGE_BYTES, video: MAX_VIDEO_BYTES, pdf: 128 * 1024 * 1024, archive: 512 * 1024 * 1024 };
const fail = () => { throw new BridgeError('FILE_SIGNATURE_INVALID', 415); };
function read(io, fd, position, length) {
  const data = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const n = io.readSync(fd, data, offset, length - offset, position + offset); if (!n) fail(); offset += n; }
  return data;
}
// No decompression or APK execution. ZIP64/multidisk/encrypted archives are deliberately unsupported.
export function validateZip(io, fd, size, apk = false) {
  const length = Math.min(size, 65557), tail = read(io, fd, size - length, length); let at = -1;
  for (let n = length - 22; n >= 0; n--) if (tail.readUInt32LE(n) === 0x06054b50 && n + 22 + tail.readUInt16LE(n + 20) === length) { at = n; break; }
  if (at < 0 || tail.readUInt16LE(at + 4) || tail.readUInt16LE(at + 6)) fail();
  const count = tail.readUInt16LE(at + 10), bytes = tail.readUInt32LE(at + 12), start = tail.readUInt32LE(at + 16);
  if (!count || count === 65535 || count > 8192 || tail.readUInt16LE(at + 8) !== count || bytes > 4 * 1024 * 1024 || start + bytes !== size - length + at) fail();
  const directory = read(io, fd, start, bytes); let offset = 0, manifest = false, dex = false;
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes || directory.readUInt32LE(offset) !== 0x02014b50) fail();
    const flags = directory.readUInt16LE(offset + 8), method = directory.readUInt16LE(offset + 10), compressed = directory.readUInt32LE(offset + 20);
    const nameLength = directory.readUInt16LE(offset + 28), extra = directory.readUInt16LE(offset + 30), comment = directory.readUInt16LE(offset + 32), local = directory.readUInt32LE(offset + 42);
    const next = offset + 46 + nameLength + extra + comment;
    if (!nameLength || nameLength > 4096 || next > bytes || flags & 1 || ![0, 8].includes(method) || directory.readUInt16LE(offset + 34) || local + 30 > start) fail();
    const nameBytes = directory.subarray(offset + 46, offset + 46 + nameLength), name = nameBytes.toString('utf8');
    if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.split('/').includes('..')) fail();
    const header = read(io, fd, local, 30);
    if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== flags || header.readUInt16LE(8) !== method || header.readUInt16LE(26) !== nameLength || local + 30 + nameLength + header.readUInt16LE(28) + compressed > start) fail();
    if (!read(io, fd, local + 30, nameLength).equals(nameBytes)) fail();
    manifest ||= name === 'AndroidManifest.xml'; dex ||= /^classes(?:[2-9]\d*)?\.dex$/.test(name);
    offset = next;
  }
  if (offset !== bytes || apk && (!manifest || !dex)) fail();
}
export function validateFile(io, fd, size, file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.mp4') return validateMp4(io, fd, size);
  if (ext === '.zip' || ext === '.apk') return validateZip(io, fd, size, ext === '.apk');
  if (ext === '.pdf') {
    const head = read(io, fd, 0, Math.min(16, size)), tail = read(io, fd, Math.max(0, size - 1024), Math.min(size, 1024));
    if (!/^%PDF-1\.[0-9]|^%PDF-2\.0/.test(head.toString('ascii')) || !/%%EOF\s*$/.test(tail.toString('ascii'))) fail();
    return;
  }
  // Images alone have a small bounded allocation, matching the existing preview validator.
  imageMime(read(io, fd, 0, size), ext);
}
export class Files extends Media {
  pathFor(raw) { return imagePath(raw, types); }
  kindFor() { return 'file'; }
  route(token) { return `/api/files/${token}`; }
  fileLimit(file) {
    const ext = path.extname(file).toLowerCase();
    return ext === '.mp4' ? FILE_LIMITS.video : ext === '.pdf' ? FILE_LIMITS.pdf : ['.zip', '.apk'].includes(ext) ? FILE_LIMITS.archive : FILE_LIMITS.image;
  }
  register(session, threadId, raw, alt) {
    const value = super.register(session, threadId, raw, alt);
    if (value.state !== 'ready') return value;
    const entry = this.entry(session, value.url.split('/').at(-1));
    return { ...value, name: path.basename(entry.file), mime: types.get(path.extname(entry.file).toLowerCase()) };
  }
  open(session, token) { return this.openStream(session, token, validateFile); }
  info(session, token) {
    const source = this.open(session, token);
    try {
      const entry = this.entry(session, token);
      return { name: path.basename(entry.file), mime: types.get(path.extname(entry.file).toLowerCase()), size: source.size,
        revision: hash(entry.snapshot), threadId: entry.threadId };
    } finally { source.close(); }
  }
}
export function attachmentName(name) {
  const safe = name.replace(/[\x00-\x1f\x7f‪-‮⁦-⁩]/g, '').slice(0, 200) || 'result';
  return `attachment; filename="${safe.replace(/[^A-Za-z0-9._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(safe).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}
export function serveFile(files, session, token, req, res) {
  const info = files.info(session, token), etag = `"${info.revision}"`;
  if (req.headers['if-match'] && req.headers['if-match'] !== etag) throw new BridgeError('FILE_CHANGED', 412);
  const source = files.open(session, token); let stream;
  try {
    let range;
    try { range = videoRange(req.headers.range, source.size); }
    catch (e) { if (e.status !== 416) throw e; res.writeHead(416, { 'Content-Range': `bytes */${source.size}` }); res.end(); return; }
    const { start, end } = range, partial = range.status === 206;
    if (req.aborted || res.destroyed) return;
    stream = source.stream(start, end);
    const abort = () => stream.destroy(); req.once('aborted', abort); res.once('close', abort);
    res.writeHead(partial ? 206 : 200, { 'Content-Type': info.mime, 'Content-Length': end - start + 1,
      'Content-Disposition': attachmentName(info.name), 'Accept-Ranges': 'bytes', ETag: etag,
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${source.size}` } : {}) });
    pipeline(stream, res, () => { req.off('aborted', abort); res.off('close', abort); });
  } catch (e) { stream?.destroy(); throw e; }
  finally { if (!stream) source.close(); }
}
