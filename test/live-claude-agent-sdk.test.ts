import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AhpClient } from '@microsoft/agent-host-protocol/client';
import type { Message, StateAction } from '@microsoft/agent-host-protocol';

import {
  AhpServer,
  createInMemoryTransportPair,
} from '@wyrd-company/ahp-server';
import { createClaudeAgentSdkProvider } from '../src/index.js';

test('streams a live Claude Agent SDK turn through AHP', {
  skip: claudeLiveEnabled()
    ? false
    : 'set CLAUDE_AGENT_SDK_ENABLED=1 to run live Claude Agent SDK validation',
  timeout: 180_000,
}, async () => {
  const server = new AhpServer({
    providers: [
      createClaudeAgentSdkProvider({
        defaultModel: process.env.CLAUDE_AGENT_SDK_MODEL,
        pathToClaudeCodeExecutable: process.env.CLAUDE_AGENT_SDK_EXECUTABLE,
        permissionMode: 'dontAsk',
        tools: [],
      }),
    ],
  });
  const [clientTransport, serverTransport] = createInMemoryTransportPair();
  const serverRun = server.accept(serverTransport);
  const client = new AhpClient(clientTransport, { requestTimeoutMs: 10_000 });
  let sessionUri: string | undefined;

  try {
    client.connect();
    await client.initialize({ clientId: 'live-claude-client', protocolVersions: ['0.3.0'] });

    sessionUri = `ahp-session:/live-claude-${Date.now()}`;
    await client.request('createSession', {
      channel: sessionUri,
      provider: 'claude-agent-sdk',
      workingDirectory: `file://${process.cwd()}`,
    });
    const { subscription } = await client.subscribe(sessionUri);
    client.dispatch(sessionUri, {
      type: 'session/turnStarted',
      turnId: 'live-claude-turn',
      message: userMessage(process.env.CLAUDE_AGENT_SDK_LIVE_TURN_PROMPT ?? 'Reply with exactly: pong'),
    } as StateAction);

    const actions = await collectUntilTerminal(subscription);
    const types = actions.map(action => String(action.type));
    assert.ok(types.includes('session/delta'), `expected streamed delta, saw: ${JSON.stringify(actions)}`);
    assert.ok(types.includes('session/turnComplete'), `expected turn completion, saw: ${JSON.stringify(actions)}`);
  } finally {
    if (sessionUri) {
      try {
        await client.request('disposeSession', { channel: sessionUri });
      } catch {
        // Ignore cleanup failure after validation failure.
      }
    }
    await client.shutdown();
    await serverRun;
  }
});

async function collectUntilTerminal(subscription: AsyncIterator<unknown>): Promise<StateAction[]> {
  const actions: StateAction[] = [];
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      subscription.next(),
      new Promise<IteratorResult<never>>(resolve => setTimeout(
        () => resolve({ done: true, value: undefined as never }),
        1_000,
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

function claudeLiveEnabled(): boolean {
  return process.env.CLAUDE_AGENT_SDK_ENABLED === '1' || process.env.CLAUDE_AGENT_SDK_ENABLED === 'true';
}

function userMessage(text: string): Message {
  return {
    text,
    origin: { kind: 'user' as Message['origin']['kind'] },
  };
}
