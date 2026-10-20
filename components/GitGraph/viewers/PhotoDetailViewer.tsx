"use client";

import { PhotoBody } from "@/types/commit";

interface PhotoDetailViewerProps {
  body: string | null;
  onToast: (msg: string) => void;
}

export default function PhotoDetailViewer({ body, onToast }: PhotoDetailViewerProps) {
  if (!body) return null;

  try {
    const bodyObj: PhotoBody = JSON.parse(body);
    let firstPhotoUri = bodyObj.photoUri;
    let countText = "";

    if (bodyObj.photos && bodyObj.photos.length > 0) {
      firstPhotoUri = bodyObj.photos[0].photoUri;
      if (bodyObj.photos.length > 1) {
        countText = ` (총 ${bodyObj.photos.length}장)`;
      }
    }

    if (!firstPhotoUri) return null;

    const handleOpenPhoto = async (e: React.MouseEvent) => {
      e.stopPropagation();
      try {
        const PhotoPlugin = (await import("@/plugins/PhotoPlugin")).default;
        await PhotoPlugin.openPhoto({ photoUri: firstPhotoUri! });
      } catch (err) {
        onToast("사진을 열 수 없습니다.");
      }
    };

    return (
      <div className="flex flex-col gap-1 pb-1 border-b border-terminal-border/40">
        <button
          onClick={handleOpenPhoto}
          className="text-[10px] font-mono text-[#ff79c6] cursor-pointer hover:underline flex items-center gap-1.5 active:bg-[#ff79c6]/10 px-1 py-1 rounded -mx-1 transition-colors text-left"
          title="클릭하여 갤러리에서 보기"
        >
          🖼️ 갤러리에서 첫 번째 사진 보기{countText}
        </button>
      </div>
    );
  } catch {
    return null;
  }
}
