import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { getAllDocuments, getDocumentById, updateDocumentRecord } from '../db/database.js';
import { getCategoriesConfig } from '../services/ai.service.js';
import { runTriageScan } from '../services/triage.service.js';
import { syncJSONRegistry } from '../services/json_registry.service.js';

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
          description: 'Modify title, registre, date, category, summary, or tags for a document',
          inputSchema: {
            type: 'object',
            properties: {
              docId: { type: 'number', description: 'Document ID' },
              title: { type: 'string' },
              registre: { type: 'string' },
              date: { type: 'string' },
              category: { type: 'string' },
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
        const limit = (args?.limit as number) || 20;

        const docs = await getAllDocuments();
        const matches = docs.filter(doc => {
          const catMatch = !category || doc.category.toLowerCase() === category;
          const textMatch = !query ||
            doc.title.toLowerCase().includes(query) ||
            doc.summary.toLowerCase().includes(query) ||
            doc.registre.toLowerCase().includes(query) ||
            doc.tags.toLowerCase().includes(query) ||
            doc.raw_text.toLowerCase().includes(query);
          return catMatch && textMatch;
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
        const docId = args?.docId as number;
        const updates: any = {};
        if (args?.title) updates.title = args.title;
        if (args?.registre) updates.registre = args.registre;
        if (args?.date) updates.date = args.date;
        if (args?.category) updates.category = args.category;
        if (args?.summary) updates.summary = args.summary;
        if (args?.tags) updates.tags = args.tags;

        const success = await updateDocumentRecord(docId, updates);
        if (success) {
          await syncJSONRegistry();
          return {
            content: [{ type: 'text', text: `Successfully updated metadata for document ID ${docId}` }]
          };
        } else {
          return {
            content: [{ type: 'text', text: `Error: Document ID ${docId} not found` }],
            isError: true
          };
        }
      }

      if (name === 'trigger_triage') {
        const result = await runTriageScan();
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
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
