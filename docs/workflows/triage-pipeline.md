# 🔄 Triage Pipeline

Entry: `runTriageScan(onProgress?)` in `src/application/triage-scan.ts`.

## Trigger points

- `npm run scan` (one-shot).
- `POST /api/triage/scan` (manual button in UI).
- 10 s auto-watcher tick when `__raws` has PDFs and `isAutoScanning === false`.

## Steps per file (strictly sequential)

For each PDF found by `getPDFsRecursively(INPUT_DIR, OUTPUT_ROOT_DIR)`:

1. **Broadcast `FILE_PROGRESS { stage: 'EXTRACTING_TEXT' }`**.
2. **`extractPDFContent(originalPath)`** → `{ checksum, raw_text }`.
3. **No-text guard**: if `cleanText.length < 10`:
   - Log `TRIAGE` warn, emit `FILE_FAILED { message: '❌ Blocked: No text extracted from PDF. Kept in __raws.' }`.
   - Yield 50 ms, `continue`. No DB row, no move.
4. **Dedupe**: `getDocumentByChecksum(checksum)`. If found:
   - `skippedCount++`, push a `SKIPPED_DUPLICATE` item.
   - Emit `FILE_COMPLETED { stage: 'SKIPPED_DUPLICATE' }`.
   - Yield 50 ms, `continue`.
5. **Broadcast `FILE_PROGRESS { stage: 'AI_CLASSIFYING' }`**.
6. **`classifyPDFText(raw_text, file)`** → validated `DocumentMetadata` (may auto-create category / subcategory in `categories.json` as a side-effect).
7. **Strict no-subcategory fail guard**: if `subcategorie` is empty / `general` / `other` / `divers`:
   - Log warn, emit `FILE_FAILED`.
   - Yield 50 ms, `continue`. No DB row, no move.
8. **`generateEmbedding(raw_text)`** — best-effort, returns `[]` on failure.
9. **`insertDocumentRecord(…)`** with `status: 'PENDING'` — enforces UNIQUE(checksum).
10. **Broadcast `FILE_PROGRESS { stage: 'RELOCALIZING' }`**.
11. **`relocalizeFileIfNeeded(originalPath, categorie, subcategorie, date)`** → moves the file to canonical archive path.
12. **`updateDocumentRecord(docId, { new_path: finalTargetPath, status: 'MOVED' })`**.
13. **`processedCount++`**, push a `MOVED` item.
14. **Broadcast `FILE_COMPLETED { stage: 'COMPLETED', …metadata }`**.
15. **Yield 50 ms** (event loop breather).

## Errors per file

Caught in the outer `try/catch`. Emit `FILE_FAILED { message: err.message }`. Yield 50 ms. Continue with the next file.

## After the loop

1. `syncJSONRegistry()` — mirror SQLite to `registry.json`.
2. Broadcast `SCAN_COMPLETED { scannedCount, processedCount, skippedCount }`.
3. Return `{ scannedCount, processedCount, skippedCount, items }`.

## Auto-watcher guard

```ts
let isAutoScanning = false;
setInterval(async () => {
  if (isAutoScanning) return;
  const incoming = getPDFsRecursively(INPUT_DIR, OUTPUT_ROOT_DIR);
  if (incoming.length === 0) return;
  isAutoScanning = true;
  try { await runTriageScan(broadcastTriageEvent); }
  finally { isAutoScanning = false; }
}, 10000);
```

The `ignoreDir` parameter to `getPDFsRecursively` ensures `__archive` (if it happens to sit under `__raws`) is never re-scanned.

## Golden rules that apply

Rules #1, #3, #4, #5, #6, #8, #9, #10, #11, #12, #17, #19, #20 all fire in this pipeline.

## Who owns this file

[pipeline-engineer](../agents/pipeline-engineer.md). Cross-cutting changes to classification behavior: also loop in [classification-expert](../agents/classification-expert.md).
