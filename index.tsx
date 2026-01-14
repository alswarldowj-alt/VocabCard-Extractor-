
import React, { useState, useRef, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { 
  Upload, ScanSearch, Loader2, FileSpreadsheet, 
  Archive, CheckCircle2, Image as ImageIcon,
  Trash2, FileType, XCircle, Info
} from 'lucide-react';
import { GoogleGenAI, Type } from "@google/genai";
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

// --- 类型定义 ---
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

// --- 工具函数 ---
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
        
        // 归一化坐标转像素
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
      // 实时获取 API_KEY 并初始化客户端，增加容错性
      const apiKey = (window as any).process?.env?.API_KEY || "";
      const ai = new GoogleGenAI({ apiKey: apiKey });

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
                { text: "提取这张词汇表中的所有单词。每张卡片包含一个插图和下方的单词。请按阅读顺序返回单词及其插图区域坐标 [ymin, xmin, ymax, xmax]。" }
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
          
          if (rawItems.length === 0) throw new Error("未检测到单词内容");

          for (let j = 0; j < rawItems.length; j++) {
            const item = rawItems[j];
            try {
              const { url, blob } = await cropImage(current.file, item.box_2d);
              const newItem: VocabItem = {
                id: results.length + 1, // 这里稍后更新
                word: item.word.trim(),
                fileName: current.file.name,
                croppedImageUrl: url,
                blob
              };
              setResults(prev => [...prev, { ...newItem, id: prev.length + 1 }]);
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
          console.error("处理失败:", err);
          let errMsg = err.message || "请求异常";
          if (errMsg.includes("API key not valid")) errMsg = "API 密钥配置无效";
          setFileStatuses(prev => prev.map((s, idx) => 
            idx === i ? { ...s, status: 'error', error: errMsg } : s
          ));
        }
      }
    } catch (err: any) {
      setGlobalError("识别流程异常: " + (err.message || "请检查网络或密钥"));
    } finally {
      setIsBusy(false);
    }
  };

  const exportExcel = () => {
    if (results.length === 0) return;
    const data = results.map(item => ({ '序号': item.id, '单词': item.word }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Vocabulary");
    XLSX.writeFile(wb, "词汇提取结果.xlsx");
  };

  const exportZip = async () => {
    if (results.length === 0) return;
    const zip = new JSZip();
    const folder = zip.folder("images");
    results.forEach(item => {
      if (item.blob) folder?.file(`${item.word}.jpg`, item.blob);
    });
    const content = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(content);
    const a = document.createElement('a');
    a.href = url;
    a.download = "词汇插图包.zip";
    a.click();
  };

  return (
    <div className="max-w-7xl mx-auto px-6 py-12 animate-in text-slate-800">
      <header className="text-center mb-16">
        <div className="inline-flex items-center justify-center w-20 h-20 bg-indigo-600 text-white rounded-[1.8rem] mb-6 shadow-2xl shadow-indigo-200">
          <ScanSearch size={40} strokeWidth={2.5} />
        </div>
        <h1 className="text-5xl font-black tracking-tight mb-4">批量词汇提取专家</h1>
        <p className="text-slate-500 text-xl font-medium max-w-2xl mx-auto opacity-70">
          利用智能 AI 自动分析词汇表，一键识别并切割插图与单词。
        </p>
      </header>

      {globalError && (
        <div className="mb-8 p-5 bg-rose-50 border border-rose-100 text-rose-600 rounded-3xl flex items-center gap-4 shadow-sm">
          <XCircle size={24} className="flex-shrink-0" />
          <p className="font-bold flex-1">{globalError}</p>
          <button onClick={() => setGlobalError(null)} className="text-rose-300 hover:text-rose-500 font-bold px-2">关闭</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
        <div className="lg:col-span-4 space-y-6">
          <div 
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(e) => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
            onClick={() => !isBusy && fileInputRef.current?.click()}
            className={`
              relative border-4 border-dashed rounded-[2.5rem] p-12 text-center cursor-pointer transition-all duration-300
              ${isDragging ? 'bg-indigo-50 border-indigo-500 scale-[1.02]' : 'bg-white border-slate-200 hover:border-indigo-300 hover:bg-slate-50'}
              ${isBusy ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''}
            `}
          >
            <input type="file" multiple accept="image/*" className="hidden" ref={fileInputRef} onChange={(e) => addFiles(e.target.files)} />
            <div className="flex flex-col items-center gap-4">
              <div className="w-16 h-16 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center">
                <Upload size={32} />
              </div>
              <div>
                <p className="font-bold text-lg">上传目标图片</p>
                <p className="text-slate-400 text-sm mt-1">支持批量选择、拖拽</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-[2.5rem] p-8 shadow-xl shadow-slate-200/50 border border-slate-100">
            <div className="flex justify-between items-center mb-6 pb-4 border-b border-slate-50">
              <h3 className="font-black text-slate-800 text-lg flex items-center gap-2">待处理队列 <span className="text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-lg text-sm">{fileStatuses.length}</span></h3>
              {fileStatuses.length > 0 && !isBusy && (
                <button onClick={processAll} className="bg-indigo-600 text-white px-5 py-2 rounded-xl font-bold shadow-lg hover:bg-indigo-700 transition-all active:scale-95">开始处理</button>
              )}
            </div>
            <div className="space-y-3 overflow-y-auto max-h-[400px] pr-2 custom-scrollbar">
              {fileStatuses.map((status, idx) => (
                <div key={idx} className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
                  <div className="flex items-center gap-3">
                    <ImageIcon size={18} className="text-slate-400" />
                    <p className="text-sm font-bold text-slate-600 truncate flex-1">{status.file.name}</p>
                    {status.status === 'completed' && <CheckCircle2 size={18} className="text-emerald-500" />}
                    {status.status === 'processing' && <Loader2 size={18} className="text-indigo-600 animate-spin" />}
                  </div>
                  {status.status === 'error' && <p className="text-[10px] text-rose-500 font-bold mt-2 ml-7">{status.error}</p>}
                  {status.status === 'processing' && (
                    <div className="mt-3 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                      <div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${status.progress}%` }} />
                    </div>
                  )}
                </div>
              ))}
              {fileStatuses.length === 0 && <div className="text-center py-12 text-slate-300"><FileType size={48} className="mx-auto mb-3 opacity-20" /><p className="font-bold">暂无文件</p></div>}
            </div>
          </div>
        </div>

        <div className="lg:col-span-8 space-y-6 text-left">
          {results.length > 0 && (
            <div className="grid grid-cols-2 gap-4">
              <button onClick={exportExcel} className="flex items-center justify-center gap-3 bg-white border border-slate-200 p-5 rounded-3xl font-black text-emerald-600 hover:bg-emerald-50 transition-all shadow-sm">
                <FileSpreadsheet /> 导出 Excel 表格
              </button>
              <button onClick={exportZip} className="flex items-center justify-center gap-3 bg-white border border-slate-200 p-5 rounded-3xl font-black text-amber-600 hover:bg-amber-50 transition-all shadow-sm">
                <Archive /> 导出插图 ZIP
              </button>
            </div>
          )}

          <div className="bg-white rounded-[3rem] p-10 shadow-xl shadow-slate-200/50 border border-slate-100 min-h-[600px] flex flex-col">
            <div className="flex justify-between items-center mb-8">
              <h2 className="text-3xl font-black tracking-tight">提取结果</h2>
              {results.length > 0 && <span className="bg-indigo-50 text-indigo-600 font-black px-4 py-1.5 rounded-full text-sm">已检测 {results.length} 项</span>}
            </div>

            {results.length > 0 ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-6 overflow-y-auto max-h-[800px] pr-2 custom-scrollbar">
                {results.map((item, idx) => (
                  <div key={idx} className="group bg-white border border-slate-100 rounded-3xl overflow-hidden hover:shadow-xl transition-all hover:-translate-y-2">
                    <div className="aspect-square bg-slate-50 flex items-center justify-center p-6 relative">
                      <img src={item.croppedImageUrl} className="max-w-full max-h-full object-contain drop-shadow-md group-hover:scale-110 transition-transform duration-500" />
                      <span className="absolute top-3 left-3 bg-indigo-600 text-white text-[10px] font-black px-2 py-0.5 rounded-lg shadow-lg">#{item.id}</span>
                    </div>
                    <div className="p-4 text-center border-t border-slate-50">
                      <p className="font-black text-slate-800 text-lg truncate" title={item.word}>{item.word}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center opacity-20">
                {isBusy ? (
                  <div className="text-center animate-pulse">
                    <Loader2 size={64} className="animate-spin text-indigo-600 mx-auto mb-4" />
                    <p className="text-2xl font-black">AI 正在深度识别中...</p>
                  </div>
                ) : (
                  <div className="text-center">
                    <ImageIcon size={80} className="mx-auto mb-4" />
                    <p className="text-2xl font-black">等待处理任务</p>
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

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
