import { t } from "@lingui/core/macro";
import { bestEffort } from "@rakazo/logging/best-effort";
import * as SecureStore from "expo-secure-store";
import { resumeLiveNotifications } from "../notifications/live-notifications";
import { registerPushToken } from "../notifications/push";
import {
  clearStoredValue,
  currentApiBase,
  currentSpaceSelectionGeneration,
  flushPendingSignOut,
  nextSpaceSelectionRequest,
  queueEndpointChange,
  rawSelectedSpaceId,
  resumeSelectedSpaceNotifications,
  SPACE_KEY,
  SPACE_ROLLBACK_KEY,
  selectedSpaceId,
  setCachedApiBase,
  setSelectedSpace,
  spaceSelectionSeq,
  writeStoredValue,
} from "./api";
import type { EndpointResult } from "./endpoint";
import { defaultApiBase, normalizeApiBase } from "./endpoint";
import {
  loadSavedServers,
  MAUSHAUS_API_BASE,
  recordSavedServer,
  savedServersSeeded,
} from "./saved-servers";
import { API_BASE_STORAGE_KEY as ENDPOINT_KEY } from "./server-config";
import { loadServerHeaders, saveServerHeaders, serverHeaders } from "./server-headers";
import {
  currentSessionGeneration,
  ensureLegacySessionMigrated,
  noteSessionServerChange,
  sessionSaveInProgress,
  setSessionServer,
  snapshotSessionToken,
  snapshotStoredSessionToken,
  snapshotStoredSessionTokenFor,
} from "./session";

/** The Space last used in each organization on this device, by organization id. */
const ORGANIZATION_SPACES_KEY = "rakazo.org_spaces";
/** The Space last used on each server, by origin. The live `SPACE_KEY` slot is what the app reads. */
const SERVER_SPACES_KEY = "rakazo.server_spaces";

/** The parked Spaces, or null when the stored map could not be read; never throws. */
async function loadServerSpaces(): Promise<Record<string, string> | null> {
  try {
    const parsed: unknown = JSON.parse((await SecureStore.getItemAsync(SERVER_SPACES_KEY)) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return null;
  }
}

/**
 * Applies one change to the parked Spaces. False when the map could not be read or written, in
 * which case nothing is written: a damaged map must never be replaced with an empty one.
 */
async function updateServerSpaces(
  update: (spaces: Record<string, string>) => void,
): Promise<boolean> {
  const spaces = await loadServerSpaces();
  if (!spaces) return false;
  update(spaces);
  return writeStoredValue(SERVER_SPACES_KEY, JSON.stringify(spaces));
}

/** Remembers a Space for its server. Best-effort: a map failure never fails the selection. */
async function rememberServerSpace(apiBase: string, spaceId: string): Promise<void> {
  await updateServerSpaces((spaces) => {
    spaces[apiBase] = spaceId;
  });
}

/** Forgets a server's parked Space. Best-effort, like the remember. */
async function forgetServerSpace(apiBase: string): Promise<void> {
  await updateServerSpaces((spaces) => {
    delete spaces[apiBase];
  });
}
const confirmedSpaceSwitchListeners = new Set<() => void>();
/** Fires when a selection change to another Space is confirmed durable; a
 * rollback after a failed switch, or selecting the same Space again, does not. */
export function subscribeConfirmedSpaceSwitch(listener: () => void): () => void {
  confirmedSpaceSwitchListeners.add(listener);
  return () => {
    confirmedSpaceSwitchListeners.delete(listener);
  };
}
function noteConfirmedSpaceSwitch(): void {
  for (const listener of [...confirmedSpaceSwitchListeners]) listener();
}
export async function loadApiBase() {
  let apiBase = defaultApiBase();
  let storedEndpoint = false;
  try {
    const stored = await SecureStore.getItemAsync(ENDPOINT_KEY);
    if (stored) {
      const parsed = normalizeApiBase(stored);
      if (parsed.ok) {
        apiBase = parsed.url;
        storedEndpoint = true;
      }
    }
  } catch {
    // SecureStore is unavailable in some test / web hosts.
  }
  // First launch: no server was ever stored and the list was never seeded, so open the
  // pre-filled Maushaus server and remember it. The loopback default is unreachable
  // from a phone, and the Server screen shows whichever server is current. A device
  // that launched before keeps its server, so a restart still restores it.
  if (!storedEndpoint && !(await savedServersSeeded())) {
    apiBase = MAUSHAUS_API_BASE;
    await writeStoredValue(ENDPOINT_KEY, MAUSHAUS_API_BASE);
  }
  await loadServerHeaders(apiBase);
  await loadSavedServers();
  setCachedApiBase(apiBase);
  setSessionServer(apiBase);
  await ensureLegacySessionMigrated();
  try {
    const storedSpace = (await SecureStore.getItemAsync(SPACE_KEY)) ?? "";
    const spaces = await loadServerSpaces();
    // The map wins for the server being opened: a crash mid-switch can leave `SPACE_KEY`
    // holding the old server's Space. The resolved selection is parked for the next switch.
    const resolvedSpace = spaces?.[apiBase] ?? storedSpace;
    setSelectedSpace(resolvedSpace);
    if (resolvedSpace !== storedSpace) await writeStoredValue(SPACE_KEY, resolvedSpace);
    if (resolvedSpace) await rememberServerSpace(apiBase, resolvedSpace);
    // A deletion fallback must override the now-invalid saved Space even when
    // the device failed to replace that value before the previous process exited.
    await recoverSpaceRollback(apiBase);
  } catch {
    // Keep any in-memory selection when SecureStore is temporarily unavailable.
  }
  // A revocation left pending by an earlier sign-out or server switch retries on this launch.
  void flushPendingSignOut(true);
  return currentApiBase();
}
export async function selectSpace(id: string) {
  const requestGeneration = nextSpaceSelectionRequest();
  if (!(await clearStoredValue(SPACE_ROLLBACK_KEY))) return false;
  // Rollback cleanup is the first await. A newer selection may have claimed
  // the live space while this call was still deleting the rollback record.
  if (requestGeneration !== spaceSelectionSeq()) return false;
  // Claim memory before persisting: recovery paths reconcile against the
  // in-memory selection, so a durable write must never precede its owner.
  const previousSpaceId = rawSelectedSpaceId();
  setSelectedSpace(id);
  // Generation ownership distinguishes A→B→A from "we still own this claim":
  // an ID-only check would treat a later same-id selection as ours.
  const claimGeneration = currentSpaceSelectionGeneration();
  try {
    await SecureStore.setItemAsync(SPACE_KEY, id);
    // Our write may have landed stale behind a newer overlapping selection's
    // write. Re-assert the live selection best-effort so durable converges
    // to it; each selector heals at most once, so overlapping chains settle
    // on the latest claim. Never delete here: a missing memory owner means
    // another path (recovery, sign-out) owns cleanup.
    const liveSpaceId = rawSelectedSpaceId();
    if (liveSpaceId && liveSpaceId !== id) {
      await writeStoredValue(SPACE_KEY, liveSpaceId);
    }
  } catch {
    // Roll back the claim and heal durable state: a concurrent recovery may
    // have persisted the rolled-back id after reading it, which would leave
    // restart opening a Space the live session is not using. A newer
    // overlapping selection owns both by now, so only heal a claim we hold.
    if (rawSelectedSpaceId() === id && currentSpaceSelectionGeneration() === claimGeneration) {
      setSelectedSpace(previousSpaceId);
      const rollbackGeneration = currentSpaceSelectionGeneration();
      if (previousSpaceId) await writeStoredValue(SPACE_KEY, previousSpaceId);
      if (previousSpaceId)
        await resumeSelectedSpaceNotifications(previousSpaceId, rollbackGeneration);
    }
    return false;
  }
  // Park the live selection for this server, so switching back restores it. A map failure
  // never fails the selection; the live slot already holds it.
  const liveSpaceId = rawSelectedSpaceId();
  if (liveSpaceId) await rememberServerSpace(currentApiBase(), liveSpaceId);
  else await forgetServerSpace(currentApiBase());
  // Playback belongs to the conversation being left; the listener in voice.ts
  // stops it once a switch to another Space is confirmed. A fallback that
  // failed to persist left its origin pending; this confirmed switch consumes
  // it, so the fallback's retry cannot stop this Space's later playback.
  if ((pendingFallbackSwitchFrom ?? previousSpaceId) !== id) noteConfirmedSpaceSwitch();
  pendingFallbackSwitchFrom = null;
  await resumeSelectedSpaceNotifications(id, claimGeneration);
  return true;
}
/** Keep requests usable after the server deleted the selected Space but native
 * storage could not replace it. Neutralize any same-endpoint rollback before
 * writing the replacement selection so a cleanup failure cannot leave the new
 * id beside a stale record that recoverSpaceRollback would prefer on restart. */
/** The Space the user was actually on before a fallback adoption that has not
 * landed yet; a retry that persists must still count as leaving it. */
let pendingFallbackSwitchFrom: string | null = null;
export async function adoptDeletedSpaceFallback(id: string): Promise<boolean> {
  const previousSpaceId = rawSelectedSpaceId();
  if (pendingFallbackSwitchFrom === null && previousSpaceId !== id) {
    pendingFallbackSwitchFrom = previousSpaceId;
  }
  setSelectedSpace(id);
  // Same ownership as selectSpace: a newer selection during the token read wins.
  const claimGeneration = currentSpaceSelectionGeneration();
  // Neutralize any same-endpoint rollback before writing SPACE_KEY. Writing the
  // selection first can leave it beside a stale record that recoverSpaceRollback
  // would prefer on restart if later cleanup fails.
  const rollbackNeutralized =
    (await clearStoredValue(SPACE_ROLLBACK_KEY)) || (await saveSpaceRollback(id));
  // Playback belongs to the conversation being left; the fallback too is a
  // confirmed switch once it durably adopts another Space. A failed attempt
  // already claimed the replacement in memory, so the Space remembered before
  // the first attempt, not the claim, decides whether one was left behind.
  if (rollbackNeutralized && (await writeStoredValue(SPACE_KEY, id))) {
    // SPACE_KEY is authoritative; drop a rollback we may have written only to
    // overwrite a stale record (best-effort).
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    await rememberServerSpace(currentApiBase(), id);
    if ((pendingFallbackSwitchFrom ?? previousSpaceId) !== id) noteConfirmedSpaceSwitch();
    pendingFallbackSwitchFrom = null;
    await resumeSelectedSpaceNotifications(id, claimGeneration);
    return true;
  }
  // Clear before saving recovery: an empty selection lets startup resolve the
  // server default even when the recovery record cannot be written.
  const staleSelectionCleared = await clearStoredValue(SPACE_KEY);
  const recoverySaved = await saveSpaceRollback(id);
  await resumeSelectedSpaceNotifications(id, claimGeneration);
  // Only treat a cleared selection as durable success when no same-endpoint
  // rollback remains to override it after restart.
  const durable =
    recoverySaved || (staleSelectionCleared && (await clearStoredValue(SPACE_ROLLBACK_KEY)));
  if (durable) await rememberServerSpace(currentApiBase(), id);
  if (durable && (pendingFallbackSwitchFrom ?? previousSpaceId) !== id) {
    noteConfirmedSpaceSwitch();
  }
  if (durable) pendingFallbackSwitchFrom = null;
  return durable;
}
export async function selectInitialSpace(id: string) {
  if (selectedSpaceId()) return true;
  return selectSpace(id);
}
export async function loadOrganizationSpaces(): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(
      (await SecureStore.getItemAsync(ORGANIZATION_SPACES_KEY)) || "{}",
    );
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? Object.fromEntries(
          Object.entries(parsed).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : {};
  } catch {
    return {};
  }
}
export async function rememberOrganizationSpace(
  organizationId: string,
  spaceId: string,
): Promise<void> {
  const spaces = await loadOrganizationSpaces();
  await writeStoredValue(
    ORGANIZATION_SPACES_KEY,
    JSON.stringify({ ...spaces, [organizationId]: spaceId }),
  );
}
/**
 * Clears the current server's Space state only. Other servers keep their parked Space, and
 * their sessions are untouched. The per-server map entry is a hint, not auth, so a failed map
 * write never fails the clear.
 */
export async function clearSpace(): Promise<boolean> {
  const organizationsCleared = await clearStoredValue(ORGANIZATION_SPACES_KEY);
  const spaceCleared = await clearStoredValue(SPACE_KEY);
  const rollbackCleared = await clearStoredValue(SPACE_ROLLBACK_KEY);
  await forgetServerSpace(currentApiBase());
  if (!organizationsCleared || !spaceCleared || !rollbackCleared) return false;
  setSelectedSpace("");
  return true;
}
async function snapshotSpace(): Promise<{ ok: true; value: string } | { ok: false }> {
  if (rawSelectedSpaceId()) return { ok: true, value: rawSelectedSpaceId() };
  try {
    return { ok: true, value: (await SecureStore.getItemAsync(SPACE_KEY)) ?? "" };
  } catch {
    return { ok: false };
  }
}
/**
 * Hangs up an active call while its session can still authorize the hang-up. Set by the call
 * module; a server switch runs it before it parks the old server's session, which would
 * otherwise leave the old server holding an answered call with no marker or wrap-up.
 */
let hangUpBeforeEndpointChange: (() => Promise<void>) | undefined;
/** Registers (or clears) the hang-up that runs before an endpoint change parks credentials. */
export function configureSessionEndHangUp(hangUp: (() => Promise<void>) | undefined): void {
  hangUpBeforeEndpointChange = hangUp;
}
type ParkedCredentials = {
  previousApiBase: string;
  previousToken: string;
  previousSpace: string;
  /** The target server's parked session, "" when it has none yet. */
  targetToken: string;
  /** The target server's remembered Space, "" when it has none. */
  targetSpace: string;
  /** The Space selection generation when parking started; a newer selection bumps it. */
  spaceGeneration: number;
};

/**
 * Parks the current server's session in place: nothing is cleared and no revocation is recorded.
 * The old token stays in its per-origin key, so a failed switch only has to flip the active
 * server back. Only a real sign-out revokes a session.
 */
async function parkCredentialsForEndpointChange(
  previous: string,
  target: string,
): Promise<({ ok: true } & ParkedCredentials) | { ok: false; result: EndpointResult }> {
  // The old server's session authorizes the call's hang-up; send it while it is still the active one.
  await bestEffort("hang up before switching servers", hangUpBeforeEndpointChange?.());
  // A selection that lands after this point owns the live slot; the rollback and the commit
  // must not overwrite it. A selection that was never loaded yet does not bump this.
  const spaceGeneration = currentSpaceSelectionGeneration();
  const generation = currentSessionGeneration();
  // A save still running reads as no session; its token may land before the switch.
  const previousToken = sessionSaveInProgress()
    ? ({ ok: false } as const)
    : await snapshotSessionToken();
  // A failed save or wipe can leave a token stored that reads as no session. A restart would send
  // it again, so it counts as the parked session too; it is never deleted here.
  const storedToken =
    previousToken.ok && !previousToken.value ? await snapshotStoredSessionToken() : previousToken;
  // An unreadable session is not an empty one: do not switch blind.
  if (!previousToken.ok || !storedToken.ok) {
    return {
      ok: false,
      result: { ok: false, error: t`Could not save the previous server session` },
    };
  }
  const failed = {
    ok: false as const,
    result: { ok: false as const, error: t`Could not clear the previous server session` },
  };
  const previousSpace = await snapshotSpace();
  if (!previousSpace.ok) return failed;
  // Park the previous Space in the per-server map, so a stored `SPACE_KEY` from an older
  // build cannot strand it when the switch leaves.
  if (previousSpace.value) await rememberServerSpace(previous, previousSpace.value);
  const rollbackReady = previousSpace.value
    ? await saveSpaceRollback(previousSpace.value)
    : await clearStoredValue(SPACE_ROLLBACK_KEY);
  if (!rollbackReady) return failed;
  // Checked in the same tick as the snapshots: a session saved after the read stops the switch
  // before anything moves. The rollback record written above is dropped, so a later launch does
  // not restore a selection the new session already replaced.
  if (generation !== currentSessionGeneration()) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return failed;
  }
  // The target's parked session is read without making it active.
  const targetToken = await snapshotStoredSessionTokenFor(target);
  if (!targetToken.ok) {
    return {
      ok: false,
      result: { ok: false, error: t`Could not save the previous server session` },
    };
  }
  const spaces = await loadServerSpaces();
  return {
    ok: true,
    previousApiBase: previous,
    previousToken: storedToken.value,
    previousSpace: previousSpace.value,
    targetToken: targetToken.value,
    targetSpace: spaces?.[target] ?? "",
    spaceGeneration,
  };
}

/**
 * Rolls back an endpoint change: nothing was cleared before the commit point, so this only flips
 * the pointers back to the previous server and resumes its notifications. The rollback record
 * written while parking is dropped; the endpoint-bound record restores the selection after a
 * restart if the Space write below cannot land.
 */
async function rollBackEndpointChange(parked: ParkedCredentials | undefined): Promise<void> {
  if (!parked) return;
  // A newer selection that landed during the switch owns the live slot now; the rollback must
  // not clobber it. The rollback record is dropped either way: it describes the abandoned switch.
  const ownsLiveSelection = currentSpaceSelectionGeneration() === parked.spaceGeneration;
  let reassertedGeneration = -1;
  if (ownsLiveSelection) {
    setSelectedSpace(parked.previousSpace);
    reassertedGeneration = currentSpaceSelectionGeneration();
    try {
      await SecureStore.setItemAsync(SPACE_KEY, parked.previousSpace);
      await clearStoredValue(SPACE_ROLLBACK_KEY);
    } catch {
      // The endpoint-bound rollback record restores this selection after restart.
    }
  } else {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
  }
  if (
    parked.previousToken &&
    ownsLiveSelection &&
    currentSpaceSelectionGeneration() === reassertedGeneration
  ) {
    await bestEffort(
      "resume live notifications on the previous server",
      resumeLiveNotifications(parked.previousApiBase, parked.previousToken, parked.previousSpace),
    );
  }
}

/** Commits a switch: flips the cached server, the session server and the generation, then restores the target's Space. */
async function commitEndpointChange(
  target: string,
  parked: ParkedCredentials | undefined,
): Promise<void> {
  setCachedApiBase(target);
  setSessionServer(target);
  // Bumps the generation, so in-flight old-server requests are discarded and the inbox remounts
  // and re-reads the session for the new server; with no parked token it shows sign-in there.
  noteSessionServerChange();
  if (parked) {
    // A newer selection that landed during the switch owns the live slot; the target's parked
    // Space must not overwrite it.
    if (currentSpaceSelectionGeneration() === parked.spaceGeneration) {
      setSelectedSpace(parked.targetSpace);
      await writeStoredValue(SPACE_KEY, parked.targetSpace);
      if (parked.targetSpace) await rememberServerSpace(target, parked.targetSpace);
    }
  }
  await clearStoredValue(SPACE_ROLLBACK_KEY);
}

/** Best-effort, after a switch commits: point live notifications and push at the new server. */
async function resumeAfterSwitch(
  target: string,
  parked: ParkedCredentials | undefined,
): Promise<void> {
  if (!parked) return;
  // With no parked session there is nothing to subscribe with; resumeLiveNotifications
  // returns false for an empty token anyway, so the call is skipped, not attempted.
  if (parked.targetToken) {
    await bestEffort(
      "resume live notifications on the new server",
      resumeLiveNotifications(target, parked.targetToken, rawSelectedSpaceId()),
    );
  }
  await bestEffort("register the push token on the new server", registerPushToken());
}
async function saveSpaceRollback(spaceId: string): Promise<boolean> {
  return writeStoredValue(
    SPACE_ROLLBACK_KEY,
    JSON.stringify({ apiBase: currentApiBase(), spaceId }),
  );
}
async function recoverSpaceRollback(apiBase: string) {
  const stored = await SecureStore.getItemAsync(SPACE_ROLLBACK_KEY);
  if (!stored) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  const rollback = parsed as { apiBase?: unknown; spaceId?: unknown };
  if (rollback.apiBase !== apiBase || typeof rollback.spaceId !== "string" || !rollback.spaceId) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  setSelectedSpace(rollback.spaceId);
  if (await writeStoredValue(SPACE_KEY, rollback.spaceId)) {
    await clearStoredValue(SPACE_ROLLBACK_KEY);
    return;
  }
  // Could not replace the selection yet. Drop the deleted id so startup RPCs
  // are not scoped to an inaccessible Space; keep the recovery record.
  await clearStoredValue(SPACE_KEY);
}
export async function saveApiBase(
  input: string,
  headers: Record<string, string> = {},
): Promise<EndpointResult> {
  const parsed = normalizeApiBase(input);
  if (!parsed.ok) return parsed;
  if (parsed.url === defaultApiBase() && Object.keys(headers).length === 0) return resetApiBase();
  return queueEndpointChange(parsed.url, async (previous, switching) => {
    const previousHeaders = serverHeaders(previous);
    let parked: ParkedCredentials | undefined;
    if (switching) {
      const result = await parkCredentialsForEndpointChange(previous, parsed.url);
      if (!result.ok) return result.result;
      parked = result;
    }
    if (!(await saveServerHeaders(parsed.url, headers))) {
      await rollBackEndpointChange(parked);
      return { ok: false, error: t`Could not save the server URL` };
    }
    try {
      await SecureStore.setItemAsync(ENDPOINT_KEY, parsed.url);
    } catch {
      await saveServerHeaders(previous, previousHeaders);
      await rollBackEndpointChange(parked);
      return { ok: false, error: t`Could not save the server URL` };
    }
    await commitEndpointChange(parsed.url, parked);
    await rememberServers(switching ? previous : undefined, previousHeaders, parsed.url, headers);
    await resumeAfterSwitch(parsed.url, parked);
    return parsed;
  });
}
export async function resetApiBase(): Promise<EndpointResult> {
  const url = defaultApiBase();
  return queueEndpointChange(url, async (previous, switching) => {
    const previousHeaders = serverHeaders(previous);
    let parked: ParkedCredentials | undefined;
    if (switching) {
      const result = await parkCredentialsForEndpointChange(previous, url);
      if (!result.ok) return result.result;
      parked = result;
    }
    try {
      await SecureStore.deleteItemAsync(ENDPOINT_KEY);
    } catch {
      // The endpoint value is unchanged, so the old server is still current and its session
      // is intact. The switch simply fails; nothing is revoked.
      await rollBackEndpointChange(parked);
      return { ok: false, error: t`Could not clear the custom server URL` };
    }
    if (!(await saveServerHeaders(url, {}))) {
      if (await writeStoredValue(ENDPOINT_KEY, previous)) {
        await rollBackEndpointChange(parked);
      } else {
        // The old server URL could not be stored again, so the next launch opens the default
        // server; this launch follows it too, with the default server's parked session.
        await commitEndpointChange(url, parked);
        if (switching) await rememberServers(previous, previousHeaders);
        await resumeAfterSwitch(url, parked);
      }
      return { ok: false, error: t`Could not clear the custom server URL` };
    }
    await commitEndpointChange(url, parked);
    if (switching) await rememberServers(previous, previousHeaders);
    await resumeAfterSwitch(url, parked);
    return { ok: true, url };
  });
}
/**
 * Lists the server a switch left, so one set up before the list existed can be returned to, and
 * the one it moved to. Runs only after the switch committed; the list is a convenience, so a
 * write that fails leaves the switch standing.
 */
async function rememberServers(
  left: string | undefined,
  leftHeaders: Record<string, string>,
  entered?: string,
  enteredHeaders: Record<string, string> = {},
): Promise<void> {
  if (left) await recordSavedServer(left, leftHeaders, { keepHeaders: true });
  if (entered) await recordSavedServer(entered, enteredHeaders);
}
