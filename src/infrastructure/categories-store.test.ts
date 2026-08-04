import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let tempDir: string;
let categoriesFile: string;

// CATEGORIES_FILE is CONFIG.CATEGORIES_FILE = path.join(BASE_DIR, 'categories.json') in the
// real settings.ts — BASE_DIR is a hardcoded literal (unlike INPUT_DIR/DB_PATH, which respect
// env vars), so left un-mocked this would read/write the REAL project's categories.json (the
// live taxonomy source of truth). Mock the whole settings module with a temp path instead.
vi.mock('./settings.js', () => ({
  get CONFIG() { return { CATEGORIES_FILE: categoriesFile }; },
}));

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'categories-store-test-'));
  categoriesFile = path.join(tempDir, 'categories.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function fresh() {
  vi.resetModules();
  return import('./categories-store.js');
}

describe('getCategoriesConfig', () => {
  it('returns the built-in default categories when categories.json does not exist', async () => {
    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();
    expect(config.categories.length).toBeGreaterThan(0);
    expect(config.categories.some(c => c.id === 'invoices')).toBe(true);
  });

  it('returns the parsed content when categories.json exists and is valid', async () => {
    fs.writeFileSync(categoriesFile, JSON.stringify({
      categories: [{ id: 'custom', name: 'Custom', description: '', aliases: [], subcategories: [] }],
    }));
    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();
    expect(config.categories).toEqual([{ id: 'custom', name: 'Custom', description: '', aliases: [], subcategories: [] }]);
  });

  it('falls back to defaults when categories.json contains malformed JSON', async () => {
    fs.writeFileSync(categoriesFile, '{not valid json');
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();
    expect(config.categories.some(c => c.id === 'invoices')).toBe(true);
    consoleErrorSpy.mockRestore();
  });

  it('falls back to defaults when categories.json fails schema validation', async () => {
    fs.writeFileSync(categoriesFile, JSON.stringify({ categories: [{ name: 'Missing id field' }] }));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { getCategoriesConfig } = await fresh();
    const config = getCategoriesConfig();
    expect(config.categories.some(c => c.id === 'invoices')).toBe(true);
    consoleErrorSpy.mockRestore();
  });
});

describe('saveCategoriesConfig', () => {
  it('writes validated JSON to categories.json', async () => {
    const { saveCategoriesConfig } = await fresh();
    saveCategoriesConfig([{ id: 'new_cat', name: 'New', description: '', aliases: [], subcategories: [] }]);

    const written = JSON.parse(fs.readFileSync(categoriesFile, 'utf-8'));
    expect(written.categories).toEqual([{ id: 'new_cat', name: 'New', description: '', aliases: [], subcategories: [] }]);
  });

  it('invokes the registered onCategoryCreatedCallback', async () => {
    const { saveCategoriesConfig, setOnCategoryCreatedCallback } = await fresh();
    const callback = vi.fn();
    setOnCategoryCreatedCallback(callback);

    saveCategoriesConfig([{ id: 'c', name: 'C', description: '', aliases: [], subcategories: [] }]);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('swallows an error thrown by the callback instead of letting it propagate', async () => {
    const { saveCategoriesConfig, setOnCategoryCreatedCallback } = await fresh();
    setOnCategoryCreatedCallback(() => { throw new Error('callback exploded'); });

    expect(() => saveCategoriesConfig([{ id: 'c', name: 'C', description: '', aliases: [], subcategories: [] }])).not.toThrow();
  });

  it('does not invoke a callback when none has been registered', async () => {
    const { saveCategoriesConfig } = await fresh();
    // Fresh module graph => onCategoryCreatedCallback starts null; just confirm no throw.
    expect(() => saveCategoriesConfig([{ id: 'c', name: 'C', description: '', aliases: [], subcategories: [] }])).not.toThrow();
  });
});
