import fs from 'fs';
import path from 'path';
import { isPathInsideDir } from '../domain/taxonomy.js';

export function getPDFsRecursively(dir: string, ignoreDir?: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);

    if (ignoreDir && isPathInsideDir(fullPath, ignoreDir)) {
      continue;
    }

    if (item.isDirectory()) {
      results = results.concat(getPDFsRecursively(fullPath, ignoreDir));
    } else if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) {
      results.push(fullPath);
    }
  }
  return results;
}

export function getAllFilesRecursively(dir: string): string[] {
  let results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const items = fs.readdirSync(dir, { withFileTypes: true });

  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    if (item.isDirectory()) {
      results = results.concat(getAllFilesRecursively(fullPath));
    } else if (item.isFile() && item.name.toLowerCase().endsWith('.pdf')) {
      results.push(fullPath);
    }
  }
  return results;
}
