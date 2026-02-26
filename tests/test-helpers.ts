/**
 * Shared test helpers — mock factories, message builders, and constants.
 */
import { vi } from 'vitest';
import type { NewMessage, MessageAttachment } from '../src/types.js';

// --- Test constants ---

export const TEST_CHAT_JID = '12345';
export const TEST_BOT_NAME = 'TestBot';

// --- Config mock factory ---

export function mockConfig(overrides?: Record<string, unknown>) {
  return {
    OWNER_CHAT_JID: TEST_CHAT_JID,
    ASSISTANT_NAME: TEST_BOT_NAME,
    DATA_DIR: '/tmp/nanoclaw-test',
    GROUPS_DIR: '/tmp/nanoclaw-test-groups',
    STORE_DIR: ':memory:',
    MEDIA_DIR: '/tmp/nanoclaw-test/media',
    TELEGRAM_MAX_FILE_SIZE: 20 * 1024 * 1024,
    IDLE_TIMEOUT: 60000,
    IPC_POLL_INTERVAL: 1000,
    TIMEZONE: 'UTC',
    ...overrides,
  };
}

// --- Logger mock factory ---

export function mockLogger() {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

// --- fs mock factory (allows real reads, mocks writes) ---

export async function mockFs() {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn(),
      renameSync: vi.fn(),
      readFileSync: actual.readFileSync,
      existsSync: actual.existsSync,
    },
  };
}

// --- Message factory ---

export function makeMessage(
  content: string,
  timestamp: string,
  sender = 'user1',
  attachments?: MessageAttachment[],
): NewMessage {
  return {
    id: `msg-${timestamp}`,
    chat_jid: TEST_CHAT_JID,
    sender,
    sender_name: sender,
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
    attachments,
  };
}

// --- DB setup helper ---

export function setupTestDb() {
  // Dynamically import to respect vi.mock ordering
  return import('../src/db.js').then(({ _initTestDatabase, storeChatMetadata }) => {
    _initTestDatabase();
    storeChatMetadata(TEST_CHAT_JID, '2026-02-17T00:00:00.000Z', 'Test Chat');
  });
}
