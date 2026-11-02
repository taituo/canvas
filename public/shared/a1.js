// A1 address helpers. Internal coordinates are 0-based {c, r}.

export function colToName(c) {
  let s = '';
  c += 1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}

export function nameToCol(n) {
  let c = 0;
  for (const ch of n.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}

export const addr = (c, r) => colToName(c) + (r + 1);

export function parseAddr(a) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(String(a).trim());
  if (!m || +m[2] < 1) return null;
  return { c: nameToCol(m[1]), r: +m[2] - 1 };
}

/** Split "Sheet!A1:B2" / "'My sheet'!A1" -> [sheetName|null, "A1:B2"] */
export function splitSheet(str) {
  str = String(str).trim();
  const i = str.lastIndexOf('!');
  if (i < 0) return [null, str];
  let sh = str.slice(0, i);
  if (sh.startsWith("'") && sh.endsWith("'")) sh = sh.slice(1, -1).replace(/''/g, "'");
  return [sh, str.slice(i + 1)];
}

/** "A1" | "A1:C9" | "C:D" | "3:5" -> normalized {c1,r1,c2,r2}. Open ends use maxR/maxC. */
export function parseRange(s, maxR = 1e6 - 1, maxC = 18277) {
  s = String(s).trim();
  const [a, b] = s.split(':');
  if (b === undefined) {
    const p = parseAddr(a);
    if (!p) return null;
    return { c1: p.c, r1: p.r, c2: p.c, r2: p.r };
  }
  const pa = parseAddr(a), pb = parseAddr(b);
  if (pa && pb) return norm({ c1: pa.c, r1: pa.r, c2: pb.c, r2: pb.r });
  if (/^[A-Za-z]{1,3}$/.test(a) && /^[A-Za-z]{1,3}$/.test(b))
    return norm({ c1: nameToCol(a), r1: 0, c2: nameToCol(b), r2: maxR });
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) return norm({ c1: 0, r1: +a - 1, c2: maxC, r2: +b - 1 });
  return null;
}

export function norm(R) {
  return {
    c1: Math.min(R.c1, R.c2), r1: Math.min(R.r1, R.r2),
    c2: Math.max(R.c1, R.c2), r2: Math.max(R.r1, R.r2),
  };
}

export function rangeToString(R) {
  const a = addr(R.c1, R.r1), b = addr(R.c2, R.r2);
  return a === b ? a : a + ':' + b;
}

export const inRange = (R, c, r) => c >= R.c1 && c <= R.c2 && r >= R.r1 && r <= R.r2;

export function quoteSheet(n) {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(n) && !/^[A-Za-z]{1,3}\d+$/.test(n)
    ? n : "'" + n.replace(/'/g, "''") + "'";
}

export const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
