"use client";

import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import { fmt } from "@/lib/dashboard";
import { CHART_MOTION } from "@/lib/motion";

const GRID = "var(--color-line)";
const TICK = { fill: "var(--color-muted)", fontSize: 12 };
const tipStyle = { background: "var(--color-base)", border: "1px solid var(--color-line)", borderRadius: 8, fontSize: 12 };
const num = (v: number) => (Math.abs(v) >= 100 ? fmt.int(v) : fmt.two(v));

export type BandRow = { x: string; actual?: number | null; forecast?: number | null; band?: [number, number] | null };

/** Observed values, then the forecast with its uncertainty band. */
export function ForecastBandChart({
  data, unit, actualLabel = "Observed", forecastLabel = "Forecast", height = 240,
}: { data: BandRow[]; unit?: string; actualLabel?: string; forecastLabel?: string; height?: number }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="x" tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={24} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={64} tickFormatter={num} domain={["auto", "auto"]} />
          <Tooltip
            contentStyle={tipStyle}
            formatter={(v: unknown, name: unknown) => {
              const shown = Array.isArray(v) ? `${num(Number(v[0]))} to ${num(Number(v[1]))}` : num(Number(v));
              return [`${shown}${unit ? ` ${unit}` : ""}`, String(name)];
            }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Area dataKey="band" name="Forecast range" stroke="none" fill="#eb6834" fillOpacity={0.15} connectNulls {...CHART_MOTION} />
          <Line dataKey="actual" name={actualLabel} stroke="#2a78d6" strokeWidth={2} dot={false} connectNulls {...CHART_MOTION} />
          <Line dataKey="forecast" name={forecastLabel} stroke="#eb6834" strokeWidth={2} strokeDasharray="5 3" dot={false} connectNulls {...CHART_MOTION} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

export type BarKey = { key: string; label: string; color: string };

/** Several measures per category, side by side or stacked. */
export function MultiBarChart({
  data, xKey, keys, stacked = false, unit, height = 240, angle = false,
}: { data: Record<string, string | number | null>[]; xKey: string; keys: BarKey[]; stacked?: boolean; unit?: string; height?: number; angle?: boolean }) {
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={{ stroke: GRID }} interval={angle ? 0 : "preserveStartEnd"}
                 {...(angle ? { tick: { ...TICK, fontSize: 11 }, angle: -55, textAnchor: "end" as const, height: 44 } : { tick: TICK })} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={52} tickFormatter={num} />
          <Tooltip contentStyle={tipStyle} cursor={{ fill: "var(--color-raised)", opacity: 0.6 }}
                   formatter={(v: unknown, name: unknown) => [`${num(Number(v))}${unit ? ` ${unit}` : ""}`, String(name)]} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {keys.map((k) => (
            <Bar key={k.key} dataKey={k.key} name={k.label} fill={k.color} stackId={stacked ? "s" : undefined} maxBarSize={22}
                 radius={stacked ? undefined : [3, 3, 0, 0]} {...CHART_MOTION} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Lines over a numeric or category x axis (e.g. hour of day), each with its own colour. */
export function MultiLineChart({
  data, xKey, keys, unit, height = 240, percent = false,
}: { data: Record<string, string | number | null>[]; xKey: string; keys: BarKey[]; unit?: string; height?: number; percent?: boolean }) {
  const f = (v: number) => (percent ? `${Math.round(v * 100)}%` : num(v));
  return (
    <div style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey={xKey} tick={TICK} tickLine={false} axisLine={{ stroke: GRID }} minTickGap={16} />
          <YAxis tick={TICK} tickLine={false} axisLine={false} width={52} tickFormatter={f} />
          <Tooltip contentStyle={tipStyle} formatter={(v: unknown, name: unknown) => [`${f(Number(v))}${unit ? ` ${unit}` : ""}`, String(name)]} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {keys.map((k) => (
            <Line key={k.key} dataKey={k.key} name={k.label} stroke={k.color} strokeWidth={2} dot={false} connectNulls {...CHART_MOTION} />
          ))}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
