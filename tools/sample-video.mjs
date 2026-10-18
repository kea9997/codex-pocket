// Original generated 16x16 AVC/MP4 fixture, two I_PCM frames, no external media or encoder.
// Container/HTTP tests do not establish device decoder compatibility; review playback separately.
const cat = (...parts) => Buffer.concat(parts.flat().map(p => typeof p === 'string' ? Buffer.from(p, 'ascii') : p));
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = n => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type, ...data) => { const payload = cat(...data); return cat(u32(payload.length + 8), type, payload); };
const full = (type, flags, ...data) => box(type, u32(flags), ...data);
const zeros = n => Buffer.alloc(n);
const matrix = cat(u32(65536), u32(0), u32(0), u32(0), u32(65536), u32(0), u32(0), u32(0), u32(1073741824));
function bits() {
  const values = [];
  const put = (n, count) => { for (let i = count - 1; i >= 0; i--) values.push((n >>> i) & 1); };
  const ue = n => { const value = n + 1, width = Math.floor(Math.log2(value)); put(0, width); put(value, width + 1); };
  const align = () => { while (values.length % 8) values.push(0); };
  const finish = () => { values.push(1); align(); return Buffer.from(Array.from({ length: values.length / 8 }, (_, i) => values.slice(i * 8, i * 8 + 8).reduce((n, bit) => n * 2 + bit, 0))); };
  return { put, ue, align, finish };
}
function nal(header, payload) {
  const bytes = []; let zero = 0;
  for (const byte of payload) { if (zero >= 2 && byte <= 3) { bytes.push(3); zero = 0; } bytes.push(byte); zero = byte === 0 ? zero + 1 : 0; }
  return Buffer.from([header, ...bytes]);
}
function avc() {
  const s = bits(); s.put(66, 8); s.put(192, 8); s.put(10, 8);
  for (const n of [0, 0, 2, 1]) s.ue(n);
  s.put(0, 1); s.ue(0); s.ue(0); s.put(1, 1); s.put(1, 1); s.put(0, 1); s.put(0, 1);
  const sps = nal(0x67, s.finish()), p = bits();
  p.ue(0); p.ue(0); p.put(0, 1); p.put(0, 1); p.ue(0); p.ue(0); p.ue(0); p.put(0, 1); p.put(0, 2);
  p.ue(0); p.ue(0); p.ue(0); p.put(1, 1); p.put(0, 1); p.put(0, 1);
  const pps = nal(0x68, p.finish());
  const frames = [0, 1].map(index => {
    const f = bits(); f.ue(0); f.ue(2); f.ue(0); f.put(0, 4); f.ue(index); f.put(0, 1); f.put(0, 1); f.ue(0); f.ue(1);
    f.ue(25); f.align();
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) f.put(((x >> 2) + (y >> 2) + index) % 2 ? 170 : 60, 8);
    for (let i = 0; i < 128; i++) f.put(128, 8);
    const n = nal(0x65, f.finish()); return cat(u32(n.length), n);
  });
  return { sps, pps, frames };
}
export function sampleVideo() {
  const { sps, pps, frames } = avc(), duration = 1000;
  const ftyp = box('ftyp', 'isom', u32(512), 'isom', 'iso2', 'avc1', 'mp41');
  const avcC = box('avcC', Buffer.from([1, 66, 192, 10, 255, 225]), u16(sps.length), sps, Buffer.from([1]), u16(pps.length), pps);
  const visual = box('avc1', zeros(6), u16(1), zeros(16), u16(16), u16(16), u32(72 * 65536), u32(72 * 65536), u32(0), u16(1), zeros(32), u16(24), u16(65535), avcC);
  const makeMoov = offset => {
    const stbl = box('stbl', full('stsd', 0, u32(1), visual), full('stts', 0, u32(1), u32(2), u32(500)), full('stsc', 0, u32(1), u32(1), u32(2), u32(1)), full('stsz', 0, u32(0), u32(2), frames.map(b => u32(b.length))), full('stco', 0, u32(1), u32(offset)), full('stss', 0, u32(2), u32(1), u32(2)));
    const dinf = box('dinf', full('dref', 0, u32(1), full('url ', 1)));
    const minf = box('minf', full('vmhd', 1, zeros(8)), dinf, stbl);
    const mdia = box('mdia', full('mdhd', 0, zeros(8), u32(1000), u32(duration), u16(0x55c4), u16(0)), full('hdlr', 0, u32(0), 'vide', zeros(12), Buffer.from('Synthetic Video\0')), minf);
    const trak = box('trak', full('tkhd', 7, zeros(8), u32(1), u32(0), u32(duration), zeros(8), zeros(8), matrix, u32(16 * 65536), u32(16 * 65536)), mdia);
    return box('moov', full('mvhd', 0, zeros(8), u32(1000), u32(duration), u32(65536), u16(256), zeros(10), matrix, zeros(24), u32(2)), trak);
  };
  const moov = makeMoov(ftyp.length + makeMoov(0).length + 8);
  return cat(ftyp, moov, box('mdat', frames));
}
