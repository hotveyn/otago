import { describe, expect, it } from 'vitest';
import { matchLanguage, resolveLanguage } from './language';

describe('matchLanguage', () => {
  it('matches by primary subtag, case-insensitively', () => {
    expect(matchLanguage(['ru-RU', 'en'])).toBe('ru');
    expect(matchLanguage(['EN-us'])).toBe('en');
  });

  it('skips unsupported languages and falls back to English', () => {
    expect(matchLanguage(['de-DE', 'ru'])).toBe('ru');
    expect(matchLanguage(['de', 'fr'])).toBe('en');
    expect(matchLanguage([])).toBe('en');
  });
});

describe('resolveLanguage', () => {
  it('prefers a valid stored choice over the browser', () => {
    expect(resolveLanguage('en', ['ru'])).toBe('en');
  });

  it('ignores missing or unknown stored values', () => {
    expect(resolveLanguage(null, ['ru'])).toBe('ru');
    expect(resolveLanguage('xx', ['ru'])).toBe('ru');
  });
});
