import assert from "node:assert/strict";
import { openInitialised } from "./sqliteTestDb";
import { applyFilterSave, loadFilterSetting, readSetting, writeSetting, NOISE_FILTER_SETTING } from "./settings";
import { restoreBackup } from "./backupTables";
import { FILTERS_STORAGE_KEY, LEGACY_FILTERS_KEY } from "./filters";

type Row = Record<string, unknown>;
const DEFAULTS = "# --- 런처 ---\ncom.sec.android.app.launcher";
const local = (m: Record<string, string>) => ({ getItem: (k: string) => m[k] ?? null });

async function main() {
  // seeding: row present -> localStorage ignored (only defaults merged)
  {
    const { adapter } = await openInitialised();
    await writeSetting(adapter, NOISE_FILTER_SETTING, "com.from.db");
    const t = await loadFilterSetting(adapter, local({ [FILTERS_STORAGE_KEY]: "com.from.local" }), DEFAULTS);
    assert.ok(t.includes("com.from.db") && !t.includes("com.from.local") && t.includes("com.sec.android.app.launcher"));
    assert.equal(await readSetting(adapter, NOISE_FILTER_SETTING), t);
  }
  // row absent -> seeded from the v3 localStorage key
  {
    const { adapter } = await openInitialised();
    const t = await loadFilterSetting(adapter, local({ [FILTERS_STORAGE_KEY]: DEFAULTS + "\ncom.google.android.apps.maps" }), DEFAULTS);
    assert.ok(t.includes("com.google.android.apps.maps"), "deliberate maps entry from the mirror survives");
    assert.equal(await readSetting(adapter, NOISE_FILTER_SETTING), t);
  }
  // row absent, only legacy text without the marker -> cleaned
  {
    const { adapter } = await openInitialised();
    const t = await loadFilterText_legacy(adapter);
    assert.ok(!t.includes("com.google.android.apps.maps") && t.includes("com.example.mine"));
  }
  // nothing anywhere -> defaults
  {
    const { adapter } = await openInitialised();
    assert.equal(await loadFilterSetting(adapter, null, DEFAULTS), DEFAULTS);
  }

  // filter save is atomic with its mass delete: a failure before commit leaves rows AND the filter unchanged
  {
    const { d, adapter } = await openInitialised();
    await writeSetting(adapter, NOISE_FILTER_SETTING, "old.filter");
    d.prepare("INSERT INTO commits (id, branch_id, subject, started_at, ended_at, duration_sec, app_package, event_type, created_at) VALUES ('x',1,'s',1,1,1,'com.x','APP_USAGE',1)").run();
    d.exec("BEGIN");
    try { await applyFilterSave(adapter, "com.x"); throw new Error("commit failed"); } catch { d.exec("ROLLBACK"); }
    assert.equal(await readSetting(adapter, NOISE_FILTER_SETTING), "old.filter");
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM commits WHERE id='x'").get() as Row).n, 1);
    const r = await applyFilterSave(adapter, "com.x");
    assert.equal(r.commits, 1);
    assert.equal(await readSetting(adapter, NOISE_FILTER_SETTING), "com.x");
  }
  // restore + filter in one transaction: a failure mid-restore leaves the filter unchanged
  {
    const { d, adapter } = await openInitialised();
    await writeSetting(adapter, NOISE_FILTER_SETTING, "old.filter");
    const failing = { ...adapter, async run(sql: string, p: unknown[] = []) { if (sql.startsWith("UPDATE commits SET parent_id")) throw new Error("mid-restore failure"); return adapter.run(sql, p); } };
    const backup = { version: 4, branches: [{ id: 1, name: "main", color: "#1", created_at: 1 }], customFilters: "new.filter",
      commits: [{ id: "c", branch_id: 1, parent_id: "p", subject: "s", started_at: 2, ended_at: 2, duration_sec: 1, event_type: "manual", created_at: 1 },
                { id: "p", branch_id: 1, parent_id: null, subject: "s", started_at: 1, ended_at: 1, duration_sec: 1, event_type: "manual", created_at: 1 }] };
    d.exec("BEGIN");
    try { await writeSetting(failing, NOISE_FILTER_SETTING, "new.filter"); await restoreBackup(failing, backup); d.exec("COMMIT"); } catch { d.exec("ROLLBACK"); }
    assert.equal(await readSetting(adapter, NOISE_FILTER_SETTING), "old.filter");
    assert.equal((d.prepare("SELECT COUNT(*) AS n FROM commits").get() as Row).n, 0);
  }
  console.log("settings checks passed");
}

async function loadFilterText_legacy(adapter: Parameters<typeof loadFilterSetting>[0]) {
  return loadFilterSetting(adapter, local({ [LEGACY_FILTERS_KEY]: "# --- 네비게이션 / 차량 (백그라운드 지속 실행 노이즈) ---\ncom.google.android.apps.maps\ncom.example.mine" }), DEFAULTS);
}
main();
