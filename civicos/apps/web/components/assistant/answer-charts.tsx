"use client";

import { BarSeriesChart, LineSeriesChart } from "@/components/dashboard/charts";
import { SERIES } from "@/lib/chart-colors";

export type AnswerChart = {
  type: "line" | "bar";
  title: string;
  x: string;
  unit?: string;
  series: { key: string; label: string }[];
  data: Record<string, string | number | null>[];
};

const COLORS = [SERIES.one, SERIES.two, SERIES.three];

/** Charts the assistant attaches to an answer: drawn from the same tool results its cited figures came from. */
export function AnswerCharts({ charts }: { charts: AnswerChart[] }) {
  return (
    <div className="mt-4 space-y-4">
      {charts.map((c, i) => {
        const series = c.series.map((s, j) => ({ ...s, color: COLORS[j % COLORS.length] }));
        return (
          <figure key={i} className="rounded-lg border border-line p-3">
            <figcaption className="mb-2 text-xs font-medium text-ink">{c.title}</figcaption>
            {c.type === "bar" ? (
              <BarSeriesChart data={c.data} xKey={c.x} unit={c.unit} series={series[0]} height={200} />
            ) : (
              <LineSeriesChart data={c.data} xKey={c.x} xType="category" series={series} unit={c.unit} zeroBased={false} />
            )}
          </figure>
        );
      })}
    </div>
  );
}
