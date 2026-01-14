
import React, { useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Upload, ScanSearch, Loader2, FileSpreadsheet, 
  Archive, CheckCircle2, Image as ImageIcon,
  Trash2, FileType, XCircle
} from 'lucide-react';
import { GoogleGenAI, Type } from "@google/genai";
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

// --- Types ---
interface VocabItem {
  word: string;
  fileName: string;
  croppedImageUrl?: string;
  blob?: Blob;
}

interface FileStatus {
  file: File;
  status: 'pending' | 'processing' | 'completed' | 'error';
  progress: number;
  error?: string;
}

// --- Utilities ---
const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = () => reject(new Error("文件读取失败"));
    reader.readAsDataURL(file);
  });
};

const cropImage = (file: File, box: number[]): Promise<{ url: string; blob: Blob }> => {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.src = URL.createObjectURL(file);
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error("Canvas context failed");
        
        const [ymin, xmin, ymax, xmax] = box;
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        
        const sx = (xmin / 1000) * w;
        const sy = (ymin / 1000) * h;
        const sw = ((xmax - xmin) / 1000) * w;
        const sh = ((ymax - ymin) / 1000) * h;
        
        canvas.width = Math.max(1, sw);
        canvas.height = Math.max(1, sh);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        
        canvas.toBlob((blob) => {
          if (blob) resolve({ url: URL.createObjectURL(blob), blob });
          else reject(new Error("Blob creation failed"));
          URL.revokeObjectURL(img.src);
        }, 'image/jpeg', 0.9);
      } catch (e) {
        URL.revokeObjectURL(img.src);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject(new Error("图片加载失败"));
    };
  });
};

const App = () => {
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
  const [results, setResults] = useState<VocabItem[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const newFiles = Array.from(files)
      .filter(f => f.type.startsWith('image/'))
      .map(file => ({
        file,
        status: 'pending' as const,
        progress: 0
      }));
    setFileStatuses(prev => [...prev, ...newFiles]);
    setGlobalError(null);
  };

  const processAll = async () => {
    if (fileStatuses.length === 0 || isBusy) return;

    setIsBusy(true);
    setGlobalError(null);
    setResults([]);

    try {
      // 按照规范直接使用 process.env.API_KEY。
      // 如果环境未准备好，SDK 会在调用时抛出错误，我们在 catch 块中统一处理。
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      for (let i = 0; i < fileStatuses.length; i++) {
        const current = fileStatuses[i];
        if (current.status === 'completed') continue;

        setFileStatuses(prev => prev.map((s, idx) => 
          idx === i ? { ...s, status: 'processing', progress: 5, error: undefined } : s
        ));

        try {
          const base64 = await fileToBase64(current.file);
          const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: {
              parts: [
                { inlineData: { mimeType: current.file.type, data: base64 } },
                { text: "提取这张词汇表中的所有单词。每张卡片包含一个插图和下方的单词。请按从左到右、从上到下的阅读顺序返回。返回单词及其对应的插图区域坐标 [ymin, xmin, ymax, xmax]。" }
              ]
            },
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  items: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        word: { type: Type.STRING },
                        box_2d: { 
                          type: Type.ARRAY, 
                          items: { type: Type.NUMBER },
                          description: "[ymin, xmin, ymax, xmax]"
                        }
                      },
                      required: ["word", "box_2d"]
                    }
                  }
                },
                required: ["items"]
              }
            }
          });

          const data = JSON.parse(response.text || '{"items":[]}');
          const rawItems = data.items || [];
          
          if (rawItems.length === 0) {
            throw new Error("未在此图片中检测到卡片内容");
          }

          for (let j = 0; j < rawItems.length; j++) {
            const item = rawItems[j];
            try {
              const { url, blob } = await cropImage(current.file, item.box_2d);
              const newItem: VocabItem = {
                word: item.word.trim(),
                fileName: current.file.name,
                croppedImageUrl: url,
                blob
              };
              setResults(prev => [...prev, newItem]);
            } catch (err) {
              console.error("单个卡片裁剪失败:", err);
            }
            
            setFileStatuses(prev => prev.map((s, idx) => 
              idx === i ? { ...s, progress: 10 + ((j + 1) / rawItems.length) * 90 } : s
            ));
          }

          setFileStatuses(prev => prev.map((s, idx) => 
            idx === i ? { ...s, status: 'completed', progress: 100 } : s
          ));
        } catch (err: any) {
          console.error("文件识别异常:", err);
          let errMsg = err.message || "未知错误";
          if (errMsg.includes("API key not valid") || errMsg.includes("403")) {
            errMsg = "API 密钥无效或环境未配置 API_KEY。";
          }
          setFileStatuses(prev => prev.map((s, idx) => 
            idx === i ? { ...s, status: 'error', error: errMsg } : s
          ));
        }
      }
    } catch (err: any) {
      console.error("全局流程中断:", err);
      setGlobalError("识别中断: " + (err.message || "请检查网络连接或 API 配置"));
    } finally {
      setIsBusy(false);
    }
  };

  const exportExcel = () => {
    if (results.length === 0) return;
    const exportData = results.map((item, index) => ({
      '序号': index + 1, 
      '单词': item.word
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Vocabulary");
    XLSX.writeFile(wb, `词汇表_${new Date().getTime()}.xlsx`);
  };

  const exportZip = async () => {
    if (results.length === 0) return;
    const zip = new JSZip();
    const folder = zip.folder("images");
    results.forEach(item => {
      if (item.blob) {
        const safeName = item.word.replace(/[\\/:*?"<>|]/g, '_'); 
        folder?.file(`${safeName}.jpg`, item.blob);
      }
    });
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `插图包_${new Date().getTime()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 pb-20 select-none animate-in">
      <header className="text-center mb-12 pt-16">
        <div className="inline-flex items-center justify-center p-5 bg-indigo-600 text-white rounded-[2rem] mb-6 shadow-2xl shadow-indigo-200">
          <ScanSearch size={44} strokeWidth={2.5} />
        </div>
        <h1 className="text-5xl font-black text-slate-900 tracking-tight">批量词汇提取专家</h1>
        <p className="text-slate-500 text-xl max-w-2xl mx-auto mt-4 font-medium opacity-80">
          AI 智能识别大图中的单词卡片，自动切割插图并生成词汇表。
        </p>
      </header>

      {globalError && (
        <div className="mb-10 p-6 bg-rose-50 border-2 border-rose-100 text-rose-600 rounded-[2rem] flex items-center gap-4 shadow-lg shadow-rose-100/50">
          <XCircle size={28} className="flex-shrink-0" />
          <div className="flex-1 text-left">
            <p className="font-black text-lg">操作异常</p>
            <p className="text-sm