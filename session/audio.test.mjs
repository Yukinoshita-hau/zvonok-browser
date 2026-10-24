import {it,expect} from 'vitest';
import {validAudio,AUDIO_BYTES,AUDIO_HEADER} from './audio.mjs';
it('rejects malformed, stale, replayed or non-stereo 48k 10ms PCM',()=>{
 const b=Buffer.alloc(AUDIO_HEADER+AUDIO_BYTES);b.write('PCM1');b.writeUInt32LE(48000,4);b.writeUInt16LE(2,8);b.writeUInt16LE(480,10);b.writeBigUInt64LE(1n,12);b.writeDoubleLE(1000,20);
 expect(validAudio(b,0n,1000)).toBe(true);
 expect(validAudio(b,1n,1000)).toBe(false);expect(validAudio(b,0n,1201)).toBe(false);
 expect(validAudio(b.subarray(1),0n,1000)).toBe(false);
 for(const [offset,value]of [[4,44100],[8,1],[10,960]]) {const copy=Buffer.from(b);if(offset===4)copy.writeUInt32LE(value,offset);else copy.writeUInt16LE(value,offset);expect(validAudio(copy,0n,1000)).toBe(false);}
 b.writeDoubleLE(NaN,20);expect(validAudio(b,0n,1000)).toBe(false);
});
