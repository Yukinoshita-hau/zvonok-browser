import { useEffect, useRef, useState } from "react";
import { Room, RoomEvent, Track, RemoteVideoTrack } from "livekit-client";
export function MediaViewer({ token }: { token: string }) {
  const video = useRef<HTMLVideoElement>(null),
    roomRef = useRef<Room | undefined>(undefined),
    trackRef = useRef<RemoteVideoTrack | undefined>(undefined);
  const [wanted, setWanted] = useState(false),
    [state, setState] = useState("disconnected"),
    [participant, setParticipant] = useState(""),
    [metrics, setMetrics] = useState<Record<string, unknown>>({});
  useEffect(() => {
    if (!wanted) return;
    let stopped = false,
      retry: ReturnType<typeof setTimeout> | undefined,
      frameCallback = 0,
      first = 0,
      generationMs = 0,
      presentedFrames = 0,
      latencyRejectedFrames = 0;
    const started = performance.now(),
      samples: number[] = [],
      canvas = document.createElement("canvas");
    canvas.width = 600;
    canvas.height = 48;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    function frame() {
      const v = video.current;
      if (!v || stopped) return;
      if (v.videoWidth) {
        if (!first) first = performance.now() - started;
        presentedFrames++;
        context.drawImage(
          v,
          0,
          0,
          (600 * v.videoWidth) / 1280,
          (48 * v.videoHeight) / 720,
          0,
          0,
          600,
          48,
        );
        const p = context.getImageData(0, 0, 600, 48).data;
        let ms = 0;
        for (let i = 0; i < 48; i++)
          if (p[(28 * 600 + 22 + i * 12) * 4] > 128) ms += 2 ** i;
        const age = Date.now() - ms;
        if (age >= 0 && age < 10000) {
          generationMs = ms;
          samples.push(age);
          if (samples.length > 1800) samples.shift();
        } else latencyRejectedFrames++;
      }
      frameCallback = v.requestVideoFrameCallback(frame);
    }
    frameCallback = video.current!.requestVideoFrameCallback(frame);
    async function connect() {
      if (stopped) return;
      const room = new Room({ adaptiveStream: false, dynacast: false });
      roomRef.current = room;
      room.on(RoomEvent.ConnectionStateChanged, (s) => {
        if (!stopped) setState(s);
      });
      room.on(RoomEvent.TrackSubscribed, (t, _p, p) => {
        if (stopped) return;
        if (t.kind === Track.Kind.Video && t instanceof RemoteVideoTrack) {
          trackRef.current = t;
          t.attach(video.current!);
          setParticipant(p.identity);
          void video.current?.play().catch(() => {});
        }
      });
      room.on(RoomEvent.TrackUnsubscribed, (t) => {
        t.detach();
        if (stopped) return;
        trackRef.current = undefined;
        setParticipant("waiting for publisher");
      });
      room.on(RoomEvent.ParticipantConnected, (p) => {
        if (!stopped) setParticipant(p.identity);
      });
      room.on(RoomEvent.Disconnected, () => {
        trackRef.current = undefined;
        if (!stopped) {
          setState("disconnected; retrying");
          retry = setTimeout(() => void connect(), 2000);
        }
      });
      try {
        setState("connecting");
        const response = await fetch("/media/token", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw Error(`Token HTTP ${response.status}`);
        const auth = await response.json();
        if (stopped) return;
        await room.connect(auth.url, auth.token, {
          rtcConfig: { iceTransportPolicy: "all", iceServers: [] },
        });
        if (stopped) await room.disconnect();
      } catch (e) {
        await room.disconnect();
        if (!stopped) {
          setState(String(e));
          clearTimeout(retry);
          retry = setTimeout(() => void connect(), 3000);
        }
      }
    }
    void connect();
    const timer = setInterval(async () => {
      const t = trackRef.current;
      if (!t) return;
      const report = await t.getRTCStatsReport().catch(() => undefined);
      if (stopped || t !== trackRef.current) return;
      const sorted = [...samples].sort((a, b) => a - b);
      report?.forEach((s) => {
        if (s.type === "inbound-rtp" && s.kind === "video") {
          const codec = report.get(s.codecId);
          const data = {
            participant: roomRef.current?.remoteParticipants.size,
            decodedFps: s.framesPerSecond,
            framesReceived: s.framesReceived,
            width: s.frameWidth,
            height: s.frameHeight,
            framesDecoded: s.framesDecoded,
            framesDropped: s.framesDropped,
            codec: codec?.mimeType,
            firstFrameMs: Math.round(first),
            generationMs,
            presentedFrames,
            latencyRejectedFrames,
            latencySamples: sorted.length,
            latencyP50Ms: sorted[Math.floor(sorted.length * 0.5)],
            latencyP95Ms: sorted[Math.floor(sorted.length * 0.95)],
            totalDecodeTime: s.totalDecodeTime,
            jitter: s.jitter,
          };
          setMetrics(data);
          (window as unknown as { mediaMetrics: unknown }).mediaMetrics = data;
        }
      });
    }, 1000);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(timer);
      video.current?.cancelVideoFrameCallback(frameCallback);
      trackRef.current?.detach();
      trackRef.current = undefined;
      void roomRef.current?.disconnect();
      roomRef.current = undefined;
      setState("disconnected");
      setParticipant("");
    };
  }, [wanted, token]);
  return (
    <section>
      <h2>Slice 2A · LiveKit generated video</h2>
      <button onClick={() => setWanted((v) => !v)} disabled={!token}>
        {wanted ? "Отключиться от видео" : "Подключиться к видео"}
      </button>
      <p role="status">
        {state} · {participant}
      </p>
      <video
        ref={video}
        autoPlay
        muted
        playsInline
        controls
        className="viewport"
        aria-label="LiveKit moving test pattern"
      />
      <pre>{JSON.stringify(metrics, null, 2)}</pre>
      <p>
        Цифры на видео: кадр / Unix ms генерации / заданный FPS. Задержка:
        генерация → decoded frame callback, включая IPC, encode, сеть и decode;
        часы Docker VM и браузера.
      </p>
    </section>
  );
}
