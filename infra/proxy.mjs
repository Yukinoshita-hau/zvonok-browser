import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { publicIPv4 } from "./proxy-policy.mjs";
const hosts = new Set([
  "example.com", "www.selenium.dev", "google.com", "googleapis.com",
  "gstatic.com", "googleusercontent.com", "youtube.com", "youtu.be",
  "googlevideo.com", "ytimg.com", "ggpht.com",
]);
const allowedHost = (host) => [...hosts].some((domain) => host === domain || host.endsWith(`.${domain}`));

const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/guard-ready" ? 200 : 403);
  res.end();
});
server.on("connect", async (req, client, head) => {
  let remote, closed = false;
  const deny = () => { if (closed) return; closed = true; client.destroy(); remote?.destroy(); };
  client.on("error", deny);
  client.on("close", deny);
  client.on("end", () => {
    if (!remote || (remote.destroyed && !remote.readableEnded)) deny();
    else if (remote.readableEnded) client.end(); // Flush an orderly upstream response before closing.
  });
  client.setTimeout(30000, deny);
  try {
    if (
      !req.url ||
      !allowedHost(req.url.slice(0, -4)) ||
      !req.url.endsWith(":443")
    )
      return deny();
    const addresses = await lookup(req.url.slice(0, -4), {
      all: true,
      family: 4,
    });
    if (closed || client.destroyed) return;
    if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
      return deny();
    remote = net.connect({ host: addresses[0].address, port: 443 });
    remote.setTimeout(30000, deny);
    remote.on("error", deny);
    remote.on("close", () => { if (!remote.readableEnded) deny(); });
    remote.once("connect", () => {
      if (closed || client.destroyed) return deny();
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
  } catch {
    deny();
  }
});
server.maxConnections = 64;
server.headersTimeout = 5000;
server.listen(3128, "0.0.0.0");
for (const s of ["SIGTERM", "SIGINT"])
  process.on(s, () => server.close(() => process.exit()));
