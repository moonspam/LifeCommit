#!/usr/bin/env node
// Regenerates public/THIRD_PARTY_NOTICES.txt (shipped in both APKs under assets/public): the licenses of everything the
// app bundles - npm production packages (incl. Capacitor's Android code), Android libraries of the release classpaths,
// and the Fira Code web font. Run after dependency changes: node scripts/build-notices.mjs
import { execSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const notice = (f) => readFileSync(join(root, "scripts/notices", f), "utf8").trim();
const out = ["LifeCommit - third-party notices", "", "LifeCommit itself is MIT licensed (LICENSE). It bundles the software below under the licenses shown.", ""];
const hr = "-".repeat(78);

// 1. npm production tree (what the web bundle and Capacitor's native modules are built from; a superset of what ships)
const seen = new Set();
const paths = execSync("npm ls --omit=dev --all --parseable", { cwd: root, encoding: "utf8" }).trim().split("\n").slice(1);
const npm = [];
for (const dir of paths) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const id = `${pkg.name}@${pkg.version}`;
  if (seen.has(id) || pkg.os || pkg.cpu) continue; // platform binaries (swc, sharp, rollup) run at build time on the Mac, never shipped
  seen.add(id);
  const files = readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort();
  const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type ?? "(see package)";
  npm.push([id, license, files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n")]);
}
npm.sort((a, b) => a[0].localeCompare(b[0]));
out.push(`== npm packages (${npm.length}) ==`, "");
for (const [id, license, text] of npm) out.push(hr, `${id}  (${license})`, "", text || `License: ${license} (no license file in the package)`, "");

// 2. Android libraries (release runtime classpaths of both flavors)
const android = new Set(), inOss = new Set();
for (const conf of ["ossReleaseRuntimeClasspath", "fullReleaseRuntimeClasspath"]) {
  const txt = execSync(`./gradlew --offline -q :app:dependencies --configuration ${conf}`, { cwd: join(root, "android"), encoding: "utf8" });
  for (const m of txt.matchAll(/([a-z0-9_.-]+):([A-Za-z0-9_.-]+):([0-9][^ \n]*?)(?: -> ([0-9][^ \n]*))?(?: \([c*]\))?$/gm)) {
    const c = `${m[1]}:${m[2]}:${m[4] ?? m[3]}`;
    android.add(c);
    if (conf.startsWith("oss")) inOss.add(c);
  }
}
const APACHE = /^(androidx\.|org\.jetbrains|com\.google\.guava|com\.google\.errorprone|com\.google\.crypto\.tink|com\.google\.code\.gson|org\.jspecify|org\.apache\.cordova)/;
const byLicense = { "Apache License 2.0 (full text at the end)": [], "SQLCipher (BSD-style)": [], "Ionic geolocation (MIT)": [], "Google Play services": [] };
for (const c of [...android].sort()) {
  if (APACHE.test(c)) byLicense["Apache License 2.0 (full text at the end)"].push(c);
  else if (c.startsWith("net.zetetic:")) byLicense["SQLCipher (BSD-style)"].push(c);
  else if (c.startsWith("io.ionic.libs:")) byLicense["Ionic geolocation (MIT)"].push(c);
  else if (c.startsWith("com.google.android.gms:")) byLicense["Google Play services"].push(c);
  else throw new Error(`no license mapping for ${c} - add it to scripts/build-notices.mjs`);
}
out.push(`== Android libraries (${android.size}) ==`, "");
out.push("Marked [LifeCommit+ only]: bundled in the full build, not in the oss build.", "");
for (const [license, libs] of Object.entries(byLicense)) out.push(hr, license, "", ...libs.map((c) => (inOss.has(c) ? c : `${c}  [LifeCommit+ only]`)), "");
out.push(hr, "SQLCipher license", "", notice("sqlcipher.txt"), "", "SQLCipher is based on SQLite, which is in the public domain.", "");
out.push(hr, "Ionic geolocation license", "", notice("iongeolocation-android.txt"), "");
out.push(hr, "Google Play services: used under the Android Software Development Kit License Agreement", "(https://developer.android.com/studio/terms).", "");

// 3. fonts bundled by next/font (app/layout.tsx)
out.push("== Fonts ==", "", hr, "Fira Code (SIL Open Font License 1.1)", "", notice("fira-code-ofl.txt"), "");

// 4. LifeCommit+ only: the administrative-dong boundaries carry their own notice (android/app/src/full/assets/public/dong.NOTICE.txt)
out.push("== LifeCommit+ (full build) data ==", "", "Administrative-dong boundaries: see dong.NOTICE.txt (CC BY 4.0, Statistics Korea SGIS / KOGL Type 1).", "");

out.push(hr, "Apache License 2.0", "", notice("apache-2.0.txt"), "");
writeFileSync(join(root, "public/THIRD_PARTY_NOTICES.txt"), out.join("\n"));
console.log(`public/THIRD_PARTY_NOTICES.txt: ${npm.length} npm packages, ${android.size} Android libraries`);
