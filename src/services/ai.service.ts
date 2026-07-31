import { CONFIG } from '../infrastructure/settings.js';
import { DocumentMetadataSchema, DocumentMetadata, SubcategoryItem } from '../domain/document.schema.js';
import { logger } from '../infrastructure/logger.js';
import { cleanAndParseJSON, ruleBasedClassify, isGroundedSubcategorySlug, normalizeSlug, buildCategoriesDescriptionStr } from '../domain/classification.js';
import { buildClassificationPrompt } from '../domain/prompt.js';
import { refineClassification, resolveCategory, resolveSubcategory } from '../domain/classification-resolution.js';
import { getCategoriesConfig, saveCategoriesConfig } from '../infrastructure/categories-store.js';
import { getEntityDictionary } from '../infrastructure/entity-dictionary-store.js';
import { ensureOllamaModel, requestClassificationCompletion } from '../infrastructure/ollama-client.js';

export async function classifyPDFText(rawText: string, filename: string, previousError?: string): Promise<DocumentMetadata> {
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

    const response = await requestClassificationCompletion(systemPrompt, userPrompt);

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
