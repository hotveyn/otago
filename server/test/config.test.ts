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

describe('model config', () => {
  it('ignores a leftover OTAGO_SUGGEST_MODEL', () => {
    const { models } = loadConfig({
      OTAGO_MODELS: 'claude-opus-5-5',
      OTAGO_SUGGEST_MODEL: 'claude-fable-5-1',
    });
    expect(models).not.toHaveProperty('suggest');
    expect(models.available).not.toContain('claude-fable-5-1');
    const listed = loadConfig({
      OTAGO_MODELS: 'claude-opus-5-5,claude-fable-5-1',
      OTAGO_SUGGEST_MODEL: 'claude-fable-5-1',
    });
    expect(listed.models.available).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-haiku-4-5',
    ]);
  });
});
