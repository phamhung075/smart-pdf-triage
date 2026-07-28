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
    return true;
  } catch (err: any) {
    console.warn(`Ollama check/pull warning for model ${modelName}:`, err.message);
    try {
      console.log('Attempting auto-spawn of local Ollama serve process...');
      const { exec } = await import('child_process');
      exec('ollama serve');
      await new Promise(r => setTimeout(r, 2000));
      const retryList = await ollama.list();
      return retryList.models.some(m => m.name.startsWith(modelName) || m.name.includes(modelName));
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

export function cleanAndParseJSON(rawStr: string): any {
  let text = rawStr.trim();
  text = text.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    text = text.substring(start, end + 1);
  }

  text = text.replace(/,\s*([\}\]])/g, '$1');
  return JSON.parse(text);
}

export function ruleBasedClassify(rawText: string, filename: string): { categorie: string; subcategorie: string; title: string; date: string } {
  const combined = (filename + ' ' + rawText.substring(0, 4000)).toLowerCase();

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
    else if (/\bedf|engie\b/i.test(combined)) subcategorie = 'edf';
    else if (/\bcdiscount\b/i.test(combined)) subcategorie = 'cdiscount';
    else if (/\bamazon\b/i.test(combined)) subcategorie = 'amazon';
    else {
      const dictVendor = matchEntityDictionary(combined, ['telecom', 'energy']);
      if (dictVendor) subcategorie = dictVendor.subcategorie;
    }
  }
  // 7. Taxes & Government Income Statements
  else if (/\b(avis[ _-]d[ _-]impot|avis[ _-]d'impot|avis[ _-]impot|déclaration[ _-]d'impôt|taxe[ _-]fonciere|taxe[ _-]foncière|taxe[ _-]d'habitation|revenus[ _-]et[ _-]prelev|prélèvement[ _-]sociaux|prelev[ _-]sociaux|finances[ _-]publiques|dgfip|impôt|impots)\b/i.test(combined)) {
    categorie = 'administrative';
    subcategorie = 'impot';
  }
  // 7b. Government & Social Agencies
  else if (matchEntityDictionary(combined, ['gov'])) {
    const dictGov = matchEntityDictionary(combined, ['gov'])!;
    categorie = dictGov.categorie;
    subcategorie = dictGov.subcategorie;
  }
  // 8. Insurance / Assurances
  else if (/\b(assurance auto|assurance habitation|prévoyance|prevoyance|responsabilité civile|allianz|macif|maaf|a2a)\b/i.test(combined) || matchEntityDictionary(combined, ['insurance'])) {
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
    else if (/\b(edf|engie)\b/i.test(combined)) subcategorie = 'edf';
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
      // Dynamic Subcategory Extraction from Filename Words
      const cleanName = filename.replace(/\.pdf$/i, '').replace(/[-_\s]+/g, '_').toLowerCase();
      const words = cleanName.split('_').filter(w => w.length > 2 && !/^\d+$/.test(w) && !['pdf', 'doc', 'document', 'copy', 'scan', 'the', 'and', 'for', 'mon', 'mes', 'une', 'des', 'sur', 'les', 'par'].includes(w));
      if (words.length > 0) {
        const candidate = words.find(w => !['contrat', 'facture', 'attestation', 'lettre', 'avis', 'bulletin', 'certificat'].includes(w)) || words[0];
        if (candidate && candidate.length >= 3) {
          subcategorie = normalizeSlug(candidate);
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
  await ensureOllamaModel(CONFIG.OLLAMA_MODEL);

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
   - If the issuing company or organization is NOT in existing subcategories, DYNAMICALLY GENERATE A NEW CLEAN SLUG for that exact entity (e.g. 'france_travail', 'caf', 'urssaf', 'veolia', 'orange').
   - NEVER output 'general', 'personal', 'other', 'divers', or year strings ('2023') as subcategories!

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
    userPrompt += `\n\n⚠️ PREVIOUS ATTEMPT FEEDBACK (FIX THIS PROBLEM):\nThe previous classification attempt for this document encountered an error: "${previousError}".\nPlease carefully analyze the document text and fix this issue. You MUST provide a specific, valid Category and Subcategory slug (e.g. 'credit_mutuel', 'impot', 'ameli', 'sfr'). Do NOT return 'general' or 'other'.`;
  }

  logger.debug('OLLAMA_AI', `Sending classification request to model '${CONFIG.OLLAMA_MODEL}'`, { filename, textSnippetLength: textSnippet.length });

  let validated: DocumentMetadata;

  try {
    const response = await ollama.generate({
      model: CONFIG.OLLAMA_MODEL,
      system: systemPrompt,
      prompt: userPrompt,
      format: 'json',
      options: {
        temperature: 0.1
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

  let matchedSub = matchedCategory.subcategories.find(s =>
    s.id === rawSubSlug || (s.aliases && s.aliases.some(a => rawSubSlug.includes(a)))
  );

  if (matchedSub) {
    validated.subcategorie = matchedSub.id;
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
