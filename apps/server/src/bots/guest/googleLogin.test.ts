// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off
// Drives the plain-Node login flow against a fake Google over real loopback HTTP.
import * as NodeCrypto from "node:crypto";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { GOOGLE_SCOPES, parseGoogleClient, runGoogleLogin } from "./googleLogin.ts";

/** A fake token endpoint that checks the PKCE verifier against the challenge it was shown. */
async function fakeTokenEndpoint(grantedScopes: ReadonlyArray<string>) {
  const exchanges: Array<Record<string, string>> = [];
  let expectedChallenge = "";
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      const form = Object.fromEntries(new URLSearchParams(body));
      exchanges.push(form);
      const challenge = NodeCrypto.createHash("sha256")
        .update(form.code_verifier ?? "")
        .digest("base64url");
      const ok = form.code === "code-1" && challenge === expectedChallenge;
      response.writeHead(ok ? 200 : 400, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          ok
            ? { access_token: "a", refresh_token: "bia-refresh", scope: grantedScopes.join(" ") }
            : { error: "invalid_grant" },
        ),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address() as { port: number };
  return {
    server,
    exchanges,
    tokenUrl: `http://127.0.0.1:${address.port}/token`,
    expect: (challenge: string) => (expectedChallenge = challenge),
  };
}

const scratch = () =>
  NodeFS.mkdtempSync(NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "t3-google-login-"));

it("reads only the client from any Google client or authorized_user file", () => {
  expect(
    parseGoogleClient(JSON.stringify({ installed: { client_id: "c", client_secret: "s" } })),
  ).toEqual({ clientId: "c", clientSecret: "s" });
  const owner = parseGoogleClient(
    JSON.stringify({
      type: "authorized_user",
      client_id: "c",
      client_secret: "s",
      refresh_token: "owner",
    }),
  );
  expect(owner).toEqual({ clientId: "c", clientSecret: "s" });
  expect(parseGoogleClient("{}")).toBeNull();
  expect(parseGoogleClient("not json")).toBeNull();
});

it("signs the guest in with PKCE and writes only their own credential, mode 600", async () => {
  const google = await fakeTokenEndpoint(GOOGLE_SCOPES);
  const dir = scratch();
  try {
    const result = await runGoogleLogin({
      client: { clientId: "client-1", clientSecret: "secret-1" },
      secretsDir: dir,
      tokenUrl: google.tokenUrl,
      onAuthUrl: (url) => {
        const auth = new URL(url);
        expect(auth.searchParams.get("scope")).toBe(GOOGLE_SCOPES.join(" "));
        expect(auth.searchParams.get("access_type")).toBe("offline");
        expect(auth.searchParams.get("prompt")).toBe("consent");
        expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
        google.expect(auth.searchParams.get("code_challenge")!);
        const redirect = new URL(auth.searchParams.get("redirect_uri")!);
        expect(redirect.hostname).toBe("127.0.0.1");
        // A link from another attempt is refused before the right one arrives.
        void fetch(`${redirect}?code=code-1&state=wrong`).then((response) =>
          expect(response.status).toBe(400),
        );
        setTimeout(() => {
          void fetch(`${redirect}?code=code-1&state=${auth.searchParams.get("state")}`);
        }, 50);
      },
    });
    expect(result.missingScopes).toEqual([]);
    expect(google.exchanges).toHaveLength(1);
    const file = NodePath.join(dir, "google", "credentials.json");
    expect(result.credentialFile).toBe(file);
    expect(NodeFS.statSync(file).mode & 0o777).toBe(0o600);
    expect(NodeFS.statSync(NodePath.dirname(file)).mode & 0o777).toBe(0o700);
    expect(JSON.parse(NodeFS.readFileSync(file, "utf8"))).toMatchObject({
      type: "authorized_user",
      client_id: "client-1",
      client_secret: "secret-1",
      refresh_token: "bia-refresh",
    });
  } finally {
    google.server.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

it("reports scopes the guest left unchecked on the consent screen", async () => {
  const google = await fakeTokenEndpoint(["https://www.googleapis.com/auth/calendar"]);
  const dir = scratch();
  try {
    const result = await runGoogleLogin({
      client: { clientId: "client-1", clientSecret: "secret-1" },
      secretsDir: dir,
      tokenUrl: google.tokenUrl,
      onAuthUrl: (url) => {
        const auth = new URL(url);
        google.expect(auth.searchParams.get("code_challenge")!);
        void fetch(
          `${auth.searchParams.get("redirect_uri")}?code=code-1&state=${auth.searchParams.get("state")}`,
        );
      },
    });
    expect(result.missingScopes).toEqual(
      GOOGLE_SCOPES.filter((scope) => scope !== "https://www.googleapis.com/auth/calendar"),
    );
  } finally {
    google.server.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});
