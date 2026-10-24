import { describe, expect, it } from 'vitest';
import { mediaProfiles, resolveMediaProfile } from './media-profiles.mjs';

describe('publisher media profiles', () => {
  it('accepts each explicit profile with matching dimensions and frame rate', () => {
    expect(Object.keys(mediaProfiles)).toEqual(['720p15', '720p30', '720p60', '1080p30', '1080p60']);
    for (const [name, expected] of Object.entries({
      '720p15': { width: 1280, height: 720, fps: 15 },
      '720p30': { width: 1280, height: 720, fps: 30 },
      '720p60': { width: 1280, height: 720, fps: 60 },
      '1080p30': { width: 1920, height: 1080, fps: 30 },
      '1080p60': { width: 1920, height: 1080, fps: 60 },
    })) expect(resolveMediaProfile(name)).toEqual({ name, ...expected });
  });

  it('rejects unsupported media profile names', () => {
    expect(() => resolveMediaProfile('4k60')).toThrow('INVALID_MEDIA_PROFILE');
  });
});
