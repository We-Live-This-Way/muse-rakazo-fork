import { bestEffort } from "@rakazo/logging/best-effort";
import * as SecureStore from "expo-secure-store";
import {
  invalidateArtifactCacheSession,
  rotateArtifactCacheSession,
  rotatedArtifactCacheToken,
} from "../artifacts/artifact-cache-session";
import { rememberSignedIn } from "../auth/returning-user";
import { forgetReferrals } from "../billing/referral";
import { stopLiveNotifications } from "../notifications/live-notifications";
import { clearFailedSends } from "../thread/send/thread-feedback";
import { defaultApiBase } from "./endpoint";
import { clearNetworkCache } from "./network-cache";

/** One token per server, so switching servers parks the session instead of ending it. */
const SESSION_KEY_PREFIX = "rakazo.session_token:";
/** The single-key era's token. Migration source only, never written again. */
const LEGACY_SESSION_KEY = "rakazo.session_token";
// Named for the screen that first kept it; renaming it would drop every saved identity.
const VERIFIED_SCOPE_KEY = "rakazo.integrations-scope";

/** The token key for one server. `apiBase` is a normalized origin, so two servers never share one. */
export function sessionKeyFor(apiBase: string): string {
  return `${SESSION_KEY_PREFIX}${apiBase}`;
}

/**
 * The server the token functions read and write for. `session.ts` is imported by `api.ts`, so it
 * cannot read `currentApiBase()` back without a cycle; only `api-server.ts` writes this, always
 * in step with `setCachedApiBase()`. Invariant: it equals `currentApiBase()` before any token
 * operation. Writers are `loadApiBase()` at boot and the switch commit point.
 */
let activeApiBase = defaultApiBase();
export function setSessionServer(apiBase: string): void {
  activeApiBase = apiBase;
  // The invalidation belongs to the previous server's in-memory session: a save that failed
  // there must not suppress the new server's stored token, which is read fresh below.
  sessionInvalidated = false;
  sessionFallback = undefined;
}

function currentSessionKey(): string {
  return sessionKeyFor(activeApiBase);
}

/**
 * A server switch moved the active session without changing any stored token. Bumping the
 * generation discards in-flight old-server requests and remounts the inbox, which re-reads the
 * token for the new server; the verified scope is invalidated in memory only, so the next
 * `verifiedScope()` call re-verifies with one `me` call. The artifact namespace and disk caches
 * are deliberately untouched: the parked server's data stays filed under its own scope.
 */
export function noteSessionServerChange(): void {
  sessionGeneration += 1;
  scopeInvalidated = true;
  sessionFallback = undefined;
  publishSessionGeneration();
}

/** The server a legacy-token migration last completed for; a new server re-runs it. */
let migratedApiBase: string | undefined;

/**
 * Adopts the single-key era's token into the current server's per-origin key, once per server.
 * True when there is nothing left to adopt for this server. The legacy token necessarily belongs
 * to the stored current server, because the old app only ever had one server at a time.
 */
export async function ensureLegacySessionMigrated(): Promise<void> {
  if (migratedApiBase === activeApiBase) return;
  const server = activeApiBase;
  const generation = sessionGeneration;
  let done = false;
  try {
    const key = sessionKeyFor(server);
    const current = await SecureStore.getItemAsync(key);
    if (current) {
      // The per-origin token wins. A legacy key that differs can only be a leftover of a
      // half-finished earlier migration, since nothing in the fork ever writes it, so it goes too.
      await bestEffort(
        "delete the migrated legacy session token",
        SecureStore.deleteItemAsync(LEGACY_SESSION_KEY),
      );
      done = true;
    } else {
      const legacy = await SecureStore.getItemAsync(LEGACY_SESSION_KEY);
      if (!legacy) {
        done = true;
      } else if (generation !== sessionGeneration) {
        // A sign-in landed while this read was in flight; its token owns the store now.
        done = true;
      } else {
        let adopted = false;
        try {
          await SecureStore.setItemAsync(key, legacy);
          adopted = true;
        } catch {
          // Keep the legacy key and treat the session as memory-only; a restart loses it, and
          // the next launch retries the adoption.
          sessionFallback = legacy;
        }
        if (adopted) {
          await bestEffort(
            "delete the migrated legacy session token",
            SecureStore.deleteItemAsync(LEGACY_SESSION_KEY),
          );
        }
        done = true;
      }
    }
  } catch {
    // An unreadable store leaves the adoption for a later read; the token read reports it.
    done = false;
  }
  if (done && activeApiBase === server) migratedApiBase = server;
}

export type SavedVerifiedScope = {
  apiBase: string;
  userId: string;
  spaceId: string;
  selectionId: string | null;
};
let scopeInvalidated = false;
let scopeWrites: Promise<void> = Promise.resolve();

function enqueueScopeWrite<T>(task: () => Promise<T>): Promise<T> {
  const next = scopeWrites.then(task, task);
  scopeWrites = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

const sessionDiskCaches = new Set<(sameAccount: boolean) => void | Promise<void>>();

/** Registers a cache wipe; a verified same-account replacement can keep account-scoped data. */
export function registerSessionDiskCache(
  clear: (sameAccount: boolean) => void | Promise<void>,
): void {
  sessionDiskCaches.add(clear);
}

/**
 * `keepUnsent` is for a new token of the same account and server; its unsent messages stay.
 * `rejectedUnsent` keeps only the queue of a session the server rejected, so the sign-in
 * warning can still report those messages; it grants no same-account data.
 */
function invalidateSessionCaches(
  keepUnsent = false,
  sameAccount = keepUnsent,
  rejectedUnsent = false,
): Promise<void> {
  scopeInvalidated = true;
  if (!keepUnsent && !rejectedUnsent) clearFailedSends();
  clearNetworkCache();
  // Another account must never see, or share, the previous owner's invite link.
  forgetReferrals();
  for (const clear of sessionDiskCaches) {
    try {
      // Optional caches must never hold up credential writes, even if their storage stalls.
      void Promise.resolve(clear(sameAccount)).catch(() => undefined);
    } catch {
      // A failed disk wipe must not block the session change or the other wipes.
    }
  }
  const clearingArtifacts = keepUnsent ? undefined : invalidateArtifactCacheSession();
  return enqueueScopeWrite(async () => {
    await clearingArtifacts;
    try {
      await SecureStore.deleteItemAsync(VERIFIED_SCOPE_KEY);
    } catch {
      try {
        await SecureStore.setItemAsync(VERIFIED_SCOPE_KEY, "");
      } catch {
        // A failed wipe remains invalid in memory; token matching gates future reads.
      }
    }
  });
}

export async function loadVerifiedScope(): Promise<SavedVerifiedScope | null> {
  const generation = sessionGeneration;
  if (scopeInvalidated) return null;
  try {
    const token = await snapshotSessionToken();
    const stored = await SecureStore.getItemAsync(VERIFIED_SCOPE_KEY);
    if (
      !token.ok ||
      !token.value ||
      !stored ||
      generation !== sessionGeneration ||
      scopeInvalidated
    )
      return null;
    const data = JSON.parse(stored);
    if (
      data.token !== token.value ||
      typeof data.apiBase !== "string" ||
      !data.apiBase ||
      typeof data.userId !== "string" ||
      !data.userId ||
      typeof data.spaceId !== "string" ||
      !data.spaceId ||
      !(data.selectionId === null || typeof data.selectionId === "string")
    )
      return null;
    return {
      apiBase: data.apiBase,
      userId: data.userId,
      spaceId: data.spaceId,
      selectionId: data.selectionId,
    };
  } catch {
    return null;
  }
}

export async function saveVerifiedScope(
  generation: number,
  scope: SavedVerifiedScope,
): Promise<void> {
  // The launch's first token read queues its recovery write, so it cannot run inside the queue.
  if (!(await snapshotSessionToken()).ok) return;
  return enqueueScopeWrite(async () => {
    if (generation !== sessionGeneration) return;
    const token = await snapshotSessionToken();
    if (!token.ok || !token.value || generation !== sessionGeneration) return;
    try {
      await SecureStore.setItemAsync(
        VERIFIED_SCOPE_KEY,
        JSON.stringify({ ...scope, token: token.value }),
      );
      if (generation === sessionGeneration) scopeInvalidated = false;
    } catch {
      // Verified scope persistence is optional.
    }
  });
}

/** In-memory gate so a failed SecureStore wipe cannot keep sending the old bearer. */
let sessionInvalidated = false;
let sessionFallback: string | undefined;
/** Bumped by every session change, so a late response can tell it no longer owns the session. */
let sessionGeneration = 0;

let readySessionGeneration = 0;
export function currentReadySessionGeneration() {
  return readySessionGeneration;
}
const sessionListeners = new Set<() => void>();
export function subscribeSessionGeneration(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => {
    sessionListeners.delete(listener);
  };
}
function publishSessionGeneration(ready = true) {
  if (ready) readySessionGeneration = sessionGeneration;
  for (const listener of sessionListeners) {
    try {
      listener();
    } catch {
      /* Observers cannot block an authentication change. */
    }
  }
}

export function currentSessionGeneration() {
  return sessionGeneration;
}

/** Token saves still running; a read during one sees no session until its token lands. */
let sessionSaves = 0;
export function sessionSaveInProgress() {
  return sessionSaves > 0;
}

/** True while the active token is only in memory after a failed save; a restart loses it. */
export function sessionOnlyInMemory() {
  return sessionFallback !== undefined;
}

export async function loadSessionToken() {
  const snapshot = await snapshotSessionToken();
  return snapshot.ok ? snapshot.value : "";
}

export async function saveSessionToken(token: string) {
  const generation = ++sessionGeneration;
  publishSessionGeneration(false);
  sessionInvalidated = true;
  sessionFallback = undefined;
  sessionSaves += 1;
  try {
    const clearingScope = invalidateSessionCaches();
    // Marked before the token lands, so an account deletion that clears it afterwards also clears the mark.
    await rememberSignedIn();
    await enqueueScopeWrite(() => SecureStore.setItemAsync(currentSessionKey(), token));
    await clearingScope;
  } finally {
    sessionSaves -= 1;
  }
  if (generation !== sessionGeneration) return;
  sessionInvalidated = false;
  sessionFallback = undefined;
  if (generation === sessionGeneration) publishSessionGeneration();
}

/**
 * Clears the session. Returns false only when SecureStore could neither delete nor overwrite.
 * `keepUnsent` leaves the unsent queue in place for a session the server rejected; signing
 * out and signing in clear the queue themselves.
 */
export async function clearSessionToken(options: { keepUnsent?: boolean } = {}): Promise<boolean> {
  const generation = ++sessionGeneration;
  publishSessionGeneration(false);
  sessionInvalidated = true;
  sessionFallback = undefined;
  const clearingScope = invalidateSessionCaches(false, false, options.keepUnsent);
  const clearingToken = clearStoredSessionToken(generation);
  await stopLiveNotifications(true).catch(() => undefined);
  const tokenCleared = await clearingToken;
  await clearingScope;
  if (generation === sessionGeneration) publishSessionGeneration();
  return tokenCleared;
}

async function clearStoredSessionToken(generation: number): Promise<boolean> {
  return enqueueScopeWrite(async () => {
    let cleared = false;
    try {
      await SecureStore.deleteItemAsync(currentSessionKey());
      cleared = true;
    } catch {
      try {
        await SecureStore.setItemAsync(currentSessionKey(), "");
        cleared = true;
      } catch {
        // A failed wipe keeps the bearer invalid in memory.
      }
    }
    if (generation === sessionGeneration) {
      sessionInvalidated = !cleared;
      sessionFallback = undefined;
    }
    return cleared;
  });
}

/**
 * Restores the current-server session in memory even when persistence is unavailable. False when
 * saving the token failed and only memory holds it.
 */
export async function restoreSessionToken(token: string): Promise<boolean> {
  const generation = ++sessionGeneration;
  publishSessionGeneration(false);
  const clearingScope = invalidateSessionCaches();
  if (!token) {
    await clearingScope;
    if (generation !== sessionGeneration) return true;
    sessionInvalidated = false;
    sessionFallback = undefined;
    if (generation === sessionGeneration) publishSessionGeneration();
    return true;
  }
  try {
    await saveSessionToken(token);
    return true;
  } catch {
    if (sessionGeneration === generation + 1) {
      sessionInvalidated = false;
      sessionFallback = token;
      publishSessionGeneration();
    }
    return false;
  }
}

/**
 * Replaces the session only if nothing changed it since `generation` was read. The check and the
 * write start in the same tick, so a sign-out that begins later clears the replacement too.
 */
export async function replaceSessionTokenIfCurrent(
  generation: number,
  token: string,
): Promise<boolean> {
  if (generation !== sessionGeneration) return false;
  try {
    await saveSessionToken(token);
  } catch (error) {
    // The server already revoked the stored token; keep the replacement in memory unless
    // something else changed the session meanwhile, and still report that it was not saved.
    if (sessionGeneration === generation + 1) {
      sessionInvalidated = false;
      sessionFallback = token;
      publishSessionGeneration();
    }
    throw error;
  }
  return true;
}

/** A password change's token kept only in memory until it is saved with its cache namespace. */
let unsavedRotation: { generation: number; token: string } | undefined;

/**
 * Replaces the token the server reissued for the same account after a password change. Unlike
 * `replaceSessionTokenIfCurrent`, it keeps unsent messages and the cache namespace they live in.
 * The token is saved only after that namespace, which also records it as the revoked token's
 * replacement; a restart between the two saves adopts it. If a save fails, the token stays in
 * memory until `saveRotatedSessionToken`.
 */
export async function rotateSessionTokenIfCurrent(
  generation: number,
  previous: string,
  token: string,
): Promise<boolean> {
  if (generation !== sessionGeneration) return false;
  const rotation = ++sessionGeneration;
  publishSessionGeneration(false);
  sessionInvalidated = true;
  sessionFallback = undefined;
  unsavedRotation = undefined;
  const clearingScope = invalidateSessionCaches(true);
  sessionSaves += 1;
  try {
    await rotateArtifactCacheSession(previous, token);
    await saveRotatedToken(rotation, token);
  } catch (error) {
    if (rotation === sessionGeneration) {
      sessionInvalidated = false;
      sessionFallback = token;
      unsavedRotation = { generation: rotation, token };
      publishSessionGeneration();
    }
    throw error;
  } finally {
    sessionSaves -= 1;
  }
  await clearingScope;
  if (rotation === sessionGeneration) {
    sessionInvalidated = false;
    publishSessionGeneration();
  }
  return true;
}

/** Retries saving a password change's token kept in memory; true when it saved one. */
export async function saveRotatedSessionToken(): Promise<boolean> {
  const pending = unsavedRotation;
  if (pending?.generation !== sessionGeneration) return false;
  await rotateArtifactCacheSession(pending.token, pending.token);
  await saveRotatedToken(pending.generation, pending.token);
  if (unsavedRotation !== pending || pending.generation !== sessionGeneration) return false;
  unsavedRotation = undefined;
  sessionFallback = undefined;
  return true;
}

/** Runs before the first token read of a launch; one that could not read runs again. */
let recovery: Promise<boolean> | undefined;

/**
 * Adopts the token of a password change that stopped after its namespace was saved. False when
 * the store could not be read, so it is unknown whether the saved token was revoked.
 */
async function recoverRotatedToken(): Promise<boolean> {
  // A session change in this launch owns the store; nothing is left to recover.
  if (sessionGeneration !== 0) return true;
  const generation = sessionGeneration;
  let token: string | undefined;
  try {
    const stored = await SecureStore.getItemAsync(currentSessionKey());
    // Only the token the change replaced is swapped; any other session ignores the record.
    token = stored ? await rotatedArtifactCacheToken(stored) : undefined;
  } catch {
    return generation !== sessionGeneration;
  }
  if (!token || generation !== sessionGeneration) return true;
  try {
    await saveRotatedToken(generation, token);
  } catch {
    if (generation !== sessionGeneration) return true;
    sessionFallback = token;
    unsavedRotation = { generation, token };
  }
  return true;
}

/** Writes the token unless another session change started; that change then owns the store. */
function saveRotatedToken(generation: number, token: string): Promise<void> {
  return enqueueScopeWrite(async () => {
    if (generation === sessionGeneration)
      await SecureStore.setItemAsync(currentSessionKey(), token);
  });
}

/** Snapshots the active token without treating an unreadable store as an empty session. */
export async function snapshotSessionToken(): Promise<{ ok: true; value: string } | { ok: false }> {
  // The legacy token is adopted before the rotation recovery reads the store, so a password
  // change that stopped mid-migration still finds the token it replaced.
  await ensureLegacySessionMigrated();
  recovery ??= recoverRotatedToken();
  const attempt = recovery;
  if (!(await attempt)) {
    // The saved token may be the revoked one; the next read tries again.
    if (recovery === attempt) recovery = undefined;
    return { ok: false };
  }
  if (sessionFallback !== undefined) return { ok: true, value: sessionFallback };
  if (sessionInvalidated) return { ok: true, value: "" };
  const generation = sessionGeneration;
  try {
    const value = (await SecureStore.getItemAsync(currentSessionKey())) ?? "";
    return {
      ok: true,
      value: generation === sessionGeneration && !sessionInvalidated ? value : "",
    };
  } catch {
    return { ok: false };
  }
}

/**
 * The stored token, even one this launch stopped sending after a failed save or wipe: a restart
 * would send it again, so discarding it must revoke it.
 */
export async function snapshotStoredSessionToken(): Promise<
  { ok: true; value: string } | { ok: false }
> {
  await ensureLegacySessionMigrated();
  try {
    return { ok: true, value: (await SecureStore.getItemAsync(currentSessionKey())) ?? "" };
  } catch {
    return { ok: false };
  }
}

/**
 * The token stored for a server without making it active, so a switch can read the target's
 * parked session before the commit point. No migration: the legacy token belongs to the boot
 * server, which is already the active one when a switch starts.
 */
export async function snapshotStoredSessionTokenFor(
  apiBase: string,
): Promise<{ ok: true; value: string } | { ok: false }> {
  try {
    return { ok: true, value: (await SecureStore.getItemAsync(sessionKeyFor(apiBase))) ?? "" };
  } catch {
    return { ok: false };
  }
}

/**
 * The server only accepts a signed bearer. `set-auth-token` and the session cookie are signed on
 * every server version; the body token is signed only by servers that refuse unsigned bearers.
 */
export function tokenFromAuthResponse(res: Response, body: unknown) {
  const cookies = res.headers.get("set-cookie") ?? "";
  const encoded =
    res.headers.get("set-auth-token") ||
    cookies.match(/(?:^|,\s*)(?:__Secure-)?better-auth\.session_token=([^;,]*)/)?.[1];
  if (!encoded) return jsonToken(body);
  try {
    return decodeURIComponent(encoded);
  } catch {
    return "";
  }
}

function jsonToken(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;
  if (typeof record.token === "string" && record.token) return record.token;
  const session = record.session;
  if (
    session &&
    typeof session === "object" &&
    typeof (session as { token?: string }).token === "string"
  ) {
    return (session as { token: string }).token;
  }
  return "";
}
