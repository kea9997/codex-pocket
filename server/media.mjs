import * as fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { Transform, pipeline } from 'node:stream';
import { MAX_VIDEO_BYTES, validateMp4 } from './video.mjs';
import { BridgeError } from './rpc.mjs';

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const extensions = new Map([['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.mp4', 'video/mp4']]);
const deny = /^(?:\..*|appdata|codexphonedata|config|credentials?|secrets?|tokens?|passwords?|sessions?|pairing|android-signing)(?:\..*)?$/i;
const fail = (code, status = 404) => { throw new BridgeError(code, status); };
export const mediaPlaceholder = (code = 'MEDIA_SOURCE_UNSUPPORTED', alt = '대화 이미지') => ({ state: 'unavailable', error: code, alt: String(alt).slice(0, 200) });

// The same offsets are used by the browser; fenced/inline code is never registered as a file reference.
export function markdownImages(value, files = false) {
  const ranges = []; let fence = null, start = 0, offset = 0;
  for (const line of value.split(/(?<=\n)/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) { fence = marker[1]; start = offset; }
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !line.slice(marker[0].length).trim()) { ranges.push([start, offset + line.length]); fence = null; }
    }
    offset += line.length;
  }
  if (fence) ranges.push([start, value.length]);
  for (const match of value.matchAll(/(`+)[\s\S]*?\1/g)) ranges.push([match.index, match.index + match[0].length]);
  const images = [];
  const pattern = /(!?)\[([^\]\n]{0,200})\]\(\s*(?:<([^>\n]{1,4096})>|([^\n)]{1,4096}?))\s*\)/g;
  for (const match of value.matchAll(pattern)) {
    if (images.length >= 64) break;
    if (value[match.index - 1] === '\\' || ranges.some(([a, b]) => match.index >= a && match.index < b)) continue;
    const file = match[3] ?? match[4];
    // Download references must also be local. No code, remote URL or tool output becomes a capability.
    const local = /^(?:\/?[A-Za-z]:[\\/]|\/(?!\/))/.test(file) && !/^\/\//.test(file);
    if (files ? !local : !match[1] && (!/\.mp4$/i.test(file) || !local)) continue;
    images.push({ start: match.index, end: match.index + match[0].length, alt: match[2] || '대화 미디어', path: file });
  }
  return images;
}

export function imagePath(raw, allowed = extensions) {
  if (typeof raw !== 'string' || raw.length > 4096 || /[\x00-\x1f%<>"|?*]/.test(raw)) fail('MEDIA_PATH_BLOCKED');
  const windows = process.platform === 'win32';
  // Codex Markdown sometimes prefixes a drive-absolute path with one slash, not a UNC path.
  if (windows && /^\/[A-Za-z]:\//.test(raw)) raw = raw.slice(1);
  if (windows ? !/^[A-Za-z]:[\\/]/.test(raw) : !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) fail('MEDIA_PATH_BLOCKED');
  const parts = raw.slice(windows ? 3 : 1).split(/[\\/]/);
  if (parts.some(p => !p || p === '.' || p === '..' || /[:]|[. ]$/.test(p) || deny.test(p) || /(?:credential|secret|password|token|signing|config|api[._-]?key|private[._-]?key|^keys?(?:[._-]|$)|^id_(?:rsa|ed25519)|cookies?|auth[._-]|session[._-]|pairing[._-])/i.test(p) || /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(p))) fail('MEDIA_PATH_BLOCKED');
  const resolved = path.normalize(raw), ext = path.extname(resolved).toLowerCase();
  if (!allowed.has(ext)) fail('MEDIA_TYPE_UNSUPPORTED', 415);
  return resolved;
}
function identity(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join('/'); }
function samePath(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
export function imageMime(data, ext) {
  let mime;
  if (data.length >= 33 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && data.toString('ascii', 12, 16) === 'IHDR') mime = 'image/png';
  else if (data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255 && data.at(-2) === 255 && data.at(-1) === 217) mime = 'image/jpeg';
  else if (data.length >= 14 && /^GIF8[79]a$/.test(data.toString('ascii', 0, 6))) mime = 'image/gif';
  else if (data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(data.toString('ascii', 12, 16)) && data.readUInt32LE(4) + 8 === data.length) mime = 'image/webp';
  if (!mime || extensions.get(ext) !== mime) fail('MEDIA_SIGNATURE_INVALID', 415);
  return mime;
}

export class Media {
  constructor({ now = Date.now, io = fs, ttl = 30 * 60000, limit = 512, ownedUpload = () => null, privateRoot = null } = {}) {
    this.now = now; this.io = io; this.ttl = ttl; this.limit = limit; this.ownedUpload = ownedUpload; this.entries = new Map(); this.keys = new Map();
    this.privateRoot = privateRoot === null ? null : path.resolve(privateRoot);
  }
  remove(token) {
    const entry = this.entries.get(token); this.entries.delete(token);
    if (entry) { this.keys.delete(entry.key); for (const stream of entry.streams ?? []) stream.destroy(new BridgeError('MEDIA_NOT_FOUND', 404)); }
  }
  entry(session, token) {
    this.prune(); const entry = this.entries.get(token);
    if (!entry || entry.owner !== session?.id) fail('MEDIA_NOT_FOUND');
    return entry;
  }
  kind(session, token) { return this.entry(session, token).kind; }
  prune() { for (const [token, e] of this.entries) if (e.expires <= this.now()) this.remove(token); }
  revoke(session) { for (const [token, e] of this.entries) if (e.owner === session.id) this.remove(token); }
  fileLimit(file) { return path.extname(file).toLowerCase() === '.mp4' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES; }
  inspect(file) {
    const root = path.parse(file).root, parts = path.relative(root, file).split(path.sep); let current = root;
    for (let index = 0; index < parts.length; index++) {
      current = path.join(current, parts[index]);
      const stat = this.io.lstatSync(current);
      if (stat.isSymbolicLink() || !samePath(this.io.realpathSync(current), current)) fail('MEDIA_PATH_BLOCKED');
      if (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile() || stat.nlink > 1) fail('MEDIA_PATH_BLOCKED');
      if (index === parts.length - 1) {
        const limit = this.fileLimit(file);
        if (!stat.size || stat.size > limit) fail('MEDIA_TOO_LARGE', 413);
        return identity(stat);
      }
    }
    fail('MEDIA_PATH_BLOCKED');
  }
  pathFor(raw) { return imagePath(raw); }
  kindFor(file) { return path.extname(file).toLowerCase() === '.mp4' ? 'video' : 'image'; }
  route(token) { return `/api/media/${token}`; }
  register(session, threadId, raw, alt = '대화 이미지') {
    if (!session?.id) return mediaPlaceholder();
    try {
      const upload = this.ownedUpload(session, raw), file = upload ? upload.file : this.pathFor(raw); this.prune();
      // Only a verified session-owned upload may bypass the configured private-directory exclusion.
      if (!upload && this.privateRoot) {
        const relative = path.relative(this.privateRoot, file);
        if (!relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep)) fail('MEDIA_PATH_BLOCKED');
      }
      const key = JSON.stringify([session.id, threadId, file]);
      let token = this.keys.get(key);
      if (!token) {
        const snapshot = this.inspect(file);
        while (this.entries.size >= this.limit) this.remove(this.entries.keys().next().value);
        const own = [...this.entries].filter(([, e]) => e.owner === session.id);
        if (own.length >= 128) this.remove(own[0][0]);
        token = randomBytes(32).toString('base64url');
        this.entries.set(token, { key, owner: session.id, threadId, file, snapshot, upload, kind: this.kindFor(file), expires: this.now() + this.ttl, streams: new Set() }); this.keys.set(key, token);
      }
      return { state: 'ready', kind: this.entries.get(token).kind, url: this.route(token), alt: String(alt).slice(0, 200) };
    } catch (e) { return { ...mediaPlaceholder(e instanceof BridgeError ? e.code : 'MEDIA_MISSING', alt), ...(typeof raw === 'string' && /\.mp4$/i.test(raw) ? { kind: 'video' } : {}) }; }
  }
  openVideo(session, token) {
    if (this.entry(session, token).kind !== 'video') fail('MEDIA_TYPE_UNSUPPORTED', 415);
    return this.openStream(session, token, (io, fd, size) => validateMp4(io, fd, size));
  }
  openStream(session, token, validate) {
    const entry = this.entry(session, token); let fd;
    try {
      if (this.inspect(entry.file) !== entry.snapshot) fail('MEDIA_CHANGED');
      fd = this.io.openSync(entry.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const valid = () => { const stat = this.io.fstatSync(fd); if (!stat.isFile() || identity(stat) !== entry.snapshot) fail('MEDIA_CHANGED'); };
      valid();
      if (!entry.validated) { validate(this.io, fd, this.io.fstatSync(fd).size, entry.file); entry.validated = true; }
      valid(); if (this.inspect(entry.file) !== entry.snapshot) fail('MEDIA_CHANGED');
      const size = this.io.fstatSync(fd).size; let owned = true;
      return { size, close: () => { if (owned) { owned = false; this.io.closeSync(fd); } },
        stream: (start, end) => {
          if (!owned) fail('MEDIA_NOT_FOUND');
          const source = this.io.createReadStream(null, { fd, autoClose: true, start, end, highWaterMark: 64 * 1024 }); owned = false;
          const check = new Transform({
            transform: (chunk, _encoding, done) => { try { valid(); done(null, chunk); } catch { done(new BridgeError('MEDIA_CHANGED', 404)); } },
            flush: done => { try { valid(); if (this.inspect(entry.file) !== entry.snapshot) fail('MEDIA_CHANGED'); done(); } catch { done(new BridgeError('MEDIA_CHANGED', 404)); } }
          });
          entry.streams.add(check);
          pipeline(source, check, error => { entry.streams.delete(check); if (error && !['ERR_STREAM_PREMATURE_CLOSE', 'ABORT_ERR'].includes(error.code)) this.remove(token); });
          return check;
        } };
    } catch (e) {
      if (fd !== undefined) this.io.closeSync(fd);
      this.remove(token); throw e instanceof BridgeError ? e : new BridgeError('MEDIA_MISSING', 404);
    }
  }
  load(session, token) {
    const entry = this.entry(session, token);
    if (entry.kind !== 'image') fail('MEDIA_TYPE_UNSUPPORTED', 415);
    let fd;
    try {
      if (entry.upload) {
        const current = this.ownedUpload(session, entry.file);
        if (!current || current.file !== entry.file || current.sha256 !== entry.upload.sha256) fail('MEDIA_CHANGED');
      }
      if (this.inspect(entry.file) !== entry.snapshot) fail('MEDIA_CHANGED');
      fd = this.io.openSync(entry.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      const stat = this.io.fstatSync(fd);
      if (!stat.isFile() || identity(stat) !== entry.snapshot || this.inspect(entry.file) !== entry.snapshot) fail('MEDIA_CHANGED');
      const data = Buffer.alloc(stat.size); let offset = 0;
      while (offset < data.length) {
        const bytes = this.io.readSync(fd, data, offset, data.length - offset, offset);
        if (!bytes) fail('MEDIA_CHANGED'); offset += bytes;
      }
      if (identity(this.io.fstatSync(fd)) !== entry.snapshot || this.inspect(entry.file) !== entry.snapshot) fail('MEDIA_CHANGED');
      if (entry.upload && createHash('sha256').update(data).digest('hex') !== entry.upload.sha256) fail('MEDIA_CHANGED');
      return { data, mime: imageMime(data, path.extname(entry.file).toLowerCase()) };
    } catch (e) {
      this.remove(token);
      throw e instanceof BridgeError ? e : new BridgeError('MEDIA_MISSING', 404);
    } finally { if (fd !== undefined) this.io.closeSync(fd); }
  }
}
