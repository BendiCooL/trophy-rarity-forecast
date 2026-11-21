// Trophy rarity forecaster for GTA VI (make.fun: gta6-trophy-rarity-forecast-01).
//
// For every trophy in a case file, this program predicts five quantiles of the
// trophy's earn rate (percent of tracked players who hold it) at the case's
// target time. It reads every *.in case in the input directory and writes one
// <id>.out file per case to the output directory. Node 22, standard library
// only, no network, fully deterministic.
//
// Model sketch
// ------------
// A printed earn rate is a ratio: earners / players_tracked. The two parts
// move for different reasons, so they are forecast separately and divided at
// the end.
//
//   * Players: the tracked-player count grows quickly after launch and then
//     bends over. On the axis x = ln(1 + hours since release) that bend is
//     close to a straight line, so ln(players) is extrapolated by least
//     squares and clamped to a sane band around the last observed count.
//
//   * Earners: per trophy, earners grow as the player base works through the
//     game. Each trophy gets a log-earners slope on the same x axis, but a
//     single trophy's slope is noisy, so it is shrunk toward the mean slope
//     of its tier (platinum / gold / silver / bronze) with a precision
//     weighted posterior. The forecast earners are capped just below the
//     forecast player count.
//
//   * Median: earners_target / players_target, with the implied logit move
//     away from the last printed rate damped by a factor, because earn-rate
//     ratios rarely travel as far as a raw two-sided extrapolation suggests.
//
//   * Spread: the quantile band lives on the logit scale. Its width combines
//     a horizon term (uncertainty grows with the square root of the days
//     ahead), the posterior slope uncertainty carried over the x distance,
//     and a constant floor term for refresh-step noise (the source page
//     updates its counts in jumps, not continuously).
//
// Histories are first collapsed to distinct snapshots: the source page can
// sit unchanged across many reads, and treating every read as a fresh
// observation would fake precision that is not there.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Release-day anchor for the time axis: x = ln(1 + hours since this instant).
const RELEASE_MS = Date.parse("2026-11-19T00:00:00Z");

// The five forecast levels and their standard-normal quantiles.
const LEVELS: Array<[number, number]> = [
  [0.05, -1.645],
  [0.25, -0.674],
  [0.5, 0],
  [0.75, 0.674],
  [0.95, 1.645],
];

// Players forecast is clamped into [last, PLAYERS_MAX_GROWTH * last].
const PLAYERS_MAX_GROWTH = 25;

// Hierarchical shrinkage prior for per-trophy earner slopes.
const SLOPE_PRIOR_SD = 0.35;
// Standard-error guards for a fitted slope: never trust one completely,
// never let one become so vague that it swamps the prior either.
const SLOPE_SE_FLOOR = 0.1;
const SLOPE_SE_CAP = 2.0;
const SLOPE_SE_TWO_POINTS = 0.5;

// Earner forecasts may not exceed this share of the player forecast.
const EARNERS_CAP_SHARE = 0.995;
// Logit move from the last printed rate is damped by this factor.
const LOGIT_DAMPING = 0.85;

// Spread recipe on the logit scale:
//   sigma^2 = (SPREAD_HORIZON * sqrt(days))^2 + (slope_sd * dx)^2 + SPREAD_BASE^2
// clamped into [SPREAD_MIN, SPREAD_MAX].
const SPREAD_HORIZON = 0.4;
const SPREAD_BASE = 0.3;
const SPREAD_MIN = 0.55;
const SPREAD_MAX = 2.0;

// Printed rates are percentages in (0, 100); keep logits finite.
const RATE_EPS = 0.01;

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function logit(p: number): number {
  const c = clamp(p, RATE_EPS / 100, 1 - RATE_EPS / 100);
  return Math.log(c / (1 - c));
}

function invLogit(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

// x-axis value for a timestamp: ln(1 + hours since release).
function timeX(ms: number): number {
  const hours = (ms - RELEASE_MS) / 3_600_000;
  return Math.log(Math.max(1 + hours, 0.05));
}

interface OlsFit {
  slope: number;
  intercept: number;
  slopeSe: number;
  n: number;
}

// Ordinary least squares of y on x, with the standard error of the slope.
function ols(xs: number[], ys: number[]): OlsFit | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i] - my);
  }
  if (sxx <= 1e-12) return null;
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let slopeSe: number;
  if (n === 2) {
    slopeSe = SLOPE_SE_TWO_POINTS;
  } else {
    let rss = 0;
    for (let i = 0; i < n; i++) {
      const r = ys[i] - (intercept + slope * xs[i]);
      rss += r * r;
    }
    const s2 = rss / (n - 2);
    slopeSe = Math.sqrt(Math.max(s2, 0) / sxx);
  }
  return { slope, intercept, slopeSe: clamp(slopeSe, SLOPE_SE_FLOOR, SLOPE_SE_CAP), n };
}

// ---------------------------------------------------------------------------
// Case handling
// ---------------------------------------------------------------------------

interface TrophyMeta {
  id: number;
  tier: string;
}

interface Snapshot {
  x: number;
  players: number;
  rates: Array<number | null>;
}

interface CaseData {
  id: string;
  targetMs: number;
  horizonDays: number;
  trophies: TrophyMeta[];
  snapshots: Snapshot[];
}

// Collapse the read history to distinct page states. Two reads are the same
// state when the player count, the earned total and every rate agree; the
// earliest sighting of a state is kept as its timestamp.
function distinctSnapshots(history: any[]): Snapshot[] {
  const seen = new Set<string>();
  const out: Snapshot[] = [];
  for (const read of history) {
    const rates: Array<number | null> = Array.isArray(read?.rates) ? read.rates : [];
    const key =
      String(read?.players_tracked) + "|" + String(read?.trophies_earned) + "|" + rates.join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    const atMs = Date.parse(read?.at ?? read?.slot ?? "");
    out.push({
      x: timeX(Number.isFinite(atMs) ? atMs : RELEASE_MS),
      players: Number(read?.players_tracked) || 0,
      rates,
    });
  }
  return out;
}

function parseCase(raw: any): CaseData {
  const trophies: TrophyMeta[] = (raw?.trophies ?? []).map((t: any) => ({
    id: Number(t?.id),
    tier: String(t?.tier ?? ""),
  }));
  const targetMs = Date.parse(raw?.target ?? "");
  const horizonDays = Math.max(Number(raw?.horizon_minutes) || 0, 0) / 1440;
  return {
    id: String(raw?.id ?? "case"),
    targetMs: Number.isFinite(targetMs) ? targetMs : RELEASE_MS,
    horizonDays,
    trophies,
    snapshots: distinctSnapshots(Array.isArray(raw?.history) ? raw.history : []),
  };
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

// Forecast the tracked-player count at the target.
function forecastPlayers(c: CaseData, xTarget: number): number {
  const pts = c.snapshots.filter((s) => s.players > 0);
  if (pts.length === 0) return 0;
  const last = pts[pts.length - 1].players;
  const fit = ols(
    pts.map((s) => s.x),
    pts.map((s) => Math.log(s.players)),
  );
  if (!fit) return last;
  const predicted = Math.exp(fit.intercept + fit.slope * xTarget);
  if (!Number.isFinite(predicted)) return last;
  return clamp(predicted, last, last * PLAYERS_MAX_GROWTH);
}

interface TrophyForecast {
  medianRate: number; // percent
  sigma: number; // logit-scale spread
}

// Per-trophy earner series over distinct snapshots, plus its shrunk slope.
function forecastTrophies(c: CaseData, playersTarget: number, xTarget: number): TrophyForecast[] {
  const n = c.trophies.length;
  const results: TrophyForecast[] = new Array(n);
  if (c.snapshots.length === 0 || playersTarget <= 0) {
    for (let i = 0; i < n; i++) results[i] = { medianRate: 1, sigma: SPREAD_MIN };
    return results;
  }
  const xLast = c.snapshots[c.snapshots.length - 1].x;
  const dx = Math.max(xTarget - xLast, 0);

  // First pass: each trophy's own earner slope and its standard error.
  const slopes: Array<number | null> = new Array(n).fill(null);
  const slopeSes: number[] = new Array(n).fill(SLOPE_SE_CAP);
  const anchors: number[] = new Array(n).fill(0); // recent earner level
  const anchorXs: number[] = new Array(n).fill(xLast); // x the anchor sits at
  const lastRates: Array<number | null> = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    const xs: number[] = [];
    const ys: number[] = [];
    const earners: number[] = [];
    for (const s of c.snapshots) {
      const r = s.rates[i];
      if (r === null || r === undefined || !Number.isFinite(r) || s.players <= 0) continue;
      const e = (r / 100) * s.players;
      xs.push(s.x);
      ys.push(Math.log(e + 0.5));
      earners.push(e);
      lastRates[i] = r;
    }
    if (earners.length > 0) {
      const tail = earners.slice(-3);
      anchors[i] = tail.reduce((a, b) => a + b, 0) / tail.length;
      // The anchor averages the last few snapshots, so it belongs to their
      // mean x, not to the final snapshot's x; projecting from the wrong
      // origin would bias every forecast by the slope over that gap.
      const tailX = xs.slice(-3);
      anchorXs[i] = tailX.reduce((a, b) => a + b, 0) / tailX.length;
    }
    const fit = ols(xs, ys);
    if (fit) {
      slopes[i] = fit.slope;
      slopeSes[i] = fit.slopeSe;
    }
  }

  // Tier mean slopes (falling back to the global mean, then to zero).
  const tierSlopes = new Map<string, number[]>();
  let globalSum = 0;
  let globalCount = 0;
  for (let i = 0; i < n; i++) {
    if (slopes[i] === null) continue;
    const tier = c.trophies[i].tier;
    if (!tierSlopes.has(tier)) tierSlopes.set(tier, []);
    tierSlopes.get(tier)!.push(slopes[i]!);
    globalSum += slopes[i]!;
    globalCount++;
  }
  const globalMean = globalCount > 0 ? globalSum / globalCount : 0;
  const tierMean = (tier: string): number => {
    const arr = tierSlopes.get(tier);
    if (arr && arr.length > 0) return arr.reduce((a, b) => a + b, 0) / arr.length;
    return globalMean;
  };

  // Second pass: shrink, project, and build the quantile band.
  for (let i = 0; i < n; i++) {
    const mu = tierMean(c.trophies[i].tier);
    let postSlope = mu;
    let postSd = SLOPE_PRIOR_SD;
    if (slopes[i] !== null) {
      const wData = 1 / (slopeSes[i] * slopeSes[i]);
      const wPrior = 1 / (SLOPE_PRIOR_SD * SLOPE_PRIOR_SD);
      postSlope = (slopes[i]! * wData + mu * wPrior) / (wData + wPrior);
      postSd = Math.sqrt(1 / (wData + wPrior));
    }

    const dxTrophy = Math.max(xTarget - anchorXs[i], 0);
    let earnersTarget = anchors[i] * Math.exp(postSlope * dxTrophy);
    earnersTarget = clamp(earnersTarget, 0, EARNERS_CAP_SHARE * playersTarget);
    let median = (100 * earnersTarget) / playersTarget;

    // Damp the logit move away from the last printed rate.
    const rLast = lastRates[i];
    if (rLast !== null && rLast > 0 && rLast < 100 && median > 0 && median < 100) {
      const moved = logit(rLast / 100) + LOGIT_DAMPING * (logit(median / 100) - logit(rLast / 100));
      median = 100 * invLogit(moved);
    }
    median = clamp(median, RATE_EPS, 100 - RATE_EPS);

    const horizonTerm = SPREAD_HORIZON * Math.sqrt(Math.max(c.horizonDays, 0));
    const sigma = clamp(
      Math.sqrt(
        horizonTerm * horizonTerm + (postSd * dxTrophy) * (postSd * dxTrophy) + SPREAD_BASE * SPREAD_BASE,
      ),
      SPREAD_MIN,
      SPREAD_MAX,
    );
    results[i] = { medianRate: median, sigma };
  }
  return results;
}

function forecastCase(c: CaseData): { trophies: Array<{ id: number; q: number[] }> } {
  const xTarget = timeX(c.targetMs);
  const playersTarget = forecastPlayers(c, xTarget);
  const per = forecastTrophies(c, playersTarget, xTarget);
  const rows = c.trophies.map((t, i) => {
    const f = per[i] ?? { medianRate: 1, sigma: SPREAD_MIN };
    const centre = logit(f.medianRate / 100);
    const q = LEVELS.map(([, z]) => {
      const v = 100 * invLogit(centre + z * f.sigma);
      return clamp(Math.round(v * 10000) / 10000, RATE_EPS, 100 - RATE_EPS);
    });
    // Rounding can break monotonicity at the extremes; repair in order.
    for (let k = 1; k < q.length; k++) {
      if (q[k] < q[k - 1]) q[k] = q[k - 1];
    }
    return { id: t.id, q };
  });
  return { trophies: rows };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  mkdirSync(outputDir, { recursive: true });
  const files = readdirSync(inputDir)
    .filter((f) => f.endsWith(".in"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(join(inputDir, file), "utf8"));
    const parsed = parseCase(raw);
    const out = forecastCase(parsed);
    writeFileSync(join(outputDir, parsed.id + ".out"), JSON.stringify(out) + "\n");
  }
}

main();
