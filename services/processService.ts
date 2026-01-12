
import { GoogleGenAI, Type } from "@google/genai";
import { VocabItem } from "../types.ts";
import { cropImage } from "../utils/imageProcessor.ts";

const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve(base64String);
    };
    reader.onerror = error => reject(error);
  });
};

export const processImages = async (
  file: File, 
  imageIndex: number,
  onProgress: (p: number) => void
): Promise<VocabItem[]> => {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const base64 = await fileToBase64(file);
  
  onProgress(20);

  const systemInstruction = `
    You are an expert OCR and object detection model. 
    Analyze the provided vocabulary sheet image which contains a grid of cards. 
    Each card consists of an illustration and a word below it.
    
    Tasks:
    1. Identify every individual card in the sheet.
    2. Extract the vocabulary word associated with each card.
    3. Provide the normalized bounding box [ymin, xmin, ymax, xmax] of ONLY the illustration part (the graphic area above the word).
    4. Return the items in natural reading order (left-to-right, then top-to-bottom).
    
    Bounding boxes must be in scale 0-1000.
  `;

  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: {
      parts: [
        { inlineData: { mimeType: file.type, data: base64 } },
        { text: "Extract all vocabulary items as requested." }
      ]
    },
    config: {
      systemInstruction,
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

  onProgress(50);

  const data = JSON.parse(response.text);
  const rawItems = data.items || [];
  const processedItems: VocabItem[] = [];

  for (let i = 0; i < rawItems.length; i++) {
    const item = rawItems[i];
    const [ymin, xmin, ymax, xmax] = item.box_2d;
    
    try {
      const { url, blob } = await cropImage(file, { ymin, xmin, ymax, xmax });
      processedItems.push({
        id: 0,
        localId: i + 1, // 设置在原图中的序号
        word: item.word,
        originalImageIndex: imageIndex,
        boundingBox: { ymin, xmin, ymax, xmax },
        croppedImageUrl: url,
        blob
      });
    } catch (err) {
      console.warn("Failed to crop image for", item.word);
    }
    
    onProgress(50 + ((i + 1) / rawItems.length) * 50);
  }

  return processedItems;
};
