import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, SERVER_DIR } from '../src/config.js';

describe('trees dir config', () => {
  it('resolves relative paths from server/, not from cwd', () => {
    expect(loadConfig({ OTAGO_TREES_DIR: '../trees' }).treesDir).toBe(
      path.resolve(SERVER_DIR, '../trees'),
    );
    expect(loadConfig({}).treesDir).toBe(path.join(SERVER_DIR, 'trees'));
  });

  it('keeps absolute paths as is', () => {
    expect(loadConfig({ OTAGO_TREES_DIR: '/tmp/otago-trees' }).treesDir).toBe('/tmp/otago-trees');
  });
});
