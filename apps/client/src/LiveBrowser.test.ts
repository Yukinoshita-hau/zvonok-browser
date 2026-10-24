import {expect,it} from 'vitest';
import type {BrowserSession} from '@browser/protocol';
import {applySessionUpdate} from './LiveBrowser';
it('late HTTP responses cannot restore closed sessions, previous epochs or revoked generations',()=>{
  const active={sessionId:'one',status:'active',collaboration:{generation:3}} as BrowserSession;
  expect(applySessionUpdate(active,{...active,collaboration:{...active.collaboration!,generation:2}})).toBe(active);
  const closed={...active,status:'closed' as const};expect(applySessionUpdate(closed,active)).toBe(closed);
  expect(applySessionUpdate(active,{...active,sessionId:'old'})).toBe(active);
  expect(applySessionUpdate(active,closed)).toBe(closed);
});
