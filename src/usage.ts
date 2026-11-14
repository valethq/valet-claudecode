import { tmpdir } from "node:os";
import type { PluginContext, SettingsBlock, SettingsTone } from "@valethq/sdk";
import { claudeEnv } from "./cache";
import type { ClaudeCodeConfig } from "./config";
import { untilReset } from "./events";
import type { SdkDeps } from "./sdk";

const SESSION_MS = 5 * 3_600_000;
const WEEK_MS = 7 * 86_400_000;
/** Pace within this many points of an even burn-down counts as "on pace". */
const PACE_SLACK = 5;
/** A cached reading newer than this is reused; the plan-usage endpoint is not meant to be hammered. */
const FRESH_MS = 60_000;
/** After a failed read, wait this long before trying again on its own. */
const RETRY_MS = 5 * 60_000;
/** "Refresh now" within this long of the last read is ignored. */
const MANUAL_GAP_MS = 10_000;
const FETCH_TIMEOUT_MS = 20_000;
/** How long the first view waits for a reading before showing "Reading usage". */
const FIRST_WAIT_MS = 3_000;

export interface UsageRow {
  kind: string;
  group: string;
  /** Share of the window used, 0-100. */
  percent: number;
  resetsAt?: number;
  severity: string;
  scope?: string;
}

export interface UsageSnapshot {
  available: boolean;
  plan?: string;
  rows: UsageRow[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const time = (v: unknown): number | undefined => {
  const t = typeof v === "string" ? Date.parse(v) : Number.NaN;
  return Number.isFinite(t) ? t : undefined;
};

function row(
  kind: string,
  group: string,
  percent: unknown,
  resets: unknown,
  severity: unknown,
  scope?: string,
) {
  const p = num(percent);
  if (p === undefined) return undefined;
  const resetsAt = time(resets);
  return {
    kind,
    group,
    percent: Math.min(100, Math.max(0, p)),
    ...(resetsAt !== undefined && { resetsAt }),
    severity: typeof severity === "string" ? severity : "normal",
    ...(scope !== undefined && { scope }),
  } satisfies UsageRow;
}

/** The SDK's usage call is experimental, so trust nothing about its shape. */
export function parseUsage(raw: unknown): UsageSnapshot {
  const o = isObj(raw) ? raw : {};
  const limits = isObj(o.rate_limits) ? o.rate_limits : undefined;
  const plan = typeof o.subscription_type === "string" ? o.subscription_type : undefined;
  const base = { ...(plan !== undefined && { plan }) };
  if (o.rate_limits_available === false || !limits) return { available: false, ...base, rows: [] };
  const rows: UsageRow[] = [];
  if (Array.isArray(limits.limits)) {
    for (const l of limits.limits) {
      if (!isObj(l)) continue;
      const scope = isObj(l.scope) ? l.scope : {};
      const name = [scope.model, scope.surface]
        .map((s) => (isObj(s) ? s.display_name : undefined))
        .find((n) => typeof n === "string");
      const r = row(
        String(l.kind ?? ""),
        String(l.group ?? ""),
        l.percent,
        l.resets_at,
        l.severity,
        name as string | undefined,
      );
      if (r) rows.push(r);
    }
  } else {
    const windows: [string, string, unknown][] = [
      ["session", "session", limits.five_hour],
      ["weekly_all", "weekly", limits.seven_day],
    ];
    for (const [kind, group, w] of windows) {
      const r = isObj(w) ? row(kind, group, w.utilization, w.resets_at, undefined) : undefined;
      if (r) rows.push(r);
    }
    if (Array.isArray(limits.model_scoped)) {
      for (const m of limits.model_scoped) {
        const r = isObj(m)
          ? row(
              "weekly_scoped",
              "weekly",
              m.utilization,
              m.resets_at,
              undefined,
              String(m.display_name ?? ""),
            )
          : undefined;
        if (r) rows.push(r);
      }
    }
  }
  return { available: true, ...base, rows };
}

const capitalize = (s: string) => (s ? s[0]?.toUpperCase() + s.slice(1) : s);
const label = (r: UsageRow) =>
  `${capitalize(r.group || r.kind.replaceAll("_", " "))}${r.scope ? ` · ${r.scope}` : ""}`;
const windowMs = (r: UsageRow) =>
  r.group === "session" ? SESSION_MS : r.group === "weekly" ? WEEK_MS : undefined;
const tone = (severity: string): SettingsTone =>
  severity === "critical" ? "critical" : severity === "warning" ? "warning" : "normal";

/** One meter per limit: the bar shows what is left, the marker where an even burn-down would be by now. */
export function usageMeter(r: UsageRow, now: number): SettingsBlock {
  const used = Math.round(r.percent);
  const left = 100 - used;
  /** Zero when the reset time is unknown or already past (a stale reading). */
  const remaining = r.resetsAt === undefined ? 0 : Math.max(0, r.resetsAt - now);
  const span = windowMs(r);
  const pace = remaining > 0 && span !== undefined;
  const burned = pace ? Math.min(1, 1 - remaining / span) * 100 : 0;
  const status = !pace
    ? undefined
    : used > burned + PACE_SLACK
      ? "Over pace"
      : used < burned - PACE_SLACK
        ? "Under pace"
        : "On pace";
  return {
    type: "meter",
    label: label(r),
    value: left,
    display: `${left}% left`,
    ...(used > 0 &&
      remaining > 0 && { caption: `+${used}% in ${untilReset((now + remaining) / 1000, now)}` }),
    ...(status && { status }),
    ...(pace && { marker: 100 - burned }),
    tone: tone(r.severity),
  };
}

export interface UsageState {
  snapshot?: UsageSnapshot;
  at?: number;
  error?: string;
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

export function usageBlocks(s: UsageState, now = Date.now()): SettingsBlock[] {
  const out: SettingsBlock[] = [];
  const snap = s.snapshot;
  if (!snap) {
    out.push({
      type: "text",
      text: s.error ? `Could not read usage: ${s.error}` : "Reading usage...",
      tone: s.error ? "warning" : "normal",
    });
  } else if (!snap.available) {
    out.push({
      type: "text",
      text: "Plan limits are not available for this login (an API key or other non-subscription sign-in).",
    });
  } else {
    out.push({
      type: "group",
      title: "Plan usage",
      blocks: [
        ...(snap.plan ? [{ type: "badge" as const, text: capitalize(snap.plan) }] : []),
        ...snap.rows.map((r) => usageMeter(r, now)),
      ],
    });
    if (s.error) out.push({ type: "text", text: `Could not refresh usage: ${s.error}`, tone: "warning" });
  }
  if (snap || s.error)
    out.push({
      type: "group",
      layout: "row",
      blocks: [
        ...(s.at === undefined ? [] : [{ type: "text" as const, text: `Updated ${clock(s.at)}` }]),
        { type: "button", label: "Refresh now", action: "refresh" },
      ],
    });
  return out;
}

export interface UsageService {
  view(): Promise<SettingsBlock[]>;
  refresh(force?: boolean): Promise<void>;
}

/** Reads plan usage from a short-lived idle `claude` child (about half a second, no model turn) and caches it. */
export function createUsage(
  ctx: PluginContext<ClaudeCodeConfig>,
  deps: SdkDeps,
  now = Date.now,
): UsageService {
  const state: UsageState = {};
  let failedAt: number | undefined;
  let inflight: Promise<void> | undefined;

  async function read(): Promise<UsageSnapshot> {
    const cfg = ctx.config ?? {};
    const q = deps.query({
      prompt: (async function* () {
        await new Promise<never>(() => {});
      })(),
      options: {
        cwd: tmpdir(),
        tools: [],
        settingSources: [],
        persistSession: false,
        env: claudeEnv(cfg),
        ...(cfg.pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable: cfg.pathToClaudeCodeExecutable }),
        stderr: (line) => ctx.log.debug("claude usage stderr", { line: line.trimEnd() }),
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out reading usage")), FETCH_TIMEOUT_MS);
      });
      const raw = await Promise.race([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }),
        timeout,
      ]);
      return parseUsage(raw);
    } finally {
      clearTimeout(timer);
      q.close();
    }
  }

  function refresh(force = false): Promise<void> {
    if (inflight) return inflight;
    const t = now();
    if (state.at !== undefined && t - state.at < (force ? MANUAL_GAP_MS : FRESH_MS)) return Promise.resolve();
    if (!force && failedAt !== undefined && t - failedAt < RETRY_MS) return Promise.resolve();
    inflight = read()
      .then((snapshot) => {
        state.snapshot = snapshot;
        state.at = now();
        delete state.error;
        failedAt = undefined;
      })
      .catch((error: unknown) => {
        state.error = error instanceof Error ? error.message : String(error);
        failedAt = now();
        ctx.log.warn("claude usage read failed", { error: state.error });
      })
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  return {
    refresh,
    async view() {
      const pending = refresh();
      if (!state.snapshot && !state.error) {
        let wait: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([pending, new Promise<void>((r) => (wait = setTimeout(r, FIRST_WAIT_MS)))]);
        clearTimeout(wait);
      }
      return usageBlocks(state, now());
    },
  };
}
