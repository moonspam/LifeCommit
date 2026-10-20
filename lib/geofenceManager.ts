/**
 * LifeCommit - 지오펜스(장소) 관리 모듈
 */

import { executeInTransaction, getDB } from "./db";
import { Capacitor } from "@capacitor/core";
import { loadDongs } from "./dong";
import { rematchPlacesMarked } from "./rematch";
import { emit, EVENT_COMMITS_UPDATED } from "./events";

export interface GeofenceItem {
  id: number;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  branch_trigger: string;
}

/**
 * 전체 지오펜스 목록 조회
 */
export async function fetchGeofences(): Promise<GeofenceItem[]> {
  try {
    const db = getDB();
    const res = await db.query("SELECT * FROM geofences ORDER BY id ASC");
    return res.values || [];
  } catch (err) {
    console.error("[GeofenceManager] Fetch failed:", err);
    return [];
  }
}

/**
 * 지오펜스 파라미터 공통 검증 (add/update 공통 경계)
 */
export function validateGeofenceParams(
  name: string,
  lat: number,
  lng: number,
  radiusM: number
): void {
  if (!name.trim()) {
    throw new Error("장소명을 입력해 주세요.");
  }
  if (!Number.isFinite(radiusM) || !Number.isInteger(radiusM) || radiusM < 10 || radiusM > 5000) {
    throw new Error("반경은 10m에서 5000m 사이의 정수여야 합니다.");
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error("위도는 -90도에서 90도 사이여야 합니다.");
  }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
    throw new Error("경도는 -180도에서 180도 사이여야 합니다.");
  }
}

/**
 * 지오펜스 등록
 */
export async function addGeofence(
  name: string,
  lat: number,
  lng: number,
  radiusM: number = 150,
  branchTrigger: string = "main"
): Promise<void> {
  validateGeofenceParams(name, lat, lng, radiusM);
  await loadDongs(); // 트랜잭션 밖에서: 재판정의 위치 제목이 행정동을 읽는다
  await executeInTransaction(async (d) => {
    await d.run(
      `INSERT INTO geofences (name, lat, lng, radius_m, branch_trigger)
       VALUES (?, ?, ?, ?, ?)`,
      [name.trim(), lat, lng, radiusM, branchTrigger.trim() || "main"],
      false
    );
    await rematchPlacesMarked(d);
  }, { requireTransaction: true });
  emit(EVENT_COMMITS_UPDATED);
}

/**
 * 지오펜스 수정
 */
export async function updateGeofence(
  id: number,
  name: string,
  lat: number,
  lng: number,
  radiusM: number = 150,
  branchTrigger: string = "main"
): Promise<void> {
  validateGeofenceParams(name, lat, lng, radiusM);
  await loadDongs();
  await executeInTransaction(async (d) => {
    await d.run(
      `UPDATE geofences 
       SET name = ?, lat = ?, lng = ?, radius_m = ?, branch_trigger = ?
       WHERE id = ?`,
      [name.trim(), lat, lng, radiusM, branchTrigger.trim() || "main", id],
      false
    );
    await rematchPlacesMarked(d);
  }, { requireTransaction: true });
  emit(EVENT_COMMITS_UPDATED);
}

/**
 * 지오펜스 삭제
 */
export async function deleteGeofence(id: number): Promise<void> {
  await loadDongs();
  await executeInTransaction(async (d) => {
    await d.run("DELETE FROM geofences WHERE id = ?", [id], false);
    await rematchPlacesMarked(d);
  }, { requireTransaction: true });
  emit(EVENT_COMMITS_UPDATED);
}

/**
 * 현재 기기 GPS 위치 가져오기 (지오펜스 간편 등록용)
 */
export async function getCurrentGPSCoordinates(): Promise<{ lat: number; lng: number } | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const GeoModule = await import("@capacitor/geolocation");
      const position = await GeoModule.Geolocation.getCurrentPosition({
        enableHighAccuracy: true,
        timeout: 10000,
      });
      return {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
      };
    } else {
      return new Promise((resolve) => {
        if (!navigator.geolocation) return resolve(null);
        navigator.geolocation.getCurrentPosition(
          (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
          () => resolve(null),
          { timeout: 8000 }
        );
      });
    }
  } catch (e) {
    console.warn("[GeofenceManager] GPS location acquisition failed:", e);
    return null;
  }
}
