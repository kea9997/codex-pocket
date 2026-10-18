'use strict';
// Small, bounded block grammar. All leaf text uses the existing safe inline renderer.
function tableCells(line) {
  if (line.length > 8192 || !line.includes('|')) return null;
  let source = line.trim(); if (source.startsWith('|')) source = source.slice(1); if (source.endsWith('|') && !source.endsWith('\\|')) source = source.slice(0, -1);
  const cells = []; let cell = '', ticks = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\' && source[i + 1] === '|') { cell += '|'; i++; }
    else if (ch === '`') { let n = 1; while (source[i + 1] === '`') { n++; i++; } ticks = ticks === n ? 0 : ticks || n; cell += '`'.repeat(n); }
    else if (ch === '|' && !ticks) { cells.push(cell.trim()); cell = ''; if (cells.length > 24) return null; }
    else cell += ch;
  }
  cells.push(cell.trim()); return cells.length >= 1 && cells.length <= 24 && !ticks ? cells : null;
}
function markdownBlocks(target, value) {
  const literal = text => { const p = node('p'); appendInline(p, text); target.append(p); };
  if (value.length > 131072) { literal(value); return; }
  const lines = value.split('\n'); if (lines.length > 4096) { literal(value); return; }
  const listItem = line => /^( {0,3})([-+*]|\d{1,9}[.)])\s+(.+)$/.exec(line);
  let paragraph = [];
  const flush = () => { if (paragraph.length) literal(paragraph.join('\n')); paragraph = []; };
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { flush(); i++; continue; }
    const head = tableCells(line), delimiter = i + 1 < lines.length ? tableCells(lines[i + 1]) : null;
    if (head && delimiter && delimiter.length === head.length && delimiter.every(cell => /^:?-{3,}:?$/.test(cell))) {
      const rows = []; let end = i + 2, valid = true;
      while (end < lines.length && lines[end].trim() && lines[end].includes('|')) {
        const cells = tableCells(lines[end]); if (!cells || cells.length !== head.length || rows.length >= 200) valid = false;
        rows.push(cells); end++;
      }
      flush();
      if (!valid) { literal(lines.slice(i, end).join('\n')); i = end; continue; }
      const region = node('div', undefined, 'markdown-table'); region.setAttribute('role', 'region'); region.setAttribute('aria-label', '표 · 가로로 스크롤'); region.setAttribute('tabindex', '0');
      target.structuredMarkdown = true;
      const table = node('table'), thead = node('thead'), tr = node('tr'), tbody = node('tbody');
      const align = delimiter.map(cell => cell.endsWith(':') ? cell.startsWith(':') ? 'align-center' : 'align-right' : 'align-left');
      head.forEach((cell, n) => { const th = node('th', undefined, align[n]); th.setAttribute('scope', 'col'); appendInline(th, cell); tr.append(th); }); thead.append(tr);
      for (const cells of rows) { const row = node('tr'); cells.forEach((cell, n) => { const td = node('td', undefined, align[n]); appendInline(td, cell); row.append(td); }); tbody.append(row); }
      table.append(thead, tbody); region.append(table); target.append(region); i = end; continue;
    }
    const item = listItem(line);
    if (item) {
      flush(); const ordered = /^\d/.test(item[2]), entries = []; let end = i;
      while (end < lines.length) { const m = listItem(lines[end]); if (!m || /^\d/.test(m[2]) !== ordered || entries.length >= 200) break; entries.push(m); end++; }
      target.structuredMarkdown = true;
      const list = node(ordered ? 'ol' : 'ul'); if (ordered) list.setAttribute('start', String(Number.parseInt(item[2], 10)));
      for (const m of entries) {
        const li = node('li'), task = /^\[([ xX])\]\s+(.+)$/.exec(m[3]);
        if (task) {
          li.className = 'task-item'; const mark = node('span', task[1] === ' ' ? '☐' : '☑', 'task-mark');
          mark.setAttribute('role', 'img'); mark.setAttribute('aria-label', task[1] === ' ' ? '미완료' : '완료');
          const text = node('span'); appendInline(text, task[2]); li.append(mark, text);
        } else appendInline(li, m[3]);
        list.append(li);
      }
      target.append(list); i = end; continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) { flush(); const h = node(heading[1].length === 3 ? 'h3' : 'h2'); appendInline(h, heading[2]); target.append(h); i++; continue; }
    paragraph.push(line); i++;
  }
  flush();
}
