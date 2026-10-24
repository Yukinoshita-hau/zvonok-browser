export const mediaProfiles = Object.freeze({
  '720p15': { width: 1280, height: 720, fps: 15 },
  '720p30': { width: 1280, height: 720, fps: 30 },
  '720p60': { width: 1280, height: 720, fps: 60 },
  '1080p30': { width: 1920, height: 1080, fps: 30 },
  '1080p60': { width: 1920, height: 1080, fps: 60 },
});

export function resolveMediaProfile(name) {
  const profile = mediaProfiles[name];
  if (!profile || !Object.hasOwn(mediaProfiles, name)) throw Error('INVALID_MEDIA_PROFILE');
  return { name, ...profile };
}
