import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

export interface LogEntry {
  id: number;
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  moduleName: string;
  message: string;
  meta?: any;
  line: string;
}

const LOG_DIR = path.resolve('logs');
const LOG_FILE = path.join(LOG_DIR, 'triage_debug.log');

export const logEmitter = new EventEmitter();
logEmitter.setMaxListeners(100);

const MAX_BUFFER_SIZE = 500;
let logIdCounter = 1;
const logBuffer: LogEntry[] = [];

function ensureLogDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function formatLogMessage(level: LogEntry['level'], moduleName: string, message: string, meta?: any): { line: string; entry: LogEntry } {
  const timestamp = new Date().toISOString();
  let metaStr = '';
  if (meta !== undefined) {
    try {
      metaStr = typeof meta === 'object' ? ` | Meta: ${JSON.stringify(meta)}` : ` | Meta: ${meta}`;
    } catch {
      metaStr = ` | Meta: [Circular]`;
    }
  }
  const line = `[${timestamp}] [${level}] [${moduleName}] ${message}${metaStr}\n`;
  const entry: LogEntry = {
    id: logIdCounter++,
    timestamp,
    level,
    moduleName,
    message,
    meta,
    line
  };

  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER_SIZE) {
    logBuffer.shift();
  }

  logEmitter.emit('log', entry);
  return { line, entry };
}

function writeToFile(logLine: string): void {
  try {
    ensureLogDir();
    fs.appendFileSync(LOG_FILE, logLine, 'utf8');
  } catch (err) {
    console.error('Failed to write to log file:', err);
  }
}

export function getRecentLogs(limit = 200): LogEntry[] {
  return logBuffer.slice(-limit);
}

export const logger = {
  debug(moduleName: string, message: string, meta?: any): void {
    const { line } = formatLogMessage('DEBUG', moduleName, message, meta);
    console.log(`\x1b[36m[DEBUG]\x1b[0m \x1b[35m[${moduleName}]\x1b[0m ${message}`, meta ? meta : '');
    writeToFile(line);
  },
  info(moduleName: string, message: string, meta?: any): void {
    const { line } = formatLogMessage('INFO', moduleName, message, meta);
    console.log(`\x1b[32m[INFO]\x1b[0m \x1b[35m[${moduleName}]\x1b[0m ${message}`, meta ? meta : '');
    writeToFile(line);
  },
  warn(moduleName: string, message: string, meta?: any): void {
    const { line } = formatLogMessage('WARN', moduleName, message, meta);
    console.warn(`\x1b[33m[WARN]\x1b[0m \x1b[35m[${moduleName}]\x1b[0m ${message}`, meta ? meta : '');
    writeToFile(line);
  },
  error(moduleName: string, message: string, meta?: any): void {
    const { line } = formatLogMessage('ERROR', moduleName, message, meta);
    console.error(`\x1b[31m[ERROR]\x1b[0m \x1b[35m[${moduleName}]\x1b[0m ${message}`, meta ? meta : '');
    writeToFile(line);
  }
};
