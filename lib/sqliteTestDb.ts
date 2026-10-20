/** Test-only helpers (used by *.check.ts): a real node:sqlite DB that executes schema SQL the way the Android plugin does. */
// @ts-expect-error node:sqlite typings need @types/node >= 22 (runtime is Node 24)
import { DatabaseSync } from "node:sqlite";
import type { InitDb } from "./schemaInit";
import { initSchema } from "./schemaInit";

type Row = Record<string, unknown>;

/** Mirrors UtilsSQLite.getStatementsArray: split on ";\n", drop `--` comments, join lines. Each chunk must be ONE statement. */
export function pluginSplit(sql: string): string[] {
  return sql
    .replace(/end;/g, "END;")
    .split(";\n")
    .map((chunk) => chunk.split("\n").map((l) => { const i = l.indexOf("--"); return (i > -1 ? l.slice(0, i) : l).trim(); }).filter(Boolean).join(" "))
    .filter((c) => c.trim().length > 0);
}

export function openRaw() {
  const d = new DatabaseSync(":memory:");
  d.exec("PRAGMA foreign_keys = ON;");
  const deviceExec = (sql: string) => {
    for (const chunk of pluginSplit(sql)) {
      const body = chunk.replace(/;\s*$/, "");
      if (body.includes(";")) throw new Error(`more than one statement in an execute() chunk (the plugin would drop some): ${body.slice(0, 80)}`);
      d.exec(body);
    }
  };
  let inTx = false;
  const adapter = {
    async query(sql: string, v: unknown[] = []) { return { values: (d.prepare(sql).all(...(v as never[])) as Row[]).map((r) => ({ ...r })) }; },
    async run(sql: string, v: unknown[] = []) { const r = d.prepare(sql).run(...(v as never[])); return { changes: { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) } }; }, // same shape as the Capacitor plugin
    async execute(sql: string) { deviceExec(sql); },
    async isTransactionActive() { return { result: inTx }; },
    async beginTransaction() { d.exec("BEGIN"); inTx = true; },
    async commitTransaction() { d.exec("COMMIT"); inTx = false; },
    async rollbackTransaction() { d.exec("ROLLBACK"); inTx = false; },
  };
  return { d, adapter, deviceExec };
}

/** Fresh DB initialised exactly like the app (initSchema). */
export async function openInitialised() {
  const r = openRaw();
  await initSchema(r.adapter);
  return r;
}
