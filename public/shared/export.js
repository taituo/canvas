// Sheet -> document. Reads the sheet top-to-bottom: big/bold cells become headings, named tables become
// tables, charts become data tables (+ images in the browser export), =IMAGE() becomes an image.
import { TYPES } from './types/index.js';
import { Engine, fmtValue, isImg } from './engine.js';
import { parseAddr, splitSheet, addr } from './a1.js';

export function sheetBlocks(doc, sheetName) {
  const S = TYPES.sheet;
  const sh = S.findSheet(doc, sheetName);
  const en = new Engine(doc);
  const tabs = S.tables(doc).filter((x) => x.sh === sh);
  const inTable = (c, r) => tabs.find((x) => c >= x.R.c1 && c <= x.R.c2 && r >= x.R.r1 && r <= x.R.r2);
  const byRow = new Map();
  for (const A of Object.keys(sh.cells)) {
    const p = parseAddr(A);
    const cell = sh.cells[A];
    if (cell.v === '' || cell.v == null) continue;
    if (inTable(p.c, p.r)) continue;
    const M = S.mergeAt(sh, p.c, p.r);
    if (M && (M.c1 !== p.c || M.r1 !== p.r)) continue;
    if (!byRow.has(p.r)) byRow.set(p.r, []);
    byRow.get(p.r).push(p);
  }
  const events = [];
  for (const [r, cells] of byRow) events.push({ r, kind: 'cells', cells: cells.sort((a, b) => a.c - b.c) });
  for (const x of tabs) events.push({ r: x.R.r1, kind: 'table', x });
  for (const ch of sh.charts || []) {
    const p = parseAddr(splitSheet(ch.at)[1]);
    events.push({ r: p.r + (ch.dy || 0) / 1000, c: p.c, kind: 'chart', ch });
  }
  events.sort((a, b) => a.r - b.r || (a.kind === 'chart' ? 1 : 0) - (b.kind === 'chart' ? 1 : 0) || (a.c || 0) - (b.c || 0));
  const blocks = [];
  for (const e of events) {
    if (e.kind === 'table') {
      const t = S.readTable(doc, e.x.t.name, { limit: 5000 });
      blocks.push({ t: 'table', name: t.table, cols: t.columns, rows: t.rows.map((row) => row.values.map((v) => (v.value !== undefined ? v.value : v.raw))) });
    } else if (e.kind === 'chart') {
      let data;
      try { data = S.chartData(doc, sh.name, e.ch, en); } catch { continue; }
      if (data.kpi) blocks.push({ t: 'kpi', id: e.ch.id, title: e.ch.title || data.kpi.label, text: data.kpi.text });
      else blocks.push({ t: 'chart', id: e.ch.id, type: e.ch.type, title: e.ch.title || '', data });
    } else {
      const parts = e.cells.map((p) => ({ p, v: en.value(sh, p.c, p.r), s: sh.cells[addr(p.c, p.r)].s || {} }));
      const imgs = parts.filter((x) => isImg(x.v));
      for (const x of imgs) blocks.push({ t: 'img', url: x.v.url });
      const texts = parts.filter((x) => !isImg(x.v)).map((x) => ({ text: fmtValue(x.v), s: x.s }));
      if (!texts.length) continue;
      const lead = texts[0].s;
      const text = texts.map((x) => x.text).join(texts.length === 2 ? ': ' : ' · ');
      if (texts.length === 1 && (lead.fs || 13) >= 24) blocks.push({ t: 'h', level: 1, text });
      else if (texts.length === 1 && (lead.fs || 13) >= 16) blocks.push({ t: 'h', level: 2, text });
      else if (texts.length === 1 && lead.b && text.length < 80) blocks.push({ t: 'h', level: 3, text });
      else blocks.push({ t: 'p', text });
    }
  }
  return { sheet: sh.name, blocks };
}

const mdCell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\n/g, '<br>');
function mdTable(cols, rows) {
  return [`| ${cols.map(mdCell).join(' | ')} |`, `|${cols.map(() => ' --- ').join('|')}|`, ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`)].join('\n');
}
export function toMarkdown({ blocks }) {
  const out = [];
  for (const b of blocks) {
    if (b.t === 'h') out.push('#'.repeat(b.level) + ' ' + b.text);
    else if (b.t === 'p') out.push(b.text);
    else if (b.t === 'img') out.push(`![](${b.url})`);
    else if (b.t === 'kpi') out.push(`**${b.title}:** ${b.text}`);
    else if (b.t === 'table') out.push(mdTable(b.cols, b.rows));
    else if (b.t === 'chart') {
      out.push(`*${b.title || b.type} (${b.type} chart)*`);
      out.push(mdTable(['', ...b.data.series.map((s) => s.name)], b.data.labels.map((l, i) => [l, ...b.data.series.map((s) => s.values[i] ?? '')])));
    }
  }
  return out.join('\n\n') + '\n';
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export function toHtml({ sheet, blocks }, chartImages = {}) {
  const body = blocks.map((b) => {
    if (b.t === 'h') return `<h${b.level}>${esc(b.text)}</h${b.level}>`;
    if (b.t === 'p') return `<p>${esc(b.text).replace(/\n/g, '<br>')}</p>`;
    if (b.t === 'img') return `<p><img src="${esc(b.url)}" alt=""></p>`;
    if (b.t === 'kpi') return `<div class="kpi"><span>${esc(b.title)}</span><b>${esc(b.text)}</b></div>`;
    const table = (cols, rows) => `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    if (b.t === 'table') return table(b.cols, b.rows);
    if (b.t === 'chart') {
      const im = chartImages[b.id];
      if (im) return `<figure><img src="${typeof im === 'string' ? im : im.src}" ${im.w ? `width="${im.w}"` : ''} alt="${esc(b.title)}"></figure>`;
      return `<figure><figcaption>${esc(b.title)}</figcaption>${table(['', ...b.data.series.map((s) => s.name)], b.data.labels.map((l, i) => [l, ...b.data.series.map((s) => s.values[i] ?? '')]))}</figure>`;
    }
    return '';
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(sheet)}</title><style>
body{font:15px/1.55 system-ui,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#202124}
table{border-collapse:collapse;margin:12px 0;font-size:14px}th,td{border:1px solid #dadce0;padding:5px 10px;text-align:left}th{background:#e8f0fe}
.kpi{display:inline-flex;flex-direction:column;border:1px solid #dadce0;border-radius:8px;padding:10px 16px;margin:4px 8px 4px 0}.kpi span{color:#5f6368;font-size:13px}.kpi b{font-size:30px}
figure{margin:16px 0}figure img,p img{max-width:100%}figcaption{color:#5f6368;font-size:13px}
</style></head><body>
${body}
</body></html>`;
}

export function exportSheet(doc, sheetName, format) {
  const b = sheetBlocks(doc, sheetName);
  if (format === 'json') return JSON.stringify(b);
  return format === 'html' ? toHtml(b) : toMarkdown(b);
}
