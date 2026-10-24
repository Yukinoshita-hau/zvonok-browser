const profiles = {
  '720p15': { width: 1280, height: 720, fps: 15 },
  '720p30': { width: 1280, height: 720, fps: 30 },
  '720p60': { width: 1280, height: 720, fps: 60 },
  '1080p30': { width: 1920, height: 1080, fps: 30 },
  '1080p60': { width: 1920, height: 1080, fps: 60 },
} as const;

export function resolveMediaProfile(name = process.env.BROWSER_MEDIA_PROFILE || `720p${process.env.MEDIA_FPS ?? 15}`) {
  const profile = profiles[name as keyof typeof profiles];
  if (!profile) throw Error('INVALID_MEDIA_PROFILE');
  return { name: name as keyof typeof profiles, ...profile };
}
