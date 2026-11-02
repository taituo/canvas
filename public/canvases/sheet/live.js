// Live mode: the current sheet as a full-screen, real-time, presentation-grade surface.
// Background: Paper Shaders (WebGL mesh gradient). Foreground: frosted-glass cards rendered from the
// sheet's own layout — charts in white, KPIs, named tables (values editable, structure locked), titles.
import { ShaderMount, meshGradientFragmentShader, getShaderColorFromString, ShaderFitOptions } from '../../vendor/paper-shaders/index.js';
import { drawChart } from './charts.js';
import { tables as allTables, chartData, mergeAt, tableColumns, usedRange } from '../../shared/types/sheet.js';
import { Engine, fmtValue, isImg } from '../../shared/engine.js';
import { addr, parseAddr, parseRange, splitSheet, sameName } from '../../shared/a1.js';
import { isErr } from '../../shared/formula.js';

export const PRESETS = {
  aurora: { colors: ['#0b1026', '#3b1c74', '#0aa5d8', '#ff4f9a'], distortion: 0.85, swirl: 0.4, speed: 0.35 },
  nebula: { colors: ['#e0eaff', '#241d9a', '#f75092', '#9f50d3'], distortion: 0.8, swirl: 0.1, speed: 0.5 },
  ocean: { colors: ['#04293a', '#0a6c8a', '#00c6d7', '#7ef0c9'], distortion: 0.9, swirl: 0.3, speed: 0.3 },
  ember: { colors: ['#1a0b0b', '#7a1f1f', '#ff6a3d', '#ffc56e'], distortion: 0.7, swirl: 0.5, speed: 0.4 },
  forest: { colors: ['#071a12', '#145a3a', '#4fb286', '#d8f3a6'], distortion: 0.8, swirl: 0.25, speed: 0.25 },
  ink: { colors: ['#1d1d1f', '#000000', '#3a3a40', '#6b6b75'], distortion: 1, swirl: 0.2, speed: 0.4 },
};

const DEF_W = 100, DEF_H = 21;
const ease = (t) => 1 - Math.pow(1 - t, 3);

export function openLive(ctx, doc, startSheet, { submit, onClose }) {
  let sheetName = startSheet;
  const sh = () => doc.sheets.find((s) => sameName(s.name, sheetName)) || doc.sheets[0];
  const root = document.createElement('div');
  root.className = 'lv';
  root.innerHTML = `
    <div class="lv-bg"></div>
    <div class="lv-scroll"><div class="lv-stage"></div></div>
    <div class="lv-bar">
      <div class="lv-modes"><button class="lv-btn" data-m="sheet" title="Each sheet with its own layout">Sheet</button><button class="lv-btn" data-m="auto" title="All tables, charts and KPIs from every sheet, auto-composed">✦ Combined</button></div>
      <div class="lv-sep"></div>
      <div class="lv-sheets"></div>
      <div class="lv-sep"></div>
      <div class="lv-themes"></div>
      <div class="lv-sep"></div>
      <button class="lv-btn" data-a="fs" title="Fullscreen">⛶</button>
      <button class="lv-btn" data-a="exit" title="Back to edit mode (Esc)">✎ Edit</button>
    </div>
    <div class="lv-live"><i></i>LIVE</div>`;
  document.body.append(root);
  const $ = (s) => root.querySelector(s);
  const stage = $('.lv-stage'), scroller = $('.lv-scroll'), bar = $('.lv-bar');

  // ------------------------------------------------------------- shader background
  let mount = null;
  function theme() { return PRESETS[sh().view?.theme] || PRESETS.aurora; }
  function uniforms(p) {
    return {
      u_colors: p.colors.map(getShaderColorFromString), u_colorsCount: p.colors.length,
      u_distortion: p.distortion, u_swirl: p.swirl, u_grainMixer: 0, u_grainOverlay: 0.06,
      u_fit: ShaderFitOptions.cover, u_rotation: 0, u_scale: 1, u_offsetX: 0, u_offsetY: 0,
      u_originX: 0.5, u_originY: 0.5, u_worldWidth: 0, u_worldHeight: 0,
    };
  }
  function applyTheme() {
    const p = theme();
    try {
      if (!mount) mount = new ShaderMount($('.lv-bg'), meshGradientFragmentShader, uniforms(p), undefined, p.speed, 0, 1, 1920 * 1080 * 2);
      else { mount.setUniforms(uniforms(p)); mount.setSpeed(p.speed); }
    } catch (e) { $('.lv-bg').style.background = `linear-gradient(135deg, ${p.colors.join(', ')})`; }
    root.querySelectorAll('.lv-dot').forEach((d) => d.classList.toggle('on', d.dataset.t === (sh().view?.theme || 'aurora')));
  }

  // ------------------------------------------------------------- layout model from the sheet
  function geometry(s) {
    const cx = (c) => { let x = 0; for (let i = 0; i < c; i++) x += s.colW[i] ?? DEF_W; return x; };
    const ry = (r) => { let y = 0; for (let i = 0; i < r; i++) y += s.rowH[i] ?? DEF_H; return y; };
    const rect = (R) => { const x = cx(R.c1), y = ry(R.r1); return { x, y, w: cx(R.c2 + 1) - x, h: ry(R.r2 + 1) - y }; };
    return { cx, ry, rect };
  }
  function model(name = sheetName) {
    const s = doc.sheets.find((x) => sameName(x.name, name)) || doc.sheets[0];
    const en = new Engine(doc), G = geometry(s), K = s.name + '::';
    const items = [];
    const tabs = allTables(doc).filter((x) => x.sh === s);
    const charts = (s.charts || []).map((ch) => {
      const p = parseAddr(splitSheet(ch.at)[1]) || { c: 0, r: 0 };
      return { ch, r: { x: G.cx(p.c) + (ch.dx || 0), y: G.ry(p.r) + (ch.dy || 0), w: ch.w, h: ch.h } };
    });
    const under = (r) => charts.some(({ r: c }) => r.x < c.x + c.w && c.x < r.x + r.w && r.y < c.y + c.h && c.y < r.y + r.h);
    for (const { ch, r } of charts) {
      let data;
      try { data = chartData(doc, s.name, ch, en); } catch { data = { labels: [], series: [] }; }
      items.push({ key: K + 'chart:' + ch.id, sheet: s.name, kind: ch.type === 'kpi' ? 'kpi' : 'chart', ch, data, r });
    }
    for (const x of tabs) {
      const r = G.rect(x.R);
      if (under(r)) continue;
      const cols = tableColumns(x.sh, x.R);
      const rows = [];
      for (let rr = x.R.r1 + 1; rr <= x.R.r2; rr++) {
        const row = [];
        for (let c = x.R.c1; c <= x.R.c2; c++) {
          const A = addr(c, rr), cell = s.cells[A];
          const v = en.value(s, c, rr);
          row.push({ A, raw: cell?.v ?? '', text: fmtValue(v), num: typeof v === 'number', formula: typeof cell?.v === 'string' && cell.v[0] === '=', err: isErr(v) });
        }
        rows.push(row);
      }
      const above = x.R.r1 > 0 && [x.R.c1, x.R.c1 + 1].some((c) => String(s.cells[addr(c, x.R.r1 - 1)]?.v ?? '').trim());
      items.push({ key: K + 'table:' + x.t.name, sheet: s.name, kind: 'table', name: x.t.name, label: !above, cols, rows, r: { ...r, h: Math.max(r.h, 60) } });
    }
    const inTable = (c, r) => tabs.some((x) => c >= x.R.c1 && c <= x.R.c2 && r >= x.R.r1 && r <= x.R.r2);
    for (const A of Object.keys(s.cells)) {
      const cell = s.cells[A];
      if (cell.v === '' || cell.v == null) continue;
      const p = parseAddr(A);
      if (inTable(p.c, p.r)) continue;
      const M = mergeAt(s, p.c, p.r);
      if (M && (M.c1 !== p.c || M.r1 !== p.r)) continue;
      const r = G.rect(M || { c1: p.c, r1: p.r, c2: p.c, r2: p.r });
      if (under(r)) continue;
      const v = en.value(s, p.c, p.r);
      const st = cell.s || {};
      if (isImg(v)) items.push({ key: K + 'img:' + A, sheet: s.name, kind: 'img', url: v.url, r });
      else items.push({ key: K + 'text:' + A, sheet: s.name, kind: 'text', A, raw: cell.v, text: fmtValue(v), st, num: typeof v === 'number', formula: cell.v[0] === '=', merged: !!M, r });
    }
    return items;
  }

  // ------------------------------------------------------------- combined mode: all sheets, auto-composed
  let mode = 'sheet';
  try { mode = localStorage.getItem('lotus.liveMode') === 'auto' ? 'auto' : 'sheet'; } catch {}
  const excluded = new Set();
  const ORDER = { kpi: 0, stat: 1, chart: 2, table: 3, img: 4 };
  function autoItems() {
    const out = [];
    for (const s of doc.sheets) {
      if (excluded.has(s.name)) continue;
      const items = model(s.name);
      // a sheet with plain data but no named table: show its used range as an implicit table
      if (!items.some((it) => it.kind === 'table' || it.kind === 'chart' || it.kind === 'kpi')) {
        const U = usedRange(s);
        if (U && U.r2 > U.r1 && U.c2 > U.c1 && (U.r2 - U.r1 + 1) * (U.c2 - U.c1 + 1) <= 4000) {
          const en = new Engine(doc);
          const cols = [];
          for (let c = U.c1; c <= U.c2; c++) cols.push(fmtValue(en.value(s, c, U.r1)) || ' ');
          const rows = [];
          for (let r = U.r1 + 1; r <= U.r2; r++) {
            const row = [];
            for (let c = U.c1; c <= U.c2; c++) {
              const A = addr(c, r), cell = s.cells[A], v = en.value(s, c, r);
              row.push({ A, raw: cell?.v ?? '', text: fmtValue(v), num: typeof v === 'number', formula: typeof cell?.v === 'string' && cell.v[0] === '=', err: isErr(v) });
            }
            rows.push(row);
          }
          out.push({ key: s.name + '::range', kind: 'table', sheet: s.name, name: s.name, label: true, cols, rows, r: { x: 0, y: 0, w: 400, h: 200 } });
          continue;
        }
      }
      const rows = new Map();
      for (const it of items) {
        if (it.kind !== 'text') { out.push(it); continue; }
        const r = parseAddr(it.A).r;
        if (!rows.has(r)) rows.set(r, []);
        rows.get(r).push(it);
      }
      // "label | value" rows become stat cards
      for (const list of rows.values()) {
        list.sort((a, b) => parseAddr(a.A).c - parseAddr(b.A).c);
        if (list.length === 2 && !list[0].num && list[1].num) {
          out.push({ key: s.name + '::stat:' + list[1].A, kind: 'stat', sheet: s.name, label: list[0].text, value: list[1], r: list[1].r });
        }
      }
    }
    // the same number under the same label (e.g. a KPI and the cell it reads) is shown once
    const seenStat = new Set();
    out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
    const uniq = out.filter((it) => {
      if (it.kind !== 'kpi' && it.kind !== 'stat') return true;
      const label = (it.kind === 'kpi' ? it.ch.title || it.data.kpi.label : it.label).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const val = it.kind === 'kpi' ? it.data.kpi.value : it.value.text;
      const k = label + '=' + (typeof val === 'number' ? +val.toFixed(6) : String(val).replace(',', '.'));
      if (seenStat.has(k)) return false;
      seenStat.add(k);
      return true;
    });
    return uniq.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  }
  function spanOf(it, cols) {
    const n = it.kind === 'table' ? (it.cols.length >= 6 ? 3 : it.cols.length >= 4 ? 2 : 1)
      : it.kind === 'chart' ? (it.ch.type !== 'pie' && it.ch.w >= 520 ? 2 : 1) : 1;
    return Math.min(n, cols);
  }
  const FIXED_H = { kpi: 150, stat: 118, chart: 300, img: 260 };

  // ------------------------------------------------------------- rendering (keyed)
  const nodes = new Map();       // key -> { el, item, tween }
  let scale = 1, bx = 0, by = 0, offX = 0;
  const PAD = 56;

  function layoutScale(items) {
    if (!items.length) return;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const it of items) {
      const w = it.kind === 'text' && !it.merged && !it.st.wrap ? Math.max(it.r.w, textWidth(it) + 8) : it.r.w;
      x1 = Math.min(x1, it.r.x); y1 = Math.min(y1, it.r.y); x2 = Math.max(x2, it.r.x + w); y2 = Math.max(y2, it.r.y + it.r.h);
    }
    const W = scroller.clientWidth - PAD * 2;
    scale = Math.max(0.5, Math.min(1.9, W / (x2 - x1)));
    bx = x1; by = y1;
    offX = PAD + Math.max(0, (W - (x2 - x1) * scale) / 2);
    stage.style.height = (y2 - y1) * scale + PAD * 2 + 80 + 'px';
  }
  const meas = document.createElement('canvas').getContext('2d');
  function textWidth(it) { meas.font = `${it.st.b ? 600 : 400} ${it.st.fs || 13}px system-ui`; return meas.measureText(it.text).width; }
  function place(el, r, autoH) {
    el.style.left = offX + (r.x - bx) * scale + 'px';
    el.style.top = PAD + (r.y - by) * scale + 'px';
    el.style.width = r.w * scale + 'px';
    if (!autoH) el.style.height = r.h * scale + 'px';
  }

  let vtSeq = 0;
  function render() {
    const auto = mode === 'auto';
    const items = auto ? autoItems() : model();
    stage.classList.toggle('lv-grid', auto);
    root.classList.toggle('lv-auto', auto);
    if (auto) { scale = 1; stage.style.height = ''; } else layoutScale(items);
    const seen = new Set();
    const cols = auto ? Math.max(1, getComputedStyle(stage).gridTemplateColumns.split(' ').length) : 1;
    for (const it of items) {
      seen.add(it.key);
      let n = nodes.get(it.key);
      if (!n) {
        n = { el: create(it), item: null, tween: null };
        n.el.style.viewTransitionName = 'lv' + ++vtSeq;
        nodes.set(it.key, n);
        stage.append(n.el);
        n.el.classList.add('lv-in');
        n.el.addEventListener('animationend', () => n.el.classList.remove('lv-in'), { once: true });
      }
      if (auto) {
        stage.append(n.el); // DOM order = visual order in the grid
        n.el.style.left = n.el.style.top = n.el.style.width = '';
        n.el.style.gridColumn = `span ${spanOf(it, cols)}`;
        n.el.style.height = FIXED_H[it.kind] ? FIXED_H[it.kind] + 'px' : 'auto';
        n.el.dataset.tag = doc.sheets.length > 1 ? it.sheet : '';
      } else { n.el.style.gridColumn = ''; n.el.style.gridRowEnd = ''; n.el.dataset.tag = ''; }
      update(n, it);
      n.item = it;
    }
    for (const [k, n] of nodes) if (!seen.has(k)) { n.el.remove(); nodes.delete(k); }
    if (auto) masonry(items); else reflow(items);
    for (const n of nodes.values()) if (n.item.kind === 'chart') paintChart(n, n.item);
    renderBar();
    tick();
  }
  /** Masonry: each card spans as many 4px grid rows as its height needs; `dense` fills the holes. */
  function masonry(items) {
    for (const it of items) {
      const el = nodes.get(it.key).el;
      el.style.gridRowEnd = `span ${Math.ceil((el.offsetHeight + 18) / 4)}`;
    }
  }
  /** Switch layouts with a View Transition so cards morph to their new places. */
  function transition(fn) {
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(fn);
    else fn();
  }

  /** Tables take their natural height; everything below them (overlapping horizontally) moves down. */
  function reflow(items) {
    const shifts = [];
    for (const it of items) {
      if (it.kind !== 'table') continue;
      const el = nodes.get(it.key).el;
      el.style.height = 'auto';
      const natural = el.offsetHeight / scale;
      const extra = natural - it.r.h;
      if (extra > 1) shifts.push({ x1: it.r.x, x2: it.r.x + it.r.w, bottom: it.r.y + it.r.h, extra });
    }
    if (!shifts.length) return;
    let maxBottom = 0;
    for (const it of items) {
      let dy = 0;
      for (const sft of shifts) {
        const w = it.kind === 'text' ? Math.max(it.r.w, 200) : it.r.w;
        if (it.r.y >= sft.bottom - 1 && it.r.x < sft.x2 && sft.x1 < it.r.x + w) dy = Math.max(dy, sft.extra);
      }
      if (dy) place(nodes.get(it.key).el, { ...it.r, y: it.r.y + dy }, it.kind === 'table');
      maxBottom = Math.max(maxBottom, (it.r.y + dy - by) * scale + nodes.get(it.key).el.offsetHeight);
    }
    stage.style.height = Math.max(parseFloat(stage.style.height) || 0, maxBottom + PAD * 2 + 80) + 'px';
  }

  function create(it) {
    const el = document.createElement('div');
    if (it.kind === 'chart') {
      el.className = 'lv-card lv-chart';
      el.innerHTML = '<div class="lv-title"></div><canvas></canvas>';
    } else if (it.kind === 'kpi') {
      el.className = 'lv-card lv-kpi';
      el.innerHTML = '<div class="lv-label"></div><div class="lv-num"></div>';
    } else if (it.kind === 'table') {
      el.className = 'lv-card lv-table';
      el.innerHTML = '<div class="lv-label"></div><div class="lv-tw"><table><thead></thead><tbody></tbody></table></div>';
      el.addEventListener('focusout', (e) => commitCell(e.target));
      el.addEventListener('keydown', (e) => cellKey(e));
    } else if (it.kind === 'stat') {
      el.className = 'lv-card lv-stat';
      el.innerHTML = '<div class="lv-label"></div><div class="lv-statv"></div>';
      el.addEventListener('focusout', (e) => commitCell(e.target));
      el.addEventListener('keydown', (e) => cellKey(e));
    } else if (it.kind === 'img') {
      el.className = 'lv-card lv-imgcard';
      el.innerHTML = '<img alt="">';
    } else {
      el.className = 'lv-text';
      el.addEventListener('focusout', (e) => commitCell(e.target));
      el.addEventListener('keydown', (e) => cellKey(e));
    }
    return el;
  }

  function update(n, it) {
    const el = n.el;
    el.dataset.sheet = it.sheet;
    if (mode === 'sheet') place(el, it.r);
    if (it.kind === 'stat') {
      el.querySelector('.lv-label').textContent = it.label;
      const v = el.querySelector('.lv-statv');
      v.dataset.a = it.value.A; v.dataset.raw = it.value.raw; v.dataset.sheet = it.sheet;
      v.contentEditable = it.value.formula ? 'false' : 'plaintext-only';
      if (v !== document.activeElement && v.textContent !== it.value.text) { if (n.item) pulse(el); v.textContent = it.value.text; }
      return;
    }
    if (it.kind === 'chart') {
      el.querySelector('.lv-title').textContent = it.ch.title || '';
      const prev = n.item?.data;
      if (prev && sameShape(prev, it.data) && changed(prev, it.data)) n.tween = { from: n.tween ? current(n) : prev, to: it.data, t0: performance.now() };
      else if (!prev) n.tween = { from: zeroed(it.data), to: it.data, t0: performance.now() };
      else if (!sameShape(prev, it.data)) n.tween = null;
      n.data = it.data;
      if (mode === 'sheet') paintChart(n, it);
    } else if (it.kind === 'kpi') {
      el.querySelector('.lv-label').textContent = it.ch.title || it.data.kpi.label || '';
      const v = it.data.kpi.value;
      const pv = n.item?.data.kpi.value;
      n.kpi = { to: v, text: it.data.kpi.text, from: typeof pv === 'number' ? (n.kpi?.cur ?? pv) : typeof v === 'number' ? 0 : v, t0: performance.now() };
      const kh = mode === 'auto' ? FIXED_H.kpi : it.r.h * scale, kw = mode === 'auto' ? el.clientWidth || 300 : it.r.w * scale;
      el.querySelector('.lv-num').style.fontSize = Math.min(kh * 0.48, kw * 0.3) + 'px';
      if (n.item && pv !== v) pulse(el);
    } else if (it.kind === 'table') {
      const lab = el.querySelector('.lv-label');
      lab.textContent = it.name;
      lab.style.display = it.label || mode === 'auto' ? '' : 'none';
      const thead = el.querySelector('thead'), tbody = el.querySelector('tbody');
      const fsz = mode === 'auto' ? 14 : Math.max(11, Math.min(17, 12 * scale));
      el.style.fontSize = fsz + 'px';
      const sig = it.cols.join('\u0001') + '|' + it.rows.length;
      if (n.sig !== sig && !el.contains(document.activeElement)) {
        thead.innerHTML = '<tr>' + it.cols.map((c) => `<th>${esc(c)}</th>`).join('') + '</tr>';
        tbody.innerHTML = it.rows.map((row) => '<tr>' + row.map((c) => `<td data-a="${c.A}"></td>`).join('') + '</tr>').join('');
        n.sig = sig;
      }
      for (const row of it.rows) for (const c of row) {
        const td = tbody.querySelector(`td[data-a="${c.A}"]`);
        if (!td || td === document.activeElement) continue;
        if (td.textContent !== c.text) { if (td.dataset.init) pulse(td); td.textContent = c.text; }
        td.dataset.init = 1;
        td.dataset.raw = c.raw;
        td.className = (c.num ? 'num' : '') + (c.err ? ' err' : '');
        td.contentEditable = c.formula ? 'false' : 'plaintext-only';
        td.title = c.formula ? c.raw : '';
      }
    } else if (it.kind === 'img') {
      const img = el.querySelector('img');
      if (img.getAttribute('src') !== it.url) img.src = it.url;
    } else {
      const st = it.st;
      const fs = (st.fs || 13) * scale;
      el.style.fontSize = fs + 'px';
      el.style.fontWeight = st.b || (st.fs || 13) >= 20 ? 650 : 400;
      el.style.fontStyle = st.i ? 'italic' : '';
      el.style.textAlign = st.align || (it.num ? 'right' : 'left');
      el.style.whiteSpace = st.wrap || it.merged ? 'pre-wrap' : 'pre';
      el.style.opacity = (st.fs || 13) >= 16 || st.b ? 1 : 0.78;
      el.style.letterSpacing = (st.fs || 13) >= 24 ? '-0.025em' : '';
      el.style.lineHeight = Math.max(fs * 1.25, Math.min(it.r.h * scale, fs * 1.6)) + 'px';
      el.style.width = (st.wrap || it.merged || it.num ? it.r.w * scale : Math.max(it.r.w * scale, (textWidth(it) + 8) * scale)) + 'px';
      el.dataset.a = it.A;
      el.dataset.raw = it.raw;
      el.contentEditable = it.formula ? 'false' : 'plaintext-only';
      if (el !== document.activeElement && el.textContent !== it.text) { if (n.item) pulse(el); el.textContent = it.text; }
    }
  }

  // ------------------------------------------------------------- charts: tweened canvas paint
  const sameShape = (a, b) => a.labels?.length === b.labels?.length && a.series?.length === b.series?.length;
  const changed = (a, b) => a.series.some((s, i) => s.values.some((v, j) => v !== b.series[i].values[j]));
  const zeroed = (d) => ({ ...d, series: d.series.map((s) => ({ ...s, values: s.values.map((v) => (v === null ? null : 0)) })) });
  function current(n) {
    const t = n.tween;
    const k = ease(Math.min(1, (performance.now() - t.t0) / 900));
    return { ...t.to, series: t.to.series.map((s, i) => ({ ...s, values: s.values.map((v, j) => { const f = t.from.series[i]?.values[j]; return v === null || f == null ? v : f + (v - f) * k; }) })) };
  }
  function paintChart(n, it) {
    const cv = n.el.querySelector('canvas');
    const dpr = window.devicePixelRatio || 1;
    const card = n.el, title = card.querySelector('.lv-title');
    const w = Math.max(40, card.clientWidth - 24), h = Math.max(40, card.clientHeight - 28 - (title.offsetHeight || 0) - 6);
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; cv.style.width = w + 'px'; cv.style.height = h + 'px'; }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const data = n.tween ? current(n) : n.data;
    drawChart(g, { x: 0, y: 0, w, h }, { ...it.ch, title: '' }, data, Math.min(1.6, scale * 1.05), false, 'glass');
  }
  let raf = 0;
  function tick() {
    cancelAnimationFrame(raf);
    let busy = false;
    const now = performance.now();
    for (const n of nodes.values()) {
      if (n.item?.kind === 'chart' && n.tween) {
        paintChart(n, n.item);
        if (now - n.tween.t0 < 900) busy = true; else n.tween = null;
      }
      if (n.item?.kind === 'kpi' && n.kpi) {
        const k = n.kpi, num = n.el.querySelector('.lv-num');
        const t = Math.min(1, (now - k.t0) / 900);
        if (typeof k.to === 'number' && typeof k.from === 'number' && t < 1) {
          k.cur = k.from + (k.to - k.from) * ease(t);
          num.textContent = fmtNum(k.cur, k.to);
          busy = true;
        } else { k.cur = k.to; num.textContent = typeof k.to === 'number' ? fmtNum(k.to, k.to) : k.text || '—'; }
      }
    }
    if (busy) raf = requestAnimationFrame(tick);
  }
  const decimals = (v) => { const s = String(+v.toFixed(6)); return s.includes('.') ? Math.min(2, s.split('.')[1].length) : 0; };
  const fmtNum = (v, target) => v.toLocaleString('fi-FI', { minimumFractionDigits: decimals(target), maximumFractionDigits: decimals(target) });

  function pulse(el) { el.classList.remove('lv-pulse'); void el.offsetWidth; el.classList.add('lv-pulse'); }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  // ------------------------------------------------------------- editing values (structure is locked)
  function commitCell(el) {
    const A = el?.dataset?.a;
    if (!A || el.contentEditable === 'false') return;
    const text = el.textContent.replace(/\n+$/, '');
    if (text === (el.dataset.raw ?? '')) return;
    submit([{ op: 'set', sheet: el.dataset.sheet || el.closest('[data-sheet]')?.dataset.sheet || sh().name, cells: { [A]: text === '' ? null : text } }]);
  }
  function cellKey(e) {
    const el = e.target;
    if (!el.dataset?.a) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); el.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); el.textContent = el.dataset.raw ?? ''; el.blur(); }
  }

  // ------------------------------------------------------------- control bar
  function renderBar() {
    const sheets = $('.lv-sheets');
    const names = doc.sheets.map((s) => s.name).join('|');
    const sig = names + '|' + sh().name + '|' + mode + '|' + [...excluded].join(',');
    if (sheets.dataset.sig !== sig) {
      sheets.innerHTML = '';
      for (const s of doc.sheets) {
        const b = document.createElement('button');
        const on = mode === 'auto' ? !excluded.has(s.name) : s === sh();
        b.className = 'lv-btn' + (on ? ' on' : '') + (mode === 'auto' ? ' chip' : '');
        b.textContent = s.name;
        b.title = mode === 'auto' ? 'Include / exclude this sheet' : 'Show this sheet';
        b.onclick = () => transition(() => {
          if (mode === 'auto') { if (excluded.has(s.name)) excluded.delete(s.name); else excluded.add(s.name); }
          else { sheetName = s.name; applyTheme(); scroller.scrollTop = 0; }
          render();
        });
        sheets.append(b);
      }
      sheets.dataset.sig = sig;
    }
    root.querySelectorAll('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === mode));
    const th = $('.lv-themes');
    if (!th.childElementCount) {
      for (const [k, p] of Object.entries(PRESETS)) {
        const d = document.createElement('button');
        d.className = 'lv-dot'; d.dataset.t = k; d.title = k;
        d.style.background = `conic-gradient(${p.colors.join(', ')}, ${p.colors[0]})`;
        d.onclick = () => { submit([{ op: 'view', sheet: sh().name, theme: k }]); applyTheme(); };
        th.append(d);
      }
      applyTheme();
    }
  }
  root.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => {
    if (mode === b.dataset.m) return;
    transition(() => { mode = b.dataset.m; try { localStorage.setItem('lotus.liveMode', mode); } catch {} render(); scroller.scrollTop = 0; });
  }));
  // Cross-highlight: hovering a value lights up the same value in every other card -> tables connect visually.
  const norm = (t) => t.trim().toLowerCase();
  stage.addEventListener('mouseover', (e) => {
    const t = e.target.closest('td, .lv-text, .lv-statv');
    const key = t ? norm(t.textContent) : '';
    stage.querySelectorAll('.lv-link').forEach((x) => x.classList.remove('lv-link'));
    stage.querySelectorAll('.lv-linked').forEach((x) => x.classList.remove('lv-linked'));
    if (!key || key.length < 2 || !isNaN(+key.replace(',', '.'))) { stage.classList.remove('lv-linking'); return; }
    let hits = 0;
    stage.querySelectorAll('td, .lv-text, .lv-statv').forEach((x) => { if (norm(x.textContent) === key) { x.classList.add('lv-link'); x.closest('.lv-card, .lv-text')?.classList.add('lv-linked'); hits++; } });
    stage.classList.toggle('lv-linking', hits > 1);
  });
  stage.addEventListener('mouseleave', () => { stage.classList.remove('lv-linking'); stage.querySelectorAll('.lv-link, .lv-linked').forEach((x) => x.classList.remove('lv-link', 'lv-linked')); });
  root.querySelector('[data-a=exit]').onclick = close;
  root.querySelector('[data-a=fs]').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen?.());
  let idle;
  const wake = () => { root.classList.remove('lv-idle'); clearTimeout(idle); idle = setTimeout(() => root.classList.add('lv-idle'), 2600); };
  root.addEventListener('mousemove', wake);
  wake();
  const onKey = (e) => { if (e.key === 'Escape' && !document.activeElement?.dataset?.a) { e.preventDefault(); close(); } };
  document.addEventListener('keydown', onKey, true);
  const onResize = () => render();
  addEventListener('resize', onResize);

  function close() {
    cancelAnimationFrame(raf);
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', onResize);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    try { mount?.dispose(); } catch {}
    root.classList.add('lv-out');
    setTimeout(() => root.remove(), 260);
    onClose?.(sheetName);
  }

  render();
  return { update: () => render(), close, get sheet() { return sheetName; } };
}
