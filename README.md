# btc-cent-forecast-01 — Forecast Bitcoin's price 4 hours ahead

Entry for the make.fun bounty [btc-cent-forecast-01](https://make.fun/bounty/btc-cent-forecast-01) ($250, 100 paid places).

`main.ts` (Node 22, standard library only) reads one case at a time — 4,320
one-minute BTC/USDC closes covering the 72 hours up to a checkpoint — and
writes one number: the forecast of the close 240 minutes after the checkpoint,
to `/output/<id>.out` as `{"forecasts":[{"case":"<id>","price":<number>}]}`.

## Method

A robust, heavily shrunk median forecaster in log-price space (MAE scoring
makes the conditional median the optimal point forecast):

- **Trend:** medians of the 30 most recent overlapping 60/240/720-minute log
  returns, combined as `0.45·(4·H60) + 0.40·H240 + 0.15·(H720/3)`.
- **Volatility-adaptive shrinkage:** 1-minute returns are winsorised at
  ±6·MAD-scale; realised 4h volatility `σ4` and a 72h block-median reference
  scale the trend weight, with a penalty when the last hour is unusually
  turbulent. Base trend shrink 0.25.
- **Mean reversion:** 5% pull toward the median of the last 24 hours of
  prices, capped at ±3% log-distance.
- **Cap:** the forecast's log-deviation from the checkpoint close is capped
  at `min(1.2%, 0.85·σ4)`, so a short-term spike is never extrapolated.

Deterministic (same input bytes → same output bytes), no network, no clock,
~0.08 s per case (limit 8 s).

## Backtest (practice recording, 2026-11-07 → 2026-11-11)

- 84 sliced 4h-ahead points + the 5 official practice cases with known
  actuals (the 6th case's target is outside the recording).
- Persistence (house baseline) MAE: 44,191¢ on slices, 47,055¢ on the 5
  official cases (official 6-case baseline: 44,522¢).
- This entry: 43,372¢ on slices (**+1.9%** vs persistence), 45,970¢ on the
  5 official cases (**+2.3%**). Wins 44/84 slices, 2/5 official cases —
  a small, consistent edge, deliberately kept close to persistence so a
  wrong directional call costs little.
- The as-designed version (trend shrink 0.20, reversion 0.10, 72h-median
  anchor) scored 8.3% *worse* than persistence on the official cases; the
  constants above are the tuned fix (see the header comment in `main.ts`).

## Run locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=../btc-cent-forecast-01-kit/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see `LICENSE`.
