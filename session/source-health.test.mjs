import { expect, it } from 'vitest';
import { sourceHealth } from './source-health.mjs';

it('temporary starvation preserves the publisher, actual input restores health, permanent loss remains bounded', () => {
  expect(sourceHealth(1999, 0)).toBe('fresh');
  expect(sourceHealth(2000, 0)).toBe('reconnecting');
  expect(sourceHealth(9999, 0)).toBe('reconnecting');
  expect(sourceHealth(10000, 0)).toBe('expired');
  expect(sourceHealth(10000, 9999)).toBe('fresh');
});
