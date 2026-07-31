import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Ollama } from 'ollama';
import fs from 'fs';

vi.mock('fs');

const { generateMock, listMock, pullMock } = vi.hoisted(() => ({
  generateMock: vi.fn(),
  listMock: vi.fn(),
  pullMock: vi.fn(),
}));

vi.mock('ollama', () => ({
  // NOTE: must be a regular `function`, not an arrow function — ai.service.ts calls
  // `new Ollama(...)`, and arrow functions can never be used as constructors in JS.
  // An arrow-function implementation throws "is not a constructor" under `new`.
  Ollama: vi.fn().mockImplementation(function () {
    return {
      generate: generateMock,
      list: listMock,
      pull: pullMock,
    };
  }),
}));

afterEach(() => {
  vi.resetAllMocks();
});

describe('classifyPDFText', () => {
  beforeEach(() => {
    vi.resetModules();
    generateMock.mockReset();
    listMock.mockReset();
    pullMock.mockReset();
    // The module-level `afterEach(() => vi.resetAllMocks())` (see top of file) also wipes the
    // hoisted `Ollama` constructor's `.mockImplementation(...)` set up in the `vi.mock('ollama', ...)`
    // factory above — resetAllMocks() clears implementations, not just call history, on every
    // mock function, including this one. Without re-establishing it here, `new Ollama(...)` inside
    // ai.service.ts would return a bare `{}` (mock constructors with no implementation just return
    // `this` under `new`), so `.generate`/`.list`/`.pull` would be undefined and every test below
    // would silently fall through to the ruleBasedClassify catch-path instead of exercising Ollama.
    vi.mocked(Ollama).mockImplementation(function () {
      return {
        generate: generateMock,
        list: listMock,
        pull: pullMock,
      } as any;
    } as any);
    vi.mocked(fs.existsSync).mockReturnValue(false); // categories.json/entity_dictionary.json absent -> built-in defaults
    listMock.mockResolvedValue({ models: [{ name: 'qwen3.5:9b' }] });
  });

  it('requests think:false from Ollama — regression guard for the 2026-07-30 bug where the model routed its whole JSON answer into response.thinking and left response.response empty', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' }) // health probe (checkModelCanGenerate)
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Facture SFR', registre: '', date: '2024-05-12',
          categorie: 'invoices', subcategorie: 'sfr', summary: 's', tags: [], markdown_content: 'm',
        }),
      });
    const { classifyPDFText } = await import('./ai.service.js');
    await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf');
    expect(generateMock).toHaveBeenNthCalledWith(2, expect.objectContaining({ think: false }));
  });

  it('parses a valid JSON response into DocumentMetadata (happy path)', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' })
      .mockResolvedValueOnce({
        response: JSON.stringify({
          titre: 'Facture SFR', registre: 'REF-1', date: '2024-05-12',
          categorie: 'invoices', subcategorie: 'sfr', summary: 'A vendor invoice',
          tags: ['sfr'], markdown_content: '# Facture',
        }),
      });
    const { classifyPDFText } = await import('./ai.service.js');
    const result = await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf');
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('sfr');
    expect(result.titre).toBe('Facture SFR');
  });

  it('falls back to ruleBasedClassify when Ollama returns an empty response.response (the pre-fix failure shape)', async () => {
    generateMock
      .mockResolvedValueOnce({ response: 'ok' })
      .mockResolvedValueOnce({
        response: '',
        thinking: JSON.stringify({ titre: 'Facture SFR', categorie: 'invoices', subcategorie: 'sfr' }),
      });
    const { classifyPDFText } = await import('./ai.service.js');
    const result = await classifyPDFText('SFR Facture Total TTC 45.99', 'facture.pdf');
    // classifyPDFText never reads response.thinking — this only resolves correctly via the
    // try/catch fallback to ruleBasedClassify, which independently recognizes 'sfr' + 'total ttc'.
    expect(result.categorie).toBe('invoices');
    expect(result.subcategorie).toBe('sfr');
  });
});
