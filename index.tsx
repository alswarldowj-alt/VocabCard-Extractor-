
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

// --- 类型声明 ---
interface VocabItem {
  id: number;
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

// --- 图片处理工具 ---
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
      // 严格使用系统提供的 API_KEY
      const apiKey = process.env.API_KEY;
      if (!apiKey) {
        throw new Error("检测到 API 密钥为空。请确保在环境设置中配置了有效的 API_KEY。");
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
                { text: "请识别这张词汇表中的每一张单词卡片。每张卡片上方是插图，下方是单词。请返回单词内容及其对应插图的归一化坐标 [ymin, xmin, ymax, xmax]。" }
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

          const responseText = response.text || "{}";
          const data = JSON.parse(responseText);
          const rawItems = data.items || [];
          
          if (rawItems.length === 0) throw new Error("未识别到有效内容");

          for (let j = 0; j < rawItems.length; j++) {
            const item = rawItems[j];
            try {
              const { url, blob } = await cropImage(current.file, item.box_2d);
              setResults(prev => [...prev, {
                id: prev.length + 1,
                word: item.word.trim(),
                fileName: current.file.name,
                croppedImageUrl: url,
                blob
              }]);
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
          console.error("处理异常:", err);
          let userFriendlyError = err.message || "请求异常";
          if (userFriendlyError.includes("API key")) {
            userFriendlyError = "API 密钥无效或未配置，请联系管理员。";
          }
          setFileStatuses(prev => prev.map((s, idx) => 
            idx === i ? { ...s, status: 'error', error: userFriendlyError } : s
          ));
        }
      }
    } catch (err: any) {
      setGlobalError(err.message || "初始化失败");
    } finally {
      setIsBusy(false);
    }
  };

  const exportExcel = () => {
    if (results.length === 0) return;
    const ws = XLSX.utils.json_to_sheet(results.map(r => ({ '序号': r.id, '单词': r.word })));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Vocabulary");
    XLSX.writeFile(wb, "词汇表.xlsx");
  };

  const exportZip = async () => {
    if (results.length === 0) return;
    const zip = new JSZip();
    const folder = zip.folder("images");
    results.forEach(item => {
      if (item.blob) folder?.file(`${item.word}.jpg`, item.blob);
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = "词汇插图包.zip";
    link.click();
  };

  return (
    <div className="max-w-6xl mx-auto px-6 py-12 animate-in">
      <header className="text-center mb-16">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-indigo-600 text-white rounded-2xl mb-6 shadow-xl">
          <ScanSearch size={32} />
        </div>
        <h1 className="text-4xl font-black text-slate-900 mb-2">批量词汇提取专家</h1>
        <p className="text-slate-500 font-medium">智能识别词汇表，自动切割插图并整理单词</p>
      </header>

      {globalError && (
        <div className="mb-8 p-4 bg-rose-50 border border-rose-100 text-rose-600 rounded-2xl flex items-center gap-3 shadow-sm">
          <XCircle size={20} />
          <p className="font-bold flex-1">{globalError}</p>
          <button onClick={() => setGlobalError(null)} className="text-rose-300 hover:text-rose-500 p-1">关闭</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        <div className="lg:col-span-4 space-y-6">
          <div 
            onClick={() => !isBusy && fileInputRef.current?.click()}
            className={`
              p-10 border-4 border-dashed rounded-3xl text-center cursor-pointer transition-all
              ${isBusy ? 'opacity-50 pointer-events-none' : 'hover:border-indigo-400 hover:bg-indigo-50/30 border-slate-200 bg-white shadow-sm'}
            `}
          >
            <input type="file" multiple accept="image/*" className="hidden" ref={fileInputRef} onChange={(e) => addFiles(e.target.files)} />
            <Upload size={32} className="mx-auto text-indigo-600 mb-4" />
            <p className="font-bold text-slate-700">点击上传图片</p>
            <p className="text-xs text-slate-400 mt-1">支持批量多选</p>
          </div>

          <div className="bg-white rounded-3xl p-6 shadow-xl border border-slate-100 min-h-[300px]">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-black text-slate-800">任务队列 ({fileStatuses.length})</h3>
              {fileStatuses.length > 0 && !isBusy && (
                <button onClick={processAll} className="bg-indigo-600 text-white px-4 py-1.5 rounded-lg text-sm font-bold shadow-lg hover:bg-indigo-700 transition-colors">开始处理</button>
              )}
            </div>
            <div className="space-y-3 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar text-left">
              {fileStatuses.map((status, idx) => (
                <div key={idx} className="p-3 bg-slate-50 rounded-xl border border-slate-100">
                  <div className="flex items-center gap-2">
                    <ImageIcon size={14} className="text-slate-400" />
                    <p className="text-xs font-bold text-slate-600 truncate flex-1">{status.file.name}</p>
                    {status.status === 'completed' && <CheckCircle2 size={16} className="text-emerald-500" />}
                    {status.status === 'processing' && <Loader2 size={16} className="text-indigo-600 animate-spin" />}
                    {status.status === 'error' && <XCircle size={16} className="text-rose-500" />}
                  </div>
                  {status.status === 'error' && <p className="text-[10px] text-rose-500 mt-1 ml-6 font-semibold">{status.error}</p>}
                  {status.status === 'processing' && (
                    <div className="mt-2 h-1 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${status.progress}%` }}></div>
                    </div>
                  )}
                </div>
              ))}
              {fileStatuses.length === 0 && <p className="text-center py-10 text-slate-300 font-bold italic">暂无图片</p>}
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 space-y-6">
          {results.length > 0 && (
            <div className="grid grid-cols-2 gap-4">
              <button onClick={exportExcel} className="bg-emerald-600 text-white p-4 rounded-2xl font-bold flex items-center justify-center gap-2 shadow-lg hover:bg-emerald-700 transition-all"><FileSpreadsheet size={20}/> 导出 Excel</button>
              <button onClick={exportZip} className="bg-amber-600 text-white p-4 rounded-2xl font-bold flex items-center justify-center gap-2 shadow-lg hover:bg-amber-700 transition-all"><Archive size={20}/> 导出资源包</button>
            </div>
          )}

          <div className="bg-white rounded-3xl p-8 shadow-xl border border-slate-100 min-h-[600px] text-left">
            <h2 className="text-2xl font-black mb-8">提取结果 {results.length > 0 && `(${results.length})`}</h2>
            
            {results.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-6 overflow-y-auto max-h-[700px] pr-2 custom-scrollbar">
                {results.map((item, idx) => (
                  <div key={idx} className="bg-slate-50 border border-slate-100 rounded-2xl overflow-hidden hover:shadow-md transition-shadow">
                    <div className="aspect-square flex items-center justify-center p-4 bg-white relative">
                      <img src={item.croppedImageUrl} className="max-w-full max-h-full object-contain" />
                      <span className="absolute top-2 left-2 bg-indigo-600 text-white text-[10px] px-1.5 py-0.5 rounded font-black">#{item.id}</span>
                    </div>
                    <div className="p-3 text-center border-t border-slate-50">
                      <p className="font-bold text-slate-800 truncate" title={item.word}>{item.word}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="h-full flex flex-col items-center justify-center text-slate-200 py-32">
                {isBusy ? <Loader2 size={64} className="animate-spin mb-4 text-indigo-100" /> : <ImageIcon size={80} className="mb-4 opacity-20" />}
                <p className="text-xl font-black italic opacity-20">等待任务开始</p>
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
