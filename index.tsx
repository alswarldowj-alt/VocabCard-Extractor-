
import React, { useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Upload, ScanSearch, Loader2, FileSpreadsheet, 
  Archive, CheckCircle2, AlertCircle, Image as ImageIcon,
  Trash2, FileType, XCircle
} from 'lucide-react';
import { GoogleGenAI, Type } from "@google/genai";
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

// --- Types ---
interface VocabItem {
  globalId: number;
  localId: number;
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
      reject("图片加载失败");
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
    const newFiles = Array.from(files).filter(f => f.type.startsWith('image/')).map(file => ({
      file,
      status: 'pending' as const,
      progress: 0
    }));
    setFileStatuses(prev => [...prev, ...newFiles]);
    setGlobalError(null);
  };

  const processAll = async () => {
    if (fileStatuses.length === 0 || isBusy) return;
    
    const apiKey = process.env.API_KEY;
    if (!apiKey || apiKey === "undefined") {
      setGlobalError("检测到 API Key 缺失。请检查 GitHub Secrets 或环境变量配置。");
      return;
    }

    setIsBusy(true);
    setGlobalError(null);
    setResults([]);

    const ai = new GoogleGenAI({ apiKey });
    let currentGlobalCount = 0;

    for (let i = 0; i < fileStatuses.length; i++) {
      const current = fileStatuses[i];
      if (current.status === 'completed') continue;

      setFileStatuses(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'processing', progress: 5, error: undefined } : s));

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
                      box_2d: { type: Type.ARRAY, items: { type: Type.NUMBER } }
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
            currentGlobalCount++;
            const newItem: VocabItem = {
              globalId: currentGlobalCount, 
              localId: j + 1, 
              word: item.word,
              fileName: current.file.name,
              croppedImageUrl: url,
              blob
            };
            fileResults.push(newItem);
            // 增量更新结果，避免长时间等待
            setResults(prev => [...prev, newItem]);
          } catch (err) { console.error("裁剪失败:", err); }
          setFileStatuses(prev => prev.map((s, idx) => idx === i ? { ...s, progress: 10 + ((j + 1) / rawItems.length) * 90 } : s));
        }

        setFileStatuses(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'completed', progress: 100 } : s));
      } catch (err: any) {
        console.error("处理单张图片失败:", err);
        setFileStatuses(prev => prev.map((s, idx) => idx === i ? { ...s, status: 'error', error: err.message || "未知错误" } : s));
      }
    }
    setIsBusy(false);
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
    XLSX.writeFile(wb, `词汇表_${new Date().toLocaleDateString()}.xlsx`);
  };

  const exportZip = async () => {
    if (results.length === 0) return;
    const zip = new JSZip();
    const folder = zip.folder("extracted_images");
    results.forEach(item => {
      if (item.blob) {
        // 名字必须与 Excel 中的单词一致，且不带序号
        folder?.file(`${item.word}.jpg`, item.blob);
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
    <div className="max-w-6xl mx-auto px-4 pb-20 select-none animate-in">
      <header className="text-center mb-10 pt-8">
        <div className="inline-flex items-center justify-center p-3 bg-indigo-100 text-indigo-600 rounded-2xl mb-4 shadow-sm">
          <ScanSearch size={32} />
        </div>
        <h1 className="text-4xl font-extrabold text-slate-900 tracking-tight">批量词汇提取专家</h1>
        <p className="text-slate-500 text-lg max-w-2xl mx-auto mt-2">上传图片批量识别单词。自动切割插图并生成 Excel 单词表。</p>
      </header>

      {globalError && (
        <div className="mb-8 p-4 bg-rose-50 border border-rose-100 text-rose-600 rounded-2xl flex items-center gap-3 animate-bounce">
          <XCircle size={20} />
          <p className="font-bold">{globalError}</p>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-4 space-y-6">
          <div 
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
            onClick={() => !isBusy && fileInputRef.current?.click()}
            className={`relative border-3 border-dashed rounded-[2rem] p-10 text-center cursor-pointer transition-all duration-300
              ${isBusy ? 'bg-slate-50 border-slate-200 opacity-60' : isDragging ? 'bg-indigo-50 border-indigo-500 scale-102 ring-4 ring-indigo-100' : 'bg-white border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/30 shadow-sm'}`}
          >
            <input type="file" multiple accept="image/*" className="hidden" ref={fileInputRef} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            <div className="flex flex-col items-center gap-4">
              <div className={`w-20 h-20 rounded-3xl flex items-center justify-center transition-colors shadow-sm ${isDragging ? 'bg-indigo-600 text-white' : 'bg-indigo-50 text-indigo-600'}`}>
                <Upload size={40} className={isDragging ? 'animate-bounce' : ''} />
              </div>
              <p className="font-bold text-xl text-slate-800">点此上传 或 拖拽至此</p>
            </div>
          </div>

          <div className="bg-white rounded-[2rem] p-6 shadow-sm border border-slate-100 flex flex-col min-h-[400px]">
            <div className="flex justify-between items-center mb-6 pb-2 border-b border-slate-50">
              <h3 className="font-bold text-slate-800 flex items-center gap-2 text-lg">待处理队列 <span className="bg-indigo-50 text-indigo-600 px-2.5 py-0.5 rounded-full text-xs font-bold">{fileStatuses.length}</span></h3>
              {fileStatuses.length > 0 && !isBusy && <button onClick={processAll} className="bg-indigo-600 text-white px-4 py-1.5 rounded-full text-sm font-bold shadow-md hover:bg-indigo-700 transition-all">开始识别</button>}
            </div>
            <div className="space-y-3 overflow-y-auto max-h-[500px] pr-2 custom-scrollbar">
              {fileStatuses.map((status, idx) => (
                <div key={idx} className={`group flex flex-col p-4 rounded-2xl border transition-all ${status.status === 'error' ? 'bg-rose-50 border-rose-100' : 'bg-slate-50/50 border-slate-100'}`}>
                  <div className="flex items-center gap-3">
                    <ImageIcon size={16} className={status.status === 'error' ? 'text-rose-400' : 'text-slate-400'} />
                    <span className="text-sm font-bold text-slate-700 truncate flex-1">{status.file.name}</span>
                    {!isBusy && status.status !== 'processing' && <button onClick={() => setFileStatuses(prev => prev.filter((_, i) => i !== idx))} className="text-slate-300 hover:text-rose-500"><Trash2 size={16} /></button>}
                    {status.status === 'completed' && <CheckCircle2 size={18} className="text-emerald-500" />}
                    {status.status === 'error' && <AlertCircle size={18} className="text-rose-500" />}
                    {status.status === 'processing' && <Loader2 size={18} className="text-indigo-600 animate-spin" />}
                  </div>
                  {status.status === 'error' && <p className="text-[10px] text-rose-500 font-bold mt-1">失败: {status.error}</p>}
                  {(status.status === 'processing' || status.status === 'completed') && (
                    <div className="mt-3 flex items-center gap-3">
                      <div className="h-1.5 flex-1 bg-slate-200 rounded-full overflow-hidden">
                        <div className={`h-full transition-all duration-300 ${status.status === 'completed' ? 'bg-emerald-500' : 'bg-indigo-600'}`} style={{ width: `${status.progress}%` }} />
                      </div>
                      <span className="text-[10px] font-bold text-slate-400">{Math.round(status.progress)}%</span>
                    </div>
                  )}
                </div>
              ))}
              {fileStatuses.length === 0 && <div className="flex flex-col items-center justify-center py-20 text-slate-400 opacity-40 text-center"><FileType size={48} className="mb-4" /><p className="text-sm font-medium">请先上传图片文件</p></div>}
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 space-y-6">
          {results.length > 0 && (
            <div className="grid grid-cols-2 gap-4 animate-in">
              <button onClick={exportExcel} className="bg-white border border-emerald-100 hover:bg-emerald-600 hover:text-white p-5 rounded-3xl font-bold flex items-center justify-center gap-3 shadow-sm transition-all hover:-translate-y-1">
                <FileSpreadsheet size={24} /> 导出 Excel 词汇表
              </button>
              <button onClick={exportZip} className="bg-white border border-amber-100 hover:bg-amber-600 hover:text-white p-5 rounded-3xl font-bold flex items-center justify-center gap-3 shadow-sm transition-all hover:-translate-y-1">
                <Archive size={24} /> 导出插图 ZIP 包
              </button>
            </div>
          )}
          <div className="bg-white rounded-[2rem] p-8 shadow-sm border border-slate-100 min-h-[600px] flex flex-col">
            <h3 className="text-2xl font-black text-slate-900 mb-8">识别结果</h3>
            {results.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6 overflow-y-auto max-h-[800px] pr-2 custom-scrollbar">
                {results.map((item, idx) => (
                  <div key={idx} className="group bg-slate-50/50 rounded-2xl border border-slate-100 overflow-hidden hover:shadow-xl transition-all border-b-4 border-b-slate-200">
                    <div className="aspect-square bg-white flex items-center justify-center p-4 relative">
                      <img src={item.croppedImageUrl} alt={item.word} className="max-w-full max-h-full object-contain" />
                      <div className="absolute top-2 left-2 flex gap-1">
                        <span className="text-[10px] font-black bg-indigo-600 text-white px-2 py-0.5 rounded shadow-sm">#{idx + 1}</span>
                      </div>
                    </div>
                    <div className="p-4 bg-white border-t border-slate-100 text-center">
                      <p className="font-black text-slate-900 text-lg truncate mb-1">{item.word}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center py-20 text-slate-300">
                {isBusy ? <div className="text-center"><Loader2 className="animate-spin text-indigo-600 mb-4" size={64} /><p className="text-xl font-black text-slate-800">正在拼命处理中...</p><p className="text-sm text-slate-400 mt-2">请稍等，识别结果将陆续出现</p></div> : <p className="text-xl font-black text-slate-400">目前没有任何提取的数据</p>}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) { createRoot(rootElement).render(<App />); }
