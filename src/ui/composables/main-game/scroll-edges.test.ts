import { describe, expect, it } from 'vitest';
import { scrollEdges } from './scroll-edges';

describe('scrollEdges', () => {
  it('nothing hidden when everything fits', () => {
    expect(scrollEdges(0, 300, 300)).toEqual({ moreBefore: false, moreAfter: false });
    expect(scrollEdges(0, 300.5, 300)).toEqual({ moreBefore: false, moreAfter: false });
  });

  it('more after at the start, more on both sides in the middle, more before at the end', () => {
    expect(scrollEdges(0, 500, 200)).toEqual({ moreBefore: false, moreAfter: true });
    expect(scrollEdges(150, 500, 200)).toEqual({ moreBefore: true, moreAfter: true });
    expect(scrollEdges(300, 500, 200)).toEqual({ moreBefore: true, moreAfter: false });
    expect(scrollEdges(299.5, 500, 200)).toEqual({ moreBefore: true, moreAfter: false });
  });
});
