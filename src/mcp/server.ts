import fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord } from '../infrastructure/db/database.js';
import { getCategoriesConfig } from '../services/ai.service.js';
import { runTriageScan, relocalizeFileIfNeeded, ensureCategoryAndSubcategoryExist, ScanInProgressError } from '../services/triage.service.js';
import { isForbiddenSubcategory } from '../domain/taxonomy.js';
import { syncJSONRegistry } from '../services/json_registry.service.js';
import { UpdateDocumentSchema } from '../domain/document.schema.js';

export async function startMCPServer(): Promise<void> {
  const server = new Server(
    {
      name: 'pdf-triage-agent-mcp',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'search_documents',
          description: 'Search documents by title, summary, reference registre, category, or full raw text',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search term or keywords' },
              category: { type: 'string', description: 'Optional category filter' },
              subcategory: { type: 'string', description: 'Optional subcategory filter' },
              limit: { type: 'number', description: 'Max results count (default 20)' }
            }
          }
        },
        {
          name: 'get_full_document_text',
          description: 'Retrieve the complete extracted raw text of a document by document ID',
          inputSchema: {
            type: 'object',
            properties: {
              docId: { type: 'number', description: 'Document ID' }
            },
            required: ['docId']
          }
        },
        {
          name: 'update_document_metadata',
          description: 'Modify title, registre, date, category, subcategory, summary, or tags for a document. If category or subcategory changes, the physical file is relocalized to the new canonical folder (auto-creating the category/subcategory in categories.json first, per Golden Rule #5). subcategory cannot be general/other/divers/a bare year (Golden Rule #4).',
          inputSchema: {
            type: 'object',
            properties: {
              docId: { type: 'number', description: 'Document ID' },
              title: { type: 'string' },
              registre: { type: 'string' },
              date: { type: 'string' },
              category: { type: 'string' },
              subcategory: { type: 'string' },
              summary: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } }
            },
            required: ['docId']
          }
        },
        {
          name: 'trigger_triage',
          description: 'Scan the incoming PDFs input folder and process all new documents',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        },
        {
          name: 'list_categories',
          description: 'List all available document categories and their description/keywords',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      if (name === 'search_documents') {
        const query = ((args?.query as string) || '').toLowerCase();
        const category = ((args?.category as string) || '').toLowerCase();
        const subcategory = ((args?.subcategory as string) || '').toLowerCase();
        const limit = (args?.limit as number) || 20;

        const docs = await getAllDocuments();
        const matches = docs.filter(doc => {
          const catMatch = !category || doc.category.toLowerCase() === category;
          const subMatch = !subcategory || (doc.subcategory || '').toLowerCase() === subcategory;
          const textMatch = !query ||
            doc.title.toLowerCase().includes(query) ||
            doc.summary.toLowerCase().includes(query) ||
            doc.registre.toLowerCase().includes(query) ||
            doc.tags.toLowerCase().includes(query) ||
            (doc.subcategory || '').toLowerCase().includes(query) ||
            doc.raw_text.toLowerCase().includes(query);
          return catMatch && subMatch && textMatch;
        }).slice(0, limit);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                count: matches.length,
                results: matches.map(d => ({
                  id: d.id,
                  title: d.title,
                  registre: d.registre,
                  date: d.date,
                  category: d.category,
                  subcategory: d.subcategory,
                  summary: d.summary,
                  new_path: d.new_path,
                  status: d.status
                }))
              }, null, 2)
            }
          ]
        };
      }

      if (name === 'get_full_document_text') {
        const docId = args?.docId as number;
        const doc = await getDocumentById(docId);
        if (!doc) {
          return {
            content: [{ type: 'text', text: `Error: Document ID ${docId} not found` }],
            isError: true
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                id: doc.id,
                title: doc.title,
                registre: doc.registre,
                date: doc.date,
                category: doc.category,
                summary: doc.summary,
                file_path: doc.new_path || doc.original_path,
                raw_text: doc.raw_text
              }, null, 2)
            }
          ]
        };
      }

      if (name === 'update_document_metadata') {
        const docId = args?.docId;
        if (typeof docId !== 'number' || !Number.isInteger(docId) || docId <= 0) {
          return {
            content: [{ type: 'text', text: `Error: docId must be a positive integer, got: ${JSON.stringify(docId)}` }],
            isError: true
          };
        }

        const parsed = UpdateDocumentSchema.safeParse(args);
        if (!parsed.success) {
          return {
            content: [{ type: 'text', text: `Error: invalid arguments — ${parsed.error.message}` }],
            isError: true
          };
        }
        const updates = parsed.data;

        const explicitSubcategory = updates.subcategory ?? updates.subcategorie;
        if (explicitSubcategory !== undefined && isForbiddenSubcategory(explicitSubcategory)) {
          return {
            content: [{ type: 'text', text: `Error: '${explicitSubcategory}' is not a valid subcategory (general/other/divers/year strings are not allowed — Golden Rule #4). Please choose a specific entity or document-type name.` }],
            isError: true
          };
        }

        const docBefore = await getDocumentById(docId);
        if (!docBefore) {
          return {
            content: [{ type: 'text', text: `Error: Document ID ${docId} not found` }],
            isError: true
          };
        }

        const success = await updateDocumentRecord(docId, updates);
        if (!success) {
          return {
            content: [{ type: 'text', text: `Error: Document ID ${docId} not found` }],
            isError: true
          };
        }

        // Relocalize the physical file if category/subcategory changed, mirroring
        // PUT /api/documents/:id — this tool previously left the DB and disk out of sync.
        if (docBefore.new_path && fs.existsSync(docBefore.new_path)) {
          const targetCategory = updates.category ?? updates.categorie ?? docBefore.category;
          const targetSubcategory = updates.subcategory ?? updates.subcategorie ?? docBefore.subcategory;
          ensureCategoryAndSubcategoryExist(targetCategory, targetSubcategory);
          const { newPath } = relocalizeFileIfNeeded(
            docBefore.new_path,
            targetCategory,
            targetSubcategory,
            updates.date ?? docBefore.date
          );
          if (newPath !== docBefore.new_path) {
            await updateDocumentRecord(docId, { new_path: newPath });
          }
        }

        await syncJSONRegistry();
        return {
          content: [{ type: 'text', text: `Successfully updated metadata for document ID ${docId}` }]
        };
      }

      if (name === 'trigger_triage') {
        try {
          const result = await runTriageScan();
          return {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
          };
        } catch (err: any) {
          if (err instanceof ScanInProgressError) {
            return {
              content: [{ type: 'text', text: `Error: ${err.message}` }],
              isError: true
            };
          }
          throw err;
        }
      }

      if (name === 'list_categories') {
        const config = getCategoriesConfig();
        return {
          content: [{ type: 'text', text: JSON.stringify(config.categories, null, 2) }]
        };
      }

      return {
        content: [{ type: 'text', text: `Unknown tool name: ${name}` }],
        isError: true
      };
    } catch (err: any) {
      return {
        content: [{ type: 'text', text: `Error executing ${name}: ${err.message}` }],
        isError: true
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('PDF Triage MCP Server connected via stdio');
}
