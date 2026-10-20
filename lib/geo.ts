/**
 * LifeCommit 위치 유틸리티 모듈
 *
 * Haversine 공식을 사용한 거리 계산 함수를 단일 소스로 제공합니다.
 * db.ts와 LocationStrategy.ts에서 공통 참조합니다.
 */

/**
 * 두 좌표 사이의 거리를 미터 단위로 반환합니다 (Haversine 공식).
 */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371e3; // 지구 반경 (미터)
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * 주어진 위도/경도가 특정 지오펜스 반경 내에 있는지 확인합니다 (첫 번째 매칭 반환).
 */
export function matchGeofence(lat: number, lng: number, geofences: any[]): any | null {
  for (const gf of geofences) {
    const distanceMeters = haversineDistance(lat, lng, gf.lat, gf.lng);
    if (distanceMeters <= gf.radius_m) {
      return gf;
    }
  }
  return null;
}
