import { describe, expect, test } from "bun:test";
import { createUsage, parseUsage, usageBlocks, usageMeter, type UsageRow } from "../src/usage";
import { fakeSdk } from "./fake-sdk";
import { fakeCtx } from "./helpers";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const HOUR = 3_600_000;

/** The shape the SDK's usage call returns on a subscription login. */
const real = (over: Record<string, unknown> = {}) => ({
  subscription_type: "pro",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 56, resets_at: "2026-11-14T14:00:00+00:00" },
    seven_day: { utilization: 36, resets_at: "2026-11-15T22:00:00+00:00" },
    limits: [
      {
        kind: "session",
        group: "session",
        percent: 56,
        resets_at: "2026-11-14T14:00:00+00:00",
        severity: "normal",
        is_active: true,
        scope: null,
      },
      {
        kind: "weekly_all",
        group: "weekly",
        percent: 36,
        resets_at: "2026-11-15T22:00:00+00:00",
        severity: "warning",
        is_active: false,
        scope: null,
      },
      {
        kind: "weekly_scoped",
        group: "weekly",
        percent: 0,
        resets_at: "2026-11-15T22:00:00+00:00",
        severity: "normal",
        is_active: false,
        scope: { model: { display_name: "Fable", id: null }, surface: null },
      },
    ],
  },
  ...over,
});

describe("parseUsage", () => {
  test("reads the server's limit rows, with the scope's display name", () => {
    const s = parseUsage(real());
    expect(s.available).toBe(true);
    expect(s.plan).toBe("pro");
    expect(s.rows.map((r) => [r.kind, r.group, r.percent, r.scope])).toEqual([
      ["session", "session", 56, undefined],
      ["weekly_all", "weekly", 36, undefined],
      ["weekly_scoped", "weekly", 0, "Fable"],
    ]);
    expect(s.rows[0]?.resetsAt).toBe(Date.parse("2026-11-14T14:00:00Z"));
  });

  test("falls back to the fixed windows when the response has no limit rows", () => {
    const r = real();
    delete (r.rate_limits as Record<string, unknown>).limits;
    (r.rate_limits as Record<string, unknown>).model_scoped = [
      { display_name: "Opus", utilization: 10, resets_at: "2026-11-15T22:00:00+00:00" },
    ];
    expect(parseUsage(r).rows.map((x) => [x.kind, x.group, x.percent, x.scope])).toEqual([
      ["session", "session", 56, undefined],
      ["weekly_all", "weekly", 36, undefined],
      ["weekly_scoped", "weekly", 10, "Opus"],
    ]);
  });

  test("API-key logins and garbage are reported as unavailable, not as an error", () => {
    expect(parseUsage({ rate_limits_available: false, rate_limits: null }).available).toBe(false);
    expect(parseUsage(undefined)).toEqual({ available: false, rows: [] });
    expect(parseUsage("nope").available).toBe(false);
  });

  test("rows without a numeric percent are dropped and percents are clamped", () => {
    const s = parseUsage({
      rate_limits: {
        limits: [
          { kind: "a", group: "g", percent: "x" },
          { kind: "b", group: "g", percent: 250 },
        ],
      },
    });
    expect(s.rows.map((r) => r.percent)).toEqual([100]);
  });
});

describe("usageMeter", () => {
  const row = (over: Partial<UsageRow>): UsageRow => ({
    kind: "session",
    group: "session",
    percent: 56,
    severity: "normal",
    ...over,
  });

  test("session: 56% used with 2h of 5h left is on pace, marker at the even burn-down", () => {
    expect(usageMeter(row({ resetsAt: NOW + 2 * HOUR }), NOW)).toEqual({
      type: "meter",
      label: "Session",
      value: 44,
      display: "44% left",
      caption: "+56% in 2h",
      status: "On pace",
      marker: 40,
      tone: "normal",
    });
  });

  test("weekly: well under the even burn-down is under pace", () => {
    const m = usageMeter(
      row({ kind: "weekly_all", group: "weekly", percent: 36, resetsAt: NOW + 34 * HOUR }),
      NOW,
    );
    expect(m).toMatchObject({
      label: "Weekly",
      value: 64,
      display: "64% left",
      caption: "+36% in 1d 10h",
      status: "Under pace",
    });
    expect((m as { marker: number }).marker).toBeCloseTo(20.2, 1);
  });

  test("scoped rows are labelled with the model and an untouched one has no caption", () => {
    const m = usageMeter(
      row({ kind: "weekly_scoped", group: "weekly", percent: 0, scope: "Fable", resetsAt: NOW + 34 * HOUR }),
      NOW,
    );
    expect(m).toMatchObject({
      label: "Weekly · Fable",
      value: 100,
      display: "100% left",
      status: "Under pace",
    });
    expect(m).not.toHaveProperty("caption");
  });

  test("burning faster than the window is over pace", () => {
    expect(usageMeter(row({ percent: 90, resetsAt: NOW + 4 * HOUR }), NOW)).toMatchObject({
      status: "Over pace",
    });
  });

  test("a stale or unknown reset time drops the pace marker, status and caption", () => {
    for (const resetsAt of [NOW - HOUR, undefined]) {
      const m = usageMeter(row({ ...(resetsAt !== undefined && { resetsAt }) }), NOW);
      expect(m).not.toHaveProperty("marker");
      expect(m).not.toHaveProperty("status");
      expect(m).not.toHaveProperty("caption");
    }
  });

  test("unknown windows get no pace, and severity sets the tone", () => {
    const m = usageMeter(
      row({ kind: "x", group: "monthly", severity: "critical", resetsAt: NOW + HOUR }),
      NOW,
    );
    expect(m).toMatchObject({ label: "Monthly", tone: "critical" });
    expect(m).not.toHaveProperty("status");
  });
});

describe("usageBlocks", () => {
  test("lists the plan and one meter per row, then the update time and a refresh button", () => {
    const blocks = usageBlocks({ snapshot: parseUsage(real()), at: NOW }, NOW);
    expect(blocks).toHaveLength(2);
    const [usage, footer] = blocks as unknown as [
      { type: string; blocks: { type: string }[] },
      { layout: string; blocks: { type: string }[] },
    ];
    expect(usage.blocks.map((b) => b.type)).toEqual(["badge", "meter", "meter", "meter"]);
    expect(footer.layout).toBe("row");
    expect(footer.blocks.map((b) => b.type)).toEqual(["text", "button"]);
  });

  test("before the first reading, and when it failed", () => {
    expect(usageBlocks({}, NOW)).toEqual([{ type: "text", text: "Reading usage...", tone: "normal" }]);
    const failed = usageBlocks({ error: "boom" }, NOW);
    expect(failed[0]).toEqual({ type: "text", text: "Could not read usage: boom", tone: "warning" });
    expect(failed[1]).toMatchObject({ type: "group" });
  });

  test("a failed refresh keeps the last readings and says so", () => {
    const blocks = usageBlocks({ snapshot: parseUsage(real()), at: NOW, error: "boom" }, NOW);
    expect(blocks.map((b) => b.type)).toEqual(["group", "text", "group"]);
  });

  test("an unavailable plan says why and offers no meters", () => {
    const blocks = usageBlocks({ snapshot: parseUsage({ rate_limits_available: false }), at: NOW }, NOW);
    expect(blocks[0]).toMatchObject({ type: "text" });
    expect(JSON.stringify(blocks)).not.toContain('"meter"');
  });
});

describe("createUsage", () => {
  function setup(usage: () => unknown | Promise<unknown>) {
    const sdk = fakeSdk(async function* () {}, new Set(), usage);
    const { ctx, logs } = fakeCtx({}, sdk.deps);
    let t = NOW;
    const service = createUsage(ctx, sdk.deps, () => t);
    return {
      service,
      calls: sdk.calls,
      logs,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }
  const meters = (blocks: unknown) => JSON.stringify(blocks).match(/"type":"meter"/g)?.length ?? 0;

  test("reads once from an idle, tool-free child, closes it, and reuses the reading for a minute", async () => {
    const { service, calls, advance } = setup(() => real());
    expect(meters(await service.view())).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.closed).toBe(true);
    expect(calls[0]?.options).toMatchObject({ tools: [], settingSources: [], persistSession: false });
    expect(calls[0]?.methods).toEqual([{ name: "usage", args: [{ skipBehaviors: true }] }]);
    advance(59_000);
    await service.view();
    expect(calls).toHaveLength(1);
    advance(2_000);
    await service.view();
    expect(calls).toHaveLength(2);
  });

  test("concurrent views share one read", async () => {
    const { service, calls } = setup(() => real());
    await Promise.all([service.view(), service.view(), service.view()]);
    expect(calls).toHaveLength(1);
  });

  test("a manual refresh is throttled for ten seconds, then forces a read", async () => {
    const { service, calls, advance } = setup(() => real());
    await service.view();
    advance(5_000);
    await service.refresh(true);
    expect(calls).toHaveLength(1);
    advance(6_000);
    await service.refresh(true);
    expect(calls).toHaveLength(2);
  });

  test("a failed read is shown, logged and not retried on its own for five minutes", async () => {
    let fail = true;
    const { service, calls, logs, advance } = setup(() => {
      if (fail) throw new Error("not logged in");
      return real();
    });
    expect(await service.view()).toMatchObject([
      { text: "Could not read usage: not logged in", tone: "warning" },
      {},
    ]);
    expect(logs.some((l) => l.level === "warn" && l.msg === "claude usage read failed")).toBe(true);
    expect(calls[0]?.closed).toBe(true);
    advance(4 * 60_000);
    await service.view();
    expect(calls).toHaveLength(1);
    fail = false;
    advance(2 * 60_000);
    await service.view();
    await service.refresh();
    expect(meters(await service.view())).toBe(3);
    expect(calls).toHaveLength(2);
  });

  test("the refresh button's action forces a read even after a failure", async () => {
    let fail = true;
    const { service, calls, advance } = setup(() => {
      if (fail) throw new Error("x");
      return real();
    });
    await service.view();
    fail = false;
    advance(11_000);
    await service.refresh(true);
    expect(calls).toHaveLength(2);
    expect(meters(await service.view())).toBe(3);
  });
});
