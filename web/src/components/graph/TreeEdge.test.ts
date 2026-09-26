import { describe, expect, it } from 'vitest';
import { treePath } from './TreeEdge';

describe('treePath', () => {
  it('draws a straight line when the child is right below', () => {
    expect(treePath(50, 0, 50, 40)).toBe('M 50,0 V 40');
  });

  it('turns only at the shared bus halfway between the ranks', () => {
    const path = treePath(50, 0, 150, 40);
    expect(path).toBe('M 50,0 V 14 Q 50,20 56,20 H 144 Q 150,20 150,26 V 40');
  });

  it('keeps corners inside a narrow offset', () => {
    expect(treePath(50, 0, 54, 40)).toContain('Q 50,20 52,20');
  });
});
