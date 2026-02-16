---
name: migrate-to-telegram
description: Migrate NanoClaw from WhatsApp (Baileys) to Telegram Bot (grammy). Creates a TelegramChannel implementing the Channel interface in src/channels/telegram.ts, replaces WhatsApp-specific code, and updates for single-user mode. Use when user wants to switch from WhatsApp to Telegram.
disable-model-invocation: true
---

# Migrate to Telegram

This skill transforms NanoClaw from WhatsApp (using Baileys) to Telegram Bot API (using grammy). The key architectural change is replacing `src/channels/whatsapp.ts` with `src/channels/telegram.ts` — a new `TelegramChannel` class implementing the `Channel` interface from `src/types.ts`.

**What changes:**
- IM library: `@whiskeysockets/baileys` + `qrcode-terminal` + `qrcode` -> `grammy`
- Auth: QR code scan -> Bot token from @BotFather
- Channel implementation: `WhatsAppChannel` -> `TelegramChannel` (both implement `Channel` from `src/types.ts`)
- Chat IDs: `number@s.whatsapp.net` / `number@g.us` -> Numeric IDs (string representation; negative for groups, positive for private)
- Typing indicator: Single presence update -> Repeating 4.5s timer (Telegram expires after 5s)
- Message limits: None -> 4096-char split in `sendMessage()`
- Bot message detection: `fromMe` flag or content prefix -> `from.id === botId`
- Mode: Multi-group with triggers -> Single-user mode (OWNER_CHAT_JID only, no trigger patterns)
- IPv4: Not needed -> Force IPv4 with `new https.Agent({ family: 4 })` (avoids Telegram API IPv6 issues)

**What stays the same:**
- Container runtime (Apple Container: `container build`, `container run`, `container stop`)
- Agent runner with streaming output (OUTPUT_START/END markers, IPC input polling loop)
- Agent Teams support (Task, TaskOutput, TeamCreate tools)
- MCP server as standalone stdio process (`ipc-mcp-stdio.ts`)
- SQLite database schema (same columns, different ID format)
- IPC system (file-based messages/tasks), scheduler, mount security
- Group memory and CLAUDE.md hierarchy
- Channel interface contract (`connect()`, `sendMessage()`, `setTyping()`, `ownsJid()`, `disconnect()`)

## 1. Update Dependencies

Edit `package.json`:

### 1a. Remove WhatsApp dependencies

Remove from `dependencies`:
```json
"@whiskeysockets/baileys": "^7.0.0-rc.9",
"qrcode": "^1.5.4",
"qrcode-terminal": "^0.12.0",
```

Remove from `devDependencies`:
```json
"@types/qrcode-terminal": "^0.12.2",
```

### 1b. Add Telegram dependency

Add to `dependencies`:
```json
"grammy": "^1.35.0",
```

### 1c. Update npm scripts

Replace the `"auth"` script to use the new Telegram auth script:

```json
"scripts": {
  "build": "tsc",
  "start": "node dist/index.js",
  "dev": "tsx src/index.ts",
  "auth": "tsx src/telegram-auth.ts",
  "typecheck": "tsc --noEmit",
  "format": "prettier --write \"src/**/*.ts\"",
  "format:check": "prettier --check \"src/**/*.ts\"",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

### 1d. Install

```bash
npm install
```

## 2. Create Telegram Auth Script

Delete `src/whatsapp-auth.ts`.

Create `src/telegram-auth.ts`:

```typescript
/**
 * Telegram Bot Authentication Script
 *
 * Verifies the bot token works by calling getMe().
 * Set TELEGRAM_BOT_TOKEN in .env or as an environment variable.
 *
 * Usage: npx tsx src/telegram-auth.ts
 */
import https from 'https';
import { Bot } from 'grammy';
import { readEnvFile } from './env.js';

async function authenticate(): Promise<void> {
  const envConfig = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token = process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error(
      '\u2717 TELEGRAM_BOT_TOKEN not set.\n\n' +
        '  1. Message @BotFather on Telegram\n' +
        '  2. Send /newbot and follow the prompts\n' +
        '  3. Copy the token and add to .env:\n' +
        '     TELEGRAM_BOT_TOKEN=your-token-here\n',
    );
    process.exit(1);
  }

  // Force IPv4 to avoid Telegram API IPv6 connectivity issues
  const ipv4Agent = new https.Agent({ family: 4 });
  const bot = new Bot(token, {
    client: { baseFetchConfig: { agent: ipv4Agent } },
  });
  const me = await bot.api.getMe();

  console.log(`\n\u2713 Telegram bot authenticated!`);
  console.log(`  Bot: @${me.username} (${me.first_name})`);
  console.log(`  ID: ${me.id}\n`);
  console.log(`  Now send a message to your bot in Telegram.`);
  console.log(`  Your chat ID will be the OWNER_CHAT_JID.\n`);
  console.log(`  Then start NanoClaw with: npm run dev\n`);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
```

## 3. Create TelegramChannel

Delete `src/channels/whatsapp.ts` and `src/channels/whatsapp.test.ts`.

Create `src/channels/telegram.ts`. This implements the `Channel` interface from `src/types.ts`:

```typescript
import https from 'https';
import { Bot } from 'grammy';

import { logger } from '../logger.js';
import { Channel, OnInboundMessage, OnChatMetadata } from '../types.js';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

export interface TelegramChannelOpts {
  token: string;
  ownerChatJid: string;
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot;
  private botId = 0;
  private opts: TelegramChannelOpts;
  private typingTimers = new Map<string, NodeJS.Timeout>();

  constructor(opts: TelegramChannelOpts) {
    this.opts = opts;
    // Force IPv4 to avoid Telegram API IPv6 connectivity issues
    const ipv4Agent = new https.Agent({ family: 4 });
    this.bot = new Bot(opts.token, {
      client: { baseFetchConfig: { agent: ipv4Agent } },
    });
  }

  async connect(): Promise<void> {
    const me = await this.bot.api.getMe();
    this.botId = me.id;
    logger.info(
      { botUsername: me.username, botId: me.id },
      'Telegram bot authenticated',
    );

    // Handle text messages
    this.bot.on('message:text', (ctx) => {
      this.handleMessage(ctx.chat.id, ctx.message);
    });

    // Handle media with captions
    this.bot.on('message:caption', (ctx) => {
      this.handleMessage(ctx.chat.id, ctx.message, ctx.message.caption);
    });

    // Error handling
    this.bot.catch((err) => {
      logger.error({ err: err.error }, 'Telegram bot error');
    });

    // Start long polling (grammy handles reconnection automatically)
    this.bot.start();
    logger.info('Telegram bot started (long polling)');
  }

  private handleMessage(
    chatIdNum: number,
    msg: { message_id: number; date: number; from?: { id: number; first_name?: string; username?: string }; text?: string },
    captionText?: string,
  ): void {
    const chatId = String(chatIdNum);

    // Single-user mode: only process messages from OWNER_CHAT_JID
    if (chatId !== this.opts.ownerChatJid) return;

    const timestamp = new Date(msg.date * 1000).toISOString();
    const sender = String(msg.from?.id || '');
    const senderName = msg.from?.first_name || msg.from?.username || sender;
    const content = captionText || msg.text || '';
    const isBotMessage = msg.from?.id === this.botId;
    const msgId = String(msg.message_id);

    // Notify about chat metadata
    this.opts.onChatMetadata(chatId, timestamp);

    // Deliver the message
    this.opts.onMessage(chatId, {
      id: msgId,
      chat_jid: chatId,
      sender,
      sender_name: senderName,
      content,
      timestamp,
      is_from_me: isBotMessage,
      is_bot_message: isBotMessage,
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    try {
      if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
        await this.bot.api.sendMessage(Number(jid), text);
      } else {
        // Split long messages at the 4096-char boundary
        for (let i = 0; i < text.length; i += TELEGRAM_MAX_MESSAGE_LENGTH) {
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
    return true; // grammy handles reconnection internally
  }

  ownsJid(jid: string): boolean {
    // Telegram chat IDs are numeric strings
    return /^-?\d+$/.test(jid);
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    // Clear any existing timer for this chat
    const existing = this.typingTimers.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingTimers.delete(jid);
    }

    if (!isTyping) return;

    // Telegram's "typing" action expires after 5 seconds,
    // so we resend every 4.5s with a repeating timer.
    const send = () => {
      this.bot.api.sendChatAction(Number(jid), 'typing').catch(() => {});
    };
    send();
    const timer = setInterval(send, 4500);
    this.typingTimers.set(jid, timer);
  }

  async disconnect(): Promise<void> {
    // Clear all typing timers
    for (const timer of this.typingTimers.values()) {
      clearInterval(timer);
    }
    this.typingTimers.clear();
    this.bot.stop();
  }
}
```

### Key design decisions in TelegramChannel

- **IPv4 forced**: `new https.Agent({ family: 4 })` passed to grammy's client config. Node.js sometimes tries IPv6 first for `api.telegram.org`, which fails on many networks.
- **4096-char splitting**: Telegram rejects messages over 4096 characters. `sendMessage()` splits at the boundary.
- **Typing timer**: Unlike WhatsApp (single presence update), Telegram's typing indicator expires after 5 seconds. The channel maintains a `Map<string, Timeout>` of repeating 4.5s timers, cleaned up on `setTyping(jid, false)` or `disconnect()`.
- **Bot message detection**: `msg.from.id === botId` reliably identifies the bot's own messages. No need for content prefix heuristics.
- **Single-user mode**: Messages from chats other than `OWNER_CHAT_JID` are silently dropped in `handleMessage()`. No trigger patterns needed.

## 4. Update Configuration

Edit `src/config.ts`:

### 4a. Add OWNER_CHAT_JID

Add the owner chat ID configuration. This replaces the multi-group trigger pattern system:

```typescript
export const OWNER_CHAT_JID =
  process.env.OWNER_CHAT_JID || envConfig.OWNER_CHAT_JID || '';
```

Add `'OWNER_CHAT_JID'` and `'TELEGRAM_BOT_TOKEN'` to the `readEnvFile()` call:

```typescript
const envConfig = readEnvFile(['ASSISTANT_NAME', 'OWNER_CHAT_JID', 'TELEGRAM_BOT_TOKEN']);
```

### 4b. Add TELEGRAM_BOT_TOKEN reader

```typescript
export const TELEGRAM_BOT_TOKEN =
  process.env.TELEGRAM_BOT_TOKEN || envConfig.TELEGRAM_BOT_TOKEN || '';
```

### 4c. Remove ASSISTANT_HAS_OWN_NUMBER

Delete the `ASSISTANT_HAS_OWN_NUMBER` config. This was a WhatsApp-specific concept (shared vs dedicated phone number). In Telegram, the bot always has its own identity.

### 4d. Optionally remove TRIGGER_PATTERN

In single-user mode, all messages from OWNER_CHAT_JID are processed without triggers. The `TRIGGER_PATTERN` and `POLL_INTERVAL` can be removed if you don't need multi-group support. If you want to keep multi-group as a future option, leave them.

## 5. Update Main Application

Edit `src/index.ts`. The changes here are minimal because the Channel abstraction isolates most IM-specific logic.

### 5a. Replace channel import and instantiation

Replace:
```typescript
import { WhatsAppChannel } from './channels/whatsapp.js';
```

With:
```typescript
import { TelegramChannel } from './channels/telegram.js';
```

Replace:
```typescript
let whatsapp: WhatsAppChannel;
```

With:
```typescript
let channel: TelegramChannel;
```

### 5b. Update channel creation in main()

Replace the WhatsAppChannel construction:
```typescript
whatsapp = new WhatsAppChannel({
  onMessage: (chatJid, msg) => storeMessage(msg),
  onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
  registeredGroups: () => registeredGroups,
});
```

With TelegramChannel construction:
```typescript
import { OWNER_CHAT_JID, TELEGRAM_BOT_TOKEN } from './config.js';

channel = new TelegramChannel({
  token: TELEGRAM_BOT_TOKEN,
  ownerChatJid: OWNER_CHAT_JID,
  onMessage: (chatJid, msg) => {
    storeMessage(msg);
    queue.enqueueMessageCheck(chatJid);
  },
  onChatMetadata: (chatJid, timestamp) => storeChatMetadata(chatJid, timestamp),
});
```

Note the key difference: `onMessage` now calls `queue.enqueueMessageCheck(chatJid)` directly. This is event-driven processing -- no polling loop needed.

### 5c. Update all whatsapp references to channel

Replace all `whatsapp.sendMessage(`, `whatsapp.setTyping(`, `whatsapp.disconnect()`, `whatsapp.connect()`, `whatsapp.syncGroupMetadata(` with `channel.sendMessage(`, `channel.setTyping(`, etc.

### 5d. Remove the polling message loop

Delete `startMessageLoop()` entirely. In the Telegram architecture, messages arrive via grammy's event-driven long polling and are immediately enqueued via the `onMessage` callback. There is no need for a `POLL_INTERVAL`-based polling loop.

Also remove the `lastTimestamp` variable and its save/load from `loadState()`/`saveState()` -- it was only needed for the polling loop's cursor.

Remove `messageLoopRunning` guard.

### 5e. Remove getAvailableGroups group filter

In `getAvailableGroups()`, update the filter. WhatsApp used JID suffix matching:

```typescript
// Before:
.filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))

// After (for single-user, all chats are valid):
.filter((c) => c.jid !== '__group_sync__')
```

### 5f. Simplify processGroupMessages

For single-user mode, remove the trigger detection logic:

```typescript
// Remove this block (no trigger patterns in single-user mode):
if (!isMainGroup && group.requiresTrigger !== false) {
  const hasTrigger = missedMessages.some((m) =>
    TRIGGER_PATTERN.test(m.content.trim()),
  );
  if (!hasTrigger) return true;
}
```

### 5g. Update shutdown handler

```typescript
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  await queue.shutdown(10000);
  await channel.disconnect();
  process.exit(0);
};
```

### 5h. Remove syncGroupMetadata from IPC watcher

The `TelegramChannel` does not have a `syncGroupMetadata()` method (Telegram doesn't have a bulk group-fetch API like WhatsApp). Remove it from the `startIpcWatcher()` deps, or provide a no-op.

### 5i. Remove startMessageLoop() call

In `main()`, delete the call to `startMessageLoop()` at the bottom. The event-driven `onMessage` -> `enqueueMessageCheck` replaces it.

## 6. Update Database Layer

Edit `src/db.ts`:

### 6a. Remove storeMessageDirect

The `storeMessageDirect()` function was added as a transitional helper. Now that `storeMessage()` already takes a `NewMessage` object (not a Baileys proto), `storeMessageDirect` is redundant. Delete it.

### 6b. Remove Baileys-specific bot message backfill

In `createSchema()`, the migration that backfills `is_bot_message` using the `ASSISTANT_NAME:` content prefix is WhatsApp-specific. In Telegram, bot messages are reliably detected via `from.id === botId`. You can keep the migration for backwards compatibility with existing databases, but new installations won't need it.

## 7. Update IPC MCP

Edit `container/agent-runner/src/ipc-mcp-stdio.ts`:

### 7a. Update register_group tool

Replace WhatsApp-specific descriptions:

```typescript
// Before:
'Register a new WhatsApp group so the agent can respond to messages there.'
// After:
'Register a new Telegram group/chat so the agent can respond to messages there.'

// Before:
'Use available_groups.json to find the JID for a group.'
// After:
'Use available_groups.json to find the chat ID for a group/chat.'

// Before:
jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")')
// After:
jid: z.string().describe('The Telegram chat ID (e.g., "-1001234567890" for groups, "123456789" for private chats)')
```

## 8. Update Group CLAUDE.md

Edit `groups/main/CLAUDE.md`:

### 8a. Replace formatting section

Replace the "WhatsApp Formatting" section with:

```markdown
## Telegram Formatting

Telegram supports these text formats (MarkdownV2):
- *Bold* (asterisks)
- _Italic_ (underscores)
- `Code` (backticks)
- ```Code blocks``` (triple backticks)
- ~Strikethrough~ (tildes)

Keep messages clean and readable. Telegram has a 4096-character message limit; longer messages are automatically split.
```

### 8b. Update JID examples

Replace all WhatsApp JID examples:
- `120363336345536173@g.us` -> `-1001234567890`
- `1234567890@s.whatsapp.net` -> `123456789`
- Any `@g.us` or `@s.whatsapp.net` references -> numeric string IDs

### 8c. Update text references

- "WhatsApp" -> "Telegram"
- Explain that chat IDs are negative for groups, positive for private chats

## 9. Update Container Configuration

No changes needed to the container itself. The agent runner (`container/agent-runner/src/index.ts`) and container infrastructure are IM-agnostic:

- **Apple Container** commands (`container build`, `container run`, `container stop`) are unchanged
- **Streaming output** with OUTPUT_START/END markers is unchanged
- **Multi-turn IPC** (input polling via `/workspace/ipc/input/`) is unchanged
- **MCP server** (`ipc-mcp-stdio.ts`) runs as a standalone stdio process, unchanged
- **Agent Teams** (Task, TeamCreate tools) work the same way
- **Dockerfile** and `build.sh` are unchanged

## 10. Environment Setup

Add Telegram-specific variables to `.env`:

```
TELEGRAM_BOT_TOKEN=your-bot-token-here
OWNER_CHAT_JID=your-chat-id-here
ASSISTANT_NAME=Cal
```

To find your `OWNER_CHAT_JID`:
1. Run `npm run auth` to verify the bot token works
2. Send any message to your bot in Telegram
3. Run `npm run dev` and check the logs -- the chat ID will appear
4. Add it to `.env` as `OWNER_CHAT_JID`

The old `store/auth/` directory (WhatsApp credentials) can be deleted.

## 11. Update Documentation

### 11a. `CLAUDE.md`

Update the architecture overview:
- "Telegram <-> grammy Bot (long polling)" instead of WhatsApp
- `src/channels/telegram.ts` instead of `src/channels/whatsapp.ts`
- Add `OWNER_CHAT_JID` and `TELEGRAM_BOT_TOKEN` to environment variables table
- Remove `ASSISTANT_HAS_OWN_NUMBER`
- Update Key Files table: `src/channels/telegram.ts` | Telegram bot (Channel implementation)

### 11b. `README.md`

Update:
- "Telegram Bot I/O" instead of "WhatsApp I/O"
- Architecture diagram: "Telegram Bot (grammy)" with long polling
- Remove references to QR code auth, Baileys, polling loop

### 11c. `docs/REQUIREMENTS.md`

Update:
- "I use Telegram" instead of "I use WhatsApp"
- "grammy library" instead of "baileys library"
- "Bot token authentication" instead of "QR code authentication"
- "Event-driven processing via long polling" instead of "polled by router"

### 11d. `docs/SECURITY.md`

Update:
- "Telegram messages" instead of "WhatsApp messages"
- "Telegram Bot Token | .env file" instead of "WhatsApp Session | store/auth/"
- Trust boundary diagram

## 12. Update Skills

### 12a. `.claude/skills/setup/SKILL.md`

Replace Section 5 "WhatsApp Authentication" with "Telegram Bot Authentication":
- Replace QR code instructions with @BotFather token setup
- Add OWNER_CHAT_JID discovery steps
- Add privacy mode note for group usage

### 12b. `.claude/skills/debug/SKILL.md`

Update:
- "Host-side Telegram bot" instead of "Host-side WhatsApp"
- "Outgoing Telegram messages" instead of "Outgoing WhatsApp messages"

### 12c. `.claude/skills/customize/SKILL.md`

Update:
- Key files: `src/channels/telegram.ts` instead of `src/channels/whatsapp.ts`
- Channel examples reference TelegramChannel and Channel interface

## 13. Build and Verify

```bash
npm run build
```

Test authentication:
```bash
npm run auth
```

Expected: "Telegram bot authenticated!" with bot username and ID.

## 14. Test

```bash
npm run dev
```

Send a message to the bot in Telegram. Verify:
- Bot shows typing indicator (repeating every 4.5s)
- Response arrives within container timeout
- Message appears in `store/messages.db`
- Container logs appear in `groups/main/logs/`

## Troubleshooting

### IPv6 Connectivity Issues

If `npm run auth` or `npm run dev` fails with `ETIMEDOUT` or `EHOSTUNREACH`, the IPv4 agent should already handle this. Verify that `TelegramChannel` creates the bot with:
```typescript
const ipv4Agent = new https.Agent({ family: 4 });
this.bot = new Bot(opts.token, {
  client: { baseFetchConfig: { agent: ipv4Agent } },
});
```

### Bot not receiving messages in groups

Disable privacy mode in @BotFather:
1. Message @BotFather
2. Send `/setprivacy`
3. Select your bot
4. Choose **Disable**

Note: In single-user mode with a private chat, privacy mode doesn't matter.

### OWNER_CHAT_JID not set

If the bot receives messages but doesn't process them, check that `OWNER_CHAT_JID` in `.env` matches the chat ID in the logs. For private chats, this is a positive number. For groups, it's negative.

## Summary of Changed Files

| File | Type of Change |
|------|----------------|
| `package.json` | Dependencies: baileys/qrcode -> grammy; auth script path |
| `src/whatsapp-auth.ts` | Deleted |
| `src/telegram-auth.ts` | Created: bot token verification with IPv4 |
| `src/channels/whatsapp.ts` | Deleted |
| `src/channels/whatsapp.test.ts` | Deleted |
| `src/channels/telegram.ts` | Created: TelegramChannel implementing Channel interface |
| `src/config.ts` | Add OWNER_CHAT_JID, TELEGRAM_BOT_TOKEN; remove ASSISTANT_HAS_OWN_NUMBER |
| `src/index.ts` | Replace WhatsAppChannel with TelegramChannel; remove polling loop; event-driven enqueue |
| `src/db.ts` | Remove storeMessageDirect (redundant) |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Update register_group descriptions (WhatsApp -> Telegram) |
| `groups/main/CLAUDE.md` | Formatting, JID examples, Telegram references |
| `CLAUDE.md` | Architecture overview, key files, env vars |
| `README.md` | Description, architecture diagram |
| `docs/REQUIREMENTS.md` | Vision, architecture decisions |
| `docs/SECURITY.md` | Trust boundaries, credential storage |
| `.claude/skills/setup/SKILL.md` | Auth flow (BotFather + OWNER_CHAT_JID) |
| `.claude/skills/debug/SKILL.md` | Log descriptions |
| `.claude/skills/customize/SKILL.md` | Channel file references |
