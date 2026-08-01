import { describe, it, expect } from 'vitest';
import { cleanAndParseJSON, matchEntityDictionary, buildEntityHintLine, isGroundedSubcategorySlug, ruleBasedClassify } from './classification.js';
import { EntityDictionary } from './document.schema.js';

const EMPTY_DICTIONARY: EntityDictionary = { banks: [], energy: [], telecom: [], insurance: [], gov: [], health: [] };
const DEFAULT_PERSONAL_NAME_DENYLIST = ['pham', 'dai', 'hung', 'thi', 'nguyen', 'huyen'];

function dictionaryWith(overrides: Partial<EntityDictionary>): EntityDictionary {
  return { ...EMPTY_DICTIONARY, ...overrides };
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
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: ['ca'] }] });
    const result = matchEntityDictionary('extrait de compte crédit agricole paris', ['banks'], dict);
    expect(result).toEqual({ categorie: 'administrative', subcategorie: 'credit_agricole' });
  });

  it('matches an entity by alias', () => {
    const dict = dictionaryWith({ insurance: [{ slug: 'maif', name: 'MAIF', aliases: ['mutuelle assurance instituteurs'] }] });
    const result = matchEntityDictionary('contrat mutuelle assurance instituteurs 2024', ['insurance'], dict);
    expect(result).toEqual({ categorie: 'insurance', subcategorie: 'maif' });
  });

  it('matches accented entity names against accented text (Unicode word boundary)', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'societe_generale', name: 'Société Générale', aliases: [] }] });
    const result = matchEntityDictionary('extrait de compte société générale paris', ['banks'], dict);
    expect(result).toEqual({ categorie: 'administrative', subcategorie: 'societe_generale' });
  });

  it('does NOT match an accented entity name against unaccented search text — this is why every accented entity in entity_dictionary.json must also ship an unaccented alias', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    const result = matchEntityDictionary('extrait de compte credit agricole paris', ['banks'], dict);
    expect(result).toBeNull();
  });

  it('does not match a name as a substring of a longer word (word-boundary correctness)', () => {
    const dict = dictionaryWith({ insurance: [{ slug: 'axa', name: 'AXA', aliases: [] }] });
    // "taxaphone" contains "axa" as a substring but is not a match
    const result = matchEntityDictionary('société taxaphone service client', ['insurance'], dict);
    expect(result).toBeNull();
  });

  it('returns null when nothing matches', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(matchEntityDictionary('nothing recognizable here', ['banks'], dict)).toBeNull();
  });
});

describe('buildEntityHintLine', () => {
  it('formats matching entities as "slug (Name), slug (Name)."', () => {
    const dict = dictionaryWith({
      banks: [
        { slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] },
        { slug: 'fortuneo', name: 'Fortuneo', aliases: [] },
      ],
    });
    expect(buildEntityHintLine('administrative', dict)).toBe(
      ' Known real-world entities: credit_agricole (Crédit Agricole), fortuneo (Fortuneo).'
    );
  });

  it('returns an empty string when no domain maps to the category', () => {
    const dict = dictionaryWith({ banks: [{ slug: 'credit_agricole', name: 'Crédit Agricole', aliases: [] }] });
    expect(buildEntityHintLine('totally_made_up_category_xyz', dict)).toBe('');
  });
});

describe('isGroundedSubcategorySlug', () => {
  it('rejects a slug shorter than 3 characters', () => {
    expect(isGroundedSubcategorySlug('ab', 'ab ab ab', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a generic/structural word even if it appears in the text', () => {
    expect(isGroundedSubcategorySlug('page', 'page 1 of page 2', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a slug built from a personal/household name token', () => {
    expect(isGroundedSubcategorySlug('dai_pham', 'dai pham dai pham', 'file.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a slug with zero occurrences in the document text', () => {
    expect(isGroundedSubcategorySlug('veolia', 'nothing here', 'random.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)).toBe(false);
  });

  it('rejects a filename-echoed slug that appears only once in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia mentioned once', 'veolia_invoice.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)
    ).toBe(false);
  });

  it('accepts a filename-echoed slug that appears at least twice in the text', () => {
    expect(
      isGroundedSubcategorySlug('veolia', 'Veolia here and Veolia there', 'veolia_invoice.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)
    ).toBe(true);
  });

  it('accepts a non-filename-echoed slug that appears once in the text', () => {
    expect(
      isGroundedSubcategorySlug('france_travail', 'Contact France Travail for details', 'doc123.pdf', DEFAULT_PERSONAL_NAME_DENYLIST)
    ).toBe(true);
  });
});

describe('ruleBasedClassify', () => {
  it('classifies a pay slip under bulletin_salaire (never invoices), extracting employer + DD/MM/YYYY date', () => {
    const dict = dictionaryWith({ gov: [{ slug: 'pacifique4', name: 'Pacifique 4', aliases: ['pacifique4'] }] });
    const result = ruleBasedClassify(
      'Bulletin de salaire Pacifique4 Salaire brut 3000 Net a payer 2400 01/03/2023',
      'bulletin_mars.pdf',
      dict,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('bulletin_salaire');
    expect(result.subcategorie).toBe('pacifique4');
    expect(result.title).toBe('bulletin mars');
    expect(result.date).toBe('2023-03-01');
  });

  it('classifies a passport under identity/passeport', () => {
    const result = ruleBasedClassify('Republique Francaise Passeport N 12AB34567', 'doc.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('identity');
    expect(result.subcategorie).toBe('passeport');
  });

  it('classifies titre-An-Ngo.pdf and titre-Dung-Ngo.pdf under identity/titre_sejour', () => {
    const res1 = ruleBasedClassify('Carte de sejour residence permit', 'titre-An-Ngo.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(res1.categorie).toBe('identity');
    expect(res1.subcategorie).toBe('titre_sejour');

    const res2 = ruleBasedClassify('Residence permit France', 'titre-Dung-Ngo.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(res2.categorie).toBe('identity');
    expect(res2.subcategorie).toBe('titre_sejour');
  });

  it('classifies a plain tax notice under administrative/impot', () => {
    const result = ruleBasedClassify(
      "Direction Generale des Finances Publiques DGFIP Avis d'impot sur le revenu 2023",
      'impot2023.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('impot');
  });

  it('does NOT misfile a bank statement as impot just because a transaction row mentions impots (Golden Rule #6 guard)', () => {
    const result = ruleBasedClassify(
      'RELEVE DE COMPTE Credit Mutuel Marseille PRLV IMPOTS DGFIP SOLDE CREDITEUR 1234.56',
      'releve.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('credit_mutuel');
  });

  it('classifies a vendor invoice via the hardcoded regex branch, with compact YYYYMMDD date', () => {
    const result = ruleBasedClassify('Facture SFR n 123456 Total TTC 45.99 EUR 20240512', 'facture.pdf', EMPTY_DICTIONARY, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('sfr');
    expect(result.invoice_type).toBe('SUPPLIER');
    expect(result.date).toBe('2024-05-12');
  });

  it('classifies a client sales invoice under factures_clients and detects PAID / UNPAID status', () => {
    const resClientPaid = ruleBasedClassify(
      'Facture client N 2026-001 Destinataire Acme Corp Acme Corp Montant 1500 EUR PAYÉ PAR VIREMENT',
      'facture_client_acme.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(resClientPaid.categorie).toBe('factures_clients');
    expect(resClientPaid.subcategorie).toBe('acme');
    expect(resClientPaid.invoice_type).toBe('CLIENT');
    expect(resClientPaid.payment_status).toBe('PAID');

    const resClientUnpaid = ruleBasedClassify(
      'Facture de vente N 2026-002 Client Beta Solde à régler avant le 15/09/2026 EN ATTENTE',
      'facture_client_beta.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(resClientUnpaid.categorie).toBe('factures_clients');
    expect(resClientUnpaid.invoice_type).toBe('CLIENT');
    expect(resClientUnpaid.payment_status).toBe('UNPAID');
  });

  it('classifies a vendor invoice via the entity-dictionary fallback when no hardcoded regex matches', () => {
    const dict = dictionaryWith({ energy: [{ slug: 'ekwateur', name: 'Ekwateur', aliases: [] }] });
    const result = ruleBasedClassify('Facture Ekwateur Total TTC 45 EUR', 'facture2.pdf', dict, DEFAULT_PERSONAL_NAME_DENYLIST);
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('ekwateur');
  });

  it('leaves subcategorie as "general" when no signal matches and the filename word is not grounded in the text', () => {
    const result = ruleBasedClassify(
      'Hello world this is a test document with nothing recognizable.',
      'randomfile.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('general');
    expect(result.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // falls back to today's date — don't assert the exact day
  });

  it('dynamically accepts a new subcategory slug from the filename when it is genuinely grounded in the text', () => {
    const result = ruleBasedClassify(
      'Contrat Veolia Eau - consommation trimestrielle, montant total 32.10 EUR. Merci de votre confiance, Veolia.',
      'veolia_invoice.pdf',
      EMPTY_DICTIONARY,
      DEFAULT_PERSONAL_NAME_DENYLIST
    );
    expect(result.categorie).toBe('administrative');
    expect(result.subcategorie).toBe('veolia');
  });
});
