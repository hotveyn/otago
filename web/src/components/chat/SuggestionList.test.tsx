import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Suggestion } from '../../api/types';
import { SUGGESTION_LABEL_GRAPHEMES } from '../../lib/suggestions';
import { SuggestionList } from './SuggestionList';

const render = (items: Suggestion[]) =>
  renderToStaticMarkup(<SuggestionList items={items} onAsk={() => undefined} />);

const own: Suggestion = { text: 'Что дальше?', target: 'план/раздел', up: 0 };
const inherited: Suggestion = { text: 'Зачем это?', target: 'план/раздел', up: 2 };

describe('SuggestionList (server render smoke test)', () => {
  it('renders nothing without items', () => {
    expect(render([])).toBe('');
  });

  it('renders an own item without a source tag', () => {
    const html = render([own]);
    expect(html).toContain('<nav class="suggestions" aria-label="Suggested questions">');
    expect(html).toContain('<span dir="auto">Что дальше?</span>');
    expect(html).toContain('title="Что дальше?"');
    expect(html).not.toContain('suggestion-source');
  });

  it('tags an inherited item with its source and names the target in the title', () => {
    const html = render([inherited]);
    expect(html).toContain(
      '<span class="suggestion-source">from <bdi dir="auto">раздел</bdi></span>',
    );
    expect(html).toContain('title="Зачем это?\nAsks under план/раздел"');
  });

  it('truncates a long label and keeps the full text in the title', () => {
    const text = 'я'.repeat(SUGGESTION_LABEL_GRAPHEMES + 10);
    const html = render([{ ...own, text }]);
    expect(html).toContain(`<span dir="auto">${'я'.repeat(SUGGESTION_LABEL_GRAPHEMES)}…</span>`);
    expect(html).toContain(`title="${text}"`);
  });

  it('renders every item (no cap)', () => {
    const items = Array.from({ length: 8 }, (_, i) => ({ ...own, text: `Вопрос ${i}` }));
    const html = render(items);
    expect(html.match(/<button/g)).toHaveLength(8);
    const positions = items.map((item) => html.indexOf(`>${item.text}</span>`));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it('tags every item of an inherited-only list', () => {
    const items: Suggestion[] = [
      { text: 'Глава 4', target: 'план/глава-3', up: 1 },
      { text: 'Обзор', target: 'план', up: 2 },
    ];
    const html = render(items);
    expect(html.match(/class="suggestion-source"/g)).toHaveLength(2);
    expect(html).toContain('from <bdi dir="auto">глава-3</bdi>');
    expect(html).toContain('from <bdi dir="auto">план</bdi>');
  });

  it('keeps the order', () => {
    const html = render([inherited, own]);
    expect(html.indexOf('Зачем это?')).toBeLessThan(html.indexOf('Что дальше?'));
  });
});
