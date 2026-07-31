import { Ollama } from 'ollama';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { DocumentMetadataSchema, DocumentMetadata, CategoriesConfigSchema, CategoryItem, SubcategoryItem, EntityDictionarySchema, EntityDictionary } from '../domain/document.schema.js';
import { logger } from './logger.service.js';
import { cleanAndParseJSON, ruleBasedClassify, isGroundedSubcategorySlug, normalizeSlug, buildCategoriesDescriptionStr } from '../domain/classification.js';

export function getCategoriesConfig() {
  if (fs.existsSync(CONFIG.CATEGORIES_FILE)) {
    const raw = fs.readFileSync(CONFIG.CATEGORIES_FILE, 'utf-8');
    try {
      const parsed = JSON.parse(raw);
      return CategoriesConfigSchema.parse(parsed);
    } catch (e) {
      console.error("Invalid categories.json schema, using defaults", e);
    }
  }
  return {
    categories: [
      { id: 'invoices', name: 'Factures', description: 'Factures et reçus', aliases: ['facture', 'invoice'], subcategories: [] },
      { id: 'bulletin_salaire', name: 'Bulletins de Salaire', description: 'Fiches de paie par entreprise', aliases: ['bulletin_salaire', 'paie', 'salaire'], subcategories: [] },
      { id: 'contracts', name: 'Contrats', description: 'Contrats et baux', aliases: ['contrat', 'contract'], subcategories: [] },
      { id: 'administrative', name: 'Administratif', description: 'Documents administratifs', aliases: ['tax', 'impot'], subcategories: [] },
      { id: 'health', name: 'Santé', description: 'Santé et mutuelle', aliases: ['health', 'sante'], subcategories: [] },
      { id: 'identity', name: 'Identité', description: 'Passeports et cartes d identite', aliases: ['identity', 'passport'], subcategories: [] },
      { id: 'housing', name: 'Logement', description: 'Justificatifs de domicile et loyers', aliases: ['housing', 'logement'], subcategories: [] },
      { id: 'insurance', name: 'Assurances', description: 'Contrats d assurance', aliases: ['insurance', 'assurance'], subcategories: [] },
      { id: 'education', name: 'Éducation', description: 'Formations et diplômes', aliases: ['education', 'formation'], subcategories: [] },
      { id: 'recruitment', name: 'Recrutement', description: 'Lettres et CV', aliases: ['recrutement', 'candidature'], subcategories: [] },
      { id: 'correspondence', name: 'Courriers', description: 'Emails et lettres', aliases: ['courrier', 'mail'], subcategories: [] },
      { id: 'technical', name: 'Technique', description: 'Manuels et guides', aliases: ['tech', 'manual'], subcategories: [] },
      { id: 'reports', name: 'Rapports', description: 'Rapports de projets', aliases: ['report'], subcategories: [] }
    ]
  };
}

export let onCategoryCreatedCallback: (() => void) | null = null;
export function setOnCategoryCreatedCallback(cb: () => void) {
  onCategoryCreatedCallback = cb;
}

export function saveCategoriesConfig(categories: CategoryItem[]): void {
  const validated = CategoriesConfigSchema.parse({ categories });
  fs.writeFileSync(CONFIG.CATEGORIES_FILE, JSON.stringify(validated, null, 2), 'utf-8');
  if (onCategoryCreatedCallback) {
    try { onCategoryCreatedCallback(); } catch (e) {}
  }
}

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

  const textSnippet = rawText.length > 4000 ? rawText.substring(0, 4000) + '...' : rawText;

  const systemPrompt = `You are an expert AI document archivist and classifier. 
Your task is to analyze document text, select the best Category, and select or create the best Subcategory following this strict Step-by-Step Decision Flow.

Available Categories & Existing Subcategories:
${categoriesDescriptionStr}

🛑 MANDATORY DEEP CONTENT READING RULE (READ FULL CONTENT & PURPOSE, DO NOT JUST MATCH WORDS!):
- You MUST READ AND UNDERSTAND THE ENTIRE CONTEXT, PURPOSE, AND ISSUING ENTITY of the document content.
- DO NOT rely on simple string keyword matching or isolated word occurrences!
- PAY SLIPS (bulletin de salaire) MUST BE CLASSIFIED UNDER Category = 'bulletin_salaire' (NOT 'invoices'!).
- For PAY SLIPS, identify the Employer/Enterprise Name (e.g. 'pacifique4', 'pro_electro', 'capgemini', 'nextech'). Set Subcategory = Exact Employer Name!

🧠 LOCAL AI THINKING & REASONING PROTOCOL (THINK STEP-BY-STEP BEFORE OUTPUT):
1. HEADER VS BODY AUDIT: First, inspect the header/issuer of the document. Distinguish the issuing entity from transaction line items.
2. FULL CONTENT PURPOSE ANALYSIS: Read the body text to understand the legal, financial, or administrative purpose of the document.
3. CATEGORY SELECTION: Evaluate the 12-step decision flow in strict order. Pick the single most accurate category.
4. SPECIFIC SUBCATEGORY SELECTION:
   - Identify the exact company, bank, school, government branch, or document type (e.g. 'credit_mutuel', 'impot', 'pro_electro', 'ameli', 'foncia', 'allianz', 'cesi', 'pacifique4').
   - If the issuing company or organization is NOT in existing subcategories, DYNAMICALLY GENERATE A NEW CLEAN SLUG for that exact entity — ONLY if that entity's name actually appears in the Document Text Content above (e.g. 'france_travail', 'caf', 'urssaf', 'veolia', 'orange'). NEVER derive the slug from the filename and NEVER guess — the filename is not document content.
   - If the document text itself has no identifiable real entity (illegible/weak OCR, a generic confirmation page, a form with no issuer name), output subcategorie as 'general' — that is the correct, honest answer here. Do NOT invent a fake-specific slug just to avoid saying 'general'.
   - Otherwise, when a real entity IS identifiable in the text, NEVER output 'general', 'personal', 'other', 'divers', or year strings ('2023') as subcategories!

🛑 MASTER AI CLASSIFICATION DECISION FLOW (FOLLOW IN STRICT ORDER):

STEP 1: BANK STATEMENTS (High Priority Override)
- Search document header for "Crédit Mutuel", "Société Générale", "BNP Paribas", "BoursoBank", "LCL", "La Banque Postale", "C/C EUROCOMPTE", "RELEVE DE COMPTE", "SOLDE CREDITEUR", or IBAN numbers.
- IF MATCH: -> Category = 'administrative', Subcategory = Exact Bank Name (e.g. 'credit_mutuel', 'societe_generale', 'bnp_paribas').
- ⚠️ CRITICAL RULE: Ignore vendor names (like SFR, PayPal, Amazon, Lidl) that appear inside internal transaction list rows!

STEP 2: TAX DOCUMENTS (High Priority Override)
- Search document for "Avis d'impôt", "Avis d'imposition", "Prélèvements sociaux", "Revenus 2022", "Finances Publiques", "DGFIP", "Taxe foncière", "Taxe d'habitation".
- IF MATCH: -> Category = 'administrative', Subcategory = 'impot'.
- ⚠️ CRITICAL RULE: NEVER classify tax forms as 'correspondence' or 'courriers'!

STEP 3: PAY SLIPS (HIGH PRIORITY CATEGORY)
- Search document for "Bulletin de salaire", "Bulletin de paie", "Fiche de paie", "Salaire brut", "Net à payer".
- IF MATCH: -> Category = 'bulletin_salaire', Subcategory = Exact Employer/Enterprise Name (e.g. 'pacifique4', 'pro_electro', 'capgemini', 'nextech').
- ⚠️ CRITICAL RULE: NEVER put pay slips under 'invoices' (Factures)!

STEP 4: HEALTH & MEDICAL
- Search for "Ameli", "Assurance Maladie", "CPAM", "Mutuelle", "Gan Santé", "Ordonnance", "Soins Dentaires", "Pharmacie", "Hospitalisation".
- IF MATCH: -> Category = 'health', Subcategory = Health Institution (e.g. 'ameli', 'gan_sante', 'lai_dentail').

STEP 5: IDENTITY & CIVIL PAPERS
- Search for "Passeport", "Passport", "Carte d'Identité", "CNI", "Titre de Séjour", "Carte Vitale", "Permis de conduire", "Acte de mariage", "Acte de naissance".
- IF MATCH: -> Category = 'identity', Subcategory = Document Type (e.g. 'passeport', 'titre_sejour', 'carte_vitale', 'permis_conduire', 'carte_identite', 'acte_mariage').

STEP 6: HOUSING & DOMICILE PROOF
- Search for "Justificatif de domicile", "Attestation d'hébergement", "Quittance de loyer", "Foncia", "Logement", "Bail d'habitation", "Attestation titulaire de contrat 2DDoc".
- IF MATCH: -> Category = 'housing', Subcategory = 'justificatif_domicile' or 'foncia'.

STEP 7: GENERAL INSURANCE
- Search for "Assurance Auto", "Assurance Habitation", "Prévoyance", "Responsabilité Civile", "Allianz", "Macif", "Maaf".
- IF MATCH: -> Category = 'insurance', Subcategory = Company Name (e.g. 'allianz').

STEP 8: VENDOR INVOICES (FACTURES)
- Search for "Facture n°", "Facture no", "Invoice", "Montant à payer", "Total TTC", "SFR", "EDF", "Engie", "Free", "Orange", "Cdiscount", "Amazon".
- IF MATCH: -> Category = 'invoices', Subcategory = Vendor Name (e.g. 'sfr', 'edf', 'cdiscount').

STEP 9: CONTRACTS & GENERAL CONDITIONS
- Search for "Contrat de travail", "CDI", "CDD", "Avenant au contrat", "Conditions générales", "Notice employeur", "Convention collective".
- IF MATCH: -> Category = 'contracts', Subcategory = Work, Conditions, or Company Name (e.g. 'cdi_cdd', 'conditions_generales', 'attestation_employeur').

STEP 10: EDUCATION & ACADEMIC
- Search for "Attestation de stage PRO ELECTRO", "Certificat de scolarité", "Diplôme", "Bachelor", "Attestation de formation", "NEXTECH", "CESI", "Af2M", "OpenClassrooms".
- IF MATCH: -> Category = 'education', Subcategory = School or Company Name (e.g. 'pro_electro', 'nextech', 'cesi', 'openclassrooms', 'diplomes').

STEP 11: RECRUITMENT
- Search for "Lettre de motivation", "CV", "Curriculum Vitae", "Candidature", "Postuler".
- IF MATCH: -> Category = 'recruitment', Subcategory = 'lettres_motivation'.

STEP 12: POSTAL MAIL & EMAILS
- Plain postal letters or emails without invoice, tax, or contract context -> Category = 'correspondence'.

STEP 13: TECHNICAL MANUALS & REPORTS
- Technical guides -> Category = 'technical'. Project reports -> Category = 'reports'.

Respond ONLY with raw JSON matching this structure:
{
  "titre": "Document Title",
  "registre": "REF-12345",
  "date": "2026-05-15",
  "categorie": "bulletin_salaire",
  "subcategorie": "pacifique4",
  "summary": "Executive summary...",
  "tags": ["bulletin_salaire", "pacifique4", "salaire"],
  "markdown_content": "# Document Title\\n\\nContent formatted in clean Markdown..."
}`;

  let userPrompt = `Filename: ${filename}\n\nDocument Text Content:\n${textSnippet}`;
  if (previousError) {
    userPrompt += `\n\n⚠️ PREVIOUS ATTEMPT FEEDBACK (FIX THIS PROBLEM):\nThe previous classification attempt for this document encountered an error: "${previousError}".\nPlease carefully analyze the document text and fix this issue. You MUST provide a specific, valid Category and Subcategory slug that is genuinely grounded in the Document Text Content (e.g. 'credit_mutuel', 'impot', 'ameli', 'sfr') — do NOT derive it from the filename. If no real entity is identifiable in the text, it is correct to return 'general' rather than guessing.`;
  }

  logger.debug('OLLAMA_AI', `Sending classification request to model '${CONFIG.OLLAMA_MODEL}'`, { filename, textSnippetLength: textSnippet.length });

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

  // Refine Category & Subcategory using ruleBasedClassify if AI returned 'general', 'personal', 'other', or 'correspondence' for a Tax/Bank document
  if (validated.categorie === 'personal' || validated.categorie === 'other' || validated.subcategorie === 'general' || (validated.categorie === 'correspondence' && /impot|tax/i.test(filename))) {
    const rb = ruleBasedClassify(rawText, filename, dictionary, CONFIG.PERSONAL_NAME_DENYLIST);
    if (validated.categorie === 'personal' || validated.categorie === 'other' || !validated.categorie || (validated.categorie === 'correspondence' && rb.categorie === 'administrative')) {
      validated.categorie = rb.categorie;
    }
    if (validated.subcategorie === 'general' && rb.subcategorie !== 'general') {
      validated.subcategorie = rb.subcategorie;
    }
  }

  // Normalize category ID & DYNAMICALLY AUTO-CREATE NEW CATEGORY IF NOT FOUND BEFORE MOVING FILE
  const rawCatSlug = normalizeSlug(validated.categorie || 'administrative');
  let matchedCategory = categoriesConfig.categories.find(c =>
    c.id === rawCatSlug || (c.aliases && c.aliases.some(a => rawCatSlug.includes(a)))
  );

  if (!matchedCategory) {
    const newCatSlug = rawCatSlug;
    const newCatName = newCatSlug
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    logger.info('OLLAMA_AI', `Auto-created new category '${newCatSlug}' for ${filename} BEFORE move`);

    const newCatObj: CategoryItem = {
      id: newCatSlug,
      name: newCatName,
      description: `Category auto-created for ${newCatName}`,
      aliases: [newCatSlug],
      subcategories: []
    };

    categoriesConfig.categories.push(newCatObj);
    matchedCategory = newCatObj;
    saveCategoriesConfig(categoriesConfig.categories);
  }
  validated.categorie = matchedCategory.id;

  let rawSubSlug = normalizeSlug(validated.subcategorie || '');
  // Clean dates from subcategory slugs
  rawSubSlug = rawSubSlug.replace(/_\d{4,8}$/g, '').replace(/\d{4,8}$/g, '');

  if (!rawSubSlug || /^\d{4}$/.test(rawSubSlug)) {
    rawSubSlug = 'general';
  }

  if (!matchedCategory.subcategories) {
    matchedCategory.subcategories = [];
  }

  const FORBIDDEN_SUBCATEGORIES = new Set(['general', 'other', 'divers']);

  let matchedSub = FORBIDDEN_SUBCATEGORIES.has(rawSubSlug)
    ? undefined
    : matchedCategory.subcategories.find(s =>
        s.id === rawSubSlug || (s.aliases && s.aliases.some(a => rawSubSlug.includes(a)))
      );

  if (matchedSub) {
    validated.subcategorie = matchedSub.id;
  } else if (FORBIDDEN_SUBCATEGORIES.has(rawSubSlug)) {
    // Forbidden sentinel value — never auto-create it as a real taxonomy entry. Leave
    // validated.subcategorie as-is so triage.service.ts's strict fail guard (Golden Rule
    // #4) BLOCKs the file and keeps it in __raws.
    validated.subcategorie = rawSubSlug;
  } else if (!isGroundedSubcategorySlug(rawSubSlug, rawText, filename, CONFIG.PERSONAL_NAME_DENYLIST)) {
    // The model (or the ruleBasedClassify refinement pass below it) invented a
    // "specific"-looking slug that isn't actually grounded in the document's own content —
    // a filename echo, gibberish, or a generic/structural word. Refuse to pollute
    // categories.json with it; force 'general' so the BLOCK guard above catches it instead
    // of silently mis-filing the document under a garbage subcategory.
    logger.warn('OLLAMA_AI', `Rejected ungrounded subcategory slug '${rawSubSlug}' for ${filename} (not found in document content) — forcing 'general' to trigger BLOCK guard`);
    validated.subcategorie = 'general';
  } else {
    // DYNAMIC AUTO-CREATION OF NEW SUBCATEGORY BEFORE FILE MOVE!
    logger.info('OLLAMA_AI', `Auto-created new subcategory '${rawSubSlug}' under '${matchedCategory.id}' BEFORE move`, { filename });
    
    const newSubName = rawSubSlug
      .split('_')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    const newSubObj: SubcategoryItem = {
      id: rawSubSlug,
      name: newSubName,
      aliases: [rawSubSlug]
    };

    matchedCategory.subcategories.push(newSubObj);
    validated.subcategorie = rawSubSlug;

    // Save permanently to categories.json BEFORE moving file
    saveCategoriesConfig(categoriesConfig.categories);
  }

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
