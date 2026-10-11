# Mobile Route to Mockup Mapping

Every route file in `app/` maps to one of the mockups in `docs/site/screens/mN.html`.
Route names are derived from the mockup titles in kebab-case. This table is
reconciled row by row against `find mobile/app -name "*.tsx"` — one row per real
route file, no rows for nonexistent routes.

## Auth stack (signed out, Variant C "M1 Splash" flow)

The auth stack is its own navigator at `app/auth/_layout.tsx` (no header, full
screen modals).

| Route              | Mockup | Title          | File                              |
| ------------------ | :----: | -------------- | --------------------------------- |
| `/auth/splash`     | M1     | Splash         | `app/auth/splash.tsx`             |
| `/auth/sign-in`    | M2     | Sign in        | `app/auth/sign-in.tsx`            |
| `/auth/not-authorized` | M3 | Not authorized | `app/auth/not-authorized.tsx`     |

## Entry

`app/index.tsx` is the M0 entry. It redirects signed-in users to `/(tabs)` and
signed-out users to `/auth/splash`; it has no mockup of its own.

| Route   | Mockup | Title | File                 |
| ------- | :----: | ----- | -------------------- |
| `/`     | M0     | Entry | `app/index.tsx`      |

## Signed-in tabs + chrome (Variant C)

The signed-in shell uses the installed Expo native tabs from
`expo-router/unstable-native-tabs` (in `app/(tabs)/_layout.tsx`) rather than a
hand-rolled dock, matching `m4.html`'s navigation chrome:

- **Tab bar** (native, three tabs): Home, Queue, Reports
- **Review FAB** (separate `components/ReviewFab.tsx`, not a tab): opens the next
  report needing a decision at `/reports/[id]/sign-the-verdict` (M11), shows a
  count badge ("3")
- **Top bar** (top-right glass pills, `components/TopBarPill.tsx`): bell icon opens
  Inbox (M23), more icon opens the Settings / Connections / Integrations menu

Review next and the bell/more chrome are overlays rendered on the three tab
screens only, not tab routes themselves (docs/site/native-ui.html).

| Tab label     | Route             | Mockup | Title           | File                       |
| ------------- | ----------------- | :----: | --------------- | -------------------------- |
| Home          | `/(tabs)`         | M4     | Home            | `app/(tabs)/index.tsx`     |
| Queue         | `/(tabs)/queue`   | M5     | Queue           | `app/(tabs)/queue.tsx`     |
| Reports       | `/(tabs)/reports` | M6     | Reports         | `app/(tabs)/reports.tsx`   |
| (Review FAB)  | `/reports/[id]/sign-the-verdict` | M11 | Sign the verdict | (opened by ReviewFab)     |
| Inbox (bell)  | `/inbox`          | M23    | Inbox           | `app/inbox.tsx`            |
| More menu     | `/more`           | M19    | Settings        | `app/more/index.tsx`       |

## Case file detail (under `reports/[id]/`)

The case file is its own navigator at `app/reports/[id]/...`.

| Route (mockup)                 | Mockup | Title             | File                                     |
| ------------------------------ | :----: | ----------------- | ---------------------------------------- |
| `reports/[id]/index`           | M7     | Case file         | `app/reports/[id]/index.tsx`             |
| `reports/[id]/timeline`        | M8     | Timeline          | `app/reports/[id]/timeline.tsx`          |
| `reports/[id]/tool-calls`      | M9     | Tool calls        | `app/reports/[id]/tool-calls.tsx`        |
| `reports/[id]/chat`            | M10    | Ask the agent     | `app/reports/[id]/chat.tsx`              |
| `reports/[id]/sign-the-verdict`| M11    | Sign the verdict  | `app/reports/[id]/sign-the-verdict.tsx`  |
| `reports/[id]/verdict-approved`| M12    | Verdict approved  | `app/reports/[id]/verdict-approved.tsx`|
| `reports/[id]/deny-verdict`    | M13    | Deny verdict      | `app/reports/[id]/deny-verdict.tsx`      |
| `reports/[id]/sandbox-diagram` | M26    | Reproduction sandbox | `app/reports/[id]/sandbox-diagram.tsx`|

## More / Settings sub-routes

The connections and integrations group is its own stack at `app/more/_layout.tsx`:

| Route                              | Mockup | Title                | File                                       |
| ---------------------------------- | :----: | -------------------- | ------------------------------------------ |
| `more/connections`                 | M14    | Connections          | `app/more/connections.tsx`                 |
| `more/connections/[id]`            | M15    | Connection detail    | `app/more/connections/[id].tsx`            |
| `more/integrations`                | M16    | Integrations         | `app/more/integrations.tsx`                |
| `more/integrations/email-access`   | M17    | Email access         | `app/more/integrations/email-access.tsx`   |
| `more/integrations/otp-verify`     | M18    | OTP verify           | `app/more/integrations/otp-verify.tsx`     |
| `more/submit-a-report`             | M20    | Submit a report      | `app/more/submit-a-report.tsx`             |
| `more/submit-a-report/contact-verify` | M21 | Contact verify    | `app/more/submit-a-report/contact-verify.tsx`|
| `more/target-and-scope`            | M22    | Target and scope     | `app/more/target-and-scope.tsx`            |
| `more/privacy`                     | M24    | Privacy              | `app/more/privacy.tsx`                    |
| `more/terms`                       | M25    | Terms                | `app/more/terms.tsx`                      |
| `more/onboarding`                  | M27    | Onboarding           | `app/more/onboarding.tsx`                 |
| `more/submit-a-target`             | M28    | Submit a target      | `app/more/submit-a-target.tsx`            |

## Navigation chrome

The Variant C shell uses the installed Expo native tabs:

```
TABS = [[home, Home], [queue, Queue], [reports, Reports]]
```

- The three tabs render as native tab bar items (Home, Queue, Reports).
- A separate Review FAB (`components/ReviewFab.tsx`) opens the next verdict at
  `reports/[id]/sign-the-verdict`.
- The top-right glass pill (`components/TopBarPill.tsx`) holds the bell (Inbox)
  and more (Settings menu) icon-only buttons.
- Stack routes that need a back button (Inbox, Settings sub-routes) use a
  `ScreenHeader` with `back` enabled — see `components/primitives`.
