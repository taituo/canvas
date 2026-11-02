// Text canvas: the smallest possible second canvas type. Proves the plugin shape.
export const type = 'text';

export function create(title) { return { type, title: title || 'Notes', text: '' }; }

export function apply(st, op) {
  if (op.op === 'setText' || op.op === 'append') {
    const old = st.text;
    st.text = op.op === 'append' ? old + (old && !old.endsWith('\n') ? '\n' : '') + String(op.text) : String(op.text ?? '');
    return { inverse: [{ op: 'setText', text: old }], changes: diff({ text: old }, st) };
  }
  if (op.op === 'replaceAll') {
    const old = st.text;
    st.text = op.text;
    return { inverse: [{ op: 'setText', text: old }], changes: diff({ text: old }, st) };
  }
  throw new Error(`Unknown text op "${op.op}"`);
}

/** Line diff (LCS, capped) -> [{k:'text', line, old, new}] */
export function diff(a, b) {
  const A = (a.text || '').split('\n'), B = (b.text || '').split('\n');
  if (a.text === b.text) return [];
  let s = 0;
  while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length, eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const out = [];
  const n = Math.max(ea - s, eb - s);
  for (let i = 0; i < n && out.length < 200; i++) {
    out.push({ k: 'text', line: s + i + 1, old: A[s + i] ?? null, new: B[s + i] ?? null });
  }
  return out;
}

export function describe(st) {
  return { lines: st.text ? st.text.split('\n').length : 0, chars: st.text.length };
}

export function read(st, range) {
  const lines = st.text.split('\n');
  let a = 1, b = lines.length;
  const m = /^(\d+)(?:[-:](\d+))?$/.exec(range || '');
  if (m) { a = +m[1]; b = m[2] ? +m[2] : a; }
  return { lines: lines.slice(a - 1, b).map((t, i) => ({ n: a + i, t })) };
}
