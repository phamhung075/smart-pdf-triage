import { ensureDirectoriesExist, CONFIG } from './config.js';
import { startWebServer } from './server/web_server.js';
import { startMCPServer } from './mcp/server.js';
import { runTriageScan } from './services/triage.service.js';

async function main() {
  ensureDirectoriesExist();

  const command = process.argv[2];

  if (command === 'scan') {
    console.log('Starting standalone PDF triage scan...');
    const result = await runTriageScan();
    console.log('Triage finished:', JSON.stringify(result, null, 2));
    process.exit(0);
  } else if (command === 'mcp') {
    console.error('Starting MCP Server...');
    await startMCPServer();
  } else {
    console.log('Starting Web Dashboard & Triage API Server...');
    startWebServer(CONFIG.PORT);
  }
}

main().catch(err => {
  console.error('Fatal error in application:', err);
  process.exit(1);
});
