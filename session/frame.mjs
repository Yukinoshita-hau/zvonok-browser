export function validFrame(b,width,height,lastSequence,now=Date.now()) {
  return b.length===width*height*4+24 && b.readUInt32LE(0)===width && b.readUInt32LE(4)===height &&
    Number.isFinite(b.readDoubleLE(16)) && b.readBigUInt64LE(8)>lastSequence && Math.abs(now-b.readDoubleLE(16))<=2000;
}
