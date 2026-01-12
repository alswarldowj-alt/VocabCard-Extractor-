
export interface VocabItem {
  id: number;
  localId: number; // 单词在原图中的序号
  word: string;
  originalImageIndex: number;
  boundingBox: {
    ymin: number;
    xmin: number;
    ymax: number;
    xmax: number;
  };
  croppedImageUrl?: string;
  blob?: Blob;
}

export interface ProcessingStatus {
  fileName: string;
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress: number;
  error?: string;
}
