import { describe, expect, it } from 'vitest';
import { i18n } from '.';

describe('translations', () => {
  const ru = i18n.getFixedT('ru', 'chat');

  it('picks Russian plural forms', () => {
    expect([1, 2, 5, 21].map((count) => ru('table.rows', { count }))).toEqual([
      '1 строка',
      '2 строки',
      '5 строк',
      '21 строка',
    ]);
  });

  it('falls back to English for an unknown language', () => {
    expect(i18n.getFixedT('de', 'chat')('composer.send')).toBe('Send');
  });
});
