import React from 'react';
import { VocabItem } from '../types.ts';

interface ResultPreviewProps {
  items: VocabItem[];
}

export const ResultPreview: React.FC<ResultPreviewProps> = ({ items }) => {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
      {items.map((item) => (
        <div key={item.id} className="group relative bg-slate-50 border border-slate-200 rounded-xl overflow-hidden hover:shadow-md transition-shadow">
          <div className="aspect-square bg-white flex items-center justify-center p-2">
            {item.croppedImageUrl ? (
              <img 
                src={item.croppedImageUrl} 
                alt={item.word} 
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              <div className="w-full h-full bg-slate-100 animate-pulse rounded" />
            )}
          </div>
          <div className="p-2 border-t border-slate-100 bg-white">
            <span className="text-[10px] font-bold text-indigo-500 uppercase tracking-wider block">#{item.id}</span>
            <span className="text-sm font-semibold text-slate-700 truncate block" title={item.word}>
              {item.word}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
};