import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext, SettingsPanel } from "@valethq/sdk";
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
const props = manifest.configSchema.properties as Record<string, { default?: unknown }>;

describe("settings are config", () => {
  test("accessors fall back to the same defaults the manifest declares", () => {
    const ctx = ctxWith({});
    expect(permissionMode(ctx)).toBe(props.permissionMode?.default as "acceptEdits");
    expect(disableClaudeAiConnectors(ctx)).toBe(props.disableClaudeAiConnectors?.default as boolean);
    expect(strictMcpConfig(ctx)).toBe(props.strictMcpConfig?.default as boolean);
    expect(hideBuiltinTools(ctx)).toBe(props.hideBuiltinTools?.default as boolean);
    expect(minRateLimitNoticePercent(ctx)).toBe(props.minRateLimitNoticePercent?.default as number);
    expect(utilityModel(ctx)).toBe(props.utilityModel?.default as string);
  });

  test("config values win; an empty utility model turns side jobs off", () => {
    const ctx = ctxWith({
      permissionMode: "plan",
      hideBuiltinTools: true,
      strictMcpConfig: false,
      minRateLimitNoticePercent: 50,
      utilityModel: " ",
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
});

describe("usage on the settings page", () => {
  test("a view-only panel: plan usage, refreshed on a timer, with a refresh action", async () => {
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
    let panel: SettingsPanel | undefined;
    registerSettings(
      {
        ...ctx,
        onConfigChange() {},
        scopes: {
          define() {},
          provide(_s: string, impl: SettingsPanel) {
            panel = impl;
            return { dispose() {} };
          },
        },
      } as unknown as PluginContext<ClaudeCodeConfig>,
      sdk.deps,
    );
    expect(panel?.schema).toBeUndefined();
    expect(panel?.refreshMs).toBe(15_000);
    const blocks = (await panel?.view?.()) ?? [];
    expect(JSON.stringify(blocks)).toContain('"label":"Session"');
    await panel?.actions?.refresh?.({});
  });
});
