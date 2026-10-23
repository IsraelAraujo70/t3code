import { lookup as dnsLookup } from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

function publicV4(ip) {
  const [a, b, c] = ip.split(".").map(Number);
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113)
  );
}

/** Reject non-public destinations, including IPv4 embedded in IPv6 transition addresses. */
export function isPublicAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return publicV4(ip);
  if (family !== 6 || ip.includes("%")) return false;
  const normalized = ip.replace(/\d+\.\d+\.\d+\.\d+$/, (v4) => {
    const bytes = v4.split(".").map(Number);
    return `${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  });
  const halves = normalized.split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = (
    halves.length === 1
      ? left
      : [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
  ).map((word) => Number.parseInt(word, 16));
  const embeddedV4 = (offset) =>
    publicV4(
      `${words[offset] >> 8}.${words[offset] & 255}.${words[offset + 1] >> 8}.${words[offset + 1] & 255}`,
    );
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) return embeddedV4(6);
  if (words[0] === 0x64 && words[1] === 0xff9b && words.slice(2, 6).every((word) => word === 0))
    return embeddedV4(6);
  if (words[0] === 0x2002) return embeddedV4(1);
  return !(
    words.every((word) => word === 0) ||
    (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) ||
    (words[0] & 0xfe00) === 0xfc00 ||
    (words[0] & 0xffc0) === 0xfe80 ||
    (words[0] & 0xffc0) === 0xfec0 ||
    (words[0] & 0xff00) === 0xff00 ||
    (words[0] === 0x2001 && words[1] === 0xdb8) ||
    (words[0] === 0x100 && words.slice(1, 4).every((word) => word === 0))
  );
}

/** Create a CONNECT-only proxy that pins connections to validated DNS results. */
export function createEgressProxy({
  lookup = (host) => dnsLookup(host, { all: true, verbatim: true }),
  isAllowedAddress = isPublicAddress,
  log = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  const server = http.createServer((_request, response) => {
    response.writeHead(405, { "Content-Type": "text/plain", Connection: "close" });
    response.end("Only HTTPS CONNECT is supported.\n");
  });
  server.on("connect", async (request, client, head) => {
    client.on("error", () => {});
    const target = request.url ?? "";
    const deny = (status, reason) => {
      log(`deny ${target.replace(/[\r\n]/g, "")} (${reason})`);
      client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
    };
    const match = /^(?:\[([^\]]+)\]|([^:\s/]+)):(\d+)$/.exec(target);
    if (!match || Number(match[3]) < 1 || Number(match[3]) > 65535)
      return deny("403 Forbidden", "invalid target");
    const host = match[1] ?? match[2];
    if (match[1] && net.isIP(host) !== 6) return deny("403 Forbidden", "invalid IPv6 literal");
    let addresses;
    try {
      addresses = net.isIP(host) ? [{ address: host }] : await lookup(host);
    } catch {
      return deny("502 Bad Gateway", "lookup failed");
    }
    if (!addresses.length || addresses.some(({ address }) => !isAllowedAddress(address)))
      return deny("403 Forbidden", "non-public address");
    if (client.destroyed) return;
    const ip = addresses[0].address;
    const upstream = net.connect({ host: ip, port: Number(match[3]) });
    let connected = false;
    upstream.setTimeout(10_000, () => upstream.destroy(new Error("timeout")));
    client.on("close", () => upstream.destroy());
    upstream.on("error", () => {
      if (!connected) deny("502 Bad Gateway", "connect failed");
      else client.destroy();
    });
    upstream.on("connect", () => {
      connected = true;
      log(`allow ${target} -> ${ip}`);
      upstream.setTimeout(600_000, () => upstream.destroy());
      client.setTimeout(600_000, () => client.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("close", () => client.destroy());
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  createEgressProxy().listen(Number(process.env.EGRESS_PROXY_PORT || 3128), "0.0.0.0");
}
