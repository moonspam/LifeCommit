import { registerPlugin } from "@capacitor/core";

export interface PhotoEntry {
  id: string;
  photoUri: string;      // 안드로이드 MediaStore Content URI
  fileName: string;      // 파일명 (예: IMG_20260520_111500.jpg)
  timestamp: number;     // 촬영 또는 생성 타임스탬프
}

export interface GetPhotosOptions {
  afterTimestamp?: number;
  limit?: number;
  offset?: number;                // 페이지네이션 오프셋 (기본 0)
}

export interface GetPhotosResult {
  photos: PhotoEntry[];
}

export interface PhotoPluginInterface {
  /**
   * 미디어 갤러리 읽기 권한 확인
   */
  hasPhotoPermission(): Promise<{ granted: boolean }>;

  /**
   * 최근 저장된 사진(미디어) 목록 조회
   */
  getRecentPhotos(options?: GetPhotosOptions): Promise<GetPhotosResult>;

  /**
   * 특정 사진 URI를 시스템 갤러리 앱으로 엽니다.
   */
  openPhoto(options: { photoUri: string }): Promise<void>;
}

const PhotoPlugin = registerPlugin<PhotoPluginInterface>("PhotoPlugin", {
  web: () =>
    import("./mocks/PhotoMock").then((m) => new m.PhotoMock()),
});

export default PhotoPlugin;
