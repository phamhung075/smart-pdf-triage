import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import { cleanAndParseJSON, matchEntityDictionary, buildEntityHintLine } from './ai.service.js';

vi.mock('fs');

let mockDictValue: any = null;

beforeEach(() => {
  mockDictValue = null;
  // Setup fs mocks before each test
  vi.mocked(fs.existsSync).mockImplementation(() => mockDictValue !== null);
  vi.mocked(fs.readFileSync).mockImplementation(() => JSON.stringify(mockDictValue || {}) as any);
});

afterEach(() => {
  vi.clearAllMocks();
});

function mockEntityDictionary(contents: object) {
  // Ensure all required domains are present in the mocked dictionary
  mockDictValue = {
    banks: [],
    energy: [],
    telecom: [],
    insurance: [],
    gov: [],
    health: [],
    ...contents,
  };
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
    const result = matchEntityDictionary('extrait de compte credit agricole paris', ['banks']);
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
