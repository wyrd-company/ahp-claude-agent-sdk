import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction, ToolDefinition } from '@microsoft/agent-host-protocol';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  AhpServer,
  FileSystemSessionStore,
  createInMemoryTransportPair,
} from '@wyrd-company/ahp-server';
import {
  createClaudeAgentSdkProvider,
  type ClaudeAgentSdkClient,
  type ClaudeAgentSdkMessage,
  type ClaudeAgentSdkQuery,
  type ClaudeAgentSdkQueryParams,
  type ClaudeAgentSdkUserMessage,
} from '../src/index.js';

const runningServers: Array<Promise<void>> = [];

after(async () => {
  await Promise.allSettled(runningServers);
});

test('Claude Agent SDK provider streams SDK messages as AHP actions', async () => {
  const claude = new FakeClaudeAgentSdkClient([
    streamDelta('Claude '),
    streamDelta('says hello'),
    resultSuccess(),
  ]);
  const server = new AhpServer({
    providers: [createClaudeAgentSdkProvider({ client: claude, defaultModel: 'claude-test' })],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'test-client', protocolVersions: ['0.3.0'] });

  const sessionUri = 'ahp-session:/claude-session';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'claude-agent-sdk',
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'ahp-turn-1',
    message: userMessage('Hello Claude'),
  } as StateAction);

  const actions = await collectUntilTerminal(subscription);
  const types = actions.map(action => String(action.type));
  assert.deepEqual(claude.prompts, ['Hello Claude']);
  assert.equal(claude.options[0]?.model, 'claude-test');
  assert.ok(types.includes('session/responsePart'), `expected response part, saw: ${JSON.stringify(actions)}`);
  assert.ok(types.includes('session/delta'), `expected delta, saw: ${JSON.stringify(actions)}`);
  assert.ok(types.includes('session/turnComplete'), `expected turn completion, saw: ${JSON.stringify(actions)}`);
  assert.equal(
    actions
      .filter((action): action is StateAction & { content: string } => action.type === 'session/delta')
      .map(action => action.content)
      .join(''),
    'Claude says hello',
  );

  await client.request('disposeSession', { channel: sessionUri });
  await client.shutdown();
});

test('Claude Agent SDK provider exposes active-client tools through Streamable HTTP MCP', async () => {
  const releaseClaudeResult = deferred<void>();
  const claude = new FakeClaudeAgentSdkClient([resultSuccess()], releaseClaudeResult.promise);
  const server = new AhpServer({
    providers: [createClaudeAgentSdkProvider({ client: claude, defaultModel: 'claude-test' })],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));

  const client = new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
  client.connect();
  await client.initialize({ clientId: 'owner-client', protocolVersions: ['0.3.0'] });

  const tool = toolDefinition('searchWorkspace', 'Search Workspace');
  const sessionUri = 'ahp-session:/claude-active-client-tools';
  await client.request('createSession', {
    channel: sessionUri,
    provider: 'claude-agent-sdk',
    activeClient: {
      clientId: 'owner-client',
      displayName: 'Owner Client',
      tools: [tool],
    },
  });
  const { subscription } = await client.subscribe(sessionUri);

  client.dispatch(sessionUri, {
    type: 'session/turnStarted',
    turnId: 'ahp-turn-tools',
    message: userMessage('Use the MCP client tool'),
  } as StateAction);

  await waitFor(() => claude.options.length === 1 && claude.prompts.length === 1);
  const mcpServerConfig = claude.options[0]?.mcpServers?.activeClientTools;
  assert.equal(mcpServerConfig?.type, 'http');
  assert.ok(mcpServerConfig.url);

  const mcpClient = new McpClient({ name: 'ahp-server-test', version: '0.1.0' });
  const mcpTransport = new StreamableHTTPClientTransport(new URL(mcpServerConfig.url));
  await mcpClient.connect(mcpTransport);

  const tools = await mcpClient.listTools();
  assert.deepEqual(tools.tools.map(candidate => candidate.name), ['searchWorkspace']);
  assert.deepEqual(tools.tools[0]?.inputSchema, tool.inputSchema);

  const call = mcpClient.callTool({
    name: 'searchWorkspace',
    arguments: {
      sessionUri: 'ahp-session:/forged',
      turnId: 'forged-turn',
      query: 'needle',
    },
  });

  const toolActions = await collectUntilAction(subscription, action => action.type === 'session/toolCallReady');
  const toolStart = toolActions.find(action => action.type === 'session/toolCallStart');
  assert.ok(toolStart);
  assert.equal(toolStart.turnId, 'ahp-turn-tools');
  assert.equal(toolStart.toolName, 'searchWorkspace');
  assert.deepEqual(toolStart.contributor, {
    kind: 'client',
    clientId: 'owner-client',
  });

  const toolReady = toolActions.at(-1);
  assert.equal(toolReady?.type, 'session/toolCallReady');
  assert.equal(toolReady.turnId, 'ahp-turn-tools');
  assert.match(String(toolReady.toolInput), /forged-turn/);
  assert.match(String(toolReady.toolInput), /needle/);

  client.dispatch(sessionUri, {
    type: 'session/toolCallComplete',
    turnId: 'ahp-turn-tools',
    toolCallId: toolReady.toolCallId,
    result: {
      success: true,
      pastTenseMessage: 'Searched workspace',
      content: [{ type: 'text', text: 'found needle' }],
    },
  } as StateAction);

  const result = await call;
  assert.equal(result.isError, false);
  assert.deepEqual(result.content, [{ type: 'text', text: 'found needle' }]);

  releaseClaudeResult.resolve();
  await collectUntilTerminal(subscription);
  await mcpClient.close();
  await client.request('disposeSession', { channel: sessionUri });
  await client.shutdown();
});

test('Claude Agent SDK provider resumes a persisted AHP session by recreating its SDK query session', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ahp-claude-resume-'));
  const firstClaude = new FakeClaudeAgentSdkClient([resultSuccess()]);
  const secondClaude = new FakeClaudeAgentSdkClient([
    streamDelta('Resumed '),
    streamDelta('Claude'),
    resultSuccess(),
  ]);
  const sessionUri = 'ahp-session:/claude-resume';

  try {
    const firstServer = new AhpServer({
      providers: [createClaudeAgentSdkProvider({ client: firstClaude, defaultModel: 'claude-test' })],
      store: new FileSystemSessionStore({ directory }),
    });
    const firstClient = createClient(firstServer);
    firstClient.connect();
    await firstClient.initialize({ clientId: 'claude-client', protocolVersions: ['0.3.0'] });
    await firstClient.request('createSession', {
      channel: sessionUri,
      provider: 'claude-agent-sdk',
      workingDirectory: 'file:///workspaces/project-a',
      model: { id: 'claude-test' },
    });
    await firstClient.shutdown();

    const secondServer = new AhpServer({
      providers: [createClaudeAgentSdkProvider({ client: secondClaude, defaultModel: 'claude-test' })],
      store: new FileSystemSessionStore({ directory }),
    });
    const secondClient = createClient(secondServer);
    secondClient.connect();

    const reconnect = await secondClient.reconnect({
      clientId: 'claude-client',
      lastSeenServerSeq: 0,
      subscriptions: [sessionUri],
    });
    assert.equal(reconnect.type, 'snapshot');
    assert.equal(secondClaude.options.length, 0);

    const subscription = secondClient.attachSubscription(sessionUri);
    secondClient.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'resume-turn',
      message: userMessage('Continue after reconnect'),
    } as StateAction);

    const actions = await collectUntilTerminal(subscription);
    assert.equal(secondClaude.prompts[0], 'Continue after reconnect');
    assert.equal(secondClaude.options[0]?.cwd, '/workspaces/project-a');
    assert.equal(secondClaude.options[0]?.model, 'claude-test');
    assert.equal(actions.at(-1)?.type, 'session/turnComplete');

    await secondClient.request('disposeSession', { channel: sessionUri });
    await secondClient.shutdown();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

class FakeClaudeAgentSdkClient implements ClaudeAgentSdkClient {
  readonly prompts: string[] = [];
  readonly options: Array<ClaudeAgentSdkQueryParams['options']> = [];

  constructor(
    private readonly messages: readonly ClaudeAgentSdkMessage[],
    private readonly beforeMessages: Promise<void> = Promise.resolve(),
  ) {}

  createQuery(params: ClaudeAgentSdkQueryParams): ClaudeAgentSdkQuery {
    this.options.push(params.options);
    return new FakeClaudeAgentSdkQuery(params.prompt, this.messages, this.prompts, this.beforeMessages);
  }
}

class FakeClaudeAgentSdkQuery implements AsyncGenerator<ClaudeAgentSdkMessage, void>, ClaudeAgentSdkQuery {
  private readonly iterator: AsyncIterator<ClaudeAgentSdkMessage>;

  constructor(
    prompt: string | AsyncIterable<ClaudeAgentSdkUserMessage>,
    messages: readonly ClaudeAgentSdkMessage[],
    prompts: string[],
    beforeMessages: Promise<void>,
  ) {
    this.iterator = this.run(prompt, messages, prompts, beforeMessages);
  }

  [Symbol.asyncIterator](): AsyncGenerator<ClaudeAgentSdkMessage, void> {
    return this;
  }

  next(...args: [] | [undefined]): Promise<IteratorResult<ClaudeAgentSdkMessage, void>> {
    return this.iterator.next(...args);
  }

  return(value?: void): Promise<IteratorResult<ClaudeAgentSdkMessage, void>> {
    return Promise.resolve({ done: true, value });
  }

  throw(error?: unknown): Promise<IteratorResult<ClaudeAgentSdkMessage, void>> {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  async interrupt(): Promise<void> {}

  close(): void {}

  async setPermissionMode(): Promise<void> {}
  async setModel(): Promise<void> {}
  async setMaxThinkingTokens(): Promise<void> {}
  async applyFlagSettings(): Promise<void> {}
  async initializationResult(): Promise<never> { throw new Error('not implemented'); }
  async supportedCommands(): Promise<never> { throw new Error('not implemented'); }
  async supportedModels(): Promise<never> { throw new Error('not implemented'); }
  async supportedAgents(): Promise<never> { throw new Error('not implemented'); }
  async mcpServerStatus(): Promise<never> { throw new Error('not implemented'); }
  async getContextUsage(): Promise<never> { throw new Error('not implemented'); }
  async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(): Promise<never> { throw new Error('not implemented'); }
  async readFile(): Promise<null> { return null; }
  async reloadPlugins(): Promise<never> { throw new Error('not implemented'); }
  async reloadSkills(): Promise<never> { throw new Error('not implemented'); }
  async accountInfo(): Promise<never> { throw new Error('not implemented'); }
  async rewindFiles(): Promise<never> { throw new Error('not implemented'); }
  async seedReadState(): Promise<void> {}
  async reconnectMcpServer(): Promise<void> {}
  async toggleMcpServer(): Promise<void> {}
  async setMcpServers(): Promise<never> { throw new Error('not implemented'); }
  async streamInput(): Promise<void> {}
  async stopTask(): Promise<void> {}
  async backgroundTasks(): Promise<boolean> { return false; }

  private async *run(
    prompt: string | AsyncIterable<ClaudeAgentSdkUserMessage>,
    messages: readonly ClaudeAgentSdkMessage[],
    prompts: string[],
    beforeMessages: Promise<void>,
  ): AsyncGenerator<ClaudeAgentSdkMessage, void> {
    if (typeof prompt === 'string') {
      prompts.push(prompt);
    } else {
      const first = await prompt[Symbol.asyncIterator]().next();
      if (!first.done) {
        const message = first.value.message as { content?: unknown };
        prompts.push(typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
      }
    }
    await beforeMessages;
    for (const message of messages) {
      yield message;
    }
  }
}

async function collectUntilAction(
  subscription: AsyncIterator<unknown>,
  predicate: (action: StateAction) => boolean,
): Promise<StateAction[]> {
  const actions: StateAction[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const next = await subscription.next();
    assert.equal(next.done, false);
    const value = next.value as { type?: string; params?: { action?: StateAction } };
    if (value.type !== 'action' || !value.params?.action) {
      continue;
    }
    actions.push(value.params.action);
    if (predicate(value.params.action)) {
      return actions;
    }
  }
  assert.fail(`timed out waiting for matching action; saw: ${JSON.stringify(actions)}`);
}

async function collectUntilTerminal(subscription: AsyncIterator<unknown>): Promise<StateAction[]> {
  const actions: StateAction[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      subscription.next(),
      new Promise<IteratorResult<never>>(resolve => setTimeout(
        () => resolve({ done: true, value: undefined as never }),
        100,
      )),
    ]);
    const value = next.value as { type?: string; params?: { action?: StateAction } };
    if (next.done || value.type !== 'action' || !value.params?.action) {
      continue;
    }
    actions.push(value.params.action);
    const type = value.params.action.type;
    if (type === 'session/turnComplete' || type === 'session/error') {
      break;
    }
  }
  return actions;
}

function streamDelta(text: string): ClaudeAgentSdkMessage {
  return {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text },
    },
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: 'fake-claude-session',
  } as ClaudeAgentSdkMessage;
}

function resultSuccess(): ClaudeAgentSdkMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: crypto.randomUUID(),
    session_id: 'fake-claude-session',
  } as unknown as ClaudeAgentSdkMessage;
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}

function toolDefinition(name: string, title: string): ToolDefinition {
  return {
    name,
    title,
    description: `${title} test tool`,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
      },
      required: ['query'],
    },
  };
}

function createClient(server: AhpServer): AhpClient {
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  runningServers.push(server.accept(serverTransport));
  return new AhpClient(clientTransport, { requestTimeoutMs: 1_000 });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}
