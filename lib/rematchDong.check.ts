import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openInitialised } from "./sqliteTestDb";
import { rematchPlaces, rematchPlacesOnce, rematchPlacesMarked, PLACE_REMATCH_SETTING } from "./rematch";
import { loadDongs, dongsLoaded } from "./dong";

type Row = Record<string, unknown>;

// 행정동 데이터: 처음엔 로딩 실패, 나중에 성공(이 프로세스에서 같은 모듈이 재시도하는지까지 본다)
let dongFileOk = false;
globalThis.fetch = (async (url: string) => url === "/dong.geojson" && dongFileOk
  ? { ok: true, json: async () => JSON.parse(readFileSync("android/app/src/full/assets/public/dong.geojson", "utf8")) }
  : { ok: false }) as unknown as typeof fetch;

const T = 1_791_000_000_000;
const P = { lat: 37.5665, lng: 126.978 }; // 행정동: 서울특별시 중구 명동
const DONG_TITLE = "gps: 서울특별시 중구 명동 도착 및 머무름";

async function main() {
  const { d, adapter } = await openInitialised();
  d.exec("DELETE FROM geofences");
  d.prepare("INSERT INTO commits (id, branch_id, subject, body, started_at, ended_at, duration_sec, event_type, geofence_name, lat, lng, created_at) VALUES ('dong', 2, ?, ?, ?, ?, 1, 'LOCATION', NULL, ?, ?, 1)")
    .run(DONG_TITLE, JSON.stringify(P), T, T, P.lat, P.lng);
  const row = () => ({ ...(d.prepare("SELECT subject, geofence_name FROM commits WHERE id = 'dong'").get() as Row) });
  const mark = () => d.prepare("SELECT value FROM app_settings WHERE key = ?").get(PLACE_REMATCH_SETTING);

  // 1. 동 로딩 실패 상태에서 행정동 제목 행에 장소 추가 → 행 그대로·미완료·표시 없음
  assert.equal(await loadDongs(), null);
  assert.equal(dongsLoaded(), false);
  d.prepare("INSERT INTO geofences (name, lat, lng, radius_m) VALUES ('동장소', ?, ?, 150)").run(P.lat, P.lng);
  assert.deepEqual(await rematchPlacesOnce(adapter as never), { changed: 0, incomplete: 1 });
  assert.deepEqual(row(), { subject: DONG_TITLE, geofence_name: null }, "제목·장소 모두 그대로");
  assert.equal(mark(), undefined, "완료 표시를 쓰지 않음");

  // 장소 CRUD·복원 경로: 미완료면 이미 있던 완료 표시도 지운다
  d.prepare("INSERT INTO app_settings (key, value) VALUES (?, '1')").run(PLACE_REMATCH_SETTING);
  assert.deepEqual(await rematchPlacesMarked(adapter as never), { changed: 0, incomplete: 1 });
  assert.equal(mark(), undefined, "미완료면 완료 표시 삭제");

  // 2. 동 로딩 성공 후 다시 실행 → 제목·장소 모두 갱신, 완료 표시, 이어서 이름 변경도 정상
  dongFileOk = true;
  assert.ok(await loadDongs(), "실패는 기억하지 않고 다음 호출에서 다시 시도");
  assert.equal(dongsLoaded(), true);
  assert.deepEqual(await rematchPlacesOnce(adapter as never), { changed: 1, incomplete: 0 });
  assert.deepEqual(row(), { subject: "gps: 동장소 도착 및 머무름", geofence_name: "동장소" });
  assert.equal(mark()!.value, "1");
  d.prepare("UPDATE geofences SET name = '동장소2'").run();
  await rematchPlaces(adapter as never);
  assert.deepEqual(row(), { subject: "gps: 동장소2 도착 및 머무름", geofence_name: "동장소2" });

  // 3. OSS: fetch 스텁 호출 수를 세면서 loadDongs() 3회 → fetch 0회, 모두 null
  {
    const { setFlavorForTest } = await import("./flavor");
    const { resetDongLoadingForTest } = await import("./dong");
    let fetchCount = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: any[]) => {
      fetchCount++;
      return (origFetch as any)(...args);
    }) as any;

    setFlavorForTest("oss");
    resetDongLoadingForTest();
    try {
      assert.equal(await loadDongs(), null);
      assert.equal(await loadDongs(), null);
      assert.equal(await loadDongs(), null);
      assert.equal(fetchCount, 0, "oss에서는 fetch를 아예 호출하지 않음");
      assert.equal(dongsLoaded(), false);
    } finally {
      globalThis.fetch = origFetch;
      setFlavorForTest(null);
      resetDongLoadingForTest();
    }
  }

  // 4. rematchOnStartup 실제 호출 검증:
  //    - OSS(isOss=true): 72차 재현(복원된 LOCATION 행 geofence_name=null, 등록 장소 안 좌표, 제목 gps: TestDong 도착 및 머무름)
  //      3회 호출 시 commits 전체 SELECT 1회 이하, 행 그대로, 완료 표시 없음
  //    - full(isOss=false): 3회 모두 다시 시도 (SELECT 3회)
  {
    const { setFlavorForTest } = await import("./flavor");
    const { rematchOnStartup, resetOssRematchSkippedForTest } = await import("./rematch");

    // 4-1. OSS 검증
    {
      const ossDb = await openInitialised();
      ossDb.d.exec("DELETE FROM geofences");
      ossDb.d.prepare("INSERT INTO geofences (name, lat, lng, radius_m) VALUES ('TestPlace', ?, ?, 150)").run(P.lat, P.lng);
      ossDb.d.prepare("INSERT INTO commits (id, branch_id, subject, body, started_at, ended_at, duration_sec, event_type, geofence_name, lat, lng, created_at) VALUES ('loc1', 2, 'gps: TestDong 도착 및 머무름', ?, ?, ?, 1, 'LOCATION', NULL, ?, ?, 1)")
        .run(JSON.stringify(P), T, T, P.lat, P.lng);

      setFlavorForTest("oss");
      resetOssRematchSkippedForTest();

      let commitSelectCount = 0;
      const fakeRunTx = async (fn: (d: any) => Promise<any>) => {
        const origQuery = ossDb.adapter.query;
        ossDb.adapter.query = async (sql: string, params?: any[]) => {
          if (sql.includes("SELECT") && sql.includes("FROM commits")) {
            commitSelectCount++;
          }
          return origQuery.call(ossDb.adapter, sql, params);
        };
        try {
          return await fn(ossDb.adapter);
        } finally {
          ossDb.adapter.query = origQuery;
        }
      };

      try {
        await rematchOnStartup(fakeRunTx, true);
        await rematchOnStartup(fakeRunTx, true);
        await rematchOnStartup(fakeRunTx, true);

        assert.ok(commitSelectCount <= 1, `commits 전체 SELECT 1회 이하 (실제: ${commitSelectCount}회)`);
        const locRow = ossDb.d.prepare("SELECT subject, geofence_name FROM commits WHERE id = 'loc1'").get() as Row;
        assert.deepEqual({ ...locRow }, { subject: "gps: TestDong 도착 및 머무름", geofence_name: null }, "행 그대로 보존");
        const ossMark = ossDb.d.prepare("SELECT value FROM app_settings WHERE key = ?").get(PLACE_REMATCH_SETTING);
        assert.equal(ossMark, undefined, "완료 표시 없음");
      } finally {
        setFlavorForTest(null);
        resetOssRematchSkippedForTest();
      }
    }

    // 4-2. full 검증 (isOss=false 이면 3회 모두 재시도 -> SELECT 3회)
    {
      const fullDb = await openInitialised();
      fullDb.d.exec("DELETE FROM geofences");
      fullDb.d.prepare("INSERT INTO geofences (name, lat, lng, radius_m) VALUES ('TestPlace', ?, ?, 150)").run(P.lat, P.lng);
      fullDb.d.prepare("INSERT INTO commits (id, branch_id, subject, body, started_at, ended_at, duration_sec, event_type, geofence_name, lat, lng, created_at) VALUES ('loc1', 2, 'gps: TestDong 도착 및 머무름', ?, ?, ?, 1, 'LOCATION', NULL, ?, ?, 1)")
        .run(JSON.stringify(P), T, T, P.lat, P.lng);

      setFlavorForTest("full");
      resetOssRematchSkippedForTest();

      let commitSelectCount = 0;
      const fakeRunTx = async (fn: (d: any) => Promise<any>) => {
        const origQuery = fullDb.adapter.query;
        fullDb.adapter.query = async (sql: string, params?: any[]) => {
          if (sql.includes("SELECT") && sql.includes("FROM commits")) {
            commitSelectCount++;
          }
          return origQuery.call(fullDb.adapter, sql, params);
        };
        try {
          return await fn(fullDb.adapter);
        } finally {
          fullDb.adapter.query = origQuery;
        }
      };

      try {
        await rematchOnStartup(fakeRunTx, false);
        await rematchOnStartup(fakeRunTx, false);
        await rematchOnStartup(fakeRunTx, false);

        assert.equal(commitSelectCount, 3, `full에서는 3회 모두 재시도하여 SELECT 3회 실행 (실제: ${commitSelectCount}회)`);
      } finally {
        setFlavorForTest(null);
        resetOssRematchSkippedForTest();
      }
    }
  }

  console.log("rematchDong.check OK");
}

main().catch((e) => { console.error(e); process.exit(1); });
