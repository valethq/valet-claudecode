import { describe, expect, test } from "bun:test";
import type { PluginContext } from "@valethq/sdk";
import type { ClaudeCodeConfig } from "../src/config";
import {
  disableClaudeAiConnectors,
  registerSettings,
  type SettingsPanel,
  strictMcpConfig,
} from "../src/settings";
import { fakeCtx } from "./helpers";
import { fakeSdk } from "./fake-sdk";

function ctxWith(config: ClaudeCodeConfig) {
  const { ctx } = fakeCtx(config, fakeSdk(async function* () {}).deps);
  return ctx as unknown as PluginContext<ClaudeCodeConfig>;
}

function panelOf(ctx: PluginContext<ClaudeCodeConfig>): SettingsPanel {
  let panel: SettingsPanel | undefined;
  const scoped = {
    ...ctx,
    scopes: {
      define() {},
      provide(_scope: string, impl: SettingsPanel) {
        panel = impl;
        return { dispose() {} };
      },
    },
  } as unknown as PluginContext<ClaudeCodeConfig>;
  registerSettings(scoped);
  if (!panel) throw new Error("no panel");
  return panel;
}

describe("connector and MCP flags", () => {
  test("both default to on: valet's tools only", () => {
    const ctx = ctxWith({});
    expect(disableClaudeAiConnectors(ctx)).toBe(true);
    expect(strictMcpConfig(ctx)).toBe(true);
  });

  test("config.json turns them off", () => {
    const ctx = ctxWith({ disableClaudeAiConnectors: false, strictMcpConfig: false });
    expect(disableClaudeAiConnectors(ctx)).toBe(false);
    expect(strictMcpConfig(ctx)).toBe(false);
  });

  test("the settings panel overrides config and shows both in its schema", async () => {
    const ctx = ctxWith({ disableClaudeAiConnectors: true });
    const panel = panelOf(ctx);
    const props = panel.schema.properties as Record<string, { type: string }>;
    expect(props.disableClaudeAiConnectors?.type).toBe("boolean");
    expect(props.strictMcpConfig?.type).toBe("boolean");
    await panel.set({ disableClaudeAiConnectors: false });
    expect(disableClaudeAiConnectors(ctx)).toBe(false);
    expect(await panel.get()).toMatchObject({ disableClaudeAiConnectors: false, strictMcpConfig: true });
  });

  test("the panel rejects non-boolean values", () => {
    const panel = panelOf(ctxWith({}));
    expect(() => panel.set({ strictMcpConfig: "yes" })).toThrow("strictMcpConfig must be true or false");
  });
});
