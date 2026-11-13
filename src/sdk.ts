import { getSessionInfo, query } from "@anthropic-ai/claude-agent-sdk";

export interface SdkDeps {
  query: typeof query;
  getSessionInfo: typeof getSessionInfo;
}

export const realSdk: SdkDeps = { query, getSessionInfo };
