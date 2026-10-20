/**
 * LifeCommit - 데이터베이스 백업 및 복원 (Export / Import) 모듈
 */

import { executeInTransaction } from "./db";
import { emit, EVENT_COMMITS_UPDATED } from "./events";
import { collectBackup, restoreBackup, restoredFilters } from "./backupTables";
import { writeFilterText } from "./filters";
import { readSetting, writeSetting, NOISE_FILTER_SETTING } from "./settings";
import { loadDongs } from "./dong";
import { rematchPlacesMarked } from "./rematch";

/**
 * 전체 커밋 및 설정 데이터를 JSON 파일로 내보내기 (Export)
 */
export async function exportDatabaseBackup(): Promise<{ success: boolean; filename: string; count: number }> {
  try {
    // one serialized snapshot: the filter and every table are read in the same transaction, so a filter save
    // (mass delete + new filter) cannot land between them; JSON and the file write happen outside
    const backup = await executeInTransaction(
      async (d) => collectBackup(d, await readSetting(d, NOISE_FILTER_SETTING)), { requireTransaction: true });

    const jsonString = JSON.stringify(backup, null, 2);
    const dateStr = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `lifecommit_backup_${dateStr}.json`;

    const { Capacitor } = await import("@capacitor/core");

    if (Capacitor.isNativePlatform()) {
      // 안드로이드 네이티브: 다운로드 폴더 저장 + 시스템 공유 다이얼로그
      try {
        const LifeCommitPlugin = (await import("@/plugins/LifeCommitPlugin")).default;
        const res = await LifeCommitPlugin.exportBackupFile({ filename, content: jsonString });
        if (!res.success) throw new Error("네이티브 백업 저장에 실패했습니다.");
      } catch (nativeErr: any) {
        throw new Error(`네이티브 백업 저장 실패: ${nativeErr?.message || String(nativeErr)}`);
      }
    } else {
      // 웹 환경: Blob 다운로드 트리거
      const blob = new Blob([jsonString], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    return {
      success: true,
      filename,
      count: (backup.commits as unknown[]).length,
    };
  } catch (err: any) {
    console.error("[Backup] Export failed:", err);
    throw new Error(`백업 내보내기 실패: ${err?.message || String(err)}`);
  }
}

/**
 * 백업 JSON 문자열을 파싱하여 DB에 복원 (Import)
 */
/** All or nothing: rows and the noise filter (app_settings) are restored in one transaction. */
export async function importDatabaseBackup(jsonString: string): Promise<{ success: boolean; importedCommits: number }> {
  try {
    const backup = JSON.parse(jsonString);

    if (!backup.commits || !Array.isArray(backup.commits)) {
      throw new Error("올바른 LifeCommit 백업 파일 형식이 아닙니다 (commits 필드 누락).");
    }

    const filters = restoredFilters(backup);
    await loadDongs(); // 트랜잭션 밖에서: 재판정의 위치 제목이 행정동을 읽는다
    const importedCount = await executeInTransaction(async (d) => {
      const n = await restoreBackup(d, backup);
      await rematchPlacesMarked(d); // 가져온 행 + 기존 행 모두 최종 장소 집합 기준으로
      if (filters != null) await writeSetting(d, NOISE_FILTER_SETTING, filters); // same transaction as the rows
      return n;
    }, { requireTransaction: true });
    if (filters != null) {
      try { writeFilterText(localStorage, filters); } catch (e) { console.warn("[Backup] filter mirror write failed:", e); } // mirror only
    }

    emit(EVENT_COMMITS_UPDATED);
    return { success: true, importedCommits: importedCount };
  } catch (err: any) {
    console.error("[Backup] Import failed:", err);
    throw new Error(`복원 실패: ${err.message || String(err)}`);
  }
}
