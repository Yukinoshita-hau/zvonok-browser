import { it, expect } from 'vitest';
import { Registry, validBinding, validCoreOrigin } from './broker.mjs';
const sessionId='12345678-1234-1234-1234-123456789012',epoch='abcd1234-1234-1234-1234-123456789012';
const b=()=>({sessionId,epoch,ownerId:'local-owner',expiresAt:new Date(Date.now()+60000).toISOString(),profile:'720p15'});
it('strict binding rejects unknown owner, extra props, expired lease',()=>{
  expect(validBinding(b())).toBe(true);
  expect(validBinding({...b(),ownerId:'other'})).toBe(false);
  expect(validBinding({...b(),room:'arbitrary'})).toBe(false);
  expect(validBinding({...b(),expiresAt:new Date(0).toISOString()})).toBe(false);
  expect(validBinding({...b(),profile:'4k60'})).toBe(false);
});
it('allows exact HTTPS Core origins and only local HTTP origins',()=>{
  expect(validCoreOrigin('https://zvonok.example')).toBe(true);
  expect(validCoreOrigin('https://zvonok.example:8443')).toBe(true);
  expect(validCoreOrigin('http://localhost:3000')).toBe(true);
  expect(validCoreOrigin('http://127.0.0.1:3000')).toBe(true);
  expect(validCoreOrigin('http://zvonok.example')).toBe(false);
  expect(validCoreOrigin('https://zvonok.example/')).toBe(false);
  expect(validCoreOrigin('https://zvonok.example/path')).toBe(false);
});
it('revoke blocks tokens before deleting, refuses next epoch until deletion completes',async()=>{
  let release;const r=new Registry(()=>new Promise(resolve=>{release=resolve;}));
  await r.bind(b());expect(r.alive()).toBeTruthy();
  expect(r.matches({...b(),epoch:crypto.randomUUID()})).toBe(false);
  const closing=r.revoke(b());expect(r.alive()).toBeFalsy();
  await expect(r.bind({...b(),epoch:crypto.randomUUID()})).rejects.toThrow();
  release();await closing;expect(r.current).toBeUndefined();
  await r.bind({...b(),epoch:crypto.randomUUID()});expect(r.matches(b())).toBe(false);
});
it('failed room deletion stays quarantined and can retry',async()=>{
  let fail=true;const r=new Registry(async()=>{if(fail)throw Error('unavailable');});
  await r.bind(b());await expect(r.revoke(b())).rejects.toThrow();expect(r.alive()).toBeFalsy();
  await expect(r.bind(b())).rejects.toThrow();fail=false;await r.revoke(b());expect(r.current).toBeUndefined();
});

it('lost Worker lease prevents authorization before TTL',async()=>{
  const r=new Registry(async()=>{});await r.bind(b());
  r.current.lease=Date.now()-4001;expect(r.alive()).toBeFalsy();
  await r.revoke(b());expect(r.current).toBeUndefined();
});
