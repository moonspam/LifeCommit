/**
 * Administrative dong (행정동) for a coordinate, offline: the boundaries ship inside LifeCommit+
 * (android/app/src/full/assets/public/dong.geojson, scripts/build-dong.sh, CC BY 4.0 - see dong.NOTICE.txt there).
 * No network: the app's "records never leave the device" promise holds. oss has no file (and no location) -> null.
 */
import { getFlavor } from "./flavor";

type Ring = [number, number][];
export type Dong = { name: string; bbox: [number, number, number, number]; polys: Ring[][] };

export function parseDongs(geo: { features: { properties: { adm_nm: string }; geometry: { type: string; coordinates: any } }[] }): Dong[] {
  return geo.features.map((f) => {
    const polys: Ring[][] = f.geometry.type === "MultiPolygon" ? f.geometry.coordinates : [f.geometry.coordinates];
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of polys) for (const [x, y] of p[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return { name: f.properties.adm_nm, bbox: [x0, y0, x1, y1], polys };
  });
}

const inRing = (x: number, y: number, r: Ring) => {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
};

/** "경기도 고양시일산동구 식사동" -> "경기도 고양시 일산동구 식사동"; null outside every dong (sea, abroad). */
export function dongAt(dongs: Dong[], lat: number, lng: number): string | null {
  for (const d of dongs) {
    const [x0, y0, x1, y1] = d.bbox;
    if (lng < x0 || lng > x1 || lat < y0 || lat > y1) continue;
    if (d.polys.some((p) => inRing(lng, lat, p[0]) && !p.slice(1).some((h) => inRing(lng, lat, h)))) return d.name.replace(/(\S+시)(\S+구)/, "$1 $2");
  }
  return null;
}

let loading: Promise<Dong[] | null> | null = null;
let loaded: Dong[] | null = null;

/** Loads the bundled boundaries once (gives up after 10 s); null when they are not there (oss, web/dev); a failed load is retried by the next call. Never throws. */
export function loadDongs(): Promise<Dong[] | null> {
  loading ??= (async () => {
    try {
      const flavor = await getFlavor();
      if (flavor === "oss") {
        loaded = null;
        return null; // oss는 fetch 없이 null 영구 캐시(loading이 null로 초기화되지 않음)
      }
    } catch {
      // flavor 확인 실패 시 full 동작 유지
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 10_000);
      timer.unref?.();
    });

    return Promise.race([
      fetch("/dong.geojson").then((r) => (r.ok ? r.json() : null)).then((g) => (g ? parseDongs(g) : null)),
      timeoutPromise,
    ]).catch(() => null).then((d) => {
      if (timer) clearTimeout(timer);
      loaded = d;
      if (!d) loading = null; // full의 일시 실패는 기억하지 않고 다음 호출이 다시 시도
      return d;
    });
  })();
  return loading;
}

export async function dongName(lat: number, lng: number): Promise<string | null> {
  const dongs = await loadDongs();
  return dongs ? dongAt(dongs, lat, lng) : null;
}

/** Synchronous, for inside a DB transaction: null unless loadDongs() already finished (lib/processor.ts preloads it). */
export const loadedDongName = (lat: number, lng: number) => (loaded ? dongAt(loaded, lat, lng) : null);

/** True once loadDongs() found the boundaries; false while loading, in oss, or when the load failed. */
export const dongsLoaded = () => loaded !== null;

/** 테스트용: 동 경계 로딩 캐시 초기화 */
export function resetDongLoadingForTest() {
  loading = null;
  loaded = null;
}
