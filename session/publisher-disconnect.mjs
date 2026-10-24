export function closeOnDisconnect(room, close) {
  room.on('disconnected', () => { void close(1, 'livekit-disconnected'); });
}
