import { tmpdir } from "node:os";
import type { PluginContext, UtilityModel } from "@valethq/sdk";
import { claudeEnv } from "./cache";
import type { ClaudeCodeConfig } from "./config";
import type { SdkDeps } from "./sdk";
import { utilityModel } from "./settings";

/** Side jobs are one tool-free turn with no thinking, no settings files and no transcript on disk. */
export function createUtility(ctx: PluginContext<ClaudeCodeConfig>, deps: SdkDeps): UtilityModel {
  return {
    model: () => utilityModel(ctx)?.model,
    async complete(req, signal) {
      const picked = utilityModel(ctx);
      if (!picked) throw new Error("no utility model is configured");
      const { model, effort } = picked;
      const cfg = ctx.config ?? {};
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      if (signal.aborted) abort();
      signal.addEventListener("abort", abort, { once: true });
      const query = deps.query({
        prompt: req.prompt,
        options: {
          cwd: tmpdir(),
          model,
          ...(effort && { effort }),
          systemPrompt: req.system,
          tools: [],
          maxTurns: 1,
          thinking: { type: "disabled" },
          settingSources: [],
          persistSession: false,
          abortController,
          env: claudeEnv(cfg),
          ...(cfg.pathToClaudeCodeExecutable && {
            pathToClaudeCodeExecutable: cfg.pathToClaudeCodeExecutable,
          }),
          stderr: (line) => ctx.log.debug("claude utility stderr", { line: line.trimEnd() }),
        },
      });
      try {
        for await (const m of query) {
          if (m.type !== "result") continue;
          if (m.subtype === "success" && !m.is_error) return m.result.trim();
          const detail = "errors" in m && m.errors.length ? m.errors.join("; ") : "";
          throw new Error(detail || `claude code stopped: ${m.terminal_reason ?? m.subtype}`);
        }
        throw new Error("claude code returned no result");
      } finally {
        signal.removeEventListener("abort", abort);
        query.close();
      }
    },
  };
}
