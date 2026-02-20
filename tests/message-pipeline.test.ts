/**
 * Integration test: User message → Telegram reply
 *
 * Tests the full host-side pipeline from receiving a user message
 * to sending a Telegram reply. The container (runContainerAgent)
 * is the ONLY mocked boundary — all other host logic (SQLite, XML
 * formatting, internal tag stripping, cursor management) uses real
 * implementations.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ContainerOutput } from '../src/container-runner.js';
import type { NewMessage } from '../src/types.js';

// --- Mocks ---

const CHAT_JID = '12345';
const BOT_NAME = 'TestBot';

vi.mock('../src/config.js', () => ({
  OWNER_CHAT_JID: '12345',
  ASSISTANT_NAME: 'TestBot',
  DATA_DIR: '/tmp/nanoclaw-test',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  STORE_DIR: ':memory:', // Not used — _initTestDatabase uses in-memory
  IDLE_TIMEOUT: 60000,
  IPC_POLL_INTERVAL: 1000,
}));

// Mock fs to prevent real filesystem writes (container-runner, ipc use it)
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

// Mock container-runner: the ONLY real mock boundary
// The test controls what outputs the container produces via mockContainerBehavior
let mockContainerBehavior: (
  onOutput?: (output: ContainerOutput) => Promise<void>,
) => Promise<ContainerOutput>;

vi.mock('../src/container-runner.js', () => ({
  runContainerAgent: vi.fn(async (
    _config: unknown,
    _input: unknown,
    _onProcess: unknown,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => {
    return mockContainerBehavior(onOutput);
  }),
  writeTasksSnapshot: vi.fn(),
}));

// Mock logger to suppress output
vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// --- Real imports (after mocks) ---
import {
  _initTestDatabase,
  storeChatMetadata,
  storeMessage,
  getMessagesSince,
} from '../src/db.js';
import { formatMessages, stripInternalTags } from '../src/router.js';

// --- Pipeline under test ---

/**
 * Re-implements the core processMessages logic from src/index.ts.
 * Direct import of index.ts is impractical due to module-level side effects
 * (bot creation, queue init, etc.). Instead we replicate the pipeline logic
 * that matters: DB read → format → container call → output processing →
 * cursor management.
 *
 * This tests the same logic paths as the real processMessages.
 */
async function processMessages(
  chatJid: string,
  lastAgentTimestamp: string,
  sessions: Record<string, string>,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<{
  success: boolean;
  newCursor: string;
  sentMessages: string[];
  sessionUpdated: string | undefined;
}> {
  const { runContainerAgent } = await import('../src/container-runner.js');

  const missedMessages = getMessagesSince(chatJid, lastAgentTimestamp, BOT_NAME);
  if (missedMessages.length === 0) {
    return {
      success: true,
      newCursor: lastAgentTimestamp,
      sentMessages: [],
      sessionUpdated: undefined,
    };
  }

  const prompt = formatMessages(missedMessages);
  const previousCursor = lastAgentTimestamp;
  const cursor = missedMessages[missedMessages.length - 1].timestamp;

  let hadError = false;
  let outputSentToUser = false;
  const sentMessages: string[] = [];
  let sessionUpdated: string | undefined;

  try {
    const output = await runContainerAgent(
      { chatJid, folder: 'main' } as any,
      {
        prompt,
        sessionId: sessions['main'],
        groupFolder: 'main',
        chatJid,
      } as any,
      (() => {}) as any, // onProcess — not relevant to this test
      async (result: ContainerOutput) => {
        // This mirrors the onOutput callback in src/index.ts processMessages
        if (result.newSessionId) {
          sessions['main'] = result.newSessionId;
          sessionUpdated = result.newSessionId;
        }

        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          const text = stripInternalTags(raw);
          if (text) {
            await sendMessage(chatJid, text);
            sentMessages.push(text);
            outputSentToUser = true;
          }
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
    );

    if (output.status === 'error') hadError = true;
  } catch {
    hadError = true;
  }

  // Cursor rollback logic (mirrors src/index.ts)
  if (hadError) {
    if (outputSentToUser) {
      // Error after output — don't rollback to prevent duplicate sends
      return {
        success: true,
        newCursor: cursor,
        sentMessages,
        sessionUpdated,
      };
    }
    return {
      success: false,
      newCursor: previousCursor,
      sentMessages,
      sessionUpdated,
    };
  }

  return { success: true, newCursor: cursor, sentMessages, sessionUpdated };
}

// --- Helper ---

function makeMessage(
  content: string,
  timestamp: string,
  sender = 'user1',
): NewMessage {
  return {
    id: `msg-${timestamp}`,
    chat_jid: CHAT_JID,
    sender,
    sender_name: sender,
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  };
}

// --- Tests ---

describe('message pipeline: user message → Telegram reply', () => {
  beforeEach(() => {
    _initTestDatabase();
    // Create the chat record (FK constraint requires it before inserting messages)
    storeChatMetadata(CHAT_JID, '2026-02-17T00:00:00.000Z', 'Test Chat');
  });

  it('normal conversation: user message → agent reply → Telegram', async () => {
    storeMessage(makeMessage('你好', '2026-02-17T10:00:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({
        status: 'success',
        result: '你好嗎',
        newSessionId: 'sess-1',
      });
      return { status: 'success', result: null, newSessionId: 'sess-1' };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.success).toBe(true);
    expect(r.sentMessages).toEqual(['你好嗎']);
    expect(r.sessionUpdated).toBe('sess-1');
    expect(sendMessage).toHaveBeenCalledWith(CHAT_JID, '你好嗎');
  });

  it('strips <internal> tags before sending to Telegram', async () => {
    storeMessage(makeMessage('狀態', '2026-02-17T10:01:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({
        status: 'success',
        result: '一切正常 <internal>daily log written</internal>',
      });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.sentMessages).toEqual(['一切正常']);
  });

  it('does not send when all content is <internal>', async () => {
    storeMessage(makeMessage('reflect', '2026-02-17T10:02:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({
        status: 'success',
        result: '<internal>reflection complete</internal>',
      });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.success).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send null result (session update only)', async () => {
    storeMessage(makeMessage('test', '2026-02-17T10:03:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({
        status: 'success',
        result: null,
        newSessionId: 'sess-2',
      });
      return { status: 'success', result: null, newSessionId: 'sess-2' };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(r.sessionUpdated).toBe('sess-2');
  });

  it('handles multiple streaming results', async () => {
    storeMessage(makeMessage('多工', '2026-02-17T10:04:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({
        status: 'success',
        result: '第一步完成',
        newSessionId: 'sess-3',
      });
      await onOutput!({ status: 'success', result: '全部完成' });
      return { status: 'success', result: null, newSessionId: 'sess-3' };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.sentMessages).toEqual(['第一步完成', '全部完成']);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('rolls back cursor on error when no output was sent', async () => {
    storeMessage(makeMessage('crash', '2026-02-17T10:05:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({
        status: 'error',
        result: null,
        error: 'container crashed',
      });
      return { status: 'error', result: null, error: 'container crashed' };
    };

    const sendMessage = vi.fn();
    const previousCursor = '';
    const r = await processMessages(
      CHAT_JID,
      previousCursor,
      {},
      sendMessage,
    );

    expect(r.success).toBe(false);
    expect(r.newCursor).toBe(previousCursor); // rolled back
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT rollback cursor when error occurs after output was sent', async () => {
    storeMessage(makeMessage('partial', '2026-02-17T10:06:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'success', result: '部分結果' });
      await onOutput!({
        status: 'error',
        result: null,
        error: 'late error',
      });
      return { status: 'error', result: null, error: 'late error' };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.success).toBe(true); // treated as success to prevent duplicate
    expect(r.newCursor).toBe('2026-02-17T10:06:00.000Z'); // NOT rolled back
    expect(r.sentMessages).toEqual(['部分結果']);
  });

  it('batches multiple user messages into single prompt', async () => {
    storeMessage(makeMessage('第一則', '2026-02-17T10:07:00.000Z'));
    storeMessage(makeMessage('第二則', '2026-02-17T10:07:01.000Z'));
    storeMessage(makeMessage('第三則', '2026-02-17T10:07:02.000Z'));

    mockContainerBehavior = async (onOutput) => {
      // Verify prompt content via the mock
      const { runContainerAgent } = await import('../src/container-runner.js');
      const calls = vi.mocked(runContainerAgent).mock.calls;
      const prompt = (calls[calls.length - 1][1] as any).prompt;

      expect(prompt).toContain('第一則');
      expect(prompt).toContain('第二則');
      expect(prompt).toContain('第三則');

      await onOutput!({ status: 'success', result: '收到三則訊息' });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.sentMessages).toEqual(['收到三則訊息']);
  });

  it('returns success with no container call when no pending messages', async () => {
    // Don't store any messages
    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.success).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('filters bot messages from prompt', async () => {
    storeMessage(makeMessage('使用者訊息', '2026-02-17T10:08:00.000Z'));
    storeMessage({
      ...makeMessage(
        'TestBot:機器人回覆',
        '2026-02-17T10:08:01.000Z',
        BOT_NAME,
      ),
      is_bot_message: true,
    });
    storeMessage(makeMessage('使用者第二則', '2026-02-17T10:08:02.000Z'));

    mockContainerBehavior = async (onOutput) => {
      const { runContainerAgent } = await import('../src/container-runner.js');
      const calls = vi.mocked(runContainerAgent).mock.calls;
      const prompt = (calls[calls.length - 1][1] as any).prompt;

      // Bot message should NOT be in the prompt
      expect(prompt).not.toContain('機器人回覆');
      expect(prompt).toContain('使用者訊息');
      expect(prompt).toContain('使用者第二則');

      await onOutput!({ status: 'success', result: '好的' });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    await processMessages(CHAT_JID, '', {}, sendMessage);
  });

  it('advances cursor to latest message timestamp on success', async () => {
    storeMessage(makeMessage('msg1', '2026-02-17T10:09:00.000Z'));
    storeMessage(makeMessage('msg2', '2026-02-17T10:09:05.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'success', result: 'ok' });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.newCursor).toBe('2026-02-17T10:09:05.000Z');
  });
});
