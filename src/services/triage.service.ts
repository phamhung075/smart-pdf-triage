import fs from 'fs';
import path from 'path';
import { CONFIG, BASE_DIR, ensureDirectoriesExist, reloadConfigFromDisk } from '../infrastructure/settings.js';
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
import { classifyPDFText } from '../application/classify-document.js';
import { generateEmbedding } from '../infrastructure/ollama-client.js';
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
import { ruleBasedClassify } from '../domain/classification.js';
import { getDocumentByChecksum, insertDocumentRecord, updateDocumentRecord, getAllDocuments, getDb, getDocumentById } from '../infrastructure/db/database.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { logger } from '../infrastructure/logger.js';
import { isYearString, isForbiddenSubcategory, isPathInsideDir, computeCanonicalPath } from '../domain/taxonomy.js';
import { getPDFsRecursively, getAllFilesRecursively } from '../infrastructure/pdf-scanner.js';
import { readActiveLockHolder, acquireProcessLock } from '../infrastructure/pid-lock.js';

// Cross-process guard: the web server's own auto-watcher/manual-scan/repair/clear
// routes already serialize themselves via an in-memory flag, but that can't stop a
// SEPARATE process (e.g. the MCP server, `npm run scan`, or a stray second server
// instance) from concurrently running one of these against the same __raws/__archive
// files. This file-based lock makes that cross-process case fail fast instead of racing.
const SCAN_LOCK_FILE = path.join(BASE_DIR, '.scan.lock');

export class ScanInProgressError extends Error {
  constructor(public readonly holderPid: number) {
    super(`A scan/repair/clear operation is already in progress (held by process ${holderPid}). Try again shortly.`);
  }
}

function acquireScanLock(): () => void {
  const holderPid = readActiveLockHolder(SCAN_LOCK_FILE);
  if (holderPid !== null) {
    throw new ScanInProgressError(holderPid);
  }
  return acquireProcessLock(SCAN_LOCK_FILE);
}

export interface TriageResultItem {
  filename: string;
  docId: number;
  title: string;
  category: string;
  subcategory: string;
  newPath: string;
  status: string;
}

// Moves sourcePath to desiredTargetPath without the check-then-act race a plain
// `existsSync` + `renameSync` has: fs.linkSync fails atomically with EEXIST if the
// target already exists (unlike renameSync, which would silently overwrite it on
// Windows), so a genuine collision always gets a fresh unique suffix instead of
// clobbering another file. Falls back to a plain rename across filesystem/volume
// boundaries (EXDEV), where an atomic link isn't possible.
function renameAtomicNoOverwrite(sourcePath: string, desiredTargetPath: string, maxAttempts = 20): string {
  const dir = path.dirname(desiredTargetPath);
  const ext = path.extname(desiredTargetPath);
  const base = path.basename(desiredTargetPath, ext);

  let candidate = desiredTargetPath;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      fs.linkSync(sourcePath, candidate);
      fs.unlinkSync(sourcePath);
      return candidate;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        candidate = path.join(dir, `${base}_${Date.now()}_${attempt}${ext}`);
        continue;
      }
      if (err.code === 'EXDEV') {
        fs.renameSync(sourcePath, candidate);
        return candidate;
      }
      throw err;
    }
  }
  throw new Error(`Failed to move '${sourcePath}' to a unique path after ${maxAttempts} attempts`);
}

export function relocalizeFileIfNeeded(
  filePath: string,
  category: string,
  subcategory?: string,
  dateStr?: string
): { newPath: string; moved: boolean } {
  const targetPath = computeCanonicalPath(filePath, category, CONFIG.OUTPUT_ROOT_DIR, subcategory, dateStr);

  const normTarget = path.normalize(targetPath).toLowerCase();
  const normCurrent = path.normalize(filePath).toLowerCase();

  if (normTarget === normCurrent) {
    return { newPath: filePath, moved: false };
  }

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  logger.info('RELOCALIZE', `Relocalizing document to canonical subcategory path`, { from: filePath, to: targetPath });
  const finalTarget = renameAtomicNoOverwrite(filePath, targetPath);

  try {
    const oldDir = path.dirname(filePath);
    if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) {
      fs.rmdirSync(oldDir);
      const oldParent = path.dirname(oldDir);
      if (fs.existsSync(oldParent) && fs.readdirSync(oldParent).length === 0) {
        fs.rmdirSync(oldParent);
      }
    }
  } catch (e) {}

  return { newPath: finalTarget, moved: true };
}

export async function moveBackToRaws(filePath: string, checksum?: string): Promise<string> {
  const filename = path.basename(filePath);
  const desiredTargetPath = path.join(CONFIG.INPUT_DIR, filename);

  logger.warn('REPAIR', `Moving file '${filename}' back to __raws`, { targetPath: desiredTargetPath });
  const targetPath = path.normalize(desiredTargetPath).toLowerCase() === path.normalize(filePath).toLowerCase()
    ? filePath
    : renameAtomicNoOverwrite(filePath, desiredTargetPath);

  if (checksum) {
    const existing = await getDocumentByChecksum(checksum);
    if (existing) {
      const db = await getDb();
      await db.run('DELETE FROM documents WHERE id = ?', [existing.id]);
      try {
        await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [existing.id]);
      } catch (e) {}
    }
  }

  try {
    const oldDir = path.dirname(filePath);
    if (fs.existsSync(oldDir) && fs.readdirSync(oldDir).length === 0) {
      fs.rmdirSync(oldDir);
      const oldParent = path.dirname(oldDir);
      if (fs.existsSync(oldParent) && fs.readdirSync(oldParent).length === 0) {
        fs.rmdirSync(oldParent);
      }
    }
  } catch (e) {}

  return targetPath;
}

export async function repairRegistry(): Promise<{
  scannedCount: number;
  repairedCount: number;
  updatedCount: number;
  relocalizedCount: number;
  movedToRawsCount: number;
}> {
  const release = acquireScanLock();
  try {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  console.log(`Starting Repair Registry & Relocalization on: ${CONFIG.OUTPUT_ROOT_DIR}`);
  
  const existingDocs = await getAllDocuments();
  let ghostPurgedCount = 0;
  for (const doc of existingDocs) {
    if (isYearString(doc.subcategory)) {
      await updateDocumentRecord(doc.id, { subcategory: 'general' });
    }
    const actual = findActualFileOnDisk(doc);
    if (!actual || !fs.existsSync(actual)) {
      logger.info('REPAIR', `Purging ghost database record ID ${doc.id} (${doc.title}) - missing on disk`);
      const db = await getDb();
      await db.run('DELETE FROM documents WHERE id = ?', [doc.id]);
      try {
        await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [doc.id]);
      } catch (e) {}
      ghostPurgedCount++;
    }
  }

  const archivedFiles = getAllFilesRecursively(CONFIG.OUTPUT_ROOT_DIR);
  
  let repairedCount = 0;
  let updatedCount = 0;
  let relocalizedCount = 0;
  let movedToRawsCount = 0;

  for (const filePath of archivedFiles) {
    try {
      if (!fs.existsSync(filePath)) continue;

      const file = path.basename(filePath);
      const { checksum, raw_text } = await extractPDFContent(filePath);

      const isMissingContent = !raw_text || raw_text.trim().length === 0 || raw_text.includes('[No raw text extracted]');

      if (isMissingContent) {
        await moveBackToRaws(filePath, checksum);
        movedToRawsCount++;
        continue;
      }

      const existing = await getDocumentByChecksum(checksum);
      if (existing) {
        const currentText = (existing.raw_text || '').trim();
        if (currentText.length < 15 || currentText.includes('[No raw text extracted]') || (raw_text.length > 20 && currentText !== raw_text)) {
          logger.info('REPAIR', `Updating raw text for doc ID ${existing.id} (${file}): ${raw_text.length} chars`);
          await updateDocumentRecord(existing.id, { raw_text });
          updatedCount++;
        }

        let currentCat = existing.category;
        let currentSub = existing.subcategory;
        const isGeneric = !currentSub || currentSub === 'general' || currentSub === 'other' || currentSub === 'divers' || currentCat === 'personal';

        if (isGeneric) {
          const rb = ruleBasedClassify(raw_text || currentText, file, getEntityDictionary(), CONFIG.PERSONAL_NAME_DENYLIST);
          if (rb.subcategorie !== 'general' && rb.subcategorie !== 'other' && rb.subcategorie !== 'divers') {
            currentCat = rb.categorie;
            currentSub = rb.subcategorie;
            logger.info('REPAIR', `Re-classified document ID ${existing.id} (${file}): ${existing.category}/${existing.subcategory} -> ${currentCat}/${currentSub}`);
            await updateDocumentRecord(existing.id, {
              category: currentCat,
              subcategory: currentSub
            });
            updatedCount++;
          } else {
            logger.warn('REPAIR', `Document ID ${existing.id} (${file}) has no specific subcategory. Moving back to __raws!`);
            await moveBackToRaws(filePath, checksum);
            movedToRawsCount++;
            continue;
          }
        }

        const { newPath, moved } = relocalizeFileIfNeeded(filePath, currentCat, currentSub, existing.date);
        
        if (moved) relocalizedCount++;

        if (existing.new_path !== newPath || existing.status !== 'MOVED') {
          await updateDocumentRecord(existing.id, {
            new_path: newPath,
            status: 'MOVED'
          });
          updatedCount++;
        }
      } else {
        const rel = path.relative(CONFIG.OUTPUT_ROOT_DIR, filePath);
        const parts = rel.split(path.sep);
        
        const pathCat = parts[0] || 'other';
        const pathSub = parts.length >= 3 ? parts[1] : 'general';

        console.log(`Repairing & analyzing unindexed file '${file}' (Path hint: ${pathCat}/${pathSub})...`);
        const metadata = await classifyPDFText(raw_text, file);
        const embedding = await generateEmbedding(raw_text);

        const targetCat = metadata.categorie;
        const targetSub = metadata.subcategorie;
        const targetDate = metadata.date || '';

        const isGenericTarget = !targetSub || targetSub === 'general' || targetSub === 'other' || targetSub === 'divers';
        if (isGenericTarget) {
          logger.warn('REPAIR', `Unindexed file '${file}' has no specific subcategory. Moving back to __raws!`);
          await moveBackToRaws(filePath, checksum);
          movedToRawsCount++;
          continue;
        }

        const { newPath, moved } = relocalizeFileIfNeeded(filePath, targetCat, targetSub, targetDate);
        if (moved) relocalizedCount++;

        try {
          await insertDocumentRecord({
            checksum,
            title: metadata.titre || file.replace(/\.pdf$/i, ''),
            registre: metadata.registre || '',
            date: targetDate,
            category: targetCat,
            subcategory: targetSub,
            summary: metadata.summary || '',
            tags: metadata.tags || [],
            raw_text,
            original_filename: file,
            original_path: filePath,
            new_path: newPath,
            embedding,
            status: 'MOVED'
          });
          repairedCount++;
        } catch (dbErr: any) {
          if (dbErr.message?.includes('UNIQUE constraint failed')) {
            const existingDoc = await getDocumentByChecksum(checksum);
            if (existingDoc) {
              await updateDocumentRecord(existingDoc.id, {
                category: targetCat,
                subcategory: targetSub,
                new_path: newPath,
                status: 'MOVED'
              });
              updatedCount++;
            }
          } else {
            console.warn(`Error inserting record for ${file}:`, dbErr.message);
          }
        }
      }
    } catch (err: any) {
      console.warn(`Error repairing file ${filePath}:`, err.message);
    }
  }

  await syncJSONRegistry();

  return {
    scannedCount: archivedFiles.length,
    repairedCount,
    updatedCount,
    relocalizedCount,
    movedToRawsCount
  };
  } finally {
    release();
  }
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

export function findActualFileOnDisk(doc: { original_filename?: string; original_path?: string; new_path?: string }): string | null {
  if (doc.new_path && fs.existsSync(doc.new_path)) {
    return doc.new_path;
  }
  if (doc.original_path && fs.existsSync(doc.original_path)) {
    return doc.original_path;
  }

  const filename = doc.original_filename || (doc.original_path ? path.basename(doc.original_path) : '');
  if (!filename) return null;

  const rawMatch = path.join(CONFIG.INPUT_DIR, filename);
  if (fs.existsSync(rawMatch)) {
    return rawMatch;
  }

  const allArchived = getPDFsRecursively(CONFIG.OUTPUT_ROOT_DIR);
  const found = allArchived.find(f => path.basename(f).toLowerCase() === filename.toLowerCase());
  return found || null;
}

// Golden Rule #5: the category/subcategory must exist in categories.json BEFORE any
// physical file move — every caller that lets an explicit category/subcategory be set
// (not just the AI classification path) must run this first.
export function ensureCategoryAndSubcategoryExist(category: string, subcategory: string): void {
  const categoriesConfig = getCategoriesConfig();
  let catObj = categoriesConfig.categories.find(c => c.id === category);
  if (!catObj) {
    catObj = {
      id: category,
      name: category.charAt(0).toUpperCase() + category.slice(1),
      description: `Category auto-created for ${category}`,
      aliases: [category],
      subcategories: []
    };
    categoriesConfig.categories.push(catObj);
  }

  if (!catObj.subcategories) catObj.subcategories = [];
  if (!catObj.subcategories.some(s => s.id === subcategory)) {
    catObj.subcategories.push({
      id: subcategory,
      name: subcategory.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
      aliases: [subcategory]
    });
  }
  saveCategoriesConfig(categoriesConfig.categories);
}

export async function reclassifyAndRelocalizeDocument(
  id: number,
  explicitCategory?: string,
  explicitSubcategory?: string,
  userFeedbackReason?: string
): Promise<{
  success: boolean;
  staleCleaned?: boolean;
  error?: string;
  message?: string;
  document?: any;
}> {
  const doc = await getDocumentById(id);
  if (!doc) {
    return { success: false, error: 'Document not found' };
  }

  if (explicitSubcategory !== undefined && isForbiddenSubcategory(explicitSubcategory)) {
    return { success: false, error: `'${explicitSubcategory}' is not a valid subcategory (general/other/divers/year strings are not allowed — Golden Rule #4). Please choose a specific entity or document-type name.` };
  }

  const actualPath = findActualFileOnDisk(doc);
  if (!actualPath || !fs.existsSync(actualPath)) {
    logger.info('RELOCALIZE', `Purging stale ghost database record ID ${id} (${doc.title}) - missing on disk`);
    const db = await getDb();
    await db.run('DELETE FROM documents WHERE id = ?', [id]);
    try {
      await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [id]);
    } catch (e) {}
    await syncJSONRegistry();
    return {
      success: false,
      staleCleaned: true,
      error: `Physical file '${doc.original_filename || doc.title}' was missing on disk. Cleaned up stale record.`
    };
  }

  const { raw_text } = await extractPDFContent(actualPath);
  const textToAnalyze = (raw_text && raw_text.trim().length > 10) ? raw_text : (doc.raw_text || '');

  let newCategory = doc.category;
  let newSubcategory = doc.subcategory;
  let newTitle = doc.title;
  let newDate = doc.date;
  let newSummary = doc.summary;
  let newMarkdown = doc.markdown_content;

  if (explicitCategory && explicitSubcategory) {
    // User explicitly chose Category & Subcategory from Modal
    newCategory = explicitCategory.toLowerCase().trim();
    newSubcategory = explicitSubcategory.toLowerCase().trim();
    ensureCategoryAndSubcategoryExist(newCategory, newSubcategory);
  } else {
    // Re-run Qwen 3.5 AI with optional user feedback note
    logger.info('RELOCALIZE', `Re-analyzing document content with AI for ID ${id} (${doc.title})...`, { userFeedbackReason });
    const meta = await classifyPDFText(textToAnalyze, doc.original_filename || path.basename(actualPath), userFeedbackReason);

    newCategory = meta.categorie;
    newSubcategory = meta.subcategorie;
    newTitle = meta.titre || doc.title;
    newDate = meta.date || doc.date;
    newSummary = meta.summary || doc.summary;
    newMarkdown = meta.markdown_content || doc.markdown_content;
  }

  const { newPath, moved } = relocalizeFileIfNeeded(actualPath, newCategory, newSubcategory, newDate);

  await updateDocumentRecord(id, {
    title: newTitle,
    category: newCategory,
    subcategory: newSubcategory,
    date: newDate,
    summary: newSummary,
    markdown_content: newMarkdown,
    new_path: newPath,
    status: 'MOVED'
  });

  await syncJSONRegistry();
  const updatedDoc = await getDocumentById(id);

  return {
    success: true,
    message: moved
      ? `📍 Re-analyzed & relocated document to: ${newCategory.toUpperCase()} / ${newSubcategory.toUpperCase()}`
      : `📍 Document re-analyzed & confirmed in canonical location: ${newCategory.toUpperCase()} / ${newSubcategory.toUpperCase()}`,
    document: updatedDoc
  };
}

export async function clearRegistryAndMoveArchiveToRaws(): Promise<{ countMoved: number }> {
  const release = acquireScanLock();
  try {
  reloadConfigFromDisk();
  ensureDirectoriesExist();

  const existingDocs = await getAllDocuments();
  console.log(`Clearing registry (${existingDocs.length} records) and moving all physical files from __archive to __raws...`);

  let countMoved = 0;
  for (const doc of existingDocs) {
    const actualPath = findActualFileOnDisk(doc);
    if (actualPath && fs.existsSync(actualPath) && isPathInsideDir(actualPath, CONFIG.OUTPUT_ROOT_DIR)) {
      try {
        await moveBackToRaws(actualPath);
        countMoved++;
      } catch (err: any) {
        console.warn(`Error moving file ${actualPath} back to __raws:`, err.message);
      }
    }
  }

  const db = await getDb();
  await db.run('DELETE FROM documents');
  try {
    await db.run('DELETE FROM documents_fts');
  } catch (e) {}

  // Any files still left under __archive at this point have no matching DB row
  // (e.g. a repair/insert that never completed). Never delete a PDF — move these
  // orphans back to __raws too, same as tracked files, then remove the now-empty
  // folder skeleton so the next scan reconstructs it cleanly.
  try {
    const moveOrphansAndRemoveEmptyDirs = async (dirPath: string): Promise<void> => {
      if (!fs.existsSync(dirPath)) return;
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const curPath = path.join(dirPath, file);
        if (fs.lstatSync(curPath).isDirectory()) {
          await moveOrphansAndRemoveEmptyDirs(curPath);
        } else {
          try {
            await moveBackToRaws(curPath);
            countMoved++;
          } catch (err: any) {
            console.warn(`Error moving orphaned file ${curPath} back to __raws:`, err.message);
          }
        }
      }
      if (
        dirPath.toLowerCase() !== path.normalize(CONFIG.OUTPUT_ROOT_DIR).toLowerCase() &&
        fs.existsSync(dirPath) &&
        fs.readdirSync(dirPath).length === 0
      ) {
        fs.rmdirSync(dirPath);
      }
    };
    await moveOrphansAndRemoveEmptyDirs(CONFIG.OUTPUT_ROOT_DIR);
    ensureDirectoriesExist();
  } catch (e) {}

  await syncJSONRegistry();

  console.log(`Clear Registry Completed: Purged DB & moved ${countMoved} physical files from __archive back to __raws.`);
  return { countMoved };
  } finally {
    release();
  }
}
