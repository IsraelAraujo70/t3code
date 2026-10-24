/**
 * Connects a guest's own Google account for their sandboxed bots: Google's installed-app OAuth flow
 * with PKCE and a loopback redirect on this machine. The guest signs in themselves in a browser
 * here; nobody types their password. The result is `<secrets>/google/credentials.json` (mode 600),
 * which only the guest's proxy container reads (sandbox/google-forward.mjs).
 *
 * From the OAuth client file only `client_id` and `client_secret` are read, so pointing it at an
 * `authorized_user` file that also holds someone else's refresh token never copies that token.
 */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// A one-shot interactive flow around a local HTTP callback; plain Node keeps it readable.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

export const GOOGLE_SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
] as const;

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export interface GoogleClient {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface GoogleLoginResult {
  readonly credentialFile: string;
  /** Requested scopes the person left unchecked on Google's consent screen. */
  readonly missingScopes: ReadonlyArray<string>;
}

/** Pure. The client of a Google client file (`installed`, `web`) or `authorized_user` file. */
export function parseGoogleClient(text: string): GoogleClient | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const holder = [record.installed, record.web, record].find(
    (candidate): candidate is Record<string, unknown> =>
      typeof candidate === "object" &&
      candidate !== null &&
      typeof (candidate as Record<string, unknown>).client_id === "string",
  );
  const clientId = holder?.client_id;
  const clientSecret = holder?.client_secret;
  return typeof clientId === "string" && typeof clientSecret === "string"
    ? { clientId, clientSecret }
    : null;
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** Writes the file whole or not at all: the proxy may read it at any moment. */
function writeCredential(file: string, credential: object) {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(NodePath.dirname(file), 0o700);
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(credential, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, file);
}

const page = (title: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
  `<body style="font-family:sans-serif;max-width:32rem;margin:4rem auto;text-align:center">` +
  `<h1>${title}</h1><p>${text}</p></body>`;

/**
 * Runs the flow: calls `onAuthUrl` with the URL to open, waits for Google's redirect, exchanges
 * the code and writes the credential. Rejects on a wrong state, a refusal, a missing refresh
 * token, or after ten minutes. Never prints a token.
 */
export async function runGoogleLogin(options: {
  readonly client: GoogleClient;
  readonly secretsDir: string;
  readonly onAuthUrl: (url: string) => void;
  readonly port?: number;
  readonly scopes?: ReadonlyArray<string>;
  readonly authUrl?: string;
  readonly tokenUrl?: string;
}): Promise<GoogleLoginResult> {
  const scopes = options.scopes ?? GOOGLE_SCOPES;
  const verifier = base64url(NodeCrypto.randomBytes(48));
  const challenge = base64url(NodeCrypto.createHash("sha256").update(verifier).digest());
  const state = base64url(NodeCrypto.randomBytes(24));
  const credentialFile = NodePath.join(options.secretsDir, "google", "credentials.json");

  let settle: (code: string) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const codeArrived = new Promise<string>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      response.writeHead(404).end();
      return;
    }
    const send = (status: number, title: string, text: string) => {
      response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
      response.end(page(title, text));
    };
    if (url.searchParams.get("state") !== state) {
      send(400, "Link inválido", "Este link não é desta tentativa de login. Tente de novo.");
      return;
    }
    const code = url.searchParams.get("code");
    if (code === null) {
      send(400, "Login cancelado", "O Google não autorizou o acesso. Pode fechar esta aba.");
      fail(new Error(`Google refused: ${url.searchParams.get("error") ?? "no code"}`));
      return;
    }
    send(200, "Pronto!", "A conta do Google foi conectada. Pode fechar esta aba.");
    settle(code);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const timer = setTimeout(
    () => fail(new Error("Login timed out after 10 minutes.")),
    LOGIN_TIMEOUT_MS,
  );
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no loopback port");
    const redirectUri = `http://127.0.0.1:${address.port}/callback`;
    const authUrl = new URL(options.authUrl ?? AUTH_URL);
    for (const [name, value] of Object.entries({
      client_id: options.client.clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scopes.join(" "),
      access_type: "offline",
      // Without it, a second login returns no refresh token.
      prompt: "consent",
      include_granted_scopes: "false",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    })) {
      authUrl.searchParams.set(name, value);
    }
    options.onAuthUrl(authUrl.toString());

    const code = await codeArrived;
    const response = await fetch(options.tokenUrl ?? TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: options.client.clientId,
        client_secret: options.client.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      }),
    });
    const tokens = (await response.json().catch(() => null)) as {
      readonly refresh_token?: string;
      readonly scope?: string;
      readonly error?: string;
    } | null;
    if (!response.ok || typeof tokens?.refresh_token !== "string") {
      throw new Error(
        `Google did not issue a refresh token (HTTP ${response.status}${tokens?.error ? `, ${tokens.error}` : ""}).`,
      );
    }
    const granted = (tokens.scope ?? "").split(" ").filter((scope) => scope !== "");
    writeCredential(credentialFile, {
      type: "authorized_user",
      client_id: options.client.clientId,
      client_secret: options.client.clientSecret,
      refresh_token: tokens.refresh_token,
      scopes: granted,
      created_at: new Date().toISOString(),
    });
    return {
      credentialFile,
      missingScopes: scopes.filter((scope) => !granted.includes(scope)),
    };
  } finally {
    clearTimeout(timer);
    server.close();
  }
}
