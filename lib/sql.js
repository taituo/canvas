// SQL over named tables using Node's built-in SQLite (node:sqlite, in-memory, rebuilt per query).
// Every named table in every workbook becomes a SQL table. Tables of the current workbook use their
// own name; tables of other workbooks are "doc.Table". A hidden _row column ties records to sheet rows,
// so UPDATE / INSERT / DELETE are written back as normal table ops (versioned, undoable, in the change feed).
import { TYPES } from '../public/shared/types/index.js';
import { Engine, fmtValue } from '../public/shared/engine.js';
import { literal, isErr } from '../public/shared/formula.js';
import { addr } from '../public/shared/a1.js';

let DatabaseSync;
async function sqlite() {
  if (!DatabaseSync) {
    const emit = process.emitWarning;
    process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...a));
    ({ DatabaseSync } = await import('node:sqlite'));
  }
  return DatabaseSync;
}

const qi = (n) => '"' + String(n).replace(/"/g, '""') + '"';

function cellValue(en, sh, c, r) {
  const cell = sh.cells[addr(c, r)];
  if (!cell || cell.v === '' || cell.v == null) return null;
  const v = cell.v[0] === '=' ? en.value(sh, c, r) : literal(cell.v);
  if (v === null) return null;
  if (isErr(v)) return v.code;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'object') return fmtValue(v);
  return v;
}

/** Collect tables of all sheet docs. */
function collect(state, docId) {
  const out = [];
  for (const id of state.order) {
    const d = state.docs[id];
    if (d.type !== 'sheet') continue;
    const en = new Engine(d);
    for (const x of TYPES.sheet.tables(d)) {
      const cols = uniq(TYPES.sheet.tableColumns(x.sh, x.R));
      const rows = [];
      for (let r = x.R.r1 + 1; r <= x.R.r2; r++) {
        const vals = [];
        for (let c = x.R.c1; c <= x.R.c2; c++) vals.push(cellValue(en, x.sh, c, r));
        rows.push({ r, vals });
      }
      out.push({ doc: id, sqlName: id === docId ? x.t.name : `${id}.${x.t.name}`, name: x.t.name, cols, rows, R: x.R });
    }
  }
  return out;
}
function uniq(cols) {
  const seen = new Map();
  return cols.map((c) => { const k = c.toLowerCase(); const n = (seen.get(k) || 0) + 1; seen.set(k, n); return n > 1 ? `${c}_${n}` : c; });
}

export async function runSql(state, docId, sql, { write = false } = {}) {
  const DB = await sqlite();
  const db = new DB(':memory:');
  const tabs = collect(state, docId);
  for (const t of tabs) {
    db.exec(`CREATE TABLE ${qi(t.sqlName)} (_row INTEGER, ${t.cols.map(qi).join(', ')})`);
    const ins = db.prepare(`INSERT INTO ${qi(t.sqlName)} VALUES (${['?', ...t.cols.map(() => '?')].join(', ')})`);
    for (const row of t.rows) ins.run(row.r, ...row.vals);
  }
  const stmt = db.prepare(sql);
  const isRead = /^\s*(select|with|pragma|explain|values)\b/i.test(sql);
  if (isRead) {
    const rows = stmt.all();
    const columns = rows.length ? Object.keys(rows[0]).filter((k) => k !== '_row') : stmt.columns ? stmt.columns().map((c) => c.name).filter((k) => k !== '_row') : [];
    db.close();
    return { kind: 'rows', columns, rows: rows.map((r) => columns.map((c) => r[c])) };
  }
  if (!write) { db.close(); throw Object.assign(new Error('Write statements need write=true (cm sql --write)'), { status: 400 }); }
  const info = stmt.run();
  // diff each table back into table ops
  const opsByDoc = {};
  for (const t of tabs) {
    const now = db.prepare(`SELECT * FROM ${qi(t.sqlName)}`).all();
    const before = new Map(t.rows.map((x) => [x.r, x.vals]));
    const seen = new Set();
    const ops = [];
    const appended = [];
    for (const row of now) {
      const vals = t.cols.map((c) => row[c] ?? null);
      if (row._row == null || !before.has(row._row) || seen.has(row._row)) { appended.push(vals); continue; }
      seen.add(row._row);
      const old = before.get(row._row);
      const set = {};
      t.cols.forEach((c, i) => { if (!same(old[i], vals[i])) set[t.cols[i]] = vals[i] == null ? null : String(vals[i]); });
      if (Object.keys(set).length) ops.push({ op: 'updateRows', table: t.name, rows: [row._row - t.R.r1], set });
    }
    const removed = t.rows.filter((x) => !seen.has(x.r)).map((x) => x.r - t.R.r1);
    if (removed.length) ops.push({ op: 'removeRows', table: t.name, rows: removed });
    if (appended.length) ops.push({ op: 'appendRows', table: t.name, rows: appended.map((v) => v.map((x) => (x == null ? null : String(x)))) });
    if (ops.length) (opsByDoc[t.doc] ||= []).push(...ops);
  }
  db.close();
  return { kind: 'write', changes: Number(info.changes), opsByDoc };
}
const same = (a, b) => (a == null && b == null) || String(a) === String(b);

/** Table -> array of objects (typed values). */
export function tableJson(doc, name) {
  const x = TYPES.sheet.findTable(doc, name);
  const en = new Engine(doc);
  const cols = uniq(TYPES.sheet.tableColumns(x.sh, x.R));
  const out = [];
  for (let r = x.R.r1 + 1; r <= x.R.r2; r++) {
    const o = {};
    cols.forEach((c, i) => { o[c] = cellValue(en, x.sh, x.R.c1 + i, r); });
    out.push(o);
  }
  return out;
}

/** Ops that make table `name` contain exactly `rows` (array of objects). Creates it at `at` if missing. */
export function jsonToOps(doc, name, rows, at) {
  if (!Array.isArray(rows)) throw Object.assign(new Error('rows must be a JSON array of objects'), { status: 400 });
  const cols = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
  const exists = TYPES.sheet.tables(doc).find((x) => x.t.name.toLowerCase() === String(name).toLowerCase());
  const str = (v) => (v == null ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));
  if (!exists) {
    if (!at) throw Object.assign(new Error(`Table "${name}" does not exist; give "at" (e.g. "Sheet1!B2") to create it`), { status: 400 });
    const [sheetPart, cell] = at.includes('!') ? [at.slice(0, at.lastIndexOf('!')), at.slice(at.lastIndexOf('!') + 1)] : [null, at];
    const m = /^([A-Za-z]+)(\d+)$/.exec(cell);
    if (!m) throw Object.assign(new Error(`Bad "at" ${at}`), { status: 400 });
    const values = [cols, ...rows.map((r) => cols.map((c) => str(r[c])))];
    const c1 = m[1].toUpperCase(), r1 = +m[2];
    const lastCol = colName(colIndex(c1) + Math.max(0, cols.length - 1));
    const sheetPrefix = sheetPart ? sheetPart + '!' : '';
    return [
      { op: 'set', range: at, values },
      { op: 'table', name, range: `${sheetPrefix}${c1}${r1}:${lastCol}${r1 + Math.max(1, rows.length)}` },
    ];
  }
  const ops = [];
  const have = TYPES.sheet.tableColumns(exists.sh, exists.R);
  for (const c of cols) if (!have.some((h) => h.toLowerCase() === c.toLowerCase())) ops.push({ op: 'addColumn', table: name, name: c });
  const n = exists.R.r2 - exists.R.r1;
  rows.slice(0, n).forEach((r, i) => ops.push({ op: 'updateRows', table: name, rows: [i + 1], set: Object.fromEntries(cols.map((c) => [c, str(r[c])])) }));
  if (rows.length < n) ops.push({ op: 'removeRows', table: name, rows: Array.from({ length: n - rows.length }, (_, i) => rows.length + 1 + i) });
  if (rows.length > n) ops.push({ op: 'appendRows', table: name, rows: rows.slice(n).map((r) => Object.fromEntries(cols.map((c) => [c, str(r[c])]))) });
  return ops;
}
function colIndex(n) { let c = 0; for (const ch of n) c = c * 26 + ch.charCodeAt(0) - 64; return c - 1; }
function colName(c) { let s = ''; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; }

export function formatResult(res, max = 200) {
  if (res.kind === 'write') return `ok, ${res.changes} row(s) affected`;
  const lines = [res.columns.join(' | ')];
  for (const r of res.rows.slice(0, max)) lines.push(r.map((v) => (v == null ? '∅' : String(v).replace(/\n/g, '⏎'))).join(' | '));
  if (res.rows.length > max) lines.push(`… ${res.rows.length - max} more rows`);
  lines.push(`(${res.rows.length} rows)`);
  return lines.join('\n');
}
