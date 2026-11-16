# Mumbai models

`train.py` trains four models (ward groups; complaint, waste and air-quality forecasts) on the published figures in `../praja_tables.json` and writes `results.json`;
`build_ml_sql.py` turns that into `supabase/migrations/0009_mumbai_models.sql`. Both are deterministic.

```bash
pip install scikit-learn numpy
python3 train.py ../praja_tables.json results.json
python3 build_ml_sql.py results.json ../../../supabase/migrations/0009_mumbai_models.sql
```

## Ward groups (clustering)

- **Features, per ward:** complaints per 10,000 residents, % closed, average days to close (all 2025),
  water supply hours and % unfit water samples (2024), waste kg per person per day (2025), slum share (2011).
  Every ward has every feature, so nothing is imputed. Air quality is left out because 7 wards have no station.
- **Method:** standardise, log-transform water hours (ward T has 24 h against a median under 4), k-means
  with 50 restarts. k from 2 to 5 chosen by silhouette score, requiring at least 3 wards per group.
- **Result:** k = 2, silhouette 0.35. Group 2 is A, B, C and H/W. Higher k scored 0.19 to 0.20 or left a
  one-ward group, so the data supports two groups and no more.

## Complaint forecasts (2026)

- **Series:** complaints registered per year, 2016 to 2025, for every ward (all issues, SWM, drainage), every
  city issue, and the city total: 91 series.
- **Methods compared:** last year's value, average of the last three years, straight-line trend.
- **Backtest:** forecast 2022, 2023, 2024 and 2025 from the years before each. The method with the lowest
  mean absolute percentage error across a family of series is used for every series in it.
- **Interval:** 80% of that method's backtest errors fell within ±x%; the range is forecast × (1 ± x).

| Family | Chosen | Error (MAPE) | Last-year baseline | 80% range |
| --- | --- | --- | --- | --- |
| All complaints, by ward | trend | 9.7% | 11.7% | ±14.2% |
| Solid waste, by ward | last year | 23.4% | 23.4% | ±43.6% |
| Drainage, by ward | last year | 22.2% | 22.2% | ±27.4% |
| City, by issue | 3-yr average | 16.5% | 16.8% | ±25.7% |
| City, all issues | trend | 5.8% | 10.6% | ±10.2% |

The city-total result rests on four test forecasts of one series, so treat its edge over the baseline as tentative.

## Waste forecasts (2026)

Waste lifted per day for the city and each of the 24 wards, 2021 to 2025 (Praja Foundation 2026 report, Table 37).
The same three methods as the complaint forecasts, tested on 2024 and 2025 (each needs three earlier years).

| Series | Last year | 3-year average | Trend | Used | 80% range |
| --- | --- | --- | --- | --- | --- |
| Waste lifted, by ward (24 series) | **3.7%** | 22.0% | 17.1% | Last year | ±5.1% |
| Waste lifted, whole city | 2.6% | 5.4% | **2.0%** | Trend | ±5.1% |

City 2026: about **7,174 tonnes/day** (6,808 to 7,540); 2025 was 6,955. The city series gives only two test errors,
so its range uses the wider ward-level figure. For wards, repeating 2025 was clearly best, so ward forecasts equal
their 2025 figure and the range is the useful part.

## Air-quality forecast (each month of 2026)

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

Limits: city-wide only (no monthly AQI by ward is published); an unusual year (weak monsoon, heavy firecracker
season, construction boom) will not be foreseen; the history includes 2020, the lockdown year.
