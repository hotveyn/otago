import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MODELS, loadConfig } from '../src/config.js';
import { makeApp, TEST_MODELS } from './helpers.js';

describe('model config', () => {
  it('uses built-in defaults', () => {
    expect(loadConfig({}).models).toEqual(DEFAULT_MODELS);
  });

  it('reads the allowlist and defaults from env, keeping defaults selectable', () => {
    const { models } = loadConfig({
      OTAGO_MODELS: ' claude-sonnet-5 , claude-haiku-4-5,,claude-sonnet-5 ',
      OTAGO_MODEL: 'claude-opus-5-5',
      OTAGO_NAMING_MODEL: 'claude-haiku-4-5',
    });
    expect(models).toEqual({
      available: ['claude-sonnet-5', 'claude-haiku-4-5', 'claude-opus-5-5'],
      answer: 'claude-opus-5-5',
      naming: 'claude-haiku-4-5',
    });
  });

  it('treats empty env values as unset', () => {
    expect(
      loadConfig({ OTAGO_MODEL: '', OTAGO_NAMING_MODEL: '', OTAGO_MODELS: '' }).models,
    ).toEqual(DEFAULT_MODELS);
  });
});

describe('GET /api/models', () => {
  let ctx: Awaited<ReturnType<typeof makeApp>>;
  afterEach(() => ctx.close());

  it('lists available models and defaults', async () => {
    ctx = await makeApp();
    const res = await ctx.app.inject({ method: 'GET', url: '/api/models' });
    expect(res.json()).toEqual({
      models: TEST_MODELS.available,
      defaults: { answer: 'answer-default', naming: 'naming-default' },
    });
  });
});
