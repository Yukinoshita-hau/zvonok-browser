import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { closeOnDisconnect } from './publisher-disconnect.mjs';

it('routes LiveKit disconnect through the idempotent BrowserSession publisher cleanup', () => {
  const room = new EventEmitter(), close = vi.fn();
  closeOnDisconnect(room, close); room.emit('disconnected');
  expect(close).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledWith(1, 'livekit-disconnected');
});
