import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import http from 'http';
import type { AddressInfo } from 'net';
import type express from 'express';
import fs from 'fs';
import type { DocumentRecord } from '../db/database.js';

// This suite never touches the real project's pdf_triage.db, registry.json, categories.json,
// or __raws/__archive folders — every infrastructure/application dependency createWebServer()
// pulls in is mocked below, matching the house convention from database.test.ts /
// ollama-client.test.ts / classify-document.test.ts. fs is auto-mocked (no factory) exactly like
// classify-document.test.ts, so `fs.existsSync(publicDir)` returns falsy by default and
// createWebServer() never registers express.static(...) or a real fs.watch() on the actual
// public/ folder on disk.
vi.mock('fs');

const {
  getAllDocumentsMock,
  getDocumentByIdMock,
  updateDocumentRecordMock,
  getDbMock,
  getCategorySubcategoryStatsMock,
  getBlockedFileMock,
} = vi.hoisted(() => ({
  getAllDocumentsMock: vi.fn(),
  getDocumentByIdMock: vi.fn(),
  updateDocumentRecordMock: vi.fn(),
  getDbMock: vi.fn(),
  getCategorySubcategoryStatsMock: vi.fn(),
  getBlockedFileMock: vi.fn(),
}));
vi.mock('../db/database.js', () => ({
  getAllDocuments: getAllDocumentsMock,
  getDocumentById: getDocumentByIdMock,
  updateDocumentRecord: updateDocumentRecordMock,
  getDb: getDbMock,
  getCategorySubcategoryStats: getCategorySubcategoryStatsMock,
  getBlockedFile: getBlockedFileMock,
}));

const { checkModelCanGenerateMock } = vi.hoisted(() => ({ checkModelCanGenerateMock: vi.fn() }));
vi.mock('../ollama-client.js', () => ({ checkModelCanGenerate: checkModelCanGenerateMock }));

const {
  getCategoriesConfigMock,
  saveCategoriesConfigMock,
  setOnCategoryCreatedCallbackMock,
} = vi.hoisted(() => ({
  getCategoriesConfigMock: vi.fn(),
  saveCategoriesConfigMock: vi.fn(),
  setOnCategoryCreatedCallbackMock: vi.fn(),
}));
vi.mock('../categories-store.js', () => ({
  getCategoriesConfig: getCategoriesConfigMock,
  saveCategoriesConfig: saveCategoriesConfigMock,
  setOnCategoryCreatedCallback: setOnCategoryCreatedCallbackMock,
}));

const { syncJSONRegistryMock } = vi.hoisted(() => ({ syncJSONRegistryMock: vi.fn() }));
vi.mock('../json-registry.js', () => ({ syncJSONRegistry: syncJSONRegistryMock }));

const { clearRegistryAndMoveArchiveToRawsMock } = vi.hoisted(() => ({ clearRegistryAndMoveArchiveToRawsMock: vi.fn() }));
vi.mock('../../application/clear-registry.js', () => ({ clearRegistryAndMoveArchiveToRaws: clearRegistryAndMoveArchiveToRawsMock }));

const { repairRegistryMock } = vi.hoisted(() => ({ repairRegistryMock: vi.fn() }));
vi.mock('../../application/repair-registry.js', () => ({ repairRegistry: repairRegistryMock }));

const { runTriageScanMock } = vi.hoisted(() => ({ runTriageScanMock: vi.fn() }));
vi.mock('../../application/triage-scan.js', () => ({ runTriageScan: runTriageScanMock }));

const {
  relocalizeFileIfNeededMock,
  findActualFileOnDiskMock,
  reclassifyAndRelocalizeDocumentMock,
  ensureCategoryAndSubcategoryExistMock,
} = vi.hoisted(() => ({
  relocalizeFileIfNeededMock: vi.fn(),
  findActualFileOnDiskMock: vi.fn(),
  reclassifyAndRelocalizeDocumentMock: vi.fn(),
  ensureCategoryAndSubcategoryExistMock: vi.fn(),
}));
vi.mock('../../application/relocalize-document.js', () => ({
  relocalizeFileIfNeeded: relocalizeFileIfNeededMock,
  findActualFileOnDisk: findActualFileOnDiskMock,
  reclassifyAndRelocalizeDocument: reclassifyAndRelocalizeDocumentMock,
  ensureCategoryAndSubcategoryExist: ensureCategoryAndSubcategoryExistMock,
}));

const { getPDFsRecursivelyMock } = vi.hoisted(() => ({ getPDFsRecursivelyMock: vi.fn() }));
vi.mock('../pdf-scanner.js', () => ({ getPDFsRecursively: getPDFsRecursivelyMock }));

const { loggerMock, getRecentLogsMock } = vi.hoisted(() => ({
  loggerMock: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  getRecentLogsMock: vi.fn(() => []),
}));
vi.mock('../logger.js', async () => {
  const { EventEmitter } = await import('events');
  return {
    logger: loggerMock,
    getRecentLogs: getRecentLogsMock,
    logEmitter: new EventEmitter(),
  };
});

// domain/taxonomy.js and domain/document.schema.js are left un-mocked: both are pure,
// I/O-free modules (Zod schemas / string helpers), so exercising the real implementations
// through the route handlers is both safe and more representative than re-stubbing them.
vi.mock('../settings.js', () => ({
  CONFIG: {
    INPUT_DIR: 'C:/pdf-triage-test/__raws',
    OUTPUT_ROOT_DIR: 'C:/pdf-triage-test/__archive',
    OLLAMA_HOST: 'http://127.0.0.1:11434',
    OLLAMA_MODEL: 'qwen3.5:9b',
    PORT: 0,
    PERSONAL_NAME_DENYLIST: [] as string[],
  },
  BASE_DIR: 'C:/pdf-triage-test',
  updateConfig: vi.fn(),
}));

// Imported AFTER every vi.mock(...) above is registered (vi.mock calls are hoisted by
// vitest to the top of the module regardless of source position, but importing here keeps
// the file readable top-to-bottom).
import { createWebServer } from './web-server.js';

function sampleDoc(overrides: Partial<DocumentRecord> = {}): DocumentRecord {
  return {
    id: 1,
    checksum: 'abc123',
    title: 'Facture SFR Janvier',
    registre: 'REF-001',
    date: '2026-01-15',
    category: 'invoices',
    subcategory: 'sfr',
    summary: 'Facture mensuelle SFR pour janvier',
    tags: JSON.stringify(['facture', 'sfr']),
    raw_text: 'Contenu complet de la facture SFR de janvier 2026',
    markdown_content: '# Facture SFR',
    original_filename: 'facture.pdf',
    original_path: 'C:/pdf-triage-test/__raws/facture.pdf',
    new_path: '', // falsy on purpose: keeps PUT /api/documents/:id off the physical-relocalize branch
    embedding: '[]',
    status: 'COMPLETED',
    created_at: '2026-01-15T10:00:00.000Z',
    updated_at: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
}

function listen(app: express.Express): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, port });
    });
    server.on('error', reject);
  });
}

// superagent/supertest requests are lazy: `request(app).delete(...)` alone does NOT actually
// dispatch over the wire until `.then()`/`await`/`.end()` is called on it — so a "fire this
// request now but read its response later" pattern (needed to test the isAutoScanning
// concurrency guard below) must force immediate dispatch via `.end()` instead of relying on
// the thenable's lazy `.then()`, or the request never leaves the process and the racing
// second request has nothing to actually race against.
function fire(test: request.Test): Promise<request.Response> {
  return new Promise((resolve, reject) => {
    test.end((err, res) => (err ? reject(err) : resolve(res)));
  });
}

// Connects to the live SSE stream and resolves once the client has actually received the
// response headers — by that point the server-side handler has already pushed `res` into
// `triageSseClients`, so any mutation issued after this resolves is guaranteed to be seen.
function connectSSE(port: number): Promise<{ chunks: string[]; close: () => void }> {
  const chunks: string[] = [];
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/triage/events`, (res) => {
      res.on('data', (chunk) => chunks.push(chunk.toString()));
      resolve({ chunks, close: () => req.destroy() });
    });
  });
}

let app: express.Express;
let openServers: http.Server[] = [];

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);

  getAllDocumentsMock.mockReset().mockResolvedValue([]);
  getDocumentByIdMock.mockReset();
  updateDocumentRecordMock.mockReset();
  getDbMock.mockReset();
  getCategorySubcategoryStatsMock.mockReset().mockResolvedValue({ total: 0, categoryCounts: {}, subcategoryCounts: {} });
  getBlockedFileMock.mockReset();
  checkModelCanGenerateMock.mockReset();
  getCategoriesConfigMock.mockReset().mockReturnValue({ categories: [] });
  saveCategoriesConfigMock.mockReset();
  setOnCategoryCreatedCallbackMock.mockReset();
  syncJSONRegistryMock.mockReset().mockResolvedValue(undefined);
  clearRegistryAndMoveArchiveToRawsMock.mockReset();
  repairRegistryMock.mockReset();
  runTriageScanMock.mockReset().mockResolvedValue({});
  relocalizeFileIfNeededMock.mockReset();
  findActualFileOnDiskMock.mockReset();
  reclassifyAndRelocalizeDocumentMock.mockReset();
  ensureCategoryAndSubcategoryExistMock.mockReset();
  getPDFsRecursivelyMock.mockReset().mockReturnValue([]);

  // Golden Rule #17: the 10s auto-watcher must never fire on its own inside these tests —
  // faking only setInterval/clearInterval (not setTimeout/setImmediate/Date) keeps every other
  // route handler and Node/Express/supertest internal timing completely real, so the only
  // behavior under test-controlled time is the auto-watcher tick itself (advanced explicitly
  // via vi.advanceTimersByTimeAsync in the dedicated tests below).
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

  app = createWebServer();
  openServers = [];
});

afterEach(() => {
  vi.useRealTimers();
  for (const server of openServers) {
    try { server.close(); } catch {}
  }
});

describe('GET /api/documents', () => {
  it('returns the formatted, truncated document list', async () => {
    getAllDocumentsMock.mockResolvedValue([sampleDoc()]);

    const res = await request(app).get('/api/documents').expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.documents[0]).toMatchObject({
      id: 1,
      title: 'Facture SFR Janvier',
      category: 'invoices',
      subcategory: 'sfr',
      tags: ['facture', 'sfr'],
    });
  });

  it('filters by category and subcategory query params, case-insensitively', async () => {
    getAllDocumentsMock.mockResolvedValue([
      sampleDoc({ id: 1, category: 'invoices', subcategory: 'sfr' }),
      sampleDoc({ id: 2, category: 'invoices', subcategory: 'edf', checksum: 'c2' }),
      sampleDoc({ id: 3, category: 'health', subcategory: 'general', checksum: 'c3' }),
    ]);

    const res = await request(app).get('/api/documents?category=INVOICES&subcategory=SFR').expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.documents[0].id).toBe(1);
  });

  it('filters by the free-text search query across title/summary/tags/raw_text', async () => {
    getAllDocumentsMock.mockResolvedValue([
      sampleDoc({ id: 1, title: 'Facture SFR' }),
      sampleDoc({ id: 2, title: 'Bulletin de Salaire', summary: 'Paie mensuelle', checksum: 'c2' }),
    ]);

    const res = await request(app).get('/api/documents?q=salaire').expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.documents[0].id).toBe(2);
  });

  it('returns 500 with the error message when the DB layer throws', async () => {
    getAllDocumentsMock.mockRejectedValue(new Error('DB unavailable'));

    const res = await request(app).get('/api/documents').expect(500);
    expect(res.body.error).toBe('DB unavailable');
  });
});

describe('GET /api/documents/:id', () => {
  it('returns the full document with tags parsed', async () => {
    getDocumentByIdMock.mockResolvedValue(sampleDoc());

    const res = await request(app).get('/api/documents/1').expect(200);

    expect(res.body.title).toBe('Facture SFR Janvier');
    expect(res.body.tags).toEqual(['facture', 'sfr']);
  });

  it('returns 404 when the document does not exist', async () => {
    getDocumentByIdMock.mockResolvedValue(undefined);

    const res = await request(app).get('/api/documents/999').expect(404);
    expect(res.body.error).toBe('Document not found');
  });
});

describe('PUT /api/documents/:id', () => {
  it('updates metadata, re-syncs the JSON registry, and returns the updated document', async () => {
    getDocumentByIdMock.mockResolvedValue(sampleDoc());
    updateDocumentRecordMock.mockResolvedValue(true);

    const res = await request(app)
      .put('/api/documents/1')
      .send({ summary: 'Updated summary' })
      .expect(200);

    expect(updateDocumentRecordMock).toHaveBeenCalledWith(1, expect.objectContaining({ summary: 'Updated summary' }));
    expect(syncJSONRegistryMock).toHaveBeenCalledTimes(1);
    expect(res.body.message).toMatch(/updated successfully/i);
  });

  it('does NOT attempt physical relocalization when the document has no new_path on disk', async () => {
    getDocumentByIdMock.mockResolvedValue(sampleDoc({ new_path: '' }));
    updateDocumentRecordMock.mockResolvedValue(true);

    await request(app).put('/api/documents/1').send({ summary: 'x' }).expect(200);

    expect(relocalizeFileIfNeededMock).not.toHaveBeenCalled();
  });

  it('rejects an explicit forbidden subcategory (general/other/divers/year) — Golden Rule #4', async () => {
    getDocumentByIdMock.mockResolvedValue(sampleDoc());

    const res = await request(app)
      .put('/api/documents/1')
      .send({ subcategory: 'general' })
      .expect(400);

    expect(res.body.error).toMatch(/not a valid subcategory/i);
    expect(updateDocumentRecordMock).not.toHaveBeenCalled();
  });

  it('rejects a year-string subcategory — Golden Rule #4', async () => {
    getDocumentByIdMock.mockResolvedValue(sampleDoc());

    const res = await request(app)
      .put('/api/documents/1')
      .send({ subcategorie: '2026' })
      .expect(400);

    expect(res.body.error).toMatch(/not a valid subcategory/i);
  });

  it('returns 404 when the document does not exist', async () => {
    getDocumentByIdMock.mockResolvedValue(undefined);
    updateDocumentRecordMock.mockResolvedValue(false);

    const res = await request(app).put('/api/documents/999').send({ summary: 'x' }).expect(404);
    expect(res.body.error).toBe('Document not found or update failed');
  });
});

describe('SSE broadcast on mutation (Golden Rule #10)', () => {
  it('broadcasts a REGISTRY_UPDATED/EDIT event to connected SSE clients when a document is edited', async () => {
    getDocumentByIdMock.mockResolvedValue(sampleDoc());
    updateDocumentRecordMock.mockResolvedValue(true);

    const { server, port } = await listen(app);
    openServers.push(server);
    const sse = await connectSSE(port);

    await request(server).put('/api/documents/1').send({ summary: 'Updated summary' }).expect(200);
    // Real setTimeout (not faked — only setInterval/clearInterval are) so the loopback SSE
    // chunk has a moment to actually arrive before we assert on it.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const received = sse.chunks.join('');
    expect(received).toContain('"type":"REGISTRY_UPDATED"');
    expect(received).toContain('"action":"EDIT"');
    expect(received).toContain('"docId":1');

    sse.close();
  });
});

describe('DELETE /api/documents (Clear Registry semantics — Golden Rule #15)', () => {
  it('moves archived files back to __raws, purges SQLite, and broadcasts REGISTRY_UPDATED + CATEGORIES_UPDATED', async () => {
    clearRegistryAndMoveArchiveToRawsMock.mockResolvedValue({ countMoved: 3 });

    const { server, port } = await listen(app);
    openServers.push(server);
    const sse = await connectSSE(port);

    const res = await request(server).delete('/api/documents').expect(200);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(res.body.countMoved).toBe(3);
    expect(res.body.message).toMatch(/Moved 3 PDF file\(s\)/);
    expect(clearRegistryAndMoveArchiveToRawsMock).toHaveBeenCalledTimes(1);

    const received = sse.chunks.join('');
    expect(received).toContain('"type":"REGISTRY_UPDATED"');
    expect(received).toContain('"action":"CLEAR"');
    expect(received).toContain('"type":"CATEGORIES_UPDATED"');

    sse.close();
  });

  it('returns 409 instead of running concurrently when a scan/repair/clear is already in progress', async () => {
    let releaseClear!: () => void;
    // Resolving `started` from inside the mock implementation itself — rather than guessing
    // a sleep duration — pins down the exact moment the route handler has entered the async
    // function and reached `isAutoScanning = true` (which happens synchronously, immediately
    // before this call), so the second request below is deterministically guaranteed to see it.
    const started = new Promise<void>((resolveStarted) => {
      clearRegistryAndMoveArchiveToRawsMock.mockImplementation(() => new Promise((resolve) => {
        releaseClear = () => resolve({ countMoved: 1 });
        resolveStarted();
      }));
    });

    const firstRequest = fire(request(app).delete('/api/documents'));
    await started;

    const second = await request(app).delete('/api/documents').expect(409);
    expect(second.body.error).toMatch(/already in progress/i);

    releaseClear();
    const first = await firstRequest;
    expect(first.status).toBe(200);
  });

  it('propagates a 500 when the clear operation fails, and does not leave isAutoScanning stuck', async () => {
    clearRegistryAndMoveArchiveToRawsMock.mockRejectedValueOnce(new Error('disk error'));
    const failed = await request(app).delete('/api/documents').expect(500);
    expect(failed.body.error).toBe('disk error');

    // The `finally { isAutoScanning = false }` guard must have run — a subsequent call
    // should be free to proceed instead of getting stuck behind a false-positive 409.
    clearRegistryAndMoveArchiveToRawsMock.mockResolvedValueOnce({ countMoved: 0 });
    await request(app).delete('/api/documents').expect(200);
  });
});

describe('POST /api/triage/scan', () => {
  it('runs a triage scan and returns its result', async () => {
    runTriageScanMock.mockResolvedValue({ scannedCount: 2, processedCount: 2 });

    const res = await request(app).post('/api/triage/scan').expect(200);

    expect(res.body.message).toBe('Triage scan completed');
    expect(res.body.scannedCount).toBe(2);
    expect(runTriageScanMock).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when a scan is already running (shared isAutoScanning guard)', async () => {
    let releaseScan!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      runTriageScanMock.mockImplementation(() => new Promise((resolve) => {
        releaseScan = () => resolve({});
        resolveStarted();
      }));
    });

    const firstRequest = fire(request(app).post('/api/triage/scan'));
    await started;

    await request(app).post('/api/triage/scan').expect(409);

    releaseScan();
    await firstRequest;
  });
});

describe('GET /api/categories', () => {
  it('merges DB-derived counts onto the configured categories', async () => {
    getCategoriesConfigMock.mockReturnValue({
      categories: [
        { id: 'invoices', name: 'Factures', description: '', aliases: [], subcategories: [{ id: 'sfr', name: 'SFR', aliases: [] }] },
      ],
    });
    getCategorySubcategoryStatsMock.mockResolvedValue({
      total: 5,
      categoryCounts: { invoices: 5 },
      subcategoryCounts: { invoices: { sfr: 3, edf: 2 } },
    });

    const res = await request(app).get('/api/categories').expect(200);

    expect(res.body.totalDocuments).toBe(5);
    const invoices = res.body.categories.find((c: any) => c.id === 'invoices');
    expect(invoices.count).toBe(5);
    const sfr = invoices.subcategories.find((s: any) => s.id === 'sfr');
    expect(sfr.count).toBe(3);
    // 'edf' exists in DB stats but not yet in categories.json — the route must surface it
    // dynamically so a document isn't invisible in the UI just because no one renamed it in yet.
    const edf = invoices.subcategories.find((s: any) => s.id === 'edf');
    expect(edf).toBeDefined();
    expect(edf.count).toBe(2);
  });

  it('excludes "general" and bare year strings from the dynamically-surfaced subcategories', async () => {
    getCategoriesConfigMock.mockReturnValue({
      categories: [{ id: 'invoices', name: 'Factures', description: '', aliases: [], subcategories: [] }],
    });
    getCategorySubcategoryStatsMock.mockResolvedValue({
      total: 2,
      categoryCounts: { invoices: 2 },
      subcategoryCounts: { invoices: { general: 1, '2026': 1 } },
    });

    const res = await request(app).get('/api/categories').expect(200);
    const invoices = res.body.categories.find((c: any) => c.id === 'invoices');
    expect(invoices.subcategories).toHaveLength(0);
  });
});

describe('10-second auto-watcher tick (Golden Rule #17)', () => {
  it('kicks off a triage scan when __raws has unblocked PDFs and no scan is in progress', async () => {
    getPDFsRecursivelyMock.mockReturnValue(['C:/pdf-triage-test/__raws/incoming.pdf']);
    getBlockedFileMock.mockResolvedValue(undefined); // not previously blocked
    runTriageScanMock.mockResolvedValue({});

    await vi.advanceTimersByTimeAsync(10_000);

    expect(runTriageScanMock).toHaveBeenCalledTimes(1);
  });

  it('does nothing when __raws has no PDFs', async () => {
    getPDFsRecursivelyMock.mockReturnValue([]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(runTriageScanMock).not.toHaveBeenCalled();
  });

  it('skips files that are already blocked with an unchanged mtime/size (Golden Rule #3 no-text guard)', async () => {
    getPDFsRecursivelyMock.mockReturnValue(['C:/pdf-triage-test/__raws/blocked.pdf']);
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ mtimeMs: 111, size: 222 } as fs.Stats);
    getBlockedFileMock.mockResolvedValue({
      original_path: 'C:/pdf-triage-test/__raws/blocked.pdf',
      filename: 'blocked.pdf',
      reason: 'no_text',
      message: 'Blocked: No text extracted from PDF.',
      mtime_ms: 111,
      size: 222,
    });

    await vi.advanceTimersByTimeAsync(10_000);

    expect(runTriageScanMock).not.toHaveBeenCalled();
  });

  it('does not overlap with an in-flight manual scan (shared isAutoScanning guard)', async () => {
    getPDFsRecursivelyMock.mockReturnValue(['C:/pdf-triage-test/__raws/incoming.pdf']);
    getBlockedFileMock.mockResolvedValue(undefined);

    let releaseManualScan!: () => void;
    const started = new Promise<void>((resolveStarted) => {
      runTriageScanMock.mockImplementation(() => new Promise((resolve) => {
        releaseManualScan = () => resolve({});
        resolveStarted();
      }));
    });

    const manualScan = fire(request(app).post('/api/triage/scan'));
    await started;

    await vi.advanceTimersByTimeAsync(10_000);
    // Only the manual scan's call should have happened — the tick must have returned early.
    expect(runTriageScanMock).toHaveBeenCalledTimes(1);

    releaseManualScan();
    await manualScan;
  });
});
