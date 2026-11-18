export type Feature = { key: string; label: string; higher_is_better: boolean | null };
export type Group = { cluster: number; label: string; wards: string[]; mean: Record<string, number>; z: Record<string, number> };
/** Backtest results for one family of series. Keys of the *_by_horizon maps are years ahead ("1", "2", "3"). */
export type FamilyMetrics = {
  label: string;
  series: number;
  backtest_years: number[];
  chosen: string;
  mape_pct: Record<string, number>;
  mae: Record<string, number>;
  interval_pct: number;
  improvement_vs_naive_pct: number | null;
  error?: "relative" | "absolute";
  chosen_by_horizon?: Record<string, string>;
  horizons_tested?: number[];
  mape_pct_by_horizon?: Record<string, Record<string, number>>;
  interval_pct_by_horizon?: Record<string, number>;
  interval_basis_by_horizon?: Record<string, string>;
};
/** The water model's unfit-samples family is scored in percentage points, not as a share. */
export type AbsFamilyMetrics = Omit<FamilyMetrics, "mape_pct" | "interval_pct" | "interval_pct_by_horizon" | "improvement_vs_naive_pct"> & {
  interval_abs: number;
  interval_abs_by_horizon: Record<string, number>;
};

export type Model<P> = {
  id: string;
  name: string;
  kind: "clustering" | "forecast";
  method: string;
  description: string;
  params: P;
  metrics: Record<string, unknown>;
  trained_on: string;
  trained_at: string;
};

export type ClusterParams = { k: number; features: Feature[]; groups: Group[] };
export type ForecastParams = { methods: Record<string, string>; backtest_years: number[]; forecast_years?: number[]; families: Record<string, FamilyMetrics> };

export type Forecast = { year: number; value: number; lower: number; upper: number; method: string; family: string; category: string | null };
export type YearRange = { year: number; value: number; lower: number; upper: number };
/** One ward's latest published figure and its forecast for each future year. */
export type WardForecast = { code: string; name: string; last: number | null; last_year: number | null; years: YearRange[] };

export type MlData = {
  models: { clustering?: Model<ClusterParams>; forecast?: Model<ForecastParams> };
  wards: { code: string; name: string; cluster: number; features: Record<string, number>; z: Record<string, number> }[];
  zone: { id: string; code: string; name: string } | null;
  issue: string | null;
  history: { year: number; value: number }[];
  forecasts: Forecast[];
  ward_forecasts: WardForecast[];
  issues_with_forecasts: string[];
  ward_issues: string[];
};

export type AqiParams = {
  methods: Record<string, string>;
  backtest_years: number[];
  forecast_years?: number[];
  chosen: string;
  chosen_by_horizon?: Record<string, string>;
  mape_pct: Record<string, number>;
  mape_pct_by_horizon?: Record<string, Record<string, number>>;
  mae: Record<string, number>;
  interval_pct: number;
  interval_pct_by_horizon?: Record<string, number>;
  backtest: { year: number; predicted: number[]; actual: number[]; mae: number }[];
  naive: string;
};
export type SourceRef = { publisher: string; table: string; page: number } | null;
export type MonthPoint = { year: number; month: number; value: number; lower?: number; upper?: number; method?: string };

export type WaterParams = {
  methods: Record<string, string>;
  backtest_years: number[];
  forecast_years: number[];
  families: { unfit: AbsFamilyMetrics; city_water_fy: FamilyMetrics };
};
type MetricPoint = { year: number; metric: "water_yield_fy" | "water_supply_fy"; value: number; lower?: number; upper?: number; method?: string };

export type ForecastExtras = {
  zone: { id: string; code: string; name: string } | null;
  aqi: { model: Model<AqiParams> | null; history: MonthPoint[]; forecast: MonthPoint[]; source: SourceRef };
  waste: {
    model: Model<ForecastParams> | null;
    history: { year: number; value: number }[];
    forecasts: Forecast[];
    ward_forecasts: WardForecast[];
    source: SourceRef;
  };
  water?: {
    model: Model<WaterParams> | null;
    unfit: { history: { year: number; value: number }[]; forecasts: (YearRange & { method: string })[]; wards: WardForecast[] };
    balance: { history: MetricPoint[]; forecasts: MetricPoint[] };
  };
};

export const METHOD_SHORT: Record<string, string> = {
  naive: "last year", mean3: "3-year average", trend: "trend",
  snaive: "same month last year", smean3: "3-year monthly average", climatology: "all-years monthly average", profile: "seasonal shape",
};

/** "trend for 2026, 3-year average for 2027 and 2028" from a family's per-horizon choice. */
export function methodsByYear(chosen: Record<string, string> | undefined, firstYear: number, fallback: string) {
  const byH = chosen ?? { "1": fallback };
  const groups: { method: string; years: number[] }[] = [];
  for (const h of Object.keys(byH).map(Number).sort((a, b) => a - b)) {
    const m = byH[String(h)], y = firstYear + h - 1, last = groups.at(-1);
    if (last && last.method === m) last.years.push(y); else groups.push({ method: m, years: [y] });
  }
  const yrs = (ys: number[]) => (ys.length === 1 ? `${ys[0]}` : ys.length === 2 ? `${ys[0]} and ${ys[1]}` : `${ys[0]} to ${ys.at(-1)}`);
  return groups.map((g) => `${METHOD_SHORT[g.method] ?? g.method} for ${yrs(g.years)}`).join(", ");
}

/** forecast_more() (migration 0023): complaint closure and water lost in distribution. */
type ShortFamily = { label: string; series: number; chosen: string; chosen_by_horizon: Record<string, string>; backtest_years: number[];
                     mape_pct?: Record<string, number>; mae?: Record<string, number>; interval_pct_by_horizon?: Record<string, number>;
                     interval_abs_by_horizon?: Record<string, number> };
export type MoreForecasts = {
  zone: string | null;
  closure: {
    model: { method: string; description: string; trained_on: string;
             params: { methods: Record<string, string>; families: { days_to_close: ShortFamily; closed_pct: ShortFamily } } } | null;
    days: { history: { year: number; value: number }[]; forecasts: (YearRange & { method: string })[] };
    pct: { history: { year: number; value: number }[]; forecasts: (YearRange & { method: string })[] };
    wards: { code: string; name: string; days_last: number | null; days: YearRange[] | null; pct: YearRange[] | null }[];
  };
  water_loss: {
    history: { year: number; metric: string; value: number }[];
    forecasts: { year: number; metric: string; value: number; lower: number; upper: number; method: string }[];
  };
};
