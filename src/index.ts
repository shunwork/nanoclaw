import { execSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';

import { Bot } from 'grammy';
import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  OWNER_CHAT_JID,
  TIMEZONE,
} from './config.js';
import {
  AgentResponse,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  createTask,
  deleteTask,
  ensureChat,
  getAllTasks,
  getMessagesSince,
  getRouterState,
  getSession,
  getTaskById,
  initDatabase,
  setRouterState,
  setSession,
  storeMessage,
  updateTask,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { OwnerConfig } from './types.js';
import { logger } from './logger.js';

const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;

let bot: Bot;
let botUsername = '';
let sessionId: string | undefined;
let lastAgentTimestamp = '';
let ipcWatcherRunning = false;

const queue = new GroupQueue();

// Single owner config — no multi-group registration needed
const ownerConfig: OwnerConfig = {
  chatJid: OWNER_CHAT_JID,
  folder: 'main',
};

/**
 * Start a repeating typing indicator for Telegram.
 * Telegram's "typing" action expires after 5 seconds, so we resend every 4.5s.
 */
function startTypingLoop(chatId: string): NodeJS.Timeout {
  const send = () => {
    bot.api.sendChatAction(Number(chatId), 'typing').catch(() => {});
  };
  send();
  return setInterval(send, 4500);
}

function loadState(): void {
  const agentTs = getRouterState('last_agent_timestamp');
  if (agentTs) {
    // Migrate from multi-group format (JSON object) to single string
    try {
      const parsed = JSON.parse(agentTs);
      if (typeof parsed === 'object' && parsed !== null) {
        // Old format: { "chatJid": "timestamp" }
        lastAgentTimestamp = parsed[OWNER_CHAT_JID] || '';
      } else {
        lastAgentTimestamp = agentTs;
      }
    } catch {
      lastAgentTimestamp = agentTs;
    }
  }
  sessionId = getSession('main');
  logger.info('State loaded');
}

function saveState(): void {
  setRouterState('last_agent_timestamp', lastAgentTimestamp);
}

/**
 * Process all pending messages.
 * Called by the queue when it's time to process.
 */
async function processMessages(chatJid: string): Promise<boolean> {
  const missedMessages = getMessagesSince(
    chatJid,
    lastAgentTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  const lines = missedMessages.map((m) => {
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`;
  });
  const prompt = `<messages>\n${lines.join('\n')}\n</messages>`;

  logger.info(
    { messageCount: missedMessages.length },
    'Processing messages',
  );

  const typingTimer = startTypingLoop(chatJid);
  const response = await runAgent(prompt, chatJid);
  clearInterval(typingTimer);

  if (response === 'error') {
    return false;
  }

  lastAgentTimestamp =
    missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  if (response.outputType === 'message' && response.userMessage) {
    await sendMessage(chatJid, response.userMessage);
  }

  if (response.internalLog) {
    logger.info(
      { outputType: response.outputType },
      `Agent: ${response.internalLog}`,
    );
  }

  return true;
}

async function runAgent(
  prompt: string,
  chatJid: string,
): Promise<AgentResponse | 'error'> {
  // Update tasks snapshot for container to read
  const tasks = getAllTasks();
  writeTasksSnapshot(
    'main',
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  try {
    const output = await runContainerAgent(
      ownerConfig,
      {
        prompt,
        sessionId,
        groupFolder: 'main',
        chatJid,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName),
    );

    if (output.newSessionId) {
      sessionId = output.newSessionId;
      setSession('main', output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return output.result ?? { outputType: 'log' };
  } catch (err) {
    logger.error({ err }, 'Agent error');
    return 'error';
  }
}

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

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcDir = path.join(DATA_DIR, 'ipc', 'main');
  fs.mkdirSync(path.join(ipcDir, 'messages'), { recursive: true });
  fs.mkdirSync(path.join(ipcDir, 'tasks'), { recursive: true });

  const messagesDir = path.join(ipcDir, 'messages');
  const tasksDir = path.join(ipcDir, 'tasks');

  const processIpcFiles = async () => {
    // Process messages
    try {
      const messageFiles = fs
        .readdirSync(messagesDir)
        .filter((f) => f.endsWith('.json'));
      for (const file of messageFiles) {
        const filePath = path.join(messagesDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          if (data.type === 'message' && data.text) {
            const targetJid = data.chatJid || OWNER_CHAT_JID;
            await sendMessage(targetJid, data.text);
            logger.info({ chatJid: targetJid }, 'IPC message sent');
          }
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, err }, 'Error processing IPC message');
          const errorDir = path.join(DATA_DIR, 'ipc', 'errors');
          fs.mkdirSync(errorDir, { recursive: true });
          fs.renameSync(filePath, path.join(errorDir, `main-${file}`));
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading IPC messages directory');
    }

    // Process tasks
    try {
      const taskFiles = fs
        .readdirSync(tasksDir)
        .filter((f) => f.endsWith('.json'));
      for (const file of taskFiles) {
        const filePath = path.join(tasksDir, file);
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          await processTaskIpc(data);
          fs.unlinkSync(filePath);
        } catch (err) {
          logger.error({ file, err }, 'Error processing IPC task');
          const errorDir = path.join(DATA_DIR, 'ipc', 'errors');
          fs.mkdirSync(errorDir, { recursive: true });
          fs.renameSync(filePath, path.join(errorDir, `main-${file}`));
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error reading IPC tasks directory');
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
  },
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value) {
        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: 'main',
          chat_jid: OWNER_CHAT_JID,
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info({ taskId, contextMode }, 'Task created via IPC');
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info({ taskId: data.taskId }, 'Task paused via IPC');
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task) {
          updateTask(data.taskId, { status: 'active' });
          logger.info({ taskId: data.taskId }, 'Task resumed via IPC');
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task) {
          deleteTask(data.taskId);
          logger.info({ taskId: data.taskId }, 'Task cancelled via IPC');
        }
      }
      break;

    case 'new_session':
      sessionId = undefined;
      setSession('main', '');
      logger.info('Session reset via IPC');
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}

async function startTelegramBot(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    logger.error(
      'TELEGRAM_BOT_TOKEN environment variable is required. Run /setup in Claude Code.',
    );
    process.exit(1);
  }

  if (!OWNER_CHAT_JID) {
    logger.error(
      'OWNER_CHAT_JID environment variable is required. Set it in .env to your Telegram chat ID.',
    );
    process.exit(1);
  }

  // Force IPv4 to avoid IPv6 connectivity issues with Telegram API
  const ipv4Agent = new https.Agent({ family: 4 });
  bot = new Bot(token, {
    client: { baseFetchConfig: { agent: ipv4Agent } },
  });

  // Verify token and get bot info
  const botInfo = await bot.api.getMe();
  botUsername = botInfo.username || '';
  logger.info({ botUsername, botId: botInfo.id }, 'Telegram bot authenticated');

  // Ensure owner chat exists in DB
  ensureChat(OWNER_CHAT_JID);

  // Handle text messages — only from owner's chat
  bot.on('message:text', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (chatId !== OWNER_CHAT_JID) return;

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

    storeMessage(msgId, chatId, sender, senderName, content, timestamp, isFromMe);
    queue.enqueueMessageCheck(chatId);
  });

  // Handle media with captions — only from owner's chat
  bot.on('message:caption', async (ctx) => {
    const chatId = String(ctx.chat.id);
    if (chatId !== OWNER_CHAT_JID) return;

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

    storeMessage(msgId, chatId, sender, senderName, content, timestamp, isFromMe);
    queue.enqueueMessageCheck(chatId);
  });

  // Error handling
  bot.catch((err) => {
    logger.error({ err: err.error }, 'Telegram bot error');
  });

  // Start subsystems
  startSchedulerLoop({
    sendMessage,
    ownerConfig,
    getSessionId: () => sessionId,
    queue,
    onProcess: (chatJid, proc, containerName) =>
      queue.registerProcess(chatJid, proc, containerName),
  });
  startIpcWatcher();
  queue.setProcessMessagesFn(processMessages);
  recoverPendingMessages();

  logger.info(`NanoClaw running (Telegram bot: @${botUsername}, owner: ${OWNER_CHAT_JID})`);
  bot.start();
}

/**
 * Startup recovery: check for unprocessed messages.
 */
function recoverPendingMessages(): void {
  const pending = getMessagesSince(OWNER_CHAT_JID, lastAgentTimestamp, ASSISTANT_NAME);
  if (pending.length > 0) {
    logger.info(
      { pendingCount: pending.length },
      'Recovery: found unprocessed messages',
    );
    queue.enqueueMessageCheck(OWNER_CHAT_JID);
  }
}

function ensureContainerSystemRunning(): void {
  try {
    execSync('docker info', { stdio: 'pipe' });
    logger.debug('Docker is running');
  } catch {
    logger.error('Docker is not running');
    console.error(
      '\n╔════════════════════════════════════════════════════════════════╗',
    );
    console.error(
      '║  FATAL: Docker is not running                                  ║',
    );
    console.error(
      '║                                                                ║',
    );
    console.error(
      '║  Agents cannot run without Docker. To fix:                    ║',
    );
    console.error(
      '║  1. Start Docker Desktop or the Docker daemon                 ║',
    );
    console.error(
      '║  2. Restart NanoClaw                                          ║',
    );
    console.error(
      '╚════════════════════════════════════════════════════════════════╝\n',
    );
    throw new Error('Docker is required but not running');
  }

  // Clean up stopped NanoClaw containers from previous runs
  try {
    const output = execSync('docker ps -a --filter name=nanoclaw- --format {{.Names}}', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const stale = output
      .split('\n')
      .map((n) => n.trim())
      .filter((n) => n.startsWith('nanoclaw-'));
    if (stale.length > 0) {
      execSync(`docker rm ${stale.join(' ')}`, { stdio: 'pipe' });
      logger.info({ count: stale.length }, 'Cleaned up stopped containers');
    }
  } catch {
    // No stopped containers
  }
}

async function main(): Promise<void> {
  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    if (bot) bot.stop();
    await queue.shutdown(10000);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await startTelegramBot();
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start NanoClaw');
  process.exit(1);
});
