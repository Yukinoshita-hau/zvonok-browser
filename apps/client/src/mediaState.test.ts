import {expect,it} from 'vitest';
import {mediaState} from './mediaState';
it('reports observed resolution/FPS degradation without claiming missing stats are zero',()=>{
  expect(mediaState(1280,15)).toBe('streaming');
  expect(mediaState(1280,NaN)).toBe('streaming');
  expect(mediaState(960,15)).toMatch(/^degraded/);
  expect(mediaState(1280,8)).toMatch(/^degraded/);
});
