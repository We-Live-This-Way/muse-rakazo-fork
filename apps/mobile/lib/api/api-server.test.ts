vi.mock("../settings/ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));

import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { signOut } from "../auth/api-auth.js";
import {
  resumeLiveNotifications,
  stopLiveNotifications,
} from "../notifications/live-notifications.js";
import { registerPushToken } from "../notifications/push.js";
import {
  authHeaders,
  currentApiBase,
  flushPendingSignOut,
  rpc,
  selectedSpaceId,
  spaceSelectionSeq,
} from "./api.js";
import {
  adoptDeletedSpaceFallback,
  clearSpace,
  configureSessionEndHangUp,
  loadApiBase,
  resetApiBase,
  saveApiBase,
  selectSpace,
} from "./api-server.js";
import { defaultApiBase } from "./endpoint.js";
import { MAUSHAUS_API_BASE } from "./saved-servers.js";
import {
  clearSessionToken,
  restoreSessionToken,
  saveSessionToken,
  sessionKeyFor,
  snapshotSessionToken,
} from "./session.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("../notifications/live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("../notifications/push.js", () => ({
  registerPushToken: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

import {
  jsonResponse,
  mockSecureStore,
  pendingSignOutRecords,
  rpcErrorResponse,
} from "./api-test-helpers";

describe("mobile API server and Space selection", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    vi.mocked(resumeLiveNotifications).mockClear();
    vi.mocked(registerPushToken).mockClear();
    await restoreSessionToken("");
  });

  const ONE = defaultApiBase();
  const TWO = "https://second-server.example";
  const THREE = "https://third-server.example";
  const tokenKey = (apiBase: string) => sessionKeyFor(apiBase);
  const spacesMap = (store: Map<string, string>) =>
    JSON.parse(store.get("rakazo.server_spaces") ?? "{}") as Record<string, string>;

  it("shares the selected space with direct API requests", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue("session-token");
    await selectSpace("space-support");

    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
  });

  it("does not switch spaces when the selection cannot be persisted", async () => {
    await expect(selectSpace("space-support")).resolves.toBe(true);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    await selectSpace("");
  });

  it("does not switch spaces when stale recovery cannot be cleared", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
    });

    await expect(selectSpace("space-social")).resolves.toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith("rakazo.space_id", "space-social");
    expect(selectedSpaceId()).toBe("space-support");

    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    await selectSpace("");
  });

  it("opens the seeded Maushaus server on a fresh install and switches with no previous session", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await loadApiBase();
    expect(currentApiBase()).toBe(MAUSHAUS_API_BASE);
    expect(store.get("rakazo.api_base")).toBe(MAUSHAUS_API_BASE);
    // A relaunch still opens Maushaus: the first launch remembered it.
    await loadApiBase();
    expect(currentApiBase()).toBe(MAUSHAUS_API_BASE);

    await expect(saveApiBase(TWO)).resolves.toEqual({ ok: true, url: TWO });
    expect(currentApiBase()).toBe(TWO);
    await resetApiBase();
  });

  it("a server switch leaves the previous server's token and Space stored", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("session-token");
    await selectSpace("space-support");

    await expect(saveApiBase(TWO)).resolves.toMatchObject({ ok: true });

    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith(tokenKey(ONE));
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith("rakazo.space_id");
    expect(store.get(tokenKey(ONE))).toBe("session-token");
    expect(spacesMap(store)[ONE]).toBe("space-support");
    expect(selectedSpaceId()).toBeNull();
    await resetApiBase();
  });

  it("keeps no revocation pending when switching servers signed in", async () => {
    await resetApiBase();
    const store = new Map<string, string>([[tokenKey(ONE), "session-token"]]);
    mockSecureStore(store);

    await expect(saveApiBase(TWO)).resolves.toMatchObject({ ok: true });

    // The old server keeps its session; only a sign-out revokes it.
    expect(pendingSignOutRecords(store)).toEqual([]);
    expect(store.get(tokenKey(ONE))).toBe("session-token");
    await resetApiBase();
  });

  it("records no revocation on a signed-in switch and a flush sends nothing", async () => {
    await resetApiBase();
    const store = new Map<string, string>([[tokenKey(ONE), "session-token"]]);
    mockSecureStore(store);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(saveApiBase(TWO)).resolves.toMatchObject({ ok: true });
    await flushPendingSignOut(true);

    expect(pendingSignOutRecords(store)).toEqual([]);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/auth/sign-out")),
    ).toEqual([]);
    expect(store.get(tokenKey(ONE))).toBe("session-token");
    await resetApiBase();
  });

  it("a rolled-back server switch leaves no pending revocation", async () => {
    await resetApiBase();
    for (const failure of ["headers", "endpoint"] as const) {
      const store = new Map<string, string>([[tokenKey(ONE), "session-token"]]);
      mockSecureStore(store);
      await restoreSessionToken("session-token");
      await selectSpace("space-support");
      vi.mocked(resumeLiveNotifications).mockClear();
      if (failure === "headers") {
        // Empty headers are saved by deleting the key, not writing it.
        vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
          if (key === "rakazo.server_headers") throw new Error("device locked");
          store.delete(key);
        });
      } else {
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.api_base") throw new Error("device locked");
          store.set(key, value);
        });
      }

      const saved = saveApiBase(TWO);
      await expect(saved).resolves.toMatchObject({ ok: false });
      // No record was ever created, and the old token and Space are intact.
      expect(pendingSignOutRecords(store)).toEqual([]);
      expect(store.get(tokenKey(ONE))).toBe("session-token");
      expect(currentApiBase()).toBe(ONE);
      await expect(authHeaders()).resolves.toEqual({
        authorization: "Bearer session-token",
        "x-rakazo-space-id": "space-support",
      });
      expect(resumeLiveNotifications).toHaveBeenCalledWith(ONE, "session-token", "space-support");
      mockSecureStore(store);
      await resetApiBase();
    }
  });

  it("a switch proceeds when the pending-sign-out store is unreadable", async () => {
    await resetApiBase();
    const store = new Map<string, string>([[tokenKey(ONE), "session-token"]]);
    mockSecureStore(store);
    await restoreSessionToken("session-token");
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.pending_sign_out") throw new Error("device locked");
      return store.get(key) ?? null;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.pending_sign_out") throw new Error("device locked");
      store.set(key, value);
    });

    // The switch never touches that store, so its failure cannot stop it.
    await expect(saveApiBase(TWO)).resolves.toMatchObject({ ok: true });
    expect(store.get(tokenKey(ONE))).toBe("session-token");
    expect(currentApiBase()).toBe(TWO);
    mockSecureStore(store);
    await resetApiBase();
  });

  it("a flush racing a failing server switch sends no sign-out", async () => {
    await resetApiBase();
    const store = new Map<string, string>([[tokenKey(ONE), "token-a"]]);
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    let failEndpointWrite: (() => void) | undefined;
    let endpointWrites = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") {
        endpointWrites += 1;
        if (endpointWrites === 1) {
          await new Promise((_resolve, reject) => {
            failEndpointWrite = () => reject(new Error("device locked"));
          });
        }
      }
      store.set(key, value);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const switching = saveApiBase(TWO);
    await vi.waitFor(() => expect(failEndpointWrite).toBeTruthy());
    await flushPendingSignOut(true);
    expect(
      fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/api/auth/sign-out")),
    ).toEqual([]);
    failEndpointWrite?.();
    await expect(switching).resolves.toMatchObject({ ok: false });

    expect(fetchMock.mock.calls).toEqual([]);
    expect(pendingSignOutRecords(store)).toEqual([]);
    expect(store.get(tokenKey(ONE))).toBe("token-a");
    expect(currentApiBase()).toBe(ONE);
  });

  it("delivers a provisional record a failed promotion left behind", async () => {
    // A provisional record written by the old version is still reconciled and delivered by a
    // flush, even though a switch no longer creates one.
    await resetApiBase();
    const store = new Map<string, string>([
      [
        "rakazo.pending_sign_out",
        JSON.stringify([
          {
            apiBase: ONE,
            token: "token-a",
            headers: {},
            recordedAt: Date.now(),
            provisional: true,
          },
        ]),
      ],
    ]);
    mockSecureStore(store);
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    await flushPendingSignOut(true);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${ONE}/api/auth/sign-out`]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer token-a" });
    expect(pendingSignOutRecords(store)).toEqual([]);
  });

  it.each(["save", "reset"])(
    "serializes a %s behind an earlier switch rollback",
    async (change) => {
      await resetApiBase();
      const store = new Map<string, string>();
      mockSecureStore(store);
      await saveApiBase("https://old-server.example");
      await restoreSessionToken("token-a");
      let failEndpointWrite: (() => void) | undefined;
      let endpointWrites = 0;
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === "rakazo.api_base") {
          endpointWrites += 1;
          if (endpointWrites === 1) {
            await new Promise((_resolve, reject) => {
              failEndpointWrite = () => reject(new Error("device locked"));
            });
          }
        }
        store.set(key, value);
      });
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);

      // This switch parks the old credentials, then fails before committing.
      const first = saveApiBase(TWO);
      await vi.waitFor(() => expect(failEndpointWrite).toBeTruthy());
      const second = change === "save" ? saveApiBase(THREE) : resetApiBase();
      try {
        // Give the overlapping transaction and reconciliation the same storage window.
        await flushPendingSignOut(true);
        expect(fetchMock.mock.calls).toEqual([]);
      } finally {
        failEndpointWrite?.();
      }
      await expect(first).resolves.toMatchObject({ ok: false });
      await expect(second).resolves.toMatchObject({ ok: true });
      expect(currentApiBase()).toBe(change === "save" ? THREE : ONE);
      // The old token survives in its per-origin key; no revocation was recorded.
      expect(store.get(tokenKey("https://old-server.example"))).toBe("token-a");
      expect(pendingSignOutRecords(store)).toEqual([]);
      mockSecureStore(store);
      await resetApiBase();
    },
  );

  it.each(["save", "reset"])(
    "a %s rollback preserves a newer explicit sign-out record",
    async (change) => {
      vi.spyOn(Date, "now").mockReturnValue(Date.now());
      const store = new Map<string, string>();
      mockSecureStore(store);
      if (change === "reset") await saveApiBase("https://old-server.example");
      const apiBase = currentApiBase();
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      let releaseRollback!: Deferred;
      const rollbackStarted = new Promise<void>((resolve) => {
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.space_rollback" && value) {
            resolve();
            releaseRollback = deferred();
            await releaseRollback.promise;
            throw new Error("device locked");
          }
          store.set(key, value);
        });
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("offline");
        }),
      );

      const switching =
        change === "save" ? saveApiBase("https://second-server.example") : resetApiBase();
      await rollbackStarted;
      // The provisional record is durable; the old session has not been cleared yet.
      const signingOut = signOut();
      try {
        await vi.waitFor(() => {
          const records = JSON.parse(store.get("rakazo.pending_sign_out") ?? "[]");
          expect(records).toHaveLength(1);
          expect(records[0].provisional).toBeUndefined();
        });
      } finally {
        releaseRollback.resolve();
      }
      await expect(switching).resolves.toMatchObject({ ok: false });
      await signingOut;
      expect(pendingSignOutRecords(store)).toEqual([{ apiBase, token: "token-a" }]);
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        store.set(key, value);
      });
      await resetApiBase();
    },
  );

  it("aborts a server switch when the session cannot be read", async () => {
    await resetApiBase();
    const store = new Map<string, string>([[tokenKey(ONE), "session-token"]]);
    mockSecureStore(store);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === tokenKey(ONE)) throw new Error("device locked");
      return store.get(key) ?? null;
    });

    await expect(saveApiBase(TWO)).resolves.toEqual({
      ok: false,
      error: "Could not save the previous server session",
    });
    // Without knowing whether the old server has a session, the switch clears nothing.
    expect(store.get(tokenKey(ONE))).toBe("session-token");
    expect(pendingSignOutRecords(store)).toEqual([]);
    mockSecureStore(store);
    await resetApiBase();
  });

  it.each(["the call hang-up", "the space rollback write"])(
    "a save never clears a session that replaced the recorded one during %s",
    async (during) => {
      await resetApiBase();
      const store = new Map<string, string>();
      mockSecureStore(store);
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      // An earlier failed switch left the selection stored only in its rollback record.
      store.delete("rakazo.space_id");
      const signIn = () => saveSessionToken("token-b");
      if (during === "the call hang-up") {
        configureSessionEndHangUp(signIn);
      } else {
        vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
          if (key === "rakazo.space_rollback" && value) await signIn();
          store.set(key, value);
        });
      }
      let result: Awaited<ReturnType<typeof saveApiBase>>;
      try {
        result = await saveApiBase(TWO);
      } finally {
        configureSessionEndHangUp(undefined);
        mockSecureStore(store);
      }

      if (during === "the call hang-up") {
        // The sign-in lands before the switch reads the session, so it is the session
        // being parked, not one the switch clears.
        expect(result).toMatchObject({ ok: true });
        expect(store.get(tokenKey(ONE))).toBe("token-b");
        expect(pendingSignOutRecords(store)).toEqual([]);
        expect(currentApiBase()).toBe(TWO);
      } else {
        // A session that changed after the read stops the switch before anything moves.
        expect(result).toMatchObject({ ok: false });
        expect(store.get(tokenKey(ONE))).toBe("token-b");
        expect(pendingSignOutRecords(store)).toEqual([]);
        expect(currentApiBase()).toBe(ONE);
        expect(selectedSpaceId()).toBe("space-old");
        expect(spacesMap(store)[ONE]).toBe("space-old");
      }
      mockSecureStore(store);
      await resetApiBase();
    },
  );

  it("a save stops while a session save started during the hang-up is still running", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    const saveHeld = deferred();
    let saving: Promise<void> | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === tokenKey(ONE) && value === "token-b") await saveHeld.promise;
      store.set(key, value);
    });
    configureSessionEndHangUp(async () => {
      saving = saveSessionToken("token-b");
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase(TWO);
    } finally {
      configureSessionEndHangUp(undefined);
      saveHeld.resolve();
      await saving;
      mockSecureStore(store);
    }

    expect(result).toMatchObject({ ok: false });
    // The save that was in flight lands after the switch stops, so it owns the session now.
    expect(store.get(tokenKey(ONE))).toBe("token-b");
    expect(currentApiBase()).toBe(ONE);
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("a save parks a stored session that a failed save during the hang-up left in place", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === tokenKey(ONE) && value === "token-b") throw new Error("device locked");
      store.set(key, value);
    });
    configureSessionEndHangUp(() => saveSessionToken("token-b"));
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase(TWO);
    } finally {
      configureSessionEndHangUp(undefined);
      mockSecureStore(store);
    }

    // The failed save left token-a stored; the switch parks it instead of revoking it.
    expect(result).toMatchObject({ ok: true });
    expect(store.get(tokenKey(ONE))).toBe("token-a");
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it.each(["save", "reset"])(
    "a %s rolled back after a failed save during the hang-up leaves the stored session parked",
    async (change) => {
      await resetApiBase();
      const store = new Map<string, string>();
      mockSecureStore(store);
      if (change === "reset") await saveApiBase("https://old-server.example");
      const previous = currentApiBase();
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === tokenKey(previous) && value === "token-b") {
          throw new Error("device locked");
        }
        if (change === "save" && key === "rakazo.api_base") throw new Error("device locked");
        store.set(key, value);
      });
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
        if (change === "reset" && key === "rakazo.api_base") throw new Error("device locked");
        store.delete(key);
      });
      configureSessionEndHangUp(() => saveSessionToken("token-b"));
      let result: Awaited<ReturnType<typeof saveApiBase>>;
      try {
        result = await (change === "save" ? saveApiBase(TWO) : resetApiBase());
      } finally {
        configureSessionEndHangUp(undefined);
        mockSecureStore(store);
      }

      // The rollback does not revoke token-a: it stays stored for its server.
      expect(result).toMatchObject({ ok: false });
      expect(store.get(tokenKey(previous))).toBe("token-a");
      expect(currentApiBase()).toBe(previous);
      expect(pendingSignOutRecords(store)).toEqual([]);
      mockSecureStore(store);
      await resetApiBase();
    },
  );

  it.each([
    ["save", "nothing"],
    ["save", "a sign-in during the rollback"],
    ["save", "a sign-in after the rollback"],
    ["reset", "nothing"],
    ["reset", "a sign-in during the rollback"],
    ["reset", "a sign-in after the rollback"],
  ])(
    "a %s rolled back after a failed save during the hang-up still parks the session when %s",
    async (change, reactivation) => {
      await resetApiBase();
      const store = new Map<string, string>();
      mockSecureStore(store);
      if (change === "reset") await saveApiBase("https://old-server.example");
      const previous = currentApiBase();
      await restoreSessionToken("token-a");
      await selectSpace("space-old");
      let rollingBack = false;
      vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
        if (key === tokenKey(previous) && value === "token-b") {
          throw new Error("device locked");
        }
        if (change === "save" && key === "rakazo.api_base") {
          rollingBack = true;
          throw new Error("device locked");
        }
        // The rollback restores the Space; a sign-in that returns token-a lands meanwhile.
        if (
          key === "rakazo.space_id" &&
          rollingBack &&
          reactivation === "a sign-in during the rollback"
        ) {
          rollingBack = false;
          await saveSessionToken("token-a");
        }
        store.set(key, value);
      });
      vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
        if (change === "reset" && key === "rakazo.api_base") {
          rollingBack = true;
          throw new Error("device locked");
        }
        store.delete(key);
      });
      configureSessionEndHangUp(() => saveSessionToken("token-b"));
      let result: Awaited<ReturnType<typeof saveApiBase>>;
      try {
        result = await (change === "save" ? saveApiBase(TWO) : resetApiBase());
      } finally {
        configureSessionEndHangUp(undefined);
        mockSecureStore(store);
      }
      if (reactivation === "a sign-in after the rollback") await saveSessionToken("token-a");
      const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
      vi.stubGlobal("fetch", fetchMock);
      await flushPendingSignOut(true);

      expect(result).toMatchObject({ ok: false });
      // No sign-out is ever sent for a parked session, whatever lands meanwhile.
      const signOuts = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/api/auth/sign-out"),
      );
      expect(signOuts).toEqual([]);
      expect(store.get(tokenKey(previous))).toBe("token-a");
      expect(pendingSignOutRecords(store)).toEqual([]);
      mockSecureStore(store);
      await resetApiBase();
    },
  );

  it("a save stopped by a session change stores a Space selected during its restoring write", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    let selecting: Promise<boolean> | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      if (key === "rakazo.space_id" && value === "space-old" && !selecting) {
        // A new selection lands before the rollback's restoring write.
        selecting = selectSpace("space-new");
        await selecting;
      }
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase(TWO);
    } finally {
      mockSecureStore(store);
    }

    expect(selecting).toBeDefined();
    expect(result).toMatchObject({ ok: false });
    expect(selectedSpaceId()).toBe("space-new");
    // The live selection wins; the per-server map is what a later launch reads, even
    // though the rollback's own write lands stale in the single live slot behind it.
    expect(spacesMap(store)[ONE]).toBe("space-new");
    expect(store.has("rakazo.space_rollback")).toBe(false);
    mockSecureStore(store);
    await resetApiBase();
  });

  it("a save stopped by a session change keeps a Space selected while it read the old one", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await clearSpace();
    // Stored but not yet cached, so the switch reads the selection from the store.
    store.set("rakazo.space_id", "space-old");
    let selecting: Promise<boolean> | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      const value = store.get(key) ?? null;
      if (key === "rakazo.space_id" && !selecting) {
        // A new selection lands after the switch read the old one.
        selecting = selectSpace("space-new");
        await selecting;
      }
      return value;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback" && value) await saveSessionToken("token-b");
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase("https://second-server.example");
    } finally {
      mockSecureStore(store);
    }

    expect(selecting).toBeDefined();
    expect(result).toMatchObject({ ok: false });
    expect(store.get("rakazo.space_id")).toBe("space-new");
    expect(store.has("rakazo.space_rollback")).toBe(false);
    await resetApiBase();
  });

  it("a reset that cannot clear the endpoint leaves its session intact, not revoked", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await saveApiBase("https://old-server.example");
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.delete(key);
    });
    let result: Awaited<ReturnType<typeof resetApiBase>>;
    try {
      result = await resetApiBase();
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);

    // The endpoint value never changed, so the old server is still current and its session
    // is intact.
    expect(result).toMatchObject({ ok: false });
    expect(store.get("rakazo.api_base")).toBe("https://old-server.example");
    expect(store.get(tokenKey("https://old-server.example"))).toBe("token-a");
    expect(currentApiBase()).toBe("https://old-server.example");
    const signOuts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/sign-out"),
    );
    expect(signOuts).toEqual([]);
    expect(pendingSignOutRecords(store)).toEqual([]);
    mockSecureStore(store);
    await resetApiBase();
  });

  it("a reset that cannot clear the endpoint leaves the next launch on the old server", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await saveApiBase("https://old-server.example");
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.delete(key);
    });
    let result: Awaited<ReturnType<typeof resetApiBase>>;
    try {
      result = await resetApiBase();
    } finally {
      mockSecureStore(store);
    }

    expect(result).toMatchObject({ ok: false });
    expect(currentApiBase()).toBe("https://old-server.example");

    // A restart opens the stored endpoint, so the old session is still the one in use.
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.currentApiBase()).toBe("https://old-server.example");
    await expect(restartedApi.authHeaders()).resolves.toMatchObject({
      authorization: "Bearer token-a",
      "x-rakazo-space-id": "space-old",
    });
    await restartedApiServer.resetApiBase();
  });

  it("a rolled-back switch keeps the session its endpoint write could not store", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase(TWO);
    } finally {
      mockSecureStore(store);
    }

    // Nothing was cleared, so the session is still stored for its server.
    expect(result).toMatchObject({ ok: false });
    expect(store.get(tokenKey(ONE))).toBe("token-a");
    expect(await authHeaders()).toMatchObject({ authorization: "Bearer token-a" });
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("a flush after a rolled-back switch sends no sign-out", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });
    try {
      await saveApiBase(TWO);
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await flushPendingSignOut(true);

    // token-a is still in use, so it is not revoked.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(tokenKey(ONE))).toBe("token-a");
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("a flush after a failed switch and a re-save of the same session sends no sign-out", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });
    try {
      await saveApiBase(TWO);
    } finally {
      mockSecureStore(store);
    }
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const saveHeld = deferred();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === tokenKey(ONE)) await saveHeld.promise;
      store.set(key, value);
    });
    // The same token is saved again; a flush runs while its write is held.
    const saving = saveSessionToken("token-a");
    await flushPendingSignOut(true);
    saveHeld.resolve();
    await saving;
    mockSecureStore(store);
    await flushPendingSignOut(true);

    // token-a is in use and now stored, so it is never revoked and no record exists.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.get(tokenKey(ONE))).toBe("token-a");
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("a hung session save defers only the current server's switch records", async () => {
    await resetApiBase();
    const record = (apiBase: string, token: string) => ({
      apiBase,
      token,
      headers: {},
      recordedAt: Date.now(),
      provisional: true,
    });
    const store = new Map<string, string>([
      [
        "rakazo.pending_sign_out",
        JSON.stringify([
          record("https://old-server.example", "token-a"),
          record(currentApiBase(), "token-c"),
        ]),
      ],
    ]);
    mockSecureStore(store);
    const saveHeld = deferred();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === tokenKey(ONE)) await saveHeld.promise;
      store.set(key, value);
    });
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    const signOuts = () =>
      fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith("/api/auth/sign-out"))
        .map(([url, init]) => [url, new Headers(init?.headers).get("authorization")]);
    const saving = saveSessionToken("token-b");
    await flushPendingSignOut(true);

    // The other server's session cannot be the one being saved here, so it is revoked now.
    expect(signOuts()).toEqual([
      ["https://old-server.example/api/auth/sign-out", "Bearer token-a"],
    ]);
    expect(pendingSignOutRecords(store).map((entry) => entry.token)).toEqual(["token-c"]);

    saveHeld.resolve();
    await saving;
    await flushPendingSignOut(true);
    expect(signOuts()).toEqual([
      ["https://old-server.example/api/auth/sign-out", "Bearer token-a"],
      [`${currentApiBase()}/api/auth/sign-out`, "Bearer token-c"],
    ]);
  });

  it("a server switch stops when a session is saved while it parks the old one", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    const previous = currentApiBase();
    await restoreSessionToken("token-a");
    await selectSpace("space-old");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      // A sign-in on the old server saves its token while the park writes the rollback record.
      if (key === "rakazo.space_rollback" && value) await saveSessionToken("token-b");
      store.set(key, value);
    });
    let result: Awaited<ReturnType<typeof saveApiBase>>;
    try {
      result = await saveApiBase(TWO);
    } finally {
      mockSecureStore(store);
    }

    // The old server's new token is never sent to the new server.
    expect(result).toEqual({ ok: false, error: "Could not clear the previous server session" });
    expect(currentApiBase()).toBe(previous);
    expect(store.get(tokenKey(previous))).toBe("token-b");
    expect(await authHeaders()).toMatchObject({ authorization: "Bearer token-b" });
    // The parked session is intact, so no revocation exists for it.
    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("records no revocation when switching servers without a session", async () => {
    const store = new Map<string, string>();
    mockSecureStore(store);

    await expect(saveApiBase("https://second-server.example")).resolves.toMatchObject({ ok: true });

    expect(pendingSignOutRecords(store)).toEqual([]);
    await resetApiBase();
  });

  it("refuses to switch endpoints when SecureStore cannot clear credentials", async () => {
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("device locked"));

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    expect(SecureStore.setItemAsync).not.toHaveBeenCalledWith(
      "rakazo.api_base",
      "https://second-server.example",
    );
  });

  it("restores notifications to the selected space when the endpoint write fails", async () => {
    await resetApiBase();
    const previousApiBase = currentApiBase();
    const store = new Map<string, string>([[tokenKey(ONE), "session-token"]]);
    mockSecureStore(store);
    await selectSpace("space-social");
    await selectSpace("space-support");
    vi.mocked(resumeLiveNotifications).mockClear();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });

    await expect(saveApiBase(TWO)).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
    expect(currentApiBase()).toBe(previousApiBase);
    expect(resumeLiveNotifications).toHaveBeenCalledWith(
      previousApiBase,
      "session-token",
      "space-support",
    );
    mockSecureStore(store);
    await resetApiBase();
  });

  it("reports a failed clear when the remembered organization Spaces stay on the device", async () => {
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.org_spaces") throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.org_spaces") throw new Error("device locked");
    });

    await expect(clearSpace()).resolves.toBe(false);
  });

  it("restores credentials when the new endpoint cannot be persisted", async () => {
    await resetApiBase();
    const previous = currentApiBase();
    const store = new Map<string, string>([[tokenKey(ONE), "session-token"]]);
    mockSecureStore(store);
    await selectSpace("space-support");
    vi.mocked(resumeLiveNotifications).mockClear();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });

    await expect(saveApiBase(TWO)).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalledWith("rakazo.org_spaces");
    expect(resumeLiveNotifications).toHaveBeenCalledWith(
      previous,
      "session-token",
      "space-support",
    );
    mockSecureStore(store);
    await resetApiBase();
  });

  it("restores a persisted space when its initial load failed", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await loadApiBase();
    const previous = currentApiBase();
    let spaceReads = 0;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key !== "rakazo.space_id") return null;
      spaceReads += 1;
      if (spaceReads === 1) throw new Error("device locked");
      return "space-support";
    });
    await loadApiBase();
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(authHeaders()).resolves.toEqual({
      "x-rakazo-space-id": "space-support",
    });
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("rakazo.space_id", "space-support");
  });

  it("refuses an endpoint switch when the active space cannot be snapshotted", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue(null);
    await loadApiBase();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
      return null;
    });
    await loadApiBase();
    vi.mocked(SecureStore.deleteItemAsync).mockClear();

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not clear the previous server session",
    });
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("preserves credentials when the active session cannot be snapshotted", async () => {
    await resetApiBase();
    await saveSessionToken("session-token");
    await selectSpace("space-support");
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("device locked"));
    vi.mocked(SecureStore.deleteItemAsync).mockClear();
    const previous = currentApiBase();
    const next =
      previous === "https://second-server.example"
        ? "https://third-server.example"
        : "https://second-server.example";

    await expect(saveApiBase(next)).resolves.toEqual({
      ok: false,
      error: "Could not save the previous server session",
    });
    expect(currentApiBase()).toBe(previous);
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();

    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === tokenKey(previous) ? "session-token" : null,
    );
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
  });

  it("a failed session clear still lets a switch park the stored token", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await saveSessionToken("session-token");
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === tokenKey(ONE)) throw new Error("device locked");
      store.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === tokenKey(ONE) && value === "") throw new Error("device locked");
      store.set(key, value);
    });
    await expect(clearSessionToken()).resolves.toBe(false);

    // The in-memory session reads as empty, but the stored token is still the parked session.
    await expect(snapshotSessionToken()).resolves.toEqual({ ok: true, value: "" });
    await expect(saveApiBase(TWO)).resolves.toMatchObject({ ok: true });
    expect(store.get(tokenKey(ONE))).toBe("session-token");
    expect(currentApiBase()).toBe(TWO);
    // Switching back restores the parked session without a sign-in.
    mockSecureStore(store);
    await resetApiBase();
    await expect(authHeaders()).resolves.toMatchObject({
      authorization: "Bearer session-token",
    });
  });

  it("keeps the in-memory session across consecutive failed endpoint switches", async () => {
    await resetApiBase();
    const store = new Map<string, string>([[tokenKey(ONE), "session-token"]]);
    mockSecureStore(store);
    await selectSpace("space-support");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
      store.set(key, value);
    });

    await expect(saveApiBase(TWO)).resolves.toMatchObject({ ok: false });
    await expect(saveApiBase(THREE)).resolves.toMatchObject({ ok: false });

    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });
    expect(currentApiBase()).toBe(ONE);
    expect(store.get(tokenKey(ONE))).toBe("session-token");
    mockSecureStore(store);
    await resetApiBase();
  });

  it("restores credentials when resetting the endpoint cannot be persisted", async () => {
    await resetApiBase();
    await saveApiBase(TWO);
    const previous = currentApiBase();
    const store = new Map<string, string>([[tokenKey(TWO), "session-token"]]);
    mockSecureStore(store);
    await selectSpace("space-support");
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.api_base") throw new Error("device locked");
    });

    await expect(resetApiBase()).resolves.toEqual({
      ok: false,
      error: "Could not clear the custom server URL",
    });
    expect(currentApiBase()).toBe(previous);
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer session-token",
      "x-rakazo-space-id": "space-support",
    });

    mockSecureStore(store);
    await resetApiBase();
  });

  it("recovers a deleted-space fallback over a stale saved selection after restart", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    storage.set("rakazo.saved_servers_seeded", "1");
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    // Stale deleted id is cleared even while the replacement write stays locked.
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("clears a deleted selection when every SecureStore write fails after delete", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.has("rakazo.space_rollback")).toBe(false);

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    // Cleared selection lets startup fall through to the server default.
    expect(restartedApi.selectedSpaceId()).toBeNull();
    await expect(restartedApiServer.selectInitialSpace("space-personal")).resolves.toBe(true);
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("drops a stale deleted selection when rollback recovery cannot rewrite SPACE_KEY", async () => {
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
      ],
    ]);
    storage.set("rakazo.saved_servers_seeded", "1");
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();

    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.has("rakazo.space_id")).toBe(false);
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-personal" }),
    );
  });

  it("recovers after restart when SecureStore could neither write nor clear after delete", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    await loadApiBase();

    await expect(selectSpace("space-personal")).resolves.toBe(false);
    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-deleted");

    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-deleted");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(restartedApi.rpc("spaces/list")).resolves.toEqual({ spaces: [] });
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]![1].headers["x-rakazo-space-id"]).toBe("space-deleted");
    expect(fetchMock.mock.calls[1]![1].headers["x-rakazo-space-id"]).toBeUndefined();
  });

  it("does not let a stale rollback override a saved deleted-space fallback", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    storage.set("rakazo.saved_servers_seeded", "1");
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      // clearStoredValue falls back to writing ""; keep that failing for rollback
      // so only an overwrite of the rollback payload can neutralize it.
      if (key === "rakazo.space_rollback" && value === "") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
    // Neutralization overwrote the stale rollback; best-effort clear may leave
    // the matching recovery payload when delete/empty writes stay locked.
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-personal" }),
    );

    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBe("space-personal");
    expect(storage.get("rakazo.space_id")).toBe("space-personal");
  });

  it("does not write SPACE_KEY beside a stale rollback when neutralization fails", async () => {
    const apiBase = "http://127.0.0.1:3100";
    const storage = new Map<string, string>([
      ["rakazo.space_id", "space-deleted"],
      ["rakazo.space_rollback", JSON.stringify({ apiBase, spaceId: "space-old" })],
    ]);
    storage.set("rakazo.saved_servers_seeded", "1");
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async () => {
      throw new Error("device locked");
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      // Block recoverSpaceRollback during loadApiBase, and block SPACE_KEY clears.
      // Writes of the new fallback id would succeed — the bug was doing that write
      // before neutralization, then failing to undo it.
      if (key === "rakazo.space_id" && (value === "" || value === "space-old")) {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });
    await loadApiBase();

    await expect(adoptDeletedSpaceFallback("space-personal")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-personal");
    // Must not leave the new selection durable beside the stale rollback.
    expect(storage.get("rakazo.space_id")).toBe("space-deleted");
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase, spaceId: "space-old" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_rollback") throw new Error("device locked");
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();
    // Restart may still recover the old rollback target, but must not have
    // replaced a newer SPACE_KEY fallback with it.
    expect(restartedApi.selectedSpaceId()).toBe("space-old");
    expect(storage.get("rakazo.space_id")).toBe("space-old");
  });

  it("heals durable divergence when persisting a new Space fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    await expect(selectSpace("space-support")).resolves.toBe(true);
    // A concurrent recovery persisted the claimed id, then the selection
    // write below fails and rolls the claim back.
    storage.set("rakazo.space_id", "space-new");
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-new") {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });

    await expect(selectSpace("space-new")).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
  });

  it("keeps a newer overlapping selection when an older persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let rejectA!: Deferred<never>;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        rejectA = deferred<never>();
        await rejectA.promise;
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    rejectA.reject(new Error("device locked"));

    await expect(pendingA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
  });

  it("does not commit a selection superseded during rollback cleanup", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-current"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let releaseOlderCleanup!: Deferred;
    let heldOlderCleanup = false;
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_rollback" && !heldOlderCleanup) {
        heldOlderCleanup = true;
        releaseOlderCleanup = deferred();
        await releaseOlderCleanup.promise;
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    await loadApiBase();
    expect(selectedSpaceId()).toBe("space-current");

    const previousSeq = spaceSelectionSeq();
    const pendingOlder = selectSpace("space-older");
    expect(spaceSelectionSeq()).toBe(previousSeq + 1);
    expect(selectedSpaceId()).toBe("space-current");
    await vi.waitFor(() => expect(heldOlderCleanup).toBe(true));
    await expect(selectSpace("space-newer")).resolves.toBe(true);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");

    releaseOlderCleanup.resolve();
    await expect(pendingOlder).resolves.toBe(false);
    expect(spaceSelectionSeq()).toBe(previousSeq + 2);
    expect(selectedSpaceId()).toBe("space-newer");
    expect(storage.get("rakazo.space_id")).toBe("space-newer");
  });

  it("converges durable state to the latest overlapping selection", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let resolveA!: Deferred;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        resolveA = deferred();
        await resolveA.promise;
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    // The older write lands stale after the newer one completed.
    resolveA.resolve();

    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledTimes(1);
    expect(resumeLiveNotifications).toHaveBeenLastCalledWith(
      currentApiBase(),
      expect.anything(),
      "space-b",
    );
  });

  it("does not restore the first selection after switching away and back", async () => {
    const storage = new Map<string, string>([[tokenKey(ONE), "fake-token"]]);
    storage.set("rakazo.saved_servers_seeded", "1");
    let releaseFirstA!: Deferred;
    let firstA = true;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a" && firstA) {
        firstA = false;
        releaseFirstA = deferred();
        await releaseFirstA.promise;
      }
      storage.set(key, value);
    });
    await loadApiBase();
    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(firstA).toBe(false));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    releaseFirstA.resolve();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    expect(resumeLiveNotifications).toHaveBeenCalledTimes(2);
    expect(resumeLiveNotifications).toHaveBeenLastCalledWith(
      currentApiBase(),
      "fake-token",
      "space-a",
    );
  });

  it("does not restore an obsolete selection after its token read finishes", async () => {
    const storage = new Map<string, string>([[tokenKey(ONE), "fake-token"]]);
    storage.set("rakazo.saved_servers_seeded", "1");
    let releaseToken!: Deferred;
    let tokenReadHeld = false;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === tokenKey(ONE) && !tokenReadHeld) {
        tokenReadHeld = true;
        releaseToken = deferred();
        await releaseToken.promise;
      }
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();

    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(tokenReadHeld).toBe(true));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    releaseToken.resolve();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(storage.get("rakazo.space_id")).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-b");
  });

  it("does not resume a deleted-space fallback after a newer Space is selected", async () => {
    const storage = new Map<string, string>([[tokenKey(ONE), "fake-token"]]);
    storage.set("rakazo.saved_servers_seeded", "1");
    let releaseToken!: Deferred;
    let tokenReadHeld = false;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === tokenKey(ONE) && !tokenReadHeld) {
        tokenReadHeld = true;
        releaseToken = deferred();
        await releaseToken.promise;
      }
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    vi.mocked(resumeLiveNotifications).mockClear();

    const pending = adoptDeletedSpaceFallback("space-fallback");
    await vi.waitFor(() => expect(tokenReadHeld).toBe(true));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    releaseToken.resolve();
    await expect(pending).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-b");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-b");
  });

  it("resumes the fallback Space after failed auth recovery invalidates its pending resume", async () => {
    const storage = new Map<string, string>([[tokenKey(ONE), "fake-token"]]);
    storage.set("rakazo.saved_servers_seeded", "1");
    let releaseToken!: Deferred;
    let tokenReadHeld = false;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
      if (key === tokenKey(ONE) && !tokenReadHeld) {
        tokenReadHeld = true;
        releaseToken = deferred();
        await releaseToken.promise;
      }
      return storage.get(key) ?? null;
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    await loadApiBase();
    vi.mocked(resumeLiveNotifications).mockClear();

    const pending = adoptDeletedSpaceFallback("space-fallback");
    await vi.waitFor(() => expect(tokenReadHeld).toBe(true));
    let releaseResume!: () => void;
    vi.mocked(resumeLiveNotifications).mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseResume = () => resolve(true);
        }),
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
        .mockRejectedValueOnce(new Error("Network unavailable")),
    );
    await expect(rpc("spaces/list")).rejects.toThrow("Network unavailable");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    releaseResume();
    releaseToken.resolve();
    await expect(pending).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-fallback");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(
      currentApiBase(),
      "fake-token",
      "space-fallback",
    );
  });

  it("restores notifications for the previous selection when a newer persist fails", async () => {
    const storage = new Map<string, string>([[tokenKey(ONE), "fake-token"]]);
    storage.set("rakazo.saved_servers_seeded", "1");
    let releaseA!: Deferred;
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        releaseA = deferred();
        await releaseA.promise;
      }
      if (key === "rakazo.space_id" && value === "space-b") throw new Error("device locked");
      storage.set(key, value);
    });
    await loadApiBase();
    const pendingA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    // Let rollback's recovery write complete without waiting on the older write.
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-b") throw new Error("device locked");
      storage.set(key, value);
    });
    await expect(selectSpace("space-b")).resolves.toBe(false);
    releaseA.resolve();
    await expect(pendingA).resolves.toBe(true);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    expect(resumeLiveNotifications).toHaveBeenCalledOnce();
    expect(resumeLiveNotifications).toHaveBeenCalledWith(currentApiBase(), "fake-token", "space-a");
  });

  it("keeps a later A claim when an earlier A→B→A persist fails", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-support"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    let firstAWriteCount = 0;
    let rejectFirstA!: Deferred<never>;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-a") {
        firstAWriteCount += 1;
        if (firstAWriteCount === 1) {
          rejectFirstA = deferred<never>();
          await rejectFirstA.promise;
        }
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const pendingFirstA = selectSpace("space-a");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-a"));
    await expect(selectSpace("space-b")).resolves.toBe(true);
    await expect(selectSpace("space-a")).resolves.toBe(true);
    expect(storage.get("rakazo.space_id")).toBe("space-a");
    rejectFirstA.reject(new Error("device locked"));

    await expect(pendingFirstA).resolves.toBe(false);
    expect(selectedSpaceId()).toBe("space-a");
    expect(storage.get("rakazo.space_id")).toBe("space-a");
  });

  it("does not let auth cleanup overwrite a newer selection with a stale snapshot", async () => {
    const storage = new Map<string, string>([["rakazo.space_id", "space-deleted"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    let injected = false;
    let holdCleanupReconcile = false;
    const cleanupWriteHeld = deferred();
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "rakazo.space_id" && !injected) {
        injected = true;
        // Finish selecting B before cleanup snapshots it for reconcile.
        await expect(selectSpace("space-b")).resolves.toBe(true);
        holdCleanupReconcile = true;
      }
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.space_id" && value === "space-b" && holdCleanupReconcile) {
        holdCleanupReconcile = false;
        // Hold only the post-clear reconcile write of the B snapshot.
        await cleanupWriteHeld.promise;
      }
      storage.set(key, value);
    });
    await loadApiBase();

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(rpcErrorResponse(401, "UNAUTHORIZED", "Unauthorized"))
      .mockResolvedValueOnce(jsonResponse({ json: { spaces: [] } }));
    vi.stubGlobal("fetch", fetchMock);

    const pendingRpc = rpc("spaces/list");
    await vi.waitFor(() => expect(selectedSpaceId()).toBe("space-b"));
    await expect(selectSpace("space-c")).resolves.toBe(true);
    expect(storage.get("rakazo.space_id")).toBe("space-c");
    cleanupWriteHeld.resolve();

    await expect(pendingRpc).resolves.toEqual({ spaces: [] });
    expect(selectedSpaceId()).toBe("space-c");
    expect(storage.get("rakazo.space_id")).toBe("space-c");
  });

  it("recovers the active space after rollback persistence fails", async () => {
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) =>
      key === "rakazo.saved_servers_seeded" ? "1" : null,
    );
    await loadApiBase();
    await selectSpace("space-support");

    const storage = new Map<string, string>();
    storage.set("rakazo.saved_servers_seeded", "1");
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "rakazo.api_base" || (key === "rakazo.space_id" && value === "space-support")) {
        throw new Error("device locked");
      }
      storage.set(key, value);
    });

    await expect(saveApiBase("https://second-server.example")).resolves.toEqual({
      ok: false,
      error: "Could not save the server URL",
    });
    await expect(authHeaders()).resolves.toEqual({
      "x-rakazo-space-id": "space-support",
    });
    expect(storage.get("rakazo.space_rollback")).toBe(
      JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-support" }),
    );

    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");
    await restartedApiServer.loadApiBase();

    expect(restartedApi.selectedSpaceId()).toBe("space-support");
    expect(storage.get("rakazo.space_id")).toBe("space-support");
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("does not recover a space on a different endpoint", async () => {
    const storage = new Map([
      ["rakazo.api_base", "https://second-server.example"],
      [
        "rakazo.space_rollback",
        JSON.stringify({ apiBase: "http://127.0.0.1:3100", spaceId: "space-support" }),
      ],
    ]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");

    await expect(restartedApiServer.loadApiBase()).resolves.toBe("https://second-server.example");
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("removes a malformed space rollback record", async () => {
    const storage = new Map([["rakazo.space_rollback", "null"]]);
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");

    await restartedApiServer.loadApiBase();
    expect(restartedApi.selectedSpaceId()).toBeNull();
    expect(storage.has("rakazo.space_rollback")).toBe(false);
  });

  it("parks and restores sessions across a round trip without signing in again", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-a");

    await expect(saveApiBase(TWO)).resolves.toMatchObject({ ok: true });
    expect(currentApiBase()).toBe(TWO);
    await expect(authHeaders()).resolves.toEqual({});
    expect(store.get(tokenKey(ONE))).toBe("token-a");

    await restoreSessionToken("token-b");
    await selectSpace("space-b");
    await expect(resetApiBase()).resolves.toMatchObject({ ok: true });
    expect(currentApiBase()).toBe(ONE);
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer token-a",
      "x-rakazo-space-id": "space-a",
    });
    expect(store.get(tokenKey(TWO))).toBe("token-b");
    await resetApiBase();
  });

  it("switching to an unsigned server leaves the previous session parked", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-a");

    await expect(saveApiBase(TWO)).resolves.toMatchObject({ ok: true });
    await expect(authHeaders()).resolves.toEqual({});
    expect(store.get(tokenKey(ONE))).toBe("token-a");

    await expect(resetApiBase()).resolves.toMatchObject({ ok: true });
    await expect(authHeaders()).resolves.toEqual({
      authorization: "Bearer token-a",
      "x-rakazo-space-id": "space-a",
    });
    await resetApiBase();
  });

  it("never sends a token to the wrong origin after a switch", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await saveApiBase(TWO, {});
    await restoreSessionToken("token-b");
    const fetchMock = vi.fn<typeof globalThis.fetch>(async () =>
      jsonResponse({ json: { spaces: [] } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(rpc("spaces/list")).resolves.toEqual({ spaces: [] });
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      url: String(url),
      authorization: new Headers(init?.headers).get("authorization"),
    }));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.startsWith(TWO)).toBe(true);
    expect(calls[0]?.authorization).toBe("Bearer token-b");
    expect(calls.some((call) => call.url.startsWith(ONE))).toBe(false);
    mockSecureStore(store);
    await resetApiBase();
  });

  it("resumes push on the target server after a switch and never stops it", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await selectSpace("space-a");
    await saveApiBase(TWO, {});
    await restoreSessionToken("token-b");
    await selectSpace("space-b");
    vi.mocked(resumeLiveNotifications).mockClear();
    vi.mocked(stopLiveNotifications).mockClear();
    vi.mocked(registerPushToken).mockClear();

    await expect(resetApiBase()).resolves.toMatchObject({ ok: true });
    expect(resumeLiveNotifications).toHaveBeenCalledWith(ONE, "token-a", "space-a");
    expect(stopLiveNotifications).not.toHaveBeenCalled();
    expect(registerPushToken).toHaveBeenCalled();
    await resetApiBase();
  });

  it("signing out revokes exactly one server", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await restoreSessionToken("token-a");
    await saveApiBase(TWO, {});
    await restoreSessionToken("token-b");
    await resetApiBase();
    await expect(authHeaders()).resolves.toMatchObject({ authorization: "Bearer token-a" });

    const fetchMock = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);
    await signOut();
    await flushPendingSignOut(true);

    const signOuts = fetchMock.mock.calls.filter(([url]) =>
      String(url).endsWith("/api/auth/sign-out"),
    );
    expect(signOuts.map(([url]) => url)).toEqual([`${ONE}/api/auth/sign-out`]);
    const [, init] = signOuts[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ authorization: "Bearer token-a" });
    expect(pendingSignOutRecords(store)).toEqual([]);
    expect(store.get(tokenKey(TWO))).toBe("token-b");
    expect(store.has(tokenKey(ONE))).toBe(false);
    await resetApiBase();
  });

  it("remembers each server's Space across a switch", async () => {
    await resetApiBase();
    const store = new Map<string, string>();
    mockSecureStore(store);
    await selectSpace("space-a");
    await saveApiBase(TWO, {});
    expect(selectedSpaceId()).toBeNull();
    await selectSpace("space-b");
    await resetApiBase();
    expect(selectedSpaceId()).toBe("space-a");
    expect(spacesMap(store)).toEqual({ [ONE]: "space-a", [TWO]: "space-b" });
    await resetApiBase();
  });

  it("recovers the parked Space when the stored selection belongs to another server", async () => {
    await resetApiBase();
    const store = new Map<string, string>([
      ["rakazo.api_base", TWO],
      ["rakazo.space_id", "space-a"],
      ["rakazo.server_spaces", JSON.stringify({ [TWO]: "space-b" })],
      [tokenKey(TWO), "token-b"],
    ]);
    mockSecureStore(store);
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");

    await expect(restartedApiServer.loadApiBase()).resolves.toBe(TWO);
    expect(restartedApi.selectedSpaceId()).toBe("space-b");
    expect(store.get("rakazo.space_id")).toBe("space-b");
    await expect(restartedApi.authHeaders()).resolves.toMatchObject({
      authorization: "Bearer token-b",
      "x-rakazo-space-id": "space-b",
    });
    await restartedApiServer.resetApiBase();
  });

  it("adopts a legacy session for the server a restart opens", async () => {
    await resetApiBase();
    const legacyServer = "https://legacy-server.example";
    const store = new Map<string, string>([
      ["rakazo.api_base", legacyServer],
      ["rakazo.session_token", "legacy-token"],
    ]);
    mockSecureStore(store);
    vi.resetModules();
    const restartedApi = await import("./api.js");
    const restartedApiServer = await import("./api-server.js");

    await expect(restartedApiServer.loadApiBase()).resolves.toBe(legacyServer);
    await expect(restartedApi.authHeaders()).resolves.toMatchObject({
      authorization: "Bearer legacy-token",
    });
    expect(store.get(tokenKey(legacyServer))).toBe("legacy-token");
    expect(store.has("rakazo.session_token")).toBe(false);
    await restartedApiServer.resetApiBase();
  });
});
