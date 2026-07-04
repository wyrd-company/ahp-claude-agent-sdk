import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import type { SessionKey, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

import { JsonlSessionStore } from '../src/jsonl-session-store.js';

let directory = '';

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'ahp-claude-jsonl-store-'));
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('JsonlSessionStore appends and loads entries in order', async () => {
  const store = new JsonlSessionStore(directory);
  const key = sessionKey('session-a');
  const first = entry('user', 'uuid-1', { message: { content: 'first' } });
  const second = entry('assistant', 'uuid-2', { message: { content: 'second' } });

  await store.append(key, [first]);
  await store.append(key, [second]);

  assert.deepEqual(await store.load(key), [first, second]);
});

test('JsonlSessionStore ignores duplicate uuid entries and keeps uuid-less entries', async () => {
  const store = new JsonlSessionStore(directory);
  const key = sessionKey('session-a');
  const first = entry('user', 'uuid-1', { message: { content: 'first' } });
  const duplicate = entry('user', 'uuid-1', { message: { content: 'duplicate' } });
  const withoutUuid = { type: 'summary', text: 'summary' };

  await store.append(key, [first]);
  await store.append(key, [duplicate, withoutUuid, withoutUuid]);

  assert.deepEqual(await store.load(key), [first, withoutUuid, withoutUuid]);
});

test('JsonlSessionStore returns null for never-written keys', async () => {
  const store = new JsonlSessionStore(directory);

  assert.equal(await store.load(sessionKey('missing')), null);
});

test('JsonlSessionStore lists session ids with modification times', async () => {
  const store = new JsonlSessionStore(directory);
  const before = Date.now();

  await store.append(sessionKey('session-a'), [entry('user', 'uuid-a')]);
  await store.append(sessionKey('session-b'), [entry('user', 'uuid-b')]);

  const sessions = await store.listSessions('project-a');
  const byId = new Map(sessions.map(session => [session.sessionId, session.mtime]));
  assert.deepEqual([...byId.keys()].sort(), ['session-a', 'session-b']);
  assert.ok((byId.get('session-a') ?? 0) >= before);
  assert.ok((byId.get('session-b') ?? 0) >= before);
});

test('JsonlSessionStore stores and lists subpath keys for resume materialization', async () => {
  const store = new JsonlSessionStore(directory);
  const mainKey = sessionKey('session-a');
  const subpathKey = { ...mainKey, subpath: 'subagents/agent-a' };
  const subpathEntry = entry('assistant', 'uuid-subagent');

  await store.append(mainKey, [entry('user', 'uuid-main')]);
  await store.append(subpathKey, [subpathEntry]);

  assert.deepEqual(await store.load(subpathKey), [subpathEntry]);
  assert.deepEqual(await store.listSubkeys(mainKey), ['subagents/agent-a']);
});

test('JsonlSessionStore deletes sessions best effort', async () => {
  const store = new JsonlSessionStore(directory);
  const key = sessionKey('session-a');

  await store.append(key, [entry('user', 'uuid-a')]);
  await store.delete(key);
  await store.delete(key);

  assert.equal(await store.load(key), null);
  assert.deepEqual(await store.listSessions('project-a'), []);
});

function sessionKey(sessionId: string): SessionKey {
  return {
    projectKey: 'project-a',
    sessionId,
  };
}

function entry(type: string, uuid?: string, rest: Record<string, unknown> = {}): SessionStoreEntry {
  return {
    type,
    ...(uuid ? { uuid } : {}),
    timestamp: new Date(0).toISOString(),
    ...rest,
  };
}
