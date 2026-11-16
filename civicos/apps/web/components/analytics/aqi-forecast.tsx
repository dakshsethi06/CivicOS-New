"use client";

import { useState } from "react";
import { Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { SERIES } from "@/lib/chart-colors";
import { MONTHS } from "@/lib/dashboard";
import { CHART_MOTION } from "@/lib/motion";
import type { AqiParams, MonthPoint } from "@/lib/models";

type Row = { key: string; label: string; actual: number | null; forecast: number | null; band: [number, number] | null; lower?: number; upper?: number };
const tick = { fill: "var(--color-muted)", fontSize: 11 };

/** CPCB AQI bands, for reading a value in words. */
function band(v: number) {
  if (v <= 50) return "Good";
  if (v <= 100) return "Satisfactory";
  if (v <= 200) return "Moderate";
  if (v <= 300) return "Poor";
  return "Very poor";
}

/**
 * The last two published years of monthly AQI as a solid line, then each month of 2026 as a dashed line inside its
 * 80% range. A second view replays the backtest: what the method would have said for a past year against what happened.
 */
export function AqiForecast({ history, forecast, params }: { history: MonthPoint[]; forecast: MonthPoint[]; params: AqiParams }) {
  const [view, setView] = useState<"forecast" | number>("forecast");
  const lastYear = Math.max(...history.map((h) => h.year));
  const firstYear = Math.min(...history.map((h) => h.year));
  const shown = history.filter((h) => h.year >= lastYear - 1);

  const rows: Row[] = shown.map((h) => ({
    key: `${h.year}-${h.month}`, label: `${MONTHS[h.month - 1]} ${String(h.year).slice(2)}`, actual: h.value, forecast: null, band: null,
  }));
  if (rows.length && forecast.length) {
    const last = rows[rows.length - 1];
    last.forecast = last.actual;                        // dashed line starts from the last real month
    last.band = [last.actual!, last.actual!];
  }
  for (const f of forecast) {
    rows.push({
      key: `${f.year}-${f.month}`, label: `${MONTHS[f.month - 1]} ${String(f.year).slice(2)}`, actual: null, forecast: f.value,
      band: [f.lower!, f.upper!], lower: f.lower, upper: f.upper,
    });
  }
  const firstForecast = forecast.length ? `${forecast[0].year}-${forecast[0].month}` : null;
  const lastKey = rows.length ? rows[rows.length - 1].key : null;

  const bt = typeof view === "number" ? params.backtest.find((b) => b.year === view) : null;
  const btRows = bt ? MONTHS.map((m, i) => ({ label: m, actual: bt.actual[i], forecast: bt.predicted[i] })) : [];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Chart view" className="inline-flex rounded-lg border border-line bg-raised p-0.5 text-xs">
          <button role="tab" aria-selected={view === "forecast"} onClick={() => setView("forecast")}
            className={`rounded-md px-3 py-1.5 ${view === "forecast" ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
            2026 forecast
          </button>
          {params.backtest.map((b) => (
            <button key={b.year} role="tab" aria-selected={view === b.year} onClick={() => setView(b.year)}
              className={`rounded-md px-3 py-1.5 ${view === b.year ? "bg-panel font-medium text-ink shadow-sm" : "text-muted hover:text-ink"}`}>
              Test {b.year}
            </button>
          ))}
        </div>
        <ul className="flex flex-wrap gap-x-4 text-xs text-muted">
          <li className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded" style={{ background: SERIES.one }} />Published</li>
          <li className="flex items-center gap-1.5">
            <span className="inline-block h-0 w-4 border-t-2 border-dashed" style={{ borderColor: SERIES.two }} />
            {bt ? `Forecast made from data before ${bt.year}` : "Forecast"}
          </li>
          {!bt ? <li className="flex items-center gap-1.5"><span className="inline-block h-2.5 w-4 rounded-sm" style={{ background: SERIES.two, opacity: 0.18 }} />80% range</li> : null}
        </ul>
      </div>

      <div className="h-72">
        <ResponsiveContainer width="100%" height="100%">
          {bt ? (
            <ComposedChart key={`bt-${bt.year}`} data={btRows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--color-line)" vertical={false} />
              <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: "var(--color-line)" }} />
              <YAxis tick={tick} tickLine={false} axisLine={false} width={40} domain={[0, 220]} ticks={[0, 50, 100, 150, 200]} />
              <ReferenceLine y={100} stroke="var(--color-faint)" strokeDasharray="2 4" />
              <Tooltip content={<Tip />} cursor={{ stroke: "var(--color-faint)", strokeWidth: 1 }} />
              <Line type="monotone" dataKey="actual" stroke={SERIES.one} strokeWidth={2} dot={{ r: 3, fill: SERIES.one, strokeWidth: 0 }} {...CHART_MOTION} />
              <Line type="monotone" dataKey="forecast" stroke={SERIES.two} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: SERIES.two, strokeWidth: 0 }} {...CHART_MOTION} />
            </ComposedChart>
          ) : (
            <ComposedChart key="fc" data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="var(--color-line)" vertical={false} />
              {firstForecast && lastKey ? <ReferenceArea x1={rows.find((r) => r.key === firstForecast)?.label} x2={rows[rows.length - 1].label} fill="var(--color-raised)" fillOpacity={0.7} /> : null}
              <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: "var(--color-line)" }} interval={2} />
              <YAxis tick={tick} tickLine={false} axisLine={false} width={40} domain={[0, 220]} ticks={[0, 50, 100, 150, 200]} />
              <ReferenceLine y={100} stroke="var(--color-faint)" strokeDasharray="2 4" />
              <Tooltip content={<Tip />} cursor={{ stroke: "var(--color-faint)", strokeWidth: 1 }} />
              <Area type="monotone" dataKey="band" stroke="none" fill={SERIES.two} fillOpacity={0.18} connectNulls {...CHART_MOTION} />
              <Line type="monotone" dataKey="actual" stroke={SERIES.one} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: "var(--color-panel)", strokeWidth: 2 }} {...CHART_MOTION} />
              <Line type="monotone" dataKey="forecast" stroke={SERIES.two} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2.5, fill: SERIES.two, strokeWidth: 0 }} activeDot={{ r: 4, stroke: "var(--color-panel)", strokeWidth: 2 }} connectNulls {...CHART_MOTION} />
            </ComposedChart>
          )}
        </ResponsiveContainer>
      </div>
      <p className="mt-2 text-xs text-muted">
        {bt
          ? `Forecast for ${bt.year} made only from ${firstYear} to ${bt.year - 1}, against what was published. Average miss: ${bt.mae} AQI points.`
          : "Shaded area: 2026, the forecast period. Lower AQI is cleaner air."}{" "}
        Dotted line: AQI 100, the upper limit of “Satisfactory”.
      </p>
    </div>
  );
}

function Tip({ active, payload, label }: { active?: boolean; payload?: { payload: Row & { forecast: number | null } }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const r = payload[0].payload;
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-medium text-ink">{label}</p>
      {r.actual != null ? <p className="text-muted">Published <span className="ml-2 font-medium tabular-nums text-ink">{r.actual}</span> <span className="text-faint">{band(r.actual)}</span></p> : null}
      {r.forecast != null && (r.actual == null || r.lower == null) && r.actual !== r.forecast ? (
        <p className="text-muted">Forecast <span className="ml-2 font-medium tabular-nums text-ink">{r.forecast}</span> <span className="text-faint">{band(r.forecast)}</span></p>
      ) : null}
      {r.lower != null ? <p className="text-muted">80% range <span className="ml-2 tabular-nums text-ink">{r.lower} to {r.upper}</span></p> : null}
    </div>
  );
}
