import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { createServer } from '../server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-'));
const store = new Store(dir).init();
const srv = createServer(store);
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${srv.address().port}`;
const get = (p) => fetch(base + p).then((r) => r.text());
const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
test.after(() => srv.close());

test('ops -> changes (text) with recalc, own edits excluded', async () => {
  await post('/api/ops', { by: 'user', ops: [{ op: 'set', sheet: 'Budjetti', cells: { B2: '10' } }] });
  await post('/api/ops', { by: 'agent', ops: [{ op: 'set', sheet: 'Budjetti', cells: { G1: 'x' } }] });
  const t = await get('/api/changes?since=0&exclude=agent');
  assert.match(t, /Budjetti!B2: 4 → 10/);
  assert.match(t, /calc: .*Budjetti!D2 50→125/);
  assert.doesNotMatch(t, /G1/);
});

test('expect -> 409 on conflict, batch is atomic', async () => {
  const r = await post('/api/ops', { expect: { 'Budjetti!B2': '4' }, ops: [{ op: 'set', sheet: 'Budjetti', cells: { B2: '5' } }] });
  assert.equal(r.status, 409);
  const bad = await post('/api/ops', { ops: [{ op: 'set', cells: { Z1: 'a' } }, { op: 'move', from: 'nope', to: 'A1' }] });
  assert.equal(bad.status, 400);
  assert.doesNotMatch(await get('/api/read?range=Z1:Z1'), /Z1 a/);
});

test('move is reported compactly and diff vs milestone is move-aware', async () => {
  await (await post('/api/commit', { message: 'base' })).json();
  await post('/api/ops', { by: 'user', ops: [{ op: 'move', sheet: 'Budjetti', from: 'A2:E5', to: 'A20' }] });
  await post('/api/ops', { by: 'user', ops: [{ op: 'set', sheet: 'Budjetti', cells: { B20: '7' } }] });
  const ch = await get('/api/changes?since=0&mode=net');
  assert.match(ch, /MOVE Budjetti!A2:E5 → A20:E23/);
  const d = await get('/api/diff?from=last');
  assert.match(d, /Budjetti!B20: 10 → 7/);
  assert.doesNotMatch(d, /A2: Servot → ∅/);
});

test('restore milestone', async () => {
  const r = await (await post('/api/restore', { commit: 'last' })).json();
  assert.ok(r.version > 0);
  assert.match(await get('/api/read?range=Budjetti!B2'), /B2 10/);
});

test('selection + read + find', async () => {
  await post('/api/selection', { doc: 'main', sheet: 'Budjetti', ranges: ['C23:D32'], active: 'C23' });
  assert.match(await get('/api/selection'), /Budjetti!C23:D32 active C23/);
  assert.match(await get('/api/find?q=raspberry'), /Budjetti!A3 Raspberry Pi/);
  assert.match(await get('/api/overview'), /Budjetti: used/);
});

test('tables over HTTP', async () => {
  await post('/api/ops', { by: 'user', ops: [{ op: 'updateRows', table: 'Tehtävät', key: 'Kytke servot', set: { Tila: 'valmis' } }] });
  assert.match(await get('/api/changes?since=0'), /⟨Tehtävät\[Kytke servot\]\.Tila⟩/);
  assert.match(await get('/api/read?range=@Tehtävät'), /Tehtävä: Kytke servot · Tila: valmis/);
  assert.match(await get('/api/overview'), /table Tehtävät B6:E10/);
});

test('text canvas', async () => {
  await post('/api/ops', { doc: 'notes', ops: [{ op: 'append', text: 'hei agentilta' }] });
  assert.match(await get('/api/read?doc=notes'), /hei agentilta/);
});
