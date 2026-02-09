---
name: migrate-to-telegram
description: Migrate NanoClaw from WhatsApp (Baileys) to Telegram Bot (grammy). Replaces the IM layer while keeping all other functionality intact. Use when user wants to switch from WhatsApp to Telegram.
disable-model-invocation: true
---

# Migrate to Telegram

This skill transforms NanoClaw from WhatsApp (using Baileys) to Telegram Bot API (using grammy).

**What changes:**
- IM library: `@whiskeysockets/baileys` + `qrcode-terminal` → `grammy`
- Auth: QR code scan → Bot token from @BotFather
- Message handling: Polling loop → Event-driven (grammy long polling)
- Chat IDs: `number@s.whatsapp.net` / `number@g.us` → Numeric IDs (negative for groups, positive for private)
- Typing indicator: Single presence update → Repeating timer (Telegram expires after 5s)
- Message limits: None → 4096-char split
- Auth script: `src/whatsapp-auth.ts` → `src/telegram-auth.ts`

**What stays the same:**
- Container runtime (Apple Container / Docker)
- Agent runner (Claude Agent SDK)
- SQLite database schema (same columns, different ID format)
- IPC system, scheduler, mount security
- Group memory and CLAUDE.md hierarchy
- All MCP tools

## 1. Update Dependencies

Edit `package.json`:

### 1a. Remove WhatsApp dependencies

Remove from `dependencies`:
```json
"@whiskeysockets/baileys": "^7.0.0-rc.9",
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

The original project didn't need `.env` because WhatsApp used QR code auth and Claude CLI managed its own credentials. Telegram requires a `TELEGRAM_BOT_TOKEN` env var, and the Agent SDK in the container needs `CLAUDE_CODE_OAUTH_TOKEN`. Since Node.js and tsx don't auto-load `.env` files, use the `--env-file=.env` flag (Node.js 20.6+):

```json
"scripts": {
  "start": "node --env-file=.env dist/index.js",
  "dev": "node --env-file=.env node_modules/.bin/tsx src/index.ts",
  "auth": "node --env-file=.env node_modules/.bin/tsx src/telegram-auth.ts"
}
```

**Why `node --env-file=.env node_modules/.bin/tsx`** instead of just `tsx`? The `--env-file` flag is a Node.js flag. By invoking tsx through `node`, we get both the flag and tsx's TypeScript support.

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
 * Set TELEGRAM_BOT_TOKEN as an environment variable.
 *
 * Usage: TELEGRAM_BOT_TOKEN=your-token npx tsx src/telegram-auth.ts
 */
import { Bot } from 'grammy';

async function authenticate(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
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

  const bot = new Bot(token);
  const me = await bot.api.getMe();

  console.log(`\n\u2713 Telegram bot authenticated!`);
  console.log(`  Bot: @${me.username} (${me.first_name})`);
  console.log(`  ID: ${me.id}\n`);
  console.log(`  You can now start NanoClaw with: npm run dev\n`);
}

authenticate().catch((err) => {
  console.error('Authentication failed:', err.message);
  process.exit(1);
});
```

## 3. Update Configuration

Edit `src/config.ts`:

### 3a. Remove POLL_INTERVAL

Delete this line (no longer needed — grammy uses event-driven processing):
```typescript
export const POLL_INTERVAL = 2000;
```

## 4. Update Database Layer

Edit `src/db.ts`:

### 4a. Remove Baileys import

Delete:
```typescript
import { proto } from '@whiskeysockets/baileys';
```

### 4b. Replace storeMessage function signature

Find the `storeMessage` function and replace its signature and message extraction logic. The function should take plain parameters instead of a Baileys message object:

```typescript
export function storeMessage(
  msgId: string,
  chatJid: string,
  sender: string,
  senderName: string,
  content: string,
  timestamp: string,
  isFromMe: boolean,
): void {
  db.prepare(
    `INSERT OR REPLACE INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    // ... keep existing .run() arguments using the new parameters
  );
}
```

Remove the old message extraction logic that parsed `msg.message?.conversation`, `msg.message?.extendedTextMessage?.text`, etc.

## 5. Rewrite Main Application

Edit `src/index.ts`. This is the largest change.

### 5a. Replace imports

Remove:
```typescript
import { exec, execSync } from 'child_process';
import makeWASocket, {
  DisconnectReason,
  WASocket,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';
```

Replace with:
```typescript
import { execSync } from 'child_process';
import { Bot } from 'grammy';
```

Remove these from the config imports (no longer needed):
```typescript
POLL_INTERVAL,
STORE_DIR,
```

Remove `getNewMessages` from db.ts imports (no longer needed).

### 5b. Replace module-level variables

Remove:
```typescript
let sock: WASocket;
let lastTimestamp = '';
let lidToPhoneMap: Record<string, string> = {};
let messageLoopRunning = false;
```

Replace with:
```typescript
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

let bot: Bot;
let botUsername = '';
```

### 5c. Replace typing indicator

Remove `translateJid()` and `setTyping()` functions.

Add:
```typescript
/**
 * Start a repeating typing indicator for Telegram.
 * Telegram's "typing" action expires after 5 seconds, so we resend every 4.5s.
 * Returns the interval handle for cleanup.
 */
function startTypingLoop(chatId: string): NodeJS.Timeout {
  const send = () => {
    bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {});
  };
  send();
  return setInterval(send, 4500);
}
```

### 5d. Update loadState and saveState

In `loadState()`, remove:
```typescript
lastTimestamp = getRouterState('last_timestamp') || '';
```

In `saveState()`, remove:
```typescript
setRouterState('last_timestamp', lastTimestamp);
```

### 5e. Update syncGroupMetadata

Replace the sync logic. Instead of `sock.groupFetchAllParticipating()`, iterate registered groups and call `bot.api.getChat()`:

```typescript
async function syncGroupMetadata(force = false): Promise<void> {
  // ... keep the force/cache check logic ...

  try {
    logger.info('Syncing group metadata from Telegram...');
    let count = 0;
    for (const chatId of Object.keys(registeredGroups)) {
      try {
        const chat = await bot.api.getChat(Number(chatId));
        const title =
          'title' in chat
            ? chat.title
            : 'first_name' in chat
              ? chat.first_name
              : undefined;
        if (title) {
          updateChatName(chatId, title);
          count++;
        }
      } catch {
        /* chat may no longer be accessible */
      }
    }
    // ... keep the rest (setLastGroupSync, logger) ...
  }
}
```

### 5f. Update getAvailableGroups filter

Change group detection from JID suffix to numeric comparison:

```typescript
// Before:
.filter((c) => c.jid !== '__group_sync__' && c.jid.endsWith('@g.us'))

// After:
.filter((c) => c.jid !== '__group_sync__' && Number(c.jid) < 0)
```

### 5g. Update trigger detection

In `processGroupMessages`, add `@botusername` mention detection alongside `TRIGGER_PATTERN`:

```typescript
const hasTrigger = missedMessages.some((m) => {
  const text = m.content.trim();
  if (TRIGGER_PATTERN.test(text)) return true;
  // Also check for Telegram @botusername mention
  if (
    botUsername &&
    text.toLowerCase().includes(`@${botUsername.toLowerCase()}`)
  )
    return true;
  return false;
});
```

### 5h. Update typing calls in processGroupMessages

Replace:
```typescript
await setTyping(chatJid, true);
const response = await runAgent(group, prompt, chatJid);
await setTyping(chatJid, false);
```

With:
```typescript
const typingTimer = startTypingLoop(chatJid);
const response = await runAgent(group, prompt, chatJid);
clearInterval(typingTimer);
```

### 5i. Replace sendMessage

Replace with Telegram message sending with 4096-char splitting:

```typescript
async function sendMessage(chatId: string, text: string): Promise<void> {
  try {
    if (text.length <= TELEGRAM_MAX_MESSAGE_LENGTH) {
      await bot.api.sendMessage(Number(chatId), text);
    } else {
      for (let i = 0; i < text.length; i += TELEGRAM_MAX_MESSAGE_LENGTH) {
        await bot.api.sendMessage(
          Number(chatId),
          text.slice(i, i + TELEGRAM_MAX_MESSAGE_LENGTH),
        );
      }
    }
    logger.info({ chatId, length: text.length }, 'Message sent');
  } catch (err) {
    logger.error({ chatId, err }, 'Failed to send message');
  }
}
```

### 5j. Replace connectWhatsApp with startTelegramBot

Delete `connectWhatsApp()` and `startMessageLoop()` entirely.

Create `startTelegramBot()`:

```typescript
async function startTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error(
      'TELEGRAM_BOT_TOKEN environment variable is required. Run /setup in Claude Code.',
    );
    process.exit(1);
  }

  bot = new Bot(token);

  // Verify token and get bot info
  const botInfo = await bot.api.getMe();
  botUsername = botInfo.username || '';
  logger.info({ botUsername, botId: botInfo.id }, 'Telegram bot authenticated');

  // Handle text messages
  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const msg = ctx.message;

    const timestamp = new Date(msg.date * 1000).toISOString();
    const sender = String(msg.from?.id || '');
    const senderName =
      msg.from?.first_name ||
      msg.from?.username ||
      sender;
    const content = msg.text || '';
    const isFromMe = msg.from?.id === botInfo.id;
    const msgId = String(msg.message_id);

    const chatTitle =
      'title' in ctx.chat ? ctx.chat.title : undefined;

    // Always store chat metadata for group discovery
    storeChatMetadata(chatId, timestamp, chatTitle);

    // Only store full message content for registered groups
    if (registeredGroups[chatId]) {
      storeMessage(msgId, chatId, sender, senderName, content, timestamp, isFromMe);
      // Immediately enqueue for processing (no polling loop needed)
      queue.enqueueMessageCheck(chatId);
    }
  });

  // Handle media with captions
  bot.on('message:caption', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const msg = ctx.message;

    const timestamp = new Date(msg.date * 1000).toISOString();
    const sender = String(msg.from?.id || '');
    const senderName =
      msg.from?.first_name ||
      msg.from?.username ||
      sender;
    const content = msg.caption || '';
    const isFromMe = msg.from?.id === botInfo.id;
    const msgId = String(msg.message_id);

    const chatTitle =
      'title' in ctx.chat ? ctx.chat.title : undefined;

    storeChatMetadata(chatId, timestamp, chatTitle);

    if (registeredGroups[chatId]) {
      storeMessage(msgId, chatId, sender, senderName, content, timestamp, isFromMe);
      queue.enqueueMessageCheck(chatId);
    }
  });

  // Handle bot being added to / removed from groups (group discovery)
  bot.on('my_chat_member', async (ctx) => {
    const chatId = String(ctx.chat.id);
    const chatTitle =
      'title' in ctx.chat ? ctx.chat.title : 'Private Chat';
    const newStatus = ctx.myChatMember.new_chat_member.status;

    if (newStatus === 'member' || newStatus === 'administrator') {
      storeChatMetadata(chatId, new Date().toISOString(), chatTitle);
      logger.info({ chatId, chatTitle }, 'Bot added to chat');
    } else if (newStatus === 'left' || newStatus === 'kicked') {
      logger.info({ chatId, chatTitle }, 'Bot removed from chat');
    }
  });

  // Error handling
  bot.catch((err) => {
    logger.error({ err: err.error }, 'Telegram bot error');
  });

  // Start subsystems
  syncGroupMetadata().catch((err) =>
    logger.error({ err }, 'Initial group sync failed'),
  );
  if (!groupSyncTimerStarted) {
    groupSyncTimerStarted = true;
    setInterval(() => {
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Periodic group sync failed'),
      );
    }, GROUP_SYNC_INTERVAL_MS);
  }

  startSchedulerLoop({
    sendMessage,
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName) =>
      queue.registerProcess(groupJid, proc, containerName),
  });
  startIpcWatcher();
  queue.setProcessMessagesFn(processGroupMessages);
  recoverPendingMessages();

  // Start long polling (grammy handles reconnection automatically)
  logger.info(`NanoClaw running (Telegram bot: @${botUsername}, trigger: @${ASSISTANT_NAME})`);
  bot.start();
}
```

### 5k. Update main() function

In `main()`:

Add `bot.stop()` to the shutdown handler:
```typescript
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  if (bot) bot.stop();
  await queue.shutdown(10000);
  process.exit(0);
};
```

Replace:
```typescript
await connectWhatsApp();
```
With:
```typescript
await startTelegramBot();
```

## 6. Update IPC MCP

Edit `container/agent-runner/src/ipc-mcp.ts`:

Update the `register_group` tool description:

```typescript
// Before:
'Register a new WhatsApp group so the agent can respond to messages there.'
// After:
'Register a new Telegram group/chat so the agent can respond to messages there.'

// Before:
'Use available_groups.json to find the JID for a group.'
// After:
'Use available_groups.json to find the chat ID for a group.'

// Before:
jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")')
// After:
jid: z.string().describe('The Telegram chat ID (e.g., "-1001234567890" for groups, "123456789" for private chats)')
```

## 7. Update Group CLAUDE.md

Edit `groups/main/CLAUDE.md`:

### 7a. Replace formatting section

Replace the "WhatsApp Formatting" section with:

```markdown
## Telegram Formatting

Telegram supports these text formats:
- *Bold* (asterisks)
- _Italic_ (underscores)
- `Code` (backticks)
- ```Code blocks``` (triple backticks)
- ~Strikethrough~ (tildes)

Keep messages clean and readable for Telegram.
```

### 7b. Update JID examples

Replace all WhatsApp JID examples:
- `120363336345536173@g.us` → `-1001234567890`
- `1234567890-1234567890@g.us` → `-1001234567890`
- `1234567890@g.us` → `-1009876543210`

### 7c. Update group discovery queries

Replace:
```sql
WHERE jid LIKE '%@g.us' AND jid != '__group_sync__'
```
With:
```sql
WHERE CAST(jid AS INTEGER) < 0 AND jid != '__group_sync__'
```

### 7d. Update text references

- "WhatsApp" → "Telegram"
- "Synced from WhatsApp daily" → "Synced from Telegram daily"
- Explain that chat IDs are negative for groups, positive for private chats

## 8. Update Documentation

### 8a. `CLAUDE.md`

Update:
- Quick Context: "connects to WhatsApp" → "connects to Telegram via bot API"
- Key Files: "WhatsApp connection" → "Telegram bot"

### 8b. `README.md`

Update:
- "WhatsApp I/O" → "Telegram Bot I/O"
- Architecture diagram: "WhatsApp (baileys)" → "Telegram Bot (grammy)", "Polling loop" → "Event-driven queue"
- FAQ: "Why WhatsApp" → "Why Telegram"
- RFS: "/add-telegram" → "/add-whatsapp"
- All WhatsApp references

### 8c. `docs/REQUIREMENTS.md`

Update:
- "I use WhatsApp" → "I use Telegram"
- "baileys library" → "grammy library"
- "QR code authentication" → "Bot token authentication"
- "Messages stored in SQLite, polled by router" → "Messages stored in SQLite, event-driven processing via long polling"

### 8d. `docs/SPEC.md`

Update:
- Architecture diagram: WhatsApp → Telegram Bot, Message Loop → Event Handler
- Tech stack table
- File structure: `whatsapp-auth.ts` → `telegram-auth.ts`, remove `store/auth/`
- Config: remove `POLL_INTERVAL`
- Message flow: Remove polling step, describe event-driven flow
- All WhatsApp references

### 8e. `docs/SECURITY.md`

Update:
- "WhatsApp messages" → "Telegram messages"
- "WhatsApp Session | store/auth/" → "Telegram Bot Token | .env file"
- Trust boundary diagram

## 9. Update Skills

### 9a. `.claude/skills/setup/SKILL.md`

Replace Section 5 "WhatsApp Authentication" with "Telegram Bot Authentication":
- Replace QR code instructions with @BotFather token setup
- Update main channel options (private chat instead of self-chat)
- Update group discovery queries to use numeric IDs
- Add privacy mode note

### 9b. `.claude/skills/debug/SKILL.md`

Update:
- "Host-side WhatsApp" → "Host-side Telegram bot"
- "Outgoing WhatsApp messages" → "Outgoing Telegram messages"
- "WhatsApp groups" → "Telegram groups"

### 9c. `.claude/skills/customize/SKILL.md`

Update:
- Key files: `whatsapp-auth.ts` → `telegram-auth.ts`
- "WhatsApp connection" → "Telegram bot"
- Channel examples: Telegram → WhatsApp (since Telegram is now default)

### 9d. `.claude/skills/add-gmail/SKILL.md`

Update references:
- "triggered from WhatsApp" → "triggered from Telegram"
- "WhatsApp main channel" → "Telegram main channel"
- "`connectWhatsApp`" → "`startTelegramBot`"

## 10. Environment Setup

Create `.env` in the project root with both tokens:

```
TELEGRAM_BOT_TOKEN=your-bot-token-here
CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token-here
```

The `--env-file=.env` flag added to npm scripts in Step 1c ensures these are loaded before any application code runs.

Also update the launchd plist template (`launchd/com.nanoclaw.plist`) to include `--env-file=.env` in `ProgramArguments`:

```xml
<key>ProgramArguments</key>
<array>
    <string>{{NODE_PATH}}</string>
    <string>--env-file=.env</string>
    <string>{{PROJECT_ROOT}}/dist/index.js</string>
</array>
```

The old `store/auth/` directory (WhatsApp credentials) can be deleted.

## 11. Build and Verify

```bash
npm run build
```

Test authentication:
```bash
npm run auth
```

Expected: "Telegram bot authenticated!" with bot username and ID.

## 12. Test

```bash
npm run dev
```

Send a message to the bot in Telegram. Verify:
- Bot shows typing indicator
- Response arrives within 30 seconds
- Message appears in `store/messages.db`

## Troubleshooting

### IPv6 Connectivity Issues

If `npm run auth` or `npm run dev` fails with `ETIMEDOUT` or `EHOSTUNREACH` but `curl` to the Telegram API works, Node.js may be trying IPv6 first. Fix by forcing IPv4:

In `src/index.ts`, add import and configure the Bot:
```typescript
import https from 'https';

// In startTelegramBot():
const ipv4Agent = new https.Agent({ family: 4 });
bot = new Bot(token, {
  client: { baseFetchConfig: { agent: ipv4Agent } },
});
```

Apply the same fix in `src/telegram-auth.ts`.

### Bot not receiving messages in groups

Disable privacy mode in @BotFather:
1. Message @BotFather
2. Send `/setprivacy`
3. Select your bot
4. Choose **Disable**

### .env not loaded

If `TELEGRAM_BOT_TOKEN not set` after migration, verify the npm scripts have `--env-file=.env` (Step 1c). The original WhatsApp-based project didn't need this because it used QR code auth and the Claude CLI managed its own credentials. For Node.js < 20.6, use `dotenv-cli` instead (`npm i -D dotenv-cli`, then `dotenv -- tsx ...`).

## Summary of Changed Files

| File | Type of Change |
|------|----------------|
| `package.json` | Dependencies: baileys/qrcode → grammy; scripts: add `--env-file=.env` |
| `launchd/com.nanoclaw.plist` | Add `--env-file=.env` to ProgramArguments |
| `src/whatsapp-auth.ts` | Deleted |
| `src/telegram-auth.ts` | Created: bot token verification |
| `src/config.ts` | Remove POLL_INTERVAL |
| `src/db.ts` | Remove baileys import, plain params for storeMessage |
| `src/index.ts` | Full rewrite: WhatsApp → Telegram Bot with grammy |
| `container/agent-runner/src/ipc-mcp.ts` | Update register_group descriptions |
| `groups/main/CLAUDE.md` | Formatting, JID examples, queries |
| `CLAUDE.md` | Quick context |
| `README.md` | Description, architecture, FAQ |
| `docs/REQUIREMENTS.md` | Vision, architecture decisions |
| `docs/SPEC.md` | Architecture diagram, tech stack, message flow |
| `docs/SECURITY.md` | Trust boundaries |
| `.claude/skills/setup/SKILL.md` | Auth flow, channel setup |
| `.claude/skills/debug/SKILL.md` | Log descriptions |
| `.claude/skills/customize/SKILL.md` | File references, examples |
| `.claude/skills/add-gmail/SKILL.md` | Channel references |
