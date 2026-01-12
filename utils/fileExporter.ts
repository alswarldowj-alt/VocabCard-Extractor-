
import { VocabItem } from '../types.ts';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

const formatWordForExport = (word: string): string => {
  return word.replace(/_/g, ' ').trim();
};

export const exportToExcel = (items: VocabItem[]) => {
  const data = items.map(item => ({
    '序号': item.id, 
    '单词': formatWordForExport(item.word)
  }));

  const worksheet = XLSX.utils.json_to_sheet(data);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Vocabulary");
  
  XLSX.writeFile(workbook, "Vocabulary_List.xlsx");
};

export const exportToZip = async (items: VocabItem[]) => {
  const zip = new JSZip();
  const folder = zip.folder("images");
  
  if (!folder) return;

  for (const item of items) {
    if (item.blob) {
      const cleanWord = formatWordForExport(item.word);
      // 名字和导出的Excel中的名字一模一样（包括大小写），去除序号信息
      const filename = `${cleanWord}.jpg`;
      folder.file(filename, item.blob);
    }
  }

  const content = await zip.generateAsync({ type: "blob" });
  const url = URL.createObjectURL(content);
  const link = document.createElement('a');
  link.href = url;
  link.download = "Extracted_Images.zip";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};
