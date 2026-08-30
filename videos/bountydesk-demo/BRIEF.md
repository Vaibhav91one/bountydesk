---
workflow: general-video
flow: automation
storyboard: no
message: "BountyDesk turns report handling from model judgment into an evidence-gated workflow humans can trust."
destination: demo-video
aspect: 1920x1080
language: en
audience: bug bounty program owners
length: 110s
angle: product-demo
---

## Intent

Create a HyperFrames demo video for BountyDesk that mirrors the Assay demo tour structure. The piece should use the same fixed product-card staging, timed caption rhythm, top progress bar, and sparse editorial pacing, adapted to the BountyDesk product theme.

## Assets

- assets/logo-small.svg: BountyDesk brand mark copied from the UI worktree.
- assets/mascot-idle.svg, assets/mascot-canary-found.svg, assets/mascot-delivered.svg: mascot states copied from the UI worktree.
- assets/fonts/questrial-latin.woff2 and assets/fonts/robotomono-latin.woff2: local render-safe fonts matching the Assay reference style.
- assets/audio/bountydesk-lofi.mp3: generated local lofi bed.
- assets/audio/whoosh.wav and assets/audio/ping.wav: generated local transition and completion cues.

## Customizations

- Use HyperFrames only.
- Recreate the Assay scene language closely, but in the BountyDesk theme.
- Use regular-weight headings.
- Reuse the BountyDesk UI design language and assets from the isolated UI worktree.

## Notes

- The video is a deterministic HTML composition, with React used only to mount reusable BountyDesk product surfaces into the fixed demo card.
- The render should not depend on remote media.
