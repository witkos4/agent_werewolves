// Credential rules for the access-key gate (FR-001). One key, set with
// `wrangler secret put ACCESS_KEY`. Browsers hold a session signed with the
// key itself, so rotating the key invalidates every session at once.

export const MIN_KEY_LENGTH = 32;
export const SESSION_COOKIE = "aw_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

/** The trimmed key, or null when it is unset or too short (the gate then fails closed). */
export function configuredKey(env: Env): string | null {
  const key = (env.ACCESS_KEY as string | undefined)?.trim();
  return key && key.length >= MIN_KEY_LENGTH ? key : null;
}

/** The reason `configuredKey` returned null, for the misconfiguration log line. */
export function misconfiguration(env: Env): "unset" | "too_short" {
  return (env.ACCESS_KEY as string | undefined)?.trim() ? "too_short" : "unset";
}

export async function keyMatches(given: string, expected: string): Promise<boolean> {
  const trimmed = given.trim();
  if (!trimmed) return false;
  // Compare fixed-length digests in constant time, so timing leaks neither
  // the key's length nor how many leading bytes matched.
  const [a, b] = await Promise.all([sha256(trimmed), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** Cookie value `<expSeconds>.<base64url HMAC>`; `now` is in milliseconds. */
export async function issueSession(key: string, now: number): Promise<string> {
  const exp = Math.floor(now / 1000) + SESSION_TTL_SECONDS;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(key), sessionData(exp));
  return `${exp}.${toBase64Url(new Uint8Array(signature))}`;
}

export async function verifySession(value: string, key: string, now: number): Promise<boolean> {
  const match = /^(\d{1,12})\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!match) return false;
  const exp = Number(match[1]);
  if (exp * 1000 <= now) return false;
  const signature = fromBase64Url(match[2]);
  if (!signature) return false;
  // crypto.subtle.verify compares in constant time.
  return crypto.subtle.verify("HMAC", await hmacKey(key), signature, sessionData(exp));
}

export function sessionCookie(value: string, { secure }: { secure: boolean }): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  // Only over https, so `npm run dev` on http://localhost keeps working in every browser.
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function readSessionCookie(request: Request): string | null {
  for (const part of request.headers.get("Cookie")?.split(";") ?? []) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

/** A same-origin path to send the operator to after sign-in; anything else becomes `/`. */
export function sanitizeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  // Never bounce back to the login page itself.
  if (/^\/login(?:[/?#]|$)/.test(raw)) return "/";
  return raw;
}

/** True for a valid session cookie or `Authorization: Bearer <key>`. */
export async function isAuthenticated(request: Request, env: Env, now: number): Promise<boolean> {
  const key = configuredKey(env);
  if (!key) return false;

  const session = readSessionCookie(request);
  if (session && (await verifySession(session, key, now))) return true;

  const bearer = /^Bearer\s+(.+)$/i.exec(request.headers.get("Authorization") ?? "");
  return bearer ? keyMatches(bearer[1], key) : false;
}

function sessionData(exp: number): Uint8Array<ArrayBuffer> {
  return encoder.encode(`session:v1:${exp}`);
}

function hmacKey(key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}
