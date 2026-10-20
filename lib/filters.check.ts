import assert from "node:assert/strict";
import { filterLines, loadFilterText, removeRetiredDefaults, writeFilterText, FILTERS_STORAGE_KEY, LEGACY_FILTERS_KEY, LEGACY_MIGRATION_KEY, RETIRED_DEFAULT_PACKAGES } from "./filters";

const old = ["# --- 런처 ---", "com.sec.android.app.launcher", "", "# --- 네비게이션 / 차량 (백그라운드 지속 실행 노이즈) ---",
  "com.google.android.projection.gearhead", "com.skt.tmap.ku", "com.locnall.KimGiSa", "com.nhn.android.nmap", "com.google.android.apps.maps",
  "", "# my own", "com.example.private"].join("\n");
const cleaned = removeRetiredDefaults(old);
assert.deepEqual(filterLines(cleaned), ["com.sec.android.app.launcher", "com.example.private"]);
assert.ok(!cleaned.includes("네비게이션"));
assert.ok(cleaned.includes("# my own"));
assert.equal(removeRetiredDefaults(cleaned), cleaned); // idempotent
for (const p of RETIRED_DEFAULT_PACKAGES) assert.ok(!filterLines(cleaned).includes(p));

// storage paths (Map-backed fake localStorage)
const mem = () => { const m = new Map<string, string>(); return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };
const MAPS = "com.google.android.apps.maps";
const DEFAULTS = "# --- 런처 ---\ncom.sec.android.app.launcher";
{ // 1. fresh install -> user saves maps -> relaunch: maps stays
  const st = mem();
  const first = loadFilterText(st, DEFAULTS);
  assert.equal(st.getItem(FILTERS_STORAGE_KEY), DEFAULTS, "fresh defaults are written to the current key");
  st.setItem(FILTERS_STORAGE_KEY, first + "\n" + MAPS); // even a plain write of the text (any writer) must not be re-migrated
  assert.ok(filterLines(loadFilterText(st, DEFAULTS)).includes(MAPS), "fresh install keeps a deliberate maps entry");
}
{ // 2. empty storage -> v3 restore with maps -> launch: maps stays
  const st = mem();
  writeFilterText(st, DEFAULTS + "\n" + MAPS);
  assert.ok(filterLines(loadFilterText(st, DEFAULTS)).includes(MAPS), "v3 restore keeps a deliberate maps entry");
}
{ // 3. legacy text without the marker: retired packages stripped once, second load is a no-op
  const st = mem();
  st.setItem(LEGACY_FILTERS_KEY, old);
  const once = loadFilterText(st, DEFAULTS);
  for (const p of RETIRED_DEFAULT_PACKAGES) assert.ok(!filterLines(once).includes(p));
  assert.equal(loadFilterText(st, DEFAULTS), once);
}
{ // 4. a newly added default is merged in
  const st = mem();
  writeFilterText(st, "com.example.private");
  assert.ok(filterLines(loadFilterText(st, DEFAULTS)).includes("com.sec.android.app.launcher"));
}
{ // 5. reviewer scenario: storage without the format marker, save succeeds for the text but the 2nd write fails -> next load keeps maps
  const st = mem();
  let writes = 0;
  const flaky = { getItem: st.getItem, setItem: (k: string, v: string) => { if (++writes === 2) throw new Error("quota"); st.setItem(k, v); } };
  try { writeFilterText(flaky, DEFAULTS + "\n" + MAPS); } catch {}
  assert.ok(filterLines(loadFilterText(st, DEFAULTS)).includes(MAPS), "half-written save must not be re-migrated");
}
{ // 6. legacy text WITH the marker (already cleaned by an older build) is copied as-is: a deliberate maps entry survives
  const st = mem();
  st.setItem(LEGACY_FILTERS_KEY, DEFAULTS + "\n" + MAPS);
  st.setItem(LEGACY_MIGRATION_KEY, "1");
  assert.ok(filterLines(loadFilterText(st, DEFAULTS)).includes(MAPS));
}
{ // 7. the user cleared the filter (current key ""): legacy text must not come back; defaults are merged in
  const st = mem();
  st.setItem(LEGACY_FILTERS_KEY, "com.example.legacy");
  st.setItem(FILTERS_STORAGE_KEY, "");
  const t = loadFilterText(st, DEFAULTS);
  assert.ok(!t.includes("com.example.legacy"));
  assert.ok(filterLines(t).includes("com.sec.android.app.launcher"));
}
console.log("filter checks passed");
