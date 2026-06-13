import type {
  AgentInfo,
  Message,
} from '@microsoft/agent-host-protocol';

import type {
  AgentProvider,
  AgentSession,
  AgentSessionContext,
  ActiveClientTools,
  AgentTurnSink,
  ProviderResumeState,
  ResumableAgentProvider,
  ResumableAgentSessionContext,
} from '@wyrd-company/ahp-provider-kit';
import { ActiveClientToolsMcpBridge } from './active-client-tools-mcp-bridge.js';
import {
  MarkdownTurnEmitter,
  resolveModelId,
  singleModelAgentInfo,
  uriToPath,
} from '@wyrd-company/ahp-provider-kit';
import {
  AnthropicClaudeAgentSdkClient,
  type ClaudeAgentSdkClient,
  type ClaudeAgentSdkMessage,
  type ClaudeAgentSdkOptions,
  type ClaudeAgentSdkQuery,
  type ClaudeAgentSdkUserMessage,
} from './client.js';

export interface ClaudeAgentSdkProviderOptions {
  readonly client?: ClaudeAgentSdkClient;
  readonly clientFactory?: () => ClaudeAgentSdkClient;
  readonly providerId?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly defaultModel?: string;
  readonly pathToClaudeCodeExecutable?: string;
  readonly permissionMode?: ClaudeAgentSdkOptions['permissionMode'];
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly tools?: ClaudeAgentSdkOptions['tools'];
  readonly mcpServers?: ClaudeAgentSdkOptions['mcpServers'];
  readonly env?: ClaudeAgentSdkOptions['env'];
}

export function createClaudeAgentSdkProvider(options: ClaudeAgentSdkProviderOptions = {}): ResumableAgentProvider {
  const providerId = options.providerId ?? 'claude-agent-sdk';
  const defaultModel = options.defaultModel ?? 'default';
  const agent: AgentInfo = singleModelAgentInfo({
    providerId,
    displayName: options.displayName ?? 'Claude Agent SDK',
    description: options.description ?? 'Claude Agent SDK adapter',
    defaultModel,
  });

  function createRuntimeSession(context: AgentSessionContext | ResumableAgentSessionContext): AgentSession {
    const client = options.client ?? options.clientFactory?.() ?? new AnthropicClaudeAgentSdkClient();
    const cwd = context.workingDirectory ? uriToPath(context.workingDirectory) : process.cwd();
    const resumeState = resumeStateFromContext(context);
    const activeClientToolsMcpBridge = new ActiveClientToolsMcpBridge({
      name: `${providerId}-active-client-tools`,
      sink: context.activeClientToolSink,
    });
    activeClientToolsMcpBridge.setActiveClientTools(context.activeClientTools);
    return new ClaudeAgentSdkAHPAgentSession(client, {
      cwd,
      model: resolveModelId(context.model, options.defaultModel),
      pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable,
      permissionMode: options.permissionMode ?? 'dontAsk',
      allowedTools: options.allowedTools,
      disallowedTools: options.disallowedTools,
      tools: options.tools,
      mcpServers: options.mcpServers,
      env: options.env,
      activeClientToolsMcpBridge,
      sessionId: resumeState.sessionId,
    });
  }

  return {
    agent,
    createSession(context: AgentSessionContext): AgentSession {
      return createRuntimeSession(context);
    },
    resumeSession(context: ResumableAgentSessionContext): AgentSession {
      return createRuntimeSession(context);
    },
  };
}

interface ClaudeAgentSdkResumeState extends ProviderResumeState {
  readonly sessionId?: string;
}

interface ClaudeAgentSdkSessionOptions {
  readonly cwd: string;
  readonly model?: string;
  readonly pathToClaudeCodeExecutable?: string;
  readonly permissionMode: ClaudeAgentSdkOptions['permissionMode'];
  readonly allowedTools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly tools?: ClaudeAgentSdkOptions['tools'];
  readonly mcpServers?: ClaudeAgentSdkOptions['mcpServers'];
  readonly env?: ClaudeAgentSdkOptions['env'];
  readonly activeClientToolsMcpBridge: ActiveClientToolsMcpBridge;
  readonly sessionId?: string;
}

class ClaudeAgentSdkAHPAgentSession implements AgentSession {
  private readonly input = new AsyncQueue<ClaudeAgentSdkUserMessage>();
  private readonly abortController = new AbortController();
  private query?: ClaudeAgentSdkQuery;
  private iterator?: AsyncIterator<ClaudeAgentSdkMessage>;
  private sessionId?: string;

  constructor(
    private readonly client: ClaudeAgentSdkClient,
    private readonly options: ClaudeAgentSdkSessionOptions,
  ) {
    this.sessionId = options.sessionId;
  }

  async sendUserMessage(message: Message, sink: AgentTurnSink, signal: AbortSignal, turnId?: string): Promise<void> {
    const ahpTurnId = turnId ?? `turn-${Date.now()}`;
    const markdown = new MarkdownTurnEmitter(sink, ahpTurnId);
    const query = await this.ensureQuery();
    let emittedStreamingDelta = false;
    let emittedAnyText = false;

    const emitDelta = (content: string): void => {
      if (!content) {
        return;
      }
      emittedAnyText = true;
      markdown.emitDelta(content);
    };

    const interrupt = (): void => {
      void query.interrupt().catch(() => undefined);
    };
    signal.addEventListener('abort', interrupt, { once: true });
    this.options.activeClientToolsMcpBridge.setCurrentTurn(ahpTurnId);

    try {
      this.input.push(userMessage(message.text));
      while (true) {
        if (signal.aborted) {
          return;
        }
        const next = await this.nextMessage(signal);
        if (next.done) {
          throw new Error('Claude Agent SDK query ended before the turn completed');
        }

        const sdkMessage = next.value;
        this.captureSessionId(sdkMessage);
        if (sdkMessage.type === 'stream_event') {
          const delta = streamEventTextDelta(sdkMessage.event);
          if (delta) {
            emittedStreamingDelta = true;
            emitDelta(delta);
          }
          continue;
        }

        if (sdkMessage.type === 'assistant') {
          if (sdkMessage.error) {
            throw new Error(`Claude Agent SDK assistant error: ${sdkMessage.error}`);
          }
          if (!emittedStreamingDelta) {
            for (const text of assistantText(sdkMessage)) {
              emitDelta(text);
            }
          }
          continue;
        }

        if (sdkMessage.type === 'result') {
          if (sdkMessage.subtype !== 'success') {
            const errors = 'errors' in sdkMessage ? sdkMessage.errors.join('; ') : '';
            throw new Error(errors || `Claude Agent SDK result error: ${sdkMessage.subtype}`);
          }
          if (!emittedAnyText && sdkMessage.result) {
            emitDelta(sdkMessage.result);
          }
          markdown.complete();
          return;
        }
      }
    } finally {
      this.options.activeClientToolsMcpBridge.setCurrentTurn(undefined);
      signal.removeEventListener('abort', interrupt);
    }
  }

  setActiveClientTools(activeClientTools: ActiveClientTools | undefined): void {
    this.options.activeClientToolsMcpBridge.setActiveClientTools(activeClientTools);
  }

  getResumeState(): ClaudeAgentSdkResumeState | undefined {
    return this.sessionId ? { sessionId: this.sessionId } : undefined;
  }

  async cancel(): Promise<void> {
    await this.query?.interrupt().catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.input.close();
    this.abortController.abort();
    this.query?.close();
    await this.options.activeClientToolsMcpBridge.close();
  }

  private async ensureQuery(): Promise<ClaudeAgentSdkQuery> {
    if (this.query) {
      return this.query;
    }

    await this.options.activeClientToolsMcpBridge.start();
    const activeClientToolsMcpServer = {
      type: 'http',
      url: this.options.activeClientToolsMcpBridge.url,
      alwaysLoad: true,
    } as const;

    this.query = this.client.createQuery({
      prompt: this.input,
      options: {
        abortController: this.abortController,
        cwd: this.options.cwd,
        ...(this.options.model ? { model: this.options.model } : {}),
        ...(this.options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable } : {}),
        permissionMode: this.options.permissionMode,
        ...(this.options.allowedTools ? { allowedTools: [...this.options.allowedTools] } : {}),
        ...(this.options.disallowedTools ? { disallowedTools: [...this.options.disallowedTools] } : {}),
        ...(this.options.tools ? { tools: this.options.tools } : {}),
        mcpServers: {
          ...(this.options.mcpServers ?? {}),
          activeClientTools: activeClientToolsMcpServer,
        },
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.sessionId ? { resume: this.options.sessionId } : {}),
        includePartialMessages: true,
      },
    });
    this.iterator = this.query[Symbol.asyncIterator]();
    return this.query;
  }

  private async nextMessage(signal: AbortSignal): Promise<IteratorResult<ClaudeAgentSdkMessage>> {
    if (!this.iterator) {
      throw new Error('Claude Agent SDK query was not initialized');
    }
    return Promise.race([
      this.iterator.next(),
      new Promise<IteratorResult<ClaudeAgentSdkMessage>>(resolve => {
        if (signal.aborted) {
          resolve({ done: true, value: undefined });
          return;
        }
        signal.addEventListener(
          'abort',
          () => resolve({ done: true, value: undefined }),
          { once: true },
        );
      }),
    ]);
  }

  private captureSessionId(message: ClaudeAgentSdkMessage): void {
    const sessionId = sessionIdFromMessage(message);
    if (sessionId) {
      this.sessionId = sessionId;
    }
  }
}

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly readers: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      throw new Error('cannot push to a closed queue');
    }
    const reader = this.readers.shift();
    if (reader) {
      reader({ done: false, value });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const reader of this.readers.splice(0)) {
      reader({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async (): Promise<IteratorResult<T>> => {
        const value = this.values.shift();
        if (value) {
          return { done: false, value };
        }
        if (this.closed) {
          return { done: true, value: undefined };
        }
        return new Promise<IteratorResult<T>>(resolve => {
          this.readers.push(resolve);
        });
      },
    };
  }
}

function userMessage(text: string): ClaudeAgentSdkUserMessage {
  return {
    type: 'user',
    message: {
      role: 'user',
      content: text,
    } as ClaudeAgentSdkUserMessage['message'],
    parent_tool_use_id: null,
  };
}

function assistantText(message: Extract<ClaudeAgentSdkMessage, { type: 'assistant' }>): string[] {
  const content = message.message.content as unknown;
  if (!Array.isArray(content)) {
    return [];
  }
  const chunks: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') {
      chunks.push(block.text);
    }
  }
  return chunks;
}

function streamEventTextDelta(event: unknown): string | undefined {
  if (!isRecord(event) || event.type !== 'content_block_delta' || !isRecord(event.delta)) {
    return undefined;
  }
  const delta = event.delta;
  return delta.type === 'text_delta' && typeof delta.text === 'string' ? delta.text : undefined;
}

function resumeStateFromContext(context: AgentSessionContext | ResumableAgentSessionContext): ClaudeAgentSdkResumeState {
  if (!('resumeState' in context) || !context.resumeState) {
    return {};
  }
  return typeof context.resumeState.sessionId === 'string'
    ? { sessionId: context.resumeState.sessionId }
    : {};
}

function sessionIdFromMessage(message: ClaudeAgentSdkMessage): string | undefined {
  const candidate = message as unknown as { session_id?: unknown };
  return typeof candidate.session_id === 'string' ? candidate.session_id : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
