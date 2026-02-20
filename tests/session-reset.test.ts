/**
 * Integration test: Session reset via IPC new_session
 *
 * Tests that session reset (new_session IPC command) correctly clears
 * the session state AND that the wrappedOnOutput logic in runAgent
 * does not accidentally restore the old session ID afterwards.
 *
 * These bugs were found through manual testing and log reading.
 * This test suite ensures they stay fixed.
 *
 * Mock boundary: container-runner.js only (same as message-pipeline.test.ts).
 * Real implementations: SQLite, IPC processTaskIpc, wrappedOnOutput logic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContainerOutput } from '../src/container-runner.js';

// --- Mocks ---

vi.mock('../src/config.js', () => ({
  OWNER_CHAT_JID: '12345',
  ASSISTANT_NAME: 'TestBot',
  DATA_DIR: '/tmp/nanoclaw-test',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  STORE_DIR: ':memory:',
  IDLE_TIMEOUT: 60000,
  IPC_POLL_INTERVAL: 1000,
  TIMEZONE: 'UTC',
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn(),
      readFileSync: actual.readFileSync,
      existsSync: actual.existsSync,
    },
  };
});

vi.mock('../src/container-runner.js', () => ({
  runContainerAgent: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// --- Real imports (after mocks) ---
import { _initTestDatabase, getSession, setSession } from '../src/db.js';
import { processTaskIpc, type IpcDeps } from '../src/ipc.js';

// --- wrappedOnOutput logic under test ---

/**
 * Re-implements the wrappedOnOutput logic from src/index.ts runAgent().
 *
 * This is the critical logic that prevents the old session ID from being
 * restored after a session reset. The container may still report the old
 * session ID in its output (since it doesn't know about the reset), so
 * wrappedOnOutput must detect and skip that stale update.
 */
function createWrappedOnOutput(
  sessions: Record<string, string>,
  folder: string,
  initialSessionId: string | undefined,
  onOutput: (output: ContainerOutput) => Promise<void>,
): (output: ContainerOutput) => Promise<void> {
  return async (output: ContainerOutput) => {
    if (output.newSessionId) {
      const currentSession = sessions[folder];
      // If session was reset (cleared to '') but container still reports the old ID, skip
      if (currentSession === '' && output.newSessionId === initialSessionId) {
        // Skip — session was reset, don't restore old ID
      } else {
        sessions[folder] = output.newSessionId;
        setSession(folder, output.newSessionId);
      }
    }
    await onOutput(output);
  };
}

// --- Tests ---

describe('session reset: IPC new_session', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('IPC new_session clears session in DB and calls onSessionReset', async () => {
    // Pre-condition: session exists
    setSession('main', 'existing-session-123');
    expect(getSession('main')).toBe('existing-session-123');

    const onSessionReset = vi.fn();
    const deps: IpcDeps = {
      sendMessage: vi.fn(),
      onSessionReset,
    };

    await processTaskIpc(
      { type: 'new_session', groupFolder: 'main' },
      deps,
    );

    // Session should be cleared in DB
    expect(getSession('main')).toBe('');

    // Callback should have been invoked
    expect(onSessionReset).toHaveBeenCalledWith('main');
  });

  it('wrappedOnOutput does NOT restore old session after reset', async () => {
    const sessions: Record<string, string> = { main: 'old-session' };
    const initialSessionId = 'old-session';

    // Simulate session reset (same as what onSessionReset does in index.ts)
    sessions['main'] = '';
    setSession('main', '');

    const receivedOutputs: ContainerOutput[] = [];
    const wrappedOnOutput = createWrappedOnOutput(
      sessions,
      'main',
      initialSessionId,
      async (output) => { receivedOutputs.push(output); },
    );

    // Container reports the old session ID (it doesn't know about the reset)
    await wrappedOnOutput({
      status: 'success',
      result: 'some response',
      newSessionId: 'old-session',
    });

    // Session should still be empty — NOT restored to 'old-session'
    expect(sessions['main']).toBe('');
    expect(getSession('main')).toBe('');

    // The output callback should still have been called
    expect(receivedOutputs).toHaveLength(1);
  });

  it('wrappedOnOutput DOES accept new session ID after reset', async () => {
    const sessions: Record<string, string> = { main: 'old-session' };
    const initialSessionId = 'old-session';

    // Simulate session reset
    sessions['main'] = '';
    setSession('main', '');

    const wrappedOnOutput = createWrappedOnOutput(
      sessions,
      'main',
      initialSessionId,
      async () => {},
    );

    // Container reports a brand new session ID (from a fresh query())
    await wrappedOnOutput({
      status: 'success',
      result: 'fresh response',
      newSessionId: 'brand-new-session',
    });

    // New session should be accepted
    expect(sessions['main']).toBe('brand-new-session');
    expect(getSession('main')).toBe('brand-new-session');
  });

  it('normal session update (no reset) still works', async () => {
    const sessions: Record<string, string> = { main: '' };
    const initialSessionId = undefined; // fresh start, no previous session

    const wrappedOnOutput = createWrappedOnOutput(
      sessions,
      'main',
      initialSessionId,
      async () => {},
    );

    // Container reports a new session ID
    await wrappedOnOutput({
      status: 'success',
      result: 'hello',
      newSessionId: 'sess-1',
    });

    expect(sessions['main']).toBe('sess-1');
    expect(getSession('main')).toBe('sess-1');

    // Second output updates the session
    await wrappedOnOutput({
      status: 'success',
      result: 'world',
      newSessionId: 'sess-2',
    });

    expect(sessions['main']).toBe('sess-2');
    expect(getSession('main')).toBe('sess-2');
  });
});
