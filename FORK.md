# About this fork

This is a fork of [Rakazo](https://github.com/elie222/rakazo) (Apache License 2.0), based on upstream commit `2600073`. The original LICENSE and NOTICE are kept unchanged. Version history for this fork is in [FORK_CHANGELOG.md](FORK_CHANGELOG.md).

Fork changes built by Muse:

- **Server switching on mobile.** The app remembers the servers you use and stays signed in on each one. Switching parks the session instead of signing you out, so switching back needs no sign-in. The server screen is reachable from **Settings → Server** while signed in.
- **Saved servers** with optional labels and one seeded default entry (`https://rakazo.example.com` here; change `MAUSHAUS_API_BASE` in `apps/mobile/lib/api/saved-servers.ts` to your own server). On a first launch the app opens that default instead of the unreachable loopback URL.
- **Calls and drafts:** an active call hangs up cleanly on a server switch, and the unsent-message warning covers switches.
- **v1.0.20 session keys:** per-server session tokens use a SecureStore-safe encoded key, so switching servers can actually save the previous session on a real device.
- **Local Android build:** its own package id (so it installs next to the official app), EAS project id and over-the-air updates removed, and `apps/mobile/plugins/with-sdk-36.js` to build against Android SDK 36.

## Files changed from upstream

All under `apps/mobile/` unless noted:

- `app.json`, `app/server.tsx`, `app/(settings)/general.tsx`, `plugins/with-sdk-36.js` (new)
- `lib/api/`: `api.ts`, `api-server.ts`, `saved-servers.ts`, `session.ts` and their tests
- `lib/auth/api-auth.ts`, `lib/calls/call-session.ts`, `lib/thread/send/unsent-send-warning.ts` and related tests
- `docs/mobile-app.md`, `docs/self-host-clients.md`, `.gitignore` (repo root)

## Build the Android app

Follow upstream's [mobile docs](docs/mobile-app.md). For a local APK: `pnpm install`, then in `apps/mobile` run `npx expo prebuild --platform android` and build with Gradle, signing with your own release keystore. Keep the keystore out of git (`keystore/` is ignored).
