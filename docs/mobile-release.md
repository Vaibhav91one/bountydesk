# Mobile release setup

What is configured in the repo for building and shipping the reviewer app (issue #359), and the
values still needed from the account owner. Nothing here is a secret.

## Builds (`mobile/eas.json`)

Three EAS Build profiles, each on its own update channel: `development` (dev client, internal),
`preview` (internal) and `production` (store, auto-incrementing build number).
`runtimeVersion` uses the `appVersion` policy, so a JavaScript-only EAS Update only reaches builds
with the same app version; a native change means a new version and a new build.

Still to do with the Expo account (not possible from the repo):

1. `eas init` to link the project (writes `extra.eas.projectId` into `mobile/app.json`).
2. `npx expo install expo-updates` then `eas update:configure` (adds the `updates.url`).
3. `eas credentials` for iOS signing and the Android keystore.

## Universal links

`app.bountydesk.vaibhav.quest/reports/*` and `/inbox` open the app when it is installed.

- `mobile/app.json` declares the iOS associated domain and the Android intent filter.
- The web app serves `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json`
  from `lib/mobile/universal-links.ts`. Each returns 404 until its env var is set, because the OS
  caches a wrong association file and is slow to pick up a correction:
  - `MOBILE_IOS_TEAM_ID` (Apple Developer team id)
  - `MOBILE_ANDROID_SHA256_FINGERPRINTS` (comma-separated signing fingerprints)

`lib/mobile/release-config.test.ts` keeps `app.json`, `eas.json` and the served paths in agreement.
