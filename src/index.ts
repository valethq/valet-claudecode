import { definePlugin } from "@valethq/sdk";
import type { ClaudeCodeConfig } from "./config";
import { createProvider, PROVIDER_KEY } from "./provider";
import { realSdk } from "./sdk";
import { registerSettings } from "./settings";

export default definePlugin<ClaudeCodeConfig>({
  activate(ctx) {
    const { provider, dispose } = createProvider(ctx);
    ctx.onDispose(dispose);
    ctx.scopes.provide("inference", provider, { key: PROVIDER_KEY });
    registerSettings(ctx, realSdk);
  },
});
