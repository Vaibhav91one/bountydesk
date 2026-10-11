# Mobile Route to Mockup Mapping

Every screen in the Expo Router app maps to one of the 28 HTML mockups in `docs/site/screens/mN.html`.
Route names are derived from the mockup titles in kebab-case.

## Auth stack (signed out, Variant C "M1 Splash" flow)

| Route              | Mockup | Title          |
| ------------------ | :----: | -------------- |
| `/auth/splash`     | M1     | Splash         |
| `/auth/sign-in`    | M2     | Sign in        |
| `/auth/not-authorized` | M3 | Not authorized |

## Signed-in tabs + chrome (Variant C)

The signed-in shell uses a custom floating tab dock (not expo-router Tabs) to match
`m4.html`'s navigation chrome exactly:

- **Tab bar** (bottom, glass pill): Home, Queue, Reports
- **Review FAB** (separate circular button, next to the tab pill): opens the next
  report needing a decision, shows a count badge ("3")
- **Top bar** (top-right glass pills): bell icon opens Inbox (M23), more icon opens
  the Settings / Connections / Integrations menu

| Tab label   | Route              | Mockup | Title            |
| ----------- | ------------------ | :----: | ---------------- |
| Home        | `/(tabs)`          | M4     | Home             |
| Queue       | `/(tabs)/queue`    | M5     | Queue            |
| Reports     | `/(tabs)/reports`  | M6     | Reports          |
| (Review FAB)| `/(tabs)/review`   | M11    | Sign the verdict |
| Inbox (bell)| `/(tabs)/inbox`    | M23    | Inbox            |
| More menu   | `/(tabs)/more`     | M19    | Settings         |

## Case file detail (under `reports/[id]/`)

| Route (mockup)             | Mockup | Title             |
| -------------------------- | :----: | ----------------- |
| `reports/[id]/index`       | M7     | Case file         |
| `reports/[id]/timeline`    | M8     | Timeline          |
| `reports/[id]/tool-calls`  | M9     | Tool calls        |
| `reports/[id]/chat`        | M10    | Ask the agent     |
| `reports/[id]/sign-the-verdict` | M11 | Sign the verdict |
| `reports/[id]/verdict-approved` | M12 | Verdict approved |
| `reports/[id]/deny-verdict`    | M13 | Deny verdict     |
| `reports/[id]/sandbox-diagram` | M26 | Reproduction sandbox |

## More / Settings sub-routes

| Route                              | Mockup | Title                |
| ---------------------------------- | :----: | -------------------- |
| `more/connections`                 | M14    | Connections          |
| `more/connections/[id]`            | M15    | Connection detail    |
| `more/integrations`                | M16    | Integrations         |
| `more/integrations/email-access`   | M17    | Email access         |
| `more/integrations/otp-verify`     | M18    | OTP verify           |
| `more/submit-a-report`             | M20    | Submit a report      |
| `more/submit-a-report/contact-verify` | M21 | Contact verify     |
| `more/target-and-scope`            | M22    | Target and scope     |
| `more/privacy`                     | M24    | Privacy              |
| `more/terms`                       | M25    | Terms                |
| `more/onboarding`                  | M27    | Onboarding           |
| `more/submit-a-target`             | M28    | Submit a target      |

## Navigation chrome

The Variant C floating tab dock (from `m4.html` and `c.js` TABS constant):

```
TABS = [[home, Home], [queue, Queue], [reports, Reports]]
```

- Tabs render inside a glass pill with `data-tabs` attribute.
- A separate Review FAB (`.fab`) sits next to the tab pill, showing `data-review="3"`.
- The top bar (`.topbar.glass`) contains icon-only buttons: bell (Inbox) and
  more (Settings menu).
- Screens that need a back button (e.g. Inbox, Settings sub-routes) use
  `.topbar.l.glass.round` with a `data-back` back icon button.
