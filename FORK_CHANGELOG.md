# Rakazo Fork — Changelog

## 1.0.20 (versionCode 12) — 2026-11-22

### First-launch server fix

- On a fresh install the Server screen opened on `http://127.0.0.1:3100`
  (the upstream loopback default, unreachable from a phone) instead of
  the seeded Maushaus server. First launch now opens Maushaus and
  remembers it, so a relaunch stays on Maushaus. Returning devices keep
  the server they were on; a restart still restores it.
- Every server switch failed with "Could not save the previous server
  session", even tapping the Maushaus row. Root cause: the per-origin
  session key was `rakazo.session_token:` plus the server URL, and
  SecureStore only allows letters, digits, `.`, `-`, `_` in a key, so
  every read and write of a per-origin token threw on a real device. The
  key is now `rakazo.session_token.` plus a hex-encoded origin, using
  only SecureStore-valid characters. This resolves the O-8 limitation
  from 1.0.19. No migration is needed: 1.0.19 never managed to write a
  per-origin token, so no device holds one under the old keys; the
  legacy global key migration is untouched.
- The test SecureStore mock now enforces the real key rule, so a bad key
  fails in tests the way it fails on a device.
- Regression tests: first launch opens Maushaus, remembers it across a
  relaunch, and switches with no previous session; session keys stay
  inside SecureStore's alphabet for loopback, Maushaus, LAN and
  second-server origins, and two servers get different keys.

### Known wart

- "Use default server" still restores the upstream loopback default
  (`http://127.0.0.1:3100`), not Maushaus. The first-launch default and
  the reset default disagree until that is aligned.

### Build info

- Package: `com.welivethisway.rakazo`, version 1.0.20, versionCode 12.
- Signing: release keystore `keystore/release.keystore`, alias
  `welivethisway-rakazo`, RSA 2048, valid until 2054-04-09.
  SHA-256 fingerprint:
  `F8:64:71:DD:75:41:3F:E1:CA:27:1D:10:17:B2:74:9F:FC:88:A9:30:44:8C:57:71:D9:38:04:05:12:8C:75:59`
  (same key as 1.0.19, so this installs over it).
  APK verified with `apksigner verify` (v2 + v3 schemes), `zipalign -c`,
  and `aapt dump badging` (package, versionCode, versionName, label
  `Rakazo` all match). The JS bundle contains zero occurrences of the
  upstream EAS project id `07f7eb04`; the single `u.expo.dev` hit is the
  known false positive (`expo.dev-toStandardLazyRequest`), not a URL.
- APK: `rakazo-fork-1.0.20-12.apk`, 130,500,007 bytes (~124 MB).
- Full mobile suite: 360 files, 4,484 tests, all passing.
- Build notes: the Gradle build was interrupted twice by runtime
  restarts (once during the app native compile, once during R8) and
  resumed incrementally both times; the egress truststore
  (`/tmp/egress-cacerts`) had to be rebuilt from the CA bundle after each
  restart. Total build time across the three runs was about 70 minutes
  of Gradle work; the final run completed in 26m 35s.

## 1.0.19 (versionCode 11) — 2026-11-22

### Fork identity

- Package `com.welivethisway.rakazo`, version 1.0.19 (versionCode 11),
  slug `rakazo-fork`.
- OTA disabled (`updates: {"enabled": false}`); the upstream EAS project
  (`07f7eb04-45e3-47fe-9374-99a2f991131e`) and its updates URL are removed.
  No upstream OTA string survives in the APK (verified: the EAS project id
  appears zero times in the JS bundle; the single `u.expo.dev` regex hit is
  a false positive, the tail of the words "for you." running into the next
  minified token `expo.dev-toStandardLazyRequest…`, not a URL).
- No push: no `google-services.json`, no Google services config. Push
  delivery is the accepted v1 limitation.

### Multi-server sessions

- Stay signed in on each server; switching servers parks the session
  (token + Space) instead of signing out. Switching back needs no sign-in.
- Per-origin session tokens, with a one-time migration from the legacy
  global key.
- Per-server Space memory; each server's last Space is restored on return.
- Saved servers: optional labels (label as row title, host as value).
  Labeled default servers can be pinned. Maushaus is pre-filled once on
  first launch.
- Settings gains a Server row opening the server screen.
- Unsent messages wait for their server across a switch instead of being
  deleted; sign-out/sign-in still delete them.
- No revocation is recorded on a server switch; only a real sign-out
  revokes a session.
- Docs updated for per-server sessions (`docs/mobile-app.md`,
  `docs/self-host-clients.md`).

### Known limitations needing on-device confirmation

- Parked-server push delivery (O-5).
- SecureStore per-origin key charset on Android (O-8).
- Parked token artifact-namespace reuse (cold cache after a round trip,
  never deleted).
- The app is built against compileSdk 36 with AGP's compileSdk check
  disabled (see Build notes below). The Expo 58 libraries are built to run
  on devices up to API 36, but only installing and running the APK on a
  phone proves no library calls an API 37 symbol unguarded.
- Install, launch, sign-in to Maushaus and to the laptop server, and the
  LAN cleartext flag in a release build still need a phone to confirm.

### Build info

- Package: `com.welivethisway.rakazo`, version 1.0.19, versionCode 11.
- Signing: release keystore `keystore/release.keystore`, alias
  `welivethisway-rakazo`, RSA 2048, valid until 2054-04-09.
  SHA-256 fingerprint:
  `F8:64:71:DD:75:41:3F:E1:CA:27:1D:10:17:B2:74:9F:FC:88:A9:30:44:8C:57:71:D9:38:04:05:12:8C:75:59`.
  APK verified with `apksigner verify` (v2 + v3 schemes), `zipalign -c`,
  and `aapt dump badging` (package, versionCode, versionName, label
  `Rakazo` all match).
- APK: `rakazo-fork-1.0.19-11.apk`, 130,495,911 bytes (~125 MB, a little
  above the 60–120 MB estimate; four ABIs of native libraries).
  Built 2026-11-22, 21:30 UTC (16:30 EST).
- Full mobile test suite re-run from scratch before the build: 360 files,
  4,481 tests, all passed. `pnpm --filter @rakazo/mobile check` passed.

### Build notes (SDK 36)

- Expo 58 defaults to compileSdk 37 and build-tools 37.0.0, but no API 37
  platform is published in any SDK channel sdkmanager knows (stable, beta,
  dev and canary all top out at API 36 as of 2026-11-22), so the build
  failed on `platforms;android-37.0`.
- The fork builds against SDK 36 via the `with-sdk-36` config plugin
  (`apps/mobile/plugins/with-sdk-36.js`, wired in `app.json`). It is
  tracked and re-applies itself on every prebuild: it sets
  `compileSdkVersion = 36` and `buildToolsVersion = "36.0.0"` in the root
  build.gradle before Expo's root plugin runs, and adds
  `android.experimental.disableCompileSdkChecks=true` to
  `android/gradle.properties`, because every Expo 58 module and AndroidX
  Compose 1.12 stamp minCompileSdk 37 in their AAR metadata and AGP's
  `checkReleaseAarMetadata` otherwise fails. (Note:
  `android.suppressUnsupportedCompileSdk` does NOT do this; it only
  suppresses warnings when the project's own compileSdk is newer than AGP
  supports.)
- Rebuild environment (VM-specific, not in the repo): the build script is
  saved at `~/workspace/rakazo-fork-build/gradle-build.sh` with the
  successful build log next to it. It sets the egress proxy and a
  truststore holding the sandbox CA, uses JDK 17 and
  `GRADLE_USER_HOME=/home/hatch/.gradle` (persistent disk; `/root` is
  wiped by runtime restarts), and runs Gradle with `--max-workers=1` and
  `-Xmx1536m`: the parallel build was killed by the system out-of-memory
  killer, so the build runs serially.
