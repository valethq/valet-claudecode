import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const userSettingsPath = (base: Record<string, string | undefined> = process.env): string =>
  join(base.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json");

/** The string entries of `env` in a Claude Code settings file. A missing or malformed file gives none. */
export function readSettingsEnv(path: string): Record<string, string> {
  try {
    const env = JSON.parse(readFileSync(path, "utf8"))?.env;
    if (typeof env !== "object" || env === null) return {};
    return Object.fromEntries(Object.entries(env).filter(([, v]) => typeof v === "string")) as Record<
      string,
      string
    >;
  } catch {
    return {};
  }
}
