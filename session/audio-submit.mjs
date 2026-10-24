export async function submitAudio(source, frame, stalled, softMs = 200, hardMs = 2000) {
  let timedOut = false, soft, hard;
  try {
    const pending = source.captureFrame(frame);
    await Promise.race([pending, new Promise((_, reject) => {
      soft = setTimeout(() => {
        try { timedOut = true; source.clearQueue(); stalled(); } catch (error) { reject(error); }
      }, softMs);
      hard = setTimeout(() => reject(Error('AUDIO_SUBMIT_TIMEOUT')), hardMs);
    })]);
    // Keep admission busy until the old native callback completes; never overlap submissions.
    if (timedOut) source.clearQueue();
    return !timedOut;
  } finally { clearTimeout(soft); clearTimeout(hard); }
}
