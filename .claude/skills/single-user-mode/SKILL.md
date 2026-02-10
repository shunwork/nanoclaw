---
name: single-user-mode
description: Convert NanoClaw from multi-group architecture to single-user mode. Removes group registration, group discovery, trigger patterns, per-group isolation, and isMain distinction. All messages from the owner's private chat are processed directly. Use when user wants to simplify to personal-only usage.
---

# Convert to Single-User Mode

This skill removes the multi-group architecture and simplifies NanoClaw to serve a single user in a single Telegram private chat. No trigger pattern needed — all messages are processed.

## What Changes

**Remove:**
- `registered_groups` table and all group registration logic
- Group discovery (chat metadata sync, `my_chat_member` handler)
- Trigger pattern detection (`TRIGGER_PATTERN`, `@botusername` mention checks)
- `isMain` distinction — everything is "main"
- `register_group` and `refresh_groups` IPC handlers
- `register_group` MCP tool in the container agent
- `target_group_jid` parameter from `schedule_task` MCP tool
- `writeGroupsSnapshot()` and available groups file
- `getAvailableGroups()`, `syncGroupMetadata()`, `registerGroup()`
- `groups/global/CLAUDE.md` concept (no need for global vs per-group)
- Group-filtered task visibility (show all tasks always)

**Keep (still valuable):**
- Container isolation (security)
- Task scheduler (cron/interval/once)
- Message queue (serialized processing with retry)
- IPC system (agent → host communication for messages and tasks)
- Session management (conversation continuity)
- Additional mounts / mount security

**Add:**
- `OWNER_CHAT_JID` config — the single Telegram chat ID to serve

## Implementation Steps

### Step 1: Add owner chat config to `src/config.ts`

Add `OWNER_CHAT_JID` from environment. Remove `TRIGGER_PATTERN` and `MAIN_GROUP_FOLDER`.

```typescript
// Replace TRIGGER_PATTERN and MAIN_GROUP_FOLDER with:
export const OWNER_CHAT_JID = process.env.OWNER_CHAT_JID || '';
```

Keep: `ASSISTANT_NAME`, all directory paths, container settings, `TIMEZONE`, `IPC_POLL_INTERVAL`, `SCHEDULER_POLL_INTERVAL`.

Remove: `TRIGGER_PATTERN`, `MAIN_GROUP_FOLDER`, the `escapeRegex` helper.

### Step 2: Simplify `src/types.ts`

Replace `RegisteredGroup` with a simpler owner config:

```typescript
export interface OwnerConfig {
  chatJid: string;
  folder: string; // Always 'main'
  containerConfig?: ContainerConfig;
}
```

Keep: `AdditionalMount`, `MountAllowlist`, `AllowedRoot`, `ContainerConfig`, `NewMessage`, `ScheduledTask`, `TaskRunLog`.

### Step 3: Simplify `src/db.ts`

**Remove entirely:**
- `registered_groups` table creation (from `initDatabase`)
- `storeChatMetadata()`, `updateChatName()`, `getAllChats()`, `getLastGroupSync()`, `setLastGroupSync()`
- `getRegisteredGroup()`, `setRegisteredGroup()`, `getAllRegisteredGroups()`
- The `requires_trigger` migration
- The `registered_groups` migration from `migrateJsonState()`

**Simplify:**
- `getAllSessions()` → `getSession(folder)` already exists, keep it
- Session table: keep as-is (still uses group_folder='main')
- Keep the `chats` table for now (messages FK references it), but only store the owner's chat

**Keep unchanged:**
- `storeMessage()`, `getMessagesSince()`, `getNewMessages()`
- All task functions (`createTask`, `getTaskById`, `getAllTasks`, `getDueTasks`, etc.)
- `getRouterState()`, `setRouterState()`
- `getSession()`, `setSession()`, `getAllSessions()`

### Step 4: Simplify `src/container-runner.ts`

**`buildVolumeMounts()`**: Remove the `isMain` branch — always use the "main" mount configuration:
- Always mount project root at `/workspace/project`
- Always mount `groups/main/` at `/workspace/group`
- Keep per-session `.claude/` directory
- Keep single IPC namespace at `data/ipc/main/`
- Keep env-dir mount
- Keep additional mounts from config

Change function signature: replace `(group: RegisteredGroup, isMain: boolean)` with `(config: OwnerConfig)` — isMain is always true.

**`runContainerAgent()`**: Update to use `OwnerConfig` instead of `RegisteredGroup`. Remove `isMain` from `ContainerInput` — it's always true.

**`writeTasksSnapshot()`**: Remove the `isMain` parameter and group filtering — always show all tasks.

**Remove entirely:**
- `writeGroupsSnapshot()` and `AvailableGroup` interface

### Step 5: Simplify `src/index.ts` (biggest change)

**Remove entirely:**
- `registeredGroups` map and all references
- `registerGroup()` function
- `getAvailableGroups()` function
- `syncGroupMetadata()` function
- `groupSyncTimerStarted` flag and its timer
- `GROUP_SYNC_INTERVAL_MS` constant
- `processTaskIpc` cases: `register_group`, `refresh_groups`
- `my_chat_member` handler
- `recoverPendingMessages()` loop over groups (simplify to single check)

**`loadState()`**: Simplify — only load `lastAgentTimestamp` (single entry) and session. No `registeredGroups` loading.

**`processGroupMessages()` → rename to `processMessages()`**:
- Remove the `registeredGroups[chatJid]` lookup — we know the owner
- Remove trigger pattern check entirely — all messages are processed
- Always use owner's config directly
- Always pass `isMain: true` (or remove the field entirely)

**`runAgent()`**: Use `OwnerConfig` instead of `RegisteredGroup`. Remove `isMain` — always true. Remove `writeGroupsSnapshot()` call. Simplify `writeTasksSnapshot()` call.

**Telegram bot message handlers (`bot.on('message:text', ...)` etc.)**:
- Only process messages from `OWNER_CHAT_JID`
- Remove `storeChatMetadata()` calls
- Remove `registeredGroups[chatId]` check — just check `chatId === OWNER_CHAT_JID`
- Simplify: store message and enqueue directly

**IPC watcher (`startIpcWatcher`)**:
- Only scan `data/ipc/main/` (single namespace)
- Remove multi-group directory scanning
- Remove authorization checks on IPC messages (single user = full trust)
- Remove `sourceGroup` / `isMain` parameters from `processTaskIpc`

**`processTaskIpc()`**:
- Remove `sourceGroup` and `isMain` parameters
- Remove authorization checks (all operations are allowed)
- Remove `register_group` case
- Remove `refresh_groups` case
- `schedule_task`: always use owner's chat JID, no `targetJid` resolution needed

**`startTelegramBot()`**:
- Remove `syncGroupMetadata()` calls and timer
- Simplify `startSchedulerLoop` deps

**Startup validation**: Add check that `OWNER_CHAT_JID` is set. If not, log an error telling user to run `/setup` or set `OWNER_CHAT_JID` in `.env`.

### Step 6: Simplify `src/task-scheduler.ts`

**`SchedulerDependencies`**: Remove `registeredGroups` — replace with owner config.

**`runTask()`**:
- Remove group lookup (`Object.values(groups).find(...)`) — use owner config directly
- Remove `isMain` — always true
- Always use `groups/main/` for task directory

### Step 7: Simplify `src/group-queue.ts`

This file is mostly fine as-is. The queue still provides serialized processing and retry logic. Optional cosmetic renames:
- `GroupQueue` → `MessageQueue`
- `GroupState` → `QueueState`
- `groupJid` → `chatJid`
- `drainGroup` → `drainQueue`

These renames are optional — the queue works correctly with one "group" (the owner's chat).

### Step 8: Simplify container agent

**`container/agent-runner/src/index.ts`**:
- Remove `isMain` from `ContainerInput` — always true
- Remove global CLAUDE.md loading (lines checking `!input.isMain && fs.existsSync(globalClaudeMdPath)`) — not needed, there's only one context
- Pass `isMain: true` to `createIpcMcp` always (or remove the field)

**`container/agent-runner/src/ipc-mcp.ts`**:
- Remove `isMain` from `IpcMcpContext` — always true
- Remove `register_group` tool entirely
- Remove `target_group_jid` parameter from `schedule_task` — always use own chatJid
- Remove `isMain` guards on `list_tasks` filtering — always show all
- Simplify tool descriptions (remove "main group only" language)

### Step 9: Update `.env` and setup

Add to `.env`:
```
OWNER_CHAT_JID=<user's telegram chat id>
```

The chat ID can be found from the existing database:
```bash
sqlite3 store/messages.db "SELECT jid FROM registered_groups WHERE folder = 'main'"
```

### Step 10: Filesystem cleanup

- If `groups/global/CLAUDE.md` has useful content, merge it into `groups/main/CLAUDE.md`
- Remove `groups/global/` directory after merging
- Remove any other group directories under `groups/` besides `main/`
- Keep `groups/main/` as the single workspace
- Keep `data/ipc/main/`, `data/sessions/main/` — remove other group folders from `data/ipc/` and `data/sessions/` if they exist
- Remove `data/registered_groups.json.migrated` (leftover from JSON→SQLite migration, no longer relevant)

### Step 11: Database migration

In `initDatabase()`, keep the `registered_groups` table creation SQL so existing databases don't break, but the code will no longer use it. Or add a migration step:

```sql
-- Optional: clean up old table
DROP TABLE IF EXISTS registered_groups;
```

Actually, safest approach: just stop using the table. Don't drop it — existing data won't cause issues.

### Step 12: Update `src/mount-security.ts`

Change the `validateAdditionalMounts()` signature if it references `isMain` — always treat as main (full access).

### Step 13: Update CLAUDE.md and docs

Update `groups/main/CLAUDE.md` — remove any multi-group references.

Update the project `CLAUDE.md`:
- Remove "Per-group memory" references
- Update Key Files table
- Simplify Quick Context description

## After Changes

```bash
npm run build
cd container && npm run build && cd ..  # Rebuild agent-runner
./container/build.sh                     # Rebuild container image
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

## Verification

1. Send a message to the bot in Telegram — it should respond without any trigger prefix
2. Check logs: `tail -f logs/nanoclaw.log` — should show single-chat processing
3. Test task scheduling via the bot: "remind me in 1 minute to test"
4. Verify IPC works: check `data/ipc/main/` for message/task files being processed
