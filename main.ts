// btc-cent-forecast-01: 4-hour-ahead BTC/USDC forecast from 72h of 1-min closes.
// A robust shrunk-median forecaster in log space. MAE scoring rewards the
// conditional median, so every directional estimate here is a median, never
// a mean, and every estimate is shrunk hard toward persistence (last price).
//
// Method, step by step:
//  - Trend: median of the 30 latest overlapping log returns at 1h, 4h and
//    12h horizons, blended 0.45 * (4 * H1h) + 0.40 * H4h + 0.15 * (H12h / 3).
//  - Volatility: 1-min log returns are centred on their median and clipped
//    at +/-6 MAD-scales; sigma1/sigma4 are realised vol over 60/240 minutes,
//    sigmaRef the median 4h-block vol over the full history. The trend weight
//    (base 0.25) grows with sigma4/sigmaRef (clipped 0.50..1.25) and shrinks
//    when the last hour ran hot relative to the last 4 hours.
//  - Anchor: 5% pull toward the median close of the last 24h, capped at a
//    3% log gap, so a slow drift is faded only a little.
//  - Safety cap: the forecast may move at most min(1.2%, 0.85 * sigma4) in
//    log terms from the checkpoint close. Flat or broken input falls back
//    to persistence. Output is rounded to 5 decimals and clamped to the
//    scorer's (0, 10,000,000) range.
//
// Tuning (84 sliced 4h-ahead points from the practice recording + the 5
// official practice cases with known actuals): the first design (trend
// shrink 0.20, anchor pull 0.10, 72h-median anchor) lost 8.3% to persistence
// on the official cases, so the shrink went to 0.25, the pull to 0.05 and
// the anchor to the 24h median. Tuned: +1.9% vs persistence on the slices
// (43,372c vs 44,191c), +2.3% on the official cases (45,970c vs 47,055c).
// A small, consistent edge, kept close to persistence so a wrong call
// costs little. Deterministic, offline, stdlib only, ~0.08s per case.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LO = 0.00001, HI = 9999999.99999; // scorer's price grid bounds
const W1 = 0.45, W4 = 0.40, W12 = 0.15; // horizon blend weights
const SHRINK = 0.25; // base trend shrink toward persistence
const PULL = 0.05; // pull toward the 24h-median anchor
const ANCHOR = 1440; // anchor window, minutes
const MAD = 0.67449, FLOOR = 0.00002, CLIP = 6; // winsorising scale
const BLOCK = 240, NBLOCK = 18; // volatility reference blocks

type Market = { id: string; prices: number[] };
type CaseFile = { markets: Market[] };

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const grid = (v: number) => clamp(Math.round(v * 1e5) / 1e5, LO, HI);

// Median of a copy; NaN on empty input.
function med(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function forecast(m: Market): number {
  const p = m.prices;
  if (p.length === 0) throw new Error(`market ${m.id} has no prices`);
  const last = p[p.length - 1]!;
  if (!Number.isFinite(last)) throw new Error(`market ${m.id} last price is not finite`);

  const lx = p.map((v) => Math.log(v));
  const r: number[] = [];
  for (let i = 1; i < lx.length; i++) r.push(lx[i]! - lx[i - 1]!);
  if (r.length === 0) return grid(last);

  // Median of the 30 latest overlapping h-minute log returns.
  const horizon = (h: number): number => {
    const vs: number[] = [];
    for (let j = lx.length - 1; j >= Math.max(h, lx.length - 30); j--) {
      vs.push(lx[j]! - lx[j - h]!);
    }
    return med(vs);
  };
  const trend = W1 * 4 * horizon(60) + W4 * horizon(240) + W12 * (horizon(720) / 3);

  const mid = med(r);
  const scale = Math.max(med(r.map((v) => Math.abs(v - mid))) / MAD, FLOOR);
  const wr = r.map((v) => mid + clamp(v - mid, -CLIP * scale, CLIP * scale));
  const sig = (a: number, b: number) => Math.sqrt(wr.slice(a, b).reduce((s, v) => s + v * v, 0));
  const s1 = sig(Math.max(0, wr.length - 60), wr.length);
  const s4 = sig(Math.max(0, wr.length - 240), wr.length);
  const ref: number[] = [];
  for (let k = 0; k < Math.min(NBLOCK, Math.max(1, Math.floor(wr.length / BLOCK))); k++) {
    ref.push(sig(k * BLOCK, Math.min((k + 1) * BLOCK, wr.length)));
  }
  const sRef = med(ref);
  if (!Number.isFinite(s4) || s4 === 0) return grid(last);

  const hot = clamp(s1 / (s4 / 2), 0.5, 2.0);
  const alpha = SHRINK
    * clamp(s4 / sRef, 0.5, 1.25)
    * clamp(1 / (1 + 0.35 * Math.max(hot - 1, 0)), 0.6, 1.0);
  const anchor = med(p.slice(Math.max(0, p.length - ANCHOR)));
  const pull = PULL * clamp(Math.log(anchor / last), -0.03, 0.03);

  const z = clamp(alpha * trend + pull, -Math.min(0.012, 0.85 * s4), Math.min(0.012, 0.85 * s4));
  const out = last * Math.exp(z);
  return Number.isFinite(out) ? grid(out) : grid(last);
}

const inDir = process.env.MAKEFUN_INPUT_DIR ?? "/input";
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? "/output";
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(inDir).filter((x) => x.endsWith(".in")).sort()) {
  const id = f.slice(0, -3);
  const c = JSON.parse(readFileSync(join(inDir, f), "utf8")) as CaseFile;
  if (!Array.isArray(c.markets) || c.markets.length !== 1) throw new Error(`${f} must hold exactly one market`);
  const price = forecast(c.markets[0]!);
  writeFileSync(join(outDir, `${id}.out`), JSON.stringify({ forecasts: [{ case: id, price }] }) + "\n");
}
