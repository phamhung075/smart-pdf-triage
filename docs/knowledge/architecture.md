# 🏛️ Architecture

## Module map

```
src/
├── index.ts                    # Dispatcher: default web, `scan`, `mcp`
├── config.ts                   # CONFIG + settings.json load/save
├── db/database.ts              # SQLite open, schema init, CRUD, FTS5
├── schemas/document.schema.ts  # Zod contracts (validation only)
├── services/
│   ├── pdf.service.ts          # extractPDFContent() + SHA-256 checksum
│   ├── ai.service.ts           # Ollama classify + rule-based fallback + taxonomy CRUD
│   ├── triage.service.ts       # Pipeline + repair + relocalize + clear
│   ├── json_registry.service.ts # SQLite → registry.json mirror
│   └── logger.service.ts       # Color terminal + file logs
├── server/web_server.ts        # Express + SSE + REST + 10s watcher
└── mcp/server.ts               # MCP tools over stdio
public/                         # UI (index.html, app.js, style.css)
```

## Ownership boundaries

| Module                     | Owner agent            | May write to             |
| -------------------------- | ---------------------- | ------------------------ |
| `services/pdf.service.ts`  | pipeline-engineer      | itself                   |
| `services/ai.service.ts`   | classification-expert  | itself, categories.json  |
| `services/triage.service.ts` | pipeline-engineer    | itself, uses DB + AI     |
| `services/json_registry.service.ts` | db-registry-keeper | itself, registry.json |
| `db/database.ts`           | db-registry-keeper     | itself, pdf_triage.db    |
| `schemas/*`                | classification-expert (data) + db-registry-keeper (records) | itself |
| `server/web_server.ts`     | pipeline-engineer      | itself                   |
| `mcp/server.ts`            | mcp-integrator         | itself                   |
| `public/*`                 | ui-frontend            | itself                   |
| Ollama connectivity        | ollama-ops             | ai.service.ts (limited)  |

Cross-module edits: do them, but ping [qa-reviewer](../agents/qa-reviewer.md) via a review pass.

## Layering (domain / application / infrastructure)

`src/` is organized into three layers, each with a one-way dependency rule:

- **`src/domain/`** — pure logic, zero I/O. No `fs`, no network calls, no reading
  `CONFIG` or environment variables. Functions take data as parameters and return
  data. Includes classification rules (`classification.ts`), Qwen prompt building
  (`prompt.ts`), category/subcategory resolution (`classification-resolution.ts`),
  taxonomy/path helpers (`taxonomy.ts`), text cleanup (`pdf-text.ts`), and the Zod
  schemas (`document.schema.ts`).
- **`src/application/`** — orchestration ("use cases"). Fetches data via
  infrastructure, calls domain functions to decide what to do, calls infrastructure
  again to persist or act. This is where `classifyPDFText`, `runTriageScan`,
  `repairRegistry`, the relocalize/clear-registry flows, and the cross-process
  scan lock live.
- **`src/infrastructure/`** — all I/O adapters: SQLite (`db/database.ts`), the
  filesystem-backed settings/categories/entity-dictionary/JSON-registry stores,
  the Ollama client, the PDF extractor/scanner, the shared PID-lock helper, the
  Express HTTP server (`http/web-server.ts`), and the MCP stdio server
  (`mcp/mcp-server.ts`).

Dependency direction: `infrastructure/` and `application/` may import from
`domain/`; `domain/` never imports from the other two. `application/` may import
from `infrastructure/`; `infrastructure/` never imports from `application/`.
`src/index.ts` is the composition root — the only place that wires a concrete
infrastructure adapter (e.g. `startWebServer`) to the application layer.

This structure exists so the pure decision logic (which category, which
subcategory, is this slug grounded, what canonical path) can be unit-tested
without mocking `fs`/`CONFIG`/Ollama — see
`docs/superpowers/specs/2026-07-31-test-harness-design.md` (Phase 1) and
`docs/superpowers/specs/2026-07-31-ddd-restructure-design.md` (Phase 2, this
restructuring).

## Data flow (steady state)

1. `web_server.ts` boots, static-serves `public/`, opens SSE endpoints, starts the 10 s auto-watcher.
2. Auto-watcher calls `runTriageScan(broadcast)` when `__raws` has PDFs.
3. `triage.service.ts` walks `__raws`, for each PDF:
   - `pdf.service.extractPDFContent()` → `{checksum, raw_text, numpages, info}`.
   - Dedup check via `getDocumentByChecksum(checksum)`.
   - `ai.service.classifyPDFText()` → validated `DocumentMetadata`.
   - `insertDocumentRecord()` → SQLite + FTS5.
   - `relocalizeFileIfNeeded()` → moves file to canonical path.
   - `updateDocumentRecord(id, { new_path, status: 'MOVED' })`.
   - `syncJSONRegistry()`.
4. SSE clients receive `FILE_PROGRESS`, `FILE_COMPLETED`/`FAILED`, then `SCAN_COMPLETED`.
5. UI subscribes to `/api/triage/events` and repaints pills + cards live.

## MCP path

`src/mcp/server.ts` exposes tools (`search_documents`, `get_full_document_text`, `update_document_metadata`, `trigger_triage`, `list_categories`) over stdio. Runs as a separate process (`npm run mcp`); shares the SQLite DB and categories.json but does NOT bring up the web server.

## SQLite tables

- `documents` — the record of truth (see [data-model](./data-model.md)).
- `documents_fts` — FTS5 virtual mirror for search. May not exist if the SQLite build lacks FTS5; all writes are wrapped in try/catch.
- `categories_db` — legacy scaffold table; the taxonomy source of truth is the JSON file `categories.json`, not this table.

## Config resolution order (highest wins)

1. `settings.json` (project-local, editable via Settings modal or `PUT /api/config`).
2. Environment variables (`PDF_INPUT_DIR`, `PDF_OUTPUT_DIR`, `PDF_REGISTRY_PATH`, `PDF_DB_PATH`, `OLLAMA_HOST`, `OLLAMA_MODEL`, `OLLAMA_EMBED_MODEL`, `PORT`).
3. Defaults in `src/config.ts`.

## Threading model

Single-process Node event loop. No worker threads. Long tasks (Ollama call, PDF parse) are async I/O — the 50 ms yield between files keeps SSE and HTTP responsive.
