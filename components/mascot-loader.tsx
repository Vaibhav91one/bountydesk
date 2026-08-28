import Image from "next/image";
import { CircleNotch } from "@phosphor-icons/react/ssr";

import { mascotStates } from "@/lib/mascot/states";

/**
 * Where each mascot sits and how it drifts.
 *
 * Fixed rather than random: this renders on the server, and a random layout would differ
 * between the server pass and the client pass and blow up hydration. The positions are hand
 * placed to leave the middle band clear for the lockup.
 */
const FIELD = [
  { top: "8%", left: "12%", size: 96, x: "18px", y: "-22px", rotate: "6deg", seconds: 11 },
  { top: "14%", left: "72%", size: 78, x: "-24px", y: "16px", rotate: "-8deg", seconds: 13 },
  { top: "6%", left: "44%", size: 62, x: "12px", y: "20px", rotate: "4deg", seconds: 9 },
  { top: "26%", left: "26%", size: 70, x: "-16px", y: "18px", rotate: "-5deg", seconds: 14 },
  { top: "30%", left: "84%", size: 88, x: "20px", y: "14px", rotate: "7deg", seconds: 10 },
  { top: "34%", left: "6%", size: 58, x: "14px", y: "-16px", rotate: "-6deg", seconds: 12 },
  { top: "58%", left: "16%", size: 84, x: "22px", y: "18px", rotate: "5deg", seconds: 15 },
  { top: "62%", left: "78%", size: 66, x: "-18px", y: "-20px", rotate: "-7deg", seconds: 11 },
  { top: "74%", left: "38%", size: 54, x: "16px", y: "14px", rotate: "8deg", seconds: 9 },
  { top: "80%", left: "62%", size: 92, x: "-20px", y: "-14px", rotate: "-4deg", seconds: 13 },
  { top: "84%", left: "8%", size: 64, x: "18px", y: "-18px", rotate: "6deg", seconds: 12 },
  { top: "48%", left: "92%", size: 56, x: "-14px", y: "16px", rotate: "-9deg", seconds: 10 },
  { top: "20%", left: "-2%", size: 74, x: "20px", y: "20px", rotate: "5deg", seconds: 14 },
  { top: "90%", left: "88%", size: 60, x: "-16px", y: "-16px", rotate: "-6deg", seconds: 11 },
];

/**
 * Three star layers, each a tile of seven stars repeated across the screen.
 *
 * One star per tile would draw a visible grid, which is what the eye latches onto and stops
 * reading as sky. Seven irregular stars in a tile, and tile sizes that share no factors, put
 * the repeat far enough apart that it does not register.
 */
const STARS = [
  {
    tile: "317px 241px",
    dot: 1,
    alpha: 0.55,
    seconds: 4,
    at: [[23, 187], [97, 42], [151, 213], [206, 88], [268, 159], [41, 119], [293, 17]],
  },
  {
    tile: "419px 353px",
    dot: 1.4,
    alpha: 0.75,
    seconds: 6.5,
    at: [[57, 301], [133, 66], [214, 188], [299, 341], [371, 102], [19, 229], [248, 29]],
  },
  {
    tile: "523px 467px",
    dot: 1.9,
    alpha: 1,
    seconds: 9,
    at: [[89, 411], [178, 97], [263, 352], [347, 183], [452, 431], [31, 268], [496, 58]],
  },
];

/**
 * The loading screen: Agent Bounty's states adrift, the lockup holding the middle.
 *
 * Server-rendered and animated entirely in CSS, so it costs no client JavaScript at exactly
 * the moment the browser is busy fetching the page it is standing in for. Each mascot keeps
 * its own animation from the Figma export; the drift here is on the wrapper, so the two
 * compose instead of fighting.
 */
export function MascotLoader({ label = "Loading" }: { label?: string }) {
  const states = mascotStates();

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 overflow-hidden bg-[#05050a]"
    >
      {STARS.map((layer, index) => (
        <span
          key={layer.tile}
          aria-hidden="true"
          className="absolute inset-0 animate-starfield-twinkle motion-reduce:animate-none"
          style={{
            backgroundImage: layer.at
              .map(
                ([x, y]) =>
                  `radial-gradient(${layer.dot}px ${layer.dot}px at ${x}px ${y}px, rgba(255,255,255,${layer.alpha}), transparent)`,
              )
              .join(", "),
            backgroundSize: layer.tile,
            animationDuration: `${layer.seconds}s`,
            animationDelay: `${index * -1.5}s`,
          }}
        />
      ))}

      {states.map((state, index) => {
        const spot = FIELD[index % FIELD.length];
        const markup = state.markup.replaceAll(`${state.key}__`, `${state.key}__load__`);
        return (
          <span
            key={state.key}
            aria-hidden="true"
            className="absolute animate-mascot-drift motion-reduce:animate-none [&>svg]:block [&>svg]:size-full"
            style={{
              top: spot.top,
              left: spot.left,
              width: spot.size,
              height: spot.size,
              animationDuration: `${spot.seconds}s`,
              animationDelay: `${index * -0.9}s`,
              ["--drift-x" as string]: spot.x,
              ["--drift-y" as string]: spot.y,
              ["--drift-rotate" as string]: spot.rotate,
            }}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        );
      })}

      <div className="absolute inset-0 flex items-center justify-center">
        {/* Padding, not a plate: the lockup keeps a clear ring around it so a mascot drifting
            past never touches the wordmark. */}
        <span className="px-8 py-6">
          <Image src="/logo-lockup.svg" alt="BountyDesk" width={241} height={36} priority />
        </span>
      </div>

      <span className="absolute inset-x-0 bottom-16 flex items-center justify-center gap-2.5 text-meta text-foreground/70">
        <CircleNotch className="size-4 animate-spin motion-reduce:animate-none" />
        {label}
      </span>
    </div>
  );
}
