#!/usr/bin/env node
// cm — tiny CLI for agents. Text output, remembers a cursor so `cm changes` only shows what's new.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.CANVAS_URL || 'http://127.0.0.1:3210').replace(/\/$/, '');
const CURSOR = process.env.CM_CURSOR || path.join(os.homedir(), '.canvas-mini-cursor');
const DOC = process.env.CM_DOC || '';
const BY = process.env.CM_BY || 'agent';

const [cmd, ...args] = process.argv.slice(2);
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')).toString();

async function call(method, p, body) {
  const r = await fetch(BASE + p, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  if (!r.ok) { console.error(`HTTP ${r.status}: ${t}`); process.exit(1); }
  return t;
}
const readCursor = () => { try { return +fs.readFileSync(CURSOR, 'utf8').trim() || 0; } catch { return 0; } };
const writeCursor = (v) => fs.writeFileSync(CURSOR, String(v));
const out = (t) => process.stdout.write(t.endsWith('\n') ? t : t + '\n');

/** Parse "A1=val" pairs; values beginning with = are formulas. */
function pairs(list) {
  const cells = {};
  for (const a of list) {
    const i = a.indexOf('=');
    if (i <= 0) { console.error(`expected CELL=value, got "${a}"`); process.exit(2); }
    cells[a.slice(0, i)] = a.slice(i + 1);
  }
  return cells;
}
async function ops(list, extra = {}) {
  out(await call('POST', '/api/ops?format=text', { doc: DOC || undefined, by: BY, ops: list, ...extra }));
}

const help = `cm — canvas-mini agent CLI   (CANVAS_URL=${BASE})
  cm overview                      docs, sheets, used ranges, user selection
  cm read [Sheet!A1:F20]           non-empty cells with formulas ⇒ values
  cm changes [--all] [--net]       what changed since your cursor (default: excludes your own edits)
  cm sel                           what the user has selected right now
  cm set A1=10 B1==A1*2 'Data!C3=hello'
  cm table B2 '[["a",1],["b",2]]'  write a 2D block anchored at B2
  cm move C23:D32 F23              cut/paste, references follow
  cm insert-rows 5 [n] | delete-rows 5 [n] | insert-cols C [n] | delete-cols C [n]   (add --sheet=Name)
  cm fmt A1:E1 '{"b":true,"fill":"#fff2cc"}'
  cm border A1:C3 outer [thick] ['#d93025']   all|inner|horizontal|vertical|outer|left|top|right|bottom|clear
  cm merge A1:C1 [all|horizontal|vertical] | cm unmerge A1:C1
  cm note B2 "text"
  cm add-sheet Name | rename-sheet Old New
  cm read @Tehtävät                 a named table as records:  [5] Nimi: Servot · Tila: auki
  cm mktable Tehtävät B4:E9        name a region (header row first) as a table
  cm add Tehtävät '{"Nimi":"Akku","Tila":"auki"}' ['{...}']    append records
  cm update Tehtävät Servot Tila=valmis Vastuu=Isi             key = first-column value (or 'Tila=auki' to match)
  cm rm Tehtävät Servot | cm rm Tehtävät 'Tila=valmis'
  cm addcol Tehtävät Huom
  cm find text
  cm commit "message" | cm commits | cm diff [m3|last] | cm restore m3
  cm focus A1:B5 "label"           highlight where you're working
  cm ops '<json array of ops>'     raw batch
  cm cursor [N]                    show / set cursor
Env: CM_DOC (default first doc), CM_BY (default agent), CM_CURSOR`;

const sheetFlag = () => { const i = args.findIndex((a) => a.startsWith('--sheet=')); if (i < 0) return undefined; const v = args[i].slice(8); args.splice(i, 1); return v; };

switch (cmd) {
  case 'overview': out(await call('GET', '/api/overview')); break;
  case 'read': out(await call('GET', '/api/read?' + qs({ doc: DOC, range: args[0] }))); break;
  case 'sel': case 'selection': out(await call('GET', '/api/selection')); break;
  case 'changes': {
    const all = args.includes('--all'), net = args.includes('--net');
    const since = readCursor();
    const t = await call('GET', '/api/changes?' + qs({ since, doc: DOC, exclude: all ? '' : BY, mode: net ? 'net' : '' }));
    out(t);
    const m = /cursor: (\d+)\s*$/.exec(t);
    // advance to latest version even when our own edits were filtered out
    const v = JSON.parse(await call('GET', '/api/workspace')).version;
    writeCursor(Math.max(m ? +m[1] : since, v));
    break;
  }
  case 'cursor': if (args[0]) writeCursor(+args[0]); out(String(readCursor())); break;
  case 'set': await ops([{ op: 'set', cells: pairs(args) }]); break;
  case 'table': await ops([{ op: 'set', range: args[0], values: JSON.parse(args[1]) }]); break;
  case 'move': await ops([{ op: 'move', from: args[0], to: args[1] }]); break;
  case 'insert-rows': case 'delete-rows': case 'insert-cols': case 'delete-cols': {
    const sheet = sheetFlag();
    const op = { 'insert-rows': 'insertRows', 'delete-rows': 'deleteRows', 'insert-cols': 'insertCols', 'delete-cols': 'deleteCols' }[cmd];
    await ops([{ op, sheet, at: /^\d+$/.test(args[0]) ? +args[0] : args[0], count: +(args[1] || 1) }]);
    break;
  }
  case 'fmt': case 'format': await ops([{ op: 'format', range: args[0], style: JSON.parse(args[1]) }]); break;
  case 'border': case 'borders': await ops([{ op: 'borders', range: args[0], type: args[1] || 'all', style: args[2], color: args[3] }]); break;
  case 'merge': await ops([{ op: 'merge', range: args[0], type: args[1] || 'all' }]); break;
  case 'unmerge': await ops([{ op: 'unmerge', range: args[0] }]); break;
  case 'note': await ops([{ op: 'note', cell: args[0], text: args.slice(1).join(' ') || null }]); break;
  case 'add-sheet': await ops([{ op: 'addSheet', name: args[0] }]); break;
  case 'rename-sheet': await ops([{ op: 'renameSheet', sheet: args[0], name: args[1] }]); break;
  case 'mktable': await ops([{ op: 'table', name: args[0], range: args[1] }]); break;
  case 'add': await ops([{ op: 'appendRows', table: args[0], rows: args.slice(1).map((a) => JSON.parse(a)) }]); break;
  case 'update': case 'rm': {
    const sel = args[1].includes('=') ? { match: pairs([args[1]]) } : { key: args[1] };
    if (cmd === 'update') await ops([{ op: 'updateRows', table: args[0], ...sel, set: pairs(args.slice(2)) }]);
    else await ops([{ op: 'removeRows', table: args[0], ...sel }]);
    break;
  }
  case 'addcol': await ops([{ op: 'addColumn', table: args[0], name: args[1] }]); break;
  case 'find': out(await call('GET', '/api/find?' + qs({ doc: DOC, q: args.join(' ') }))); break;
  case 'commit': out(await call('POST', '/api/commit', { message: args.join(' '), by: BY })); break;
  case 'commits': out(await call('GET', '/api/commits')); break;
  case 'diff': out(await call('GET', '/api/diff?' + qs({ from: args[0] || 'last', doc: DOC }))); break;
  case 'restore': out(await call('POST', '/api/restore', { commit: args[0], doc: DOC || undefined, by: BY })); break;
  case 'focus': await call('POST', '/api/focus', { doc: DOC || undefined, range: args[0], label: args.slice(1).join(' '), by: BY }); out('ok'); break;
  case 'ops': await ops(JSON.parse(args[0])); break;
  default: out(help);
}
