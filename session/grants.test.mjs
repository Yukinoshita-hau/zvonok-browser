import {it,expect} from 'vitest';
import {publisherGrant} from './grants.mjs';
it('publisher allows only camera and browser audio; viewers cannot publish media or data',()=>{
  const sources={CAMERA:1,MICROPHONE:2,SCREEN_SHARE:3,SCREEN_SHARE_AUDIO:4};
  const p=publisherGrant(true,'epoch-room',sources),v=publisherGrant(false,'epoch-room',sources);
  expect(p.canPublishSources).toEqual([1,4]);
  for(const source of [sources.MICROPHONE,sources.SCREEN_SHARE])expect(p.canPublishSources.includes(source)).toBe(false);
  expect(p.canPublishData).toBe(false);expect(p.canSubscribe).toBe(false);
  expect(v).toEqual({roomJoin:true,room:'epoch-room',canPublish:false,canSubscribe:true,canPublishData:false});
  expect(p).not.toHaveProperty('roomAdmin');
});
