import path from 'path';
import { CONFIG, ensureDirectoriesExist, reloadConfigFromDisk } from '../infrastructure/settings.js';
import { acquireScanLock } from './scan-lock.js';
import { getPDFsRecursively } from '../infrastructure/pdf-scanner.js';
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
import { getDocumentByChecksum, insertDocumentRecord, updateDocumentRecord } from '../infrastructure/db/database.js';
import { classifyPDFText } from './classify-document.js';
import { generateEmbedding } from '../infrastructure/ollama-client.js';
import { relocalizeFileIfNeeded } from './relocalize-document.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { logger } from '../infrastructure/logger.js';

export interface TriageResultItem {
  filename: string;
  docId: number;
  title: string;
  category: string;
  subcategory: string;
  newPath: string;
  status: string;
}

export interface TriageProgressEvent {
  type: 'SCAN_STARTED' | 'FILE_PROGRESS' | 'FILE_COMPLETED' | 'FILE_FAILED' | 'SCAN_COMPLETED';
  totalFiles?: number;
  files?: string[];
  filename?: string;
  stage?: 'EXTRACTING_TEXT' | 'AI_CLASSIFYING' | 'RELOCALIZING' | 'COMPLETED' | 'SKIPPED_DUPLICATE' | 'FAILED';
  message?: string;
  docId?: number;
  title?: string;
  category?: string;
  subcategory?: string;
  newPath?: string;
  scannedCount?: number;
  processedCount?: number;
  skippedCount?: number;
}

export async function runTriageScan(onProgress?: (event: TriageProgressEvent) => void): Promise<{
  scannedCount: number;
  processedCount: number;
  skippedCount: number;
  items: TriageResultItem[];
}> {
  const release = acquireScanLock();
  try {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  console.log(`Scanning for PDFs in: ${CONFIG.INPUT_DIR}`);
  console.log(`Output Root Directory: ${CONFIG.OUTPUT_ROOT_DIR}`);

  const pdfFilePaths = getPDFsRecursively(CONFIG.INPUT_DIR, CONFIG.OUTPUT_ROOT_DIR);
  const filenames = pdfFilePaths.map(p => path.basename(p));

  onProgress?.({
    type: 'SCAN_STARTED',
    totalFiles: pdfFilePaths.length,
    files: filenames
  });

  let processedCount = 0;
  let skippedCount = 0;
  const items: TriageResultItem[] = [];

  for (const originalPath of pdfFilePaths) {
    const file = path.basename(originalPath);

    try {
      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        stage: 'EXTRACTING_TEXT',
        message: 'Extracting text layer from PDF...'
      });

      const { checksum, raw_text } = await extractPDFContent(originalPath);

      const cleanText = (raw_text || '').trim();
      if (!cleanText || cleanText.length < 10) {
        logger.warn('TRIAGE', `BLOCKED: No text extracted from PDF '${file}'. Kept in __raws.`, { originalPath });
        onProgress?.({
          type: 'FILE_FAILED',
          filename: file,
          stage: 'FAILED',
          message: '❌ Blocked: No text extracted from PDF. Kept in __raws.'
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      const existing = await getDocumentByChecksum(checksum);
      if (existing) {
        logger.info('TRIAGE', `Skipping duplicate file '${file}' (Checksum in DB, ID: ${existing.id})`);
        skippedCount++;
        items.push({
          filename: file,
          docId: existing.id,
          title: existing.title,
          category: existing.category,
          subcategory: existing.subcategory || 'general',
          newPath: existing.new_path,
          status: 'SKIPPED_DUPLICATE'
        });

        onProgress?.({
          type: 'FILE_COMPLETED',
          filename: file,
          stage: 'SKIPPED_DUPLICATE',
          message: 'Duplicate file (Already in database)',
          docId: existing.id,
          title: existing.title,
          category: existing.category,
          subcategory: existing.subcategory || 'general',
          newPath: existing.new_path
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        stage: 'AI_CLASSIFYING',
        message: 'Analyzing text, title, date & subcategory with Qwen 3.5 AI...'
      });

      console.log(`Classifying '${file}'...`);
      const metadata = await classifyPDFText(raw_text, file);

      const subcat = (metadata.subcategorie || '').toLowerCase().trim();
      if (!subcat || subcat === 'general' || subcat === 'other' || subcat === 'divers') {
        logger.warn('TRIAGE', `BLOCKED: No specific subcategory detected for '${file}' (subcat='${subcat}'). Kept in __raws.`, { originalPath });
        onProgress?.({
          type: 'FILE_FAILED',
          filename: file,
          stage: 'FAILED',
          message: `❌ Blocked: Failed to assign specific subcategory to '${file}'. Kept in __raws.`
        });
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      const embedding = await generateEmbedding(raw_text);

      const docId = await insertDocumentRecord({
        checksum,
        title: metadata.titre,
        registre: metadata.registre,
        date: metadata.date,
        category: metadata.categorie,
        subcategory: metadata.subcategorie || 'general',
        summary: metadata.summary,
        tags: metadata.tags,
        raw_text,
        markdown_content: metadata.markdown_content || '',
        original_filename: file,
        original_path: originalPath,
        embedding,
        status: 'PENDING'
      });

      onProgress?.({
        type: 'FILE_PROGRESS',
        filename: file,
        stage: 'RELOCALIZING',
        message: `Moving file to __archive/${metadata.categorie}/${metadata.subcategorie || 'general'}/...`
      });

      const { newPath: finalTargetPath } = relocalizeFileIfNeeded(
        originalPath,
        metadata.categorie,
        metadata.subcategorie,
        metadata.date
      );

      await updateDocumentRecord(docId, {
        new_path: finalTargetPath,
        status: 'MOVED'
      });

      processedCount++;
      items.push({
        filename: file,
        docId,
        title: metadata.titre,
        category: metadata.categorie,
        subcategory: metadata.subcategorie || 'general',
        newPath: finalTargetPath,
        status: 'MOVED'
      });

      onProgress?.({
        type: 'FILE_COMPLETED',
        filename: file,
        stage: 'COMPLETED',
        message: 'Successfully triaged & relocated',
        docId,
        title: metadata.titre,
        category: metadata.categorie,
        subcategory: metadata.subcategorie || 'general',
        newPath: finalTargetPath
      });

      logger.info('TRIAGE', `Successfully triaged '${file}' -> ID: ${docId}, Category: ${metadata.categorie}/${metadata.subcategorie}`);
    } catch (err: any) {
      logger.error('TRIAGE', `Error processing file ${file}: ${err.message}`);
      onProgress?.({
        type: 'FILE_FAILED',
        filename: file,
        stage: 'FAILED',
        message: err.message
      });
    } finally {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  await syncJSONRegistry();

  onProgress?.({
    type: 'SCAN_COMPLETED',
    scannedCount: pdfFilePaths.length,
    processedCount,
    skippedCount
  });

  return {
    scannedCount: pdfFilePaths.length,
    processedCount,
    skippedCount,
    items
  };
  } finally {
    release();
  }
}
