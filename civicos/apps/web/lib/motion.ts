/** Chart draw-in animation, off for people who ask their system for reduced motion. Read in the browser only. */
export const ANIMATE =
  typeof window !== "undefined" && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export const CHART_MOTION = { isAnimationActive: ANIMATE, animationDuration: 750, animationEasing: "ease-out" as const };
