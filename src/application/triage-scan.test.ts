import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '../infrastructure/settings.js';
import { moveDuplicateFileToDuplicatesFolder } from './triage-scan.js';

describe('moveDuplicateFileToDuplicatesFolder', () => {
  const testInputDir = path.join(CONFIG.INPUT_DIR, 'test_tmp_scan');
  const dupDir = path.join(CONFIG.INPUT_DIR, 'duplicates_files');

  beforeEach(() => {
    if (!fs.existsSync(testInputDir)) {
      fs.mkdirSync(testInputDir, { recursive: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testInputDir)) {
      fs.rmSync(testInputDir, { recursive: true, force: true });
    }
  });

  it('moves duplicate file into input/duplicates_files directory', () => {
    const testFile = path.join(testInputDir, 'sample_duplicate.pdf');
    fs.writeFileSync(testFile, 'dummy pdf content');

    const resultPath = moveDuplicateFileToDuplicatesFolder(testFile);

    expect(fs.existsSync(testFile)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(true);
    expect(resultPath).toContain('duplicates_files');
    expect(path.basename(resultPath)).toBe('sample_duplicate.pdf');

    // Clean up created file in dupDir
    if (fs.existsSync(resultPath)) {
      fs.unlinkSync(resultPath);
    }
  });

  it('handles filename collision by appending _dup counter', () => {
    const testFile = path.join(testInputDir, 'collision.pdf');
    fs.writeFileSync(testFile, 'dummy pdf content');

    const existingInDup = path.join(dupDir, 'collision.pdf');
    fs.writeFileSync(existingInDup, 'already existing duplicate');

    const resultPath = moveDuplicateFileToDuplicatesFolder(testFile);

    expect(fs.existsSync(testFile)).toBe(false);
    expect(fs.existsSync(resultPath)).toBe(true);
    expect(path.basename(resultPath)).toBe('collision_dup1.pdf');

    // Clean up
    if (fs.existsSync(existingInDup)) fs.unlinkSync(existingInDup);
    if (fs.existsSync(resultPath)) fs.unlinkSync(resultPath);
  });
});
