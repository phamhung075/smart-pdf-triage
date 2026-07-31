import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { cleanAndParseJSON, matchEntityDictionary, buildEntityHintLine, isGroundedSubcategorySlug, ruleBasedClassify } from './ai.service.js';

vi.mock('fs');

afterEach(() => {
  vi.clearAllMocks();
});

function mockEntityDictionary(contents: object) {
  vi.mocked(fs.existsSync).mockImplementation((p) =>
    String(p).endsWith('entity_dictionary.json')
  );
  vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify(contents) as any);
}

describe('cleanAndParseJSON', () => {
  it('strips ```json fences and trailing commas', () => {
    const raw = '```json\n{"titre": "Test", "categorie": "invoices",}\n```';
    expect(cleanAndParseJSON(raw)).toEqual({ titre: 'Test', categorie: 'invoices' });
  });

  it('throws when the response has no JSON object at all', () => {
    expect(() => cleanAndParseJSON('I cannot help with that request.')).toThrow(
      'No JSON object found in AI response'
    );
  });

  it('repairs a truncated response (unterminated string, missing closing brace)', () => {
    const raw = '{"titre": "Test Doc", "markdown_content": "some unterminated text';
    expect(cleanAndParseJSON(raw)).toEqual({
      titre: 'Test Doc',
      markdown_content: 'some unterminated text',
    });
  });

  it('repairs truncation inside a nested array', () => {
    const raw = '{"titre": "Test", "tags": ["a", "b"';
    expect(cleanAndParseJSON(raw)).toEqual({ titre: 'Test', tags: ['a', 'b'] });
  });

  it('ignores text before the first { and after the last }', () => {
    const raw = 'Here is the JSON: {"titre": "Test"} — hope that helps!';
    expect(cleanAndParseJSON(raw)).toEqual({ titre: 'Test' });
  });
});

describe('matchEntityDictionary', () => {
  it('matches an entity by its exact name, case-insensitively', () => {
    mockEntityDictionary({
      banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: ['ca'] }],
    });
    const result = matchEntityDictionary('extrait de compte crédit agricole paris', ['banks']);
    expect(result).toEqual({ categorie: 'administrative', subcategorie: 'credit_agricole' });
  });

  it('matches an entity by alias', () => {
    mockEntityDictionary({
      insurance: [{ slug: 'maif', name: 'MAIF', aliases: ['mutuelle assurance instituteurs'] }],
    });
    const result = matchEntityDictionary('contrat mutuelle assurance instituteurs 2024', ['insurance']);
    expect(result).toEqual({ categorie: 'insurance', subcategorie: 'maif' });
  });

  it('matches accented entity names against accented text (Unicode word boundary)', () => {
    mockEntityDictionary({
      banks: [{ slug: 'societe_generale', name: 'Société Générale', aliases: [] }],
    });
    const result = matchEntityDictionary('extrait de compte société générale paris', ['banks']);
    expect(result).toEqual({ categorie: 'administrative', subcategorie: 'societe_generale' });
  });

  it('does not match a name as a substring of a longer word (word-boundary correctness)', () => {
    mockEntityDictionary({
      insurance: [{ slug: 'axa', name: 'AXA', aliases: [] }],
    });
    // "taxaphone" contains "axa" as a substring but is not a match
    const result = matchEntityDictionary('société taxaphone service client', ['insurance']);
    expect(result).toBeNull();
  });

  it('returns null when nothing matches', () => {
    mockEntityDictionary({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(matchEntityDictionary('nothing recognizable here', ['banks'])).toBeNull();
  });
});

describe('buildEntityHintLine', () => {
  it('formats matching entities as "slug (Name), slug (Name)."', () => {
    mockEntityDictionary({
      banks: [
        { slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] },
        { slug: 'fortuneo', name: 'Fortuneo', aliases: [] },
      ],
    });
    expect(buildEntityHintLine('administrative')).toBe(
      ' Known real-world entities: credit_agricole (Crédit Agricole), fortuneo (Fortuneo).'
    );
  });

  it('returns an empty string when no domain maps to the category', () => {
    mockEntityDictionary({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(buildEntityHintLine('totally_made_up_category_xyz')).toBe('');
  });
});

describe('isGroundedSubcategorySlug', () => {
  it('rejects a slug shorter than 3 characters', () => {
    expect(isGroundedSubcategorySlug('ab', 'ab ab ab', 'file.pdf')).toBe(false);
  });

  it('rejects a generic/structural word even if it appears in the text', () => {
    expect(isGroundedSubcategorySlug('page', 'page 1 of page 2', 'file.pdf')).toBe(false);
  });

  it('rejects a slug built from a personal/household name token', () => {
    // 'dai' is in CONFIG's default PERSONAL_NAME_DENYLIST
    expect(isGroundedSubcategorySlug('dai_pham', 'dai pham dai pham', 'file.pdf')).toBe(false);
  });

  it('rejects a slug with zero occurrences in the document text', () => {
    expect(isGroundedSubcategorySlug('veolia', 'nothing here', 'random.pdf')).toBe(false);
  });

  it('rejects a filename-echoed slug that appears only once in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia mentioned once', 'veolia_invoice.pdf')
    ).toBe(false);
  });

  it('accepts a filename-echoed slug that appears at least twice in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia here and Veolia there', 'veolia_invoice.pdf')
    ).toBe(true);
  });

  it('accepts a non-filename-echoed slug that appears once in the text', () => {
    expect(
      isGroundedSubcategorySlug('france_travail', 'Contact France Travail for details', 'doc123.pdf')
    ).toBe(true);
  });
});

describe('ruleBasedClassify', () => {
  it('classifies a pay slip under bulletin_salaire (never invoices), extracting employer + DD/MM/YYYY date', () => {
    const result = ruleBasedClassify(
      'Bulletin de salaire Pacifique4 Salaire brut 3000 Net a payer 2400 01/03/2023',
      'bulletin_mars.pdf'
    );
    expect(result).toEqual({
      categorie: 'bulletin_salaire',
      subcategorie: 'pacifique4',
      title: 'bulletin mars',
      date: '2023-03-01',
    });
  });

  it('classifies a passport under identity/passeport', () => {
    const result = ruleBasedClassify('Republique Francaise Passeport N 12AB34567', 'doc.pdf');
    expect(result.categorie).toBe('identity');
    expect(result.subcategorie).toBe('passeport');
  });

  it('classifies a plain tax notice under administrative/impot', () => {
    const result = ruleBasedClassify(
      "Direction Generale des Finances Publiques DGFIP Avis d'impot sur le revenu 2023",
      'impot2023.pdf'
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('impot');
  });

  it('does NOT misfile a bank statement as impot just because a transaction row mentions impots (Golden Rule #6 guard)', () => {
    const result = ruleBasedClassify(
      'RELEVE DE COMPTE Credit Mutuel Marseille PRLV IMPOTS DGFIP SOLDE CREDITEUR 1234.56',
      'releve.pdf'
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('credit_mutuel');
  });

  it('classifies a vendor invoice via the hardcoded regex branch, with compact YYYYMMDD date', () => {
    const result = ruleBasedClassify('Facture SFR n 123456 Total TTC 45.99 EUR 20240512', 'facture.pdf');
    expect(result).toEqual({
      categorie: 'invoices',
      subcategorie: 'sfr',
      title: 'facture',
      date: '2024-05-12',
    });
  });

  it('classifies a vendor invoice via the entity-dictionary fallback when no hardcoded regex matches', () => {
    mockEntityDictionary({ energy: [{ slug: 'ekwateur', name: 'Ekwateur', aliases: [] }] });
    const result = ruleBasedClassify('Facture Ekwateur Total TTC 45 EUR', 'facture2.pdf');
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('ekwateur');
  });

  it('leaves subcategorie as "general" when no signal matches and the filename word is not grounded in the text', () => {
    const result = ruleBasedClassify(
      'Hello world this is a test document with nothing recognizable.',
      'randomfile.pdf'
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('general');
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // falls back to today's date — don't assert the exact day
  });

  it('dynamically accepts a new subcategory slug from the filename when it is genuinely grounded in the text', () => {
    const result = ruleBasedClassify(
      'Contrat Veolia Eau - consommation trimestrielle, montant total 32.10 EUR. Merci de votre confiance, Veolia.',
      'veolia_invoice.pdf'
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('veolia');
  });
});
