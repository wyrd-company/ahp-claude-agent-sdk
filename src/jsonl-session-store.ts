import { appendFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from '@anthropic-ai/claude-agent-sdk';

export class JsonlSessionStore implements SessionStore {
  private readonly appendChains = new Map<string, Promise<void>>();

  constructor(readonly rootDir: string) {}

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }

    const file = this.fileForKey(key);
    const previous = this.appendChains.get(file) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(() => this.appendEntries(file, key, entries));
    this.appendChains.set(file, next);
    try {
      await next;
    } finally {
      if (this.appendChains.get(file) === next) {
        this.appendChains.delete(file);
      }
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const text = await readFile(this.fileForKey(key), 'utf8').catch(error => {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return undefined;
      }
      throw error;
    });
    if (text === undefined) {
      return null;
    }
    if (!text) {
      return [];
    }
    return text
      .split('\n')
      .filter(line => line.length > 0)
      .map(line => JSON.parse(line) as SessionStoreEntry);
  }

  async listSessions(_projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const entries = await readdir(this.rootDir, { withFileTypes: true }).catch(error => {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return [];
      }
      throw error;
    });
    const sessions: Array<{ sessionId: string; mtime: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session-')) {
        continue;
      }
      const file = join(this.rootDir, entry.name, 'main.jsonl');
      const fileStat = await stat(file).catch(error => {
        if (isNodeErrorCode(error, 'ENOENT')) {
          return undefined;
        }
        throw error;
      });
      if (fileStat) {
        sessions.push({
          sessionId: decodePathSegment(entry.name.slice('session-'.length)),
          mtime: fileStat.mtimeMs,
        });
      }
    }
    return sessions;
  }

  async delete(key: SessionKey): Promise<void> {
    const target = key.subpath
      ? this.fileForKey(key)
      : this.sessionDir(key.sessionId);
    await rm(target, { recursive: true, force: true });
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const dir = join(this.sessionDir(key.sessionId), 'subpaths');
    const entries = await readdir(dir, { withFileTypes: true }).catch(error => {
      if (isNodeErrorCode(error, 'ENOENT')) {
        return [];
      }
      throw error;
    });
    return entries
      .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
      .map(entry => decodePathSegment(entry.name.slice(0, -'.jsonl'.length)));
  }

  private async appendEntries(file: string, key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const currentEntries = await this.load(key);
    const seenUuids = new Set(
      (currentEntries ?? [])
        .map(entry => entry.uuid)
        .filter((uuid): uuid is string => typeof uuid === 'string'),
    );
    const newEntries: SessionStoreEntry[] = [];
    for (const entry of entries) {
      if (typeof entry.uuid === 'string') {
        if (seenUuids.has(entry.uuid)) {
          continue;
        }
        seenUuids.add(entry.uuid);
      }
      newEntries.push(entry);
    }
    if (newEntries.length === 0) {
      return;
    }

    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${newEntries.map(entry => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
  }

  private fileForKey(key: SessionKey): string {
    if (key.subpath) {
      return join(
        this.sessionDir(key.sessionId),
        'subpaths',
        `${encodePathSegment(key.subpath)}.jsonl`,
      );
    }
    return join(this.sessionDir(key.sessionId), 'main.jsonl');
  }

  // Content is keyed by sessionId ONLY, never projectKey: the SDK derives the
  // default projectKey from the session's sanitized cwd, so a session resumed
  // from a different workspace path presents a different projectKey for the
  // same sessionId. Folding projectKey into the layout would break the
  // provider-kit contract that the directory plus the resume handle suffice on
  // a different machine or path. Session ids are UUIDs, so cross-project
  // collisions are not a practical concern; listSessions consequently lists
  // every session under the root regardless of the projectKey argument.
  private sessionDir(sessionId: string): string {
    return join(this.rootDir, `session-${encodePathSegment(sessionId)}`);
  }
}

function encodePathSegment(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function decodePathSegment(value: string): string {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === code;
}
