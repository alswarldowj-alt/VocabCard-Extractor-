
interface BBox {
  ymin: number;
  xmin: number;
  ymax: number;
  xmax: number;
}

export const cropImage = (
  file: File, 
  box: BBox
): Promise<{ url: string; blob: Blob }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error("Canvas context failed"));
        return;
      }

      // Convert normalized [0-1000] to pixels
      const width = img.naturalWidth;
      const height = img.naturalHeight;

      const sx = (box.xmin / 1000) * width;
      const sy = (box.ymin / 1000) * height;
      const sw = ((box.xmax - box.xmin) / 1000) * width;
      const sh = ((box.ymax - box.ymin) / 1000) * height;

      canvas.width = sw;
      canvas.height = sh;

      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

      canvas.toBlob((blob) => {
        if (blob) {
          const url = URL.createObjectURL(blob);
          resolve({ url, blob });
        } else {
          reject(new Error("Blob creation failed"));
        }
        URL.revokeObjectURL(img.src);
      }, 'image/jpeg', 0.9);
    };
    img.onerror = reject;
  });
};
