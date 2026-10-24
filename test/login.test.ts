import { env } from "cloudflare:workers";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { issueSession, sanitizeNext, verifySession } from "../app/access.server";
import { cloudflareContext } from "../app/cloudflare-context";
import { action, loader } from "../app/routes/login";

const NEXT = "/spike/8f14e45f-ceea-4672-b1b3-0a8c2c6d5e9f?a=1";

// Call the route module directly; the React Router build is not in the test entry.
function args(request: Request, routeEnv: Env = env) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, { env: routeEnv, ctx: {} as ExecutionContext });
  return { request, context, url: new URL(request.url), pattern: "/login", params: {} };
}

function signIn(key: string, { origin = "https://example.test", routeEnv = env } = {}) {
  const body = new URLSearchParams({ key, next: NEXT });
  return action(args(new Request(`${origin}/login`, { method: "POST", body }), routeEnv));
}

function cookieValue(response: Response): string {
  return /^aw_session=([^;]+)/.exec(response.headers.get("Set-Cookie") ?? "")![1];
}

describe("login route", () => {
  it.each([
    ["the right key", env.ACCESS_KEY],
    ["the right key with a trailing newline", `${env.ACCESS_KEY}\n`],
  ])("signs in with %s and redirects to next", async (_label, key) => {
    const response = (await signIn(key)) as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe(NEXT);
    expect(await verifySession(cookieValue(response), env.ACCESS_KEY, Date.now())).toBe(true);
  });

  it("marks the cookie Secure only over https", async () => {
    const https = (await signIn(env.ACCESS_KEY)) as Response;
    const http = (await signIn(env.ACCESS_KEY, { origin: "http://localhost:5173" })) as Response;
    expect(https.headers.get("Set-Cookie")).toContain("; Secure");
    expect(http.headers.get("Set-Cookie")).not.toContain("Secure");
    expect(http.headers.get("Set-Cookie")).toContain("HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000");
  });

  it("rejects a wrong key with 401 and no cookie", async () => {
    const result = await signIn("wrong-key-0123456789abcdefghijklmn");
    expect(result).not.toBeInstanceOf(Response);
    expect(result).toMatchObject({ data: { error: "Wrong access key." }, init: { status: 401 } });
  });

  it("answers 503 when ACCESS_KEY is misconfigured", async () => {
    const broken = { ...env, ACCESS_KEY: "k".repeat(31) } as unknown as Env;
    expect(await signIn("k".repeat(31), { routeEnv: broken })).toMatchObject({ init: { status: 503 } });
    expect(await loader(args(new Request("https://example.test/login"), broken))).toMatchObject({
      misconfigured: true,
    });
  });

  it("redirects an already signed-in visitor to next, or / without one", async () => {
    const Cookie = `aw_session=${await issueSession(env.ACCESS_KEY, Date.now())}`;
    for (const [query, location] of [
      [`?next=${encodeURIComponent(NEXT)}`, NEXT],
      ["", "/"],
    ]) {
      const request = new Request(`https://example.test/login${query}`, { headers: { Cookie } });
      const thrown = await loader(args(request)).catch((error: unknown) => error);
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(302);
      expect((thrown as Response).headers.get("Location")).toBe(location);
    }
  });

  it("shows the form to an anonymous visitor, carrying a sanitized next", async () => {
    const request = new Request("https://example.test/login?next=%2F%2Fevil.test");
    expect(await loader(args(request))).toEqual({ next: "/", misconfigured: false });
  });
});

describe("sanitizeNext", () => {
  it("keeps same-origin paths", () => {
    expect(sanitizeNext(NEXT)).toBe(NEXT);
    expect(sanitizeNext("/")).toBe("/");
  });

  it.each(["//evil.test", "https://evil.test", "/\\evil", "/login", "/login?next=%2F", "", null, undefined])(
    "maps %j to /",
    (raw) => {
      expect(sanitizeNext(raw)).toBe("/");
    },
  );
});
