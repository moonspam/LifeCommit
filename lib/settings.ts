import { filterLines, loadFilterText, FILTERS_STORAGE_KEY, LEGACY_FILTERS_KEY, LEGACY_MIGRATION_KEY, type KV } from "./filters";
/**
 * Settings stored in SQLite so they commit atomically with the rows they govern. The noise-filter text lives here:
 * a filter save (mass delete + new text), a restore and every reader (usage drain, processor) see one consistent state.
 * localStorage keeps a best-effort mirror only for seeding after a DB wipe (resetDatabase / corruption recovery).
 */
type Row = Record<string, unknown>;
interface Db {
  query(sql: string, values?: unknown[]): Promise<{ values?: Row[] }>;
  run(sql: string, params: unknown[], transaction?: boolean): Promise<unknown>;
}

export const NOISE_FILTER_SETTING = "noise_filters";

export async function readSetting(d: Pick<Db, "query">, key: string): Promise<string | null> {
  const v = (await d.query("SELECT value FROM app_settings WHERE key = ?", [key])).values?.[0]?.value;
  return typeof v === "string" ? v : null;
}

export async function writeSetting(d: Db, key: string, value: string) {
  await d.run("INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value], false);
}


/** In-memory KV so the legacy-upgrade logic (loadFilterText) never writes to localStorage inside a DB transaction. */
const memKV = (init: Record<string, string | null>): KV => {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(init)) if (v != null) m.set(k, v);
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

/**
 * Initialise/upgrade the noise-filter setting (call inside a transaction). The DB row is the source of truth:
 * row present -> localStorage is ignored, only newly added defaults are merged in; row absent (fresh install, or a
 * wiped DB) -> seeded from the localStorage mirror (current key, else legacy text cleaned as before), else defaults.
 * Returns the text; the caller mirrors it to localStorage after commit.
 */
export async function loadFilterSetting(d: Db, local: Pick<KV, "getItem"> | null, defaults: string): Promise<string> {
  const row = await readSetting(d, NOISE_FILTER_SETTING);
  const read = (k: string) => { try { return local?.getItem(k) ?? null; } catch { return null; } };
  const source = row != null
    ? memKV({ [FILTERS_STORAGE_KEY]: row })
    : memKV({ [FILTERS_STORAGE_KEY]: read(FILTERS_STORAGE_KEY), [LEGACY_FILTERS_KEY]: read(LEGACY_FILTERS_KEY), [LEGACY_MIGRATION_KEY]: read(LEGACY_MIGRATION_KEY) });
  const text = loadFilterText(source, defaults);
  if (text !== row) await writeSetting(d, NOISE_FILTER_SETTING, text);
  return text;
}

/** Filter save (call inside ONE transaction): delete history of the listed packages and store the new text together. */
export async function applyFilterSave(d: Db, text: string): Promise<{ commits: number; events: number }> {
  const pkgs = filterLines(text);
  let commits = 0, events = 0;
  if (pkgs.length > 0) {
    const ph = pkgs.map(() => "?").join(",");
    const c = (await d.run(`DELETE FROM commits WHERE app_package IN (${ph})`, pkgs, false)) as { changes?: { changes?: number } } | undefined;
    const e = (await d.run(`DELETE FROM raw_events WHERE app_package IN (${ph})`, pkgs, false)) as { changes?: { changes?: number } } | undefined;
    commits = c?.changes?.changes || 0;
    events = e?.changes?.changes || 0;
  }
  await writeSetting(d, NOISE_FILTER_SETTING, text);
  return { commits, events };
}
