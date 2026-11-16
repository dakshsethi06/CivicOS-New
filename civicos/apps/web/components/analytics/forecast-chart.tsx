"use client";

import { CHART_MOTION } from "@/lib/motion";
import { Area, CartesianGrid, ComposedChart, ErrorBar, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SERIES } from "@/lib/chart-colors";
import type { YearRange } from "@/lib/models";

type Row = {
  year: number; actual: number | null; forecast: number | null;
  range: [number, number] | null; band: [number, number] | null; lower?: number; upper?: number;
};

/**
 * Published years as a solid line; each forecast year as a dashed line from the last published year, with its
 * 80% range as an error bar and a shaded band that widens with distance.
 */
export function ForecastChart({
  history, forecasts, decimals = 0, unit = "",
}: {
  history: { year: number; value: number }[];
  forecasts: YearRange[];
  decimals?: number;
  unit?: string;
}) {
  const nf = new Intl.NumberFormat("en-IN", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  const f = (v: number | null | undefined) => (v == null ? "—" : nf.format(v) + (unit ? ` ${unit}` : ""));
  const rows: Row[] = history.map((h) => ({ year: h.year, actual: h.value, forecast: null, range: null, band: null }));
  const fc = [...forecasts].sort((a, b) => a.year - b.year);
  if (fc.length && rows.length) {
    const last = rows[rows.length - 1];
    last.forecast = last.actual;      // dashed line starts at the last real year
    last.range = [0, 0];
    last.band = [last.actual!, last.actual!];
  }
  for (const p of fc) {
    rows.push({
      year: p.year, actual: null, forecast: p.value,
      range: [p.value - p.lower, p.upper - p.value], band: [p.lower, p.upper], lower: p.lower, upper: p.upper,
    });
  }
  const tick = { fill: "var(--color-muted)", fontSize: 12 };

  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 text-xs text-muted">
        <li className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded" style={{ background: SERIES.one }} />Published</li>
        <li className="flex items-center gap-1.5">
          <span className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: SERIES.two }} />
          Forecast
        </li>
        <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: SERIES.two, opacity: 0.18 }} />80% range</li>
      </ul>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--color-line)" vertical={false} />
            <XAxis dataKey="year" tick={tick} tickLine={false} axisLine={{ stroke: "var(--color-line)" }} />
            <YAxis tick={tick} tickLine={false} axisLine={false} width={60} domain={[0, "auto"]} tickFormatter={(v) => nf.format(v)} />
            <Tooltip
              cursor={{ stroke: "var(--color-faint)", strokeWidth: 1 }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const r = payload[0].payload as Row;
                return (
                  <div className="rounded-lg border border-line bg-base px-3 py-2 text-xs shadow-lg">
                    <p className="mb-1 font-medium text-ink">{label}</p>
                    {r.actual != null ? <p className="text-muted">Published <span className="ml-2 font-medium tabular-nums text-ink">{f(r.actual)}</span></p> : null}
                    {r.actual == null && r.forecast != null ? (
                      <>
                        <p className="text-muted">Forecast <span className="ml-2 font-medium tabular-nums text-ink">{f(r.forecast)}</span></p>
                        <p className="text-muted">80% range <span className="ml-2 tabular-nums text-ink">{f(r.lower)} to {f(r.upper)}</span></p>
                      </>
                    ) : null}
                  </div>
                );
              }}
            />
            <Area type="linear" dataKey="band" stroke="none" fill={SERIES.two} fillOpacity={0.14} connectNulls {...CHART_MOTION} />
            <Line type="linear" dataKey="actual" stroke={SERIES.one} strokeWidth={2} dot={{ r: 3, fill: SERIES.one, strokeWidth: 0 }} activeDot={{ r: 4, stroke: "var(--color-panel)", strokeWidth: 2 }} {...CHART_MOTION} />
            <Line type="linear" dataKey="forecast" stroke={SERIES.two} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 4, fill: SERIES.two, strokeWidth: 0 }} {...CHART_MOTION} connectNulls>
              <ErrorBar dataKey="range" width={10} strokeWidth={1.5} stroke={SERIES.two} direction="y" />
            </Line>
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
