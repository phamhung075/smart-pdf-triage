import { CategoryItem, EntityDictionary } from './document.schema.js';

const DOMAIN_CATEGORY_MAP: Record<keyof EntityDictionary, string> = {
  banks: 'administrative',
  energy: 'invoices',
  telecom: 'invoices',
  insurance: 'insurance',
  gov: 'administrative',
  health: 'health'
};

export const ALL_ENTITY_DOMAINS = Object.keys(DOMAIN_CATEGORY_MAP) as (keyof EntityDictionary)[];

export function matchEntityDictionary(combined: string, domains: (keyof EntityDictionary)[], dictionary: EntityDictionary): { categorie: string; subcategorie: string } | null {
  for (const domain of domains) {
    const categorie = DOMAIN_CATEGORY_MAP[domain];
    for (const entry of dictionary[domain]) {
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

export function buildEntityHintLine(categoryId: string, dictionary: EntityDictionary): string {
  const domains = ALL_ENTITY_DOMAINS.filter(domain => DOMAIN_CATEGORY_MAP[domain] === categoryId);
  const entries = domains.flatMap(domain => dictionary[domain]);
  if (entries.length === 0) return '';
  return ` Known real-world entities: ${entries.map(e => `${e.slug} (${e.name})`).join(', ')}.`;
}

export function normalizeSlug(str: string): string {
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
export function isGroundedSubcategorySlug(slug: string, rawText: string, filename: string, personalNameDenylist: string[]): boolean {
  if (!slug || slug.length < MIN_GROUNDED_SLUG_LENGTH) return false;
  if (GENERIC_SLUG_DENYLIST.has(slug)) return false;
  // The document owner's own name appears in nearly every header/footer (postal address,
  // "cher Monsieur/Madame", etc.), so a naive grounding check would mistake the owner for
  // the actual issuer/entity. personalNameDenylist filters the owner's own name out so it
  // is never mistaken for a grounding match.
  const denylistSet = new Set(personalNameDenylist.map(n => n.toLowerCase().trim()));
  if (slug.split('_').some(part => denylistSet.has(part))) return false;

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

export function ruleBasedClassify(rawText: string, filename: string, dictionary: EntityDictionary, personalNameDenylist: string[]): { categorie: string; subcategorie: string; title: string; date: string } {
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
      const dictHealth = matchEntityDictionary(combined, ['health'], dictionary);
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
      const dictVendor = matchEntityDictionary(combined, ['telecom', 'energy'], dictionary);
      if (dictVendor) {
        subcategorie = dictVendor.subcategorie;
      } else {
        const dictInsuranceViaFacture = matchEntityDictionary(combined, ['insurance'], dictionary);
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
  else if (!looksLikeBankStatement && matchEntityDictionary(combined, ['gov'], dictionary)) {
    const dictGov = matchEntityDictionary(combined, ['gov'], dictionary)!;
    categorie = dictGov.categorie;
    subcategorie = dictGov.subcategorie;
  }
  // 8. Insurance / Assurances
  else if (/\b(assurance auto|assurance habitation|prévoyance|prevoyance|responsabilité civile|allianz|macif|maaf|a2a)\b/i.test(combined) || (!looksLikeBankStatement && matchEntityDictionary(combined, ['insurance'], dictionary))) {
    categorie = 'insurance';
    if (/\ballianz\b/i.test(combined)) subcategorie = 'allianz';
    else {
      const dictInsurance = matchEntityDictionary(combined, ['insurance'], dictionary);
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
  } else if (matchEntityDictionary(combined, ['banks'], dictionary)) {
    const dictBank = matchEntityDictionary(combined, ['banks'], dictionary)!;
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
    else if (matchEntityDictionary(combined, ALL_ENTITY_DOMAINS, dictionary)) {
      const dictAny = matchEntityDictionary(combined, ALL_ENTITY_DOMAINS, dictionary)!;
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
          if (isGroundedSubcategorySlug(candidateSlug, rawText, filename, personalNameDenylist)) {
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

export function buildCategoriesDescriptionStr(categoriesConfig: { categories: CategoryItem[] }, dictionary: EntityDictionary): string {
  return categoriesConfig.categories.map(c => {
    const subsStr = c.subcategories ? c.subcategories.map(s => s.id).join(', ') : 'none';
    const entityHint = buildEntityHintLine(c.id, dictionary);
    return `- Category '${c.id}' (${c.name}): ${c.description}. Existing subcategories: [${subsStr}].${entityHint}`;
  }).join('\n');
}
