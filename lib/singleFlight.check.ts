import assert from "node:assert/strict";
import { singleFlight } from "./singleFlight";

const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

async function main() {
  // controllable runs: each run waits for its own release
  let runs = 0;
  const releases: Array<(ok: boolean) => void> = [];
  const f = singleFlight(() => new Promise<number>((res, rej) => { const n = ++runs; releases.push((ok) => (ok ? res(n) : rej(new Error(`run${n}`)))); }));

  const a = f();
  await tick();
  assert.equal(runs, 1);
  const b = f(); // arrive during run1
  const c = f();
  await tick();
  assert.equal(runs, 1, "the follow-up run waits for run1 to settle");
  releases[0](true);
  assert.equal(await a, 1);
  await tick();
  assert.equal(runs, 2, "one shared follow-up run");
  releases[1](true);
  assert.equal(await b, 2);
  assert.equal(await c, 2);

  const d = f(); // everything settled: a fresh run
  await tick();
  assert.equal(runs, 3);
  releases[2](true);
  assert.equal(await d, 3);

  // a rejected run still triggers the follow-up
  const e = f();
  await tick();
  const g = f();
  releases[3](false);
  await assert.rejects(e, /run4/);
  await tick();
  releases[4](true);
  assert.equal(await g, 5);

  // reviewer's order: A running, B queued, `await A`, then C immediately -> runs must never overlap
  {
    let active = 0, maxActive = 0;
    const waiting: Array<() => void> = [];
    const h = singleFlight(() => new Promise<void>((res) => { active++; maxActive = Math.max(maxActive, active); waiting.push(() => { active--; res(); }); }));
    const A = h();
    await tick();
    const B = h(); // queued behind A
    waiting.shift()!(); // finish A
    await A;
    const C = h(); // immediately after A settles
    let settled = false;
    void Promise.all([B, C]).then(() => { settled = true; });
    for (let i = 0; i < 50 && !settled; i++) { await tick(); if (waiting.length) waiting.shift()!(); }
    await tick();
    assert.ok(settled, "B and C settle");
    assert.equal(maxActive, 1, "runs overlapped");
  }

  // seeded random interleaving: never overlap, every call settles, and each result comes from a run that started at/after the call
  {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let active = 0, maxActive = 0, started = 0;
    const open: Array<() => void> = [];
    const h = singleFlight(() => new Promise<number>((res) => { active++; maxActive = Math.max(maxActive, active); const k = ++started; open.push(() => { active--; res(k); }); }));
    const calls: Array<{ startedBefore: number; p: Promise<number> }> = [];
    for (let i = 0; i < 1000; i++) {
      if (rnd() < 0.5) calls.push({ startedBefore: started, p: h() });
      else if (open.length) open.shift()!();
      await tick();
    }
    while (open.length || active) { if (open.length) open.shift()!(); await tick(); }
    const results = await Promise.all(calls.map((c) => c.p));
    assert.equal(maxActive, 1, "runs overlapped under random interleaving");
    results.forEach((r, i) => assert.ok(r > calls[i].startedBefore, `call ${i} got a run that started before it`));
  }
  console.log("single-flight checks passed");
}
main();
