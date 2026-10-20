/**
 * 장소 재판정: 장소(geofence)가 바뀌면 과거 기록의 geofence_name과 위치 자동 제목을 현재 장소 정의로 다시 맞춘다.
 * 순수 모듈(Capacitor 없음): 이미 열린 트랜잭션 핸들 `d`만 받는다. 안에서 executeInTransaction을 다시 부르면 직렬 큐가 교착한다.
 */
import { matchGeofence } from "./geo";
import { loadedDongName, dongsLoaded } from "./dong";
import { readSetting, writeSetting } from "./settings";

type Row = Record<string, unknown>;
interface Db {
  query(sql: string, values?: unknown[]): Promise<{ values?: Row[] }>;
  run(sql: string, params: unknown[], transaction?: boolean): Promise<unknown>;
}

/** 모든 판정 경로가 같은 정렬을 쓴다(겹치는 장소는 id 작은 쪽). */
export const GEOFENCES_SQL = "SELECT * FROM geofences ORDER BY id ASC";

export const PLACE_REMATCH_SETTING = "place_rematch_v1";

const TAILED_TYPES = new Set(["APP_USAGE", "CALL", "SMS", "PHOTO"]);
const SUBJECT_PREFIX = "gps: ";
const SUBJECT_SUFFIX = " 도착 및 머무름";

/** 다른 이벤트(앱 사용·통화·문자·사진) 제목 꼬리 규칙: 전략과 재판정이 같은 함수를 쓴다. */
export const locationHint = (name: string | null | undefined): string => (name ? ` @ ${name}` : "");

const coordLabel = (lat: number, lng: number) => `위치(${lat.toFixed(4)}, ${lng.toFixed(4)})`;

/** LocationStrategy와 재판정이 공유하는 규칙: 장소 > 행정동 > 좌표. */
export function locationSubject(geofenceName: string | null, lat: number, lng: number): string {
  const name = geofenceName || loadedDongName(lat, lng) || coordLabel(lat, lng);
  return `${SUBJECT_PREFIX}${name}${SUBJECT_SUFFIX}`;
}

/**
 * 자동 생성된 LOCATION 제목과 정확히 일치하는지 판별:
 * 지오펜스가 있으면 locationSubject(geofenceName, lat, lng),
 * 지오펜스가 없으면 locationSubject(null, lat, lng) 또는 좌표 라벨 제목.
 */
export function isAutoLocationSubject(
  subject: string,
  geofenceName: string | null,
  lat: number,
  lng: number
): boolean {
  const autoTitles = geofenceName
    ? [locationSubject(geofenceName, lat, lng)]
    : [locationSubject(null, lat, lng), `${SUBJECT_PREFIX}${coordLabel(lat, lng)}${SUBJECT_SUFFIX}`];
  return autoTitles.includes(subject);
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** lat/lng 열 우선, 없으면 LOCATION body의 좌표. 둘 다 없거나 잘못되면 null. */
function coordsOf(row: Row): { lat: number; lng: number } | null {
  if (isNum(row.lat) && isNum(row.lng)) return { lat: row.lat, lng: row.lng };
  if (row.event_type === "LOCATION" && typeof row.body === "string") {
    try {
      const b = JSON.parse(row.body);
      if (isNum(b?.lat) && isNum(b?.lng)) return { lat: b.lat, lng: b.lng };
    } catch {}
  }
  return null;
}

/**
 * 좌표가 있는 모든 커밋을 현재 장소 목록으로 다시 판정한다. 바뀐 행만 UPDATE(FTS 트리거가 따라온다).
 * 호출하는 쪽이 트랜잭션 밖에서 `await loadDongs()`를 먼저 해 둘 것.
 * 반환: 바뀐 행 수(changed)와, 행정동 미로딩 때문에 건너뛴 행 수(incomplete).
 */
export async function rematchPlaces(d: Db): Promise<{ changed: number; incomplete: number }> {
  const geofences = (await d.query(GEOFENCES_SQL)).values || [];
  const rows = (await d.query("SELECT id, event_type, subject, CASE WHEN event_type = 'LOCATION' THEN body END AS body, geofence_name, lat, lng FROM commits")).values || [];
  const dongsReady = dongsLoaded();
  let changed = 0;
  let incomplete = 0;
  for (const row of rows) {
    const c = coordsOf(row);
    if (!c) continue; // 좌표 없음: 이름만 보고 배정하지 않는다
    const oldName = typeof row.geofence_name === "string" ? row.geofence_name : null;
    const newName = (matchGeofence(c.lat, c.lng, geofences)?.name as string | undefined) ?? null;
    if (newName === oldName) continue;

    // 행정동 데이터가 없으면 옛 "gps: <행정동> ..." 제목을 자동 제목인지 판별할 수 없다: 행 전체를 건너뛰고 미완료로 센다
    if (!dongsReady && row.event_type === "LOCATION" && oldName === null && typeof row.subject === "string"
      && row.subject.startsWith(SUBJECT_PREFIX) && row.subject.endsWith(SUBJECT_SUFFIX)
      && row.subject !== `${SUBJECT_PREFIX}${coordLabel(c.lat, c.lng)}${SUBJECT_SUFFIX}`) {
      incomplete++;
      continue;
    }

    let subject = row.subject;
    if (row.event_type === "LOCATION" && typeof row.subject === "string") {
      // 옛 판정으로 자동 생성됐을 제목일 때만 다시 만든다(사용자가 고친 제목은 그대로)
      if (isAutoLocationSubject(row.subject, oldName, c.lat, c.lng)) {
        subject = locationSubject(newName, c.lat, c.lng);
      }
    } else if (oldName && typeof row.subject === "string" && TAILED_TYPES.has(String(row.event_type))) {
      // 자동 제목 꼬리를 쓰는 4종만, 정확히 옛 꼬리로 끝날 때만 교체. manual·REPLY·MERGE 등과 꼬리 없는 제목은 그대로.
      // 옛 이름이 없던 행에 꼬리를 덧붙이지 않는다: 사용자가 고친 제목과 구분할 수 없다.
      const oldTail = locationHint(oldName);
      if (row.subject.endsWith(oldTail)) subject = row.subject.slice(0, -oldTail.length) + locationHint(newName);
    }
    await d.run("UPDATE commits SET geofence_name = ?, subject = ? WHERE id = ?", [newName, subject, row.id], false);
    changed++;
  }
  return { changed, incomplete };
}

/** 장소 CRUD·복원용: 재판정 뒤 미완료가 있으면 완료 표시를 지워 processor가 다음 주기에 다시 시도하게 한다. */
export async function rematchPlacesMarked(d: Db): Promise<{ changed: number; incomplete: number }> {
  const r = await rematchPlaces(d);
  if (r.incomplete > 0) await d.run("DELETE FROM app_settings WHERE key = ?", [PLACE_REMATCH_SETTING], false);
  return r;
}

/** 기존 DB 보정(표시는 app_settings). 표시가 있으면 쿼리 1번으로 끝. 미완료가 남으면 표시를 쓰지 않는다. 호출은 트랜잭션 안에서. */
export async function rematchPlacesOnce(d: Db): Promise<{ changed: number; incomplete: number }> {
  if ((await readSetting(d, PLACE_REMATCH_SETTING)) != null) return { changed: 0, incomplete: 0 };
  const r = await rematchPlaces(d);
  if (r.incomplete === 0) await writeSetting(d, PLACE_REMATCH_SETTING, "1");
  return r;
}

let ossRematchSkipped = false;

/** 테스트용: OSS 재시도 건너뛰기 세션 플래그 초기화 */
export function resetOssRematchSkippedForTest() {
  ossRematchSkipped = false;
}

/**
 * 앱 구동 시/배치 주기마다 실행하는 최초 1회 보정 오케스트레이션.
 * OSS 환경에서 미완료(incomplete > 0)가 발생하면 이번 세션에서는 다시 시도하지 않는다.
 * 트랜잭션 실행 함수 runTx를 인자로 받아, changed > 0일 때 반환하여 호출처가 emit할 수 있게 한다.
 */
export async function rematchOnStartup<T extends Db>(
  runTx: (fn: (d: T) => Promise<{ changed: number; incomplete: number }>) => Promise<{ changed: number; incomplete: number }>,
  isOss: boolean
): Promise<{ changed: number }> {
  if (ossRematchSkipped && isOss) return { changed: 0 };
  try {
    const r = await runTx((d) => rematchPlacesOnce(d));
    if (r.incomplete > 0 && isOss) {
      ossRematchSkipped = true;
    }
    return { changed: r.changed };
  } catch (e) {
    console.error("Place rematch failed (will retry):", e);
    return { changed: 0 };
  }
}
