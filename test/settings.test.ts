import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext, Setting, SettingsContribution } from "@valethq/sdk";
import type { ClaudeCodeConfig } from "../src/config";
import {
  disableClaudeAiConnectors,
  hideBuiltinTools,
  minRateLimitNoticePercent,
  permissionMode,
  registerSettings,
  strictMcpConfig,
  utilityModel,
} from "../src/settings";
import { fakeSdk } from "./fake-sdk";
import { fakeCtx } from "./helpers";

function ctxWith(config: ClaudeCodeConfig) {
  const { ctx } = fakeCtx(config, fakeSdk(async function* () {}).deps);
  return ctx as unknown as PluginContext<ClaudeCodeConfig>;
}

const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "manifest.json"), "utf8"));
const settings = (manifest.settings.sections.inference.subsections as { items: Setting[] }[]).flatMap(
  (s) => s.items,
);
const props = Object.fromEntries(settings.map((s) => [s.id, { default: s.input.default }]));

describe("settings are config", () => {
  test("accessors fall back to the same defaults the manifest declares", () => {
    const ctx = ctxWith({});
    expect(permissionMode(ctx)).toBe(props.permissionMode?.default as "acceptEdits");
    expect(disableClaudeAiConnectors(ctx)).toBe(props.disableClaudeAiConnectors?.default as boolean);
    expect(strictMcpConfig(ctx)).toBe(props.strictMcpConfig?.default as boolean);
    expect(hideBuiltinTools(ctx)).toBe(props.hideBuiltinTools?.default as boolean);
    expect(minRateLimitNoticePercent(ctx)).toBe((props.rateLimitNoticeAt?.default as number) * 100);
    expect(utilityModel(ctx)).toEqual(props.utilityModel?.default as { model: string });
  });

  test("config values win; an empty utility model turns side jobs off", () => {
    const ctx = ctxWith({
      permissionMode: "plan",
      hideBuiltinTools: true,
      strictMcpConfig: false,
      rateLimitNoticeAt: 0.5,
      utilityModel: { model: " ", effort: "low" },
    });
    expect(permissionMode(ctx)).toBe("plan");
    expect(hideBuiltinTools(ctx)).toBe(true);
    expect(strictMcpConfig(ctx)).toBe(false);
    expect(minRateLimitNoticePercent(ctx)).toBe(50);
    expect(utilityModel(ctx)).toBeUndefined();
  });

  test("the manifest no longer carries per-provider custom models", () => {
    expect(props.customModels).toBeUndefined();
  });

  test("v2 values migrate: utility suffixes split into model and effort, the percent becomes a share", () => {
    const utility = settings.find((s) => s.id === "utilityModel");
    const split = new RegExp(((utility?.migrate?.[0]?.map ?? {}) as { match: string }).match, "u");
    expect({ ...split.exec("claude-sonnet-5-5-xhigh")?.groups }).toEqual({
      model: "claude-sonnet-5-5",
      effort: "xhigh",
    });
    expect(split.exec("my-model")?.groups?.model).toBe("my-model");
    expect(split.exec("")?.groups?.model).toBe("");
    expect(settings.find((s) => s.id === "rateLimitNoticeAt")?.migrate).toEqual([
      { from: "minRateLimitNoticePercent", map: { scale: 0.01 } },
    ]);
  });
});

describe("settings@2 contribution", () => {
  test("model and effort options, built-in tools, and plan usage as a runtime subsection", async () => {
    const sdk = fakeSdk(
      async function* () {},
      new Set(),
      () => ({
        subscription_type: "max",
        rate_limits_available: true,
        rate_limits: { limits: [{ kind: "session", group: "session", percent: 10, severity: "normal" }] },
      }),
    );
    const { ctx } = fakeCtx({}, sdk.deps);
    let contribution: SettingsContribution | undefined;
    registerSettings(
      {
        ...ctx,
        config: ctx.config,
        onConfigChange() {},
        scopes: {
          define() {},
          provide(_s: string, impl: SettingsContribution) {
            contribution = impl;
            return { dispose() {} };
          },
        },
      } as unknown as PluginContext<ClaudeCodeConfig>,
      sdk.deps,
    );
    const models = (await contribution?.options?.models?.({})) ?? [];
    expect(models.map((m) => m.value)).toContain("claude-haiku-5-5");
    expect(await contribution?.options?.efforts?.({ model: "claude-haiku-5-5" })).toEqual(
      ["low", "medium", "high", "xhigh", "max"].map((value) => ({ value })),
    );
    expect(await contribution?.options?.efforts?.({ model: "nope" })).toEqual([]);
    expect((await contribution?.options?.builtinTools?.({}))?.map((o) => o.value)).toContain("Bash");
    const [usage] = (await contribution?.subsections?.()) ?? [];
    expect(usage?.id).toBe("usage");
    expect(usage?.refreshMs).toBe(15_000);
    expect(JSON.stringify(usage?.items)).toContain('"label":"Session"');
    await contribution?.actions?.refresh?.({});
  });
});
