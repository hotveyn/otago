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

describe('suggestion model config', () => {
  it('defaults to the naming default, also when the naming model is overridden', () => {
    expect(loadConfig({}).models.suggest).toBe('claude-haiku-4-5');
    const { models } = loadConfig({ OTAGO_NAMING_MODEL: 'claude-sonnet-5' });
    expect(models.suggest).toBe('claude-sonnet-5');
    expect(loadConfig({ OTAGO_SUGGEST_MODEL: '' }).models.suggest).toBe('claude-haiku-4-5');
  });

  it('uses OTAGO_SUGGEST_MODEL and keeps it selectable', () => {
    const { models } = loadConfig({
      OTAGO_MODELS: 'claude-opus-5-5',
      OTAGO_SUGGEST_MODEL: 'claude-fable-5-1',
    });
    expect(models.suggest).toBe('claude-fable-5-1');
    expect(models.available).toContain('claude-fable-5-1');
  });
});
