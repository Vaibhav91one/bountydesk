"use client";

import React, { useCallback, useEffect, useMemo, useRef, type RefObject } from "react";
import {
  motion,
  useAnimationFrame,
  useMotionValue,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  useVelocity,
  type MotionValue,
  type SpringOptions,
} from "motion/react";

import { cn } from "@/lib/utils";

/**
 * A marquee whose items travel along an SVG path rather than a straight line.
 *
 * Ported with one structural change. The source called useTransform, useMotionValue and
 * useEffect inside the items.map callback, which is a hooks-in-a-loop violation: React's rules
 * of hooks are an eslint error here, and the pattern only survives at all while the array
 * length never changes. Each item is its own component now, so its hooks run at the top level
 * of that component and the behaviour is identical.
 *
 * The path in `path` is used twice and the two are not the same coordinate space. The <svg>
 * draws it inside `viewBox`; the motion uses CSS `offset-path`, which is in the container's own
 * pixels. Author the path in pixels and set a viewBox to match, or the dots will not go where
 * the drawn line does.
 */

const wrap = (min: number, max: number, value: number): number => {
  const range = max - min;
  return ((((value - min) % range) + range) % range) + min;
};

type CSSVariableInterpolation = {
  property: string;
  from: number | string;
  to: number | string;
};

function MarqueeItem({
  child,
  itemIndex,
  itemCount,
  path,
  baseOffset,
  easing,
  hidden,
  draggable,
  grabCursor,
  calculateZIndex,
  enableRollingZIndex,
  cssVariableInterpolation,
  onHoverChange,
}: {
  child: React.ReactNode;
  itemIndex: number;
  itemCount: number;
  path: string;
  baseOffset: MotionValue<number>;
  easing?: (value: number) => number;
  hidden: boolean;
  draggable: boolean;
  grabCursor: boolean;
  calculateZIndex: (offsetDistance: number) => number | undefined;
  enableRollingZIndex: boolean;
  cssVariableInterpolation: CSSVariableInterpolation[];
  onHoverChange: (hovered: boolean) => void;
}) {
  const itemOffset = useTransform(baseOffset, (v) => {
    const position = (itemIndex * 100) / itemCount;
    const wrapped = wrap(0, 100, v + position);
    return `${easing ? easing(wrapped / 100) * 100 : wrapped}%`;
  });

  const currentOffsetDistance = useMotionValue(0);
  const zIndex = useTransform(currentOffsetDistance, (value) => calculateZIndex(value));

  useEffect(() => {
    return itemOffset.on("change", (value: string) => {
      const match = /^([\d.]+)%$/.exec(value);
      if (match?.[1]) currentOffsetDistance.set(Number.parseFloat(match[1]));
    });
  }, [itemOffset, currentOffsetDistance]);

  // A fixed-length list, so one hook per entry is stable across renders.
  const variables = cssVariableInterpolation.map(({ from, to }) =>
    // eslint-disable-next-line react-hooks/rules-of-hooks
    useTransform(currentOffsetDistance, [0, 100], [from, to]),
  );
  const style = Object.fromEntries(
    cssVariableInterpolation.map(({ property }, index) => [property, variables[index]]),
  );

  return (
    <motion.div
      className={cn("absolute top-0 left-0", draggable && grabCursor && "cursor-grab")}
      style={{
        offsetPath: `path('${path}')`,
        offsetDistance: itemOffset,
        // offset-rotate defaults to auto, which turns each item to face along the path. A face
        // travelling over an arc would end up lying on its side at the ends.
        offsetRotate: "0deg",
        zIndex: enableRollingZIndex ? zIndex : undefined,
        willChange: "offset-distance",
        backfaceVisibility: "hidden",
        ...style,
      }}
      aria-hidden={hidden}
      onMouseEnter={() => onHoverChange(true)}
      onMouseLeave={() => onHoverChange(false)}
    >
      {child}
    </motion.div>
  );
}

export function MarqueeAlongSvgPath({
  children,
  className,
  path,
  pathId,
  preserveAspectRatio = "xMidYMid meet",
  showPath = false,
  width = "100%",
  height = "100%",
  viewBox = "0 0 100 100",
  baseVelocity = 5,
  direction = "normal",
  easing,
  slowdownOnHover = false,
  slowDownFactor = 0.3,
  slowDownSpringConfig = { damping: 50, stiffness: 400 },
  useScrollVelocity = false,
  scrollAwareDirection = false,
  scrollSpringConfig = { damping: 50, stiffness: 400 },
  scrollContainer,
  repeat = 3,
  draggable = false,
  dragSensitivity = 0.2,
  dragVelocityDecay = 0.96,
  dragAwareDirection = false,
  grabCursor = false,
  enableRollingZIndex = true,
  zIndexBase = 1,
  zIndexRange = 10,
  cssVariableInterpolation = [],
}: {
  children: React.ReactNode;
  className?: string;
  path: string;
  pathId?: string;
  preserveAspectRatio?: string;
  showPath?: boolean;
  width?: string | number;
  height?: string | number;
  viewBox?: string;
  baseVelocity?: number;
  direction?: "normal" | "reverse";
  easing?: (value: number) => number;
  slowdownOnHover?: boolean;
  slowDownFactor?: number;
  slowDownSpringConfig?: SpringOptions;
  useScrollVelocity?: boolean;
  scrollAwareDirection?: boolean;
  scrollSpringConfig?: SpringOptions;
  scrollContainer?: RefObject<HTMLElement | null> | null;
  repeat?: number;
  draggable?: boolean;
  dragSensitivity?: number;
  dragVelocityDecay?: number;
  dragAwareDirection?: boolean;
  grabCursor?: boolean;
  enableRollingZIndex?: boolean;
  zIndexBase?: number;
  zIndexRange?: number;
  cssVariableInterpolation?: CSSVariableInterpolation[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const baseOffset = useMotionValue(0);
  const generatedId = React.useId();
  const id = pathId ?? `marquee-path-${generatedId}`;

  const items = useMemo(() => {
    const list = React.Children.toArray(children);
    return list.flatMap((child, childIndex) =>
      Array.from({ length: repeat }, (_, repeatIndex) => ({
        child,
        repeatIndex,
        itemIndex: repeatIndex * list.length + childIndex,
        key: `${childIndex}-${repeatIndex}`,
      })),
    );
  }, [children, repeat]);

  const calculateZIndex = useCallback(
    (offsetDistance: number) =>
      enableRollingZIndex ? Math.floor(zIndexBase + (offsetDistance / 100) * zIndexRange) : undefined,
    [enableRollingZIndex, zIndexBase, zIndexRange],
  );

  const { scrollY } = useScroll({
    container: (scrollContainer as RefObject<HTMLDivElement | null>) ?? container,
  });
  const smoothVelocity = useSpring(useVelocity(scrollY), scrollSpringConfig);

  const isHovered = useRef(false);
  const isDragging = useRef(false);
  const dragVelocity = useRef(0);
  const directionFactor = useRef(direction === "normal" ? 1 : -1);
  const lastPointer = useRef({ x: 0, y: 0 });

  const hoverFactorValue = useMotionValue(1);
  const defaultVelocity = useMotionValue(1);
  const reducedMotion = useReducedMotion();
  const smoothHoverFactor = useSpring(hoverFactorValue, slowDownSpringConfig);
  const velocityFactor = useTransform(
    useScrollVelocity ? smoothVelocity : defaultVelocity,
    [0, 1000],
    [0, 5],
    { clamp: false },
  );

  useAnimationFrame((_, delta) => {
    // Decorative travel, so it stops entirely rather than slowing down. Returning here also
    // drops the per-frame work for anyone who asked not to see it move.
    if (reducedMotion) return;

    if (isDragging.current && draggable) {
      baseOffset.set(baseOffset.get() + dragVelocity.current);
      dragVelocity.current *= 0.9;
      if (Math.abs(dragVelocity.current) < 0.01) dragVelocity.current = 0;
      return;
    }

    hoverFactorValue.set(isHovered.current && slowdownOnHover ? slowDownFactor : 1);

    let moveBy =
      directionFactor.current * baseVelocity * (delta / 1000) * smoothHoverFactor.get();

    if (scrollAwareDirection && !isDragging.current) {
      if (velocityFactor.get() < 0) directionFactor.current = -1;
      else if (velocityFactor.get() > 0) directionFactor.current = 1;
    }

    moveBy += directionFactor.current * moveBy * velocityFactor.get();

    if (draggable) {
      moveBy += dragVelocity.current;
      if (dragAwareDirection && Math.abs(dragVelocity.current) > 0.1) {
        directionFactor.current = Math.sign(dragVelocity.current);
      }
      if (!isDragging.current && Math.abs(dragVelocity.current) > 0.01) {
        dragVelocity.current *= dragVelocityDecay;
      } else if (!isDragging.current) {
        dragVelocity.current = 0;
      }
    }

    baseOffset.set(baseOffset.get() + moveBy);
  });

  return (
    <div
      ref={container}
      onPointerDown={(event) => {
        if (!draggable) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        if (grabCursor) event.currentTarget.style.cursor = "grabbing";
        isDragging.current = true;
        lastPointer.current = { x: event.clientX, y: event.clientY };
        dragVelocity.current = 0;
      }}
      onPointerMove={(event) => {
        if (!draggable || !isDragging.current) return;
        const dx = event.clientX - lastPointer.current.x;
        const dy = event.clientY - lastPointer.current.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        dragVelocity.current = (dx > 0 ? distance : -distance) * dragSensitivity;
        lastPointer.current = { x: event.clientX, y: event.clientY };
      }}
      onPointerUp={(event) => {
        if (!draggable) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        isDragging.current = false;
        if (grabCursor) event.currentTarget.style.cursor = "grab";
      }}
      className={cn("relative", className)}
    >
      <div className="relative" style={{ contain: "layout style" }}>
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width={width}
          height={height}
          viewBox={viewBox}
          preserveAspectRatio={preserveAspectRatio}
          className="h-full w-full"
          aria-hidden="true"
        >
          <path id={id} d={path} stroke={showPath ? "currentColor" : "none"} fill="none" />
        </svg>

        {items.map(({ child, repeatIndex, itemIndex, key }) => (
          <MarqueeItem
            key={key}
            child={child}
            itemIndex={itemIndex}
            itemCount={items.length}
            path={path}
            baseOffset={baseOffset}
            easing={easing}
            hidden={repeatIndex > 0}
            draggable={draggable}
            grabCursor={grabCursor}
            calculateZIndex={calculateZIndex}
            enableRollingZIndex={enableRollingZIndex}
            cssVariableInterpolation={cssVariableInterpolation}
            onHoverChange={(hovered) => (isHovered.current = hovered)}
          />
        ))}
      </div>
    </div>
  );
}

export default MarqueeAlongSvgPath;
