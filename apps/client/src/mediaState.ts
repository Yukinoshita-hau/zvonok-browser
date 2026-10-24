export function mediaState(width:number, fps:number) {
  return width<1280 || (Number.isFinite(fps) && fps<10) ? 'degraded · качество видео ограничено' : 'streaming';
}
