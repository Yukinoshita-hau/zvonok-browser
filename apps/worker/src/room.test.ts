import {afterEach, expect, it, vi} from 'vitest';
import {SharedRoom, OWNER} from './room.js';
afterEach(()=>vi.useRealTimers());
function setup() {
  const r=new SharedRoom(crypto.randomUUID(),crypto.randomUUID(),Date.now()+1200000);
  const invite=r.issue(OWNER), auth=r.accept(invite.invite,r.epoch);
  return {r,invite,auth,id:auth.identity};
}
it('one session/epoch-bound single-use invite; separate guest cannot forge owner',()=>{
  const {r,invite,auth,id}=setup();
  expect(id).not.toBe(OWNER);expect(r.member(false,auth.token)).toBe(id);
  expect(()=>r.member(false,'local-owner')).toThrow();
  expect(()=>r.accept(invite.invite,r.epoch)).toThrow('INVITE_REJECTED');
  expect(()=>r.issue(id)).toThrow();expect(()=>r.owner(id)).toThrow();
  expect(()=>r.fence(id,r.epoch,'1')).toThrow();
  const other=new SharedRoom(r.sessionId,crypto.randomUUID(),Date.now()+60000);
  expect(()=>other.accept(invite.invite,r.epoch)).toThrow();
});
it('media rebind rotates viewer identities while preserving the joined guest and current controller',()=>{
  const {r,id,auth}=setup();r.control(id,'request');r.control(OWNER,'grant');
  const next=r.rebind(crypto.randomUUID());
  expect(next.member(false,auth.token)).toBe(id);
  expect(next.controller).toBe(id);expect(next.generation).toBe(r.generation+1);
  expect(next.identities()).toContain(next.viewer(id));expect(next.identities()).not.toContain(r.viewer(id));
  expect(()=>next.fence(id,r.epoch,String(next.generation))).toThrow('STALE_CONTROL_LEASE');
  next.fence(id,next.epoch,String(next.generation));
});
it('invite revoke/rotation/expiry/wrong capability and strict guest expiry',()=>{
  vi.useFakeTimers();const r=new SharedRoom('s','e',Date.now()+1200000);
  const first=r.issue(OWNER),next=r.issue(OWNER);
  expect(()=>r.accept(first.invite,r.epoch)).toThrow();
  expect(()=>r.accept('x'.repeat(43),r.epoch)).toThrow();
  vi.advanceTimersByTime(60001);expect(()=>r.accept(next.invite,r.epoch)).toThrow();
  const invite=r.issue(OWNER);r.invite=undefined;expect(()=>r.accept(invite.invite,r.epoch)).toThrow();
  const {r:room,auth}=setup();vi.advanceTimersByTime(600001);expect(()=>room.member(false,auth.token)).toThrow();
});
it('request/grant/decline/release/return/revoke; stale generation and old epoch rejected',()=>{
  const {r,id}=setup();r.control(id,'request');expect(()=>r.control(id,'request')).toThrow('REQUEST_PENDING');
  expect(()=>r.control(id,'grant')).toThrow();r.control(OWNER,'decline');expect(r.request).toBeUndefined();
  r.control(id,'request');r.control(OWNER,'grant');expect(r.controller).toBe(id);
  expect(()=>r.fence(OWNER,r.epoch,String(r.generation))).toThrow();
  const generation=String(r.generation);r.fence(id,r.epoch,generation);
  r.control(OWNER,'revoke');expect(()=>r.fence(id,r.epoch,generation)).toThrow();
  expect(()=>r.fence(OWNER,'old',String(r.generation))).toThrow();
  r.control(id,'request');r.control(OWNER,'grant');r.control(id,'release');expect(r.controller).toBe(OWNER);
});
it('queued command rechecks fence after async wait and cannot execute after revoke',async()=>{
  const {r,id}=setup();r.control(id,'request');r.control(OWNER,'grant');const generation=String(r.generation);
  let resume!:()=>void,executed=false;r.fence(id,r.epoch,generation);
  const queued=(async()=>{await new Promise<void>(resolve=>{resume=resolve;});r.fence(id,r.epoch,generation);executed=true;})();
  const assertion=expect(queued).rejects.toThrow('STALE_CONTROL_LEASE');r.control(OWNER,'revoke');resume();await assertion;expect(executed).toBe(false);
});
it('execution fence rejects a guest credential expiring while queued, before cleanup timer runs',()=>{
  const {r,id}=setup();r.control(id,'request');r.control(OWNER,'grant');
  r.guest!.expiresAt=Date.now()-1;
  expect(()=>r.fence(id,r.epoch,String(r.generation))).toThrow('STALE_CONTROL_LEASE');
});
it('terminal guest tombstone explains End but grants no status, media or command access',()=>{
  const {r,auth}=setup();r.close();const generation=r.generation;r.close();
  expect(r.generation).toBe(generation);
  expect(()=>r.member(false,auth.token)).toThrow('SESSION_ENDED');
  expect(()=>r.member(false,'wrong')).toThrow('ACCESS_DENIED');
  expect(r.guest).toBeUndefined();
});
it('fresh Core-authorized heartbeat can renew membership within absolute TTL, while stale, expired and revoked rights cannot',()=>{
  vi.useFakeTimers();const {r,id,auth}=setup();const initial=r.guest!.expiresAt;
  vi.advanceTimersByTime(1000);
  r.heartbeat(id,r.epoch,String(r.generation),true);
  expect(r.guest!.expiresAt).toBe(initial+1000);
  const renewed=r.guest!.expiresAt;
  vi.advanceTimersByTime(1000);r.heartbeat(id,r.epoch,String(r.generation-1),true);
  expect(r.guest!.expiresAt).toBe(renewed);
  r.heartbeat(id,r.epoch,String(r.generation));expect(r.guest!.expiresAt).toBe(renewed);
  r.guest!.expiresAt=Date.now()-1;
  r.heartbeat(id,r.epoch,String(r.generation),true);
  expect(()=>r.member(false,auth.token)).toThrow('ACCESS_DENIED');
  r.remove(OWNER,true);expect(()=>r.heartbeat(id,r.epoch,String(r.generation),true)).toThrow();
  const next=setup();next.r.guest!.expiresAt=next.r.expiresAt;
  next.r.heartbeat(next.id,next.r.epoch,String(next.r.generation),true);
  expect(next.r.guest!.expiresAt).toBeLessThanOrEqual(next.r.expiresAt);
});
it('lease expiry and stale heartbeat cannot restore guest control; guest cannot extend absolute expiry',()=>{
  vi.useFakeTimers();const {r,id}=setup();r.control(id,'request');r.control(OWNER,'grant');const generation=String(r.generation);
  vi.advanceTimersByTime(15001);r.heartbeat(id,r.epoch,generation);expect(r.controller).toBe(OWNER);
  expect(r.snapshot(id).ownerPresent).toBe(false);r.heartbeat(OWNER);expect(r.snapshot(id).ownerPresent).toBe(true);
  expect(()=>r.fence(id,r.epoch,generation)).toThrow();
  r.remove(OWNER,true);expect(r.guest).toBeUndefined();expect(r.controller).toBe(OWNER);
  r.close();expect(()=>r.fence(OWNER,r.epoch,String(r.generation))).toThrow();expect(()=>r.issue(OWNER)).toThrow();
});
