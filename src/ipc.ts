import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  IPC_POLL_INTERVAL,
  OWNER_CHAT_JID,
  TIMEZONE,
} from './config.js';
import { createTask, deleteTask, getTaskById, setSession, updateTask } from './db.js';
import { logger } from './logger.js';
import { stripInternalTags } from './router.js';
import { computeNextRun } from './schedule-utils.js';

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  onSessionReset?: (folder: string) => void;
}

let ipcWatcherRunning = false;

export function startIpcWatcher(deps: IpcDeps): void {
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
            const text = stripInternalTags(data.text);
            if (text) {
              await deps.sendMessage(targetJid, text);
              logger.info({ chatJid: targetJid }, 'IPC message sent');
            }
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
          await processTaskIpc(data, deps);
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

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    targetJid?: string;
    groupFolder?: string;
  },
  deps: IpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'new_session': {
      const folder = data.groupFolder || 'main';
      setSession(folder, '');
      deps.onSessionReset?.(folder);
      logger.info({ folder }, 'Session reset via IPC');
      break;
    }
    case 'schedule_task':
      if (data.prompt && data.schedule_type && data.schedule_value) {
        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        try {
          nextRun = computeNextRun(scheduleType, data.schedule_value, TIMEZONE);
        } catch (err) {
          logger.warn(
            { scheduleType, scheduleValue: data.schedule_value, err },
            'Invalid schedule value',
          );
          break;
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

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
