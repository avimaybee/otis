/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest';
import { clampPaste } from '../src/components/RecordsGridSpike.js';

describe('grid spike paste overflow', () => {
  it('clamps pasted rectangles to the grid instead of growing it', () => {
    const applied = clampPaste([8, 18], [['a', 'b', 'c', 'd'], ['e', 'f'], ['g']], 10, 20);
    expect(applied).toEqual([
      { row: 18, col: 8, values: ['a', 'b'] },
      { row: 19, col: 8, values: ['e', 'f'] },
    ]);
  });

  it('keeps in-bounds pastes intact', () => {
    expect(clampPaste([0, 0], [['a', 'b'], ['c', 'd']], 10, 20)).toEqual([
      { row: 0, col: 0, values: ['a', 'b'] },
      { row: 1, col: 0, values: ['c', 'd'] },
    ]);
  });
});
