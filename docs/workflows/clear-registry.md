# 🗑️ Clear Registry

Entry: `clearRegistryAndMoveArchiveToRaws()` in `src/services/triage.service.ts`. HTTP: `DELETE /api/documents`.

## Contract

Return every archived PDF to `__raws`, then wipe the DB. **Never delete PDFs.**

## Steps

1. `reloadConfigFromDisk()` + `ensureDirectoriesExist()`.
2. Iterate every DB record. For each:
   - Locate file via `findActualFileOnDisk(doc)`.
   - If it exists AND is inside `OUTPUT_ROOT_DIR` → `moveBackToRaws(actualPath)`. `countMoved++`.
   - Files outside `__archive` (already in `__raws`, or missing) are left alone.
3. `db.run('DELETE FROM documents')` + try `DELETE FROM documents_fts`.
4. Recursively delete every file and subfolder inside `OUTPUT_ROOT_DIR`, then re-`ensureDirectoriesExist()` to recreate the empty root.
5. `syncJSONRegistry()` (writes an empty registry).
6. Broadcast `REGISTRY_UPDATED { action: 'CLEAR' }` + `CATEGORIES_UPDATED`.
7. Return `{ countMoved }`.

## Why the recursive dir wipe

After step 2, `__archive` is empty of PDFs but still has the category/subcategory/year folder tree. Step 4 removes that skeleton so the next scan reconstructs it cleanly, and stale empty folders don't confuse the UI.

## What NOT to do

- Do not `fs.unlink` a PDF. Always `renameSync` to `__raws`.
- Do not skip the physical move because the DB delete is faster. The DB is the mirror; disk is the truth.
- Do not delete `INPUT_DIR` — it may contain user-supplied files that were never triaged.

## UI wiring

Header button `🗑️ Clear Registry` → confirm modal → `DELETE /api/documents` → toast with `countMoved`.

## Owner

Server: [pipeline-engineer](../agents/pipeline-engineer.md). Confirm modal: [ui-frontend](../agents/ui-frontend.md).
