import { describe, expect, it } from "vitest";

import {
  configuredKey,
  isAuthenticated,
  issueSession,
  keyFingerprint,
  keyMatches,
  readSessionCookie,
  SESSION_TTL_SECONDS,
  sessionCookie,
  verifySession,
} from "../app/access.server";

const KEY = "k".repeat(32);
const OTHER_KEY = "o".repeat(32);
const NOW = Date.UTC(2026, 9, 24);

const envWith = (ACCESS_KEY: string | undefined) => ({ ACCESS_KEY }) as unknown as Env;

describe("configuredKey", () => {
  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["31 characters", "k".repeat(31)],
    ["31 characters padded with whitespace", ` ${"k".repeat(31)}\n`],
  ])("is null when the key is %s", (_label, key) => {
    expect(configuredKey(envWith(key))).toBeNull();
  });

  it("returns the trimmed key from 32 characters up", () => {
    expect(configuredKey(envWith(`${KEY}\n`))).toBe(KEY);
  });
});

describe("keyMatches", () => {
  it("accepts the key, also with surrounding whitespace", async () => {
    expect(await keyMatches(KEY, KEY)).toBe(true);
    expect(await keyMatches(` ${KEY}\n`, KEY)).toBe(true);
  });

  it("rejects a different, empty or whitespace-only key", async () => {
    expect(await keyMatches(OTHER_KEY, KEY)).toBe(false);
    expect(await keyMatches("", KEY)).toBe(false);
    expect(await keyMatches(" \n", KEY)).toBe(false);
  });
});

describe("sessions", () => {
  it("verifies a session it issued until it expires", async () => {
    const session = await issueSession(KEY, NOW);
    expect(await verifySession(session, KEY, NOW)).toBe(true);
    const expiresAt = Number(session.split(".")[0]) * 1000;
    expect(expiresAt).toBe(NOW + SESSION_TTL_SECONDS * 1000);
    expect(await verifySession(session, KEY, expiresAt - 1)).toBe(true);
    expect(await verifySession(session, KEY, expiresAt)).toBe(false);
  });

  it("rejects a session signed with another key (rotation)", async () => {
    const session = await issueSession(OTHER_KEY, NOW);
    expect(await verifySession(session, KEY, NOW)).toBe(false);
  });

  it("rejects a tampered expiry or signature", async () => {
    const session = await issueSession(KEY, NOW);
    const [exp, signature] = session.split(".");
    expect(await verifySession(`${Number(exp) + 1}.${signature}`, KEY, NOW)).toBe(false);
    const flipped = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
    expect(await verifySession(`${exp}.${flipped}`, KEY, NOW)).toBe(false);
  });

  it.each(["", "garbage", "123", ".abc", "abc.def", "123.", "123.a+b/c=", "123.a.b"])(
    "rejects the malformed value %j",
    async (value) => {
      expect(await verifySession(value, KEY, NOW)).toBe(false);
    },
  );
});

describe("cookies", () => {
  it("sets the session cookie attributes, with Secure only when asked", () => {
    expect(sessionCookie("v", { secure: true })).toBe(
      `aw_session=v; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}; Secure`,
    );
    expect(sessionCookie("v", { secure: false })).not.toContain("Secure");
  });

  it("reads the session cookie among others", () => {
    const request = new Request("https://example.test/", {
      headers: { Cookie: "a=1; aw_session=123.abc; b=2" },
    });
    expect(readSessionCookie(request)).toBe("123.abc");
    expect(readSessionCookie(new Request("https://example.test/"))).toBeNull();
  });
});

describe("isAuthenticated", () => {
  const request = (headers: HeadersInit) => new Request("https://example.test/", { headers });

  it("accepts a valid session cookie or bearer key", async () => {
    const session = await issueSession(KEY, NOW);
    expect(await isAuthenticated(request({ Cookie: `aw_session=${session}` }), envWith(KEY), NOW)).toBe(true);
    expect(await isAuthenticated(request({ Authorization: `Bearer ${KEY}` }), envWith(KEY), NOW)).toBe(true);
  });

  it("rejects no credential, a wrong bearer key, or a non-bearer scheme", async () => {
    expect(await isAuthenticated(request({}), envWith(KEY), NOW)).toBe(false);
    expect(await isAuthenticated(request({ Authorization: `Bearer ${OTHER_KEY}` }), envWith(KEY), NOW)).toBe(false);
    expect(await isAuthenticated(request({ Authorization: `Basic ${KEY}` }), envWith(KEY), NOW)).toBe(false);
  });

  it("rejects even a matching credential when the configured key is too short", async () => {
    const short = "k".repeat(31);
    expect(await isAuthenticated(request({ Authorization: `Bearer ${short}` }), envWith(short), NOW)).toBe(false);
  });
});

describe("keyFingerprint", () => {
  it("is stable per key, changes on rotation, and never contains the key", async () => {
    const fingerprint = await keyFingerprint(envWith(KEY));
    expect(await keyFingerprint(envWith(`${KEY}\n`))).toBe(fingerprint);
    expect(await keyFingerprint(envWith(OTHER_KEY))).not.toBe(fingerprint);
    expect(fingerprint).not.toContain(KEY);
  });

  it("is \"none\" when the key is misconfigured", async () => {
    expect(await keyFingerprint(envWith(undefined))).toBe("none");
    expect(await keyFingerprint(envWith("k".repeat(31)))).toBe("none");
  });
});
