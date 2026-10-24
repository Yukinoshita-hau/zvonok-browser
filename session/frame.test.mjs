import {it,expect} from 'vitest';
import {validFrame} from './frame.mjs';
it('fixed RGBA dimensions size timestamp and monotonic sequence',()=>{
 const b=Buffer.alloc(1280*720*4+24);b.writeUInt32LE(1280);b.writeUInt32LE(720,4);b.writeBigUInt64LE(5n,8);b.writeDoubleLE(10000,16);
 expect(validFrame(b,1280,720,4n,10000)).toBe(true);
 expect(validFrame(b,1280,720,5n,10000)).toBe(false);
 expect(validFrame(b,1280,720,6n,10000)).toBe(false);
 expect(validFrame(b,1280,720,4n,13000)).toBe(false);
 expect(validFrame(b,1280,720,4n,7000)).toBe(false);
 expect(validFrame(b.subarray(1),1280,720,4n,10000)).toBe(false);
 b.writeUInt32LE(1279);expect(validFrame(b,1280,720,4n,10000)).toBe(false);
 b.writeUInt32LE(1280);b.writeUInt32LE(719,4);expect(validFrame(b,1280,720,4n,10000)).toBe(false);
 b.writeUInt32LE(720,4);b.writeDoubleLE(NaN,16);expect(validFrame(b,1280,720,4n,10000)).toBe(false);
});
