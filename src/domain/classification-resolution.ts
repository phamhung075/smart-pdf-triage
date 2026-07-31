import { CategoryItem, SubcategoryItem, DocumentMetadata, EntityDictionary } from './document.schema.js';
import { ruleBasedClassify, isGroundedSubcategorySlug, normalizeSlug } from './classification.js';

// Refine Category & Subcategory using ruleBasedClassify if AI returned 'general', 'personal', 'other', or 'correspondence' for a Tax/Bank document
export function refineClassification(
  validated: DocumentMetadata,
  rawText: string,
  filename: string,
  dictionary: EntityDictionary,
  personalNameDenylist: string[]
): DocumentMetadata {
  if (!(validated.categorie === 'personal' || validated.categorie === 'other' || validated.subcategorie === 'general' || (validated.categorie === 'correspondence' && /impot|tax/i.test(filename)))) {
    return validated;
  }

  const rb = ruleBasedClassify(rawText, filename, dictionary, personalNameDenylist);
  const result = { ...validated };

  if (validated.categorie === 'personal' || validated.categorie === 'other' || !validated.categorie || (validated.categorie === 'correspondence' && rb.categorie === 'administrative')) {
    result.categorie = rb.categorie;
  }
  if (validated.subcategorie === 'general' && rb.subcategorie !== 'general') {
    result.subcategorie = rb.subcategorie;
  }

  return result;
}

// Normalize category ID & resolve to an existing entry, or describe a new one to be
// auto-created BEFORE the file is moved (Golden Rule #5).
export function resolveCategory(categoriesConfig: { categories: CategoryItem[] }, rawCategorie: string): { category: CategoryItem; isNew: boolean } {
  const rawCatSlug = normalizeSlug(rawCategorie || 'administrative');
  const matchedCategory = categoriesConfig.categories.find(c =>
    c.id === rawCatSlug || (c.aliases && c.aliases.some(a => rawCatSlug.includes(a)))
  );

  if (matchedCategory) {
    return { category: matchedCategory, isNew: false };
  }

  const newCatSlug = rawCatSlug;
  const newCatName = newCatSlug
    .split('_')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

  const newCatObj: CategoryItem = {
    id: newCatSlug,
    name: newCatName,
    description: `Category auto-created for ${newCatName}`,
    aliases: [newCatSlug],
    subcategories: []
  };

  categoriesConfig.categories.push(newCatObj);
  return { category: newCatObj, isNew: true };
}

const FORBIDDEN_SUBCATEGORIES = new Set(['general', 'other', 'divers']);

// Normalize subcategory ID & resolve to an existing entry under `matchedCategory`, or
// describe a new one to be auto-created BEFORE the file is moved (Golden Rule #5) — unless
// the slug is forbidden (Golden Rule #4) or ungrounded (see isGroundedSubcategorySlug),
// in which case it resolves to 'general' so the caller's strict fail guard can BLOCK it.
export function resolveSubcategory(
  matchedCategory: CategoryItem,
  rawSubcategorie: string,
  rawText: string,
  filename: string,
  personalNameDenylist: string[]
): { subcategoryId: string; isNew: boolean; newSubcategory?: SubcategoryItem; rawSubSlug: string } {
  let rawSubSlug = normalizeSlug(rawSubcategorie || '');
  // Clean dates from subcategory slugs
  rawSubSlug = rawSubSlug.replace(/_\d{4,8}$/g, '').replace(/\d{4,8}$/g, '');

  if (!rawSubSlug || /^\d{4}$/.test(rawSubSlug)) {
    rawSubSlug = 'general';
  }

  if (!matchedCategory.subcategories) {
    matchedCategory.subcategories = [];
  }

  const matchedSub = FORBIDDEN_SUBCATEGORIES.has(rawSubSlug)
    ? undefined
    : matchedCategory.subcategories.find(s =>
        s.id === rawSubSlug || (s.aliases && s.aliases.some(a => rawSubSlug.includes(a)))
      );

  if (matchedSub) {
    return { subcategoryId: matchedSub.id, isNew: false, rawSubSlug };
  }

  if (FORBIDDEN_SUBCATEGORIES.has(rawSubSlug)) {
    // Forbidden sentinel value — never auto-create it as a real taxonomy entry. Return it
    // as-is so the caller's strict fail guard (Golden Rule #4) BLOCKs the file and keeps
    // it in __raws.
    return { subcategoryId: rawSubSlug, isNew: false, rawSubSlug };
  }

  if (!isGroundedSubcategorySlug(rawSubSlug, rawText, filename, personalNameDenylist)) {
    // The model (or the ruleBasedClassify refinement pass) invented a "specific"-looking
    // slug that isn't actually grounded in the document's own content — a filename echo,
    // gibberish, or a generic/structural word. Refuse to pollute categories.json with it;
    // resolve to 'general' so the caller's BLOCK guard catches it instead of silently
    // mis-filing the document under a garbage subcategory. `rawSubSlug` is still returned
    // (alongside the forced 'general' subcategoryId) so the caller can log the actual
    // rejected slug value for diagnosability.
    return { subcategoryId: 'general', isNew: false, rawSubSlug };
  }

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
  return { subcategoryId: rawSubSlug, isNew: true, newSubcategory: newSubObj, rawSubSlug };
}
