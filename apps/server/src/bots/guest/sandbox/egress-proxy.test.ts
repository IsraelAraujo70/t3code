import { once } from "node:events";
import net from "node:net";
import type { Server } from "node:net";
import { expect, it } from "vitest";
import { createEgressProxy, isPublicAddress } from "./egress-proxy.mjs";

const blocked = [
  "0.1.2.3",
  "10.0.0.1",
  "100.67.31.112",
  "127.0.0.1",
  "169.254.1.1",
  "172.17.0.1",
  "192.0.0.1",
  "192.0.2.1",
  "192.88.99.1",
  "192.168.15.7",
  "198.18.0.1",
  "198.51.100.1",
  "203.0.113.1",
  "224.0.0.1",
  "240.0.0.1",
  "255.255.255.255",
  "::",
  "::1",
  "fc00::1",
  "fd7a:115c:a1e0::1",
  "fe80::1",
  "fec0::1",
  "ff00::1",
  "2001:db8::1",
  "100::1",
  "::ffff:127.0.0.1",
  "::ffff:7f00:1",
  "64:ff9b::a00:1",
  "2002:c0a8:0101::1",
  "invalid",
  "1.2.3.999",
];
it.each(blocked)("blocks %s", (ip) => expect(isPublicAddress(ip)).toBe(false));
it.each([
  "1.1.1.1",
  "8.8.8.8",
  "140.82.112.3",
  "2606:4700:4700::1111",
  "::ffff:808:808",
  "64:ff9b::808:808",
  "2002:0808:0808::1",
])("allows %s", (ip) => expect(isPublicAddress(ip)).toBe(true));

async function listen(server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return address.port;
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function request(port: number, raw: string) {
  const socket = net.connect(port, "127.0.0.1");
  let response = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk: string) => {
    response += chunk;
  });
  try {
    const ended = once(socket, "end");
    socket.end(raw);
    await ended;
    return response;
  } finally {
    socket.destroy();
  }
}

it("rejects loopback with the default policy and DNS rebinding", async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const proxies = [
    createEgressProxy(),
    createEgressProxy({ lookup: async () => [{ address: "127.0.0.1", family: 4 }] }),
  ];
  try {
    const echoPort = await listen(echo);
    for (const [index, proxy] of proxies.entries()) {
      const port = await listen(proxy);
      const host = index === 0 ? "127.0.0.1" : "rebind.test";
      expect(
        await request(port, `CONNECT ${host}:${echoPort} HTTP/1.1\r\nHost: ${host}\r\n\r\n`),
      ).toContain("403 Forbidden");
    }
  } finally {
    await Promise.all(proxies.map(close));
    await close(echo);
  }
});

it("tunnels CONNECT head bytes and subsequent bytes", async () => {
  const echo = net.createServer((socket) => socket.pipe(socket));
  const proxy = createEgressProxy({ isAllowedAddress: () => true });
  let socket: net.Socket | undefined;
  try {
    const echoPort = await listen(echo);
    const port = await listen(proxy);
    socket = net.connect(port, "127.0.0.1");
    const client = socket;
    client.setEncoding("utf8");
    let response = "";
    const received = new Promise<void>((resolve, reject) => {
      client.on("error", reject);
      client.on("data", (chunk: string) => {
        response += chunk;
        if (response.endsWith("headping")) resolve();
      });
    });
    client.write(`CONNECT 127.0.0.1:${echoPort} HTTP/1.1\r\nHost: localhost\r\n\r\nhead`);
    client.write("ping");
    await received;
    expect(response).toBe("HTTP/1.1 200 Connection Established\r\n\r\nheadping");
  } finally {
    socket?.destroy();
    await close(proxy);
    await close(echo);
  }
});

it("rejects plain HTTP proxy requests", async () => {
  const proxy = createEgressProxy();
  try {
    const port = await listen(proxy);
    const response = await request(
      port,
      "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n",
    );
    expect(response).toContain("405 Method Not Allowed");
    expect(response).toContain("Only HTTPS CONNECT is supported.");
  } finally {
    await close(proxy);
  }
});

it("rejects a mixed public and private DNS answer", async () => {
  const proxy = createEgressProxy({
    lookup: async () => [
      { address: "1.1.1.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ],
  });
  try {
    const port = await listen(proxy);
    expect(await request(port, "CONNECT mixed.test:443 HTTP/1.1\r\n\r\n")).toContain(
      "403 Forbidden",
    );
  } finally {
    await close(proxy);
  }
});

it.each([
  "example.com:0",
  "example.com:65536",
  "example.com:no",
  "[example.com]:443",
  "[::1]:443",
  "example.com",
])("rejects invalid or private target %s", async (target) => {
  const proxy = createEgressProxy();
  try {
    const port = await listen(proxy);
    expect(await request(port, `CONNECT ${target} HTTP/1.1\r\n\r\n`)).toContain("403 Forbidden");
  } finally {
    await close(proxy);
  }
});
