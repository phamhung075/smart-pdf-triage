import path from 'path';
import fs from 'fs';

export const BASE_DIR = path.resolve('D:/DaiHung/__projet/__master/pdf_triage');
export const SETTINGS_FILE = path.join(BASE_DIR, 'settings.json');

export function loadCustomSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
      return JSON.parse(raw);
    } catch (e) {
      console.error("Error reading settings.json", e);
    }
  }
  return {};
}

const customSettings = loadCustomSettings();

// Golden Rule #14: only qwen3.5:9b is supported. Legacy/cloud/subscription-gated models
// are rejected even if they somehow end up in settings.json (manual edit, stale API
// caller, etc.) rather than silently trusted — this is what let 'kimi-k3:cloud' run
// undetected for hours.
const ALLOWED_OLLAMA_MODEL = 'qwen3.5:9b';
function sanitizeOllamaModel(model: unknown): string {
  if (model === ALLOWED_OLLAMA_MODEL) return ALLOWED_OLLAMA_MODEL;
  if (model) {
    console.warn(`Ignoring unsupported ollama_model '${model}' (only '${ALLOWED_OLLAMA_MODEL}' is allowed per Golden Rule #14) — falling back to '${ALLOWED_OLLAMA_MODEL}'.`);
  }
  return ALLOWED_OLLAMA_MODEL;
}

// Default set of owner/household name tokens (lowercase) that must never be accepted as
// a subcategory — see PERSONAL_NAME_DENYLIST usage in domain/classification.ts. Fully configurable via settings.json.
const DEFAULT_PERSONAL_NAME_DENYLIST: string[] = [];
function sanitizePersonalNameDenylist(list: unknown): string[] {
  if (!Array.isArray(list)) return DEFAULT_PERSONAL_NAME_DENYLIST;
  return list.map(v => String(v).toLowerCase().trim()).filter(Boolean);
}

export const CONFIG = {
  INPUT_DIR: customSettings.input_dir || process.env.PDF_INPUT_DIR || path.join(BASE_DIR, 'input'),
  OUTPUT_ROOT_DIR: customSettings.output_root_dir || process.env.PDF_OUTPUT_DIR || path.join(BASE_DIR, 'organized'),
  JSON_REGISTRY_PATH: process.env.PDF_REGISTRY_PATH || path.join(BASE_DIR, 'registry.json'),
  DB_PATH: process.env.PDF_DB_PATH || path.join(BASE_DIR, 'pdf_triage.db'),
  CATEGORIES_FILE: path.join(BASE_DIR, 'categories.json'),
  ENTITY_DICTIONARY_FILE: path.join(BASE_DIR, 'entity_dictionary.json'),

  OLLAMA_HOST: customSettings.ollama_host || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
  OLLAMA_MODEL: sanitizeOllamaModel(customSettings.ollama_model || process.env.OLLAMA_MODEL),
  OLLAMA_EMBED_MODEL: process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text',

  PORT: parseInt(process.env.PORT || '3000', 10),

  PERSONAL_NAME_DENYLIST: sanitizePersonalNameDenylist(customSettings.personal_name_denylist),
};

export function reloadConfigFromDisk(): void {
  const current = loadCustomSettings();
  if (current.input_dir) CONFIG.INPUT_DIR = current.input_dir;
  if (current.output_root_dir) CONFIG.OUTPUT_ROOT_DIR = current.output_root_dir;
  CONFIG.OLLAMA_MODEL = sanitizeOllamaModel(current.ollama_model);
  if (current.ollama_host) CONFIG.OLLAMA_HOST = current.ollama_host;
  CONFIG.PERSONAL_NAME_DENYLIST = sanitizePersonalNameDenylist(current.personal_name_denylist);
}

export function updateConfig(newSettings: {
  input_dir?: string;
  output_root_dir?: string;
  ollama_model?: string;
  ollama_host?: string;
  personal_name_denylist?: string[];
}): void {
  if (newSettings.input_dir) CONFIG.INPUT_DIR = newSettings.input_dir;
  if (newSettings.output_root_dir) CONFIG.OUTPUT_ROOT_DIR = newSettings.output_root_dir;
  if (newSettings.ollama_model) CONFIG.OLLAMA_MODEL = sanitizeOllamaModel(newSettings.ollama_model);
  if (newSettings.ollama_host) CONFIG.OLLAMA_HOST = newSettings.ollama_host;
  if (newSettings.personal_name_denylist) CONFIG.PERSONAL_NAME_DENYLIST = sanitizePersonalNameDenylist(newSettings.personal_name_denylist);

  const dataToSave = {
    input_dir: CONFIG.INPUT_DIR,
    output_root_dir: CONFIG.OUTPUT_ROOT_DIR,
    ollama_model: CONFIG.OLLAMA_MODEL,
    ollama_host: CONFIG.OLLAMA_HOST,
    personal_name_denylist: CONFIG.PERSONAL_NAME_DENYLIST
  };

  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(dataToSave, null, 2), 'utf-8');
  ensureDirectoriesExist();
}

export function ensureDirectoriesExist(): void {
  const dirs = [
    CONFIG.INPUT_DIR,
    CONFIG.OUTPUT_ROOT_DIR,
    path.dirname(CONFIG.JSON_REGISTRY_PATH),
    path.dirname(CONFIG.DB_PATH)
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
}
