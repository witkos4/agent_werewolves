import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";

import { issueSession } from "../app/access.server";
import { gate } from "../workers/gate";

const BASE = "https://example.test";
const GAME = "8f14e45f-ceea-4672-b1b3-0a8c2c6d5e9f";
const BEARER = { Authorization: `Bearer ${env.ACCESS_KEY}` };

function request(path: string, init: RequestInit = {}) {
  return new Request(`${BASE}${path}`, { redirect: "manual", ...init });
}

describe("access-key gate", () => {
  it("redirects anonymous page loads to /login, keeping path and query", async () => {
    for (const [path, next] of [
      ["/", "%2F"],
      [`/spike/${GAME}?a=1&b=2`, encodeURIComponent(`/spike/${GAME}?a=1&b=2`)],
    ]) {
      const response = await SELF.fetch(request(path));
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(`/login?next=${next}`);
    }
    expect((await SELF.fetch(request("/", { method: "HEAD" }))).status).toBe(302);
  });

  it("answers every other anonymous request with a bare 404", async () => {
    const cases: [string, RequestInit][] = [
      ["/api/spike/start", { method: "POST" }],
      [`/api/spike/${GAME}/turns`, {}],
      [`/api/spike/${GAME}/ws`, { headers: { Upgrade: "websocket" } }],
      ["/foo.data", {}],
      ["/__manifest?paths=%2F", {}],
      ["/", { method: "POST" }],
    ];
    for (const [path, init] of cases) {
      const response = await SELF.fetch(request(path, init));
      expect(response.status, `${init.method ?? "GET"} ${path}`).toBe(404);
      expect(await response.text()).toBe("Not found");
    }
  });

  it("lets /login and /healthz through without a credential", async () => {
    for (const path of ["/login", "/healthz"]) {
      expect(await gate(request(path), env)).toBeNull();
      expect(await gate(request(path, { method: "POST" }), env)).toBeNull();
    }
  });

  it("lets a valid bearer key or session cookie through, also on a WebSocket upgrade", async () => {
    const cookie = { Cookie: `aw_session=${await issueSession(env.ACCESS_KEY, Date.now())}` };
    for (const headers of [BEARER, cookie]) {
      expect(await gate(request("/api/spike/start", { method: "POST", headers }), env)).toBeNull();
      expect(await gate(request(`/api/spike/${GAME}/ws`, { headers: { ...headers, Upgrade: "websocket" } }), env)).toBeNull();
      expect(await gate(request("/", { headers }), env)).toBeNull();
    }
    // Wired into the worker: past the gate, the spike route answers.
    expect((await SELF.fetch(request(`/api/spike/${GAME}/ws`, { headers: BEARER }))).status).toBe(426);
  });

  it("refuses a session signed with the previous key (rotation)", async () => {
    const old = await issueSession("previous-key-0123456789abcdefghijkl", Date.now());
    const response = await gate(request("/", { headers: { Cookie: `aw_session=${old}` } }), env);
    expect(response?.status).toBe(302);
  });

  it.each([
    ["unset", undefined, "unset"],
    ["31 characters", "k".repeat(31), "too_short"],
  ])("fails closed and logs when ACCESS_KEY is %s", async (_label, key, reason) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { ...env, ACCESS_KEY: key } as unknown as Env;
    const headers = { Authorization: `Bearer ${key}` };

    expect((await gate(request("/api/spike/start", { method: "POST", headers }), broken))?.status).toBe(404);
    expect((await gate(request("/", { headers }), broken))?.status).toBe(302);
    expect(await gate(request("/healthz"), broken)).toBeNull();
    expect(error).toHaveBeenCalledWith(JSON.stringify({ event: "access_gate_misconfigured", reason }));
  });
});
