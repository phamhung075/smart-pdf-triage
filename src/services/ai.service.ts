import { Ollama } from 'ollama';
import fs from 'fs';
import { CONFIG } from '../infrastructure/settings.js';
import { DocumentMetadataSchema, DocumentMetadata, SubcategoryItem, EntityDictionarySchema, EntityDictionary } from '../domain/document.schema.js';
import { logger } from '../infrastructure/logger.js';
import { cleanAndParseJSON, ruleBasedClassify, isGroundedSubcategorySlug, normalizeSlug, buildCategoriesDescriptionStr } from '../domain/classification.js';
import { buildClassificationPrompt } from '../domain/prompt.js';
import { refineClassification, resolveCategory, resolveSubcategory } from '../domain/classification-resolution.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';

export function getEntityDictionary(): EntityDictionary {
  if (fs.existsSync(CONFIG.ENTITY_DICTIONARY_FILE)) {
    try {
      const raw = fs.readFileSync(CONFIG.ENTITY_DICTIONARY_FILE, 'utf-8');
      return EntityDictionarySchema.parse(JSON.parse(raw));
    } catch (e) {
      console.error("Invalid entity_dictionary.json schema, using empty dictionary", e);
    }
  }
  return EntityDictionarySchema.parse({});
}

interface ModelHealthCacheEntry {
  modelName: string;
  checkedAt: number;
  canGenerate: boolean;
  error?: string;
}
let modelHealthCache: ModelHealthCacheEntry | null = null;
const MODEL_HEALTH_CACHE_TTL_MS = 5 * 60 * 1000;

// A model can pass the "exists locally" check (ollama.list()) yet still be unable to
// generate — e.g. a cloud/subscription-gated model that's listed but rejects requests
// at generate-time. This does a cheap 1-token generation to catch that proactively,
// cached briefly so it isn't repeated on every single document classification.
export async function checkModelCanGenerate(modelName: string, host: string = CONFIG.OLLAMA_HOST, forceRefresh = false): Promise<{ ok: boolean; error?: string }> {
  const now = Date.now();
  if (!forceRefresh && modelHealthCache && modelHealthCache.modelName === modelName && (now - modelHealthCache.checkedAt) < MODEL_HEALTH_CACHE_TTL_MS) {
    return { ok: modelHealthCache.canGenerate, error: modelHealthCache.error };
  }
  const ollama = new Ollama({ host });
  try {
    await ollama.generate({ model: modelName, prompt: 'test', options: { num_predict: 1 } });
    modelHealthCache = { modelName, checkedAt: now, canGenerate: true };
    return { ok: true };
  } catch (err: any) {
    modelHealthCache = { modelName, checkedAt: now, canGenerate: false, error: err.message };
    return { ok: false, error: err.message };
  }
}

export async function ensureOllamaModel(modelName: string = CONFIG.OLLAMA_MODEL): Promise<boolean> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  try {
    const list = await ollama.list();
    const exists = list.models.some(m => m.name.startsWith(modelName) || m.name.includes(modelName));
    if (!exists) {
      console.log(`Model '${modelName}' not found locally in Ollama. Pulling '${modelName}'...`);
      await ollama.pull({ model: modelName });
      console.log(`Model '${modelName}' pulled successfully.`);
    }
    const health = await checkModelCanGenerate(modelName);
    if (!health.ok) {
      console.warn(`Model '${modelName}' exists locally but cannot generate (e.g. subscription-gated cloud model): ${health.error}`);
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`Ollama check/pull warning for model ${modelName}:`, err.message);
    try {
      console.log('Attempting auto-spawn of local Ollama serve process...');
      const { exec } = await import('child_process');
      exec('ollama serve');
      await new Promise(r => setTimeout(r, 2000));
      const retryList = await ollama.list();
      const existsAfterSpawn = retryList.models.some(m => m.name.startsWith(modelName) || m.name.includes(modelName));
      if (!existsAfterSpawn) return false;
      const health = await checkModelCanGenerate(modelName, CONFIG.OLLAMA_HOST, true);
      return health.ok;
    } catch (autoErr: any) {
      console.error('Failed to auto-spawn Ollama:', autoErr.message);
      return false;
    }
  }
}

export async function classifyPDFText(rawText: string, filename: string, previousError?: string): Promise<DocumentMetadata> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  const modelHealthy = await ensureOllamaModel(CONFIG.OLLAMA_MODEL);

  const categoriesConfig = getCategoriesConfig();
  const dictionary = getEntityDictionary();
  const categoriesDescriptionStr = buildCategoriesDescriptionStr(categoriesConfig, dictionary);

  const { system: systemPrompt, user: userPromptBuilt } = buildClassificationPrompt(categoriesDescriptionStr, filename, rawText, previousError);
  let userPrompt = userPromptBuilt;

  logger.debug('OLLAMA_AI', `Sending classification request to model '${CONFIG.OLLAMA_MODEL}'`, { filename, rawTextLength: rawText.length });

  let validated: DocumentMetadata;

  try {
    if (!modelHealthy) {
      throw new Error(`Model '${CONFIG.OLLAMA_MODEL}' failed its capability check (exists but cannot generate, e.g. a subscription-gated cloud model) — skipping the classification request.`);
    }

    const response = await ollama.generate({
      model: CONFIG.OLLAMA_MODEL,
      system: systemPrompt,
      prompt: userPrompt,
      format: 'json',
      // qwen3.5:9b is a thinking-capable model; without this, it routes its entire
      // JSON answer into response.thinking and leaves response.response empty.
      think: false,
      options: {
        temperature: 0.1,
        num_ctx: 8192,
        num_predict: 4096
      }
    });

    const rawResp = response.response.trim();
    const parsed = cleanAndParseJSON(rawResp);
    validated = DocumentMetadataSchema.parse(parsed);

  } catch (err: any) {
    logger.warn('OLLAMA_AI', `Ollama AI request failed for ${filename}: ${err.message}. Using rule-based classifier.`);
    const rb = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);
    validated = DocumentMetadataSchema.parse({
      titre: rb.title,
      registre: '',
      date: rb.date,
      categorie: rb.categorie,
      subcategorie: rb.subcategorie,
      summary: `Document: ${rb.title}.`,
      tags: [rb.categorie, rb.subcategorie].filter(Boolean),
      markdown_content: `# ${rb.title}\n\n${rawText}`
    });
  }

  validated = refineClassification(validated, rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);

  const { category: matchedCategory, isNew: isNewCategory } = resolveCategory(categoriesConfig, validated.categorie);
  if (isNewCategory) {
    logger.info('OLLAMA_AI', `Auto-created new category '${matchedCategory.id}' for ${filename} BEFORE move`);
    saveCategoriesConfig(categoriesConfig.categories);
  }
  validated.categorie = matchedCategory.id;

  const { subcategoryId, isNew: isNewSubcategory } = resolveSubcategory(matchedCategory, validated.subcategorie, rawText, filename, CONFIG.PERSONAL_NAME_DENYLIST);
  if (isNewSubcategory) {
    logger.info('OLLAMA_AI', `Auto-created new subcategory '${subcategoryId}' under '${matchedCategory.id}' BEFORE move`, { filename });
    saveCategoriesConfig(categoriesConfig.categories);
  } else if (subcategoryId === 'general' && validated.subcategorie !== 'general') {
    logger.warn('OLLAMA_AI', `Rejected ungrounded subcategory slug for ${filename} (not found in document content) — forcing 'general' to trigger BLOCK guard`);
  }
  validated.subcategorie = subcategoryId;

  logger.info('OLLAMA_AI', `Classification success`, {
    filename,
    title: validated.titre,
    category: validated.categorie,
    subcategory: validated.subcategorie,
    date: validated.date
  });

  return validated;
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  try {
    const response = await ollama.embeddings({
      model: CONFIG.OLLAMA_EMBED_MODEL,
      prompt: text.substring(0, 1000)
    });
    return response.embedding || [];
  } catch {
    return [];
  }
}
