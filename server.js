// Canvas Mini server. Zero dependencies: node:http + static files + REST + SSE.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, httpErr } from './lib/store.js';
import { TYPES } from './public/shared/types/index.js';
import { formatEntries, netChanges, formatRead, formatDiff, formatChangeList } from './lib/format.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = +(process.env.PORT || 3210);
const HOST = process.env.HOST || '127.0.0.1';
const DATA = path.resolve(process.env.CANVAS_DATA || path.join(ROOT, 'data'));

export function createServer(store) {
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown; charset=utf-8' };

  const send = (res, status, body, type) => {
    if (typeof body !== 'string') { body = JSON.stringify(body); type ||= 'application/json; charset=utf-8'; }
    res.writeHead(status, { 'content-type': type || 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    res.end(body);
  };
  const body = (req) => new Promise((ok, bad) => {
    let s = '';
    req.on('data', (d) => { s += d; if (s.length > 50e6) { bad(httpErr(413, 'Body too large')); req.destroy(); } });
    req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { bad(httpErr(400, 'Invalid JSON')); } });
  });
  const wantText = (u) => (u.searchParams.get('format') || 'text') === 'text';

  const routes = {
    'GET /api/help': (req, res) => send(res, 200, fs.readFileSync(path.join(ROOT, 'AGENT_SKILL.md'), 'utf8'), MIME['.md']),

    'GET /api/workspace': (req, res) => send(res, 200, {
      version: store.state.version, docs: store.docList(), commits: store.commits.slice(-50), selection: store.selection,
    }),

    'GET /api/overview': (req, res, u) => {
      const s = store.state;
      const lines = [`canvas-mini v${s.version}${store.commits.length ? ` · last milestone ${store.commits.at(-1).id} "${store.commits.at(-1).message}" (v${store.commits.at(-1).version})` : ''}`];
      for (const id of s.order) {
        const d = s.docs[id];
        const info = TYPES[d.type].describe(d);
        lines.push(`[${id}] ${d.type} "${d.title}"`);
        if (Array.isArray(info)) for (const sh of info) {
          lines.push(`  ${sh.name}: used ${sh.used ?? '-'} · ${sh.cells} cells · ${sh.formulas} formulas${sh.freeze.rows || sh.freeze.cols ? ` · frozen ${sh.freeze.rows}r/${sh.freeze.cols}c` : ''}`);
          if (sh.merges.length) lines.push(`    merged: ${sh.merges.slice(0, 20).join(', ')}${sh.merges.length > 20 ? ' …' : ''}`);
          for (const t of sh.tables) lines.push(`    table ${t.name} ${t.range} · ${t.rows} rows · [${t.columns.join(' | ')}]`);
        }
        else lines.push(`  ${info.lines} lines`);
      }
      if (store.selection) lines.push(`user selection: [${store.selection.doc}] ${store.selection.sheet}!${store.selection.ranges.join(',')} (active ${store.selection.active})`);
      wantText(u) ? send(res, 200, lines.join('\n')) : send(res, 200, { version: s.version, docs: s.order.map((id) => ({ id, type: s.docs[id].type, title: s.docs[id].title, info: TYPES[s.docs[id].type].describe(s.docs[id]) })), selection: store.selection });
    },

    'GET /api/doc': (req, res, u) => send(res, 200, { version: store.state.version, doc: store.doc(u.searchParams.get('id')) }),

    'POST /api/docs': async (req, res) => { const b = await body(req); const e = store.createDoc({ type: b.type || 'sheet', title: b.title, id: b.id, by: b.by || 'agent' }); send(res, 200, { version: e.v, id: e.doc }); },
    'DELETE /api/docs': (req, res, u) => { const e = store.deleteDoc(u.searchParams.get('id'), u.searchParams.get('by') || 'user'); send(res, 200, { version: e.v }); },
    'PATCH /api/docs': async (req, res, u) => { const b = await body(req); const e = store.renameDoc(u.searchParams.get('id') || b.id, b.title, b.by || 'user'); send(res, 200, { version: e.v }); },

    'POST /api/ops': async (req, res, u) => {
      const b = await body(req);
      const e = store.batch({ doc: b.doc, by: b.by || 'agent', clientId: b.clientId, ops: b.ops || (b.op ? [b] : null), expect: b.expect, label: b.label });
      if (u.searchParams.get('format') === 'text') return send(res, 200, [`ok v${e.v}`, ...formatChangeList(e.changes, e.recalc)].join('\n'));
      send(res, 200, { version: e.v, changes: e.changes, recalc: e.recalc, inverse: b.wantInverse ? e.inverse : undefined });
    },

    'GET /api/changes': (req, res, u) => {
      const p = u.searchParams;
      const r = store.changes({ since: +(p.get('since') || 0), doc: p.get('doc'), exclude: p.get('exclude'), by: p.get('by'), limit: +(p.get('limit') || 200) });
      if (p.get('mode') === 'net') return send(res, 200, netChanges(r));
      wantText(u) ? send(res, 200, formatEntries(r)) : send(res, 200, r);
    },

    'GET /api/read': (req, res, u) => {
      const d = store.doc(u.searchParams.get('doc'));
      const T = TYPES[d.type];
      const r = T.read(d, u.searchParams.get('range') || '', { limit: +(u.searchParams.get('limit') || 400) });
      wantText(u) ? send(res, 200, `v${store.state.version} ` + formatRead(r)) : send(res, 200, { version: store.state.version, ...r });
    },

    'GET /api/find': (req, res, u) => {
      const d = store.doc(u.searchParams.get('doc'));
      if (d.type !== 'sheet') throw httpErr(400, 'find works on sheet docs');
      const hits = TYPES.sheet.find(d, u.searchParams.get('q') || '');
      wantText(u) ? send(res, 200, hits.map((h) => `${h.at} ${h.raw}${h.raw !== h.value ? ' ⇒ ' + h.value : ''}`).join('\n') || 'no matches') : send(res, 200, hits);
    },

    'GET /api/commits': (req, res, u) => wantText(u)
      ? send(res, 200, store.commits.map((c) => `${c.id} v${c.version} ${c.by} ${new Date(c.ts).toISOString().slice(0, 16)} "${c.message}"`).join('\n') || 'no milestones')
      : send(res, 200, store.commits),
    'POST /api/commit': async (req, res) => { const b = await body(req); send(res, 200, store.commit({ message: b.message, by: b.by || 'agent' })); },
    'GET /api/diff': (req, res, u) => {
      const d = store.diff({ from: u.searchParams.get('from') || 'last', doc: u.searchParams.get('doc') });
      wantText(u) ? send(res, 200, formatDiff(d)) : send(res, 200, d);
    },
    'POST /api/restore': async (req, res) => { const b = await body(req); send(res, 200, store.restore({ commit: b.commit, doc: b.doc, by: b.by || 'user' })); },

    'GET /api/selection': (req, res, u) => {
      const s = store.selection;
      if (!wantText(u)) return send(res, 200, s || {});
      send(res, 200, s ? `[${s.doc}] ${s.sheet}!${s.ranges.join(',')} active ${s.active}` : 'no selection');
    },
    'POST /api/selection': async (req, res) => {
      const b = await body(req);
      store.selection = { doc: b.doc, sheet: b.sheet, ranges: b.ranges || [], active: b.active, ts: Date.now() };
      send(res, 200, { ok: true });
    },
    'POST /api/focus': async (req, res) => {
      const b = await body(req);
      store.emit({ type: 'focus', by: b.by || 'agent', doc: b.doc || store.state.order[0], sheet: b.sheet, range: b.range, label: b.label });
      send(res, 200, { ok: true });
    },

    'GET /api/events': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', version: store.state.version })}\n\n`);
      const off = store.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => { off(); clearInterval(ping); });
    },
  };

  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE', 'access-control-allow-headers': 'content-type' });
        return res.end();
      }
      const h = routes[`${req.method} ${u.pathname}`];
      if (h) return await h(req, res, u);
      if (u.pathname.startsWith('/api/')) throw httpErr(404, `No route ${req.method} ${u.pathname}. See GET /api/help`);
      // static
      let p = path.normalize(decodeURIComponent(u.pathname)).replace(/^(\.\.[/\\])+/, '');
      if (p === '/' || p === '\\') p = '/index.html';
      const f = path.join(PUBLIC, p);
      if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) throw httpErr(404, 'Not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-cache' });
      fs.createReadStream(f).pipe(res);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      if (!res.headersSent) send(res, status, { error: e.message, ...(e.extra || {}) });
      else res.end();
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const store = new Store(DATA).init();
  const srv = createServer(store);
  srv.listen(PORT, HOST, () => {
    console.log(`canvas-mini  http://${HOST}:${PORT}   data: ${DATA}`);
    if (HOST !== '127.0.0.1' && HOST !== 'localhost') console.warn('WARNING: no auth. Do not expose to untrusted networks.');
  });
  const bye = () => { store.flush(); process.exit(0); };
  process.on('SIGINT', bye);
  process.on('SIGTERM', bye);
}
