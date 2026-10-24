# Remote Browser Activity clients: HTTPS/WSS and ICE/TURN plan

This is a deployment plan only. No VPS, DNS, certificates, firewall, or TURN configuration has been changed.

## Public endpoints

* Serve the Zvonok frontend over HTTPS and the API over HTTPS/WSS on the same trusted application origins already used by Zvonok.
* Expose the Browser API only on the private Docker/Core network. Do not publish its integration endpoint to the Internet.
* Give each media broker a public WSS endpoint behind the TLS reverse proxy. Set `BROWSER_SIGNALING_URL` for each publisher to that exact `wss://` URL and add the corresponding Zvonok HTTPS origin to the broker origin allowlist.
* Serve LiveKit signaling as `wss://<media-domain>` and configure backend `LIVEKIT_SERVER_URL` to that public URL. Keep `LIVEKIT_API_URL` and the LiveKit API key/secret on the trusted backend network.

## ICE and TURN

* Replace the local loopback LiveKit node address with the VPS public address or a correctly routed private address; configure LiveKit UDP and TCP ICE listeners to match firewall/NAT mappings.
* Provide TURN over UDP and TURN/TLS over TCP 443 for restrictive client networks. Require authenticated, short-lived TURN credentials minted by the trusted backend; do not ship a static TURN secret to the browser.
* Allow the LiveKit UDP media range and TURN listener through the host firewall and cloud security group. Verify both direct UDP and forced TURN/TLS paths from an external network.
* Check ICE candidate addresses, selected candidate pair, DTLS connection, bidirectional RTP, packet loss, jitter, and reconnect behavior from Web and Electron clients.

## Release gates

1. Stage DNS and valid TLS certificates; verify HTTPS, WSS, origin checks, and private Browser API reachability.
2. Add TURN credentials and network rules without changing existing Zvonok or LiveKit secrets. Rotate only newly provisioned credentials if they are exposed.
3. Run Web↔Web and Electron↔Web calls from separate external networks, including forced TURN/TLS, and confirm Browser Activity video/audio plus ordinary voice RTP.
4. Record ICE candidate pairs, media stats, and cleanup after disconnect. Deploy only after those checks pass.
