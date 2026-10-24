import { describe, it, expect, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { BrowserIntegration, BrowserPool, IntegrationAuth, type Assertion } from './integration.js';

const key = 'test-only-'.repeat(6);
const claims = (op = 'create', subject = '1', activityId: string = randomUUID()): Assertion => ({ aud: 'zvonok-browser', exp: Date.now() + 10000, nonce: randomUUID(), activityId, subject, op, body: {}, epoch: '', generation: '' });
const signed = (c: Assertion) => { const p = Buffer.from(JSON.stringify(c)).toString('base64url'); return `${p}.${createHmac('sha256', key).update(p).digest('base64url')}`; };
const response = (data: unknown, status = 200) => ({ status, type: 'application/json', data: status === 204 ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data)) });
describe('Core integration trust boundary', () => {
	it('returns the existing session for a duplicate create on the same Activity', async () => {
		const worker = vi.fn<ConstructorParameters<typeof BrowserIntegration>[0]>(async () => response({ sessionId: 'one-session', status: 'active' }));
		const integration = new BrowserIntegration(worker), first = claims();
		const [a, b] = await Promise.all([integration.handle(first), integration.handle({ ...first, nonce: randomUUID() })]);
		expect(a.data.toString()).toBe(b.data.toString());
		expect(worker).toHaveBeenCalledTimes(1);
		expect(worker.mock.calls[0]?.[3]).toEqual({ 'x-browser-owner': '1', 'x-browser-session-id': first.activityId });
	});
	it('routes real tab create, activate and close commands to the fenced Worker session', async () => {
		const worker = vi.fn(async () => response({ sessionId: 'tab-session', status: 'active' }));
		const integration = new BrowserIntegration(worker), activity = claims();
		await integration.handle(activity);
		const tabId = randomUUID();
		for (const [op, body, path] of [
			['tabs/create', {}, '/sessions/tab-session/tabs'],
			['tabs/activate', { tabId }, `/sessions/tab-session/tabs/${tabId}/activate`],
			['tabs/close', { tabId }, `/sessions/tab-session/tabs/${tabId}/close`],
		] as const) {
			await integration.handle({ ...claims(op, '1', activity.activityId), body, epoch: 'media-epoch', generation: '7' });
			expect(worker.mock.calls.at(-1)).toEqual(['POST', path, {}, {
				'x-browser-owner': '1', 'x-control-epoch': 'media-epoch', 'x-control-generation': '7',
			}]);
		}
	});
	it('routes quality changes through the same fenced session command', async () => {
		const worker = vi.fn(async () => response({ sessionId: 'quality-session', status: 'active' }));
		const integration = new BrowserIntegration(worker), activity = claims();
		await integration.handle(activity);
		await integration.handle({ ...claims('quality', '1', activity.activityId), body: { profile: '1080p60' }, epoch: 'media-epoch', generation: '7' });
		expect(worker.mock.calls.at(-1)).toEqual(['POST', '/sessions/quality-session/quality', { profile: '1080p60' }, {
			'x-browser-owner': '1', 'x-control-epoch': 'media-epoch', 'x-control-generation': '7',
		}]);
	});
	it('only a trusted guest heartbeat requests renewal and keeps the private expiry consistent without rotating membership', async () => {
		vi.useFakeTimers();
		try {
			const worker = vi.fn(async (_method: string, path: string, _body?: unknown, _credentials?: Record<string, string>) => {
				if (path.endsWith('/invite')) return response({ invite: 'invite', epoch: 'epoch' });
				if (path.endsWith('/accept')) return response({ token: 'private-token', expiresAt: Date.now() + 2000, session: { sessionId: 'session', status: 'active' } });
				if (path.endsWith('/heartbeat')) return response({ collaboration: { membershipExpiresAt: Date.now() + 600000 } });
				return response({ sessionId: 'session', status: 'active', expiresAt: new Date(Date.now() + 1200000).toISOString() });
			});
			const integration = new BrowserIntegration(worker), a = claims(); await integration.handle(a);
			await integration.handle(claims('join', '2', a.activityId));
			await vi.advanceTimersByTimeAsync(1000); await integration.handle(claims('heartbeat', '2', a.activityId));
			expect(worker.mock.calls.at(-1)?.[3]?.['x-browser-renew-member']).toBe('1');
			await vi.advanceTimersByTimeAsync(2000); await integration.handle(claims('join', '2', a.activityId));
			expect(worker.mock.calls.filter(c => c[1].endsWith('/accept'))).toHaveLength(1);
			await integration.handle(claims('revoke-member', '1', a.activityId));
			await expect(integration.handle(claims('heartbeat', '2', a.activityId))).rejects.toThrow('ACCESS_DENIED');
		} finally { vi.useRealTimers(); }
	});
	it('a late renewal response cannot extend a replacement guest credential after revocation', async () => {
		vi.useFakeTimers();
		try {
			let complete!: (r: ReturnType<typeof response>) => void, accepted = 0;
			const worker = vi.fn(async (_method: string, path: string) => {
				if (path.endsWith('/invite')) return response({ invite: 'invite', epoch: 'epoch' });
				if (path.endsWith('/accept')) return response({ token: `private-${++accepted}`, expiresAt: Date.now() + 2000, session: { sessionId: 'session', status: 'active' } });
				if (path.endsWith('/heartbeat')) return new Promise<ReturnType<typeof response>>(resolve => { complete = resolve; });
				return response({ sessionId: 'session', status: 'active', expiresAt: new Date(Date.now() + 1200000).toISOString() });
			});
			const integration = new BrowserIntegration(worker), a = claims(); await integration.handle(a); await integration.handle(claims('join', '2', a.activityId));
			const heartbeat = integration.handle(claims('heartbeat', '2', a.activityId));
			await integration.handle(claims('revoke-member', '1', a.activityId)); await integration.handle(claims('join', '2', a.activityId));
			complete(response({ collaboration: { membershipExpiresAt: Date.now() + 600000 } })); await heartbeat;
			await vi.advanceTimersByTimeAsync(2001); await integration.handle(claims('join', '2', a.activityId));
			expect(accepted).toBe(3);
		} finally { vi.useRealTimers(); }
	});
	it('shorter signed lifetime tolerates measured positive clock skew without relaxing expiry, replay or restart checks', () => {
		vi.useFakeTimers();
		try {
			const auth = new IntegrationAuth(key);
			vi.advanceTimersByTime(5000);
			const fullLifetime = { ...claims(), exp: Date.now() + 10008 };
			expect(() => auth.verify(signed(fullLifetime))).toThrow('UNAUTHORIZED');
			const bounded = { ...claims(), exp: Date.now() + 8008 }, token = signed(bounded);
			expect(auth.verify(token).exp).toBe(bounded.exp);
			expect(() => auth.verify(token)).toThrow('UNAUTHORIZED');
			expect(() => new IntegrationAuth(key).verify(signed({ ...claims(), exp: Date.now() + 8000 }))).toThrow('UNAUTHORIZED');
			vi.advanceTimersByTime(8009);
			expect(() => auth.verify(signed(bounded))).toThrow('UNAUTHORIZED');
		} finally { vi.useRealTimers(); }
	});
	it('an in-flight heartbeat cannot renew or acknowledge an activity after sweep starts deleting it', async () => {
		vi.useFakeTimers();
		try {
			let complete!: (value: ReturnType<typeof response>) => void;
			let deleted!: () => void;
			const worker = vi.fn(async (method: string) => {
				if (method === 'GET') return new Promise<ReturnType<typeof response>>(resolve => { complete = resolve; });
				if (method === 'DELETE') return new Promise<ReturnType<typeof response>>(resolve => { deleted = () => resolve(response({}, 204)); });
				return response({ sessionId: 'session', status: 'active' });
			});
			const integration = new BrowserIntegration(worker), a = claims();
			await integration.handle(a);
			const heartbeat = integration.handle(claims('keepalive', '1', a.activityId));
			const rejected = expect(heartbeat).rejects.toThrow('ACTIVITY_ENDED');
			await vi.advanceTimersByTimeAsync(6001);
			const sweeping = integration.sweep();
			complete(response({ status: 'active' }));
			await rejected;
			await expect(integration.handle(claims('state', '1', a.activityId))).rejects.toThrow('ACTIVITY_ENDED');
			deleted(); await sweeping;
		} finally { vi.useRealTimers(); }
	});
	it.each([404, 410])('expired registry converges after Worker reports DELETE %s', async status => {
		vi.useFakeTimers();
		try {
			const worker = vi.fn(async (method: string) => method === 'DELETE' ? response({}, status) : response({ sessionId: 'session', status: 'active' }));
			const integration = new BrowserIntegration(worker), old = claims();
			await integration.handle(old);
			await vi.advanceTimersByTimeAsync(6001);
			await integration.sweep();
			await integration.handle(claims());
			await expect(integration.handle(claims('state', '1', old.activityId))).rejects.toThrow('ACTIVITY_ENDED');
		} finally { vi.useRealTimers(); }
	});
	it.each([404, 410])('owner close converges after Worker reports DELETE %s', async status => {
		const worker = vi.fn(async (method: string) => method === 'DELETE' ? response({}, status) : response({ sessionId: 'session', status: 'active' }));
		const integration = new BrowserIntegration(worker), old = claims();
		await integration.handle(old);
		const closed = await integration.handle(claims('close', '1', old.activityId));
		expect(JSON.parse(closed.data.toString())).toEqual({ status: 'closed' });
		await integration.handle(claims());
	});
	it.each(['503', 'timeout'])('cleanup retains the registry on %s until confirmed retry', async failure => {
		vi.useFakeTimers();
		try {
			let unavailable = true;
			const worker = vi.fn(async (method: string) => {
				if (method !== 'DELETE') return response({ sessionId: 'session', status: 'active' });
				if (unavailable && failure === 'timeout') throw Error('WORKER_TIMEOUT');
				return response({}, unavailable ? 503 : 204);
			});
			const integration = new BrowserIntegration(worker), old = claims();
			await integration.handle(old);
			await expect(integration.handle(claims('close', '1', old.activityId))).rejects.toThrow();
			await expect(integration.handle(claims())).rejects.toThrow('ACTIVITY_BUSY');
			await vi.advanceTimersByTimeAsync(6001);
			await expect(integration.sweep()).rejects.toThrow();
			await expect(integration.handle(claims())).rejects.toThrow('ACTIVITY_BUSY');
			unavailable = false;
			await integration.sweep();
			await integration.handle(claims());
		} finally { vi.useRealTimers(); }
	});
	it('rejects assertions minted before an API restart, even when their signature has not expired', () => {
		vi.useFakeTimers();
		try {
			const token = signed(claims());
			vi.advanceTimersByTime(1);
			expect(() => new IntegrationAuth(key).verify(token)).toThrow('UNAUTHORIZED');
		} finally { vi.useRealTimers(); }
	});
	it('guest flood cannot consume owner revoke or watchdog budget', () => {
		const auth = new IntegrationAuth(key);
		for (let i = 0; i < 30; i++) auth.verify(signed(claims('input', '2')));
		expect(() => auth.verify(signed(claims('input', '2')))).toThrow('RATE_LIMIT');
		expect(auth.verify(signed(claims('control/revoke', '1'))).subject).toBe('1');
		expect(auth.verify(signed(claims('keepalive', '1'))).op).toBe('keepalive');
	});
	it('rejects forgery, replay, wrong audience, expiry, future lifetime and spoofed subject', () => {
		const auth = new IntegrationAuth(key), c = claims(), token = signed(c);
		expect(auth.verify(token).subject).toBe('1');
		expect(() => auth.verify(token)).toThrow('UNAUTHORIZED');
		expect(() => auth.verify(`${token}x`)).toThrow('UNAUTHORIZED');
		for (const invalid of [{ ...claims(), aud: 'other' }, { ...claims(), exp: Date.now() }, { ...claims(), exp: Date.now() + 30000 }, { ...claims(), subject: 'owner' }]) expect(() => auth.verify(signed(invalid as Assertion))).toThrow('UNAUTHORIZED');
	});
	it('keeps guest credentials private, rejects guest DELETE and old Activity, and tears down on Core lease loss', async () => {
		vi.useFakeTimers();
		try {
			const worker = vi.fn(async (method: string, path: string, _body?: unknown, _credentials?: Record<string, string>) => {
				if (method === 'DELETE') return response({}, 204);
				if (path.endsWith('/invite')) return response({ invite: 'invite', epoch: 'epoch' });
				if (path.endsWith('/accept')) return response({ token: 'private-guest-token', session: { sessionId: 'session', status: 'active' } });
				return response({ sessionId: 'session', status: 'active' });
			});
			const integration = new BrowserIntegration(worker), a = claims();
			await integration.handle(a);
			await expect(integration.handle(claims('media', '2', a.activityId))).rejects.toThrow('ACCESS_DENIED');
			const joined = await integration.handle(claims('join', '2', a.activityId));
			expect(joined.data.toString()).not.toContain('private-guest-token');
			expect(worker.mock.calls.find(c => c[1].endsWith('/invite'))?.[3]).toEqual({ 'x-browser-owner': '1', 'x-browser-watchdog': '1' });
			await integration.handle(claims('media', '2', a.activityId));
			expect(worker.mock.calls.at(-1)?.[3]).toMatchObject({ 'x-browser-guest': 'private-guest-token' });
			await expect(integration.handle(claims('close', '2', a.activityId))).rejects.toThrow('ACCESS_DENIED');
			await expect(integration.handle(claims('state', '1'))).rejects.toThrow('ACTIVITY_ENDED');
			await integration.handle(claims('leave', '2', a.activityId));
			await expect(integration.handle(claims('media', '2', a.activityId))).rejects.toThrow('ACCESS_DENIED');
			await integration.handle(claims('join', '2', a.activityId));
			await integration.handle(claims('revoke-member', '1', a.activityId));
			await expect(integration.handle(claims('heartbeat', '2', a.activityId))).rejects.toThrow('ACCESS_DENIED');
			await vi.advanceTimersByTimeAsync(6001); await integration.sweep();
			expect(worker.mock.calls.at(-1)?.slice(0, 2)).toEqual(['DELETE', '/sessions/session']);
			await expect(integration.handle(claims('state', '1', a.activityId))).rejects.toThrow('ACTIVITY_ENDED');
		} finally { vi.useRealTimers(); }
	});
	it('does not keep owner presence alive when Core reconciles', async () => {
		const worker = vi.fn(async (_method: string, _path: string, _body?: unknown, _credentials?: Record<string, string>) => response({ sessionId: 'session', status: 'active' }));
		const integration = new BrowserIntegration(worker), a = claims();
		await integration.handle(a); await integration.handle(claims('keepalive', '1', a.activityId));
		expect(worker.mock.calls.at(-1)?.[3]).toEqual({ 'x-browser-owner': '1', 'x-browser-watchdog': '1' });
	});
	it('expired private guest credential is replaced only through a new trusted join', async () => {
		vi.useFakeTimers();
		try {
			const worker = vi.fn(async (_method: string, path: string, _body?: unknown, _credentials?: Record<string, string>) => {
				if (path.endsWith('/invite')) return response({ invite: 'invite', epoch: 'epoch' });
				if (path.endsWith('/accept')) return response({ token: 'private-token', expiresAt: Date.now() + 2000, session: { sessionId: 'session', status: 'active' } });
				return response({ sessionId: 'session', status: 'active' });
			});
			const integration = new BrowserIntegration(worker), a = claims();
			await integration.handle(a); await integration.handle(claims('join', '2', a.activityId));
			await vi.advanceTimersByTimeAsync(2001);
			await integration.handle(claims('join', '2', a.activityId));
			expect(worker.mock.calls.filter(c => c[1].endsWith('/accept'))).toHaveLength(2);
			expect(worker.mock.calls.find(c => c[0] === 'DELETE')?.slice(1)).toEqual(['/sessions/session/guest', undefined, { 'x-browser-owner': '1', 'x-browser-watchdog': '1' }]);
		} finally { vi.useRealTimers(); }
	});
});

it('routes activities to isolated workers and refuses capacity exhaustion', async () => {
	const first = vi.fn(async () => response({ sessionId: 'first', status: 'active' }));
	const second = vi.fn(async () => response({ sessionId: 'second', status: 'active' }));
	const pool = new BrowserPool([first, second]), a = claims(), b = claims();
	await pool.handle(a); await pool.handle(b);
	await expect(pool.handle(claims())).rejects.toThrow('SESSION_LIMIT');
	await pool.handle(claims('state', '1', b.activityId));
	expect(second.mock.calls.length).toBe(2);
	expect(first.mock.calls.length).toBe(1);
	await expect(pool.handle(claims('state', '2', b.activityId))).rejects.toThrow('ACCESS_DENIED');
	await pool.handle(claims('close', '1', a.activityId));
	await pool.handle(claims('state', '1', b.activityId));
	expect(second.mock.calls.length).toBe(3);
});

it('reserves distinct slots before concurrent creates and fences each route to its owner', async () => {
	const firstWorker = vi.fn(async (_method: string, _path: string) => response({ sessionId: 'first-session', status: 'active' }));
	const secondWorker = vi.fn(async (_method: string, _path: string) => response({ sessionId: 'second-session', status: 'active' }));
	const pool = new BrowserPool([firstWorker, secondWorker]);
	const firstActivity = claims('create', '1'), secondActivity = claims('create', '2');
	const [first, second] = await Promise.all([pool.handle(firstActivity), pool.handle(secondActivity)]);
	expect(JSON.parse(first.data.toString()).sessionId).toBe('first-session');
	expect(JSON.parse(second.data.toString()).sessionId).toBe('second-session');
	await pool.handle(claims('state', '1', firstActivity.activityId));
	await pool.handle(claims('state', '2', secondActivity.activityId));
	expect(firstWorker.mock.calls.map(call => call[1])).toEqual(['/sessions', '/sessions/first-session']);
	expect(secondWorker.mock.calls.map(call => call[1])).toEqual(['/sessions', '/sessions/second-session']);
	await expect(pool.handle(claims('state', '2', firstActivity.activityId))).rejects.toThrow('ACCESS_DENIED');
	await expect(pool.handle(claims('state', '1', secondActivity.activityId))).rejects.toThrow('ACCESS_DENIED');
});

it('reports ready only when every configured Worker socket satisfies its readiness contract', async () => {
	const ready = () => response({ status: 'ready' });
	const first = vi.fn(async () => ready());
	const unavailable = vi.fn(async () => response({ status: 'not_ready' }, 503));
	const pool = new BrowserPool([first, unavailable]);
	await expect(pool.ready()).resolves.toBe(false);
	expect(first).toHaveBeenCalledWith('GET', '/ready');
	expect(unavailable).toHaveBeenCalledWith('GET', '/ready');
	unavailable.mockImplementation(async () => ready());
	await expect(pool.ready()).resolves.toBe(true);
});

it('shares concurrent duplicate creates and reclaims an uncertain create only after worker cleanup', async () => {
	let rejectCreate = true;
	const worker = vi.fn(async (method: string) => {
		if (method === 'POST' && rejectCreate) { rejectCreate = false; throw Error('WORKER_TIMEOUT'); }
		return method === 'DELETE' ? response({}, 204) : response({ sessionId: 'recovered', status: 'active' });
	});
	const pool = new BrowserPool([worker]), activity = claims();
	await expect(pool.handle(activity)).rejects.toThrow('WORKER_TIMEOUT');
	await expect(pool.handle({ ...activity, nonce: randomUUID() })).rejects.toThrow('ACTIVITY_BUSY');
	await pool.sweep();
	await expect(pool.handle(claims())).resolves.toMatchObject({ status: 200 });
	expect(worker.mock.calls.map(call => call[0])).toEqual(['POST', 'DELETE', 'POST']);
});

it('releases a slot only after its Core lease cleanup succeeds', async () => {
	vi.useFakeTimers();
	try {
		const worker = vi.fn(async (method: string) => method === 'DELETE' ? response({}, 204) : response({ sessionId: 'reused', status: 'active' }));
		const pool = new BrowserPool([worker]), first = claims();
		await pool.handle(first);
		await vi.advanceTimersByTimeAsync(6001);
		await pool.sweep();
		const next = await pool.handle(claims());
		expect(JSON.parse(next.data.toString()).sessionId).toBe('reused');
		expect(worker.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(2);
	} finally { vi.useRealTimers(); }
});

it('does not overlap expired-session cleanup and retries a failed cleanup', async () => {
	vi.useFakeTimers();
	try {
		let rejectDelete!: (e: Error) => void;
		const worker = vi.fn(async (method: string) => method === 'DELETE'
			? new Promise<ReturnType<typeof response>>((_, reject) => { rejectDelete = reject; })
			: response({ sessionId: 'session', status: 'active' }));
		const integration = new BrowserIntegration(worker);
		await integration.handle(claims());
		await vi.advanceTimersByTimeAsync(6001);
		const first = integration.sweep();
		const failed = expect(first).rejects.toThrow('WORKER_TIMEOUT');
		await integration.sweep();
		expect(worker.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(1);
		rejectDelete(Error('WORKER_TIMEOUT')); await failed;
		worker.mockImplementation(async () => response({}, 204));
		await integration.sweep();
		expect(integration.empty).toBe(true);
		expect(worker.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(2);
	} finally { vi.useRealTimers(); }
});

it('keeps a crashed Worker slot reserved until its restarted process confirms the old session is gone', async () => {
	vi.useFakeTimers();
	try {
		let restarted = false, created = 0;
		const worker = vi.fn(async (method: string) => {
			if (method === 'DELETE') return restarted ? response({}, 404) : response({ error: { code: 'WORKER_UNAVAILABLE' } }, 503);
			return response({ sessionId: `session-${++created}`, status: 'active' });
		});
		const pool = new BrowserPool([worker]), first = claims();
		await pool.handle(first);
		await vi.advanceTimersByTimeAsync(6001);
		await pool.sweep();
		await expect(pool.handle(claims())).rejects.toThrow('SESSION_LIMIT');
		restarted = true;
		await pool.sweep();
		await expect(pool.handle(claims())).resolves.toMatchObject({ status: 200 });
		expect(worker.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(2);
	} finally { vi.useRealTimers(); }
});

it('keeps a slot reserved while its real Worker create is still starting', async () => {
	let complete!: (value: ReturnType<typeof response>) => void;
	let firstCreate = true;
	const worker = vi.fn(async (method: string) => {
		if (method === 'POST' && firstCreate) { firstCreate = false; return new Promise<ReturnType<typeof response>>(resolve => { complete = resolve; }); }
		return method === 'DELETE' ? response({}, 204) : response({ sessionId: 'reused', status: 'active' });
	});
	const pool = new BrowserPool([worker]), first = claims();
	const creating = pool.handle(first);
	await vi.waitFor(() => expect(worker).toHaveBeenCalledTimes(1));
	await pool.sweep();
	await expect(pool.handle(claims())).rejects.toThrow('SESSION_LIMIT');
	complete(response({ sessionId: 'started', status: 'active' }));
	await creating;
	await pool.handle(claims('close', '1', first.activityId));
	expect(JSON.parse((await pool.handle(claims())).data.toString()).sessionId).toBe('reused');
});
