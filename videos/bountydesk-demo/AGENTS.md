# HyperFrames composition project

This directory contains the BountyDesk demo video. It is a nested HyperFrames project, separate
from the Next.js app.

## Skills

Use the HyperFrames skills before changing the composition:

- Start with `/hyperframes` for routing.
- Use `/general-video` for this demo tour.
- Use `/hyperframes-core` for the composition contract.
- Use `/hyperframes-animation` for GSAP timeline work.
- Use `/hyperframes-cli` for preview, check, and render commands.
- Use `/media-use` before changing audio or visual media treatments.

## Commands

```bash
npm run dev
npx hyperframes preview --background --no-open
npx hyperframes preview --status
npx hyperframes preview --stop
npm run check
npm run render
npm run publish
```

Use the managed background preview for review handoff. It keeps Studio alive after the command
exits and avoids tying the server to an agent shell session.

## Project structure

- `index.html` is the root HyperFrames composition.
- `src/recording-components.jsx` holds reusable React scene components.
- `assets/` holds local fonts, audio, vendor scripts, logo art, and mascot art.
- `renders/bountydesk-demo-hyperframes.mp4` is the committed final export.
- `BRIEF.md` and `STORYBOARD.md` describe the creative direction and timed scenes.

## Authoring rules

Run `npm run check` after changing the composition, components, or assets. Review warnings before
rendering.

Timelines must be paused and registered on `window.__timelines`:

```js
window.__timelines = window.__timelines || {};
window.__timelines["composition-id"] = gsap.timeline({ paused: true });
```

Keep the composition deterministic. Do not use `Date.now()`, `Math.random()`, network fetches, or
runtime-dependent layout logic inside the rendered timeline.

Keep media local so preview and render do not depend on remote assets. If the final MP4 changes,
run `npm run render` and verify the exported file before committing it.
