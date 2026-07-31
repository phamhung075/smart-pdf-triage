import { Ollama } from 'ollama';
import fs from 'fs';
import { CONFIG } from '../config.js';
import { DocumentMetadataSchema, DocumentMetadata, CategoriesConfigSchema, CategoryItem, SubcategoryItem, EntityDictionarySchema, EntityDictionary } from '../schemas/document.schema.js';
import { logger } from './logger.service.js';

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

const DOMAIN_CATEGORY_MAP: Record<keyof EntityDictionary, string> = {
  banks: 'administrative',
  energy: 'invoices',
  telecom: 'invoices',
  insurance: 'insurance',
  gov: 'administrative',
  health: 'health'
};

export const ALL_ENTITY_DOMAINS = Object.keys(DOMAIN_CATEGORY_MAP) as (keyof EntityDictionary)[];

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

export function buildEntityHintLine(categoryId: string): string {
  const dict = getEntityDictionary();
  const domains = ALL_ENTITY_DOMAINS.filter(domain => DOMAIN_CATEGORY_MAP[domain] === categoryId);
  const entries = domains.flatMap(domain => dict[domain]);
  if (entries.length === 0) return '';
  return ` Known real-world entities: ${entries.map(e => `${e.slug} (${e.name})`).join(', ')}.`;
}

export function matchEntityDictionary(combined: string, domains: (keyof EntityDictionary)[]): { categorie: string; subcategorie: string } | null {
  const dict = getEntityDictionary();
  for (const domain of domains) {
    const categorie = DOMAIN_CATEGORY_MAP[domain];
    for (const entry of dict[domain]) {
      const candidates = [entry.name, ...entry.aliases];
      for (const candidate of candidates) {
        const escaped = candidate.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (escaped.length === 0) continue;
        // Use Unicode-aware word boundaries to correctly handle accented characters
        if (new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(combined)) {
          return { categorie, subcategorie: entry.slug };
        }
      }
    }
  }
  return null;
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

function normalizeSlug(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// --- Ungrounded subcategory slug guard --------------------------------------------------
// When neither the curated regex list nor the entity dictionary recognizes a real entity,
// both the Qwen prompt (classifyPDFText) and ruleBasedClassify's last-resort fallback are
// tempted to invent a subcategory slug from the filename itself — e.g.
// "DcyJXe9MT9i7Un7tOlhU_StanW.pdf" -> "dcyjxe9mt9i7un7tolhu", "Page de confirmation.pdf"
// -> "page". That slug then gets permanently auto-created in categories.json (Golden Rule
// #5) even though it names nothing real. A "specific"-looking slug is only accepted here if
// it is actually grounded in the document's own text — not merely echoed from the filename
// or a generic/structural word.

const GENERIC_SLUG_DENYLIST = new Set([
  'general', 'other', 'divers', 'autre', 'autres', 'various', 'misc', 'note', 'notes',
  'info', 'page', 'bon', 'export', 'scan', 'copie', 'copy', 'document', 'doc', 'fichier',
  'file', 'image', 'confirmation', 'recu', 'releve', 'extrait', 'titre',
  'contrat', 'facture', 'attestation', 'lettre', 'avis', 'bulletin', 'certificat'
]);

// This is a personal document archive for one household — the owner's (and family
// members') own name appears in the header/addressee block of nearly every document,
// so a plain "does this appear in the text" check trivially passes it, mistaking the
// document's OWNER for its ISSUER (e.g. "Dai Hung PHAM CPF Caisse des Dépôts.pdf" ->
// subcategory 'dai' instead of the actual issuing organization). A subcategory must
// identify who issued/what type the document is, never who it's about. Configurable via
// settings.json's `personal_name_denylist` (CONFIG.PERSONAL_NAME_DENYLIST) rather than
// hardcoded, so it can be edited without a code change.
function getPersonalNameDenylist(): Set<string> {
  return new Set(CONFIG.PERSONAL_NAME_DENYLIST.map(n => n.toLowerCase().trim()));
}

const MIN_GROUNDED_SLUG_LENGTH = 3;

function filenameSlugTokens(filename: string): string[] {
  const cleanName = filename.replace(/\.pdf$/i, '').replace(/[-_\s]+/g, '_').toLowerCase();
  return cleanName.split('_').filter(w => w.length >= 3 && !/^\d+$/.test(w));
}

function isFilenameEchoedSlug(slug: string, filename: string): boolean {
  const wholeFilenameSlug = normalizeSlug(filename.replace(/\.pdf$/i, ''));
  if (slug === wholeFilenameSlug) return true;
  return filenameSlugTokens(filename).some(t => t === slug || slug.includes(t) || t.includes(slug));
}

function countSlugOccurrences(slug: string, text: string): number {
  // Slugs are snake_case but real document text uses spaces/hyphens between words (e.g.
  // slug "france_travail" must still match body text "France Travail"), so underscores
  // become a flexible separator instead of a literal character.
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[\\s_-]+');
  if (!escaped) return 0;
  const regex = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu');
  return (text.match(regex) || []).length;
}

/**
 * True only if `slug` looks like a real-world entity name grounded in the document's own
 * text, as opposed to a generic/structural word, gibberish, or an echo of the filename.
 * Used to gate the dynamic subcategory auto-create path in both classifyPDFText and
 * ruleBasedClassify. Exported for testing.
 */
export function isGroundedSubcategorySlug(slug: string, rawText: string, filename: string): boolean {
  if (!slug || slug.length < MIN_GROUNDED_SLUG_LENGTH) return false;
  if (GENERIC_SLUG_DENYLIST.has(slug)) return false;
  if (slug.split('_').some(part => getPersonalNameDenylist().has(part))) return false;

  const occurrences = countSlugOccurrences(slug, rawText || '');
  if (occurrences === 0) return false;

  if (isFilenameEchoedSlug(slug, filename)) {
    // A slug that's also present in the filename is exactly what a hallucinating model
    // falls back to — require it to show up more than once in the body (letterhead,
    // footer, reference line, ...) rather than a single incidental mention.
    return occurrences >= 2;
  }

  return true;
}

function repairTruncatedJSON(text: string): string {
  let result = text;
  let inString = false;
  let escaped = false;
  const stack: string[] = [];

  for (const ch of result) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' && stack[stack.length - 1] === '{') stack.pop();
    else if (ch === ']' && stack[stack.length - 1] === '[') stack.pop();
  }

  if (inString) {
    result += '"';
  }
  while (stack.length > 0) {
    const open = stack.pop();
    result += open === '{' ? '}' : ']';
  }
  return result;
}

export function cleanAndParseJSON(rawStr: string): any {
  let text = rawStr.trim();
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('No JSON object found in AI response');
  }
  text = text.substring(start);

  const end = text.lastIndexOf('}');
  const candidate = end !== -1 ? text.substring(0, end + 1) : text;
  const cleaned = candidate.replace(/,\s*([\}\]])/g, '$1');

  try {
    return JSON.parse(cleaned);
  } catch (e) {
    // Response was likely truncated mid-generation (e.g. context/length limit cut off
    // markdown_content before the closing brace). Repair by closing any unterminated
    // string and any brackets left open, respecting string boundaries, then retry.
    const repaired = repairTruncatedJSON(text).replace(/,\s*([\}\]])/g, '$1');
    return JSON.parse(repaired);
  }
}

export function ruleBasedClassify(rawText: string, filename: string): { categorie: string; subcategorie: string; title: string; date: string } {
  const combined = (filename + ' ' + rawText.substring(0, 4000)).toLowerCase();

  // Generic bank-statement signal phrases (same signals as the Qwen prompt's STEP 1)
  // used to guard the gov (7b) and insurance-dictionary (8) branches so a
  // Crédit Mutuel relevé isn't misfiled via a transaction-row mention of
  // CAF / AXA / etc. (Golden Rule #6 "archetypal trap").
  const looksLikeBankStatement = /\b(relev[ée] de compte|solde cr[ée]diteur|c\/c eurocompte)\b/i.test(combined);

  let categorie = 'administrative';
  let subcategorie = 'general';

  // Specific Bulletin de Salaire / Pay Slips Category (SEPARATE FROM INVOICES / FACTURES!)
  if (/bulletindesalaire|bulletin de salaire|bulletin de paie|fiche de paie/i.test(combined)) {
    categorie = 'bulletin_salaire';
    if (/pro_electro|proelectro/i.test(combined)) subcategorie = 'pro_electro';
    else if (/nextech/i.test(combined)) subcategorie = 'nextech';
    else if (/cesi/i.test(combined)) subcategorie = 'cesi';
    else if (/capgemini/i.test(combined)) subcategorie = 'capgemini';
    else if (/pacifique/i.test(combined) || /2017|2018/.test(filename)) subcategorie = 'pacifique4';
    else subcategorie = 'divers';
  }
  // Specific Internship Attestations
  else if (/attestationstageproelectro|proelectro/i.test(combined)) {
    categorie = 'education';
    subcategorie = 'pro_electro';
  }
  // Specific 2DDoc Contract Holder Domicile Proof Attestations
  else if (/attestationtitulairecontrat2ddoc|2ddoc/i.test(combined)) {
    categorie = 'housing';
    subcategorie = 'justificatif_domicile';
  }
  // 1. Identity & Passports & Civil Records
  else if (/(passeport|passport|carte d'identité|cni|cancuoccongdan|giaypheplaixe|giay phep lai xe|permis de conduire|titre de séjour|titresejour|carte vitale|cartevitale|acte de mariage|actemariage|acte de naissance|livret de famille)/i.test(combined)) {
    categorie = 'identity';
    if (/(passeport|passport)/i.test(combined)) subcategorie = 'passeport';
    else if (/(titre de séjour|titresejour)/i.test(combined)) subcategorie = 'titre_sejour';
    else if (/(carte vitale|cartevitale)/i.test(combined)) subcategorie = 'carte_vitale';
    else if (/(giaypheplaixe|giay phep lai xe|permis de conduire)/i.test(combined)) subcategorie = 'permis_conduire';
    else if (/(cancuoccongdan|carte d'identité|cni)/i.test(combined)) subcategorie = 'carte_identite';
    else if (/(actemariage|acte de mariage)/i.test(combined)) subcategorie = 'acte_mariage';
  }
  // 2. Health / Medical
  else if (/\b(santé|sante|médical|medical|soins|dentaire|pharmacie|attestation de droits|attestationam|ameli|sécurité sociale|securite sociale|cpam|mutuelle|hospitalisation)\b/i.test(combined)) {
    categorie = 'health';
    if (/\bameli|assurance maladie|cpam|attestationam\b/i.test(combined)) subcategorie = 'ameli';
    else if (/\bgan\b/i.test(combined)) subcategorie = 'gan_sante';
    else if (/\blai dentail|lai dental\b/i.test(combined)) subcategorie = 'lai_dentail';
    else {
      const dictHealth = matchEntityDictionary(combined, ['health']);
      if (dictHealth) subcategorie = dictHealth.subcategorie;
    }
  }
  // 3. Housing & Domicile Proof
  else if (/\b(justificatif de domicile|attestation d'hébergement|attestation hebergement|attestation cercles|declarationhonneur|quittance de loyer|foncia|logement)\b/i.test(combined)) {
    categorie = 'housing';
    if (/\bfoncia\b/i.test(combined)) subcategorie = 'foncia';
    else subcategorie = 'justificatif_domicile';
  }
  // 4. Education & Academic Diplomas
  else if (/\b(formation|bachelor|étudiant|scolarité|inscription|cesi|nextech|af2m|openclassrooms|école|université|diplôme|diplome|bulletinscolaire|certificat|alternance|l1informatique)\b/i.test(combined)) {
    categorie = 'education';
    if (/\bnextech\b/i.test(combined)) subcategorie = 'nextech';
    else if (/\bcesi\b/i.test(combined)) subcategorie = 'cesi';
    else if (/\baf2m\b/i.test(combined)) subcategorie = 'af2m';
    else if (/\bopenclassrooms\b/i.test(combined)) subcategorie = 'openclassrooms';
    else if (/\bdiplome|diplôme|bulletinscolaire|certificat|l1informatique\b/i.test(combined)) subcategorie = 'diplomes';
  }
  // 5. Contracts & General Conditions
  else if (/\b(contrat de travail|cdi|cdd|avenant au contrat|cg de mon contrat|conditions générales|notice-attestation-employeur|attestation-employeur|engagement|convention collective)\b/i.test(combined)) {
    categorie = 'contracts';
    if (/\bcg|conditions générales\b/i.test(combined)) subcategorie = 'conditions_generales';
    else if (/\bemployeur\b/i.test(combined)) subcategorie = 'attestation_employeur';
    else subcategorie = 'cdi_cdd';
  }
  // 6. Vendor Invoices (EXCLUDING PAY SLIPS)
  else if (/\b(facture n°|facture no|facture|invoice|quittance|montant à payer|total ttc)\b/i.test(combined)) {
    categorie = 'invoices';
    if (/\bsfr\b/i.test(combined)) subcategorie = 'sfr';
    else if (/\bedf\b/i.test(combined)) subcategorie = 'edf';
    else if (/\bengie\b/i.test(combined)) subcategorie = 'engie';
    else if (/\bcdiscount\b/i.test(combined)) subcategorie = 'cdiscount';
    else if (/\bamazon\b/i.test(combined)) subcategorie = 'amazon';
    else {
      const dictVendor = matchEntityDictionary(combined, ['telecom', 'energy']);
      if (dictVendor) {
        subcategorie = dictVendor.subcategorie;
      } else {
        const dictInsuranceViaFacture = matchEntityDictionary(combined, ['insurance']);
        if (dictInsuranceViaFacture) {
          categorie = dictInsuranceViaFacture.categorie;
          subcategorie = dictInsuranceViaFacture.subcategorie;
        }
      }
    }
  }
  // 7. Taxes & Government Income Statements
  // Same bank-statement trap as 7b/8 below: a transaction row mentioning "prélèvements
  // sociaux" or "impôt" inside a relevé de compte must not divert this to 'impot'.
  else if (!looksLikeBankStatement && /\b(avis[ _-]d[ _-]impot|avis[ _-]d'impot|avis[ _-]impot|déclaration[ _-]d'impôt|taxe[ _-]fonciere|taxe[ _-]foncière|taxe[ _-]d'habitation|revenus[ _-]et[ _-]prelev|prélèvement[ _-]sociaux|prelev[ _-]sociaux|finances[ _-]publiques|dgfip|impôt|impots)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'impot';
  }
  // 7b. Government & Social Agencies
  // Bank statements are the archetypal trap (Golden Rule #6): a transaction row
  // like "VIR CAF ALLOCATIONS FAMILIALES" or "PRLV AXA FRANCE IARD" inside a
  // Crédit Mutuel relevé must not divert classification to the gov/insurance
  // branches below. Guard both dictionary-driven clauses with this check.
  else if (!looksLikeBankStatement && matchEntityDictionary(combined, ['gov'])) {
    const dictGov = matchEntityDictionary(combined, ['gov'])!;
    categorie = dictGov.categorie;
    subcategorie = dictGov.subcategorie;
  }
  // 8. Insurance / Assurances
  else if (/\b(assurance auto|assurance habitation|prévoyance|prevoyance|responsabilité civile|allianz|macif|maaf|a2a)\b/i.test(combined) || (!looksLikeBankStatement && matchEntityDictionary(combined, ['insurance']))) {
    categorie = 'insurance';
    if (/\ballianz\b/i.test(combined)) subcategorie = 'allianz';
    else {
      const dictInsurance = matchEntityDictionary(combined, ['insurance']);
      if (dictInsurance) subcategorie = dictInsurance.subcategorie;
    }
  }
  // 9. Banks / Finance
  else if (/\b(caisse de credit mutuel|crédit mutuel|credit mutuel|ccm marseille|creditmutuel)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'credit_mutuel';
  } else if (/\b(société générale|societe generale)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'societe_generale';
  } else if (/\b(bnp paribas|bnp)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'bnp_paribas';
  } else if (/\b(boursorama|boursobank)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'boursobank';
  } else if (/\b(lcl|crédit lyonnais|credit lyonnais)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'lcl';
  } else if (/\b(la banque postale|banque postale)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'la_banque_postale';
  } else if (matchEntityDictionary(combined, ['banks'])) {
    const dictBank = matchEntityDictionary(combined, ['banks'])!;
    categorie = dictBank.categorie;
    subcategorie = dictBank.subcategorie;
  }
  // 10. Recruitment
  else if (/\b(lettre de motivation|candidature|recrutement|curriculum|cv|postuler|entretien|recommandation)\b/i.test(combined)) {
    categorie = 'recruitment';
  }
  // 11. Correspondence
  else if (/\b(yahoo mail|courrier|lettre|email|mail|recommandé|notification)\b/i.test(combined)) {
    categorie = 'correspondence';
  }
  // 12. Technical
  else if (/\b(manuel|guide|spécification|notice|documentation|technique|schema)\b/i.test(combined)) {
    categorie = 'technical';
  }
  // 13. Reports
  else if (/\b(rapport|compte-rendu|projet|livrable|synthèse)\b/i.test(combined)) {
    categorie = 'reports';
  }

  // Exact Subcategory Fallbacks & Dynamic Subcategory Generation from Filename Keywords
  if (subcategorie === 'general') {
    if (/\bnextech\b/i.test(combined)) subcategorie = 'nextech';
    else if (/\bcesi\b/i.test(combined)) subcategorie = 'cesi';
    else if (/\baf2m\b/i.test(combined)) subcategorie = 'af2m';
    else if (/\bopenclassrooms\b/i.test(combined)) subcategorie = 'openclassrooms';
    else if (/\bcarrefour\b/i.test(combined)) subcategorie = 'carrefour';
    else if (/\bkairos\b/i.test(combined)) subcategorie = 'kairos';
    else if (/\ballianz\b/i.test(combined)) subcategorie = 'allianz';
    else if (/\b(gan|gan santé|gan assurances)\b/i.test(combined)) subcategorie = 'gan_sante';
    else if (/\bcapgemini\b/i.test(combined)) subcategorie = 'capgemini';
    else if (/\b(sfr|red by sfr)\b/i.test(combined)) subcategorie = 'sfr';
    else if (/\bedf\b/i.test(combined)) subcategorie = 'edf';
    else if (/\bengie\b/i.test(combined)) subcategorie = 'engie';
    else if (/\bbouygues\b/i.test(combined)) subcategorie = 'bouygues';
    else if (/\bfree\b/i.test(combined)) subcategorie = 'free';
    else if (/\b(ameli|assurance maladie|cpam)\b/i.test(combined)) subcategorie = 'ameli';
    else if (/\b(navigo|ile-de-france mobilités|ratp)\b/i.test(combined)) subcategorie = 'navigo';
    else if (/\bcdiscount\b/i.test(combined)) subcategorie = 'cdiscount';
    else if (/\bamazon\b/i.test(combined)) subcategorie = 'amazon';
    else if (/\bfnac\b/i.test(combined)) subcategorie = 'fnac';
    else if (/\bfoncia\b/i.test(combined)) subcategorie = 'foncia';
    else if (matchEntityDictionary(combined, ALL_ENTITY_DOMAINS)) {
      const dictAny = matchEntityDictionary(combined, ALL_ENTITY_DOMAINS)!;
      categorie = dictAny.categorie;
      subcategorie = dictAny.subcategorie;
    }
    else {
      // Dynamic Subcategory Extraction from Filename Words — ONLY accepted if the
      // resulting slug is actually grounded in the document text (isGroundedSubcategorySlug
      // above). Previously this unconditionally promoted a filename fragment (or a fully
      // random filename) to a permanent subcategory; now an ungrounded candidate is left as
      // 'general' so the caller's strict fail guard (Golden Rule #4) can BLOCK it instead.
      const cleanName = filename.replace(/\.pdf$/i, '').replace(/[-_\s]+/g, '_').toLowerCase();
      const words = cleanName.split('_').filter(w => w.length > 2 && !/^\d+$/.test(w) && !['pdf', 'doc', 'document', 'copy', 'scan', 'the', 'and', 'for', 'mon', 'mes', 'une', 'des', 'sur', 'les', 'par'].includes(w));
      if (words.length > 0) {
        const candidate = words.find(w => !['contrat', 'facture', 'attestation', 'lettre', 'avis', 'bulletin', 'certificat'].includes(w)) || words[0];
        if (candidate && candidate.length >= 3) {
          const candidateSlug = normalizeSlug(candidate);
          if (isGroundedSubcategorySlug(candidateSlug, rawText, filename)) {
            subcategorie = candidateSlug;
          }
        }
      }
    }
  }

  let date = new Date().toISOString().split('T')[0];
  const compactDateMatch = combined.match(/\b(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\b/);
  const dateMatch = combined.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])[-/](0[1-9]|[12]\d|3[01])\b/) ||
                    combined.match(/\b(0[1-9]|[12]\d|3[01])[-/](0[1-9]|1[0-2])[-/](20\d{2})\b/);
  if (compactDateMatch) {
    date = `${compactDateMatch[1]}-${compactDateMatch[2]}-${compactDateMatch[3]}`;
  } else if (dateMatch) {
    if (dateMatch[1].length === 4) {
      date = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;
    } else {
      date = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    }
  }

  const title = filename.replace(/\.pdf$/i, '').replace(/[-_]+/g, ' ').trim();

  return { categorie, subcategorie, title, date };
}

export function buildCategoriesDescriptionStr(categoriesConfig: ReturnType<typeof getCategoriesConfig>): string {
  return categoriesConfig.categories.map(c => {
    const subsStr = c.subcategories ? c.subcategories.map(s => s.id).join(', ') : 'none';
    const entityHint = buildEntityHintLine(c.id);
    return `- Category '${c.id}' (${c.name}): ${c.description}. Existing subcategories: [${subsStr}].${entityHint}`;
  }).join('\n');
}

export async function classifyPDFText(rawText: string, filename: string, previousError?: string): Promise<DocumentMetadata> {
  const ollama = new Ollama({ host: CONFIG.OLLAMA_HOST });
  const modelHealthy = await ensureOllamaModel(CONFIG.OLLAMA_MODEL);

  const categoriesConfig = getCategoriesConfig();
  const categoriesDescriptionStr = buildCategoriesDescriptionStr(categoriesConfig);

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
    const rb = ruleBasedClassify(rawText, filename);
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
    const rb = ruleBasedClassify(rawText, filename);
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
  } else if (!isGroundedSubcategorySlug(rawSubSlug, rawText, filename)) {
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
