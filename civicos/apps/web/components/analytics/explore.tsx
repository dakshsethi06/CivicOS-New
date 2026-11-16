"use client";

import { CHART_MOTION } from "@/lib/motion";
import { useState } from "react";
import { CartesianGrid, LabelList, ResponsiveContainer, Sankey, Scatter, ScatterChart, Tooltip, XAxis, YAxis } from "recharts";
import { GROUP_COLORS, SERIES } from "@/lib/chart-colors";
import { fmt } from "@/lib/dashboard";
import type { Feature } from "@/lib/models";

type WardPoint = { code: string; cluster: number; features: Record<string, number> };
const selectCls = "h-9 rounded-lg border border-line bg-raised px-2.5 text-sm text-ink focus:border-accent focus:outline-none";
const tick = { fill: "var(--color-muted)", fontSize: 12 };

/** Any two ward indicators against each other, one dot per ward, coloured by model group. */
export function WardScatter({ wards, features, r }: { wards: WardPoint[]; features: Feature[]; r: Record<string, Record<string, number>> }) {
  const [x, setX] = useState("slum_pct");
  const [y, setY] = useState("avg_days");
  const label = (k: string) => features.find((f) => f.key === k)?.label ?? k;
  const groups = [...new Set(wards.map((w) => w.cluster))].sort();
  const corr = r[x]?.[y];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted">
          Horizontal axis
          <select className={selectCls} value={x} onChange={(e) => setX(e.target.value)}>{features.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted">
          Vertical axis
          <select className={selectCls} value={y} onChange={(e) => setY(e.target.value)}>{features.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
        </label>
        <ul className="ml-auto flex gap-4 text-xs text-muted">
          {groups.map((g) => (
            <li key={g} className="flex items-center gap-1.5"><span className="inline-block size-2.5 rounded-full" style={{ background: GROUP_COLORS[g - 1] }} />Group {g}</li>
          ))}
        </ul>
      </div>
      <div className="h-80">
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 12, right: 24, bottom: 28, left: 8 }}>
            <CartesianGrid stroke="var(--color-line)" />
            <XAxis type="number" dataKey="x" name={label(x)} tick={tick} tickLine={false} axisLine={{ stroke: "var(--color-line)" }} domain={["auto", "auto"]}
              label={{ value: label(x), position: "bottom", offset: 8, fill: "var(--color-muted)", fontSize: 12 }} />
            <YAxis type="number" dataKey="y" name={label(y)} tick={tick} tickLine={false} axisLine={false} width={48} domain={["auto", "auto"]} />
            <Tooltip
              cursor={{ stroke: "var(--color-faint)", strokeDasharray: "3 3" }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const p = payload[0].payload as { code: string; x: number; y: number; cluster: number };
                return (
                  <div className="rounded-lg border border-line bg-base px-3 py-2 text-xs shadow-lg">
                    <p className="mb-1 font-medium text-ink">Ward {p.code} · Group {p.cluster}</p>
                    <p className="text-muted">{label(x)}: <span className="tabular-nums text-ink">{fmt.two(p.x)}</span></p>
                    <p className="text-muted">{label(y)}: <span className="tabular-nums text-ink">{fmt.two(p.y)}</span></p>
                  </div>
                );
              }}
            />
            {groups.map((g) => (
              <Scatter key={g} data={wards.filter((w) => w.cluster === g).map((w) => ({ code: w.code, cluster: g, x: w.features[x], y: w.features[y] }))}
                fill={GROUP_COLORS[g - 1]} stroke="var(--color-panel)" strokeWidth={1.5} {...CHART_MOTION}>
                <LabelList dataKey="code" position="top" offset={6} fill="var(--color-muted)" fontSize={10} />
              </Scatter>
            ))}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <p className="mt-1 text-xs text-muted">
        Vertical axis: {label(y)}.{" "}
        {corr != null && x !== y ? `Correlation across the 24 wards: r = ${corr.toFixed(2)}.` : ""}
      </p>
    </div>
  );
}

type Flow = { issue: string; closed: number; open: number };

/** Where the year's complaints went: each issue splits into closed and not closed. Band width is the number of complaints. */
export function ComplaintFlow({ flows }: { flows: Flow[] }) {
  const nodes = [...flows.map((f) => ({ name: f.issue })), { name: "Closed" }, { name: "Not closed" }];
  const closedIdx = flows.length, openIdx = flows.length + 1;
  const links = flows.flatMap((f, i) => [
    { source: i, target: closedIdx, value: f.closed },
    ...(f.open > 0 ? [{ source: i, target: openIdx, value: f.open }] : []),
  ]);
  const total = (i: number) => (i < flows.length ? flows[i].closed + flows[i].open : links.filter((l) => l.target === i).reduce((a, l) => a + l.value, 0));

  return (
    <div className="h-[420px]">
      <ResponsiveContainer width="100%" height="100%">
        <Sankey
          data={{ nodes, links }} nodePadding={14} nodeWidth={10} iterations={0}
          margin={{ top: 8, right: 150, bottom: 8, left: 8 }}
          link={{ stroke: "#94a3b8", strokeOpacity: 0.3 }}
          node={(props: { x: number; y: number; width: number; height: number; index: number; payload: { name: string } }) => {
            const { x, y, width, height, index, payload } = props;
            const target = index >= flows.length;
            const color = index === openIdx ? SERIES.two : SERIES.one;
            return (
              <g>
                <rect x={x} y={y} width={width} height={Math.max(height, 1)} rx={2} fill={color} />
                <text x={x + width + 8} y={y + height / 2} dy={4} fontSize={target ? 12 : 11} fontWeight={target ? 600 : 400} fill="var(--color-ink)">
                  {payload.name}
                  <tspan fill="var(--color-muted)" fontWeight={400}> {fmt.int(total(index))}</tspan>
                </text>
              </g>
            );
          }}
        >
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as { source?: { name: string }; target?: { name: string }; value?: number; name?: string };
              return (
                <div className="rounded-lg border border-line bg-base px-3 py-2 text-xs shadow-lg">
                  <p className="text-ink">{p.source && p.target ? `${p.source.name} → ${p.target.name}` : p.name}</p>
                  {p.value != null ? <p className="tabular-nums text-muted">{fmt.int(p.value)} complaints</p> : null}
                </div>
              );
            }}
          />
        </Sankey>
      </ResponsiveContainer>
    </div>
  );
}
