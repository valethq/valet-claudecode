import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Streaming-input side of a long-lived Query. The Query iterates this for the life of the child
 * process, and each valet turn pushes one user message.
 */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private wake?: () => void;
  private closed = false;

  push(m: SDKUserMessage): void {
    this.items.push(m);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: async () => {
        while (!this.items.length) {
          if (this.closed) return { value: undefined, done: true };
          await new Promise<void>((r) => {
            this.wake = r;
          });
        }
        return { value: this.items.shift() as SDKUserMessage, done: false };
      },
      return: async () => {
        this.close();
        return { value: undefined, done: true };
      },
    };
  }
}
