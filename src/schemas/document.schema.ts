import { z } from 'zod';

export type SubcategoryItem = {
  id: string;
  name: string;
  aliases?: string[];
  subcategories?: SubcategoryItem[];
};

export const SubcategorySchema: z.ZodType<SubcategoryItem> = z.lazy(() =>
  z.object({
    id: z.string().min(1, "Subcategory ID is required"),
    name: z.string().min(1, "Subcategory Name is required"),
    aliases: z.array(z.string()).optional().default([]),
    subcategories: z.array(SubcategorySchema).optional().default([])
  })
);

export const CategorySchema = z.object({
  id: z.string().min(1, "ID is required"),
  name: z.string().min(1, "Name is required"),
  description: z.string().optional().default(""),
  aliases: z.array(z.string()).default([]),
  subcategories: z.array(SubcategorySchema).optional().default([])
});

export const CategoriesConfigSchema = z.object({
  categories: z.array(CategorySchema)
});

export const EntityItemSchema = z.object({
  slug: z.string().min(1, "Entity slug is required"),
  name: z.string().min(1, "Entity name is required"),
  aliases: z.array(z.string()).optional().default([])
});

export const EntityDictionarySchema = z.object({
  banks: z.array(EntityItemSchema).optional().default([]),
  energy: z.array(EntityItemSchema).optional().default([]),
  telecom: z.array(EntityItemSchema).optional().default([]),
  insurance: z.array(EntityItemSchema).optional().default([]),
  gov: z.array(EntityItemSchema).optional().default([]),
  health: z.array(EntityItemSchema).optional().default([])
});

export type EntityItem = z.infer<typeof EntityItemSchema>;
export type EntityDictionary = z.infer<typeof EntityDictionarySchema>;

export const SystemSettingsSchema = z.object({
  input_dir: z.string().min(1, "Input directory is required"),
  output_root_dir: z.string().min(1, "Output directory is required"),
  ollama_model: z.string().min(1, "Ollama model is required").refine(
    (val) => val === 'qwen3.5:9b',
    { message: "Only 'qwen3.5:9b' is supported (Golden Rule #14) — other models, including cloud/subscription-gated ones, are rejected." }
  ),
  ollama_host: z.string().min(1, "Ollama host is required"),
  // No .default([]) — an absent field must stay `undefined` so updateConfig() can tell
  // "the caller didn't send this" apart from "the caller explicitly wants it cleared";
  // otherwise every settings save from a client that doesn't know this field (e.g. the
  // current UI form) would silently reset it to CONFIG's default list.
  personal_name_denylist: z.array(z.string()).optional()
});

export const DocumentMetadataSchema = z.object({
  titre: z.string().min(1, "Titre est requis"),
  registre: z.string().default(""),
  date: z.string().default(""),
  categorie: z.string().min(1, "Catégorie est requise"),
  subcategorie: z.string().default(""),
  summary: z.string().default(""),
  tags: z.array(z.string()).default([]),
  markdown_content: z.string().default(""),
  other: z.record(z.string(), z.any()).optional().default({})
});

export const UpdateDocumentSchema = z.object({
  title: z.string().optional(),
  titre: z.string().optional(),
  registre: z.string().optional(),
  date: z.string().optional(),
  category: z.string().optional(),
  categorie: z.string().optional(),
  subcategory: z.string().optional(),
  subcategorie: z.string().optional(),
  summary: z.string().optional(),
  tags: z.array(z.string()).optional(),
  markdown_content: z.string().optional()
});

export const SearchQuerySchema = z.object({
  query: z.string().default(""),
  category: z.string().optional(),
  subcategory: z.string().optional(),
  mode: z.enum(['hybrid', 'keyword', 'semantic']).default('hybrid'),
  limit: z.number().int().positive().default(50)
});

export type DocumentMetadata = z.infer<typeof DocumentMetadataSchema>;
export type UpdateDocumentInput = z.infer<typeof UpdateDocumentSchema>;
export type SearchQuery = z.infer<typeof SearchQuerySchema>;
export type CategoryItem = z.infer<typeof CategorySchema>;
export type SystemSettings = z.infer<typeof SystemSettingsSchema>;
