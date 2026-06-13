import {
  query,
  type Options as ClaudeAgentSdkOptions,
  type Query as ClaudeAgentSdkQuery,
  type SDKMessage as ClaudeAgentSdkMessage,
  type SDKUserMessage as ClaudeAgentSdkUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

export type {
  ClaudeAgentSdkMessage,
  ClaudeAgentSdkOptions,
  ClaudeAgentSdkQuery,
  ClaudeAgentSdkUserMessage,
};

export interface ClaudeAgentSdkQueryParams {
  readonly prompt: string | AsyncIterable<ClaudeAgentSdkUserMessage>;
  readonly options?: ClaudeAgentSdkOptions;
}

export interface ClaudeAgentSdkClient {
  createQuery(params: ClaudeAgentSdkQueryParams): ClaudeAgentSdkQuery;
}

export class AnthropicClaudeAgentSdkClient implements ClaudeAgentSdkClient {
  createQuery(params: ClaudeAgentSdkQueryParams): ClaudeAgentSdkQuery {
    return query(params);
  }
}
