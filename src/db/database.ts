import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import { CONFIG } from '../config.js';
import fs from 'fs';

let dbInstance: Database | null = null;

export async function getDb(): Promise<Database> {
  if (dbInstance) {
    return dbInstance;
  }

  dbInstance = await open({
    filename: CONFIG.DB_PATH,
    driver: sqlite3.Database
  });

  await initSchema(dbInstance);
  return dbInstance;
}

async function initSchema(db: Database): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checksum TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      registre TEXT DEFAULT '',
      date TEXT DEFAULT '',
      category TEXT NOT NULL,
      subcategory TEXT DEFAULT '',
      summary TEXT DEFAULT '',
      tags TEXT DEFAULT '[]',
      raw_text TEXT DEFAULT '',
      original_filename TEXT NOT NULL,
      original_path TEXT NOT NULL,
      new_path TEXT DEFAULT '',
      embedding TEXT DEFAULT '[]',
      status TEXT DEFAULT 'PENDING',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS categories_db (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      aliases TEXT DEFAULT '[]'
    );
  `);

  // Migration: add subcategory and markdown_content columns if missing
  try {
    const tableInfo = await db.all("PRAGMA table_info(documents);");
    const hasSubcategory = tableInfo.some((col: any) => col.name === 'subcategory');
    if (!hasSubcategory) {
      await db.exec("ALTER TABLE documents ADD COLUMN subcategory TEXT DEFAULT '';");
    }
    const hasMarkdown = tableInfo.some((col: any) => col.name === 'markdown_content');
    if (!hasMarkdown) {
      await db.exec("ALTER TABLE documents ADD COLUMN markdown_content TEXT DEFAULT '';");
    }
  } catch (err) {
    console.warn("Table info pragma migration check notice:", err);
  }

  // Try creating FTS5 table if supported by sqlite build
  try {
    await db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        doc_id UNINDEXED,
        title,
        registre,
        summary,
        category,
        subcategory,
        tags,
        raw_text
      );
    `);
  } catch (err) {
    console.warn("FTS5 virtual table creation skipped or not supported:", err);
  }
}

export interface DocumentRecord {
  id: number;
  checksum: string;
  title: string;
  registre: string;
  date: string;
  category: string;
  subcategory: string;
  summary: string;
  tags: string; // JSON string
  raw_text: string;
  markdown_content?: string;
  original_filename: string;
  original_path: string;
  new_path: string;
  embedding: string; // JSON string
  status: string;
  created_at: string;
  updated_at: string;
}

export async function insertDocumentRecord(doc: {
  checksum: string;
  title: string;
  registre: string;
  date: string;
  category: string;
  subcategory?: string;
  summary: string;
  tags: string[];
  raw_text: string;
  markdown_content?: string;
  original_filename: string;
  original_path: string;
  new_path?: string;
  embedding?: number[];
  status?: string;
}): Promise<number> {
  const db = await getDb();
  const now = new Date().toISOString();

  const result = await db.run(
    `INSERT INTO documents (
      checksum, title, registre, date, category, subcategory, summary, tags, raw_text, markdown_content,
      original_filename, original_path, new_path, embedding, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      doc.checksum,
      doc.title,
      doc.registre || '',
      doc.date || '',
      doc.category,
      doc.subcategory || 'general',
      doc.summary || '',
      JSON.stringify(doc.tags || []),
      doc.raw_text || '',
      doc.markdown_content || '',
      doc.original_filename,
      doc.original_path,
      doc.new_path || '',
      JSON.stringify(doc.embedding || []),
      doc.status || 'PENDING',
      now,
      now
    ]
  );

  const docId = result.lastID!;

  // Index in FTS if available
  try {
    await db.run(
      `INSERT INTO documents_fts (doc_id, title, registre, summary, category, subcategory, tags, raw_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        docId,
        doc.title,
        doc.registre || '',
        doc.summary || '',
        doc.category,
        doc.subcategory || 'general',
        JSON.stringify(doc.tags || []),
        doc.raw_text || ''
      ]
    );
  } catch (err) {
    // Ignore FTS errors if FTS5 not active
  }

  return docId;
}

export async function updateDocumentRecord(id: number, updates: {
  title?: string;
  registre?: string;
  date?: string;
  category?: string;
  subcategory?: string;
  summary?: string;
  tags?: string[];
  raw_text?: string;
  markdown_content?: string;
  new_path?: string;
  status?: string;
}): Promise<boolean> {
  const db = await getDb();
  const existing = await db.get<DocumentRecord>('SELECT * FROM documents WHERE id = ?', [id]);
  if (!existing) return false;

  const now = new Date().toISOString();
  const title = updates.title ?? existing.title;
  const registre = updates.registre ?? existing.registre;
  const date = updates.date ?? existing.date;
  const category = updates.category ?? existing.category;
  const subcategory = updates.subcategory ?? existing.subcategory;
  const summary = updates.summary ?? existing.summary;
  const tagsStr = updates.tags ? JSON.stringify(updates.tags) : existing.tags;
  const raw_text = updates.raw_text ?? existing.raw_text;
  const markdown_content = updates.markdown_content ?? (existing.markdown_content || '');
  const new_path = updates.new_path ?? existing.new_path;
  const status = updates.status ?? existing.status;

  await db.run(
    `UPDATE documents SET
      title = ?, registre = ?, date = ?, category = ?, subcategory = ?, summary = ?,
      tags = ?, raw_text = ?, markdown_content = ?, new_path = ?, status = ?, updated_at = ?
     WHERE id = ?`,
    [title, registre, date, category, subcategory, summary, tagsStr, raw_text, markdown_content, new_path, status, now, id]
  );

  // Update FTS
  try {
    await db.run('DELETE FROM documents_fts WHERE doc_id = ?', [id]);
    await db.run(
      `INSERT INTO documents_fts (doc_id, title, registre, summary, category, subcategory, tags, raw_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, title, registre, summary, category, subcategory, tagsStr, raw_text]
    );
  } catch (err) {
    // Ignore FTS errors
  }

  return true;
}

export async function getAllDocuments(): Promise<DocumentRecord[]> {
  const db = await getDb();
  return db.all<DocumentRecord[]>('SELECT * FROM documents ORDER BY id DESC');
}

export async function getDocumentById(id: number): Promise<DocumentRecord | undefined> {
  const db = await getDb();
  return db.get<DocumentRecord>('SELECT * FROM documents WHERE id = ?', [id]);
}

export async function getDocumentByChecksum(checksum: string): Promise<DocumentRecord | undefined> {
  const db = await getDb();
  return db.get<DocumentRecord>('SELECT * FROM documents WHERE checksum = ?', [checksum]);
}

export async function getCategorySubcategoryStats(): Promise<{
  total: number;
  categoryCounts: Record<string, number>;
  subcategoryCounts: Record<string, Record<string, number>>;
}> {
  const db = await getDb();
  const rows = await db.all<{ category: string; subcategory: string; count: number }[]>(
    `SELECT LOWER(category) as category, LOWER(COALESCE(NULLIF(subcategory, ''), 'general')) as subcategory, COUNT(*) as count 
     FROM documents 
     GROUP BY LOWER(category), LOWER(COALESCE(NULLIF(subcategory, ''), 'general'))`
  );

  let total = 0;
  const categoryCounts: Record<string, number> = {};
  const subcategoryCounts: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    const cat = row.category;
    const sub = row.subcategory;
    const cnt = row.count;

    total += cnt;
    categoryCounts[cat] = (categoryCounts[cat] || 0) + cnt;

    if (!subcategoryCounts[cat]) {
      subcategoryCounts[cat] = {};
    }
    subcategoryCounts[cat][sub] = (subcategoryCounts[cat][sub] || 0) + cnt;
  }

  return { total, categoryCounts, subcategoryCounts };
}
