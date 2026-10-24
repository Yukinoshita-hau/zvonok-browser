import net from "node:net";
import dns from "node:dns";
import dgram from "node:dgram";
import tls from "node:tls";
const rows = [];
const started=performance.now();
function record(row){rows.push({...row,elapsedMs:Math.round(performance.now()-started)});}
// A failed network probe must not leave an acceptance process alive after its host times out.
const campaignDeadline=setTimeout(()=>{console.table(rows);console.error('NETWORK_CAMPAIGN_TIMEOUT');process.exit(1);},45000);
campaignDeadline.unref();
const local = net.createServer((s) => s.end("probe"));
await new Promise((resolve) => local.listen(3000, "127.0.0.1", resolve));
async function blocked(name, host, port) {
  const open = await new Promise((resolve) => {
    const s = net.connect({ host, port });
    s.setTimeout(1200);
    s.on("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.on("error", () => resolve(false));
    s.on("timeout", () => {
      s.destroy();
      resolve(false);
    });
  });
  record({ name, result: open ? "FAIL" : "PASS" });
}
for (const [name, host, port] of [
  ["direct public IP", "1.1.1.1", 443],
  ["localhost", "127.0.0.1", 3000],
  ["Docker host IP", "192.168.65.254", 80],
  ["private network", "10.0.0.1", 443],
  ["metadata", "169.254.169.254", 80],
  ["IPv6 loopback", "::1", 80],
  ["IPv6 public", "2606:4700:4700::1111", 443],
  ["control API IP", "172.30.82.3", 3000],
])
  await blocked(name, host, port);
const resolver = new dns.promises.Resolver({ timeout: 1000, tries: 1 });
resolver.setServers(["127.0.0.11"]);
try {
  await resolver.resolve4("example.com");
  record({ name: "Docker DNS", result: "FAIL" });
} catch {
  record({ name: "Docker DNS", result: "PASS" });
}
const external = new dns.promises.Resolver({ timeout: 1000, tries: 1 });
external.setServers(["1.1.1.1"]);
try {
  await external.resolve4("example.com");
  record({ name: "external DNS", result: "FAIL" });
} catch {
  record({ name: "external DNS", result: "PASS" });
}
for (const target of [
  "127.0.0.1:443",
  "169.254.169.254:443",
  "host.docker.internal:443",
  "example.com.evil.test:443",
  "youtube.com.evil.test:443",
  "example.com:80",
  "[::1]:443",
]) {
  const rejected = await new Promise((resolve) => {
    const s = net.connect(3128, "172.30.87.2", () =>
      s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`),
    );
    s.setTimeout(2000);
    s.on("data", (b) => {
      resolve(!b.toString().startsWith("HTTP/1.1 200"));
      s.destroy();
    });
    s.on("close", () => resolve(true));
    s.on("error", () => resolve(true));
    s.on("timeout", () => {
      resolve(false);
      s.destroy();
    });
  });
  record({ name: `CONNECT ${target}`, result: rejected ? "PASS" : "FAIL" });
}
const allowed = await new Promise((resolve) => {
  const s = net.connect(3128, "172.30.87.2", () =>
    s.write(
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
    ),
  );
  const deadline=setTimeout(()=>{s.destroy();resolve(false)},10000);deadline.unref();
  s.once('close',()=>{clearTimeout(deadline);resolve(false)});
  s.setTimeout(8000, () => {
    s.destroy();
    resolve(false);
  });
  s.on("error", () => resolve(false));
  s.once("data", (b) => {
    if (!b.toString().startsWith("HTTP/1.1 200")) {
      s.destroy();
      resolve(false);
      return;
    }
    const secure = tls.connect({ socket: s, servername: "example.com" }, () =>
      secure.write(
        "GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n",
      ),
    );
    let body = "";
    secure.on("data", (b) => (body += b));
    secure.on("end", () => resolve(body.includes("Example Domain")));
    secure.on("error", () => resolve(false));
  });
});
record({
  name: "allowlisted HTTPS actually opens",
  result: allowed ? "PASS" : "FAIL",
});
for (const host of ["www.youtube.com", "googlevideo.com", "www.google.com"]) {
  const connected = await new Promise((resolve) => {
    const s = net.connect(3128, "172.30.87.2", () =>
      s.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`),
    );
    s.setTimeout(4000, () => { s.destroy(); resolve(false); });
    s.once("data", (b) => { resolve(b.toString().startsWith("HTTP/1.1 200")); s.destroy(); });
    s.on("error", () => resolve(false));
    s.on("close", () => resolve(false));
  });
  record({ name: `CONNECT allowlisted ${host}:443`, result: connected ? "PASS" : "FAIL" });
}
clearTimeout(campaignDeadline);local.close();
console.table(rows);
if (rows.some((r) => r.result === "FAIL")) process.exitCode = 1;

