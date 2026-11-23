# Rakazo Android fork — LOCAL build plan

**Status:** Plan only. Nothing here has been run. Execute only after approval,
step by step, stopping at the first step that does not match its expected
result.

**Sources read (2026-11-22, read-only):** `~/workspace/rakazo-fork-scope/SCOPE.md`;
`apps/mobile/app.json`, `app.config.ts`, `eas.json`, `package.json`,
`metro.config.js`; `.github/workflows/release-android-apk.yml`;
`docs/mobile-release.md`, `docs/mobile-app.md`; repo-root `package.json`,
`pnpm-workspace.yaml`; `apps/mobile/plugins/` (listing + the Android-relevant
plugins). Repo HEAD `26000736`, Expo 58, app version `1.0.18`,
Android `versionCode` 10, upstream package `com.rakazo.app`.

**Constraints this plan honours:** LOCAL build only. No EAS cloud build, no
Expo account, no `EXPO_TOKEN`. No `expo login` anywhere below. Available on
the VM: Node v24.22.1, Android SDK at `~/Android/Sdk`, JDK 17 at
`~/workspace/tools/jdk-17.0.21+9`, and the manual
aapt2/javac/kotlinc/d8/zipalign/apksigner pipeline that has built native
Android APKs here before.

**What the official build does that this plan replaces** (from
`.github/workflows/release-android-apk.yml`): EAS cloud build
(`eas build --platform android --profile android-apk`), EAS managed keystore,
EAS production update channel, `EXPO_TOKEN` secret, `GOOGLE_SERVICES_JSON`
file variable from the EAS production environment, then publish to the rolling
GitHub `android` release. Every one of those is replaced below: local
`expo prebuild` + local Gradle + local keystore + manual signing/verification,
and no publishing step at all (the APK is handed to the operator directly).

---

## Step 0 — Prerequisites (decide/apply BEFORE prebuild; prebuild bakes these in)

Prebuild generates `apps/mobile/android/` from the Expo config, so the fork
identity edits must be in place first. These are code/config edits, not build
commands; apply them as a separate approved change and re-check them in
Step 3. Do not prebuild against the unedited upstream config.

1. **Package id:** `apps/mobile/app.json` → `expo.android.package`:
   `com.rakazo.app` → **`com.welivethisway.rakazo`**. This is what lets the
   fork install alongside the official app. Also change `expo.ios.bundleIdentifier`
   and the `extra.eas.build.experimental.ios.appExtensions` bundle ids if any
   iOS work is ever done; they do not affect the Android build.
2. **OTA updates — disable, do not repoint.** In `app.json` the upstream
   config is:
   `"updates": { "url": "https://u.expo.dev/07f7eb04-45e3-47fe-9374-99a2f991131e" }`
   with `"runtimeVersion": { "policy": "appVersion" }`. Replace the `updates`
   block with `"updates": { "enabled": false }` and delete the upstream
   `updates.url` and the `extra.eas.projectId`
   (`07f7eb04-45e3-47fe-9374-99a2f991131e`). Do NOT create a new Expo project
   or a new updates URL: there is no Expo account for this fork, and a
   disabled updater is the only option that cannot be hijacked by an upstream
   OTA push. Step 6 verifies the built APK contains no reference to
   `u.expo.dev` or the upstream project id; if it does, stop and do not
   distribute the APK.
3. **App identity (cosmetic but do it now):** `expo.name` / `slug` / `scheme`
   (`Rakazo` / `rakazo`) — keep or rename; renaming the scheme changes deep
   links, so decide once and leave it alone afterwards. `expo.owner`
   (`inbox-zero`) should be removed or changed; it is only meaningful to EAS.
4. **Default server:** leave `EXPO_PUBLIC_API_URL` unset for the local build.
   `app.config.ts` only requires it (and requires HTTPS) when
   `EAS_BUILD_PROFILE` is `production`, `android-apk`, or `diagnostic`. A
   local prebuild must therefore be run with `EAS_BUILD_PROFILE` **unset**;
   the app then falls back to its built-in default (`http://127.0.0.1:3100`).
   If a fork default server URL is ever wanted, set it as an env var at
   prebuild time — never commit a private URL (repo AGENTS.md: no private
   URLs in tracked files).
5. **Push notifications — accepted loss for v1:** without your own Firebase
   project there is no `GOOGLE_SERVICES_JSON`, so the fork gets **no push
   notifications**. The official workflow *fails the build* without it; the
   local build will succeed without it, but push simply will not register.
   `app.config.ts` only wires `googleServicesFile` in when the
   `GOOGLE_SERVICES_JSON` env var is set, so leaving it unset is safe. If
   push is later wanted: create a Firebase project, register the
   `com.welivethisway.rakazo` package, download `google-services.json`, and
   set `GOOGLE_SERVICES_JSON=<path>` at prebuild time (never commit the file).
   Firebase config is native, so an OTA update could never add it later —
   but OTA is disabled anyway, so it would need a rebuild regardless.
6. **Pre-check from SCOPE.md (not a build step, but a go/no-go gate):** the
   laptop Rakazo API (port 3100) was bound to `127.0.0.1` only. The phone
   needs `http://100.97.235.102:3100` over Tailscale. Verify the laptop bind
   address before building, or the multi-server feature may be unusable on
   the phone even if the APK is perfect.

**Stop here if:** the identity/OTA edits in (1)–(2) are not yet applied, or
the laptop reachability check in (6) fails and the operator still wants the laptop
server in the fork. Do not prebuild first and fix identity later; prebuild
output would have to be regenerated.

---

## Step 1 — Tool setup: pnpm + Expo CLI (no Expo account)

Network access needed: yes, for the npm registry (pnpm + package downloads)
and for Gradle distribution download in Step 5. No Expo account, no
`EXPO_TOKEN`, no `expo login` at any point.

1. Confirm the baseline (read-only checks, run first):
   ```sh
   node --version        # expect v24.22.1 (repo engines: ^24.15.0 || >=26.0.0, so OK)
   ls ~/Android/Sdk
   ls ~/workspace/tools/jdk-17.0.21+9/bin/java
   ```
   Note: `eas.json` pins Node `24.22.2` and pnpm `12.18.0`, but that file is
   EAS-cloud-only and is ignored by the local path. The binding local
   requirement is the repo-root `package.json`: `"packageManager":
   "pnpm@12.18.0"` and `engines.node ^24.15.0 || >=26.0.0`.
2. Install pnpm **12.18.0 exactly** via Corepack (ships with Node 24; no
   separate download tool needed):
   ```sh
   corepack enable
   corepack prepare pnpm@12.18.0 --activate
   pnpm --version        # expect 12.18.0
   ```
   Alternative if Corepack is disabled on the VM: `npm install -g pnpm@12.18.0`.
   Do not install any other pnpm version: `pnpm-workspace.yaml` sets
   `engineStrict: true`, and the lockfile was written by 12.18.0.
3. Expo CLI: **do not install anything separately.** `expo` 58.0.26 is a
   dependency of `@rakazo/mobile`, and `eas-cli` 27.5.0 is one of its
   devDependencies, so both arrive with Step 2 (`pnpm install`) and are run
   as `pnpm --filter @rakazo/mobile exec expo …` / `pnpm exec expo …` from
   `apps/mobile`. Never run `npm install -g expo-cli` / `eas-cli`: a global
   CLI would drift from the versions the repo pins. `eas` is not used at
   all in this plan (no cloud build), so its presence in devDependencies is
   incidental.
4. Confirm the Android SDK has what Gradle will ask for (read-only check):
   ```sh
   ls ~/Android/Sdk/build-tools ~/Android/Sdk/platforms
   ```
   After prebuild (Step 3), compare against `compileSdkVersion` /
   `buildToolsVersion` in the generated `android/app/build.gradle`. If a
   platform or build-tools version is missing, install it with
   `~/Android/Sdk/cmdline-tools/latest/bin/sdkmanager "platforms;android-XX"
   "build-tools;XX.0.0"` — that is the only SDK mutation expected.

**Failure modes / fallbacks:**
- `corepack prepare` fails (no network / Corepack blocked) → use the
  `npm install -g pnpm@12.18.0` alternative; if npm registry is unreachable
  at all, STOP — nothing downstream can run without dependencies.
- `pnpm --version` shows a different version → re-run
  `corepack prepare pnpm@12.18.0 --activate` in the same shell; Corepack
  shims are per-shell, so re-check in every new shell.
- Wrong Node major (e.g. Node 22) → STOP; `engineStrict: true` will refuse
  the install, and Expo 58 / RN 0.88 require Node 24 per the repo engines.

---

## Step 2 — Dependency install (whole monorepo)

From the repo root (`~/workspace/rakazo-fork/`):

```sh
cd ~/workspace/rakazo-fork
pnpm install --frozen-lockfile
```

- **Scope:** the whole monorepo, not just `apps/mobile`. The mobile app
  depends on workspace packages (`@rakazo/chat-ui`, `@rakazo/contracts`,
  `@rakazo/core`, `@rakazo/i18n`, `@rakazo/logging`, `@rakazo/ui-tokens` —
  all `workspace:*` in `apps/mobile/package.json`), and Metro resolves their
  TypeScript sources at build time (`apps/mobile/metro.config.js` +
  `metro-resolver.js`). Installing only the mobile workspace would leave
  those links dangling. `pnpm-workspace.yaml` includes `apps/*`,
  `packages/*`, `infra/sandboxes/supervisor`, `infra/updater`.
- **Expected size/time (estimates, not measured):** this is a large monorepo
  (web, desktop, API, adapters, mobile). Expect several GB of
  `node_modules` across the workspaces and roughly 5–20 minutes on first
  install, depending on network and disk. Do not interrupt it; a partial
  `node_modules` is worse than a slow one.
- **Then verify the mobile project before touching native code** (this is
  the same check the official workflow runs, minus EAS):
  ```sh
  pnpm --filter @rakazo/mobile check
  ```
  That runs `cross-env EXPO_OFFLINE=1 expo install --check` (native-module /
  SDK compatibility) followed by `tsrs --noEmit -p tsconfig.json`
  (typecheck). Both must pass. `EXPO_OFFLINE=1` is set by the script itself.
- **Do not run** `pnpm build`, `pnpm checks`, or the full test suite here:
  they cover the web/desktop/API and are not needed for a mobile-only APK.
  If a mobile test is wanted later, `pnpm --filter @rakazo/mobile test`
  runs vitest over `apps/mobile/lib` and `apps/mobile/components`.

**Failure modes / fallbacks:**
- `--frozen-lockfile` fails with a lockfile mismatch → STOP and report the
  exact error. Do not run a bare `pnpm install` (it would rewrite
  `pnpm-lock.yaml` and drift the fork from upstream HEAD). The lockfile
  should match HEAD `26000736`; a mismatch means the fork copy is dirty.
- `engineStrict` Node error → re-check Step 1 (Node version).
- `expo install --check` reports mismatched native modules → run
  `pnpm exec expo install --fix` from `apps/mobile` (per
  `docs/mobile-release.md`), then re-run the check. If `--fix` wants to
  change versions, record the diff and get approval before proceeding —
  it mutates `package.json` / the lockfile.
- Typecheck (`tsrs`) failures → STOP. A failing typecheck means the fork's
  code edits (Step 0 or the switcher work) are broken; do not paper over it
  with a build.
- Network timeout mid-install → re-run the same command; pnpm resumes from
  its store. If it fails three times, check disk space (`df -h`) — a full
  disk is the usual silent cause on this VM — then report.

---

## Step 3 — Prebuild: generate the Android native project

From `apps/mobile`:

```sh
cd ~/workspace/rakazo-fork/apps/mobile
pnpm exec expo prebuild --platform android --clean
```

- **What it generates:** `apps/mobile/android/` — a standard Gradle project
  (`settings.gradle`, `app/build.gradle`, `gradlew`, `AndroidManifest.xml`,
  `app/src/main/java/com/welivethisway/rakazo/…`, resources, and the
  `expo-updates` / notification / share-extension native wiring). No
  `android/` directory exists in the fork today (verified by listing), so
  this is a first-time generation, not a regeneration. `--clean` deletes any
  existing `android/` first; on a first run it is a no-op safety net.
- **Env for this step:** `EAS_BUILD_PROFILE` must be **unset** (see Step 0.4
  — otherwise `app.config.ts` throws demanding an HTTPS
  `EXPO_PUBLIC_API_URL`). `GOOGLE_SERVICES_JSON` unset (Step 0.5).
  `SENTRY_AUTH_TOKEN` unset unless Sentry upload is explicitly wanted; if
  set, `app.config.ts` adds the `@sentry/react-native/expo` plugin and the
  build will try to upload mappings.
- **What to check in the generated `android/` dir (do this before Step 5):**
  1. `android/app/build.gradle` (or `app/build.gradle.kts`): `applicationId`
     is `com.welivethisway.rakazo`; `versionCode` 10 and `versionName`
     `1.0.18` (bump `versionCode` in `app.json` before prebuild if a newer
     fork build must supersede an older one on the phone — Android refuses
     to install over an equal/lower versionCode with the same package id).
     Note `compileSdkVersion` / `buildToolsVersion` and confirm the SDK has
     them (Step 1.4).
  2. `android/app/src/main/AndroidManifest.xml`: `package` /
     `applicationId` matches; `android:usesCleartextTraffic="true"` is
     present (added by `plugins/with-lan-cleartext.js` — this is what lets
     release builds reach a self-hosted server over `http://` on the LAN,
     e.g. the Tailscale laptop server); `android:gwpAsanMode="never"` is
     present (added by `plugins/with-android-no-gwp-asan.js` — works around
     a Hermes crash on Android 14+); share-intent filters are present
     (added by `plugins/with-share-extension.js`).
  3. **OTA check (most important):** search the whole generated tree for
     the upstream project id and update host:
     `grep -r "07f7eb04" android/ ; grep -r "u.expo.dev" android/` — both
     must return **nothing**. If either matches, the Step 0.2 edit did not
     take effect: STOP, fix `app.json`, re-run prebuild `--clean`.
  4. `android/app/src/main/java/com/welivethisway/rakazo/` exists with
     `MainActivity` / `MainApplication` under the fork package path (not
     `com/rakazo/app/`).
  5. `git status` in the repo root: the generated `android/` directory
     should show as ignored/untracked-generated, not as a pile of new
     tracked files. Do **not** commit it. (Repo AGENTS.md: keep tracked
     mobile files out of ignore patterns for EAS upload selection — that
     rule is about EAS uploads and does not apply to the local path; the
     generated native project is regenerable from `app.json` + plugins and
     belongs outside version control.)
  6. Plugin notes: `with-worklets-headers.js`, `with-app-intents.js`,
     `with-apple-watch.js`, `with-agent-notifications.js` are iOS-only
     (Podfile / Xcode / Swift) and do nothing for Android; their presence
     is harmless. `with-share-extension.js` also carries the iOS app-group
     id `group.com.rakazo.app` — Android side is unaffected, but flag it if
     the fork ever renames the iOS app group.

**Failure modes / fallbacks:**
- Prebuild fails in a config plugin (most likely `with-share-extension` or
  an `expo-*` plugin version skew) → read the plugin's error, check whether
  Step 2's `expo install --check` actually passed, and re-run prebuild
  without `--clean` once (a stale partial `android/` can confuse it). If it
  still fails, STOP — do not hand-edit generated files to force it through;
  report the plugin name and error.
- Prebuild succeeds but the OTA grep in (3) matches → STOP (see above).
  This is the fork's single biggest risk (SCOPE.md risk #1).
- Prebuild succeeds but `applicationId` is still `com.rakazo.app` → the
  Step 0.1 edit was missed or prebuild read a cached config; fix `app.json`
  and re-run with `--clean`. Never edit `applicationId` in the generated
  `build.gradle` by hand — it will be overwritten on the next prebuild.

---

## Step 4 — Keystore: generate a local release keystore

The fork must be signed with a keystore **we** own. Losing it means the
installed app can never be updated in place — the only recovery is
uninstall + reinstall + sign in again on both servers (SCOPE.md risk #4).
The official build uses an EAS managed keystore; the local path replaces it
with a file keystore.

```sh
export JAVA_HOME=~/workspace/tools/jdk-17.0.21+9
$JAVA_HOME/bin/keytool -genkeypair -v \
  -keystore ~/workspace/rakazo-fork/keystore/release.keystore \
  -alias <ALIAS> \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass <STORE_PASSWORD> -keypass <KEY_PASSWORD> \
  -dname "CN=<Your Name>, OU=<Org Unit>, O=<Org>, L=<City>, ST=<State>, C=<Country>"
```

- **Location:** `~/workspace/rakazo-fork/keystore/release.keystore` — inside
  the fork workspace as requested, so it travels with the fork's files.
  **Never commit it.** Add `keystore/` (or at minimum `*.keystore`,
  `*.jks`) to the fork's `.gitignore` before generating, and verify with
  `git status` that the keystore does not appear as a candidate file. Repo
  AGENTS.md forbids secrets in tracked files; a keystore is a secret.
- **Passwords/alias — placeholders only, never real values in any doc:**
  use a distinct alias (e.g. `welivethisway-rakazo`), a strong random
  store password and a strong random key password, and record the three
  values (alias, store password, key password) in the user's password
  manager — not in this plan, not in a file in the repo, not in chat.
  `-validity 10000` (~27 years) matches the Play-store convention and
  avoids an expiry surprise.
- **Backup (do this the same day):** copy the keystore to a second location
  off this VM (encrypted, e.g. in the password manager's file storage or an
  encrypted drive). A keystore that exists in exactly one place is already
  half-lost. Verify the backup by running `keytool -list` against the copy.
- **Gradle signing config:** create
  `apps/mobile/android/gradle.properties` (generated dir — it will be
  wiped by the next `prebuild --clean`, so keep a copy of these four lines
  in the keystore folder's README, outside the generated tree) with:
  ```properties
  RELEASE_STORE_FILE=<absolute path to release.keystore>
  RELEASE_STORE_PASSWORD=<STORE_PASSWORD>
  RELEASE_KEY_ALIAS=<ALIAS>
  RELEASE_KEY_PASSWORD=<KEY_PASSWORD>
  ```
  and add the matching `signingConfigs.release` block to the generated
  `android/app/build.gradle` (release buildType → `signingConfig
  signingConfigs.release`). Because both files live under generated
  `android/`, they must be re-applied after every `prebuild --clean` —
  record that as a step in the rebuild checklist, or the next build will
  silently come out unsigned and Step 6 will catch it.
  Alternative that survives prebuild: sign manually with `apksigner` after
  the Gradle build (Step 5/6) instead of configuring Gradle signing. Either
  route is fine; pick one and use it consistently.
- **If a keystore already exists** from a previous fork build, do NOT
  generate a new one — re-use it, or the new APK will not install over the
  old one (Android rejects a same-package update signed with a different
  key). Generating a second keystore is a STOP-and-ask moment.

**Failure modes / fallbacks:**
- `keytool` not found → `JAVA_HOME` is wrong; use the full path above
  (JDK 17 ships `keytool`).
- Keystore path inside a git-tracked directory and `git status` shows it →
  STOP, fix `.gitignore` first, regenerate only if the file was already
  committed anywhere (a committed keystore is compromised: generate a new
  alias/passwords and treat the old file as public).
- Passwords lost later → unrecoverable by design; that is why the password
  manager + off-VM backup steps are mandatory, not optional.

---

## Step 5 — Gradle build (assembleRelease)

```sh
cd ~/workspace/rakazo-fork/apps/mobile/android
export JAVA_HOME=~/workspace/tools/jdk-17.0.21+9
export ANDROID_HOME=~/Android/Sdk
export ANDROID_SDK_ROOT=~/Android/Sdk
./gradlew :app:assembleRelease --no-daemon
```

- **Env:** JDK 17 is required (React Native 0.88 / Expo 58 target JDK 17;
  do not use a system JDK 21). `ANDROID_HOME`/`ANDROID_SDK_ROOT` must point
  at `~/Android/Sdk`. Run from `apps/mobile/android` so the wrapper finds
  `settings.gradle`. `--no-daemon` keeps the Gradle daemon from lingering
  on the shared VM; omit it on repeat builds if daemon reuse is preferred.
- **What happens:** first run downloads the Gradle distribution the wrapper
  pins (network), then compiles the React Native native code, bundles the
  JS with Metro (`metro.config.js` — Sentry transformer + custom resolver;
  this is the step that needs the full `node_modules` from Step 2), runs
  R8, and produces the APK.
- **Expected duration (estimates):** first build 10–25 minutes (Gradle
  download + native compile + Hermes bundle); repeat builds 3–8 minutes.
  The build is CPU-heavy; do not run other large jobs on the VM at the same
  time.
- **Output:** `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
  (signed if the Step 4 Gradle signing config was applied, unsigned
  otherwise — check in Step 6 either way). Copy it to a stable location
  outside the build tree for handoff, e.g.
  `~/workspace/rakazo-fork/rakazo-fork-1.0.18-10.apk` (name includes
  version + versionCode so builds are distinguishable).
- **If Gradle signing was NOT configured:** sign manually now:
  ```sh
  ~/Android/Sdk/build-tools/<VERSION>/apksigner sign \
    --ks ~/workspace/rakazo-fork/keystore/release.keystore \
    --ks-key-alias <ALIAS> \
    --out rakazo-fork-1.0.18-10.apk \
    app/build/outputs/apk/release/app-release.apk
  ```
  (apksigner will prompt for the keystore/key passwords; do not put them on
  the command line, where they land in shell history.)

**Failure modes / fallbacks:**
- `SDK location not found` / missing platform or build-tools → set
  `ANDROID_HOME` as above; install the exact versions Step 3.1 recorded
  via `sdkmanager`.
- `Unsupported class file major version` / JDK error → `JAVA_HOME` is
  pointing at the wrong JDK; re-export JDK 17 and re-run. Never switch the
  project to a newer JDK to silence this.
- Metro bundling fails (missing module, resolver error) → the usual cause
  is a stale or partial `node_modules`; re-run Step 2, then re-run the
  Gradle build. If the error names a workspace package, check that
  `pnpm install` completed (Step 2) — Metro resolves `@rakazo/*` sources
  from the workspace, not from a registry.
- Native compile error in a third-party module (e.g. Reanimated/Worklets
  headers) → note that `with-worklets-headers.js` is iOS-only; an Android
  compile failure there is a real upstream/RN-version issue, not a missing
  plugin. STOP and report the failing module + error.
- Out of memory (`OutOfMemoryError`, Gradle killed) → re-run with
  `ORG_GRADLE_JVMARGS="-Xmx4g"` (VM has 6 GB total; do not exceed 4 GB for
  Gradle). If it still OOMs, STOP — the VM cannot build this target as
  configured.
- Build succeeds but takes >45 minutes on first run → let it finish once
  (Gradle download + compile on a small VM is slow); only treat it as stuck
  if there is no log output for 10+ minutes.

---

## Step 6 — Signing + verification WITHOUT a phone

All checks run on the VM against the APK file. None of them needs a device.

```sh
APK=~/workspace/rakazo-fork/rakazo-fork-1.0.18-10.apk
BT=~/Android/Sdk/build-tools/<VERSION>   # the version that matches Step 3.1

# 1. Signature is present and valid (v1 + v2/v3 schemes)
$BT/apksigner verify --verbose --print-certs "$APK"
#    expect: "Verifies" and a certificate whose SHA-256 matches the Step 4
#    keystore: keytool -list -v -keystore <keystore> shows the same fingerprint.
#    If apksigner says "DOES NOT VERIFY" or "no APK Signature Scheme v2
#    signature", the APK is unsigned or was signed with the wrong key: STOP.

# 2. zipalign (required for install; Gradle normally aligns, apksigner-signing does not unalign)
$BT/zipalign -c -v 4 "$APK" | tail -5
#    expect: "Verification successful".

# 3. Identity: package id, versionCode, versionName
$BT/aapt dump badging "$APK" | grep -E "package:|application-label"
#    expect: package: name='com.welivethisway.rakazo' versionCode='10'
#    versionName='1.0.18', and label 'Rakazo' (or the fork name chosen in Step 0.3).
#    If name='com.rakazo.app' appears, the fork would collide with / overwrite
#    the official app: STOP, do not distribute.

# 4. OTA must be disabled / upstream must be absent inside the built APK
$BT/aapt2 dump xmltree "$APK" AndroidManifest.xml | grep -i -E "expo|update|u\.expo\.dev|07f7eb04"
unzip -p "$APK" assets/index.android.bundle | strings | grep -E "u\.expo\.dev|07f7eb04" || echo "no upstream update URL in JS bundle"
#    expect: no matches for u.expo.dev or 07f7eb04 anywhere. Any match means
#    an upstream OTA endpoint survived into the binary: STOP, do not
#    distribute; fix Step 0.2 and rebuild from Step 3.
#    (Also confirm expo-updates is inert: with "enabled": false there should
#    be no EXPO_UPDATES_URL / EXPO_UPDATE_URL meta-data in the manifest dump.)

# 5. Sanity: size, contents, cleartext + push expectations
ls -lh "$APK"                       # expect roughly 60-120 MB (RN + Hermes + assets)
unzip -l "$APK" | grep -iE "lib/.*\.so|assets/index|AndroidManifest|res/.*google" | head -20
$BT/aapt2 dump xmltree "$APK" AndroidManifest.xml | grep -i cleartext
#    expect: usesCleartextTraffic=true (Step 3.2). Expect NO google-services
#    resources (Step 0.5: no Firebase config => no push; this confirms the
#    accepted limitation rather than a build error).
```

- **Pass criteria (all must hold):** apksigner verifies against the Step 4
  keystore fingerprint; zipalign passes; badging shows
  `com.welivethisway.rakazo` / versionCode 10 / versionName 1.0.18; no
  `u.expo.dev` / `07f7eb04` string anywhere in the manifest or JS bundle;
  cleartext flag present.
- **What these checks cannot prove:** that the JS bundle actually runs
  (Metro could bundle broken code that only crashes at launch), that
  sign-in works, or that the app can reach either server. Those need a
  phone (Step 8).

**Failure modes / fallbacks:**
- `apksigner verify` fails → the APK is unsigned (Gradle signing config
  missing) or signed with a different key. If unsigned, sign manually per
  Step 5 and re-verify; if the fingerprint does not match the Step 4
  keystore, STOP — a wrong-key APK would brick in-place updates.
- Badging shows the wrong package/version → rebuild from Step 3 after
  fixing `app.json`; never edit the APK.
- OTA strings present → STOP (see check 4). Do not hand-edit the APK to
  strip them; a tampered APK fails signature verification.
- `aapt`/`aapt2` not found under the expected build-tools version → list
  `~/Android/Sdk/build-tools/` and use the version installed; if none is
  installed, install one with `sdkmanager` (Step 1.4).

---

## Step 7 — Failure modes, fallbacks, and stop conditions (summary)

| Step | Failure | Fallback | Stop? |
|---|---|---|---|
| 1 Tool setup | No network to npm registry | Retry once; check VM network | Yes — nothing downstream can run |
| 1 | Wrong Node / pnpm version | Re-run Corepack prepare; check shell | Yes if Node major is wrong |
| 2 Install | Lockfile mismatch (`--frozen-lockfile`) | None — do not rewrite the lockfile | Yes, report the diff |
| 2 | `expo install --check` mismatch | `expo install --fix` in `apps/mobile`, re-check | Only if `--fix` wants version changes — get approval first |
| 2 | Typecheck fails | Fix the fork code; do not build around it | Yes |
| 3 Prebuild | Config-plugin error | Re-run once without `--clean`; check Step 2 | Yes if it persists |
| 3 | Upstream OTA id/URL in generated tree | Fix `app.json`, re-run `--clean` | Yes — do not proceed with a match |
| 3 | Wrong `applicationId` | Fix `app.json`, re-run `--clean` | Yes — never hand-edit generated gradle files as the fix |
| 4 Keystore | Already committed / exposed | Regenerate, treat old as public | Yes, and rotate |
| 4 | A previous fork keystore exists | Re-use it; never generate a second one for the same package | Yes — ask before generating |
| 5 Gradle | Missing SDK platform/build-tools | Install exact versions via `sdkmanager` | No — install and retry |
| 5 | Wrong JDK | Re-export JDK 17 | No — retry |
| 5 | Metro bundling fails | Re-run Step 2, rebuild | Yes if it names a workspace package that Step 2 cannot fix |
| 5 | Native compile error (3rd-party module) | None locally | Yes, report module + error |
| 5 | Gradle OOM | `-Xmx4g`, retry once | Yes if it still OOMs |
| 6 Verify | Unsigned / wrong-key signature | Manual `apksigner sign`, re-verify | Yes if fingerprint ≠ Step 4 keystore |
| 6 | Wrong package id in badging | Rebuild from Step 3 | Yes — do not distribute |
| 6 | Upstream OTA strings in APK | Fix Step 0.2, rebuild from Step 3 | Yes — do not distribute, do not hand-edit the APK |

**Hard stops (any one ends the run, no workarounds):**
1. Local prebuild proves unworkable — e.g. a config plugin fails
   repeatedly, or prebuild requires an Expo account / `EXPO_TOKEN` for some
   step (it should not; if it does, that is a finding, not a prompt to log
   in). Fallback at that point is the EAS cloud path, which needs an Expo
   account + project + token and is explicitly out of scope for this plan;
   report back for a decision.
2. The built APK still references the upstream updates URL / project id.
3. The APK is signed with the wrong key or cannot be verified.
4. The fork package id is not `com.welivethisway.rakazo`.
5. The keystore is lost, committed, or a second keystore was generated for
   the same package id.

**Rebuild checklist (every later build):** re-apply Step 0 edits if
`app.json` was rebased onto a newer upstream HEAD; re-run prebuild
`--clean`; re-apply the Gradle signing config (Step 4) into the regenerated
`android/` tree; bump `versionCode` in `app.json` before prebuild so the new
APK installs over the old one; re-run all Step 6 checks.

---

## Step 8 — What still cannot be verified without a phone

None of the following can be established on the VM. Do not present the APK
as "working" until the operator (or another tester with a phone) confirms them:

1. **Install:** sideloading the APK, install-over the previous fork build
   (same key = in-place update; different key = install failure), and
   install-alongside the official `com.rakazo.app` build.
2. **Launch:** first-run crash check (Hermes, GWP-ASan workaround, native
   modules), splash → sign-in screen, no immediate OTA prompt or update
   download (the disabled-updates behaviour in practice).
3. **Sign-in:** sign in to the Maushaus server, then to the laptop server
   (`http://100.97.235.102:3100` over Tailscale — depends on the Step 0.6
   bind-address fix), and confirm the LAN cleartext flag actually permits
   the `http://` connection in a release build.
4. **Server switching on device:** the fork's actual feature (per-server
   sessions / Settings entry) — switching, session restore without
   re-sign-in, no token sent to the wrong origin, push re-registration.
5. **Push notifications:** expected to be absent (Step 0.5); confirm the
   app does not crash or loop retrying registration.
6. **Share extension, voice calls, camera/image attach, notifications
   settings:** native surfaces that only exist on a device.
7. **Battery / background behaviour** and the morning-digest / live
   notification paths, if any apply to the fork.

**Handoff note for the phone test:** ship the APK file (not a store link),
plus the versionCode/versionName and the apksigner fingerprint from Step 6,
so the operator can confirm the installed app is the verified build. If any Step 8
item fails, the fix is a code/config change followed by a rebuild from
Step 3 (native/config change) or Step 5 (JS-only change, after re-running
prebuild only if config changed) — never a patch to the APK file itself.
