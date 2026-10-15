import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LineView } from './LineView';

const hits = (html: string) => html.split('line-hit').length - 1;

describe('LineView (server render smoke test)', () => {
  it('numbers lines and highlights the cited range', () => {
    const html = renderToStaticMarkup(<LineView text={'a\nb\nc\n'} start={2} end={3} />);
    expect(html).toContain('<span class="line-no">3</span>');
    expect(html).not.toContain('<span class="line-no">4</span>');
    expect(hits(html)).toBe(2);
  });

  it('highlights one line for a point range and nothing out of range', () => {
    expect(hits(renderToStaticMarkup(<LineView text={'a\nb\nc'} start={2} />))).toBe(1);
    expect(hits(renderToStaticMarkup(<LineView text={'a\nb\nc'} start={9} end={10} />))).toBe(0);
    expect(hits(renderToStaticMarkup(<LineView text={'a\nb\nc'} />))).toBe(0);
  });
});
