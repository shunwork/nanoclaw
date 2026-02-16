import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  IDLE_TIMEOUT,
  OWNER_CHAT_JID,
} from './config.js';
import { TelegramChannel } from './channels/telegram.js';
import {
  ContainerOutput,
  runContainerAgent,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllSessions,
  getAllTasks,
  getMessagesSince,
  getRouterState,
  initDatabase,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { startIpcWatcher } from './ipc.js';
import { formatMessages, formatOutbound } from './router.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { OwnerConfig } from './types.js';
import { logger } from './logger.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastAgentTimestamp = '';
let sessions: Record<string, string> = {};

let channel: TelegramChannel;
const queue = new GroupQueue();

// Single owner config — no multi-group registration needed
const ownerConfig: OwnerConfig = {
  chatJid: OWNER_CHAT_JID,
  folder: 'main',
};

function loadState(): void {
  const agentTs = getRouterState('last_agent_timestamp');
  if (agentTs) {
    // Migrate from multi-group format (JSON object) to single string
    try {
      const parsed = JSON.parse(agentTs);
      if (typeof parsed === 'object' && parsed !== null) {
        lastAgentTimestamp = parsed[OWNER_CHAT_JID] || '';
      } else {
        lastAgentTimestamp = agentTs;
      }
    } catch {
      lastAgentTimestamp = agentTs;
    }
  }
  sessions = getAllSessions();
  logger.info('State loaded');
}

function saveState(): void {
  setRouterState('last_agent_timestamp', lastAgentTimestamp);
}

/**
 * Process all pending messages.
 * Called by the GroupQueue when it's time to process.
 */
async function processMessages(chatJid: string): Promise<boolean> {
  const missedMessages = getMessagesSince(
    chatJid,
    lastAgentTimestamp,
    ASSISTANT_NAME,
  );

  if (missedMessages.length === 0) return true;

  const prompt = formatMessages(missedMessages);

  // Advance cursor. Save old cursor for rollback on error.
  const previousCursor = lastAgentTimestamp;
  lastAgentTimestamp = missedMessages[missedMessages.length - 1].timestamp;
  saveState();

  logger.info(
    { messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug('Idle timeout, closing container stdin');
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;

  const output = await runAgent(prompt, chatJid, async (result) => {
    // Streaming output callback — called for each agent result
    if (result.result) {
      const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
      // Strip <internal>...</internal> blocks
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      logger.info(`Agent output: ${raw.slice(0, 200)}`);
      if (text) {
        await channel.sendMessage(chatJid, text);
        outputSentToUser = true;
      }
      resetIdleTimer();
    }

    if (result.status === 'error') {
      hadError = true;
    }
  });

  await channel.setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (output === 'error' || hadError) {
    if (outputSentToUser) {
      logger.warn('Agent error after output was sent, skipping cursor rollback to prevent duplicates');
      return true;
    }
    lastAgentTimestamp = previousCursor;
    saveState();
    logger.warn('Agent error, rolled back message cursor for retry');
    return false;
  }

  return true;
}

async function runAgent(
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const sessionId = sessions[ownerConfig.folder];

  // Update tasks snapshot for container to read
  const tasks = getAllTasks();
  writeTasksSnapshot(
    ownerConfig.folder,
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

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[ownerConfig.folder] = output.newSessionId;
          setSession(ownerConfig.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      ownerConfig,
      {
        prompt,
        sessionId,
        groupFolder: ownerConfig.folder,
        chatJid,
      },
      (proc, containerName) => queue.registerProcess(chatJid, proc, containerName, ownerConfig.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[ownerConfig.folder] = output.newSessionId;
      setSession(ownerConfig.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      logger.error(
        { error: output.error },
        'Container agent error',
      );
      return 'error';
    }

    return 'success';
  } catch (err) {
    logger.error({ err }, 'Agent error');
    return 'error';
  }
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
    execSync('container system status', { stdio: 'pipe' });
    logger.debug('Apple Container system already running');
  } catch {
    logger.info('Starting Apple Container system...');
    try {
      execSync('container system start', { stdio: 'pipe', timeout: 30000 });
      logger.info('Apple Container system started');
    } catch (err) {
      logger.error({ err }, 'Failed to start Apple Container system');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Apple Container system failed to start                 ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without Apple Container. To fix:           ║',
      );
      console.error(
        '║  1. Install from: https://github.com/apple/container/releases ║',
      );
      console.error(
        '║  2. Run: container system start                               ║',
      );
      console.error(
        '║  3. Restart NanoClaw                                          ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Apple Container system is required but failed to start');
    }
  }

  // Kill and clean up orphaned NanoClaw containers from previous runs
  try {
    const output = execSync('container ls --format json', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    const containers: { status: string; configuration: { id: string } }[] = JSON.parse(output || '[]');
    const orphans = containers
      .filter((c) => c.status === 'running' && c.configuration.id.startsWith('nanoclaw-'))
      .map((c) => c.configuration.id);
    for (const name of orphans) {
      try {
        execSync(`container stop ${name}`, { stdio: 'pipe' });
      } catch { /* already stopped */ }
    }
    if (orphans.length > 0) {
      logger.info({ count: orphans.length, names: orphans }, 'Stopped orphaned containers');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

async function main(): Promise<void> {
  if (!OWNER_CHAT_JID) {
    logger.error(
      'OWNER_CHAT_JID is required. Set it in .env or as an environment variable.',
    );
    process.exit(1);
  }

  ensureContainerSystemRunning();
  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    await queue.shutdown(10000);
    await channel.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Create Telegram channel
  channel = new TelegramChannel({
    onMessage: (chatJid, msg) => {
      // Only process messages from owner's chat
      if (chatJid !== OWNER_CHAT_JID) return;
      storeMessage(msg);

      // Pipe to active container or enqueue for a new one
      const missedMessages = getMessagesSince(chatJid, lastAgentTimestamp, ASSISTANT_NAME);
      const formatted = formatMessages(missedMessages);

      if (queue.sendMessage(chatJid, formatted)) {
        logger.debug({ count: missedMessages.length }, 'Piped messages to active container');
        lastAgentTimestamp = missedMessages[missedMessages.length - 1].timestamp;
        saveState();
        channel.setTyping(chatJid, true);
      } else {
        queue.enqueueMessageCheck(chatJid);
      }
    },
    onChatMetadata: (chatJid, timestamp, name) => {
      if (chatJid === OWNER_CHAT_JID) {
        storeChatMetadata(chatJid, timestamp, name);
      }
    },
  });

  await channel.connect();

  // Start subsystems
  startSchedulerLoop({
    ownerConfig,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const text = formatOutbound(rawText);
      if (text) await channel.sendMessage(jid, text);
    },
  });
  startIpcWatcher({
    sendMessage: (jid, text) => channel.sendMessage(jid, text),
  });
  queue.setProcessMessagesFn(processMessages);
  recoverPendingMessages();

  logger.info(`NanoClaw running (owner: ${OWNER_CHAT_JID})`);
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname === new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
