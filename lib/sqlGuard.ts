/**
 * Allowlist for the read-only DB handle (getDB().query): one plain SELECT. A denylist on the first keyword was
 * bypassed by a leading comment (`/* x *\/ DELETE ... RETURNING`), so: strip leading whitespace and comments,
 * require SELECT, reject RETURNING / WITH (a CTE can wrap a write), and allow exactly one statement (an optional
 * trailing ';' only — no SQL in this app needs a ';' inside a SELECT).
 */
export function isPlainSelect(sql: string): boolean {
  let s = sql;
  for (;;) {
    const t = s.replace(/^\s+/, "");
    if (t.startsWith("--")) { const nl = t.indexOf("\n"); s = nl < 0 ? "" : t.slice(nl + 1); continue; }
    if (t.startsWith("/*")) { const e = t.indexOf("*/"); if (e < 0) return false; s = t.slice(e + 2); continue; }
    s = t;
    break;
  }
  if (!/^SELECT\b/i.test(s)) return false;
  if (s.replace(/;\s*$/, "").includes(";")) return false; // a second statement
  if (/\b(RETURNING|WITH)\b/i.test(s)) return false;
  return true;
}
