import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as pdfPkg from 'pdf-parse';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';
import { logger } from './logger.js';
import { cleanExtractedText } from '../domain/pdf-text.js';

export interface ExtractedPDF {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
}

export async function safePdfParse(buffer: Buffer): Promise<{ text: string; numpages: number; info: any }> {
  const originalWarn = console.warn;
  try {
    console.warn = (...args: any[]) => {
      const msg = args.map(a => (typeof a === 'string' ? a : String(a))).join(' ');
      if (msg.includes('Warning: TT:') || msg.includes('TT: undefined function') || msg.includes('TT: invalid function')) {
        return;
      }
      originalWarn(...args);
    };

    if ((pdfPkg as any).PDFParse) {
      try {
        const instance = new (pdfPkg as any).PDFParse({ data: buffer });
        const res = await instance.getText();
        if (res && typeof res.text === 'string') {
          return {
            text: res.text,
            numpages: res.numpages || res.total || 1,
            info: res.info || {}
          };
        }
      } catch (err: any) {
        logger.debug('PDF_PARSER', `Class PDFParse constructor failed: ${err.message}`);
      }
    }

    const handler = typeof pdfPkg === 'function' ? pdfPkg : ((pdfPkg as any).default || pdfPkg);
    if (typeof handler === 'function') {
      const res = await handler(buffer, { max: 0 });
      return {
        text: res.text || '',
        numpages: res.numpages || 1,
        info: res.info || {}
      };
    }

    throw new Error('Unable to find valid pdf-parse function or class constructor.');
  } finally {
    console.warn = originalWarn;
  }
}

// Fallback 1 (Solution 2): Robust text extraction via pdfjs-dist legacy (recovers text from corrupted XRef tables)
export async function parseWithPdfjs(buffer: Buffer): Promise<string> {
  try {
    const loadingTask = (pdfjsLib as any).getDocument({ data: new Uint8Array(buffer), ignoreErrors: true, useSystemFonts: true });
    const doc = await loadingTask.promise;
    let fullText = '';
    const numPages = Math.min(doc.numPages, 10);
    for (let i = 1; i <= numPages; i++) {
      const page = await doc.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map((item: any) => item.str).join(' ');
      fullText += pageText + '\n';
    }
    return fullText.trim();
  } catch (err: any) {
    logger.debug('PDF_PARSER', `pdfjs-dist fallback text parse failed: ${err.message}`);
    return '';
  }
}

// Convert pdfjs-dist RGBA/RGB image pixel data into a standard 24-bit BMP buffer for Tesseract.js
export function encodeToBMP(dataBuffer: Uint8Array, width: number, height: number, kind: number): Buffer {
  const isRGBA = kind === 3;
  const bytesPerPixel = isRGBA ? 4 : 3;
  const fileHeaderSize = 14;
  const bihSize = 40;
  const padding = (4 - ((width * 3) % 4)) % 4;
  const imageSize = (width * 3 + padding) * height;
  const fileSize = fileHeaderSize + bihSize + imageSize;

  const buf = Buffer.alloc(fileSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(fileSize, 2);
  buf.writeUInt32LE(fileHeaderSize + bihSize, 10);
  buf.writeUInt32LE(bihSize, 14);
  buf.writeInt32LE(width, 18);
  buf.writeInt32LE(-height, 22); // Top-down
  buf.writeUInt16LE(1, 26);
  buf.writeUInt16LE(24, 28); // 24 bits
  buf.writeUInt32LE(imageSize, 34);

  let offset = fileHeaderSize + bihSize;
  const rowSize = width * bytesPerPixel;
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    for (let x = 0; x < width; x++) {
      const p = rowStart + x * bytesPerPixel;
      buf[offset++] = dataBuffer[p + 2]; // B
      buf[offset++] = dataBuffer[p + 1]; // G
      buf[offset++] = dataBuffer[p];     // R
    }
    for (let p = 0; p < padding; p++) {
      buf[offset++] = 0;
    }
  }
  return buf;
}

// pdfjs-dist resolves image XObjects asynchronously; page.objs.get(id) throws if called
// synchronously before decode finishes. Await the callback form so slower-to-decode
// images (common in real scanned PDFs) aren't silently skipped.
function getResolvedPageObject(page: any, objName: string): Promise<any> {
  return new Promise((resolve) => {
    if (page.objs.has(objName)) {
      resolve(page.objs.get(objName));
      return;
    }
    page.objs.get(objName, (data: any) => resolve(data));
  });
}

// Fallback 2 (Solution 1): Offline Tesseract.js OCR for scanned image PDFs
export async function ocrPdfImages(buffer: Buffer, maxPages = 3): Promise<string> {
  let worker: any = null;
  try {
    const loadingTask = (pdfjsLib as any).getDocument({ data: new Uint8Array(buffer), ignoreErrors: true, useSystemFonts: true });
    const doc = await loadingTask.promise;
    const ocrTexts: string[] = [];

    const numPages = Math.min(doc.numPages, maxPages);
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const ops = await page.getOperatorList();

      for (let i = 0; i < ops.fnArray.length; i++) {
        if (ops.fnArray[i] === pdfjsLib.OPS.paintImageXObject || ops.fnArray[i] === pdfjsLib.OPS.paintInlineImageXObject) {
          const imgName = ops.argsArray[i][0];
          try {
            const img = await getResolvedPageObject(page, imgName);
            if (img && img.data && (img.kind === 2 || img.kind === 3) && img.width > 200 && img.height > 200) {
              const bmpBuf = encodeToBMP(img.data, img.width, img.height, img.kind);
              if (!worker) {
                // errorHandler is required, not optional: without it, createWorker.js's
                // onMessage handler falls back to a bare `throw Error(data)` inside a raw
                // worker-thread message-event callback whenever a job rejects — outside any
                // promise chain we await, so Node treats it as an uncaught exception and
                // kills the whole process. This has been observed for large scanned images:
                // tesseract.js's Node setImage() BMP workaround spreads the whole image
                // buffer into a plain object ({...image}), which throws "RangeError: Too
                // many properties to enumerate" once the image is large enough. With
                // errorHandler set, that same failure still rejects worker.recognize()
                // normally, which the try/catch around this call already handles.
                worker = await createWorker(['fra', 'eng'], undefined, {
                  errorHandler: (err: any) => logger.warn('PDF_PARSER', `Tesseract worker error: ${err?.message || err}`),
                });
              }
              const res = await worker.recognize(bmpBuf);
              if (res && res.data && res.data.text && res.data.text.trim().length > 10) {
                ocrTexts.push(res.data.text.trim());
              }
            }
          } catch (e: any) {
            logger.debug('PDF_PARSER', `Image OCR error on page ${pageNum}: ${e.message}`);
          }
        }
      }
    }

    if (worker) {
      await worker.terminate();
    }
    return ocrTexts.join('\n\n');
  } catch (err: any) {
    if (worker) {
      try { await worker.terminate(); } catch {}
    }
    logger.warn('PDF_PARSER', `Tesseract OCR fallback failed: ${err.message}`);
    return '';
  }
}

export async function extractPDFContent(filePath: string): Promise<ExtractedPDF> {
  logger.debug('PDF_PARSER', `Reading file & parsing text content`, { filePath });
  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  
  const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  let raw_text = '';
  let numpages = 1;
  let info: any = {};

  // Step 1: Fast standard pdf-parse
  try {
    const data = await safePdfParse(fileBuffer);
    numpages = data.numpages || 1;
    info = data.info || {};
    const extracted = data.text || '';
    raw_text = cleanExtractedText(extracted, filename);
  } catch (err: any) {
    logger.warn('PDF_PARSER', `pdf-parse failed on ${filename}: ${err.message}`);
  }

  // Step 2: Solution 2 — Robust pdfjs-dist fallback parser for corrupted XRef tables
  if (!raw_text || raw_text.length < 10) {
    const pdfjsText = await parseWithPdfjs(fileBuffer);
    const cleanedPdfjs = cleanExtractedText(pdfjsText, filename);
    if (cleanedPdfjs && cleanedPdfjs.length >= 10) {
      logger.info('PDF_PARSER', `Recovered ${cleanedPdfjs.length} chars using pdfjs-dist fallback parser`, { filename });
      raw_text = cleanedPdfjs;
    }
  }

  // Step 3: Solution 1 — Automatic Tesseract.js OCR for scanned paper/photo PDFs
  if (!raw_text || raw_text.length < 10) {
    logger.info('PDF_PARSER', `No digital text layer found for '${filename}'. Running offline Tesseract OCR on scanned images...`);
    const ocrText = await ocrPdfImages(fileBuffer);
    const cleanedOcr = cleanExtractedText(ocrText, filename);
    if (cleanedOcr && cleanedOcr.length >= 10) {
      logger.info('PDF_PARSER', `Successfully extracted ${cleanedOcr.length} chars via Tesseract OCR!`, { filename });
      raw_text = `[OCR Extracted Text]\n\n${cleanedOcr}`;
    }
  }

  if (raw_text && info && (info.Title || info.Author || info.Subject)) {
    const metaArr = [info.Title, info.Author, info.Subject].filter(b => typeof b === 'string' && b.trim().length > 0);
    if (metaArr.length > 0) {
      const metaHeader = `[Propriétés Document: ${metaArr.join(' | ')}]`;
      if (!raw_text.includes(metaHeader)) {
        raw_text = `${metaHeader}\n\n${raw_text}`;
      }
    }
  }

  logger.info('PDF_PARSER', `Parsed PDF text: ${raw_text.length} chars`, { filename, numpages, checksum: checksum.substring(0, 10) });

  return {
    checksum,
    raw_text,
    numpages,
    info
  };
}
