import fs from 'fs';
import path from 'path';
import { CONFIG } from '../infrastructure/settings.js';
import { computeCanonicalPath, isForbiddenSubcategory } from '../domain/taxonomy.js';
import { getPDFsRecursively } from '../infrastructure/pdf-scanner.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
import { extractPDFContent } from '../infrastructure/pdf-extractor.js';
import { classifyPDFText } from './classify-document.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { getDb, getDocumentByChecksum, getDocumentById, updateDocumentRecord } from '../infrastructure/db/database.js';
import { logger } from '../infrastructure/logger.js';

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
