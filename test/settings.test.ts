import { describe, expect, test } from "bun:test";
import type { PluginContext, SettingsPanel } from "@valethq/sdk";
import type { ClaudeCodeConfig } from "../src/config";
import {
  disableClaudeAiConnectors,
  hideBuiltinTools,
  registerSettings,
  strictMcpConfig,
} from "../src/settings";
import { fakeCtx } from "./helpers";
import { fakeSdk } from "./fake-sdk";

function ctxWith(config: ClaudeCodeConfig) {
  const { ctx } = fakeCtx(config, fakeSdk(async function* () {}).deps);
  return ctx as unknown as PluginContext<ClaudeCodeConfig>;
}

/** The panel has a form, so get and set are present. */
type FormPanel = SettingsPanel & Required<Pick<SettingsPanel, "schema" | "get" | "set">>;

function panelOf(ctx: PluginContext<ClaudeCodeConfig>): FormPanel {
  let panel: FormPanel | undefined;
  const scoped = {
    ...ctx,
    scopes: {
      define() {},
      provide(_scope: string, impl: SettingsPanel) {
        panel = impl as FormPanel;
        return { dispose() {} };
      },
    },
  } as unknown as PluginContext<ClaudeCodeConfig>;
  registerSettings(scoped, fakeSdk(async function* () {}).deps);
  if (!panel) throw new Error("no panel");
  return panel;
}

describe("connector and MCP flags", () => {
  test("connectors and extra MCP servers default to hidden; built-in tools default to shown", () => {
    const ctx = ctxWith({});
    expect(disableClaudeAiConnectors(ctx)).toBe(true);
    expect(strictMcpConfig(ctx)).toBe(true);
    expect(hideBuiltinTools(ctx)).toBe(false);
  });

  test("hideBuiltinTools comes from config.json and the panel overrides it", async () => {
    const ctx = ctxWith({ hideBuiltinTools: true });
    expect(hideBuiltinTools(ctx)).toBe(true);
    const panel = panelOf(ctx);
    const props = panel.schema.properties as Record<string, { type: string }>;
    expect(props.hideBuiltinTools?.type).toBe("boolean");
    await panel.set({ hideBuiltinTools: false });
    expect(hideBuiltinTools(ctx)).toBe(false);
    expect(await panel.get()).toMatchObject({ hideBuiltinTools: false });
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

describe("usage on the settings panel", () => {
  test("shows plan usage above the form, refreshes on a timer, and has a refresh action", async () => {
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
    let panel: FormPanel | undefined;
    registerSettings(
      {
        ...ctx,
        scopes: {
          define() {},
          provide(_s: string, impl: FormPanel) {
            panel = impl;
            return { dispose() {} };
          },
        },
      } as unknown as PluginContext<ClaudeCodeConfig>,
      sdk.deps,
    );
    expect(panel?.refreshMs).toBe(15_000);
    const blocks = (await panel?.view?.()) ?? [];
    expect(JSON.stringify(blocks)).toContain('"label":"Session"');
    await panel?.actions?.refresh?.({});
    expect(typeof panel?.actions?.refresh).toBe("function");
  });
});
