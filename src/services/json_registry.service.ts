import fs from 'fs';
import { CONFIG } from '../infrastructure/settings.js';
import { getAllDocuments, DocumentRecord } from '../infrastructure/db/database.js';

export interface JSONRegistryEntry {
  id: number;
  checksum: string;
  title: string;
  registre: string;
  date: string;
  category: string;
  subcategory: string;
  summary: string;
  tags: string[];
  original_filename: string;
  original_path: string;
  new_path: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export async function syncJSONRegistry(): Promise<void> {
  const docs: DocumentRecord[] = await getAllDocuments();
  
  const entries: JSONRegistryEntry[] = docs.map(doc => ({
    id: doc.id,
    checksum: doc.checksum,
    title: doc.title,
    registre: doc.registre,
    date: doc.date,
    category: doc.category,
    subcategory: doc.subcategory || 'general',
    summary: doc.summary,
    tags: safeParseJSON(doc.tags, []),
    original_filename: doc.original_filename,
    original_path: doc.original_path,
    new_path: doc.new_path,
    status: doc.status,
    created_at: doc.created_at,
    updated_at: doc.updated_at
  }));

  const data = {
    updated_at: new Date().toISOString(),
    total_count: entries.length,
    documents: entries
  };

  // Write to a temp file then rename over the target — a plain writeFileSync can be
  // interrupted mid-write (process kill, crash), leaving a truncated/corrupted
  // registry.json; renameSync is atomic on the same filesystem.
  const tmpPath = `${CONFIG.JSON_REGISTRY_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, CONFIG.JSON_REGISTRY_PATH);
}

function safeParseJSON(str: string, fallback: any) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}
