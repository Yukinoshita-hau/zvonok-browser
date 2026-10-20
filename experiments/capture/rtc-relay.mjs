import net from 'node:net';
// shortcut: Docker Desktop loopback ICE needs a local TCP hop; omit this relay on a routable Linux VPS.
const server = net.createServer((client) => {
  const upstream = net.connect(47934, '127.0.0.1');
  client.pipe(upstream).pipe(client);
  client.setTimeout(30000, () => client.destroy());
  upstream.setTimeout(30000, () => upstream.destroy());
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});
server.maxConnections = 16;
server.listen(47836, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close();
  setTimeout(() => process.exit(0), 1000).unref();
});

