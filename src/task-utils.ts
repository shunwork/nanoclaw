import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { ScheduledTask } from './types.js';

/**
 * Write a snapshot of all tasks for the container to read via IPC.
 * Accepts raw ScheduledTask[] and maps internally.
 */
export function writeTasksSnapshot(
  groupFolder: string,
  tasks: ScheduledTask[],
): void {
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });

  const snapshot = tasks.map((t) => ({
    id: t.id,
    groupFolder: t.group_folder,
    prompt: t.prompt,
    schedule_type: t.schedule_type,
    schedule_value: t.schedule_value,
    status: t.status,
    next_run: t.next_run,
  }));

  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(snapshot, null, 2));
}
