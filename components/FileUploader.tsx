
import React, { useRef } from 'react';
import { Upload, Image as ImageIcon } from 'lucide-react';

interface FileUploaderProps {
  onFilesSelected: (files: File[]) => void;
  isProcessing: boolean;
}

export const FileUploader: React.FC<FileUploaderProps> = ({ onFilesSelected, isProcessing }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      onFilesSelected(Array.from(e.target.files));
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      onFilesSelected(Array.from(e.dataTransfer.files));
    }
  };

  return (
    <div
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onClick={() => !isProcessing && fileInputRef.current?.click()}
      className={`
        border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all
        ${isProcessing ? 'bg-slate-50 border-slate-200 cursor-not-allowed' : 'bg-indigo-50/30 border-indigo-200 hover:border-indigo-400 hover:bg-indigo-50'}
      `}
    >
      <input
        type="file"
        ref={fileInputRef}
        onChange={handleFileChange}
        multiple
        accept="image/*"
        className="hidden"
      />
      <div className="flex flex-col items-center gap-3">
        <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-sm text-indigo-500">
          <Upload size={28} />
        </div>
        <div>
          <p className="text-lg font-medium text-slate-700">Click to upload or drag and drop</p>
          <p className="text-sm text-slate-500">Supports JPG, PNG, WEBP (Batch selection enabled)</p>
        </div>
      </div>
    </div>
  );
};
