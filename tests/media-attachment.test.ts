/**
 * Integration test: Media attachment pipeline
 *
 * Tests the full flow from storing a message with attachments
 * through to XML formatting with <attachment> tags. Also tests
 * DB round-trip (store → retrieve preserves attachments).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NewMessage, MessageAttachment } from '../src/types.js';

vi.mock('../src/config.js', () => ({
  OWNER_CHAT_JID: '12345',
  ASSISTANT_NAME: 'TestBot',
  DATA_DIR: '/tmp/nanoclaw-test',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  STORE_DIR: ':memory:',
  MEDIA_DIR: '/tmp/nanoclaw-test/media',
  TELEGRAM_MAX_FILE_SIZE: 20 * 1024 * 1024,
  IDLE_TIMEOUT: 60000,
  IPC_POLL_INTERVAL: 1000,
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  _initTestDatabase,
  storeChatMetadata,
  storeMessage,
  getMessagesSince,
} from '../src/db.js';
import { formatMessages } from '../src/router.js';

const CHAT_JID = '12345';
const BOT_NAME = 'TestBot';

function makeMessage(
  content: string,
  timestamp: string,
  attachments?: MessageAttachment[],
): NewMessage {
  return {
    id: `msg-${timestamp}`,
    chat_jid: CHAT_JID,
    sender: 'user1',
    sender_name: 'user1',
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
    attachments,
  };
}

describe('media attachment pipeline', () => {
  beforeEach(() => {
    _initTestDatabase();
    storeChatMetadata(CHAT_JID, '2026-02-17T00:00:00.000Z', 'Test Chat');
  });

  describe('DB round-trip: storeMessage → getMessagesSince', () => {
    it('preserves photo attachment through DB', () => {
      const attachments: MessageAttachment[] = [
        {
          type: 'photo',
          localPath: '/tmp/nanoclaw-test/media/main/123.jpg',
          fileName: '123.jpg',
          fileSize: 54321,
        },
      ];
      storeMessage(makeMessage('看這張圖', '2026-02-17T10:00:00.000Z', attachments));

      const messages = getMessagesSince(CHAT_JID, '', BOT_NAME);
      expect(messages).toHaveLength(1);
      expect(messages[0].attachments).toEqual(attachments);
    });

    it('preserves document attachment with mimeType through DB', () => {
      const attachments: MessageAttachment[] = [
        {
          type: 'document',
          localPath: '/tmp/nanoclaw-test/media/main/456_report.pdf',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          fileSize: 102400,
        },
      ];
      storeMessage(makeMessage('', '2026-02-17T10:01:00.000Z', attachments));

      const messages = getMessagesSince(CHAT_JID, '', BOT_NAME);
      expect(messages).toHaveLength(1);
      expect(messages[0].attachments).toEqual(attachments);
      expect(messages[0].content).toBe('');
    });

    it('handles message without attachments (null in DB)', () => {
      storeMessage(makeMessage('純文字', '2026-02-17T10:02:00.000Z'));

      const messages = getMessagesSince(CHAT_JID, '', BOT_NAME);
      expect(messages).toHaveLength(1);
      expect(messages[0].attachments).toBeUndefined();
    });

    it('preserves multiple attachments', () => {
      const attachments: MessageAttachment[] = [
        {
          type: 'photo',
          localPath: '/tmp/nanoclaw-test/media/main/789.jpg',
          fileName: '789.jpg',
          fileSize: 10000,
        },
        {
          type: 'document',
          localPath: '/tmp/nanoclaw-test/media/main/789_data.csv',
          fileName: 'data.csv',
          mimeType: 'text/csv',
          fileSize: 5000,
        },
      ];
      storeMessage(makeMessage('圖跟檔', '2026-02-17T10:03:00.000Z', attachments));

      const messages = getMessagesSince(CHAT_JID, '', BOT_NAME);
      expect(messages[0].attachments).toHaveLength(2);
      expect(messages[0].attachments![0].type).toBe('photo');
      expect(messages[0].attachments![1].type).toBe('document');
    });
  });

  describe('XML formatting: formatMessages with attachments', () => {
    it('includes <attachment> tag for photo', () => {
      const msg = makeMessage('看圖', '2026-02-17T10:00:00.000Z', [
        {
          type: 'photo',
          localPath: '/tmp/nanoclaw-test/media/main/123.jpg',
          fileName: '123.jpg',
          fileSize: 54321,
        },
      ]);

      const xml = formatMessages([msg]);
      expect(xml).toContain('<attachment type="photo" path="/workspace/media/123.jpg" />');
      expect(xml).toContain('看圖');
    });

    it('includes <attachment> tag for document with metadata', () => {
      const msg = makeMessage('', '2026-02-17T10:01:00.000Z', [
        {
          type: 'document',
          localPath: '/tmp/nanoclaw-test/media/main/456_report.pdf',
          fileName: 'report.pdf',
          mimeType: 'application/pdf',
          fileSize: 102400,
        },
      ]);

      const xml = formatMessages([msg]);
      expect(xml).toContain('type="document"');
      expect(xml).toContain('path="/workspace/media/456_report.pdf"');
      expect(xml).toContain('filename="report.pdf"');
      expect(xml).toContain('mime="application/pdf"');
      expect(xml).toContain('size="102400"');
    });

    it('formats message without attachments normally', () => {
      const msg = makeMessage('純文字', '2026-02-17T10:02:00.000Z');
      const xml = formatMessages([msg]);

      expect(xml).toContain('純文字');
      expect(xml).not.toContain('<attachment');
    });

    it('photo attachment does NOT include filename/mime/size', () => {
      const msg = makeMessage('', '2026-02-17T10:03:00.000Z', [
        {
          type: 'photo',
          localPath: '/tmp/nanoclaw-test/media/main/x.jpg',
          fileName: 'x.jpg',
          mimeType: 'image/jpeg',
          fileSize: 9999,
        },
      ]);

      const xml = formatMessages([msg]);
      // Photo attachments only have type and path
      expect(xml).toContain('type="photo"');
      expect(xml).toContain('path="/workspace/media/x.jpg"');
      expect(xml).not.toContain('filename=');
      expect(xml).not.toContain('mime=');
    });
  });

  describe('end-to-end: store → read → format', () => {
    it('photo message stored in DB produces correct XML with <attachment>', () => {
      const attachments: MessageAttachment[] = [
        {
          type: 'photo',
          localPath: '/tmp/nanoclaw-test/media/main/e2e.jpg',
          fileName: 'e2e.jpg',
          fileSize: 12345,
        },
      ];
      storeMessage(makeMessage('這是什麼', '2026-02-17T10:00:00.000Z', attachments));

      // Read back from DB (same as processMessages does)
      const messages = getMessagesSince(CHAT_JID, '', BOT_NAME);
      const xml = formatMessages(messages);

      expect(xml).toContain('這是什麼');
      expect(xml).toContain('<attachment type="photo" path="/workspace/media/e2e.jpg" />');
    });

    it('photo-only message (empty content) produces XML with attachment', () => {
      const attachments: MessageAttachment[] = [
        {
          type: 'photo',
          localPath: '/tmp/nanoclaw-test/media/main/notext.jpg',
          fileName: 'notext.jpg',
          fileSize: 8888,
        },
      ];
      storeMessage(makeMessage('', '2026-02-17T10:01:00.000Z', attachments));

      const messages = getMessagesSince(CHAT_JID, '', BOT_NAME);
      expect(messages).toHaveLength(1);

      const xml = formatMessages(messages);
      expect(xml).toContain('<attachment type="photo" path="/workspace/media/notext.jpg" />');
    });
  });
});
