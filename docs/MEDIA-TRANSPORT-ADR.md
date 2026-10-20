# ADR: кандидаты для Slice 2

Status: candidates selected, NOT IMPLEMENTED / NOT MEASURED. Slice 1 PNG diagnostics are not a media transport. Existing Zvonok LiveKit is untouched.

Candidate A: viewport frames/audio → LiveKit RTC Node SDK. Candidate B: dedicated Linux display/audio → FFmpeg/GStreamer → LiveKit Ingress. Start the next spike with B as the full audio+video baseline; retain A for lower-copy viewport capture if measurements justify its capture/audio complexity. This is an experiment order, not a proven production choice.

| Concern | A | B |
|---|---|---|
| Viewport | Browser/CDP capture or compositor export, decode/convert to SDK frame format; throughput unverified | Headed browser on session-specific virtual display, capture exact viewport rectangle |
| Audio | Separate per-session audio sink still needed; screenshots/CDP frames provide none | Dedicated PulseAudio/PipeWire sink per session, capture its monitor |
| 720p/1080p, 15/30 | Need bounded frame queue, timestamps, drop policy and backpressure | Need display sizing, encoder cadence, timestamps and A/V sync |
| CPU | Capture/decode/color conversion plus SDK software encoder; unknown | Display capture/color conversion/software encode; extra ingress transcode may add CPU |
| RAM | Raw-frame queues and Chromium/SDK native allocations | Chromium, display, audio daemon, encoder and ingress buffers |
| Latency | Capture wait + conversion + encode + WebRTC + render | Display wait + capture/encode + ingress buffering/transcode + WebRTC + render |

The [Node SDK reference](https://docs.livekit.io/reference/client-sdk-node/) documents realtime tracks and AudioSource; its page labels the SDK preview. It does not prove Chromium viewport/audio capture. [Ingress documentation](https://docs.livekit.io/transport/media/ingress-egress/ingress/) describes RTMP/WHIP input, GStreamer processing and forwarding with transcoding disabled. Avoid assuming every ingress configuration avoids re-encoding.

Plan for a separate Slice 2 task: isolated disposable LiveKit test environment, no changes to production. Measure each candidate on CPU-only Linux VPS at 1280×720 and 1920×1080, each 15 and 30 FPS, one session. Use a moving deterministic public/test page and audio tone. Collect Chromium/capture/encode/ingress CPU and RSS, dropped frames, effective FPS, bitrate, encode stages and p50/p95 input-to-pixel latency (timestamped click triggers visible flash, receiver records arrival). Separate warmup from at least 60 sec steady-state, repeat three times. Report host CPU/RAM, codec, encoder preset, network path and all buffers. Reject unbounded queues and undisclosed extra transcode.

Raw RGBA alone is ~3.5 MiB/frame at 720p and ~7.9 MiB at 1080p; 30 FPS moves ~105/~237 MiB/s before copies. These are byte arithmetic, not measured resource budgets. No universal VPS capacity or latency claim. VPS needs working user namespaces/sandbox and virtual display/audio; GPU is optional only if software encoding meets measured goals.

Windows Docker Desktop adds a Linux VM, clock/scheduling/network overhead and no automatic Windows session-audio source. It can validate container topology and functionality; do not generalize its timings to VPS. Audio isolation, sandbox and firewall must remain intact when adding capture. Neither candidate has been run here; all media performance and A/V correctness are NOT RUN.
