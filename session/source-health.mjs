// Allow a bounded Worker capture recovery without rotating healthy RTC tracks.
export function sourceHealth(now, lastReceived) {
  const gapMs = now - lastReceived;
  return gapMs >= 10000 ? 'expired' : gapMs >= 2000 ? 'reconnecting' : 'fresh';
}
