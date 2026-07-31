import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import * as pdfPkg from 'pdf-parse';
import { logger } from '../infrastructure/logger.js';
import { cleanExtractedText } from '../domain/pdf-text.js';

export interface ExtractedPDF {
  checksum: string;
  raw_text: string;
  numpages: number;
  info: any;
}

async function safePdfParse(buffer: Buffer): Promise<{ text: string; numpages: number; info: any }> {
  // 1. Try class-based constructor first (PDFParse in ES module mode)
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

  // 2. Fallback to default function invocation if constructor is function
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
}

export async function extractPDFContent(filePath: string): Promise<ExtractedPDF> {
  logger.debug('PDF_PARSER', `Reading file & parsing text content`, { filePath });
  const fileBuffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  
  // Calculate SHA256 checksum
  const checksum = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  let raw_text = '';
  let numpages = 1;
  let info: any = {};

  try {
    const data = await safePdfParse(fileBuffer);
    
    numpages = data.numpages || 1;
    info = data.info || {};
    const extracted = data.text || '';
    raw_text = cleanExtractedText(extracted, filename);

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
  } catch (err: any) {
    logger.warn('PDF_PARSER', `Failed to extract text from ${filePath}: ${err.message}`);
    raw_text = '';
  }

  return {
    checksum,
    raw_text,
    numpages,
    info
  };
}
