import net from 'node:net';
// shortcut: Docker Desktop loopback ICE needs a local TCP hop; omit this relay on a routable Linux VPS.
const livekitPort=Number(process.env.BROWSER_LIVEKIT_PORT??48034);
if(!Number.isInteger(livekitPort)||livekitPort<1024||livekitPort>65535)throw Error('INVALID_LIVEKIT_PORT');
const server = net.createServer((client) => {
  const upstream = net.connect(livekitPort, '127.0.0.1');
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

