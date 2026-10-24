import { expect, it } from 'vitest';
import { resolveMediaProfile } from './mediaProfile.js';

it.each([
  ['720p30', 1280, 720, 30],
  ['720p60', 1280, 720, 60],
  ['1080p30', 1920, 1080, 30],
  ['1080p60', 1920, 1080, 60],
] as const)('resolves %s capture and publish dimensions', (name, width, height, fps) => {
  expect(resolveMediaProfile(name)).toEqual({ name, width, height, fps });
});

it('keeps the existing 720p15 default and rejects unsupported profiles', () => {
  expect(resolveMediaProfile(undefined)).toEqual({ name: '720p15', width: 1280, height: 720, fps: 15 });
  expect(() => resolveMediaProfile('4k60')).toThrow('INVALID_MEDIA_PROFILE');
});
