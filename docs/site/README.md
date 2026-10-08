# BountyDesk documentation site

A static site that maps BountyDesk: the shipped desktop app, its architecture, and the proposed
mobile app. Open `mvp-mindmap.html` in a browser. Every page links to the others through the
Pages menu in the top right corner, and nothing needs a server or a build step.

The mobile app is a proposal. It is not built, and nothing under `screens/` is app code. Those
are HTML mockups of the 28 phone screens, used to agree on the design before any React Native
work starts. The tracking issue for building it is linked from the PR that added this folder.

## What is here

- `mvp-mindmap.html` is the mobile app flow, all 28 screens grouped by journey.
- `prototype.html` shows every screen on iOS and Android side by side. A tap in either phone moves
  both. It has toggles for light theme, large text, a screen reader view and a touch target check,
  and buttons that play the back swipe, sheet, pull to refresh, long press and push notification.
- `screens/` holds the screens (`m1.html` to `m28.html`) and their shared kit: `c.css` for the
  components, `c.js` for the behaviour, `platform.js` and `embed.*` for the prototype.
- The architecture, build, design and plan pages each have a Desktop and Mobile view where the two
  apps differ. The desktop view describes code that exists; the mobile view describes the proposal.
- `screens-real.html` has screenshots of the live desktop app's public pages. The reviewer pages
  sit behind sign-in and are not captured.

## Keeping it honest

Facts on these pages were checked against the code when they were written, and some will drift.
When a page and the code disagree, the code is right. `docs/decisions.md` and `AGENTS.md` remain
the design record; this site is a way to read them, not a replacement.

The phone app targets iOS and Android only. On the web, phones use the responsive desktop app.
