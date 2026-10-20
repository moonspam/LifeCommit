/** 7-char display hash. UUID/hex ids pass through; other formats (us:<pkg>:<ms>, commit_m_<ms>_x) are hashed so the column stays unique. */
export function displayHash(id: string): string {
  if (!id) return "0000000";
  if (/^[0-9a-f]{7}/i.test(id)) return id.slice(0, 7);
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 7);
}
