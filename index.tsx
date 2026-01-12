
import React, { useState, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Upload, ScanSearch, Loader2, FileSpreadsheet, 
  Archive, CheckCircle2, AlertCircle, Image as ImageIcon,
  Trash2, FileType
} from 'lucide-react';
import { GoogleGenAI, Type } from "@google/genai";
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

// --- Types ---
interface VocabItem {
  globalId: number;
  localId: number; // 序号 (原图)
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
    reader.onerror = reject;
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
          else reject("Blob creation failed");
          URL.revokeObjectURL(img.src);
        }, 'image/jpeg', 0.9);
      } catch (e) {
        URL.revokeObjectURL(img.src);
        reject(e);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(img.src);
      reject("Image load failed");
    };
  });
};

// --- Components ---
const Header = () => (
  <header className="text-center mb-10 pt-8">
    <div className="inline-flex items-center justify-center p-3 bg-indigo-100 text-indigo-600 rounded-2xl mb-4 shadow-sm">
      <ScanSearch size={32} />
    </div>
    <h1 className="text-4xl font-extrabold text-slate-900 tracking-tight">批量词汇提取专家</h1>
    <p className="text-slate-500 text-lg max-w-2xl mx-auto mt-2">
      上传图片批量识别单词。自动切割插图并生成带序号的 Excel 单词表。
    </p>
  </header>
);

const App = () => {
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
  const [results, setResults] = useState<VocabItem[]>([]);
  const [isBusy, setIsBusy] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const newFiles = Array.from(files).filter(f => f.type.startsWith('image/')).map(file => ({
      file,
      status: 'pending' as const,
      progress: 0
    }));
    setFileStatuses(prev => [...prev, ...newFiles]);
  };

  const handleFileSelection = (e: React.ChangeEvent<HTMLInputElement>) => {
    addFiles(e.target.files);
    e.target.value = ''; 
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => {
    setIsDragging(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const removeFile = (index: number) => {
    setFileStatuses(prev => prev.filter((_, i) => i !== index));
  };

  const processAll = async () => {
    if (fileStatuses.length === 0 || isBusy) return;
    setIsBusy(true);
    setResults([]);

    const apiKey = process.env.API_KEY;
    if (!apiKey) {
      alert("API Key missing. Please ensure your environment is configured correctly.");
      setIsBusy(false);
      return;
    }

    const ai = new GoogleGenAI({ apiKey });
    const allExtractedItems: VocabItem[] = [];

    for (let i = 0; i < fileStatuses.length; i++) {
      const current = fileStatuses[i];
      if (current.status === 'completed') continue;

      setFileStatuses(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'processing', progress: 5 } : s));

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
                      box_2d: { type: Type.ARRAY, items: { type: Type.NUMBER }, description: "插图的坐标 [ymin, xmin, ymax, xmax]" }
                    },
                    required: ["word", "box_2d"]
                  }
                }
              }
            }
          }
        });

        const data = JSON.parse(response.text || '{"items":[]}');
        const rawItems = data.items || [];
        const fileResults: VocabItem[] = [];

        for (let j = 0; j < rawItems.length; j++) {
          const item = rawItems[j];
          try {
            const { url, blob } = await cropImage(current.file, item.box_2d);
            fileResults.push({
              globalId: 0, 
              localId: j + 1, 
              word: item.word,
              fileName: current.file.name,
              croppedImageUrl: url,
              blob
            });
          } catch (err) {
            console.error("Crop error", err);
          }
          const progress = 10 + ((j + 1) / rawItems.length) * 90;
          setFileStatuses(prev => prev.map((s, idx) => idx === i ? { ...s, progress } : s));
        }

        allExtractedItems.push(...fileResults);
        setFileStatuses(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'completed', progress: 100 } : s));
      } catch (err) {
        console.error(err);
        setFileStatuses(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'error', error: String(err) } : s));
      }
    }

    const finalResults = allExtractedItems.map((item, idx) => ({
      ...item,
      globalId: idx + 1
    }));

    setResults(finalResults);
    setIsBusy(false);
  };

  const exportExcel = () => {
    if (results.length === 0) return;
    
    // 更新导出逻辑：仅包含 序号 和 单词
    const exportData = results.map(item => ({
      '序号': item.globalId, 
      '单词': item.word
    }));

    const ws = XLSX.utils.json_to_sheet(exportData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Vocabulary");
    XLSX.writeFile(wb, `词汇表_${new Date().toLocaleDateString()}.xlsx`);
  };

  const exportZip = async () => {
    if (results.length === 0) return;
    
    const zip = new JSZip();
    const folder = zip.folder("extracted_images");
    results.forEach(item => {
      if (item.blob) {
        // 去除序号信息，名字和导出的Excel中的名字要一模一样（包括大小写）
        const fileName = `${item.word}.jpg`;
        folder?.file(fileName, item.blob);
      }
    });
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = `插图导出_${new Date().getTime()}.zip`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 pb-20 select-none">
      <Header />

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-4 space-y-6">
          <div 
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            onClick={() => !isBusy && fileInputRef.current?.click()}
            className={`
              relative border-3 border-dashed rounded-[2rem] p-10 text-center cursor-pointer transition-all duration-300
              ${isBusy ? 'bg-slate-50 border-slate-200 cursor-not-allowed opacity-60' : 
                isDragging ? 'bg-indigo-50 border-indigo-500 scale-102 ring-4 ring-indigo-100' : 
                'bg-white border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/30 shadow-sm'}
            `}
          >
            <input type="file" multiple accept="image/*" className="hidden" ref={fileInputRef} onChange={handleFileSelection} />
            <div className="flex flex-col items-center gap-4">
              <div className={`w-20 h-20 rounded-3xl flex items-center justify-center transition-colors shadow-sm ${isDragging ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-600'}`}>
                <Upload size={40} className={isDragging ? 'animate-bounce' : ''} />
              </div>
              <div>
                <p className="font-bold text-xl text-slate-800">点此上传 或 拖拽至此</p>
                <p className="text-sm text-slate-500 mt-2">支持多选、批量上传卡片大图</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100 flex flex-col min-h-[400px]">
            <div className="flex justify-between items-center mb-6 pb-2 border-b border-slate-50">
              <h3 className="font-bold text-slate-800 flex items-center gap-2 text-lg">
                待处理队列 <span className="bg-indigo-50 text-indigo-600 px-2.5 py-0.5 rounded-full text-xs font-bold">{fileStatuses.length}</span>
              </h3>
              {fileStatuses.length > 0 && !isBusy && (
                <button 
                  onClick={processAll} 
                  className="bg-indigo-600 text-white px-4 py-1.5 rounded-full text-sm font-bold shadow-md shadow-indigo-100 hover:bg-indigo-700 transition-all hover:scale-105"
                >
                  开始识别
                </button>
              )}
            </div>
            
            <div className="space-y-3 overflow-y-auto max-h-[500px] pr-2 custom-scrollbar">
              {fileStatuses.map((status, idx) => (
                <div key={idx} className="group flex flex-col p-4 bg-slate-50/50 rounded-2xl border border-slate-100 transition-all hover:bg-white hover:shadow-md">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-white flex items-center justify-center border border-slate-100">
                      <ImageIcon size={16} className="text-slate-400" />
                    </div>
                    <span className="text-sm font-bold text-slate-700 truncate flex-1">{status.file.name}</span>
                    {!isBusy && status.status !== 'processing' && (
                      <button onClick={() => removeFile(idx)} className="text-slate-300 hover:text-rose-500 transition-colors">
                        <Trash2 size={16} />
                      </button>
                    )}
                    {status.status === 'completed' && <CheckCircle2 size={18} className="text-emerald-500" />}
                    {status.status === 'error' && <AlertCircle size={18} className="text-rose-500" />}
                  </div>
                  {(status.status === 'processing' || status.status === 'completed') && (
                    <div className="mt-3 flex items-center gap-3">
                      <div className="h-1.5 flex-1 bg-slate-200 rounded-full overflow-hidden">
                        <div 
                          className={`h-full transition-all duration-300 ${status.status === 'completed' ? 'bg-emerald-500' : 'bg-indigo-600 animate-pulse'}`} 
                          style={{ width: `${status.progress}%` }} 
                        />
                      </div>
                      <span className="text-[10px] font-bold text-slate-400">{Math.round(status.progress)}%</span>
                    </div>
                  )}
                </div>
              ))}
              {fileStatuses.length === 0 && (
                <div className="flex flex-col items-center justify-center py-20 text-slate-400 opacity-40">
                  <FileType size={48} className="mb-4" />
                  <p className="text-sm font-medium">请先上传图片文件</p>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 space-y-6">
          {results.length > 0 && (
            <div className="grid grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-4 duration-500">
              <button onClick={exportExcel} className="group relative bg-white border border-emerald-100 hover:bg-emerald-600 hover:text-white p-5 rounded-3xl font-bold flex items-center justify-center gap-3 shadow-sm transition-all hover:-translate-y-1 overflow-hidden">
                <FileSpreadsheet size={24} className="text-emerald-600 group-hover:text-white" /> 
                <span className="text-emerald-800 group-hover:text-white">导出 Excel 词汇表</span>
              </button>
              <button onClick={exportZip} className="group relative bg-white border border-amber-100 hover:bg-amber-600 hover:text-white p-5 rounded-3xl font-bold flex items-center justify-center gap-3 shadow-sm transition-all hover:-translate-y-1 overflow-hidden">
                <Archive size={24} className="text-amber-600 group-hover:text-white" /> 
                <span className="text-amber-800 group-hover:text-white">导出插图 ZIP 包</span>
              </button>
            </div>
          )}

          <div className="bg-white rounded-[2rem] p-8 shadow-sm border border-slate-100 min-h-[600px] flex flex-col">
            <div className="flex justify-between items-center mb-8">
              <h3 className="text-2xl font-black text-slate-900">识别结果</h3>
              {results.length > 0 && (
                <span className="text-sm font-bold text-slate-400">共找到 {results.length} 个单词</span>
              )}
            </div>

            {results.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6 overflow-y-auto max-h-[800px] pr-2 custom-scrollbar">
                {results.map((item) => (
                  <div key={item.globalId} className="group bg-slate-50/50 rounded-2xl border border-slate-100 overflow-hidden hover:shadow-xl transition-all border-b-4 border-b-slate-200 hover:border-b-indigo-400">
                    <div className="aspect-square bg-white flex items-center justify-center p-4 relative group-hover:bg-slate-50 transition-colors">
                      <img src={item.croppedImageUrl} alt={item.word} className="max-w-full max-h-full object-contain drop-shadow-sm group-hover:scale-110 transition-transform" />
                      <div className="absolute top-2 left-2 flex gap-1">
                        <span className="text-[10px] font-black bg-indigo-600 text-white px-2 py-0.5 rounded shadow-sm">原图#{item.localId}</span>
                        <span className="text-[10px] font-black bg-slate-800 text-white px-2 py-0.5 rounded shadow-sm opacity-0 group-hover:opacity-100 transition-opacity">总#{item.globalId}</span>
                      </div>
                    </div>
                    <div className="p-4 bg-white border-t border-slate-100 text-center">
                      <p className="font-black text-slate-900 text-lg truncate mb-1" title={item.word}>{item.word}</p>
                      <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest truncate">{item.fileName}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center py-20 text-slate-300">
                {isBusy ? (
                  <div className="flex flex-col items-center gap-6">
                    <div className="relative">
                      <Loader2 className="animate-spin text-indigo-600" size={64} strokeWidth={3} />
                      <div className="absolute inset-0 flex items-center justify-center">
                         <div className="w-2 h-2 bg-indigo-400 rounded-full animate-ping" />
                      </div>
                    </div>
                    <div className="text-center">
                      <p className="text-xl font-black text-slate-800">正在拼命处理中...</p>
                      <p className="text-sm font-bold text-slate-400 mt-2 italic">Gemini 正在分析您的卡片布局并切割插图</p>
                    </div>
                  </div>
                ) : (
                  <div className="text-center">
                    <div className="w-32 h-32 bg-slate-50 rounded-full flex items-center justify-center mb-6 mx-auto opacity-50 shadow-inner">
                      <ImageIcon size={48} className="text-slate-300" />
                    </div>
                    <p className="text-xl font-black text-slate-400">目前没有任何提取的数据</p>
                    <p className="text-sm font-bold text-slate-300 mt-2">请从左侧面板开始操作</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      
      <style>{`
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .animate-in { animation: fadeIn 0.5s ease-out; }
        .scale-102 { transform: scale(1.02); }
        .custom-scrollbar::-webkit-scrollbar { width: 6px; }
        .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
        .custom-scrollbar::-webkit-scrollbar-thumb { background: #e2e8f0; border-radius: 10px; }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #cbd5e1; }
      `}</style>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) {
  const root = createRoot(rootElement);
  root.render(<App />);
}
