import { Composition } from "remotion";

import { BountyDeskDemo, DURATION_IN_FRAMES, FPS } from "./video";

export const RemotionRoot = () => {
  return (
    <Composition
      id="BountyDeskDemo"
      component={BountyDeskDemo}
      durationInFrames={DURATION_IN_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
    />
  );
};
