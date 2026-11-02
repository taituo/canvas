// Formula tokenizer, parser and reference rewriting. No eval().
import { nameToCol, colToName, quoteSheet } from './a1.js';

export class FErr {
  constructor(code, msg) { this.code = code; this.msg = msg; }
  toString() { return this.code; }
}
export const isErr = (v) => v instanceof FErr;
export const E = {
  REF: '#REF!', DIV0: '#DIV/0!', NAME: '#NAME?', VALUE: '#VALUE!', NA: '#N/A',
  NUM: '#NUM!', CYCLE: '#CYCLE!', PARSE: '#ERROR!',
};

const SHEET = String.raw`(?:'(?:[^']|'')+'|[\p{L}_][\p{L}\p{N}_.]*)!`;
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d+`;
const REF_RE = new RegExp(`^(?:${SHEET})?${CELL}(?::${CELL})?`, 'u');
const FULL_RE = new RegExp(String.raw`^(?:${SHEET})?(?:\$?[A-Za-z]{1,3}:\$?[A-Za-z]{1,3}|\$?\d+:\$?\d+)`, 'u');
export const MAXR = 999999, MAXC = 18277;
const TAIL_RE = /^[\p{L}\p{N}_.(!]/u;

export function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const s = src.slice(i);
    let m, t;
    if ((m = /^\s+/.exec(s))) t = 'ws';
    else if ((m = /^"(?:[^"]|"")*"/.exec(s))) t = 'str';
    else if ((m = /^#(?:REF!|DIV\/0!|NAME\?|VALUE!|N\/A|NUM!|CYCLE!|ERROR!)/i.exec(s))) t = 'err';
    else if ((m = /^[\p{L}_][\p{L}\p{N}_.]*\[[^\]\n]*\]/u.exec(s))) t = 'tref';
    else if ((m = FULL_RE.exec(s)) && !TAIL_RE.test(s.slice(m[0].length))) t = 'ref';
    else if ((m = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(s))) t = 'num';
    else if ((m = REF_RE.exec(s)) && !TAIL_RE.test(s.slice(m[0].length))) t = 'ref';
    else if ((m = /^[\p{L}_][\p{L}\p{N}_.]*/u.exec(s))) t = 'id';
    else if ((m = /^(?:<>|<=|>=|[-+*/^&=<>%:])/.exec(s))) t = 'op';
    else if ((m = /^[(),;]/.exec(s))) t = 'p';
    else { m = [s[0]]; t = 'bad'; }
    out.push({ t, v: m[0], i });
    i += m[0].length;
  }
  return out;
}

function cellPart(s) {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(s);
  return { c: nameToCol(m[2]), r: +m[4] - 1, ac: !!m[1], ar: !!m[3] };
}

export function parseRefText(txt) {
  let sheet = null, rest = txt;
  const bang = txt.lastIndexOf('!');
  if (bang >= 0) {
    let sh = txt.slice(0, bang);
    if (sh.startsWith("'")) sh = sh.slice(1, -1).replace(/''/g, "'");
    sheet = sh;
    rest = txt.slice(bang + 1);
  }
  const [a, b] = rest.split(':');
  if (b !== undefined && /^\$?[A-Za-z]+$/.test(a)) {
    return { sheet, full: 'col', a: { c: nameToCol(a.replace('$', '')), r: 0, ac: a[0] === '$', ar: false }, b: { c: nameToCol(b.replace('$', '')), r: MAXR, ac: b[0] === '$', ar: false } };
  }
  if (b !== undefined && /^\$?\d+$/.test(a)) {
    return { sheet, full: 'row', a: { c: 0, r: +a.replace('$', '') - 1, ac: false, ar: a[0] === '$' }, b: { c: MAXC, r: +b.replace('$', '') - 1, ac: false, ar: b[0] === '$' } };
  }
  return { sheet, a: cellPart(a), b: b ? cellPart(b) : null };
}

const partText = (p) => (p.ac ? '$' : '') + colToName(p.c) + (p.ar ? '$' : '') + (p.r + 1);
export function refToText(ref) {
  const pre = ref.sheet != null ? quoteSheet(ref.sheet) + '!' : '';
  if (ref.full === 'col') return pre + (ref.a.ac ? '$' : '') + colToName(ref.a.c) + ':' + (ref.b.ac ? '$' : '') + colToName(ref.b.c);
  if (ref.full === 'row') return pre + (ref.a.ar ? '$' : '') + (ref.a.r + 1) + ':' + (ref.b.ar ? '$' : '') + (ref.b.r + 1);
  return pre + partText(ref.a) + (ref.b ? ':' + partText(ref.b) : '');
}

/** Bounding box of a ref (normalized). */
export function refBox(ref) {
  const b = ref.b || ref.a;
  return {
    c1: Math.min(ref.a.c, b.c), r1: Math.min(ref.a.r, b.r),
    c2: Math.max(ref.a.c, b.c), r2: Math.max(ref.a.r, b.r),
  };
}

/**
 * Rewrite every reference in a formula. fn(ref) returns:
 *   undefined -> unchanged, null -> #REF!, object -> new ref
 */
export function transformFormula(text, fn) {
  if (typeof text !== 'string' || text[0] !== '=') return text;
  const toks = tokenize(text.slice(1));
  let changed = false;
  for (const t of toks) {
    if (t.t !== 'ref') continue;
    const orig = parseRefText(t.v);
    let out = fn(orig);
    if (out === undefined) continue;
    if (out && orig.full === 'col') out = { ...out, full: 'col', a: { ...out.a, r: 0 }, b: { ...out.b, r: MAXR } };
    if (out && orig.full === 'row') out = { ...out, full: 'row', a: { ...out.a, c: 0 }, b: { ...out.b, c: MAXC } };
    if (out && (out.a.c < 0 || out.a.r < 0 || (out.b && (out.b.c < 0 || out.b.r < 0)))) out = null;
    const nv = out === null ? '#REF!' : refToText(out);
    if (nv !== t.v) { t.v = nv; changed = true; }
  }
  return changed ? '=' + toks.map((t) => t.v).join('') : text;
}

/** Rename structured references Old[Col] -> New[Col]. */
export function renameTableRefs(text, oldName, newName) {
  if (typeof text !== 'string' || text[0] !== '=') return text;
  const toks = tokenize(text.slice(1));
  let changed = false;
  for (const t of toks) {
    if (t.t !== 'tref') continue;
    const i = t.v.indexOf('[');
    if (t.v.slice(0, i).toLowerCase() === oldName.toLowerCase()) { t.v = newName + t.v.slice(i); changed = true; }
  }
  return changed ? '=' + toks.map((t) => t.v).join('') : text;
}

/** Copy/fill semantics: shift relative parts by (dr, dc). */
export function shiftFormula(text, dr, dc) {
  return transformFormula(text, (ref) => {
    const mv = (p) => ({ ...p, r: p.ar || ref.full === 'col' ? p.r : p.r + dr, c: p.ac || ref.full === 'row' ? p.c : p.c + dc });
    return { ...ref, a: mv(ref.a), b: ref.b ? mv(ref.b) : null };
  });
}

/** List refs with character spans (for editor highlighting). */
export function refSpans(text) {
  if (typeof text !== 'string' || text[0] !== '=') return [];
  return tokenize(text.slice(1)).filter((t) => t.t === 'ref')
    .map((t) => ({ start: t.i + 1, end: t.i + 1 + t.v.length, ref: parseRefText(t.v) }));
}

// ---------------- Parser (Pratt) ----------------
const BIN = {
  '=': [1, 2], '<>': [1, 2], '<': [1, 2], '>': [1, 2], '<=': [1, 2], '>=': [1, 2],
  '&': [3, 4], '+': [5, 6], '-': [5, 6], '*': [7, 8], '/': [7, 8], '^': [9, 9],
};

export function parse(src) {
  const toks = tokenize(src).filter((t) => t.t !== 'ws');
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const fail = (m) => { throw new FErr(E.PARSE, m); };

  function expr(minBp) {
    let left = prefix();
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'op') break;
      if (t.v === '%') { if (11 < minBp) break; next(); left = { k: 'pct', e: left }; continue; }
      const bp = BIN[t.v];
      if (!bp || bp[0] < minBp) break;
      next();
      left = { k: 'bin', op: t.v, l: left, r: expr(bp[1]) };
    }
    return left;
  }

  function prefix() {
    const t = next();
    if (!t) fail('unexpected end');
    switch (t.t) {
      case 'num': return { k: 'num', v: parseFloat(t.v) };
      case 'str': return { k: 'str', v: t.v.slice(1, -1).replace(/""/g, '"') };
      case 'err': return { k: 'err', v: t.v.toUpperCase() };
      case 'ref': return { k: 'ref', ref: parseRefText(t.v) };
      case 'tref': { const i = t.v.indexOf('['); return { k: 'tref', table: t.v.slice(0, i), col: t.v.slice(i + 1, -1).trim() }; }
      case 'id': {
        if (peek() && peek().v === '(') {
          next();
          const args = [];
          if (peek() && peek().v === ')') { next(); return { k: 'call', name: t.v.toUpperCase(), args }; }
          for (;;) {
            const q = peek();
            if (q && (q.v === ',' || q.v === ';' || q.v === ')')) args.push({ k: 'empty' });
            else args.push(expr(0));
            const s = next();
            if (!s) fail('missing )');
            if (s.v === ')') break;
            if (s.v !== ',' && s.v !== ';') fail('expected , or )');
          }
          return { k: 'call', name: t.v.toUpperCase(), args };
        }
        const u = t.v.toUpperCase();
        if (u === 'TRUE' || u === 'FALSE') return { k: 'bool', v: u === 'TRUE' };
        return { k: 'name', v: t.v };
      }
      case 'p':
        if (t.v === '(') {
          const e = expr(0);
          const c = next();
          if (!c || c.v !== ')') fail('missing )');
          return e;
        }
        break;
      case 'op':
        if (t.v === '-' || t.v === '+') return { k: t.v === '-' ? 'neg' : 'pos', e: expr(10) };
        break;
    }
    fail('unexpected ' + t.v);
  }

  const ast = expr(0);
  if (p < toks.length) fail('unexpected ' + toks[p].v);
  return ast;
}

/** Literal (non-formula) cell input -> value. */
export function literal(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw);
  if (s[0] === "'") return s.slice(1);
  const t = s.trim();
  if (/^[-+]?(\d+([.,]\d+)?|[.,]\d+)([eE][-+]?\d+)?$/.test(t)) return parseFloat(t.replace(',', '.'));
  if (/^[-+]?\d+([.,]\d+)?%$/.test(t)) return parseFloat(t.replace(',', '.')) / 100;
  if (/^true$/i.test(t)) return true;
  if (/^false$/i.test(t)) return false;
  return s;
}

/** Add missing closing parens (Sheets does this on Enter). */
export function autoClose(text) {
  if (typeof text !== 'string' || text[0] !== '=') return text;
  let depth = 0;
  for (const t of tokenize(text.slice(1))) {
    if (t.v === '(') depth++;
    else if (t.v === ')') depth--;
  }
  return depth > 0 ? text + ')'.repeat(depth) : text;
}
