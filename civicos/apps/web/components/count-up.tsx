"use client";

import { useEffect, useRef, useState } from "react";

/** Counts a formatted number (e.g. "1,30,066" or "5.37") up from zero when it first appears. Other text is shown as is. */
export function CountUp({ value, duration = 900 }: { value: string; duration?: number }) {
  const m = /^(-?)([\d,]+)(?:\.(\d+))?$/.exec(value);
  const target = m ? Number(`${m[1]}${m[2].replace(/,/g, "")}${m[3] ? "." + m[3] : ""}`) : NaN;
  const decimals = m?.[3]?.length ?? 0;
  const indian = !!m && /\d,\d\d,/.test(value);
  const [shown, setShown] = useState(value);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!Number.isFinite(target) || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const format = (n: number) => n.toLocaleString(indian ? "en-IN" : "en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(t < 1 ? format(target * eased) : value);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, decimals, indian, duration, value]);

  return <span ref={ref}>{shown}</span>;
}
