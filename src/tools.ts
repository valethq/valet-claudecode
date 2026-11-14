/** Claude Code lists the Agent tool as "Task" in `system/init` and sends it to the API as "Agent". */
const canonical = (name: string): string => (name === "Task" ? "Agent" : name);

/**
 * Tools in `deny` that Claude Code's `system/init` message still lists. `disallowedTools` is meant to remove
 * them from the model's context, so a hit means the deny did not apply. Rule patterns such as "Bash(rm *)"
 * match calls, not names, and are skipped.
 */
export function leakedTools(available: readonly string[], deny: readonly string[] | undefined): string[] {
  const plain = new Set((deny ?? []).filter((d) => !d.includes("(")).map(canonical));
  return available.filter((t) => plain.has(canonical(t)));
}
