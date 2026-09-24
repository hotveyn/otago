import path from 'node:path';

export interface ModelConfig {
  /** Models a request may pick, for answers and for node naming. */
  available: string[];
  /** Default model for answers. */
  answer: string;
  /** Default model for node naming. */
  naming: string;
}

export interface Config {
  host: string;
  port: number;
  treesDir: string;
  models: ModelConfig;
  /** `OTAGO_ALLOW_PRIVATE_URLS`: let `save_attachment` fetch loopback/private addresses. */
  allowPrivateUrls: boolean;
}

export const DEFAULT_MODELS: ModelConfig = {
  available: ['claude-opus-5-5', 'claude-sonnet-5', 'claude-fable-5-1', 'claude-haiku-4-5'],
  answer: 'claude-opus-5-5',
  naming: 'claude-haiku-4-5',
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    host: '127.0.0.1',
    port: Number(env.OTAGO_PORT ?? 3001),
    treesDir: path.resolve(env.OTAGO_TREES_DIR ?? './trees'),
    models: loadModels(env),
    allowPrivateUrls: ['1', 'true'].includes(env.OTAGO_ALLOW_PRIVATE_URLS ?? ''),
  };
}

function loadModels(env: NodeJS.ProcessEnv): ModelConfig {
  const answer = env.OTAGO_MODEL || DEFAULT_MODELS.answer;
  const naming = env.OTAGO_NAMING_MODEL || DEFAULT_MODELS.naming;
  const listed = (env.OTAGO_MODELS ?? '')
    .split(',')
    .map((model) => model.trim())
    .filter(Boolean);
  const base = listed.length > 0 ? listed : DEFAULT_MODELS.available;
  // Defaults are always selectable, even when missing from OTAGO_MODELS.
  return { available: [...new Set([...base, answer, naming])], answer, naming };
}
