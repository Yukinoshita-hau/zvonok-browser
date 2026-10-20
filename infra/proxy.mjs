import http from "node:http";
import net from "node:net";
import { lookup } from "node:dns/promises";
import { publicIPv4 } from "./proxy-policy.mjs";
const hosts = new Set(["example.com", "www.selenium.dev"]);

const server = http.createServer((req, res) => {
  res.writeHead(req.url === "/guard-ready" ? 200 : 403);
  res.end();
});
server.on("connect", async (req, client, head) => {
  let remote;
  const deny = () => client.destroy();
  client.on("error", () => remote?.destroy());
  try {
    if (
      !req.url ||
      !hosts.has(req.url.slice(0, -4)) ||
      !req.url.endsWith(":443")
    )
      return deny();
    const addresses = await lookup(req.url.slice(0, -4), {
      all: true,
      family: 4,
    });
    if (!addresses.length || addresses.some((a) => !publicIPv4(a.address)))
      return deny();
    remote = net.connect({ host: addresses[0].address, port: 443 });
    remote.setTimeout(30000, () => remote.destroy());
    remote.on("error", deny);
    remote.once("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) remote.write(head);
      client.pipe(remote);
      remote.pipe(client);
    });
    client.on("close", () => remote.destroy());
  } catch {
    deny();
  }
});
server.maxConnections = 64;
server.headersTimeout = 5000;
server.listen(3128, "0.0.0.0");
for (const s of ["SIGTERM", "SIGINT"])
  process.on(s, () => server.close(() => process.exit()));
