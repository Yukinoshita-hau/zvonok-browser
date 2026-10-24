import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { expect, it, vi } from 'vitest';
import { binding } from './surface.js';

vi.mock('node:http', () => ({ request: vi.fn() }));

it('binding failures expose a fixed diagnostic reason without the broker response body', async () => {
  const response = Object.assign(new EventEmitter(), { statusCode: 409 });
  const req = Object.assign(new EventEmitter(), {
    setTimeout: vi.fn(),
    end: () => { response.emit('data', 'private broker detail'); response.emit('end'); },
  });
  vi.mocked(request).mockImplementation(((_options: unknown, receive: (value: unknown) => void) => {
    receive(response); return req;
  }) as unknown as typeof request);
  await expect(binding('/lease', {})).rejects.toThrow('MEDIA_BINDING_REJECTED');
});

it('binding timeout retains its phase code for the lease diagnostic', async () => {
  let timeout!: () => void;
  const req = Object.assign(new EventEmitter(), {
    setTimeout: (_ms: number, callback: () => void) => { timeout = callback; },
    end: () => timeout(),
    destroy: (error: Error) => { req.emit('error', error); },
  });
  vi.mocked(request).mockReturnValue(req as unknown as ReturnType<typeof request>);
  await expect(binding('/lease', {})).rejects.toThrow('BINDING_TIMEOUT');
});
