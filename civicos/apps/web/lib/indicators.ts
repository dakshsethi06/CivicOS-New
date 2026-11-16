import type { Source } from "./dashboard";

export type IndRow = { ward: string | null; year: number; month: number | null; metric: string; category: string | null; value: number; source: string };
export type WardRef = { id: string; code: string; name: string; population: number | null };
export type IndicatorData = { rows: IndRow[]; wards: WardRef[]; sources: Record<string, Source> };

type Where = { ward?: string | null; year?: number; category?: string | null };
const match = (r: IndRow, metric: string, w: Where) =>
  r.metric === metric &&
  (w.ward === undefined || r.ward === w.ward) &&
  (w.year === undefined || r.year === w.year) &&
  (w.category === undefined || r.category === w.category);

/** Small query helpers over the published rows. `ward: null` means the city-level row. */
export function reader(rows: IndRow[]) {
  return {
    one: (metric: string, w: Where = {}) => rows.find((r) => match(r, metric, w))?.value ?? null,
    all: (metric: string, w: Where = {}) => rows.filter((r) => match(r, metric, w)),
    years: (metric: string) => [...new Set(rows.filter((r) => r.metric === metric).map((r) => r.year))].sort((a, b) => a - b),
    /** One value per ward for a metric and year, in ward order. */
    byWard: (metric: string, year: number, category: string | null = null) =>
      rows.filter((r) => r.metric === metric && r.year === year && r.ward != null && r.category === category).map((r) => ({ ward: r.ward as string, value: r.value })),
    /** Yearly series for one ward, or the city when ward is null. */
    series: (metric: string, ward: string | null, category: string | null = null) =>
      rows.filter((r) => r.metric === metric && r.ward === ward && r.category === category && r.month == null).map((r) => ({ year: r.year, value: r.value })),
  };
}
