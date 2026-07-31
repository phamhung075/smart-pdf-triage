import path from 'path';

// True only if `fullPath` IS `dirPath`, or is actually nested inside it — a plain
// string-prefix check would also match an unrelated sibling that merely shares a
// prefix (e.g. "__archive" vs "__archive_old").
export function isPathInsideDir(fullPath: string, dirPath: string): boolean {
  const normFull = path.normalize(fullPath).toLowerCase();
  const normDir = path.normalize(dirPath).toLowerCase();
  return normFull === normDir || normFull.startsWith(normDir + path.sep);
}

export function isYearString(str?: string): boolean {
  return !!str && /^\d{4}$/.test(str.trim());
}

// Golden Rule #4: general/other/divers/empty/year-only are never valid final
// subcategories — any write path that lets a caller set an explicit subcategory
// must reject these, not just the initial classification flow.
const FORBIDDEN_SUBCATEGORIES = new Set(['general', 'other', 'divers']);
export function isForbiddenSubcategory(subcategory?: string): boolean {
  if (!subcategory) return true;
  const normalized = subcategory.toLowerCase().trim();
  if (normalized.length === 0) return true;
  return FORBIDDEN_SUBCATEGORIES.has(normalized) || isYearString(normalized);
}

export function computeCanonicalPath(
  originalPath: string,
  category: string,
  outputRootDir: string,
  subcategory?: string,
  dateStr?: string
): string {
  const file = path.basename(originalPath);
  const cleanCat = category ? category.toLowerCase().trim() : 'other';
  let cleanSub = subcategory ? subcategory.toLowerCase().trim() : 'general';

  if (isYearString(cleanSub)) {
    cleanSub = 'general';
  }

  let yearStr = new Date().getFullYear().toString();
  if (dateStr && dateStr.length >= 4) {
    const match = dateStr.match(/\b(20\d{2})\b/);
    if (match) {
      yearStr = match[1];
    }
  }

  const subParts = cleanSub.split(/[\/\\]+/).filter(Boolean);
  return path.join(outputRootDir, cleanCat, ...subParts, yearStr, file);
}
