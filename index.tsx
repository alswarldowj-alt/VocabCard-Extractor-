
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
      // 修复核心：使用 typeof 检查 process 变量，防止在浏览器中抛出 ReferenceError
      // 同时依然引用规范要求的 process.env.API_KEY
      const apiKey = typeof process !== 'undefined' ? process.env.API_KEY : (globalThis as any).process?.env?.API_KEY;
      
      if (!apiKey) {
        throw new Error("API Key 未配置，请检查环境设置。");
      }

      const ai = new GoogleGenAI({ apiKey });

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
            throw new Error("未在此图片中检测到卡片");
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
              console.error("裁剪失败:", err);
            }
            
            setFileStatuses(prev => prev.map((s, idx) => 
              idx === i ? { ...s, progress: 10 + ((j + 1) / rawItems.length) * 90 } : s
            ));
          }

          setFileStatuses(prev => prev.map((s, idx) => 
            idx === i ? { ...s, status: 'completed', progress: 100 } : s
          ));
        } catch (err: any) {
          console.error("单文件处理错误:", err);
          setFileStatuses(prev => prev.map((s, idx) => 
            idx === i ? { ...s, status: 'error', error: err.message || "请求失败" } : s
          ));
        }
      }
    } catch (err: any) {
      console.error("全局处理错误:", err);
      setGlobalError("识别中断: " + (err.message || "请检查网络或配置"));
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
    XLSX.writeFile(wb, `词汇提取表_${new Date().getTime()}.xlsx`);
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
          <div className="flex-1">
            <p className="font-black text-lg">无法执行操作</p>
            <p className="text-sm font-bold opacity-80">{globalError}</p>
          </div>
          <button onClick={() => setGlobalError(null)} className="text-rose-300 hover:text-rose-500 font-black">关闭</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
        <div className="lg:col-span-4 space-y-8">
          <div 
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
            onClick={() => !isBusy && fileInputRef.current?.click()}
            className={`
              relative border-4 border-dashed rounded-[3rem] p-12 text-center cursor-pointer transition-all duration-500
              ${isBusy ? 'bg-slate-100 border-slate-200 opacity-60 cursor-not-allowed' : 
                isDragging ? 'bg-indigo-50 border-indigo-500 scale-[1.03] ring-8 ring-indigo-50' : 
                'bg-white border-slate-200 hover:border-indigo-400 hover:bg-indigo-50/20 shadow-xl shadow-slate-200/50'}
            `}
          >
            <input type="file" multiple accept="image/*" className="hidden" ref={fileInputRef} onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
            <div className="flex flex-col items-center gap-6">
              <div className={`w-24 h-24 rounded-[2.2rem] flex items-center justify-center transition-all duration-500 shadow-xl ${isDragging ? 'bg-indigo-600 text-white rotate-12' : 'bg-indigo-50 text-indigo-600'}`}>
                <Upload size={48} strokeWidth={2.5} />
              </div>
              <div>
                <p className="font-black text-2xl text-slate-800">导入素材图片</p>
                <p className="text-slate-400 font-bold mt-2 text-sm">支持批量多选、拖拽</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-[3rem] p-10 shadow-2xl shadow-slate-200/40 border border-slate-100 flex flex-col min-h-[450px]">
            <div className="flex justify-between items-center mb-8 pb-5 border-b border-slate-50">
              <h3 className="font-black text-slate-800 flex items-center gap-3 text-xl">待处理队列 <span className="bg-indigo-600 text-white px-3 py-1 rounded-2xl text-xs font-black">{fileStatuses.length}</span></h3>
              {fileStatuses.length > 0 && !isBusy && (
                <button onClick={processAll} className="bg-indigo-600 text-white px-8 py-2.5 rounded-2xl font-black shadow-xl hover:bg-indigo-700 transition-all active:scale-95">开始识别</button>
              )}
            </div>
            <div className="space-y-4 overflow-y-auto max-h-[550px] pr-2 custom-scrollbar">
              {fileStatuses.map((status, idx) => (
                <div key={idx} className={`flex flex-col p-6 rounded-[2rem] border-2 transition-all duration-300 ${status.status === 'error' ? 'bg-rose-50 border-rose-100' : 'bg-slate-50/50 border-slate-100 hover:bg-white hover:shadow-xl'}`}>
                  <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-2xl flex items-center justify-center border shadow-sm ${status.status === 'error' ? 'bg-rose-100 border-rose-200' : 'bg-white border-slate-100'}`}>
                      <ImageIcon size={22} className={status.status === 'error' ? 'text-rose-500' : 'text-slate-400'} />
                    </div>
                    <div className="flex-1 min-w-0 text-left">
                      <p className="text-sm font-black text-slate-700 truncate">{status.file.name}</p>
                      {status.status === 'error' && <p className="text-[10px] text-rose-500 font-bold truncate mt-1">{status.error}</p>}
                    </div>
                    {!isBusy && status.status !== 'processing' && (
                      <button onClick={() => setFileStatuses(prev => prev.filter((_, i) => i !== idx))} className="text-slate-300 hover:text-rose-500 p-2"><Trash2 size={20} /></button>
                    )}
                    {status.status === 'completed' && <CheckCircle2 size={24} className="text-emerald-500" />}
                    {status.status === 'processing' && <Loader2 size={24} className="text-indigo-600 animate-spin" />}
                  </div>
                  {(status.status === 'processing' || status.status === 'completed') && (
                    <div className="mt-5 flex items-center gap-4">
                      <div className="h-2.5 flex-1 bg-slate-200 rounded-full overflow-hidden shadow-inner"><div className={`h-full transition-all duration-700 ${status.status === 'completed' ? 'bg-emerald-500' : 'bg-indigo-600'}`} style={{ width: `${status.progress}%` }} /></div>
                      <span className="text-xs font-black text-slate-400 w-10 text-right">{Math.round(status.progress)}%</span>
                    </div>
                  )}
                </div>
              ))}
              {fileStatuses.length === 0 && <div className="flex flex-col items-center justify-center py-28 text-slate-300 opacity-40 text-center"><FileType size={72} strokeWidth={1.5} className="mb-6" /><p className="text-xl font-black">队列为空</p></div>}
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 space-y-8">
          {results.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 animate-in">
              <button onClick={exportExcel} className="group bg-white border-4 border-emerald-100 hover:bg-emerald-600 p-8 rounded-[3rem] font-black flex items-center justify-center gap-5 shadow-2xl transition-all hover:-translate-y-2">
                <FileSpreadsheet size={40} className="text-emerald-600 group-hover:text-white" /> 
                <div className="text-left"><span className="block text-2xl text-emerald-800 group-hover:text-white">导出 Excel</span></div>
              </button>
              <button onClick={exportZip} className="group bg-white border-4 border-amber-100 hover:bg-amber-600 p-8 rounded-[3rem] font-black flex items-center justify-center gap-5 shadow-2xl transition-all hover:-translate-y-2">
                <Archive size={40} className="text-amber-600 group-hover:text-white" /> 
                <div className="text-left"><span className="block text-2xl text-amber-800 group-hover:text-white">导出插图包</span></div>
              </button>
            </div>
          )}

          <div className="bg-white rounded-[3.5rem] p-12 shadow-2xl shadow-slate-200/40 border border-slate-100 min-h-[650px] flex flex-col text-left">
            <div className="flex justify-between items-center mb-12">
              <h3 className="text-4xl font-black text-slate-900 tracking-tight">提取结果</h3>
              {results.length > 0 && <span className="text-sm font-black text-indigo-600 bg-indigo-50 px-6 py-2.5 rounded-full uppercase tracking-widest border border-indigo-100">Detected {results.length} Items</span>}
            </div>

            {results.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-10 overflow-y-auto max-h-[850px] pr-4 custom-scrollbar">
                {results.map((item, idx) => (
                  <div key={idx} className="group bg-slate-50/50 rounded-[2.5rem] border-2 border-slate-100 overflow-hidden hover:shadow-2xl transition-all border-b-[10px] border-b-slate-200 hover:border-b-indigo-500 hover:-translate-y-3">
                    <div className="aspect-square bg-white flex items-center justify-center p-8 relative">
                      <img src={item.croppedImageUrl} alt={item.word} className="max-w-full max-h-full object-contain drop-shadow-xl transition-transform duration-700 group-hover:scale-125" />
                      <div className="absolute top-5 left-5"><span className="text-xs font-black bg-indigo-600 text-white px-3.5 py-1.5 rounded-xl shadow-xl">#{idx + 1}</span></div>
                    </div>
                    <div className="p-8 bg-white border-t-2 border-slate-100 text-center">
                      <p className="font-black text-slate-900 text-2xl truncate mb-1" title={item.word}>{item.word}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center py-32 text-slate-300">
                {isBusy ? (
                  <div className="text-center">
                    <Loader2 className="animate-spin text-indigo-600 mx-auto mb-10" size={96} strokeWidth={2.5} />
                    <p className="text-3xl font-black text-slate-800">AI 正在深度识别中...</p>
                  </div>
                ) : (
                  <div className="text-center opacity-30">
                    <div className="w-44 h-44 bg-slate-50 rounded-full flex items-center justify-center mb-10 mx-auto shadow-inner"><ImageIcon size={72} className="text-slate-300" /></div>
                    <p className="text-3xl font-black italic tracking-tighter">等待任务开始</p>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const rootElement = document.getElementById('root');
if (rootElement) { 
  createRoot(rootElement).render(<App />); 
}
