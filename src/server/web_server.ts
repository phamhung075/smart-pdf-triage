import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { Ollama } from 'ollama';
import { z } from 'zod';
import { CONFIG, BASE_DIR, updateConfig } from '../infrastructure/settings.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord, getDb, getCategorySubcategoryStats } from '../infrastructure/db/database.js';
import { checkModelCanGenerate } from '../infrastructure/ollama-client.js';
import { getCategoriesConfig, saveCategoriesConfig, setOnCategoryCreatedCallback } from '../infrastructure/categories-store.js';
import { syncJSONRegistry } from '../infrastructure/json-registry.js';
import { repairRegistry, clearRegistryAndMoveArchiveToRaws } from '../services/triage.service.js';
import { runTriageScan } from '../application/triage-scan.js';
import { relocalizeFileIfNeeded, findActualFileOnDisk, reclassifyAndRelocalizeDocument, ensureCategoryAndSubcategoryExist } from '../application/relocalize-document.js';
import { getPDFsRecursively } from '../infrastructure/pdf-scanner.js';
import { isForbiddenSubcategory } from '../domain/taxonomy.js';
import { logger } from '../infrastructure/logger.js';
import { UpdateDocumentSchema, SystemSettingsSchema, CategoriesConfigSchema } from '../domain/document.schema.js';
import { readActiveLockHolder, acquireProcessLock } from '../infrastructure/pid-lock.js';

export function createWebServer(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  setOnCategoryCreatedCallback(() => {
    broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });
  });

  const publicDir = path.join(BASE_DIR, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // Shared guard: prevents manual scan, the 10s auto-watcher, repair, and clear-registry
  // from ever running concurrently against the same __raws/__archive files in this process.
  let isAutoScanning = false;

  // Hot Reload / Live Reload SSE Endpoint
  const liveReloadClients: express.Response[] = [];
  app.get('/api/dev/livereload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    liveReloadClients.push(res);

    const cleanup = () => {
      const idx = liveReloadClients.indexOf(res);
      if (idx !== -1) liveReloadClients.splice(idx, 1);
    };
    req.on('close', cleanup);
    // Without this, a write to an abruptly-reset socket (network drop, sleep, tab
    // killed) throws an unhandled 'error' event — which crashes the whole process.
    res.on('error', cleanup);
  });

  if (fs.existsSync(publicDir)) {
    fs.watch(publicDir, { recursive: true }, () => {
      liveReloadClients.forEach(client => {
        client.write('data: reload\n\n');
      });
    });
  }

  // Open location in Windows Explorer endpoint
  app.post('/api/open-location', (req, res) => {
    try {
      const OpenLocationSchema = z.object({ targetPath: z.string().min(1) });
      const { targetPath } = OpenLocationSchema.parse(req.body);

      const normalized = path.normalize(targetPath);
      
      if (fs.existsSync(normalized)) {
        const stat = fs.statSync(normalized);
        const cmd = stat.isDirectory()
          ? `explorer "${normalized}"`
          : `explorer /select,"${normalized}"`;

        exec(cmd, (err) => {
          if (err) {
            console.warn(`Error launching Windows Explorer for ${normalized}:`, err.message);
          }
        });
        res.json({ message: 'Windows Explorer opened', path: normalized });
      } else {
        const parentDir = path.dirname(normalized);
        if (fs.existsSync(parentDir)) {
          exec(`explorer "${parentDir}"`);
          res.json({ message: 'Opened parent directory', path: parentDir });
        } else {
          res.status(404).json({ error: `Path does not exist: ${normalized}` });
        }
      }
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Ollama status check endpoint
  app.get('/api/ollama/status', async (req, res) => {
    const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
    try {
      const list = await ollama.list();
      const modelExists = list.models.some(m => m.name.includes(CONFIG.OLLAMA_MODEL));
      const health = modelExists ? await checkModelCanGenerate(CONFIG.OLLAMA_MODEL) : { ok: false, error: 'model not found locally' };
      res.json({
        online: true,
        model: CONFIG.OLLAMA_MODEL,
        host: CONFIG.OLLAMA_HOST,
        modelsCount: list.models.length,
        modelExists,
        modelCanGenerate: health.ok,
        modelError: health.ok ? undefined : health.error
      });
    } catch (err: any) {
      res.json({
        online: false,
        model: CONFIG.OLLAMA_MODEL,
        host: CONFIG.OLLAMA_HOST,
        error: err.message
      });
    }
  });

  // Endpoint to start/spawn local Ollama serve process
  app.post('/api/ollama/start', (req, res) => {
    try {
      exec('ollama serve', (err) => {
        if (err) {
          console.warn('Ollama serve launch info:', err.message);
        }
      });
      res.json({ message: 'Ollama serve launch initiated' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Endpoint to restart the server (useful when Ollama is disconnected)
  app.post('/api/server/restart', (req, res) => {
    res.json({ message: 'Server restarting...' });
    // Give the response a moment to be sent before exiting.
    setTimeout(() => {
      console.log('🛑 Server restart requested – exiting process');
      process.exit(0);
    }, 500);
  });

  // Repair registry endpoint
  app.post('/api/registry/repair', async (req, res) => {
    if (isAutoScanning) {
      res.status(409).json({ error: 'A scan/repair/clear operation is already in progress. Try again shortly.' });
      return;
    }
    isAutoScanning = true;
    try {
      const result = await repairRegistry();
      broadcastTriageEvent({ type: 'REPAIR_COMPLETED', ...result });
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED', action: 'REPAIR' });
      res.json({ message: 'Registry repair completed successfully', ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    } finally {
      isAutoScanning = false;
    }
  });

  // Get system config
  app.get('/api/config', (req, res) => {
    try {
      res.json({
        input_dir: CONFIG.INPUT_DIR,
        output_root_dir: CONFIG.OUTPUT_ROOT_DIR,
        ollama_model: CONFIG.OLLAMA_MODEL,
        ollama_host: CONFIG.OLLAMA_HOST,
        personal_name_denylist: CONFIG.PERSONAL_NAME_DENYLIST
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update system config
  app.put('/api/config', (req, res) => {
    try {
      const validated = SystemSettingsSchema.parse(req.body);
      updateConfig(validated);
      res.json({
        message: 'System settings updated successfully',
        config: {
          input_dir: CONFIG.INPUT_DIR,
          output_root_dir: CONFIG.OUTPUT_ROOT_DIR,
          ollama_model: CONFIG.OLLAMA_MODEL,
          ollama_host: CONFIG.OLLAMA_HOST,
          personal_name_denylist: CONFIG.PERSONAL_NAME_DENYLIST
        }
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Get categories with dynamic document counters from DB
  app.get('/api/categories', async (req, res) => {
    try {
      const config = getCategoriesConfig();
      const stats = await getCategorySubcategoryStats();

      const categoriesWithStats = config.categories.map(cat => {
        const catIdLower = cat.id.toLowerCase();
        const catCount = stats.categoryCounts[catIdLower] || 0;
        const subMap = stats.subcategoryCounts[catIdLower] || {};

        const subcategoriesWithStats = (cat.subcategories || []).map(sub => ({
          ...sub,
          count: subMap[sub.id.toLowerCase()] || 0
        }));

        // Dynamically include subcategories present in DB that are not yet in categories.json
        Object.keys(subMap).forEach(subId => {
          if (subId !== 'general' && !/^\d{4}$/.test(subId) && !subcategoriesWithStats.some(s => s.id.toLowerCase() === subId)) {
            const formattedName = subId.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            subcategoriesWithStats.push({
              id: subId,
              name: formattedName,
              aliases: [subId],
              count: subMap[subId]
            });
          }
        });

        return {
          ...cat,
          count: catCount,
          subcategories: subcategoriesWithStats
        };
      });

      res.json({
        totalDocuments: stats.total,
        categories: categoriesWithStats
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update categories
  app.put('/api/categories', (req, res) => {
    try {
      const validated = CategoriesConfigSchema.parse(req.body);
      saveCategoriesConfig(validated.categories);
      broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });
      res.json({
        message: 'Categories updated successfully',
        categories: validated.categories
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Rename a subcategory across all documents & relocalize physical files on disk
  app.post('/api/subcategories/rename', async (req, res) => {
    try {
      const { category, oldSubcategory, newSubcategory } = req.body || {};
      if (!category || !oldSubcategory || !newSubcategory) {
        return res.status(400).json({ error: 'Missing required parameters: category, oldSubcategory, newSubcategory' });
      }

      const cleanOld = oldSubcategory.toLowerCase().trim();
      const cleanNew = newSubcategory.toLowerCase().trim().replace(/[^a-z0-9_-]+/g, '_');

      if (cleanOld === cleanNew) {
        return res.json({ message: 'Subcategory name unchanged', count: 0 });
      }

      const config = getCategoriesConfig();
      const catObj = config.categories.find(c => c.id === category.toLowerCase().trim());
      if (catObj && catObj.subcategories) {
        const subObj = catObj.subcategories.find(s => s.id === cleanOld);
        if (subObj) {
          subObj.id = cleanNew;
          subObj.name = cleanNew.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          if (!subObj.aliases) subObj.aliases = [];
          if (!subObj.aliases.includes(cleanNew)) subObj.aliases.push(cleanNew);
        } else {
          catObj.subcategories.push({
            id: cleanNew,
            name: cleanNew.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
            aliases: [cleanNew]
          });
        }
        saveCategoriesConfig(config.categories);
      }

      const allDocs = await getAllDocuments();
      const matchingDocs = allDocs.filter(d => d.category.toLowerCase() === category.toLowerCase().trim() && (d.subcategory || '').toLowerCase() === cleanOld);

      let relocalizedCount = 0;
      for (const doc of matchingDocs) {
        const actualPath = findActualFileOnDisk(doc);
        if (actualPath && fs.existsSync(actualPath)) {
          const { newPath } = relocalizeFileIfNeeded(actualPath, doc.category, cleanNew, doc.date);
          await updateDocumentRecord(doc.id, {
            subcategory: cleanNew,
            new_path: newPath,
            status: 'MOVED'
          });
          relocalizedCount++;
        } else {
          await updateDocumentRecord(doc.id, { subcategory: cleanNew });
        }
      }

      await syncJSONRegistry();
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED' });
      broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });

      res.json({
        message: `Successfully renamed subcategory '${cleanOld}' ➔ '${cleanNew}' and relocalized ${relocalizedCount} physical file(s).`,
        count: relocalizedCount
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get documents list with search/category/subcategory filtering
  app.get('/api/documents', async (req, res) => {
    try {
      const docs = await getAllDocuments();
      const search = (req.query.q as string || '').toLowerCase();
      const category = (req.query.category as string || '').toLowerCase();
      const subcategory = (req.query.subcategory as string || '').toLowerCase();

      const filtered = docs.filter(doc => {
        const matchesCategory = !category || doc.category.toLowerCase() === category;
        const matchesSubcategory = !subcategory || (doc.subcategory && doc.subcategory.toLowerCase() === subcategory);
        const matchesQuery = !search ||
          doc.title.toLowerCase().includes(search) ||
          doc.summary.toLowerCase().includes(search) ||
          doc.registre.toLowerCase().includes(search) ||
          (doc.subcategory && doc.subcategory.toLowerCase().includes(search)) ||
          doc.tags.toLowerCase().includes(search) ||
          doc.raw_text.toLowerCase().includes(search);

        return matchesCategory && matchesSubcategory && matchesQuery;
      });

      const formatted = filtered.map(doc => ({
        id: doc.id,
        checksum: doc.checksum,
        title: doc.title,
        registre: doc.registre,
        date: doc.date,
        category: doc.category,
        subcategory: doc.subcategory || 'general',
        summary: doc.summary,
        tags: safeParseJSON(doc.tags, []),
        raw_text: doc.raw_text || '',
        markdown_content: doc.markdown_content || '',
        original_filename: doc.original_filename,
        original_path: doc.original_path,
        new_path: doc.new_path,
        status: doc.status,
        created_at: doc.created_at,
        updated_at: doc.updated_at
      }));

      res.json({ total: formatted.length, documents: formatted });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get single document with full raw text
  app.get('/api/documents/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const doc = await getDocumentById(id);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }

      res.json({
        ...doc,
        tags: safeParseJSON(doc.tags, [])
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Update document metadata & relocalize file if category/subcategory changed
  app.put('/api/documents/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const docBefore = await getDocumentById(id);
      const validatedUpdates = UpdateDocumentSchema.parse(req.body);

      // Golden Rule #4: reject an explicit attempt to set a forbidden subcategory
      // (general/other/divers/year) before writing anything — but don't re-block an
      // unrelated edit (e.g. just the title) on a document whose EXISTING subcategory
      // happens to already be one of these from before this rule was enforced everywhere.
      const explicitSubcategory = validatedUpdates.subcategory ?? validatedUpdates.subcategorie;
      if (explicitSubcategory !== undefined && isForbiddenSubcategory(explicitSubcategory)) {
        return res.status(400).json({ error: `'${explicitSubcategory}' is not a valid subcategory (general/other/divers/year strings are not allowed — Golden Rule #4). Please choose a specific entity or document-type name.` });
      }

      const success = await updateDocumentRecord(id, validatedUpdates);
      if (!success || !docBefore) {
        return res.status(404).json({ error: 'Document not found or update failed' });
      }

      // Automatically relocalize file on disk if category or subcategory changed
      if (docBefore.new_path && fs.existsSync(docBefore.new_path)) {
        const targetCategory = validatedUpdates.category || validatedUpdates.categorie || docBefore.category;
        const targetSubcategory = validatedUpdates.subcategory || validatedUpdates.subcategorie || docBefore.subcategory;
        // Golden Rule #5: the category/subcategory must exist in categories.json BEFORE
        // the physical move — this route previously skipped that step entirely.
        ensureCategoryAndSubcategoryExist(targetCategory, targetSubcategory);
        const { newPath } = relocalizeFileIfNeeded(
          docBefore.new_path,
          targetCategory,
          targetSubcategory,
          validatedUpdates.date || docBefore.date
        );
        if (newPath !== docBefore.new_path) {
          await updateDocumentRecord(id, { new_path: newPath });
        }
      }

      await syncJSONRegistry();
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED', action: 'EDIT', docId: id });
      const updatedDoc = await getDocumentById(id);
      res.json({
        message: 'Document updated successfully and relocalized if needed',
        document: {
          ...updatedDoc,
          tags: safeParseJSON(updatedDoc?.tags || '[]', [])
        }
      });
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  // Relocalize & Re-analyze a single document by ID with optional explicit category, subcategory, or AI feedback note
  app.post('/api/documents/:id/relocalize', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { category, subcategory, reason } = req.body || {};
      const result = await reclassifyAndRelocalizeDocument(id, category, subcategory, reason);
      if (!result.success) {
        return res.status(result.staleCleaned ? 404 : 400).json(result);
      }
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED', action: 'RELOCALIZE', docId: id });
      broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clear registry & move all files from __archive back to __raws
  app.delete('/api/documents', async (req, res) => {
    if (isAutoScanning) {
      res.status(409).json({ error: 'A scan/repair/clear operation is already in progress. Try again shortly.' });
      return;
    }
    isAutoScanning = true;
    try {
      const { countMoved } = await clearRegistryAndMoveArchiveToRaws();
      broadcastTriageEvent({ type: 'REGISTRY_UPDATED', action: 'CLEAR' });
      broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });
      res.json({
        message: `Registry cleared successfully. Moved ${countMoved} PDF file(s) from __archive back to __raws.`,
        countMoved
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    } finally {
      isAutoScanning = false;
    }
  });

  // SSE Triage Scan Live Progress Stream
  const triageSseClients: express.Response[] = [];
  app.get('/api/triage/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    triageSseClients.push(res);

    const cleanup = () => {
      const idx = triageSseClients.indexOf(res);
      if (idx !== -1) triageSseClients.splice(idx, 1);
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  });

  function broadcastTriageEvent(event: any) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    triageSseClients.forEach(client => {
      try {
        client.write(payload);
      } catch (e) {}
    });
  }

  // 10-Second Auto-Scan Watcher: Check __raws every 10s and put PDF into category pills automatically
  setInterval(async () => {
    if (isAutoScanning) return;
    try {
      const incoming = getPDFsRecursively(CONFIG.INPUT_DIR, CONFIG.OUTPUT_ROOT_DIR);
      if (incoming.length > 0) {
        isAutoScanning = true;
        logger.info('AUTO_WATCHER', `Auto-scan triggered: Found ${incoming.length} incoming PDF(s) in __raws`);
        await runTriageScan((evt) => {
          broadcastTriageEvent(evt);
        });
      }
    } catch (err: any) {
      logger.error('AUTO_WATCHER', `Error in 10s auto-scan watcher: ${err.message}`);
    } finally {
      isAutoScanning = false;
    }
  }, 10000);

  // Trigger triage scan with live progress broadcasting
  app.post('/api/triage/scan', async (req, res) => {
    if (isAutoScanning) {
      res.status(409).json({ error: 'A scan/repair/clear operation is already in progress. Try again shortly.' });
      return;
    }
    isAutoScanning = true;
    try {
      const result = await runTriageScan((evt) => {
        broadcastTriageEvent(evt);
      });
      res.json({ message: 'Triage scan completed', ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    } finally {
      isAutoScanning = false;
    }
  });

  return app;
}

function safeParseJSON(str: string, fallback: any) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

const PID_LOCK_FILE = path.join(BASE_DIR, '.server.lock');

// Prevent two instances of this server (e.g. a stale tsx-watch child that hasn't
// exited yet plus a freshly-spawned one) from running their auto-watchers
// concurrently against the same __raws/__archive files.
function acquireSingleInstanceLock(): void {
  const holderPid = readActiveLockHolder(PID_LOCK_FILE);
  if (holderPid !== null) {
    console.error(`Another instance of this server is already running (PID ${holderPid}). Refusing to start a second instance — stop it first, or delete ${PID_LOCK_FILE} if it's stale.`);
    process.exit(1);
  }

  const releaseLock = acquireProcessLock(PID_LOCK_FILE);
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });
}

export function startWebServer(port: number = CONFIG.PORT): void {
  acquireSingleInstanceLock();
  const app = createWebServer();
  const server = app.listen(port, () => {
    console.log(`Web Dashboard is running at http://localhost:${port} [Hot Reload Active 🔥]`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use — another process may already be bound to it. Exiting instead of running a zombie instance.`);
    } else {
      console.error('Web server failed to start:', err.message);
    }
    process.exit(1);
  });
}
