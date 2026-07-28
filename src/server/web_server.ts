import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { exec } from 'child_process';
import { Ollama } from 'ollama';
import { z } from 'zod';
import { CONFIG, updateConfig } from '../config.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord, getDb, getCategorySubcategoryStats } from '../db/database.js';
import { getCategoriesConfig, saveCategoriesConfig, setOnCategoryCreatedCallback } from '../services/ai.service.js';
import { syncJSONRegistry } from '../services/json_registry.service.js';
import { runTriageScan, repairRegistry, relocalizeFileIfNeeded, getPDFsRecursively, findActualFileOnDisk, reclassifyAndRelocalizeDocument, clearRegistryAndMoveArchiveToRaws } from '../services/triage.service.js';
import { logger } from '../services/logger.service.js';
import { UpdateDocumentSchema, SystemSettingsSchema, CategoriesConfigSchema } from '../schemas/document.schema.js';

export function createWebServer(): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json());

  setOnCategoryCreatedCallback(() => {
    broadcastTriageEvent({ type: 'CATEGORIES_UPDATED' });
  });

  const publicDir = path.resolve('D:/DaiHung/__projet/__master/pdf_triage/public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
  }

  // Hot Reload / Live Reload SSE Endpoint
  const liveReloadClients: express.Response[] = [];
  app.get('/api/dev/livereload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    liveReloadClients.push(res);

    req.on('close', () => {
      const idx = liveReloadClients.indexOf(res);
      if (idx !== -1) liveReloadClients.splice(idx, 1);
    });
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
      res.json({
        online: true,
        model: CONFIG.OLLAMA_MODEL,
        host: CONFIG.OLLAMA_HOST,
        modelsCount: list.models.length,
        modelExists
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
    try {
      const result = await repairRegistry();
      res.json({ message: 'Registry repair completed successfully', ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Clear all document records
  app.delete('/api/documents', async (req, res) => {
    try {
      const db = await getDb();
      await db.exec('DELETE FROM documents;');
      try {
        await db.exec('DELETE FROM documents_fts;');
      } catch (e) {}
      await syncJSONRegistry();
      res.json({ message: 'All registry records cleared successfully' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Get system config
  app.get('/api/config', (req, res) => {
    try {
      res.json({
        input_dir: CONFIG.INPUT_DIR,
        output_root_dir: CONFIG.OUTPUT_ROOT_DIR,
        ollama_model: CONFIG.OLLAMA_MODEL,
        ollama_host: CONFIG.OLLAMA_HOST
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
          ollama_host: CONFIG.OLLAMA_HOST
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

      const success = await updateDocumentRecord(id, validatedUpdates);
      if (!success || !docBefore) {
        return res.status(404).json({ error: 'Document not found or update failed' });
      }

      // Automatically relocalize file on disk if category or subcategory changed
      if (docBefore.new_path && fs.existsSync(docBefore.new_path)) {
        const targetCategory = validatedUpdates.category || validatedUpdates.categorie || docBefore.category;
        const targetSubcategory = validatedUpdates.subcategory || validatedUpdates.subcategorie || docBefore.subcategory;
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

    req.on('close', () => {
      const idx = triageSseClients.indexOf(res);
      if (idx !== -1) triageSseClients.splice(idx, 1);
    });
  });

  function broadcastTriageEvent(event: any) {
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    triageSseClients.forEach(client => client.write(payload));
  }

  // 10-Second Auto-Scan Watcher: Check __raws every 10s and put PDF into category pills automatically
  let isAutoScanning = false;
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
    try {
      const result = await runTriageScan((evt) => {
        broadcastTriageEvent(evt);
      });
      res.json({ message: 'Triage scan completed', ...result });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
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

export function startWebServer(port: number = CONFIG.PORT): void {
  const app = createWebServer();
  app.listen(port, () => {
    console.log(`Web Dashboard is running at http://localhost:${port} [Hot Reload Active 🔥]`);
  });
}
