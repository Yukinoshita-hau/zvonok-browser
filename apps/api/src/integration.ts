import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BrowserSession } from '@browser/protocol';

export interface Assertion {
	aud: 'zvonok-browser'; exp: number; nonce: string; activityId: string; subject: string;
	op: string; body: unknown; epoch: string; generation: string;
}
export class IntegrationAuth {
	private startedAt = Date.now();
	private seen = new Map<string, number>();
	private windows = new Map<string, { start: number; count: number }>();
	constructor(private key: string) { if (key.length < 43) throw Error('Integration key too short'); }
	verify(value: string): Assertion {
		if (typeof value !== 'string' || value.length > 24000) throw Error('UNAUTHORIZED');
		const [payload, signature, extra] = value.split('.');
		const expected = createHmac('sha256', this.key).update(payload ?? '').digest();
		const supplied = Buffer.from(signature ?? '', 'base64url');
		if (extra || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw Error('UNAUTHORIZED');
		let c: Assertion;
		try { c = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Assertion; } catch { throw Error('UNAUTHORIZED'); }
		const now = Date.now();
		if (Number.isSafeInteger(c?.exp) && (c.exp <= now || c.exp > now + 10000 || c.exp - 10000 < this.startedAt))
			console.log(JSON.stringify({ kind: 'assertion-clock-rejected', at: now, monoMs: performance.now(), pid: process.pid, remainingMs: c.exp - now, mintedAfterStartMs: c.exp - 10000 - this.startedAt }));
		for (const [nonce, expiry] of this.seen) if (expiry <= now) this.seen.delete(nonce);
		if (!c || c.aud !== 'zvonok-browser' || !Number.isSafeInteger(c.exp) || c.exp <= now || c.exp > now + 10000 || c.exp - 10000 < this.startedAt
			|| !/^[0-9a-f-]{36}$/.test(c.nonce) || !/^[0-9a-f-]{36}$/.test(c.activityId)
			|| !/^[1-9][0-9]{0,18}$/.test(c.subject) || this.seen.has(c.nonce) || this.seen.size >= 2048) throw Error('UNAUTHORIZED');
		for (const [id, window] of this.windows) if (now - window.start >= 1000) this.windows.delete(id);
		// Independent principal budgets preserve owner revoke and Core watchdog under a guest input flood.
		const bucket = `${c.subject}:${c.op === 'keepalive' ? 'watchdog' : 'user'}`;
		let window = this.windows.get(bucket);
		if (!window) {
			if (this.windows.size >= 64) throw Error('RATE_LIMIT');
			window = { start: now, count: 0 }; this.windows.set(bucket, window);
		}
		if (++window.count > 30) throw Error('RATE_LIMIT');
		this.seen.set(c.nonce, c.exp);
		return c;
	}
}
type Credentials = Record<string, string>;
export interface WorkerResponse { status: number; type: string; data: Buffer }
type Worker = (method: string, path: string, body?: unknown, credentials?: Credentials) => Promise<WorkerResponse>;
const owner = { 'x-browser-owner': '1' };
const watchdog = { ...owner, 'x-browser-watchdog': '1' };
const result = (data: unknown): WorkerResponse => ({ status: 200, type: 'application/json', data: Buffer.from(JSON.stringify(data)) });
const json = (r: WorkerResponse) => {
	if (r.status >= 400) {
		let code = 'UNKNOWN';
		try { code = JSON.parse(r.data.toString()).error?.code ?? code; } catch { }
		throw Error(`WORKER_${String(code).replace(/[^A-Z0-9_]/g, '').slice(0, 48)}`);
	}
	return r.data.length ? JSON.parse(r.data.toString()) : { status: 'closed' };
};

// shortcut: one volatile registry matches the single local Worker; use a durable allocator before multiple Core/API replicas.
export class BrowserIntegration {
	get empty() { return !this.current && !this.uncertainSessionId; }
	private current?: { id: string; owner: string; session: BrowserSession; guest?: { subject: string; token: string; expiresAt: number }; lease: number; closing?: boolean };
	private uncertainSessionId?: string;
	private tail: Promise<unknown> = Promise.resolve();
	private sweeping = false;
	constructor(private worker: Worker) { }
	async ready() {
		try {
			const response = await this.worker('GET', '/ready');
			return response.status === 200 && JSON.parse(response.data.toString()).status === 'ready';
		} catch { return false; }
	}
	async sweep() {
		if (this.sweeping) return;
		this.sweeping = true;
		try {
			if (this.uncertainSessionId) {
				const sessionId = this.uncertainSessionId;
				const response = await this.worker('DELETE', `/sessions/${sessionId}`, undefined, owner);
				if (response.status !== 404 && response.status !== 410) json(response);
				if (this.uncertainSessionId === sessionId) this.uncertainSessionId = undefined;
			}
			const a = this.current;
			if (!a || Date.now() < a.lease) return;
			a.closing = true;
			console.log(JSON.stringify({ kind: 'activity-expired', at: Date.now(), activityId: a.id, sessionId: a.session.sessionId, leaseUntil: a.lease, reason: 'core-lease-expired' }));
			const response = await this.worker('DELETE', `/sessions/${a.session.sessionId}`, undefined, owner);
			if (response.status !== 404 && response.status !== 410) json(response);
			if (this.current === a) this.current = undefined;
		} finally { this.sweeping = false; }
	}
	handle(c: Assertion): Promise<WorkerResponse> {
		if (['create', 'join', 'leave', 'close', 'revoke-member'].includes(c.op)) {
			const next = this.tail.then(() => this.execute(c));
			this.tail = next.catch(() => { }); return next;
		}
		return this.execute(c);
	}
	private async execute(c: Assertion): Promise<WorkerResponse> {
		if (Date.now() >= c.exp) throw Error('UNAUTHORIZED');
		if (c.op === 'create') {
			if (this.current?.id === c.activityId && this.current.owner === c.subject)
				return result(this.current.session);
			if (this.current) throw Error('ACTIVITY_BUSY');
			let session: BrowserSession;
			try { session = json(await this.worker('POST', '/sessions', {}, { ...owner, 'x-browser-session-id': c.activityId })) as BrowserSession; }
			catch (error) { this.uncertainSessionId = c.activityId; throw error; }
			this.current = { id: c.activityId, owner: c.subject, session, lease: Date.now() + 6000 };
			return result(session);
		}
		const a = this.current;
		if (!a && c.op === 'close') return result({ status: 'closed' });
		if (!a || c.activityId !== a.id || (c.op !== 'close' && (a.closing || Date.now() >= a.lease))) throw Error('ACTIVITY_ENDED');
		const root = `/sessions/${a.session.sessionId}`;
		const isOwner = c.subject === a.owner;
		if (c.op === 'keepalive') {
			if (!isOwner) throw Error('ACCESS_DENIED');
			const session = json(await this.worker('GET', root, undefined, watchdog));
			if (this.current !== a || a.closing || Date.now() >= a.lease || session.status !== 'active') throw Error('ACTIVITY_ENDED');
			a.lease = Date.now() + 6000;
			console.log(JSON.stringify({ kind: 'activity-renewed', at: Date.now(), activityId: a.id, sessionId: a.session.sessionId, leaseUntil: a.lease, epoch: a.session.media?.epoch }));
			return result({ status: 'alive' });
		}
		if (c.op === 'join' && !isOwner && a.guest && Date.now() >= a.guest.expiresAt) {
			json(await this.worker('DELETE', `${root}/guest`, undefined, watchdog)); a.guest = undefined;
		}
		if (c.op === 'join' && !isOwner && !a.guest) {
			const invite = json(await this.worker('POST', `${root}/invite`, {}, watchdog));
			const accepted = json(await this.worker('POST', `${root}/accept`, { invite: invite.invite, epoch: invite.epoch }, {}));
			a.guest = { subject: c.subject, token: accepted.token, expiresAt: accepted.expiresAt };
			return result(accepted.session);
		}
		if (c.op === 'revoke-member') {
			if (!isOwner) throw Error('ACCESS_DENIED');
			if (a.guest) { json(await this.worker('DELETE', `${root}/guest`, undefined, watchdog)); a.guest = undefined; }
			return result({ status: 'revoked' });
		}
		if (!isOwner && a.guest?.subject !== c.subject) throw Error('ACCESS_DENIED');
		const credentials: Credentials = isOwner ? { ...owner } : { 'x-browser-guest': a.guest!.token };
		credentials['x-control-epoch'] = c.epoch;
		credentials['x-control-generation'] = c.generation;
		if (c.op === 'close') {
			if (!isOwner) throw Error('ACCESS_DENIED');
			a.closing = true;
			let response = await this.worker('DELETE', root, undefined, credentials);
			if (response.status === 404 || response.status === 410) response = result({ status: 'closed' });
			json(response); if (this.current === a) this.current = undefined; return response;
		}
		if (c.op === 'leave') {
			if (isOwner) throw Error('ACCESS_DENIED');
			const response = await this.worker('POST', `${root}/leave`, {}, credentials);
			json(response); a.guest = undefined; return response;
		}
		if (c.op === 'state' || c.op === 'join') return this.worker('GET', root, undefined, credentials);
		if (!['media', 'heartbeat', 'navigate', 'input', 'back', 'forward', 'reload', 'quality', 'tabs/create', 'tabs/activate', 'tabs/close', 'control/request', 'control/grant', 'control/decline', 'control/revoke', 'control/release'].includes(c.op)) throw Error('ACCESS_DENIED');
		if (c.op === 'tabs/create') return this.worker('POST', `${root}/tabs`, {}, credentials);
		if (c.op === 'tabs/activate' || c.op === 'tabs/close') {
			const tabId = (c.body as { tabId?: unknown })?.tabId;
			if (typeof tabId !== 'string' || !/^[0-9a-f-]{36}$/.test(tabId)) throw Error('ACCESS_DENIED');
			return this.worker('POST', `${root}/tabs/${encodeURIComponent(tabId)}/${c.op.endsWith('close') ? 'close' : 'activate'}`, {}, credentials);
		}
		if (c.op === 'heartbeat' && !isOwner) {
			const guest = a.guest!;
			credentials['x-browser-renew-member'] = '1';
			const response = await this.worker('POST', `${root}/heartbeat`, c.body, credentials);
			if (response.status < 400 && this.current === a && !a.closing && a.guest === guest) {
				const expiresAt = json(response).collaboration?.membershipExpiresAt;
				if (Number.isFinite(expiresAt)) {
					const next = Math.max(guest.expiresAt, Math.min(expiresAt, Date.parse(a.session.expiresAt)));
					if (Math.floor(next / 60000) > Math.floor(guest.expiresAt / 60000)) console.log(JSON.stringify({ kind: 'membership-renewed', at: Date.now(), pid: process.pid, activityId: a.id, sessionId: a.session.sessionId, epoch: c.epoch, generation: c.generation, previousExpiresAt: guest.expiresAt, expiresAt: next, reason: 'Core-authorized-heartbeat' }));
					guest.expiresAt = next;
				}
			}
			return response;
		}
		return this.worker('POST', `${root}/${c.op}`, c.body, credentials);
	}
}

// Each slot owns a separate Worker/Surface/Publisher IPC namespace.
export class BrowserPool {
	private routes = new Map<string, number>();
	private occupied = new Set<number>();
	private quarantined = new Set<number>();
	private creating = new Set<number>();
	private slots: BrowserIntegration[];
	constructor(workers: Worker[]) {
		if (!workers.length || workers.length > 16) throw Error('INVALID_WORKER_POOL');
		this.slots = workers.map(worker => new BrowserIntegration(worker));
	}
	async ready() { return (await Promise.all(this.slots.map(slot => slot.ready()))).every(Boolean); }
	async handle(c: Assertion): Promise<WorkerResponse> {
		let slot = this.routes.get(c.activityId);
		if (c.op === 'create') {
			if (slot === undefined) {
				slot = this.slots.findIndex((_, index) => !this.occupied.has(index));
				if (slot < 0) throw Error('SESSION_LIMIT');
				this.routes.set(c.activityId, slot); this.occupied.add(slot);
			}
			if (this.quarantined.has(slot)) throw Error('ACTIVITY_BUSY');
			this.creating.add(slot);
			try {
				const response = await this.slots[slot].handle(c);
				if (response.status >= 400) this.quarantined.add(slot);
				return response;
			} catch (error) {
				// A lost create response leaves runtime ownership unknown; retain the slot until operator recovery.
				this.quarantined.add(slot);
				throw error;
			} finally { this.creating.delete(slot); }
		}
		if (slot === undefined) {
			if (c.op === 'close') return result({ status: 'closed' });
			throw Error('ACTIVITY_ENDED');
		}
		const response = await this.slots[slot].handle(c);
		if (c.op === 'close' && this.slots[slot].empty) {
			this.routes.delete(c.activityId); this.occupied.delete(slot);
		}
		return response;
	}
	async sweep() {
		await Promise.allSettled(this.slots.map(slot => slot.sweep()));
		for (const [activityId, slot] of this.routes) {
			if (this.slots[slot].empty && !this.creating.has(slot)) {
				this.quarantined.delete(slot);
				this.routes.delete(activityId);
				this.occupied.delete(slot);
			}
		}
	}
}
