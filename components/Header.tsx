
import React from 'react';
import { ScanSearch } from 'lucide-react';

export const Header: React.FC = () => {
  return (
    <header className="text-center space-y-2">
      <div className="inline-flex items-center justify-center p-3 bg-indigo-100 text-indigo-600 rounded-2xl mb-4">
        <ScanSearch size={32} />
      </div>
      <h1 className="text-4xl font-bold text-slate-900 tracking-tight">AI Vocabulary Extractor</h1>
      <p className="text-slate-500 text-lg max-w-2xl mx-auto">
        Automatically detect words and crop corresponding illustrations from your vocabulary sheets. 
        Export results to Excel and ZIP folders instantly.
      </p>
    </header>
  );
};
