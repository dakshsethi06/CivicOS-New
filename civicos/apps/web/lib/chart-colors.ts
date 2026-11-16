// Chart colours as hex, because Recharts and MapLibre write them into SVG/WebGL, where CSS variables do not apply.
// Lives outside any "use client" file so server components can import the values too.
// Keep in sync with the chart tokens in app/globals.css. Light-mode steps of the validated reference palette (white panel surface).
export const SERIES = { one: "#2a78d6", two: "#eb6834", three: "#1baf7a" };
export const STATUS = { good: "#0ca30c", warning: "#fab219", serious: "#ec835a", critical: "#d03b3b" };

/** Categorical colours in fixed order. Only the first three are colour-blind safe when every pair can touch (a map), so groups are capped at three. */
export const GROUP_COLORS = [SERIES.one, SERIES.two, SERIES.three];

/** Diverging pair for above/below average: blue and red poles, grey midpoint. */
export const DIVERGING = { pos: "#2a78d6", neg: "#e34948", mid: "#f0efec" };

/** Single blue ramp for magnitude on a light surface: pale = low, dark = high. */
export const RAMP = { low: "#cde2fb", mid: "#3987e5", high: "#0d366b", none: "#eceff3" };
