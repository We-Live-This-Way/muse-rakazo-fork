import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { artifactCacheSession } from "../artifacts/artifact-cache-session";
import { clearAppBadge, syncAppBadge } from "../notifications/app-badge";
import { stopLiveNotifications } from "../notifications/live-notifications.js";
import { clearFailedSends } from "../thread/send/thread-feedback.js";
import { defaultApiBase } from "./endpoint.js";
import { clearNetworkCache } from "./network-cache.js";
import {
  clearSessionToken,
  currentSessionGeneration,
  loadSessionToken,
  loadVerifiedScope,
  registerSessionDiskCache,
  replaceSessionTokenIfCurrent,
  restoreSessionToken,
  rotateSessionTokenIfCurrent,
  saveRotatedSessionToken,
  saveSessionToken,
  saveVerifiedScope,
  sessionKeyFor,
  setSessionServer,
  snapshotSessionToken,
  subscribeSessionGeneration,
  tokenFromAuthResponse,
} from "./session.js";

/** The token key for the default server in these tests. */
const TOKEN_KEY = sessionKeyFor(defaultApiBase());

vi.mock("expo-notifications", () => ({ setBadgeCountAsync: vi.fn(async () => true) }));

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("../notifications/live-notifications.js", () => ({
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("../thread/send/thread-feedback.js", () => ({ clearFailedSends: vi.fn() }));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

describe("mobile session storage", () => {
  beforeEach(async () => {
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await restoreSessionToken("");
  });

  it("hides the previous bearer while a replacement token is being stored", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("fake-old-token");
    const write = deferred();
    const setItem = vi.fn(() => write.promise);
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(setItem);
    const listener = vi.fn();
    const unsubscribe = subscribeSessionGeneration(listener);
    const saving = saveSessionToken("fake-new-token");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    await vi.waitFor(() => expect(setItem).toHaveBeenCalled());
    expect(await snapshotSessionToken()).toEqual({ ok: true, value: "" });
    write.resolve();
    await saving;
  });

  it("wipes the outbox on sign-in, sign-out and server-session restoration", async () => {
    vi.mocked(clearFailedSends).mockClear();
    await saveSessionToken("fake-a");
    await clearSessionToken();
    await restoreSessionToken("fake-b");
    expect(vi.mocked(clearFailedSends).mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("deletes registered disk caches on sign-in, sign-out and restore", async () => {
    const clear = vi.fn();
    registerSessionDiskCache(clear);
    await saveSessionToken("fake-a");
    expect(clear).toHaveBeenCalledTimes(1);
    await clearSessionToken();
    expect(clear).toHaveBeenCalledTimes(2);
    await restoreSessionToken("fake-b");
    expect(clear.mock.calls.length).toBeGreaterThan(2);
  });

  it("clears the icon badge on sign-out and server-session restoration", async () => {
    registerSessionDiskCache(() => void clearAppBadge());
    await syncAppBadge(3);
    vi.mocked(Notifications.setBadgeCountAsync).mockClear();
    await clearSessionToken();
    expect(Notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(0);
    await syncAppBadge(2);
    await restoreSessionToken("fake-other-server");
    expect(Notifications.setBadgeCountAsync).toHaveBeenLastCalledWith(0);
  });

  it("clears delivered notifications only when the session ends", async () => {
    vi.mocked(stopLiveNotifications).mockClear();
    await saveSessionToken("fake-a");
    await restoreSessionToken("fake-b");
    expect(stopLiveNotifications).not.toHaveBeenCalled();
    await clearSessionToken();
    expect(stopLiveNotifications).toHaveBeenCalledWith(true);
  });

  it("still signs out and runs every other wipe when one disk cache throws", async () => {
    const after = vi.fn();
    registerSessionDiskCache(() => {
      throw new Error("disk unavailable");
    });
    registerSessionDiskCache(after);
    await expect(clearSessionToken()).resolves.toBe(true);
    expect(after).toHaveBeenCalledOnce();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("rakazo.integrations-scope");
  });

  it("stores and clears only the session token key", async () => {
    await saveSessionToken("secret-token");
    await clearSessionToken();

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(TOKEN_KEY, "secret-token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(TOKEN_KEY);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.session_token",
      expect.anything(),
    );
  });

  it("rotates the artifact namespace on session save, clear and restore", async () => {
    await saveSessionToken("fake-cache-token");
    let previous = await artifactCacheSession("fake-cache-token");
    for (const change of [
      () => saveSessionToken("fake-cache-token"),
      () => clearSessionToken(),
      () => restoreSessionToken("fake-cache-token"),
    ]) {
      await change();
      const next = await artifactCacheSession("fake-cache-token");
      expect(next).not.toBe(previous);
      previous = next;
    }
  });

  it("clears the system network cache on session save, clear and restore", async () => {
    for (const change of [
      () => saveSessionToken("fake-cache-token"),
      () => clearSessionToken(),
      () => restoreSessionToken("fake-cache-token"),
    ]) {
      vi.mocked(clearNetworkCache).mockClear();
      await change();
      expect(clearNetworkCache).toHaveBeenCalled();
    }
  });

  it("forgets unsent messages on sign-out", async () => {
    vi.mocked(clearFailedSends).mockClear();
    await clearSessionToken();
    expect(clearFailedSends).toHaveBeenCalledOnce();
  });

  it("overwrites the token when SecureStore delete fails", async () => {
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === TOKEN_KEY) throw new Error("device locked");
    });
    await expect(clearSessionToken()).resolves.toBe(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(TOKEN_KEY, "");
  });

  it("invalidates the in-memory session when SecureStore cannot clear the token", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("secret-token");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await expect(clearSessionToken()).resolves.toBe(false);
    await expect(loadSessionToken()).resolves.toBe("");
  });

  it("returns an empty token when secure storage is empty or unavailable", async () => {
    const store = new Map<string, string>();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => store.get(key) ?? null);
    await expect(loadSessionToken()).resolves.toBe("");

    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));
    await expect(loadSessionToken()).resolves.toBe("");

    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(TOKEN_KEY);
  });

  it("restores the active session in memory when persistence is unavailable", async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await restoreSessionToken("secret-token");
    await expect(loadSessionToken()).resolves.toBe("secret-token");
    await expect(snapshotSessionToken()).resolves.toEqual({ ok: true, value: "secret-token" });

    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    await expect(clearSessionToken()).resolves.toBe(false);
    await expect(loadSessionToken()).resolves.toBe("");
  });

  it("distinguishes an unreadable token store from an empty session", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(new Error("device locked"));

    await expect(snapshotSessionToken()).resolves.toEqual({ ok: false });
  });
});

describe("per-server sessions", () => {
  const ONE = "https://one.example.test";
  const TWO = "https://two.example.test";
  let disk: Map<string, string>;
  beforeEach(async () => {
    disk = new Map();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => disk.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      disk.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      disk.delete(key);
    });
    await restoreSessionToken("");
  });
  afterEach(async () => {
    setSessionServer(defaultApiBase());
    await restoreSessionToken("");
  });

  it("keeps session keys inside SecureStore's alphabet", () => {
    for (const apiBase of [
      "http://127.0.0.1:3100",
      "https://rakazo.example.com",
      "http://100.97.235.102:3100",
      "https://second-server.example:8443",
    ]) {
      expect(sessionKeyFor(apiBase)).toMatch(/^[\w.-]+$/);
    }
  });

  it("gives two servers different session keys", () => {
    expect(sessionKeyFor("http://127.0.0.1:3100")).not.toBe(
      sessionKeyFor("https://rakazo.example.com"),
    );
    expect(sessionKeyFor("https://one.example.test")).not.toBe(
      sessionKeyFor("https://two.example.test"),
    );
  });

  it("keeps a different token per server under its own key", async () => {
    setSessionServer(ONE);
    await saveSessionToken("token-one");
    setSessionServer(TWO);
    await saveSessionToken("token-two");
    expect(await loadSessionToken()).toBe("token-two");

    setSessionServer(ONE);
    expect(await loadSessionToken()).toBe("token-one");
    expect(disk.get(sessionKeyFor(ONE))).toBe("token-one");
    expect(disk.get(sessionKeyFor(TWO))).toBe("token-two");
    expect(disk.has("rakazo.session_token")).toBe(false);
  });

  it("adopts a legacy token into the current server's key and deletes the legacy key", async () => {
    // A fresh origin per migration test: the migration runs once per server per launch.
    const server = "https://legacy-a.example.test";
    setSessionServer(server);
    disk.set("rakazo.session_token", "legacy-token");

    expect(await loadSessionToken()).toBe("legacy-token");
    expect(disk.get(sessionKeyFor(server))).toBe("legacy-token");
    expect(disk.has("rakazo.session_token")).toBe(false);
  });

  it("lets a per-origin token win over a legacy one and still deletes the legacy key", async () => {
    const server = "https://legacy-b.example.test";
    setSessionServer(server);
    disk.set(sessionKeyFor(server), "current-token");
    disk.set("rakazo.session_token", "legacy-token");

    expect(await loadSessionToken()).toBe("current-token");
    expect(disk.has("rakazo.session_token")).toBe(false);
  });

  it("keeps a legacy token in memory when its adoption cannot be written", async () => {
    const server = "https://legacy-c.example.test";
    setSessionServer(server);
    disk.set("rakazo.session_token", "legacy-token");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === sessionKeyFor(server)) throw new Error("device locked");
      disk.set(key, value);
    });

    expect(await loadSessionToken()).toBe("legacy-token");
    expect(disk.get("rakazo.session_token")).toBe("legacy-token");
    expect(disk.has(sessionKeyFor(server))).toBe(false);
  });

  it("does not let a failed save on one server suppress another server's token", async () => {
    setSessionServer(ONE);
    disk.set(sessionKeyFor(ONE), "token-one");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === sessionKeyFor(ONE)) throw new Error("device locked");
      disk.set(key, value);
    });
    await expect(saveSessionToken("token-new")).rejects.toThrow("device locked");

    setSessionServer(TWO);
    disk.set(sessionKeyFor(TWO), "token-two");
    expect(await loadSessionToken()).toBe("token-two");
  });

  it("loads no verified scope for another server until it re-verifies", async () => {
    const scope = {
      apiBase: "https://api.example.test",
      userId: "user-a",
      spaceId: "space-a",
      selectionId: "space-a",
    };
    await saveSessionToken("fake-session-a");
    await saveVerifiedScope(currentSessionGeneration(), scope);
    expect(await loadVerifiedScope()).toEqual(scope);

    setSessionServer(TWO);
    expect(await loadVerifiedScope()).toBeNull();
  });

  it("signing out on one server keeps another server's token", async () => {
    await saveSessionToken("token-default");
    setSessionServer(TWO);
    await saveSessionToken("token-two");
    setSessionServer(defaultApiBase());

    await clearSessionToken();
    expect(await loadSessionToken()).toBe("");
    expect(disk.get(sessionKeyFor(TWO))).toBe("token-two");
    expect(disk.has(TOKEN_KEY)).toBe(false);
  });
});

describe("password change token rotation", () => {
  const NAMESPACE_KEY = "rakazo.artifact-cache-session";
  let disk: Map<string, string>;
  let namespace: string;
  beforeEach(async () => {
    disk = new Map();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => disk.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      disk.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      disk.delete(key);
    });
    await saveSessionToken("fake-old");
    namespace = await artifactCacheSession("fake-old");
    vi.mocked(clearFailedSends).mockClear();
  });
  const failNamespaceWrite = () =>
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(async (key) => {
      if (key === NAMESPACE_KEY) throw new Error("keychain unavailable");
    });
  const stored = () => JSON.parse(disk.get(NAMESPACE_KEY) ?? "null");

  it("keeps unsent messages and their cache namespace for the same account", async () => {
    await rotateSessionTokenIfCurrent(currentSessionGeneration(), "fake-old", "fake-new");

    expect(clearFailedSends).not.toHaveBeenCalled();
    expect(await artifactCacheSession("fake-new")).toBe(namespace);
    expect(disk.get(TOKEN_KEY)).toBe("fake-new");
    expect(stored()).toEqual({ token: "fake-new", namespace, previous: "fake-old" });
  });

  it("still wipes unsent messages and the namespace for a sign-in, SSO or passkey session", async () => {
    await replaceSessionTokenIfCurrent(currentSessionGeneration(), "fake-new");

    expect(clearFailedSends).toHaveBeenCalledOnce();
    expect(await artifactCacheSession("fake-new")).not.toBe(namespace);
  });

  it("saves the token only after its namespace, and reports a failed namespace save", async () => {
    failNamespaceWrite();

    await expect(
      rotateSessionTokenIfCurrent(currentSessionGeneration(), "fake-old", "fake-new"),
    ).rejects.toThrow("keychain unavailable");

    // A restart still finds the previous token beside the namespace that names the queue.
    expect(disk.get(TOKEN_KEY)).toBe("fake-old");
    expect(stored()).toEqual({ token: "fake-old", namespace });
    await expect(loadSessionToken()).resolves.toBe("fake-new");
    expect(clearFailedSends).not.toHaveBeenCalled();
  });

  it("saves a failed rotation's namespace only together with its token", async () => {
    failNamespaceWrite();
    await expect(
      rotateSessionTokenIfCurrent(currentSessionGeneration(), "fake-old", "fake-new"),
    ).rejects.toThrow();

    // A cache read in the meantime must not pair the new namespace with the revoked token.
    expect(await artifactCacheSession("fake-new")).toBe(namespace);
    expect(stored()).toEqual({ token: "fake-old", namespace });

    await saveRotatedSessionToken();
    expect(disk.get(TOKEN_KEY)).toBe("fake-new");
    expect(stored()).toEqual({ token: "fake-new", namespace, previous: "fake-old" });
  });

  it("does not save a failed rotation after another session change", async () => {
    failNamespaceWrite();
    await expect(
      rotateSessionTokenIfCurrent(currentSessionGeneration(), "fake-old", "fake-new"),
    ).rejects.toThrow();
    await clearSessionToken();

    await saveRotatedSessionToken();
    expect(disk.has(TOKEN_KEY)).toBe(false);
    expect(disk.has(NAMESPACE_KEY)).toBe(false);
  });

  async function restart() {
    vi.resetModules();
    const session = await import("./session.js");
    const artifacts = await import("../artifacts/artifact-cache-session");
    return { ...session, ...artifacts };
  }

  it("finishes after a restart a rotation that stopped between its two saves", async () => {
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      // The app stops after the namespace is saved, before the token is.
      if (key === TOKEN_KEY) throw new Error("app stopped");
      disk.set(key, value);
    });
    await expect(
      rotateSessionTokenIfCurrent(currentSessionGeneration(), "fake-old", "fake-new"),
    ).rejects.toThrow();
    expect(disk.get(TOKEN_KEY)).toBe("fake-old");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      disk.set(key, value);
    });

    const next = await restart();
    await expect(next.loadSessionToken()).resolves.toBe("fake-new");
    expect(disk.get(TOKEN_KEY)).toBe("fake-new");
    expect(await next.artifactCacheSession("fake-new")).toBe(namespace);
  });

  it("retries an unfinished rotation after a failed read instead of using the revoked token", async () => {
    disk.set(NAMESPACE_KEY, JSON.stringify({ token: "fake-new", namespace, previous: "fake-old" }));
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      async (key) => disk.get(key) ?? null,
    );
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(async () => {
      throw new Error("keychain unavailable");
    });

    const next = await restart();
    await expect(next.snapshotSessionToken()).resolves.toEqual({ ok: false });
    await expect(next.loadSessionToken()).resolves.toBe("fake-new");
    expect(disk.get(TOKEN_KEY)).toBe("fake-new");
  });

  it.each([
    ["sign-out", ""],
    ["sign-in", "fake-other"],
  ])("lets a %s during the recovery write win", async (change, expected) => {
    disk.set(NAMESPACE_KEY, JSON.stringify({ token: "fake-new", namespace, previous: "fake-old" }));
    let recoveryWrite: Deferred | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (value === "fake-new") {
        recoveryWrite = deferred();
        await recoveryWrite.promise;
      }
      disk.set(key, value);
    });

    const next = await restart();
    const recovering = next.loadSessionToken();
    await vi.waitFor(() => expect(recoveryWrite).toBeDefined());
    const changing =
      change === "sign-out" ? next.clearSessionToken() : next.saveSessionToken(expected);
    // The session change runs as far as it can before the delayed recovery write finishes.
    await new Promise((resolve) => setTimeout(resolve, 10));
    recoveryWrite?.resolve();
    await Promise.all([recovering, changing]);

    expect(disk.get(TOKEN_KEY) ?? "").toBe(expected);
    await expect(next.loadSessionToken()).resolves.toBe(expected);
  });

  it("finishes the recovery when a scope save makes the first token read", async () => {
    disk.set(NAMESPACE_KEY, JSON.stringify({ token: "fake-new", namespace, previous: "fake-old" }));
    const scope = {
      apiBase: "https://api.example.test",
      userId: "u",
      spaceId: "s",
      selectionId: null,
    };

    const next = await restart();
    await next.saveVerifiedScope(0, scope);
    expect(disk.get(TOKEN_KEY)).toBe("fake-new");
    await expect(next.loadVerifiedScope()).resolves.toEqual(scope);
  });

  it("does not adopt a rotation recorded for a different saved token", async () => {
    disk.set(
      NAMESPACE_KEY,
      JSON.stringify({ token: "fake-new", namespace, previous: "fake-someone-else" }),
    );

    const next = await restart();
    await expect(next.loadSessionToken()).resolves.toBe("fake-old");
    expect(disk.get(TOKEN_KEY)).toBe("fake-old");
  });

  it("adopts a rotation only for the server that recorded it", async () => {
    disk.set(NAMESPACE_KEY, JSON.stringify({ token: "fake-new", namespace, previous: "fake-old" }));
    disk.set(sessionKeyFor("https://a.example.test"), "fake-old");

    const other = await restart();
    other.setSessionServer("https://b.example.test");
    await expect(other.loadSessionToken()).resolves.toBe("");
    expect(disk.has(sessionKeyFor("https://b.example.test"))).toBe(false);

    const home = await restart();
    home.setSessionServer("https://a.example.test");
    await expect(home.loadSessionToken()).resolves.toBe("fake-new");
    expect(disk.get(sessionKeyFor("https://a.example.test"))).toBe("fake-new");
  });
});

describe("auth response token parsing", () => {
  it("prefers the signed set-auth-token header over the cookie and an unsigned body token", () => {
    const response = new Response(null, {
      headers: {
        "set-auth-token": "header-token.c2lnbmF0dXJl%2B%3D",
        "set-cookie": "better-auth.session_token=cookie-token.sig; Path=/",
      },
    });

    expect(tokenFromAuthResponse(response, { token: "header-token" })).toBe(
      "header-token.c2lnbmF0dXJl+=",
    );
  });

  it("prefers the signed cookie over an unsigned body token", () => {
    const response = new Response(null, {
      headers: { "set-cookie": "better-auth.session_token=cookie-token.sig; Path=/" },
    });

    expect(tokenFromAuthResponse(response, { token: "cookie-token" })).toBe("cookie-token.sig");
  });

  it("falls back to JSON tokens, including nested session responses", () => {
    const response = new Response(null);

    expect(tokenFromAuthResponse(response, { token: "body-token.sig" })).toBe("body-token.sig");
    expect(tokenFromAuthResponse(response, { session: { token: "nested-token.sig" } })).toBe(
      "nested-token.sig",
    );
  });

  it.each(["better-auth.session_token", "__Secure-better-auth.session_token"])(
    "falls back to and decodes the %s cookie",
    (name) => {
      const response = new Response(null, {
        headers: { "set-cookie": `${name}=abc%2F123%3D; Path=/; HttpOnly` },
      });

      expect(tokenFromAuthResponse(response, {})).toBe("abc/123=");
    },
  );

  it("finds a secure session after another Set-Cookie value", () => {
    const response = new Response(null, {
      headers: {
        "set-cookie":
          "other=value; Path=/, __Secure-better-auth.session_token=secure-token; Path=/; HttpOnly",
      },
    });

    expect(tokenFromAuthResponse(response, {})).toBe("secure-token");
  });

  it("rejects unrelated cookies and malformed response bodies", () => {
    const unrelated = new Response(null, {
      headers: { "set-cookie": "notbetter-auth.session_token=attacker; Path=/" },
    });
    const malformed = new Response(null, {
      headers: { "set-cookie": "better-auth.session_token=bad%ZZ; Path=/" },
    });
    expect(tokenFromAuthResponse(unrelated, { token: 123 })).toBe("");
    expect(tokenFromAuthResponse(unrelated, null)).toBe("");
    expect(tokenFromAuthResponse(malformed, {})).toBe("");
  });
});

describe("verified integration session scope", () => {
  const scope = {
    apiBase: "https://api.example.test",
    userId: "user-a",
    spaceId: "space-a",
    selectionId: "space-a",
  };
  let disk: Map<string, string>;
  beforeEach(async () => {
    disk = new Map();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => disk.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      disk.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      disk.delete(key);
    });
    await restoreSessionToken("");
    await saveSessionToken("fake-session-a");
  });
  it("loads the scope only for the exact stored session", async () => {
    await saveVerifiedScope(currentSessionGeneration(), scope);
    expect(await loadVerifiedScope()).toEqual(scope);
    disk.set(TOKEN_KEY, "fake-session-b");
    expect(await loadVerifiedScope()).toBeNull();
  });
  it.each(["sign-out", "replacement", "restore"])("invalidates the scope on %s", async (change) => {
    await saveVerifiedScope(currentSessionGeneration(), scope);
    if (change === "sign-out") await clearSessionToken();
    if (change === "replacement") await saveSessionToken("fake-session-a");
    if (change === "restore") await restoreSessionToken("fake-session-a");
    expect(await loadVerifiedScope()).toBeNull();
    expect(disk.has("rakazo.integrations-scope")).toBe(false);
  });
  it("rejects a late verification after session replacement", async () => {
    const generation = currentSessionGeneration();
    await saveSessionToken("fake-session-b");
    await saveVerifiedScope(generation, scope);
    expect(disk.has("rakazo.integrations-scope")).toBe(false);
  });
  it("serializes an in-flight scope write before sign-out deletes it", async () => {
    const pending = deferred();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.integrations-scope") await pending.promise;
      disk.set(key, value);
    });
    const saving = saveVerifiedScope(currentSessionGeneration(), scope);
    await Promise.resolve();
    await Promise.resolve();
    const clearing = clearSessionToken();
    pending.resolve();
    await Promise.all([saving, clearing]);
    expect(disk.has("rakazo.integrations-scope")).toBe(false);
    expect(await loadVerifiedScope()).toBeNull();
  });
  it("treats malformed stored scopes as misses", async () => {
    await saveVerifiedScope(currentSessionGeneration(), scope);
    disk.set("rakazo.integrations-scope", "{");
    expect(await loadVerifiedScope()).toBeNull();
  });
});
