---
name: single-user-mode
description: Convert NanoClaw from multi-group architecture to single-user mode. Removes group registration, group discovery, trigger patterns, per-group isolation, and isMain distinction. All messages from the owner's private chat are processed directly. Use when user wants to simplify to personal-only usage.
---

# Convert to Single-User Mode

This skill removes the multi-group architecture and simplifies NanoClaw to serve a single user in a single chat. No trigger pattern needed -- all messages are processed. The codebase is modular: `src/index.ts` is a thin orchestrator, with IPC, routing, container-runner, task-scheduler, mount-security, db, types, and config in separate files. Channels are abstracted via a `Channel` interface. Containers run in Apple Container (not Docker) with streaming output.

## What Changes

**Remove:**
- `registered_groups` table and all group registration logic
- Group discovery (chat metadata sync, `syncGroupMetadata`)
- Trigger pattern detection (`TRIGGER_PATTERN`, `escapeRegex`, `@botusername` mention checks)
- `isMain` distinction everywhere -- everything is "main"
- `register_group` and `refresh_groups` IPC handlers in `src/ipc.ts`
- `register_group` MCP tool in `container/agent-runner/src/ipc-mcp-stdio.ts`
- `target_group_jid` parameter from `schedule_task` MCP tool
- `writeGroupsSnapshot()` and `AvailableGroup` interface in `src/container-runner.ts`
- `getAvailableGroups()`, `registerGroup()` in `src/index.ts`
- `groups/global/CLAUDE.md` concept (no need for global vs per-group)
- Multi-group IPC directory scanning (only `data/ipc/main/` remains)
- Authorization checks in IPC (single user = full trust)
- Group-filtered task visibility (show all tasks always)
- `MAIN_GROUP_FOLDER` constant (hardcode `'main'` where needed, or derive from `OwnerConfig.folder`)

**Keep (still valuable):**
- Apple Container isolation (security)
- Streaming output with `OUTPUT_START`/`OUTPUT_END` markers
- Multi-turn IPC input polling (`/workspace/ipc/input/`, `_close` sentinel)
- Task scheduler (cron/interval/once)
- Message queue (`GroupQueue` -- serialized processing with retry)
- IPC system (agent -> host communication for messages and tasks)
- Session management (conversation continuity)
- Additional mounts / mount security
- Channel abstraction (`Channel` interface in `src/types.ts`)
- Router module (`src/router.ts` -- message formatting, outbound routing)
- `src/env.ts` -- secret reading

**Add:**
- `OWNER_CHAT_JID` config -- the single chat ID to serve
- `OwnerConfig` type -- replaces `RegisteredGroup` for the single user

## Implementation Steps

### Step 1: Add owner chat config to `src/config.ts`

Add `OWNER_CHAT_JID` from environment. Remove `TRIGGER_PATTERN`, `MAIN_GROUP_FOLDER`, and `escapeRegex`.

```typescript
// Remove these:
// export const MAIN_GROUP_FOLDER = 'main';
// function escapeRegex(str: string): string { ... }
// export const TRIGGER_PATTERN = new RegExp(...);

// Add:
export const OWNER_CHAT_JID = process.env.OWNER_CHAT_JID || '';
```

Keep: `ASSISTANT_NAME`, `ASSISTANT_HAS_OWN_NUMBER`, `POLL_INTERVAL`, `SCHEDULER_POLL_INTERVAL`, all directory paths (`STORE_DIR`, `GROUPS_DIR`, `DATA_DIR`), container settings (`CONTAINER_IMAGE`, `CONTAINER_TIMEOUT`, `CONTAINER_MAX_OUTPUT_SIZE`, `IDLE_TIMEOUT`, `MAX_CONCURRENT_CONTAINERS`, `IPC_POLL_INTERVAL`), `TIMEZONE`, `MOUNT_ALLOWLIST_PATH`.

### Step 2: Simplify `src/types.ts`

Replace `RegisteredGroup` with a simpler owner config:

```typescript
export interface OwnerConfig {
  chatJid: string;
  folder: string; // Always 'main'
  containerConfig?: ContainerConfig;
}
```

Remove: `RegisteredGroup` interface entirely.

Keep: `AdditionalMount`, `MountAllowlist`, `AllowedRoot`, `ContainerConfig`, `NewMessage`, `ScheduledTask`, `TaskRunLog`, `Channel`, `OnInboundMessage`, `OnChatMetadata`.

### Step 3: Simplify `src/db.ts`

**Remove entirely:**
- `registered_groups` table creation (from `createSchema`)
- `getRegisteredGroup()`, `setRegisteredGroup()`, `getAllRegisteredGroups()`
- The `registered_groups` migration from `migrateJsonState()`
- `storeChatMetadata()`, `updateChatName()`, `getAllChats()`, `getLastGroupSync()`, `setLastGroupSync()` (group discovery functions)
- `RegisteredGroup` import from `types.js`
- `ChatInfo` interface

**Simplify:**
- `getAllSessions()` -> `getSession(folder)` already exists, keep it
- Session table: keep as-is (still uses `group_folder='main'`)
- Keep the `chats` table in schema for now (messages FK references it), but no code actively manages it beyond `storeMessage()`

**Keep unchanged:**
- `storeMessage()`, `storeMessageDirect()`, `getMessagesSince()`, `getNewMessages()`
- All task functions (`createTask`, `getTaskById`, `getTasksForGroup`, `getAllTasks`, `getDueTasks`, `updateTask`, `deleteTask`, `updateTaskAfterRun`, `logTaskRun`)
- `getRouterState()`, `setRouterState()`
- `getSession()`, `setSession()`, `getAllSessions()`
- `initDatabase()`, `_initTestDatabase()`

### Step 4: Simplify `src/mount-security.ts`

Remove the `isMain` parameter from `validateMount()` and `validateAdditionalMounts()`. Always treat as main (full access). The `nonMainReadOnly` logic becomes dead code -- remove it.

```typescript
// Before:
export function validateMount(mount: AdditionalMount, isMain: boolean): MountValidationResult { ... }
export function validateAdditionalMounts(mounts: AdditionalMount[], groupName: string, isMain: boolean): ... { ... }

// After:
export function validateMount(mount: AdditionalMount): MountValidationResult { ... }
export function validateAdditionalMounts(mounts: AdditionalMount[], groupName: string): ... { ... }
```

Inside `validateMount()`, remove the `isMain` branch in the readonly determination:
- Remove `if (!isMain && allowlist.nonMainReadOnly)` -- always allow read-write if root allows it
- The `MountAllowlist.nonMainReadOnly` field can stay in the type for backwards compat but is ignored

### Step 5: Simplify `src/container-runner.ts`

**`buildVolumeMounts()`**: Change signature from `(group: RegisteredGroup, isMain: boolean)` to `(config: OwnerConfig)`. Remove the `isMain` branch -- always use the "main" mount configuration:

```typescript
function buildVolumeMounts(config: OwnerConfig): VolumeMount[] {
  // Always mount project root (was: only for isMain)
  mounts.push({ hostPath: projectRoot, containerPath: '/workspace/project', readonly: false });
  // Always mount groups/main/ as working directory
  mounts.push({ hostPath: path.join(GROUPS_DIR, config.folder), containerPath: '/workspace/group', readonly: false });
  // Remove: global memory mount (was: only for !isMain)
  // ... rest stays the same (sessions, IPC, agent-runner src, additional mounts)
}
```

- In additional mounts validation, call `validateAdditionalMounts(mounts, 'owner')` -- no `isMain` param.

**`ContainerInput`**: Remove `isMain` field -- it is always true.

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  // isMain removed -- always true in single-user mode
  isScheduledTask?: boolean;
  secrets?: Record<string, string>;
}
```

**`runContainerAgent()`**: Change signature from `(group: RegisteredGroup, input, onProcess, onOutput)` to `(config: OwnerConfig, input, onProcess, onOutput)`. Use `config.folder` instead of `group.folder`, `config.chatJid` or `'owner'` instead of `group.name`.

**`writeTasksSnapshot()`**: Remove `isMain` parameter and group filtering -- always show all tasks:

```typescript
export function writeTasksSnapshot(
  groupFolder: string,
  tasks: Array<{ id: string; groupFolder: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string | null }>,
): void {
  // Write ALL tasks, no filtering
  const groupIpcDir = path.join(DATA_DIR, 'ipc', groupFolder);
  fs.mkdirSync(groupIpcDir, { recursive: true });
  const tasksFile = path.join(groupIpcDir, 'current_tasks.json');
  fs.writeFileSync(tasksFile, JSON.stringify(tasks, null, 2));
}
```

**Remove entirely:**
- `writeGroupsSnapshot()` function
- `AvailableGroup` interface
- `RegisteredGroup` import from `types.js`

### Step 6: Simplify `src/ipc.ts` (major simplification)

**`IpcDeps`**: Remove multi-group dependencies:

```typescript
// Before:
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (...) => void;
}

// After:
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  ownerChatJid: string;
}
```

**`startIpcWatcher()`**: Simplify to only scan `data/ipc/main/`. Remove multi-group directory scanning loop:

```typescript
export function startIpcWatcher(deps: IpcDeps): void {
  const ipcDir = path.join(DATA_DIR, 'ipc', 'main');
  // Only scan ipcDir/messages/ and ipcDir/tasks/
  // No groupFolders loop, no sourceGroup/isMain variables
}
```

**`processTaskIpc()`**: Remove `sourceGroup` and `isMain` parameters. Remove authorization checks. Remove `register_group` and `refresh_groups` cases:

```typescript
export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    targetJid?: string;
  },
  deps: IpcDeps,
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      // Always use deps.ownerChatJid -- no target resolution needed
      // No authorization checks
      break;
    case 'pause_task':
    case 'resume_task':
    case 'cancel_task':
      // Direct operations -- no authorization checks
      break;
    // Removed: 'register_group', 'refresh_groups'
    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
```

In `schedule_task`, always use `deps.ownerChatJid` as the chat JID and `'main'` as the group folder.

**Message IPC**: Remove authorization check (`isMain || targetGroup.folder === sourceGroup`). Just send all messages directly.

### Step 7: Simplify `src/index.ts` (biggest change)

**Remove entirely:**
- `registeredGroups` map and all references
- `registerGroup()` function
- `getAvailableGroups()` function
- `_setRegisteredGroups()` test helper
- `TRIGGER_PATTERN` import
- `MAIN_GROUP_FOLDER` import
- `writeGroupsSnapshot` import
- `getAllRegisteredGroups`, `setRegisteredGroup`, `storeChatMetadata`, `getAllChats` imports
- `RegisteredGroup` import
- `startMessageLoop()` function -- replaced by event-driven processing via Channel callbacks
- `messageLoopRunning` flag
- Re-export of `escapeXml`, `formatMessages` (move to call sites if needed)

**Add `ownerConfig`:**

```typescript
import { OWNER_CHAT_JID } from './config.js';
import { OwnerConfig } from './types.js';

const ownerConfig: OwnerConfig = {
  chatJid: OWNER_CHAT_JID,
  folder: 'main',
};
```

**`loadState()`**: Simplify -- only load `lastAgentTimestamp` (single entry) and session. No `registeredGroups` loading:

```typescript
function loadState(): void {
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
}
```

Remove `lastTimestamp` variable entirely (polling loop is gone).

**`processGroupMessages()` -> `processMessages()`**: Simplify to always use `ownerConfig`:

```typescript
async function processMessages(chatJid: string): Promise<boolean> {
  // No registeredGroups lookup -- use ownerConfig directly
  // No trigger pattern check -- all messages processed
  const sinceTimestamp = lastAgentTimestamp[chatJid] || '';
  const missedMessages = getMessagesSince(chatJid, sinceTimestamp, ASSISTANT_NAME);
  if (missedMessages.length === 0) return true;

  const prompt = formatMessages(missedMessages);
  // ... rest similar but uses ownerConfig instead of group
}
```

**`runAgent()`**: Use `OwnerConfig` instead of `RegisteredGroup`. Remove `isMain` branching:

```typescript
async function runAgent(
  config: OwnerConfig,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
): Promise<'success' | 'error'> {
  const sessionId = sessions[config.folder];
  const tasks = getAllTasks();
  writeTasksSnapshot(config.folder, tasks.map(t => ({...})));
  // No writeGroupsSnapshot() call

  const output = await runContainerAgent(config, {
    prompt,
    sessionId,
    groupFolder: config.folder,
    chatJid,
    // No isMain field
  }, ...);
  // ...
}
```

**Channel setup**: The Channel creates callbacks for inbound messages. Only process messages from `OWNER_CHAT_JID`:

```typescript
// In main():
const channel = new TelegramChannel({  // or WhatsAppChannel
  onMessage: (chatJid, msg) => {
    if (chatJid !== OWNER_CHAT_JID) return; // Ignore non-owner messages
    storeMessage(msg);
    // Event-driven: enqueue immediately instead of polling loop
    if (queue.sendMessage(chatJid, formatMessages([msg]))) {
      // Piped to active container
    } else {
      queue.enqueueMessageCheck(chatJid);
    }
  },
  onChatMetadata: () => {}, // No-op in single-user mode
});
```

**IPC watcher**: Pass simplified deps:

```typescript
startIpcWatcher({
  sendMessage: (jid, text) => channel.sendMessage(jid, text),
  ownerChatJid: OWNER_CHAT_JID,
});
```

**Scheduler**: Pass `ownerConfig` directly:

```typescript
startSchedulerLoop({
  ownerConfig,
  getSessions: () => sessions,
  queue,
  onProcess: (jid, proc, name, folder) => queue.registerProcess(jid, proc, name, folder),
  sendMessage: async (jid, rawText) => {
    const text = formatOutbound(rawText);
    if (text) await channel.sendMessage(jid, text);
  },
});
```

**Startup validation**: Add check that `OWNER_CHAT_JID` is set:

```typescript
if (!OWNER_CHAT_JID) {
  logger.error('OWNER_CHAT_JID not set. Set it in .env to your chat ID.');
  process.exit(1);
}
```

**`recoverPendingMessages()`**: Simplify to single chat:

```typescript
function recoverPendingMessages(): void {
  const sinceTimestamp = lastAgentTimestamp[OWNER_CHAT_JID] || '';
  const pending = getMessagesSince(OWNER_CHAT_JID, sinceTimestamp, ASSISTANT_NAME);
  if (pending.length > 0) {
    logger.info({ pendingCount: pending.length }, 'Recovery: found unprocessed messages');
    queue.enqueueMessageCheck(OWNER_CHAT_JID);
  }
}
```

### Step 8: Simplify `src/task-scheduler.ts`

**`SchedulerDependencies`**: Replace `registeredGroups` with `ownerConfig`:

```typescript
// Before:
export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (...) => void;
  sendMessage: (...) => Promise<void>;
}

// After:
export interface SchedulerDependencies {
  ownerConfig: OwnerConfig;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (chatJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<void>;
}
```

**`runTask()`**: Use `ownerConfig` directly instead of group lookup:

```typescript
async function runTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const config = deps.ownerConfig;
  // Remove: const group = Object.values(groups).find(g => g.folder === task.group_folder);
  // Remove: if (!group) { ... error ... }
  // Remove: const isMain = task.group_folder === MAIN_GROUP_FOLDER;

  const tasks = getAllTasks();
  writeTasksSnapshot(config.folder, tasks.map(t => ({...})));

  const output = await runContainerAgent(config, {
    prompt: task.prompt,
    sessionId,
    groupFolder: config.folder,
    chatJid: task.chat_jid,
    isScheduledTask: true,
  }, ...);
}
```

Remove: `MAIN_GROUP_FOLDER` import, `RegisteredGroup` import.

### Step 9: Simplify `src/group-queue.ts` (optional renames)

This file works correctly as-is with one "group" (the owner's chat). Optional cosmetic renames:
- `GroupQueue` -> `MessageQueue`
- `GroupState` -> `QueueState`
- `groupJid` -> `chatJid`
- `drainGroup` -> `drainQueue`

These renames are optional -- the queue works correctly without them.

### Step 10: Simplify container agent runner

**`container/agent-runner/src/index.ts`**:
- Remove `isMain` from `ContainerInput` interface
- Remove global CLAUDE.md loading (lines: `if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath))`) -- not needed, there is only one context
- Remove `isMain` from MCP env vars:

```typescript
// Before:
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
},

// After:
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
    },
  },
},
```

- Remove the `systemPrompt` override that appended `globalClaudeMd` -- just use `undefined` (or omit)

**`container/agent-runner/src/ipc-mcp-stdio.ts`**:

Remove `isMain` context variable:

```typescript
// Remove: const isMain = process.env.NANOCLAW_IS_MAIN === '1';
```

Remove `register_group` tool entirely (the whole `server.tool('register_group', ...)` block).

Remove `target_group_jid` parameter from `schedule_task`:

```typescript
server.tool(
  'schedule_task',
  // Update description: remove "Main group only" language
  `Schedule a recurring or one-time task...`,
  {
    prompt: z.string()...,
    schedule_type: z.enum(...)...,
    schedule_value: z.string()...,
    context_mode: z.enum(...)...,
    // Remove: target_group_jid parameter
  },
  async (args) => {
    // Always use chatJid directly
    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid: chatJid, // Always own chat
      timestamp: new Date().toISOString(),
    };
    // ...
  },
);
```

Simplify `list_tasks` -- remove `isMain` filtering:

```typescript
server.tool(
  'list_tasks',
  'List all scheduled tasks.',
  {},
  async () => {
    // Read and return all tasks, no filtering
    const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));
    // Remove: const tasks = isMain ? allTasks : allTasks.filter(...);
    const tasks = allTasks;
    // ...
  },
);
```

Remove `isMain` from `pause_task`, `resume_task`, `cancel_task` data payloads -- it is no longer needed.

### Step 11: Update `.env` and setup

Add to `.env`:
```
OWNER_CHAT_JID=<user's chat id>
```

For Telegram, the chat ID is the user's numeric ID (positive integer for private chats). It can be found from:
- The existing database: `sqlite3 store/messages.db "SELECT DISTINCT chat_jid FROM messages LIMIT 5"`
- Or from the bot's logs when a message arrives
- Or using Telegram's `@userinfobot`

### Step 12: Filesystem cleanup

- If `groups/global/CLAUDE.md` has useful content, merge it into `groups/main/CLAUDE.md`
- Remove `groups/global/` directory after merging
- Remove any other group directories under `groups/` besides `main/`
- Keep `groups/main/` as the single workspace
- Keep `data/ipc/main/`, `data/sessions/main/` -- remove other group folders from `data/ipc/` and `data/sessions/` if they exist
- Remove `data/registered_groups.json.migrated` (leftover from JSON->SQLite migration)

### Step 13: Database migration

In `createSchema()`, keep the `registered_groups` table creation SQL so existing databases don't break, but the code will no longer use it. Or add a migration step:

```sql
-- Optional: clean up old table
DROP TABLE IF EXISTS registered_groups;
```

Safest approach: just stop using the table. Don't drop it -- existing data will not cause issues.

### Step 14: Update `src/router.ts`

No changes needed to core routing logic. The `routeOutbound()` and `findChannel()` functions work with the `Channel` abstraction. Keep `formatMessages()`, `escapeXml()`, `stripInternalTags()`, `formatOutbound()` as-is.

### Step 15: Update CLAUDE.md and docs

Update `groups/main/CLAUDE.md` -- remove any multi-group references.

Update the project `CLAUDE.md`:
- Remove "Per-group memory" references
- Update Key Files table
- Simplify architecture description
- Remove `RegisteredGroup` from types documentation
- Update database schema (note `registered_groups` is unused)
- Remove `TRIGGER_PATTERN` and `MAIN_GROUP_FOLDER` from config documentation

## After Changes

```bash
npm run build
cd container && npm run build && cd ..  # Rebuild agent-runner TypeScript
./container/build.sh                     # Rebuild container image (Apple Container)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Verification

1. Send a message to the bot -- it should respond without any trigger prefix
2. Check logs: `tail -f logs/nanoclaw.log` -- should show single-chat processing
3. Test task scheduling via the bot: "remind me in 1 minute to test"
4. Verify IPC works: check `data/ipc/main/` for message/task files being processed
5. Verify multi-turn: send a follow-up message while the agent is still running -- it should be piped via IPC input
6. Verify idle timeout: after agent responds, the container should exit after `IDLE_TIMEOUT` (30 min default)

## Summary of Files Changed

| File | Action |
|------|--------|
| `src/config.ts` | Add `OWNER_CHAT_JID`, remove `TRIGGER_PATTERN`, `MAIN_GROUP_FOLDER`, `escapeRegex` |
| `src/types.ts` | Add `OwnerConfig`, remove `RegisteredGroup` |
| `src/db.ts` | Remove registered group functions, group discovery functions |
| `src/mount-security.ts` | Remove `isMain` parameter from `validateMount()` and `validateAdditionalMounts()` |
| `src/container-runner.ts` | Use `OwnerConfig`, remove `isMain` branching, remove `writeGroupsSnapshot()`, simplify `writeTasksSnapshot()` |
| `src/ipc.ts` | Simplify to single namespace, remove authorization, remove `register_group`/`refresh_groups` |
| `src/index.ts` | Remove multi-group logic, polling loop; use `ownerConfig`, event-driven processing |
| `src/task-scheduler.ts` | Use `ownerConfig` instead of `registeredGroups` lookup |
| `src/group-queue.ts` | No changes required (optional renames) |
| `src/router.ts` | No changes required |
| `container/agent-runner/src/index.ts` | Remove `isMain` from `ContainerInput`, remove global CLAUDE.md loading |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Remove `register_group` tool, `target_group_jid`, `isMain` filtering |
