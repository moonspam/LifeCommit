import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// oss ships no Google Play services, so its Capacitor plugin list must not name @capacitor/geolocation (the module is
// excluded in android/app/build.gradle; Capacitor aborts the WHOLE list on a missing class, SQLite included).
// The list is a static override of the one `cap sync` generates: it must equal that list minus geolocation.
type Entry = { pkg: string; classpath: string };
const oss = JSON.parse(readFileSync("android/app/src/oss/assets/capacitor.plugins.json", "utf8")) as Entry[];
assert.ok(!oss.some((p) => p.pkg === "@capacitor/geolocation"), "oss lists no geolocation");
assert.ok(oss.some((p) => p.pkg === "@capacitor-community/sqlite"), "oss keeps SQLite");
const generated = "android/app/src/main/assets/capacitor.plugins.json"; // written by `npx cap sync android`
if (existsSync(generated)) {
  const main = JSON.parse(readFileSync(generated, "utf8")) as Entry[];
  assert.deepEqual(oss, main.filter((p) => p.pkg !== "@capacitor/geolocation"), "oss list = generated list minus geolocation (re-derive it after adding a plugin)");
}
console.log("oss plugin list checks passed");
