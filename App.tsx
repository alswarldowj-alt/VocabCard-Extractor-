import React, { useState } from 'react';
import { Header } from './components/Header.tsx';
import { FileUploader } from './components/FileUploader.tsx';
import { ResultPreview } from './components/ResultPreview.tsx';
import { processImages } from './services/processService.ts';
import { exportToExcel, exportToZip } from './utils/fileExporter.ts';
import { VocabItem, ProcessingStatus } from './types.ts';
import { Loader2, FileSpreadsheet, Archive } from 'lucide-react';

const App: React.FC = () => {
  const [images, setImages] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [results, setResults] = useState<VocabItem[]>([]);
  const [statuses, setStatuses] = useState<ProcessingStatus[]>([]);

  const handleFilesSelected = (files: File[]) => {
    setImages(files);
    setResults([]);
    setStatuses(files.map(f => ({ fileName: f.name, status: 'pending', progress: 0 })));
  };

  const startProcessing = async () => {
    if (images.length === 0) return;
    setIsProcessing(true);
    setResults([]);

    try {
      const allResults: VocabItem[] = [];
      
      for (let i = 0; i < images.length; i++) {
        const file = images[i];
        
        setStatuses(prev => prev.map((s, idx) => 
          idx === i ? { ...s, status: 'processing' } : s
        ));

        try {
          const vocabItems = await processImages(file, i, (progress) => {
             setStatuses(prev => prev.map((s, idx) => 
              idx === i ? { ...s, progress } : s
            ));
          });
          
          allResults.push(...vocabItems);
          
          setStatuses(prev => prev.map((s, idx) => 
            idx === i ? { ...s, status: 'completed', progress: 100 } : s
          ));
        } catch (err) {
          console.error(`Error processing ${file.name}:`, err);
          setStatuses(prev => prev.map((s, idx) => 
            idx === i ? { ...s, status: 'error', error: 'Extraction failed' } : s
          ));
        }
      }

      const finalResults = allResults.map((item, idx) => ({
        ...item,
        id: idx + 1
      }));
      
      setResults(finalResults);
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadExcel = () => {
    exportToExcel(results);
  };

  const downloadZip = async () => {
    await exportToZip(results);
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <Header />
      
      <main className="space-y-8 mt-10">
        <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
          <h2 className="text-xl font-semibold mb-4 text-slate-800">1. Upload Target Images</h2>
          <FileUploader onFilesSelected={handleFilesSelected} isProcessing={isProcessing} />
          
          {images.length > 0 && !isProcessing && results.length === 0 && (
            <div className="mt-6 flex justify-center">
              <button
                onClick={startProcessing}
                className="bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3 rounded-xl font-medium transition-all shadow-lg shadow-indigo-200 flex items-center gap-2"
              >
                Start Processing {images.length} Images
              </button>
            </div>
          )}
        </section>

        {isProcessing && (
          <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
            <h2 className="text-xl font-semibold mb-4 text-slate-800 flex items-center gap-2">
              <Loader2 className="animate-spin text-indigo-600" />
              Processing...
            </h2>
            <div className="space-y-3">
              {statuses.map((status, idx) => (
                <div key={idx} className="flex flex-col gap-1">
                  <div className="flex justify-between text-sm text-slate-600">
                    <span>{status.fileName}</span>
                    <span className="capitalize">{status.status}</span>
                  </div>
                  <div className="w-full bg-slate-100 h-2 rounded-full overflow-hidden">
                    <div 
                      className={`h-full transition-all duration-300 ${status.status === 'error' ? 'bg-red-500' : 'bg-indigo-500'}`}
                      style={{ width: `${status.progress}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {results.length > 0 && (
          <>
            <section className="flex flex-wrap gap-4">
              <button
                onClick={downloadExcel}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white px-6 py-4 rounded-2xl font-semibold transition-all shadow-lg shadow-emerald-100 flex items-center justify-center gap-3"
              >
                <FileSpreadsheet size={24} />
                Download Excel Report
              </button>
              <button
                onClick={downloadZip}
                className="flex-1 bg-amber-600 hover:bg-amber-700 text-white px-6 py-4 rounded-2xl font-semibold transition-all shadow-lg shadow-amber-100 flex items-center justify-center gap-3"
              >
                <Archive size={24} />
                Download Images ZIP
              </button>
            </section>

            <section className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h2 className="text-xl font-semibold mb-6 text-slate-800">Extraction Results ({results.length} items)</h2>
              <ResultPreview items={results} />
            </section>
          </>
        )}
      </main>
    </div>
  );
};

export default App;