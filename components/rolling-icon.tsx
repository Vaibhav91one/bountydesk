import type { IconWeight } from "@phosphor-icons/react";
import type { ComponentType } from "react";

import { cn } from "@/lib/utils";

/** Phosphor icons and the brand icons from developer-icons both satisfy this. */
type IconComponent = ComponentType<{ className?: string; weight?: IconWeight }>;

/**
 * An icon that rolls on hover: the resting copy travels up out of the box while an identical
 * one arrives from below. The overflow-hidden box is the mask that makes it read as one icon
 * moving rather than two crossfading.
 *
 * It answers both `group/button` and `group/menu-button`, because the same movement belongs on
 * a button and on a nav row and only one of those ancestors ever exists. Tailwind needs both
 * variants written out, so a `group` prop would not work here.
 *
 * The second copy is decorative and hidden from assistive tech; under reduced motion it is not
 * rendered at all and the first copy stops moving.
 */
export function RollingIcon({
  icon: Icon,
  weight,
  className,
}: {
  icon: IconComponent;
  weight?: IconWeight;
  className?: string;
}) {
  const shared = "col-start-1 row-start-1 size-full transition-transform duration-200 ease-out";

  return (
    <span className={cn("relative grid shrink-0 overflow-hidden", className)}>
      <Icon
        weight={weight}
        className={cn(
          shared,
          "group-hover/button:-translate-y-full group-hover/button:scale-90",
          "group-hover/menu-button:-translate-y-full group-hover/menu-button:scale-90",
          "motion-reduce:transform-none motion-reduce:transition-none",
        )}
      />
      <Icon
        weight={weight}
        aria-hidden="true"
        className={cn(
          shared,
          "translate-y-full scale-90",
          "group-hover/button:translate-y-0 group-hover/button:scale-100",
          "group-hover/menu-button:translate-y-0 group-hover/menu-button:scale-100",
          "motion-reduce:hidden",
        )}
      />
    </span>
  );
}
