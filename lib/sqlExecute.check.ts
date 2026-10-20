import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// The Android SQLite plugin splits execute() input only on ";\n" (UtilsSQLite.getStatementsArray). Several statements
// on ONE line reach SQLite as one string and the last one is silently dropped (seen on device: `reset db confirm` left
// commit_tombstones untouched while reporting success). Run statements one by one with run() instead.
const ONE_LINE_MULTI = /\.execute\(\s*(["'`])[^"'`\n]*;\s*\S[^"'`\n]*\1/;
const files: string[] = [];
const walk = (dir: string) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) continue;
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".check.ts")) files.push(p);
  }
};
for (const d of ["lib", "app", "components"]) walk(join(__dirname, "..", d));
const offenders = files.filter((f) => ONE_LINE_MULTI.test(readFileSync(f, "utf8"))).map((f) => f.replace(join(__dirname, "..") + "/", ""));
assert.deepEqual(offenders, [], `one-line multi-statement execute(): ${offenders.join(", ")}`);
assert.ok(ONE_LINE_MULTI.test('db.execute("DELETE FROM a; DELETE FROM b;")')); // the guard itself works
assert.ok(!ONE_LINE_MULTI.test("db.execute(BASE_TABLES_SCHEMA)"));
console.log("sql execute checks passed");
