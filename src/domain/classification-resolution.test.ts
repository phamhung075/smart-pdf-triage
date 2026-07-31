import { describe, it, expect } from 'vitest';
import { refineClassification, resolveCategory, resolveSubcategory } from './classification-resolution.js';
import { DocumentMetadata, CategoryItem, EntityDictionary } from './document.schema.js';

const EMPTY_DICTIONARY: EntityDictionary = { banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] };
const DEFAULT_PERSONAL_NAME_DENYLIST = ['pham', 'dai', 'hung', 'thi', 'nguyen', 'huyen'];

function baseMetadata(overrides: Partial<DocumentMetadata>): DocumentMetadata {
  return {
    titre: 'Test', registre: '', date: '', categorie: 'administrative', subcategorie: 'general',
    summary: '', tags: [], markdown_content: '', other: {}, ...overrides,
  };
}

describe('refineClassification', () => {
  it('leaves a specific classification untouched', () => {
    const input = baseMetadata({ categorie: 'invoices', subcategorie: 'sfr' });
    const result = refineClassification(input, 'SFR Facture Total TTC', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result).toEqual(input);
  });

  it('replaces categorie "personal" with the rule-based result', () => {
    const input = baseMetadata({ categorie: 'personal', subcategorie: 'sfr' });
    const result = refineClassification(input, 'SFR Facture Total TTC', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('invoices');
  });

  it('replaces a "general" subcategorie with the rule-based result when the rule-based classifier finds something specific', () => {
    const input = baseMetadata({ categorie: 'invoices', subcategorie: 'general' });
    const result = refineClassification(input, 'Facture SFR Total TTC 45.99', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.subcategorie).toBe('sfr');
  });

  it('does not mutate the input object', () => {
    const input = baseMetadata({ categorie: 'personal', subcategorie: 'sfr' });
    refineClassification(input, 'SFR Facture Total TTC', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(input.categorie).toBe('personal');
  });
});

describe('resolveCategory', () => {
  it('matches an existing category by id', () => {
    const config = { categories: [{ id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] } as CategoryItem] };
    const { category, isNew } = resolveCategory(config, 'invoices');
    expect(category.id).toBe('invoices');
    expect(isNew).toBe(false);
  });

  it('creates and appends a new category when none matches', () => {
    const config = { categories: [] as CategoryItem[] };
    const { category, isNew } = resolveCategory(config, 'new_category');
    expect(isNew).toBe(true);
    expect(category.id).toBe('new_category');
    expect(config.categories).toContain(category);
  });

  it('defaults an empty/falsy categorie to "administrative"', () => {
    const config = { categories: [] as CategoryItem[] };
    const { category } = resolveCategory(config, '');
    expect(category.id).toBe('administrative');
  });
});

describe('resolveSubcategory', () => {
  it('matches an existing subcategory by id', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [{ id: 'sfr', name: 'SFR', aliases: [] }] };
    const { subcategoryId, isNew } = resolveSubcategory(category, 'sfr', 'text', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('sfr');
    expect(isNew).toBe(false);
  });

  it('resolves a forbidden slug (general/other/divers) as-is without creating it', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] };
    const { subcategoryId, isNew } = resolveSubcategory(category, 'other', 'text', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('other');
    expect(isNew).toBe(false);
    expect(category.subcategories).toHaveLength(0);
  });

  it('resolves an ungrounded slug to "general" instead of creating it', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] };
    const { subcategoryId, isNew } = resolveSubcategory(category, 'veolia', 'nothing here about that entity', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('general');
    expect(isNew).toBe(false);
  });

  it('creates and appends a new subcategory when the slug is genuinely grounded', () => {
    const category: CategoryItem = { id: 'invoices', name: 'Invoices', description: '', aliases: [], subcategories: [] };
    const { subcategoryId, isNew, newSubcategory } = resolveSubcategory(category, 'veolia', 'Veolia here and Veolia there', 'veolia_invoice.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(isNew).toBe(true);
    expect(subcategoryId).toBe('veolia');
    expect(newSubcategory?.id).toBe('veolia');
    expect(category.subcategories).toContainEqual(newSubcategory);
  });

  it('coerces a bare-year subcategorie to "general"', () => {
    const category: CategoryItem = { id: 'administrative', name: 'Administrative', description: '', aliases: [], subcategories: [] };
    const { subcategoryId } = resolveSubcategory(category, '2023', 'text', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(subcategoryId).toBe('general');
  });
});
