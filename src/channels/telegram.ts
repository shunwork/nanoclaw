import fs from 'fs';
import https from 'https';
import path from 'path';

import { Bot } from 'grammy';

import { ASSISTANT_NAME, MEDIA_DIR, TELEGRAM_MAX_FILE_SIZE } from '../config.js';
import { logger } from '../logger.js';
import { Channel, MessageAttachment, NewMessage, OnChatMetadata, OnInboundMessage } from '../types.js';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot!: Bot;
  private connected = false;
  private typingTimers = new Map<string, NodeJS.Timeout>();
  private botId = 0;
  private botToken = '';
  private opts: TelegramChannelOpts;

  constructor(opts: TelegramChannelOpts) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      throw new Error(
        'TELEGRAM_BOT_TOKEN environment variable is required. Run /setup in Claude Code.',
      );
    }
    this.botToken = token;

    // Force IPv4 to avoid IPv6 connectivity issues with Telegram API
    const ipv4Agent = new https.Agent({ family: 4 });
    this.bot = new Bot(token, {
      client: { baseFetchConfig: { agent: ipv4Agent } },
    });

    // Verify token and get bot info
    const botInfo = await this.bot.api.getMe();
    this.botId = botInfo.id;
    const botUsername = botInfo.username || '';
    logger.info(
      { botUsername, botId: botInfo.id },
      'Telegram bot authenticated',
    );

    // Handle text messages
    this.bot.on('message:text', (ctx) => {
      this.handleMessage(ctx);
    });

    // Handle media with captions
    this.bot.on('message:caption', (ctx) => {
      this.handleMessage(ctx);
    });

    // Handle photos without caption
    this.bot.on('message:photo', (ctx) => {
      if (!ctx.message?.caption) {
        this.handleMessage(ctx);
      }
    });

    // Handle documents without caption
    this.bot.on('message:document', (ctx) => {
      if (!ctx.message?.caption) {
        this.handleMessage(ctx);
      }
    });

    // Error handling
    this.bot.catch((err) => {
      logger.error({ err: err.error }, 'Telegram bot error');
    });

    this.connected = true;

    // Start long polling (non-blocking)
    this.bot.start();
    logger.info('Telegram bot started (long polling)');
  }

  private async handleMessage(ctx: { chat: { id: number }; message?: {
    message_id: number;
    date: number;
    from?: { id: number; first_name?: string; username?: string };
    text?: string;
    caption?: string;
    photo?: Array<{ file_id: string; file_unique_id: string; width: number; height: number; file_size?: number }>;
    document?: { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
  }}): Promise<void> {
    const msg = ctx.message;
    if (!msg) return;

    const chatId = String(ctx.chat.id);
    const timestamp = new Date(msg.date * 1000).toISOString();
    const sender = String(msg.from?.id || '');
    const senderName =
      msg.from?.first_name || msg.from?.username || sender;
    const content = msg.text || msg.caption || '';
    const isFromMe = msg.from?.id === this.botId;
    const msgId = String(msg.message_id);

    // Download media attachments
    const attachments: MessageAttachment[] = [];
    if (msg.photo && msg.photo.length > 0) {
      const largest = msg.photo[msg.photo.length - 1];
      const attachment = await this.downloadMedia(
        largest.file_id,
        'photo',
        msgId,
        `${msgId}.jpg`,
        undefined,
        largest.file_size,
        chatId,
      );
      if (attachment) attachments.push(attachment);
    }
    if (msg.document) {
      const doc = msg.document;
      if (doc.file_size && doc.file_size > TELEGRAM_MAX_FILE_SIZE) {
        logger.warn({ fileSize: doc.file_size, fileName: doc.file_name }, 'Document too large, skipping download');
      } else {
        const fileName = doc.file_name || `${msgId}_document`;
        const attachment = await this.downloadMedia(
          doc.file_id,
          'document',
          msgId,
          `${msgId}_${fileName}`,
          doc.mime_type,
          doc.file_size,
          chatId,
        );
        if (attachment) attachments.push(attachment);
      }
    }

    // Notify chat metadata
    this.opts.onChatMetadata(chatId, timestamp, senderName);

    // Deliver inbound message
    this.opts.onMessage(chatId, {
      id: msgId,
      chat_jid: chatId,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isFromMe,
      is_bot_message: isFromMe,
      ...(attachments.length > 0 ? { attachments } : {}),
    });
  }

  private async downloadMedia(
    fileId: string,
    type: 'photo' | 'document',
    msgId: string,
    fileName: string,
    mimeType?: string,
    fileSize?: number,
    chatId?: string,
  ): Promise<MessageAttachment | null> {
    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      // Determine media dir based on chatId (use 'main' for owner)
      const mediaDir = path.join(MEDIA_DIR, 'main');
      fs.mkdirSync(mediaDir, { recursive: true });

      const localPath = path.join(mediaDir, fileName);
      const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;

      // Use node:https directly — native fetch() (undici) ignores https.Agent
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        https.get(url, { family: 4 }, (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} downloading media`));
            res.resume();
            return;
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      });
      fs.writeFileSync(localPath, buffer);

      logger.info({ type, fileName, size: buffer.length }, 'Media downloaded');

      return {
        type,
        localPath,
        fileName,
        mimeType,
        fileSize: fileSize || buffer.length,
      };
    } catch (err) {
      logger.warn({ err, fileId, type }, 'Failed to download media');
      return null;
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    // Telegram bot has its own identity — no assistant name prefix needed
    try {
      if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
        await this.bot.api.sendMessage(Number(jid), text);
      } else {
        for (
          let i = 0;
          i < text.length;
          i += TELEGRAM_MAX_MESSAGE_LENGTH
        ) {
          await this.bot.api.sendMessage(
            Number(jid),
            text.slice(i, i + TELEGRAM_MAX_MESSAGE_LENGTH),
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send message');
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    // Telegram chat IDs are numeric (positive for private, negative for groups)
    return /^-?\d+$/.test(jid);
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    // Clear all typing timers
    for (const timer of this.typingTimers.values()) {
      clearInterval(timer);
    }
    this.typingTimers.clear();
    this.bot?.stop();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (isTyping) {
      // Telegram's "typing" action expires after 5 seconds, resend every 4.5s
      const send = () => {
        this.bot.api.sendChatAction(Number(jid), 'typing').catch(() => {});
      };
      send();
      // Clear any existing timer for this chat
      const existing = this.typingTimers.get(jid);
      if (existing) clearInterval(existing);
      this.typingTimers.set(jid, setInterval(send, 4500));
    } else {
      const timer = this.typingTimers.get(jid);
      if (timer) {
        clearInterval(timer);
        this.typingTimers.delete(jid);
      }
    }
  }
}
