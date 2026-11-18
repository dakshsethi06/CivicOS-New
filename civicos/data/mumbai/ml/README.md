# Mumbai models

`train.py` trains five models (ward groups; complaint, waste, air-quality and water forecasts) on the published figures in `../praja_tables.json` and writes `results.json`;
`build_ml_sql.py` turns that into `supabase/migrations/0009_mumbai_models.sql`. Both are deterministic.

```bash
pip install scikit-learn numpy
python3 train.py ../praja_tables.json results.json                  # add --keep-clusters to reuse the ward groups in results.json (numpy only)
python3 build_ml_sql.py results.json ../../../supabase/migrations/0009_mumbai_models.sql
python3 ../../../supabase/build_all_migrations.py                    # refresh all_migrations.sql
```

To load new results into an existing Supabase project, run `0009_mumbai_models.sql` and then
`0016_three_year_forecasts.sql` in the SQL Editor; the last statement of 0016 reloads the models for every Mumbai workspace.

## Forecasting three years ahead

Complaints, waste and air quality are forecast for **2026, 2027 and 2028**; water for **2025 to 2028** (its latest
published year is 2024). Every method is tested at each distance: to judge a two-years-ahead forecast, each test year is
forecast from the years up to two years before it. Two things follow from those tests:

- **The method can differ by year.** A straight-line trend is often the most accurate one year ahead and the least accurate
  three years ahead, because it keeps extrapolating. Each forecast year uses the method that tested best at that distance,
  and the page names it.
- **Each year has its own range**, from that method's errors at that distance, and a later year's range is never narrower
  than an earlier one's. Where a series is too short to test a distance on at least two past years (waste, water), the range
  is the widest tested one scaled by √(years ahead ÷ tested years ahead), and the model records that it did so.

The 2026 forecasts are identical to those of the one-year models.

## Ward groups (clustering)

- **Features, per ward:** complaints per 10,000 residents, % closed, average days to close (all 2025),
  water supply hours and % unfit water samples (2024), waste kg per person per day (2025), slum share (2011).
  Every ward has every feature, so nothing is imputed. Air quality is left out because 7 wards have no station.
- **Method:** standardise, log-transform water hours (ward T has 24 h against a median under 4), k-means
  with 50 restarts. k from 2 to 5 chosen by silhouette score, requiring at least 3 wards per group.
- **Result:** k = 2, silhouette 0.35. Group 2 is A, B, C and H/W. Higher k scored 0.19 to 0.20 or left a
  one-ward group, so the data supports two groups and no more.

## Complaint forecasts (2026 to 2028)

- **Series:** complaints registered per year, 2016 to 2025, for every ward (all issues, SWM, drainage), every
  city issue, and the city total: 91 series.
- **Methods compared:** last year's value, average of the last three years, straight-line trend.
- **Backtest:** forecast 2022, 2023, 2024 and 2025 from the years up to 1, 2 and 3 years before each. For each distance,
  the method with the lowest mean absolute percentage error across a family of series is used for every series in it.
- **Interval:** 80% of that method's backtest errors at that distance fell within ±x%; the range is forecast × (1 ± x).

| Family | 1-yr error (MAPE), used / last year | Used for 2026 · 2027 · 2028 | 80% range 2026 · 2027 · 2028 |
| --- | --- | --- | --- |
| All complaints, by ward | 9.7% / 11.7% | trend · 3-yr avg · 3-yr avg | ±14.2% · ±22.0% · ±22.0% |
| Solid waste, by ward | 23.4% / 23.4% | last year · last year · 3-yr avg | ±43.6% · ±54.1% · ±54.1% |
| Drainage, by ward | 22.2% / 22.2% | last year · 3-yr avg · 3-yr avg | ±27.4% · ±29.8% · ±34.8% |
| City, by issue | 16.5% / 16.8% | 3-yr avg (all years) | ±25.7% · ±33.7% · ±36.3% |
| City, all issues | 5.8% / 10.6% | trend · trend · 3-yr avg | ±10.2% · ±14.8% · ±16.4% |

City total: 125,270 in 2026, 128,546 in 2027, 121,919 in 2028 (the 2028 figure switches to the 3-year average, which held
up best three years ahead). The city-total result rests on four test forecasts of one series per distance, so treat its
edge over the baseline as tentative.

## Waste forecasts (2026 to 2028)

Waste lifted per day for the city and each of the 24 wards, 2021 to 2025 (Praja Foundation 2026 report, Table 37).
The same three methods as the complaint forecasts, tested on 2024 and 2025 (each needs three earlier years).

| Series | Last year | 3-year average | Trend | Used | 80% range |
| --- | --- | --- | --- | --- | --- |
| Waste lifted, by ward (24 series) | **3.7%** | 22.0% | 17.1% | Last year | ±5.1% |
| Waste lifted, whole city | 2.6% | 5.4% | **2.0%** | Trend | ±5.1% |

City: about **7,174 tonnes/day in 2026** (6,808 to 7,540), 7,393 in 2027 and 7,612 in 2028; 2025 was 6,955. The city
series gives only two test errors, so its range uses the wider ward-level figure. For wards, repeating 2025 was clearly
best, so ward forecasts equal their 2025 figure and the range is the useful part. Five years allow only the one-year
test, so the 2027 and 2028 ranges (±7.3%, ±8.9%) are widened from it, not measured.

## Air-quality forecast (each month of 2026 to 2028)

City-wide monthly average AQI, January 2016 to December 2025: 120 months (Praja Foundation 2026 report, Table 29).
AQI follows a strong yearly cycle, so all four methods are seasonal. Each one forecast all twelve months of 2022,
2023, 2024 and 2025 using only the years before.

| Method | Average miss, % | Average miss, AQI points |
| --- | --- | --- |
| Same month last year (baseline) | 21.0% | 19.8 |
| Same month, average of the last three years | 18.9% | 18.6 |
| Same month, average of all earlier years | 17.0% | 16.9 |
| **Seasonal shape of all earlier years, at last year's level** | **16.1%** | **15.2** |

The chosen method takes the average shape of the year (each month as a share of its year's mean) and applies it to
the latest year's mean. It misses 23% less than repeating last year. 80% of test forecasts were within ±30%, which
sets the range.

2026 forecast: Jan 144, Feb 128, Mar 109, Apr 79, May 68, Jun 50, Jul 49, Aug 45, Sep 49, Oct 87, Nov 120, Dec 137.
Five months are forecast above 100 (the upper limit of "Satisfactory"); the Insights page turns that into a
recommendation.

Further ahead the seasonal shape alone holds up worse (22.9% two years ahead), so 2027 uses the all-years monthly average
(17.4%) and 2028 the last-three-years monthly average (17.1%). Their 80% ranges stay at ±30%.

Limits: city-wide only (no monthly AQI by ward is published); an unusual year (weak monsoon, heavy firecracker
season, construction boom) will not be foreseen; the history includes 2020, the lockdown year.

## Water forecasts (2025 to 2028)

Published to 2024 only, five years each (Praja Foundation 2025 report): drinking-water samples found unfit, % (Table 7,
24 wards and the city) and water drawn and supplied city-wide, MLD by financial year (Table 2). The same three methods,
tested one year ahead on 2023 and 2024; 2026 to 2028 ranges are widened from that test.

| Series | Last year | 3-year average | Trend | Used | 80% range 2025 → 2028 |
| --- | --- | --- | --- | --- | --- |
| Unfit samples, wards and city (average miss, points) | 0.54 | **0.43** | 0.53 | 3-yr avg | ±0.64 → ±1.28 points |
| Water drawn and supplied, city (MAPE) | 1.5% | **1.2%** | 3.2% | 3-yr avg | ±1.8% → ±3.7% |

Unfit samples are scored in percentage points because many wards test at or near zero, where an error as a share of the
figure is meaningless. City-wide: 0.51% unfit; about 4,435 MLD drawn and 3,948 MLD supplied a year. The published
water balance repeats the same figures for 2019-20 and 2020-21, and the range for drawn and supplied rests on only
four test forecasts, so treat it as rough.

## More indicators (added November 2026)

- **Water lost between the lakes and supply** (MLD and % of water drawn), city, 2020-2024 -> 2025-2028: same three
  methods and backtest as water drawn and supplied.
- **Complaint closure**: average days to close a complaint and the share closed (closed / registered), city and every
  ward, 2023-2025 -> 2026-2028. Only three years are published, so methods that work from two years of history
  (last year, two-year average, trend) were compared by forecasting 2025 from 2023-2024 across all 25 series; the
  two-year average won (days: 49% average miss against 64% for repeating last year; share closed: 15.6 points against
  19.8). Ranges for 2027 and 2028 are widened from that single test year. Treat these as rough.
- Not forecast: figures published for one year only (water supply hours, waste per person, bulk generators,
  air-quality days, population), which have no trend.
