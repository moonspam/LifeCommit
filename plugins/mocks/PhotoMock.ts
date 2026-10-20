import type { PhotoPluginInterface, PhotoEntry } from "../PhotoPlugin";

export class PhotoMock implements PhotoPluginInterface {
  async hasPhotoPermission() {
    return { granted: true };
  }

  async getRecentPhotos(): Promise<{ photos: PhotoEntry[] }> {
    return {
      photos: [
        {
          id: "p1",
          photoUri: "https://images.unsplash.com/photo-1579546929518-9e396f3cc809",
          fileName: "mock_sunset.jpg",
          timestamp: Date.now() - 3600000 * 4,
        },
        {
          id: "p2",
          photoUri: "https://images.unsplash.com/photo-1533038590840-1cde6b66b706",
          fileName: "mock_workspace.jpg",
          timestamp: Date.now() - 3600000 * 2,
        },
      ],
    };
  }

  async openPhoto(options: { photoUri: string }): Promise<void> {
    console.log("[Mock] Opening photo in browser window:", options.photoUri);
    window.open(options.photoUri, "_blank");
  }
}
