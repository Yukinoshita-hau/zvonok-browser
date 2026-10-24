// PCM v1: magic(4), rate u32, channels u16, samples/channel u16,
// sequence u64, Linux capture-availability wall ms f64, then S16LE interleaved stereo.
export const AUDIO_BYTES=1920, AUDIO_HEADER=28;
export function validAudio(b,lastSequence,now=Date.now()) {
  return b.length===AUDIO_HEADER+AUDIO_BYTES && b.toString('ascii',0,4)==='PCM1' &&
    b.readUInt32LE(4)===48000 && b.readUInt16LE(8)===2 && b.readUInt16LE(10)===480 &&
    b.readBigUInt64LE(12)>lastSequence && Number.isFinite(b.readDoubleLE(20)) &&
    Math.abs(now-b.readDoubleLE(20))<=200;
}
