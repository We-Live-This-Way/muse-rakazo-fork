# Rakazo Android fork: multi-server, per-server sessions — implementation plan

Date: 2026-11-22. Status: design only. Nothing was run, built, or changed to
produce this plan; every claim below comes from reading the code listed in
"Sources". Execution happens later, after approval.

Goal (from the task): MausBot-like switching. Stay signed in on each server,
tap to switch, no re-login. UI stays visually identical to the official app:
reuse existing components and styles only. Visible changes are ONLY labels on
saved-server rows and a Settings row opening the Server screen while signed in.

Sources read: `~/workspace/rakazo-fork-scope/SCOPE.md`;
`apps/mobile/lib/api/session.ts`, `api-server.ts`, `saved-servers.ts`,
`server-headers.ts`, `server-config.ts`, `endpoint.ts`, `api.ts` (SPACE_KEY
parts, pending-sign-out machinery, `captureApiRequestContext`, `authHeaders`,
`resumeSelectedSpaceNotifications`), `lib/notifications/live-notifications.ts`,
`lib/notifications/push.ts`, `lib/api/verified-scope.ts`,
`lib/auth/api-auth.ts` (`signIn`/`signOut`/`authenticate`),
`lib/settings/settings-sheet.ts`, `app/server.tsx`, `app/sign-in.tsx`,
`app/_layout.tsx`, `app/(settings)/general.tsx`, `app/(settings)/account.tsx`
(first 120 lines), `app/(settings)/_layout.tsx`, `app.json`, `app.config.ts`,
`eas.json`, `package.json`, `docs/mobile-app.md`,
`apps/mobile/lib/api/saved-servers-switch.test.ts`, `session.test.ts`,
`api-server.test.ts` (full), `saved-servers.test.ts` (first 120 lines), and the
repo `AGENTS.md` (Biome formatting, `pnpm checks`, shared primitives
`bestEffort`/`useSave`, no em dashes in UI copy, mobile screens use
`useScreenHeader`/`useSave`).

Upstream baseline (from SCOPE.md): HEAD `26000736`, app version `1.0.18`,
Android `versionCode` 10, package `com.rakazo.app`. PR #5093 already ships a
Recent-servers list, but switching clears the session and re-sign-in is
required, and the Server screen is reachable only from the sign-in screen.

## 0. Design decisions (the short version)

| # | Decision | Why |
|---|---|---|
| D-1 | Tokens live in per-origin SecureStore keys, `rakazo.session_token:<origin>` | Smallest diff that makes sessions independent. No token is ever deleted on switch, so there is nothing to restore and nothing to revoke. |
| D-2 | The token is never moved on switch. Switching only flips which per-origin key is "active" | Parking becomes a no-op. Rollback becomes flipping the pointer back. This kills most of the old clear-then-restore complexity. |
| D-3 | A switch creates NO pending-sign-out record. Only a real sign-out (`signOut()` in `lib/auth/api-auth.ts`) records a revocation | This is the revocation rule. It is also the biggest behavioral break with upstream, and several existing tests encode the old rule and must be rewritten, not extended. |
| D-4 | Space selection: single live slot (`rakazo.space_id`) plus a per-server map `rakazo.server_spaces` (`{origin: spaceId}`) | Mirrors how the token works. The map is the parked memory; the live slot is what the rest of the app already reads. |
| D-5 | Verified scope stays a single slot (`rakazo.integrations-scope`). A switch re-verifies with one `me` call | The slot already stores `apiBase` and the token, and `loadVerifiedScope()` already rejects a token mismatch, so it self-heals. Per-origin scope keys are an optional follow-up, not required. |
| D-6 | Fork identity: package `com.welivethisway.rakazo`, version `1.0.19`, `versionCode` 11, own EAS project, OTA repointed to the fork project (or disabled, see open question O-1) | Installing alongside the official app is a side benefit. The OTA repoint is the single most important identity item: forgetting it lets upstream silently replace the fork. |
| D-7 | Default server is Maushaus via `EXPO_PUBLIC_API_URL`; the saved-servers default-exclusion is relaxed only for labeled entries | Otherwise the pre-filled Maushaus row would be dropped by `parseSavedServers()` and refused by `recordSavedServer()`, and switching away from Maushaus could never record it back. |
| D-8 | Pre-fill is seeded once, guarded by a marker key, never re-seeded after the user removes it | Without the marker, removing the last entry deletes the list key, and the next load would resurrect Maushaus. |

## 1. Fork identity

Files: `apps/mobile/app.json`, `apps/mobile/app.config.ts`,
`apps/mobile/eas.json`, `apps/mobile/package.json` (no change expected).

### 1.1 `app.json`

- `expo.android.package`: `com.rakazo.app` to `com.welivethisway.rakazo`.
- `expo.ios.bundleIdentifier`: `com.rakazo.app` to
  `com.welivethisway.rakazo`. The fork targets Android only and iOS is not
  built, but leaving the iOS identifier pointing at the upstream app is a
  collision waiting to happen. Update the extension bundle identifiers under
  `extra.eas.build.experimental.ios.appExtensions` (`com.rakazo.app.*`) and
  the share-extension `appGroupId` (`group.com.rakazo.app`) in the same
  pass, or the iOS config is internally inconsistent. Do not build iOS in
  this work; just keep the identifiers consistent.
- `expo.version`: `1.0.18` to `1.0.19`. Keep plain semver, no `-fork`
  suffix: `runtimeVersion.policy` is `appVersion`, and a plain bump keeps
  that mechanism working.
- `expo.android.versionCode`: `10` to `11`. Note `eas.json` production
  profile has `"autoIncrement": true`, so EAS will raise this on build
  anyway; set 11 as the base and let EAS own later increments.
- `expo.name`: keep `Rakazo`. The brief requires the UI to stay visually
  identical, and the launcher name is part of that. The package id is what
  distinguishes the fork, not the name.
- `expo.slug`: `rakazo` to `rakazo-fork` (or leave it; it only matters for
  the EAS project URL slug. Prefer changing it so nothing in the fork
  project still reads as upstream).
- `expo.owner`: `inbox-zero` to the operator's Expo account owner name, set when
  the fork project is created with `eas project:init` in `apps/mobile`.
- `expo.extra.eas.projectId`: `07f7eb04-45e3-47fe-9374-99a2f991131e` to the
  new fork project id issued by `eas project:init`. This id appears twice:
  here and in `updates.url` (see 1.2).
- `expo.scheme`: keep `rakazo`. The app authenticates with origin
  `rakazo://` (see `api-auth.ts` `postAuth` and `endpoint.ts` probe), and
  changing the scheme would break deep links and the auth origin. Note the
  consequence: official app and fork both claim the `rakazo` scheme, so
  Android may show a disambiguation prompt for `rakazo://` links. Accept
  it; do not invent a second scheme.

### 1.2 OTA updates: the must-not-miss item

Today `updates.url` is `https://u.expo.dev/07f7eb04-...`, the upstream EAS
project. A fork that keeps it can be silently replaced by an upstream OTA
push with no warning. Two acceptable outcomes, in order of preference:

1. Preferred: repoint `updates.url` to the fork project
   (`https://u.expo.dev/<fork-project-id>`) and keep OTA under fork control,
   with the `production` channel in `eas.json` now living in the fork
   project (channels are per project, so the name does not collide with
   upstream). This keeps the `installClientUpdates` / `watchForegroundUpdates`
   path in `_layout.tsx` working for fork updates.
2. Acceptable: disable OTA entirely for the fork (remove the `updates`
   block, or set the SDK 58 disable flag if one applies). Updates then come
   only from new APK installs.

Whichever is chosen, verify by reading the installed `expo-updates`
version's behavior at build time. Open question O-1 records that the exact
disable key for SDK 58 was not verified by reading. Also note the second
line of defence: `runtimeVersion.policy` is `appVersion`, so an upstream
OTA published for 1.0.18 cannot apply to a fork binary reporting 1.0.19.
Do not rely on that alone; repoint or disable anyway.

### 1.3 `app.config.ts`

- No code change needed, but two environment facts must hold at build time:
  - `EXPO_PUBLIC_API_URL` is REQUIRED for release profiles (`production`,
    `android-apk`, `diagnostic` all throw without it, and it must be
    `https:`). Set it in the EAS production environment to
    `https://rakazo.example.com`. That makes Maushaus the
    default server (`defaultApiBase()` in `endpoint.ts` derives from it),
    so a fresh install opens Maushaus sign-in directly. This interacts
    with the saved-servers default-exclusion; see D-7 and section 5.
  - `GOOGLE_SERVICES_JSON` is optional in code (it only sets
    `android.googleServicesFile` when present), but without the fork's own
    Firebase config the APK never registers for push
    (`registerPushToken()` in `lib/notifications/push.ts` catches the
    failure and skips). The fork needs its own Firebase project and
    `GOOGLE_SERVICES_JSON` file variable, or it ships without push. See
    risk R-3.
  - `SENTRY_AUTH_TOKEN` is optional; skip it for the fork unless the operator
    wants fork crash reporting.
- `passkeyRpId()` derives the passkey relying-party id from
  `EXPO_PUBLIC_API_URL`, so passkeys work on Maushaus. The app already
  hides passkeys on other servers at runtime (comment in `app.config.ts`),
  so the laptop server simply offers no passkey sign-in. No change.

### 1.4 `eas.json` and `package.json`

- `eas.json`: no structural change. `cli.appVersionSource` is `remote` and
  production has `autoIncrement: true`; verify at project setup that the
  remote version state belongs to the fork project and that the local
  `1.0.19` / `versionCode` 11 edits are not overwritten by the remote
  state (open question O-2). The `android-apk` profile
  (`eas build --platform android --profile android-apk`) is the build
  command, unchanged.
- `package.json` (`@rakazo/mobile`): no change. The npm package name is
  internal to the monorepo; the Android identity lives in `app.json`.
- New EAS-side setup (outside the repo, listed so it is not forgotten):
  own Expo project (`eas project:init`), own `EXPO_TOKEN`, own signing
  keystore (EAS managed, or a local one kept safe; losing it means the
  installed app can never be updated in place), own `EXPO_PUBLIC_API_URL`
  and `GOOGLE_SERVICES_JSON` in the EAS production environment.

## 2. Per-server sessions

### 2.1 Key scheme (`lib/api/session.ts`)

Today there is one global token key and one global verified-scope slot:

- `SESSION_KEY = "rakazo.session_token"`
- `VERIFIED_SCOPE_KEY = "rakazo.integrations-scope"` (content already
  carries `apiBase`, `userId`, `spaceId`, `selectionId`, `token`)

New scheme:

```ts
const SESSION_KEY_PREFIX = "rakazo.session_token:";
const LEGACY_SESSION_KEY = "rakazo.session_token"; // migration source only, never written again

/** The token key for one server. `apiBase` is already a normalized origin
 * (`normalizeApiBase` output: scheme + host + port, no path), so two
 * servers can never share a key, and http vs https on the same host differ. */
function sessionKeyFor(apiBase: string): string {
  return `${SESSION_KEY_PREFIX}${apiBase}`;
}
```

Example keys:

- `rakazo.session_token:https://rakazo.example.com`
- `rakazo.session_token:http://100.97.235.102:3100` (laptop over Tailscale;
  the exact laptop origin is whatever the user enters and `normalizeApiBase`
  returns; do not hard-code it anywhere)

How the active server is known inside `session.ts`: `session.ts` is
imported by `api.ts`, so it cannot import `currentApiBase()` back without a
cycle. Add a module-level active server with one setter, following the
existing module-level-state pattern in the file (generation counters,
`sessionFallback`, `sessionInvalidated`):

```ts
let activeApiBase = defaultApiBase(); // same default as api.ts cachedApiBase

/** The server the token functions read and write for. Only api-server.ts
 * writes it, always in step with setCachedApiBase(). */
export function setSessionServer(apiBase: string): void {
  activeApiBase = apiBase;
}
```

Invariant to state in a comment and enforce by call order: the session
module's active server always equals `currentApiBase()` before any token
operation. Writers are `loadApiBase()` (boot, sets it right after reading
the stored endpoint, before any token read) and `saveApiBase()` /
`resetApiBase()` (switch, sets it at the commit point). Every existing
function that touches `SESSION_KEY` (`saveSessionToken`,
`clearStoredSessionToken`, `saveRotatedToken`, `recoverRotatedToken`,
`snapshotSessionToken`, `snapshotStoredSessionToken`) reads/writes
`sessionKeyFor(activeApiBase)` instead. No call-site signature changes:
`saveSessionToken(token)`, `clearSessionToken()`,
`loadSessionToken()`, `snapshotSessionToken()` keep their signatures, so
sign-in, sign-out, rotation, and rejection paths in `api-auth.ts` and
`api.ts` (`rejectSession`) need no edits except through the scoped
`clearSpace()` change in section 2.3.

Why not pass `apiBase` explicitly at every call site: it is the more
explicit design, but it touches every token call site (sign-in, sign-out,
rotation, push registration, `_layout.tsx` boot, `api.ts` auth headers) for
no behavioral gain, and the codebase already keeps this kind of
module-level "current server" state in `api.ts` (`cachedApiBase`). The
setter approach is the smaller, reviewable diff. Record the explicit
alternative in the plan so a reviewer can overrule it.

### 2.2 Migration path for the existing single global token

The fork installs over the operator's data (same device, SecureStore intact) or
fresh. Migration runs once, lazily, inside the token read path, and is
idempotent:

1. On the first token operation for the current server after boot
   (`loadApiBase()` is the natural place, before `loadSessionToken()` is
   first used), read `sessionKeyFor(currentApiBase)`.
2. If it exists, migration is done (or was never needed). Delete the legacy
   key if it is still present and equal to the adopted value; if it differs,
   it can only be a leftover of a half-finished earlier migration (nothing
   in the fork ever writes the legacy key), so deleting it is safe. State
   that reasoning in a comment.
3. If the per-origin key is absent and the legacy key
   (`rakazo.session_token`) holds a token, adopt it: write it to
   `sessionKeyFor(currentApiBase)`, then delete the legacy key. The legacy
   token necessarily belongs to the stored current server, because the old
   app only ever had one server at a time and `rakazo.api_base` is stored
   alongside it. If the per-origin write fails, keep the legacy key and
   treat the session as memory-only (`sessionFallback`), exactly like the
   existing failed-save path; retry adoption on the next launch.
4. If neither key holds a token, there is no session to migrate; the user
   signs in on the current server as today.

Do not add a separate "migration done" marker key: the absence of the
legacy key IS the marker, and the adopt-then-delete order makes a crash
mid-migration safe (legacy still present on next launch, adoption retried).

Edge case to handle: a user who upgrades from official 1.0.18 mid-switch
could have a provisional pending-sign-out record (`rakazo.pending_sign_out`
with `provisional: true`) left by the old code. Keep
`reconcileProvisionalSignOuts()` in `api.ts` untouched for this: it already
resolves a provisional record whose token is still the active session on
its server, and promotes the rest. Mark it `compat-shim` per `AGENTS.md`
(one release of history) and remove it only after the fork has shipped
past that upgrade window.

### 2.3 Space selection per server (`lib/api/api.ts` SPACE_KEY, `lib/api/api-server.ts`)

Today `SPACE_KEY = "rakazo.space_id"` is one global slot, and the switch
flow clears it. New shape: keep the live slot, add a parked map.

```ts
// api-server.ts (new)
const SERVER_SPACES_KEY = "rakazo.server_spaces"; // JSON: { [origin]: spaceId }
```

- `selectSpace(id)`: unchanged in behavior, plus writes the per-server map
  entry for `currentApiBase()` (best-effort, after the `SPACE_KEY` write
  lands; a map write failure never fails the selection).
- Switch restore: `SPACE_KEY` is set to `map[target] ?? ""`. Empty means
  "no remembered Space on this server": the server picks its default, as
  today when nothing is selected.
- `loadApiBase()`: after reading `SPACE_KEY`, load the map. Resolve the
  selection as `map[currentApiBase] ?? stored SPACE_KEY`, then rewrite
  `SPACE_KEY` to the resolved value. This covers the crash-mid-switch case
  where `SPACE_KEY` still holds the old server's Space id: the map wins for
  the server being opened.
- `SPACE_ROLLBACK_KEY` (`rakazo.space_rollback`, already
  `{apiBase, spaceId}`): keep as-is. It is already endpoint-bound, and
  `recoverSpaceRollback(apiBase)` already ignores records for another
  endpoint. It stays the crash-recovery record for Space selection; the map
  is the normal path.
- `ORGANIZATION_SPACES_KEY` (`rakazo.org_spaces`, map by organization id):
  keep as-is. Organization ids are server-issued UUIDs, so a cross-server
  collision is negligible (record the assumption). Do not scope it per
  server in this change.
- `clearSpace()` (called by `signOut()` and by `authenticate()` on
  sign-in): change its meaning from "clear all Space state" to "clear the
  current server's Space state". It deletes the current server's entry from
  the map, clears `SPACE_KEY` and `SPACE_ROLLBACK_KEY`, and clears
  `ORGANIZATION_SPACES_KEY` (accepted minor behavior: the org-space hint is
  re-derived on next visit; see risk R-6). It must NOT touch other servers'
  map entries. Same for `clearSpace()` callers: no caller changes needed,
  only the function body.
- `selectInitialSpace`, `adoptDeletedSpaceFallback`, `rememberOrganizationSpace`:
  no signature changes. `adoptDeletedSpaceFallback` writes the live slot;
  add the map write beside it (same best-effort rule as `selectSpace`).

### 2.4 Verified scope (`lib/api/session.ts` VERIFIED_SCOPE_KEY, `lib/api/verified-scope.ts`)

No key change. The single slot already stores `apiBase` plus the token, and
`loadVerifiedScope()` returns null unless the stored token equals the
current token, so after a switch it self-invalidates and the next
`verifiedScope()` call re-verifies with one `me` RPC and re-saves the slot
for the new server. Cost of a switch: one extra `me` call. The in-memory
`identity` cache in `verified-scope.ts` is already keyed by
`apiBase + generation + selectionId`, so it partitions correctly across
servers with no change.

What the switch path must do about scope: bump the session generation (the
restore path already does) and set `scopeInvalidated = true` in memory.
Do NOT delete the slot on switch: it holds the parked server's scope, and
deleting it would only force a re-verify later anyway. But note the slot can
only hold one server's scope at a time, so the parked server's scope is
lost on the next save for the other server; that is acceptable because it is
a cache, not credentials. If a reviewer wants zero re-verification on
switch-back, the follow-up is per-origin scope keys
(`rakazo.integrations-scope:<origin>`), using the same keying function as
tokens. Do not build it in this change.

Also note: `saveVerifiedScope()` and `loadVerifiedScope()` use
`snapshotSessionToken()`, which after the keying change reads the active
server's key. No edits needed there beyond the key function.

### 2.5 Push re-registration on switch (`lib/notifications/live-notifications.ts`, `lib/notifications/push.ts`)

- `resumeLiveNotifications(apiBase, token, space)` already takes the
  endpoint, token, and Space explicitly and is already called by
  `restoreCredentials()` and `resumeSelectedSpaceNotifications()`. The new
  switch path calls it with the TARGET server's values after the commit
  point (see section 3). No change to `live-notifications.ts` itself is
  expected.
- `registerPushToken()` (`push.ts`) registers the device's Expo push token
  with the CURRENT server via `rpc("notifications/registerPush")`, and it
  reads the current session token itself. After a switch commits, call it
  (best-effort, via the existing `bestEffort` primitive, never a bare
  `.catch(() => undefined)` per `AGENTS.md`) so the new server holds the
  token. The old server keeps its registration, which is what lets a parked
  server keep pushing. No change to `push.ts` itself is expected; the call
  site is the switch path in `api-server.ts`.
- The native Android poller (`RakazoNotifications`) holds ONE endpoint +
  token: it follows the current server only. That is existing behavior for
  the current server and is unchanged. Parked-server push delivery through
  the poller is therefore not expected while parked; Expo push (FCM)
  registrations are per server and persist. See open question O-5: verify
  on device what a parked server's push does, and whether the "signed-out
  drop rule" in `push.ts` drops it.
- `clearSessionToken()` calls `stopLiveNotifications(true)`. The switch
  path must NOT call `clearSessionToken()` (see section 3); that is what
  currently stops notifications on switch, and removing the call is what
  keeps the parked server's delivered notifications alone.

### 2.6 Revocation rule

- A switch must NOT revoke the parked session. Concretely: the switch path
  creates no `PendingSignOut`, writes nothing to
  `rakazo.pending_sign_out`, and calls neither `savePendingSignOut()` nor
  `promotePendingSignOut()`.
- Only a real sign-out does: `signOut()` in `lib/auth/api-auth.ts` is
  unchanged in shape. It snapshots the CURRENT server's token, records the
  revocation for that server only, clears that server's per-origin token key
  (via `clearSessionToken()`, now keyed), and clears that server's Space
  state (via the scoped `clearSpace()`, section 2.3). Other servers'
  per-origin keys, map entries, and saved-server entries are untouched.
  `deleteAccount()` is likewise unchanged (it clears the current server's
  session only).
- Consequence for `api.ts` pending-sign-out machinery: `flushPendingSignOut`,
  `deliverPendingSignOut`, `reconcileProvisionalSignOuts` stay as-is; they
  only ever act on records a real sign-out (or a pre-fork switch) created.
  `promotePendingSignOut()` and `settleRolledBackSignOut()` become dead for
  switches; check for other callers at implementation time and delete them
  if the switch was their only caller, or keep `promotePendingSignOut`
  only if `signOut()` needs it (it does not: `signOut()` records
  non-provisional records directly).
- Session expiry note: better-auth sessions expire 7 days after last use
  (`PENDING_SIGN_OUT_MAX_AGE_MS` comment in `api.ts`). A parked session
  that is not switched back to within its server's expiry window will need
  a sign-in when next selected. That is expected server behavior, not a
  bug; do not build a background refresh for parked sessions.

### 2.7 Rollback behavior for failed switches

The new switch (section 3) never destructively clears anything before the
commit point, so rollback is a pointer flip, not a restore:

- Failure BEFORE the endpoint write lands (probe already passed in
  `server.tsx`; hang-up done; old token/space snapshotted in memory; target
  token read): abort, return the existing error copy
  (`Could not save the previous server session` /
  `Could not clear the previous server session` as applicable), change
  nothing durable. `currentApiBase()`, the active session server, the Space
  selection, and notifications are all untouched because none were moved yet.
- Failure AT the endpoint write (`SecureStore.setItemAsync(ENDPOINT_KEY)`
  throws, the existing failure mode): the endpoint value is unchanged or
  the write failed, so the old server is still stored. Flip the in-memory
  pointers back (they were only changed after the write in the new order;
  see section 3), re-assert the old Space selection, and call
  `resumeLiveNotifications(previousApiBase, previousToken, previousSpace)`
  so the poller is pointed at the old server again. Return
  `Could not save the server URL`.
- Failure AFTER the commit point (headers save is ordered BEFORE the
  endpoint write, so the only post-commit step is notification resume /
  push registration, both best-effort): the switch stands. Do not roll
  back for a failed notification resume; the next foreground resume and
  the next `resumeSelectedSpaceNotifications` heal it.
- A session change mid-switch (a sign-in landing during the switch, the
  existing generation check `generation !== currentSessionGeneration()`):
  abort and roll back exactly as in the pre-commit case. The generation
  bump from the sign-in is the tripwire; the parked token was never
  touched, so the new sign-in's token is intact.
- A process kill mid-switch: on next launch, `loadApiBase()` reads whatever
  `ENDPOINT_KEY` holds. If the endpoint write landed, the app opens the new
  server with its per-origin token (or no session, hence sign-in there).
  If it did not land, the app opens the old server with its token intact.
  There is no half-state in which a token is deleted but its server is
  still current, because tokens are never deleted on switch. The Space
  resolution in `loadApiBase()` (map wins over the live slot, section 2.3)
  covers the Space half-state.

## 3. Switch flow changes in `lib/api/api-server.ts`

Replace `clearCredentialsForEndpointChange()` with a park/restore
equivalent. Suggested shape (sketch, not final code):

```ts
type ParkedCredentials = {
  previousToken: string;
  previousSpace: string;
  targetToken: string; // "" when the target server has no parked session
  targetSpace: string; // "" when the target server has no remembered Space
};

/**
 * Parks the current server's session in place: nothing is cleared and no
 * revocation is recorded. The old token stays in its per-origin key, so a
 * failed switch only has to flip the active server back.
 */
async function parkCredentialsForEndpointChange(
  previous: string,
): Promise<
  ({ ok: true } & ParkedCredentials) | { ok: false; result: EndpointResult }
> {
  // The old server's session authorizes the call's hang-up; send it while
  // it is still the active one. (Keep the existing hang-up registration:
  // configureSessionEndHangUp stays, comment updated from "clears
  // credentials" to "parks credentials".)
  await hangUpBeforeCredentialsCleared?.().catch(() => undefined);
  const generation = currentSessionGeneration();
  if (sessionSaveInProgress()) {
    return { ok: false, result: { ok: false, error: t`Could not save the previous server session` } };
  }
  const previousToken = await snapshotSessionToken();
  const storedToken = previousToken.ok && !previousToken.value
    ? await snapshotStoredSessionToken()
    : previousToken;
  // An unreadable session is not an empty one: do not switch blind.
  if (!previousToken.ok || !storedToken.ok) {
    return { ok: false, result: { ok: false, error: t`Could not save the previous server session` } };
  }
  // No pending-sign-out record is created here. A switch parks the session;
  // only a real sign-out revokes it.
  const previousSpace = await snapshotSpace();
  if (!previousSpace.ok) {
    return { ok: false, result: { ok: false, error: t`Could not clear the previous server session` } };
  }
  // Generation check in the same tick as the snapshot: a session saved
  // after the read stops the switch before anything moves.
  if (generation !== currentSessionGeneration()) {
    return { ok: false, result: { ok: false, error: t`Could not clear the previous server session` } };
  }
  return {
    ok: true,
    previousToken: previousToken.value,
    previousSpace: previousSpace.value,
    targetToken: "", // filled in by the caller after the target is known
    targetSpace: "",
  };
}
```

Notes on the sketch: the target token is read AFTER the endpoint commit
point is decided, or before it, as long as it is read from the target's
per-origin key without touching the current session. Simplest ordering
inside `saveApiBase()` / `resetApiBase()` (which share the shape today):

1. `queueEndpointChange()` serializes switches (keep).
2. Probe already happened in `server.tsx`. Hang up, snapshot old
   token/space, generation check (park step above). No revocation record,
   no `clearSessionToken()`, no `clearStoredValue(SPACE_KEY)`, no
   `clearStoredValue(ORGANIZATION_SPACES_KEY)`.
3. `saveServerHeaders(target, headers)` (keep, before the endpoint write).
   On failure, nothing has moved; return
   `Could not save the server URL`.
4. `SecureStore.setItemAsync(ENDPOINT_KEY, target)` (keep). On failure,
   restore the previous headers (existing behavior) and return
   `Could not save the server URL`. Nothing else moved.
5. Commit point (the endpoint write landed). Now, in order:
   `setCachedApiBase(target)`; `setSessionServer(target)` (new);
   activate the target token (read `sessionKeyFor(target)`; if a token is
   present, publish the session generation so in-flight old-server requests
   are discarded and the UI re-reads; if absent, the session is empty and
   the app shows sign-in for the target server, see open question O-3);
   restore the target Space from the map (`setSelectedSpace(targetSpace)`,
   persist `SPACE_KEY`); `clearStoredValue(SPACE_ROLLBACK_KEY)` (keep);
   `rememberServers(previous, previousHeaders, target, headers)` (keep,
   extended for labels, section 4).
6. Best-effort after commit: `resumeLiveNotifications(target,
   targetToken, targetSpace)` and `registerPushToken()`. Failures here do
   not fail the switch.
7. Do NOT call `promotePendingSignOut()` (nothing provisional exists) and
   do NOT clear `ORGANIZATION_SPACES_KEY` on switch (section 2.3).

`resetApiBase()` ("Use default server") shares the same park path: it is a
switch to `defaultApiBase()`, and the default server's per-origin token is
restored the same way. Its existing failure branch ("cannot store the old
server again, follow the new server and revoke the old session") must be
reworked: under park/restore, if the endpoint value cannot be stored, the
old server is still current, so the old session is NOT revoked and the
switch simply fails. That whole branch goes away; the test
"a reset that cannot store the old server again keeps its session revoked,
not restored" must be rewritten to expect failure-with-session-intact.

`rollBackEndpointChange()` / `restoreCredentials()` / `settleRolledBackSignOut()`:
`restoreCredentials()` (restore token + space + resume notifications) is
still useful as the rollback helper, but it must be re-pointed at the new
mechanics: restoring means flipping `setSessionServer(previous)`,
`setCachedApiBase(previous)`, `setSelectedSpace(previousSpace)`, persisting
`SPACE_KEY`, and resuming notifications for the previous server. It must
NOT call `restoreSessionToken()` to rewrite a token that was never deleted.
`settleRolledBackSignOut()` goes away with the provisional records. Keep
the function names only where they still describe what happens; rename if
the reviewer prefers (`rollBackEndpointChange` still fits).

`saveSpaceRollback()` / `recoverSpaceRollback()`: keep unchanged. The
rollback record is written before the Space swap as today (or, under the
new order, before `SPACE_KEY` is rewritten at commit); its endpoint-bound
shape already handles the switch case.

Also keep: `confirmUnsentSendLoss("server-switch")` in `server.tsx`
(asked once before `saveApiBase()`), but check its copy at implementation
time: the switch no longer deletes the unsent queue, so if the warning says
the messages will be lost, the copy must change (see open question O-4).
The queue itself is not cleared on switch anymore; whether the queue is
global or per-server, and whether `startUnsentSends()` (started in
`_layout.tsx` when ready) gates sends on the current server, was not
verified by reading. Do not assume; check `lib/thread/send/`.

## 4. Labels

### 4.1 `lib/api/saved-servers.ts`

```ts
/** A server the device has used before, with the custom headers it was
 * configured with. `label` is a display name the fork sets for a server
 * (Maushaus); entries without one show their host, as before. */
export type SavedServer = {
  apiBase: string;
  headers: Record<string, string>;
  label?: string;
};
```

- `parseSavedServers()`: preserve `label` when it is a string; trim it;
  drop it when empty after trimming; cap it at 40 characters (drop or
  truncate overlong values; prefer truncation so a long label degrades to a
  short one rather than vanishing, and say which in the code comment).
  Unknown fields are ignored as today. The default-server exclusion
  (D-7): an entry whose `apiBase` equals `defaultApiBase()` is dropped
  UNLESS it carries a label. State the reason in the comment: a labeled
  server is pinned by the user and its row is the way back to it; an
  unlabeled default is still covered by the "Use default server" button.
- `recordSavedServer(apiBase, headers, options)`: add
  `options.label?: string`. When no label is passed and an entry already
  exists, keep its label (same "keep what was saved" rule as the existing
  `keepHeaders` option). When a label is passed, set it. `recordSavedServer`
  must also accept a labeled default-server entry (same relaxation as
  parse); without a label it still refuses the default, as today.
- `removeSavedServer()`: unchanged; removing an entry removes its label
  with it (the label lives only on the entry).
- `MAX_SAVED_SERVERS` (5) is unchanged; two servers fit comfortably.
- Pre-fill seeding lives here too; see section 5.

### 4.2 `app/server.tsx` (Recent-servers rows)

Only the row rendering changes, reusing the existing `SettingsRow` /
`LongPressMenu` / `SettingsGroup` components and styles:

- Row title: `entry.label ?? displaySavedServer(entry.apiBase)`.
- When a label exists, show the host as the row's `value`
  (`SettingsRow` already supports `value`; see the Language row in
  `general.tsx`). When there is no label, the title stays the host, exactly
  as today.
- Long-press menu title: `entry.label ?? displaySavedServer(entry.apiBase)`
  (keep it consistent with the row).
- No other visible change. The address field, header editor, "Use default
  server" button, and the `save(entry)` / `forget()` flows are untouched.
  `save(entry)` already passes `target.headers`; it does not need the label.
- Copy rule: no em dashes in any new UI copy (`AGENTS.md`). The only new
  user-facing words in this change are the label itself and the Settings
  row title (section 4.3).
- Note: `server.tsx` does not use `useScreenHeader` / `useSave` today (it
  uses `Stack.Screen` options and local `pending` state). Do not convert it
  in this change; converting a whole screen is out of scope and the brief
  says to reuse existing components and styles only.

### 4.3 Settings entry (`app/(settings)/general.tsx`)

Add one row to the last `SettingsGroup` in `general.tsx`, beside the
existing "AI data sharing" row, reusing `SettingsRow` with a chevron:

- Title: `Server` (new copy; quote it in the PR description per
  `AGENTS.md`).
- Value: the current server's label if the current server has a saved
  entry with one, else `displayApiHost(currentApiBase())`. Read the current
  server the way `ChatContentProviders` in `_layout.tsx` does:
  `useSyncExternalStore(subscribeApiBase, currentApiBase, currentApiBase)`,
  plus `savedServers()` for the label lookup. `general.tsx` already
  imports `currentApiBase`; add `subscribeApiBase` and the saved-servers
  read.
- `onPress`: open the Server screen from the settings sheet. `/server` is
  a root-stack screen, NOT in the `settingsScreens` set in
  `lib/settings/settings-sheet.ts`, so a plain `router.push("/server")`
  from inside the sheet would present a second sheet over it on iOS (see
  the comment at the top of `settings-sheet.ts`). Use the existing pattern
  from `account.tsx` (`settingsLink`): `openFromSettingsSheet(router,
  "/server")`, which closes the sheet first and then pushes. Do NOT add
  `"server"` to `settingsScreens`: that set means "opens inside the sheet",
  and the Server screen is declared on the root stack in `_layout.tsx`
  (formSheet on iOS, card on Android). After the sheet closes and
  `/server` opens, its `close()` (back, or `replace("/sign-in")` when it
  cannot go back) returns to the screen under Settings, i.e. the inbox.
  That is acceptable; note it in the PR.
- Alternative considered: put the row on the Settings hub
  (`app/(settings)/account.tsx`) instead, which is one tap shallower. The
  SCOPE.md suggestion and the connection-adjacent grouping (Language,
  Haptics, notifications) point to `general.tsx`; keep the hub unchanged.
- The sign-in screen link (`app/sign-in.tsx`, "Use a custom server" pushing
  `/server`) is unchanged: it stays the signed-out entry point.
- No change to `_layout.tsx` routing: `/server` is already a declared
  `Stack.Screen`, and `FULL_WINDOW_ROUTES` already contains it.

## 5. Pre-fill

Seed the saved-servers list with Maushaus on first launch. Do NOT pre-fill
the laptop server anywhere: no entry, no hard-coded laptop URL or host in
code, and no default for it.

Seed entry:

```ts
{ apiBase: "https://rakazo.example.com", headers: {}, label: "Home server" }
```

Mechanics (`lib/api/saved-servers.ts`, inside `readSavedServers()` /
`loadSavedServers()`):

- When the stored `rakazo.saved_servers` value is absent (`null`, key never
  written) AND the seed marker is absent, persist the default list
  `[{Maushaus entry}]` and write the marker. The marker is a separate key,
  e.g. `rakazo.saved_servers_seeded` = `"1"`, because an empty list deletes
  the list key (`persist()` deletes the key when the list is empty), so
  "key absent" recurs after the user removes the last entry and cannot by
  itself distinguish "never seeded" from "user removed everything". Without
  the marker, removing Maushaus would resurrect it on the next load.
- When the stored value exists (even if damaged or `[]`), never seed. A
  damaged value parses to `[]` today and stays `[]`; do not overwrite it
  with the seed.
- Seeding runs at boot: `loadApiBase()` calls `loadSavedServers()`, so the
  first launch writes the seed before the Server screen can ever read the
  list. Seeding is a list write like any other: if the write fails, the
  list stays empty and the marker is not written, so a later load retries.
- Interaction with D-7: the seed entry's `apiBase` equals
  `defaultApiBase()` (Maushaus is the default via `EXPO_PUBLIC_API_URL`,
  section 1.3), so it survives `parseSavedServers()` only because of the
  labeled-default relaxation in section 4.1. If that relaxation is rejected
  in review, the fallback is to leave `EXPO_PUBLIC_API_URL` unset as a
  default (not possible for release builds, which throw without it) or to
  accept that the Maushaus row only appears after the first switch away and
  back. The relaxation is therefore part of the pre-fill, not optional.
- When the user later switches away from Maushaus, `rememberServers()`
  records it with `keepHeaders: true`; the label is preserved by the
  keep-existing-label rule in section 4.1. When the user switches TO
  Maushaus, `recordSavedServer()` without a label keeps the existing label.
  The label therefore survives round trips without any label-editing UI.
- No label-editing UI is in scope. A server the user types by hand gets no
  label and shows its host, as today. Label editing is a follow-up if the operator
  wants to name the laptop server in the list.

## 6. Test plan

Test command (from `apps/mobile/package.json`): `pnpm test`
(`vitest run --root ../.. apps/mobile/lib apps/mobile/components`).
Harness conventions from `AGENTS.md`: hold calls open with `deferred()`,
let due timers run with `flush()`, both from `@rakazo/core/test-async`;
wait with `vi.waitFor` / `vi.waitUntil`; never hand-captured resolvers,
zero-timer promises, or sleep loops. Existing mocks to reuse:
`expo-secure-store` backed by a `Map` (`mockSecureStore` in
`lib/api/api-test-helpers.ts`), `resumeLiveNotifications` /
`stopLiveNotifications` mocked in `lib/notifications/live-notifications.js`,
`clearNetworkCache` mocked. Run the touched files first, then `pnpm checks`
and Biome format before any build.

### 6.1 `lib/api/session.test.ts` (extend)

- Per-origin keys: save a token for server A, switch the active server to
  B, save a different token for B, read each back under its own server;
  assert the SecureStore keys written are
  `rakazo.session_token:<origin>` for each origin and that the legacy key
  is never written.
- Migration: seed only the legacy key plus a stored `rakazo.api_base` for
  server A; after `loadApiBase()`, the token reads back for A and the
  legacy key is gone. Seed both legacy and per-origin keys with different
  values; the per-origin value wins and the legacy key is deleted.
- Migration failure: per-origin write throws; the legacy key survives and
  the token is memory-only (`sessionFallback` path); a later launch retries
  adoption.
- Rotation recovery per server: a rotation recorded for server A is not
  adopted when the active server is B (adapts the existing
  "does not adopt a rotation recorded for a different saved token" test to
  the keyed form).
- Scope: saving a verified scope for A, then switching the active server to
  B, makes `loadVerifiedScope()` return null for B until B re-verifies
  (existing "loads the scope only for the exact stored session" test,
  extended across a server change).
- Sign-out scoping: sign out (clear) on A; B's per-origin key still holds
  its token.

### 6.2 `lib/api/api-server.test.ts` (rewrite the switch tests that encode the old rule, then extend)

Tests that assert the OLD behavior and must be rewritten or deleted (name
them so none is missed):

- "clears server-specific session and space state when the API endpoint
  changes": becomes "a server switch leaves the previous server's token
  and Space stored": after `saveApiBase(TWO)`, assert
  `deleteItemAsync` was NOT called with the per-origin token key for ONE
  nor with `rakazo.space_id`, and the per-server map holds ONE's Space.
- "keeps the previous server's revocation pending when switching servers
  signed in": invert. After a signed-in switch, `pendingSignOutRecords`
  is `[]`.
- "records the switch's revocation before discarding the old session":
  delete. There is no record and no discard on switch anymore.
- "a rolled-back server switch leaves no pending revocation": keep the
  name, but the assertion changes from "record settled" to "no record was
  ever created and the old token and Space are intact".
- "aborts a server switch when the revocation cannot be recorded": delete.
  There is no revocation to record; the corresponding new test is "a switch
  proceeds when the pending-sign-out store is unreadable" (it never touches
  that store).
- "delivers a provisional record a failed promotion left behind": keep as
  the upgrade-path compat test (a provisional record written by the OLD
  version is still reconciled and delivered). It now documents the shim,
  not the switch flow.
- "a flush racing a failing server switch cannot revoke the old session":
  adapt. No record exists, so the flush sends nothing; assert `fetchMock`
  has no sign-out calls and the old token is intact.
- "serializes a %s behind an earlier switch rollback": adapt
  expectations. The second switch commits; the first rolls back; the old
  token survives in its per-origin key and `pendingSignOutRecords` is `[]`
  (today it expects a revocation for the old server).
- "a %s rolled back after clearing a stored session a failed save left
  unsent keeps its revocation" and the "revokes it unless %s reactivates
  it" family: adapt to park semantics. A failed save during the hang-up
  leaves the stored token for that server in place; the switch aborts or
  rolls back without creating a revocation; reactivation is now about the
  token still being the active one, not about a record.
- "a reset that cannot store the old server again keeps its session
  revoked, not restored" and "a reset that cannot store the old server
  again signs in to the server the next launch opens": rewrite. Under
  park/restore, a failed endpoint write leaves the old server current, so
  the old session is intact and NOT revoked; the second test's "sign in to
  the server the next launch opens" becomes "the next launch still opens
  the old server with its session".
- "a server switch stops when a session is saved while it clears the old
  one": adapt. The generation check still aborts the switch; the token the
  sign-in saved (for the old server) is intact in its per-origin key and no
  revocation exists for it.
- "restores credentials when the new endpoint cannot be persisted" and
  "restores credentials when resetting the endpoint cannot be persisted":
  keep, with the new meaning of restore (pointer flip, section 2.7).
  Assert `authHeaders()` still carries the old token and Space, and
  `resumeLiveNotifications` was called with the OLD server, token, and
  Space.

New tests to add in this file:

- Park/restore round trip: sign in on A with Space `space-a`, switch to B,
  sign in on B with Space `space-b`, switch back to A. Assert after each
  switch: `currentApiBase()` is the target, `authHeaders()` carries the
  target's token and the target's Space, and no sign-in was needed.
- Switch to an unsigned server: switch to B with no parked token; assert
  the session is empty for B, A keeps its token, and switching back to A
  restores A's session without sign-in.
- No revocation on switch: after a signed-in switch, `pendingSignOutRecords`
  is `[]` and a `flushPendingSignOut(true)` sends no sign-out request.
- Token never sent to the wrong origin: with a fetch mock, perform an RPC
  after switching to B and assert the `Authorization` header carries B's
  token and the request URL starts with B's origin; assert no request to
  A's origin carries B's token (extend the existing "a reset that cannot
  store..." pattern of filtering fetch calls by URL).
- Failed switch rolls back: make the `rakazo.api_base` write throw; assert
  `currentApiBase()` is still A, `authHeaders()` still carries A's token
  and Space, and `resumeLiveNotifications` was called with
  `(A, token-a, space-a)`. Repeat for the headers-save failure.
- Push: `resumeLiveNotifications` is called with the TARGET server, token,
  and Space on a successful switch; `stopLiveNotifications` is NOT called
  on switch (only on sign-out; the existing session test "clears delivered
  notifications only when the session ends" covers the sign-out side).
- Sign-out still revokes exactly one server: sign in on A and B, sign out
  while on A, flush; assert the revocation is delivered to A only and B's
  token is intact.
- Space map: `selectSpace` on A, switch to B (Space `""`), switch back to
  A; assert A's Space is restored. Crash case: stored `SPACE_KEY` holds
  A's Space while `api_base` is B and the map holds B's Space; after
  `loadApiBase()`, the selection is B's Space.

### 6.3 `lib/api/saved-servers-switch.test.ts` (extend)

- Labels survive a switch: switch A (labeled Maushaus) to B and back;
  `savedServers()` still carries `{apiBase: A, headers, label: "Home server"}`
  at the top after returning.
- Label preserved when re-recording without a label: `recordSavedServer(A,
  headers)` on an entry that already has a label keeps the label.
- Labeled default server is listed: with `defaultApiBase()` set to the
  Maushaus origin (or by stubbing the default), an entry for it WITH a
  label survives `loadSavedServers()`; the same entry WITHOUT a label is
  dropped (existing behavior preserved).
- Pre-fill: fresh store (no list key, no marker) loads to the Maushaus
  entry; the store then holds the list key and the marker key.
- Pre-fill does not resurrect: remove the Maushaus entry (long-press
  Remove path, `removeSavedServer`), reload; the list stays empty and the
  marker key is present.
- Pre-fill does not overwrite: a stored damaged list stays `[]` (existing
  "starts empty when..." behavior) and no seed is written.
- Pre-fill does not include the laptop server: assert the seeded list has
  exactly one entry and it is not any laptop origin (assert on the exact
  seeded array).

### 6.4 `lib/api/saved-servers.test.ts` (extend)

- Parse keeps a valid label, trims whitespace, drops an empty label, and
  truncates (or drops, per the section 4.1 decision) an overlong label.
- `recordSavedServer` with `label` sets it; without `label` on an existing
  entry keeps the old one; `removeSavedServer` removes label with entry.

### 6.5 `lib/api/verified-scope.test.ts` (extend)

- Scope re-verification on switch: scope saved for A, switch active server
  to B, `loadVerifiedScope()` is null; after B's `me` saves a scope, it
  loads for B; switching back to A requires A's `me` again (single slot).

### 6.6 Manual verification (on device, after build)

- Install the fork APK alongside the official app; both launch.
- Sign in on Maushaus; switch to the laptop server from Settings, Server;
  sign in there; switch back from Settings, Server; no sign-in prompt.
- Kill the app mid-switch (airplane mode during the switch is the cheap
  approximation) and relaunch; the app opens on one server or the other
  with that server's session intact, never signed out of both.
- Sign out while on Maushaus; the laptop session still works after
  switching to it. Sign back in on Maushaus; the laptop session is still
  intact.
- Leave Maushaus parked for a day, switch back; session resumes (inside
  the 7-day window).
- Push: with the app on the laptop server, trigger a notification from
  Maushaus and from the laptop server; record which arrives (see O-5).
- Confirm the Server screen while signed in shows the Maushaus row labeled
  "Maushaus" with the host underneath, and the laptop row with its host
  only.

## 7. Risks and open questions

### 7.1 Risks

- R-1, OTA overwrite (highest): forgetting to repoint or disable
  `updates.url` lets upstream silently replace the fork. Mitigation: make
  the `app.json` change first, before any code change, and verify the built
  APK's update URL points at the fork project (or that updates are off).
- R-2, session/revocation bugs: per-server sessions touch
  security-sensitive code (token storage, generation counters, rollback).
  A bug could strand a live session or send the wrong bearer to the wrong
  server. Mitigation: the park design never deletes a token on switch, so
  the worst case is a stale pointer, not a lost session; plus the
  wrong-origin test in section 6.2.
- R-3, no push without Firebase: the fork needs its own
  `GOOGLE_SERVICES_JSON`, or it ships without push notifications. The
  release workflow fails the build without it upstream; for the fork, the
  build succeeds but `registerPushToken()` silently skips.
- R-4, keystore loss: no in-place updates afterwards; reinstall and
  re-sign-in on both servers.
- R-5, upstream drift: `session.ts` / `api-server.ts` are actively
  developed upstream; rebasing the fork will conflict in exactly the files
  it touches. The fork should be rebased on a schedule, not left to rot.
- R-6, `ORGANIZATION_SPACES_KEY` is still cleared by `clearSpace()` on
  sign-out of one server (section 2.3). Minor: it is a last-used hint, not
  auth, and it re-derives on next visit.
- R-7, scheme collision: official app and fork both claim the `rakazo`
  scheme; Android may prompt for `rakazo://` links.
- R-8, parked sessions expire server-side (7 days after last use). A
  server left parked past expiry needs a sign-in on return. Expected, but
  the operator should know it is not "signed in forever".
- R-9, laptop reachability (from SCOPE.md, not re-verified here): the
  laptop Rakazo API was bound to `127.0.0.1` only. The phone needs
  `http://100.97.235.102:3100` over Tailscale, not `localhost`. Verify the
  bind address before building; if it only listens on loopback, the laptop
  side needs its bind changed first, or multi-server is unusable in
  practice.

### 7.2 Open questions (could not be determined by reading)

- O-1, expo-updates in SDK 58: what exactly disables OTA (remove the
  `updates` block vs a flag), and whether repointing `updates.url` alone is
  sufficient. Verify against the installed `expo-updates` docs at build
  time.
- O-2, `eas.json` `cli.appVersionSource: "remote"` plus
  `autoIncrement: true`: whether the local `1.0.19` / `versionCode` 11
  edits survive, or the remote EAS state wins. Verify when the fork EAS
  project is created.
- O-3, post-switch navigation when the target has no parked session: the
  routing guard that sends a signed-out app to the sign-in screen was not
  fully traced (`sign-in.tsx` redirects to `/` when a session exists; the
  inverse path, and what the inbox shows with no session after a switch,
  needs one read of the inbox/auth-routing guard at implementation time).
- O-4, unsent queue scope and warning copy: whether the unsent queue in
  `lib/thread/send/` is global or per-server, whether `startUnsentSends()`
  gates on the current server, and whether
  `confirmUnsentSendLoss("server-switch")` copy promises message loss on
  switch (it no longer loses them). Read `unsent-send-warning.ts` and the
  send queue at implementation time; update the copy if it promises loss.
- O-5, parked-server push: what the Android native poller's single-server
  design means for a parked server's notifications, and whether the
  "signed-out drop rule" in `push.ts` drops a parked server's Expo pushes
  after signing out of the current server. Needs on-device testing; the
  plan's switch path does the best-effort registration, but delivery is
  unverified.
- O-6, artifact cache namespace: `lib/artifacts/artifact-cache-session.ts`
  was not read. `saveSessionToken` rotates the artifact namespace; the new
  park path must not rotate it, and restoring a parked token should reuse
  that token's namespace. Verify how the namespace is derived from the
  token before finalizing the switch token-swap.
- O-7, disk caches on switch: `registerSessionDiskCache` callbacks
  (`clearSavedChats`, `clearQueries`, `clearSavedReads`, `clearLastBot`,
  `clearAppBadge`) are driven by `invalidateSessionCaches()`, which the
  park path deliberately does not call. Saved chats/reads are filed under
  the verified scope (per `verified-scope.ts`), so keeping them across a
  switch should be correct, but the exact keying of `saved-chats.ts` and
  `saved-reads.ts` was not read. Verify they partition by scope (and
  therefore by server) before relying on it.
- O-8, SecureStore key charset: per-origin keys embed `://` and `:` in the
  key string. Android EncryptedSharedPreferences keys are plain strings
  and should accept them, but verify once on device (a key that cannot be
  written would silently break the parked session).
- O-9, `docs/self-host-clients.md` ("Connect mobile clients") states the
  old rule ("Changing the server signs the device out of the previous
  one"). It was referenced but not read. Update it alongside
  `docs/mobile-app.md` ("The app is signed in to one server at a time...")
  to describe per-server sessions.
- O-10, iOS identifiers: whether to update the iOS bundle id, app group,
  and extension ids (section 1.1) or leave iOS untouched because the fork
  never builds iOS. Recommend updating for consistency; confirm with the operator
  since it touches identifiers he may not want changed.

## 8. File-by-file change list (summary)

| File | Change |
|---|---|
| `apps/mobile/app.json` | Package id, iOS bundle id + extensions + app group, version 1.0.19, versionCode 11, slug, owner, projectId, OTA repoint/disable. Name and scheme unchanged. |
| `apps/mobile/app.config.ts` | No code change. Build env: `EXPO_PUBLIC_API_URL=https://rakazo.example.com`, fork `GOOGLE_SERVICES_JSON`. |
| `apps/mobile/eas.json` | No change expected; verify remote version state (O-2). |
| `apps/mobile/lib/api/session.ts` | Per-origin token keys, `setSessionServer()`, migration adoption of the legacy key, scope behavior unchanged (single slot, self-heals). |
| `apps/mobile/lib/api/api-server.ts` | Replace `clearCredentialsForEndpointChange()` with park/restore; drop switch revocation and `promotePendingSignOut` on switch; per-server Space map; scoped `clearSpace()`; rollback becomes a pointer flip. |
| `apps/mobile/lib/api/api.ts` | No new behavior except through `clearSpace()` callers; keep pending-sign-out machinery and `reconcileProvisionalSignOuts()` as the upgrade shim. `SPACE_KEY` stays the live slot. |
| `apps/mobile/lib/api/saved-servers.ts` | `SavedServer.label?`; parse/record preserve labels; labeled-default relaxation; pre-fill seeding with marker key. |
| `apps/mobile/app/server.tsx` | Recent rows show label as title, host as value when labeled. Nothing else. |
| `apps/mobile/app/(settings)/general.tsx` | One `Server` row opening `/server` via `openFromSettingsSheet()`, value is the current server label or host. |
| `apps/mobile/lib/notifications/live-notifications.ts` | No change expected. |
| `apps/mobile/lib/notifications/push.ts` | No change expected; called from the switch path after commit. |
| `apps/mobile/lib/auth/api-auth.ts` | No change expected; `signOut()` is the only revocation path and now operates on the current server's per-origin key. |
| `docs/mobile-app.md`, `docs/self-host-clients.md` | Rewrite the "one server at a time" passages for per-server sessions. |
| `apps/mobile/lib/api/session.test.ts` | Per-origin keys, migration, scope across switch, sign-out scoping. |
| `apps/mobile/lib/api/api-server.test.ts` | Rewrite old-rule switch tests; add park/restore, no-revocation, wrong-origin, rollback, push tests. |
| `apps/mobile/lib/api/saved-servers-switch.test.ts` | Labels, pre-fill seed, no-resurrect, no-laptop. |
| `apps/mobile/lib/api/saved-servers.test.ts` | Label parse/record rules. |
| `apps/mobile/lib/api/verified-scope.test.ts` | Scope re-verification on switch. |

## 9. Suggested implementation order

1. Fork identity (`app.json`, EAS project, OTA) first, and verify the built
   APK's update URL. This is the irreversible-safety item.
2. `session.ts` keying + migration, with its tests. No UI yet.
3. `api-server.ts` park/restore + Space map + scoped `clearSpace()`, with
   its tests. At this point the old switch tests will fail until rewritten;
   rewrite them as part of the change, not after.
4. `saved-servers.ts` labels + pre-fill, with its tests.
5. UI: `server.tsx` rows, `general.tsx` Settings row. Screenshot-check
   against the official app; the only visible differences should be the
   label text and the one Settings row.
6. Docs (`mobile-app.md`, `self-host-clients.md`).
7. `pnpm checks`, Biome format, full mobile test run, then the EAS
   `android-apk` build. Verify the laptop bind address (R-9) before the
   first on-device switch test.

Conventions to honor throughout: Biome formatting (`pnpm format`);
`pnpm checks` before pushing; shared primitives only (`bestEffort` from
`@rakazo/logging/best-effort`, never silent `.catch(() => undefined)`);
no em dashes in UI copy; no new dependencies; keep each touched file under
the 1,000-line limit; do not edit `CHANGELOG.md` (release tooling owns it);
PR description in the repo's `## What` / `## Why` / `## Changes` /
`## Tested` shape, quoting the new `Server` copy.
