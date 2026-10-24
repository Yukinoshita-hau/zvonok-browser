import { test } from 'vitest';
import assert from 'node:assert/strict';
import { submitAudio } from './audio-submit.mjs';

test('late native completion drops the frame and holds admission until completion', async () => {
  let complete, clears=0, stalls=0, finished=false;
  const source={captureFrame:()=>new Promise(resolve=>{complete=resolve;}),clearQueue:()=>clears++};
  const task=submitAudio(source,{},()=>stalls++,5,200).then(result=>{finished=true;return result;});
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(stalls,1);assert.equal(finished,false);
  complete();assert.equal(await task,false);assert.equal(clears,2);
});
test('healthy submission succeeds and a permanently stalled source still fails closed', async () => {
  const source={captureFrame:async()=>{},clearQueue:()=>{}};
  assert.equal(await submitAudio(source,{},()=>assert.fail('unexpected stall'),5,30),true);
  source.captureFrame=()=>new Promise(()=>{});
  await assert.rejects(submitAudio(source,{},()=>{},5,30),/AUDIO_SUBMIT_TIMEOUT/);
});
test('native queue errors during recovery reject the submission', async () => {
  await assert.rejects(submitAudio({captureFrame:()=>new Promise(()=>{}),clearQueue:()=>{throw Error('source closed');}}, {}, ()=>{}, 5, 30), /source closed/);
});
