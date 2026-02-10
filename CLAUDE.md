# NanoClaw

Personal Claude assistant. Single-user mode — one Node.js host process serving one Telegram private chat via Docker-isolated Claude Agent SDK containers.

See [README.md](README.md) for philosophy and setup. See [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) for architecture decisions.

## Architecture Overview

```
Telegram ←→ grammy Bot (long polling)
               ↓
         src/index.ts (host process)
           ├── storeMessage() → SQLite
           ├── GroupQueue → concurrency control
           └── runContainerAgent() → Docker container
                  ├── Claude Agent SDK (query())
                  ├── Tools: Bash, Read/Write/Edit/Glob/Grep, WebSearch/WebFetch
                  ├── agent-browser (Chromium-based)
                  └── MCP nanoclaw: send_message, schedule_task, list/pause/resume/cancel_task
                         ↓
                  IPC (file-based) → host polls → sendMessage() / createTask()
```

### Message Flow

1. Telegram message → `bot.on('message:text')` → `storeMessage()` to SQLite
2. `queue.enqueueMessageCheck()` → waits for container slot
3. `processMessages()` → reads unprocessed messages from DB, formats as XML prompt
4. `runContainerAgent()` → spawns Docker container, pipes JSON via stdin
5. Container runs `agent-runner` → calls Agent SDK `query()` with tools
6. Agent produces structured output (`outputType: message|log`) → stdout JSON
7. Host parses output → sends response to Telegram if `outputType === 'message'`

### IPC Flow (container → host)

Container writes JSON files to `/workspace/ipc/{messages,tasks}/`. Host's `startIpcWatcher()` polls every 1s:
- **messages/**: `send_message` calls → host sends to Telegram immediately
- **tasks/**: `schedule_task`, `pause_task`, `resume_task`, `cancel_task` → host writes to SQLite

### Task Scheduler Flow

`startSchedulerLoop()` polls SQLite every 60s for due tasks → `queue.enqueueTask()` → `runTask()` → same `runContainerAgent()` pipeline. Tasks support cron, interval, and one-time schedules.

### Session Continuity

Agent SDK sessions are stored in `data/sessions/main/.claude/`. The host tracks `sessionId` and passes it as `resume` option to `query()`, enabling multi-turn conversations across separate container invocations.

## Directory Structure

```
src/                        Host process (TypeScript, compiled to dist/)
  index.ts                  Main: Telegram bot, message routing, IPC watcher
  config.ts                 OWNER_CHAT_JID, ASSISTANT_NAME, paths, timeouts
  container-runner.ts       Docker spawn, volume mounts, output parsing
  task-scheduler.ts         Scheduled task execution loop
  db.ts                     SQLite: messages, tasks, sessions, router state
  group-queue.ts            Serialized queue with retry backoff, concurrency limit
  mount-security.ts         Validates additional mounts against external allowlist
  types.ts                  OwnerConfig, ContainerConfig, ScheduledTask, etc.
  logger.ts                 Pino logger with pino-pretty

container/                  Docker container image
  Dockerfile                Node 22-slim + Chromium + agent-browser + claude-code
  build.sh                  docker build wrapper
  agent-runner/src/
    index.ts                Reads ContainerInput from stdin, runs query(), writes ContainerOutput
    ipc-mcp.ts              MCP server with 6 tools (send_message, schedule/list/pause/resume/cancel)
  skills/
    agent-browser.md        Browser automation reference (not auto-loaded, see notes below)

groups/main/                Agent workspace (mounted → /workspace/group)
  CLAUDE.md                 Agent's system instructions and persistent memory
  conversations/            Auto-archived past conversations (by PreCompact hook)
  logs/                     Per-run container logs
  .claude/skills/           Agent SDK auto-discovered skills (if any)

store/messages.db           SQLite database (messages, scheduled_tasks, task_run_logs, etc.)
data/ipc/main/              IPC files: messages/ and tasks/ (ephemeral)
data/sessions/main/.claude/ Agent SDK session transcripts
data/env/                   Filtered .env for container (only CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY)

.claude/skills/             Claude Code skills (for development, NOT for container agent)
docs/                       REQUIREMENTS.md, SECURITY.md, SPEC.md
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main: Telegram bot, message routing, IPC watcher, graceful shutdown |
| `src/config.ts` | `OWNER_CHAT_JID`, `ASSISTANT_NAME`, paths, timeouts, timezone |
| `src/container-runner.ts` | `runContainerAgent()`, `buildVolumeMounts()`, `writeTasksSnapshot()` |
| `src/db.ts` | All SQLite operations: messages, tasks, sessions, router state |
| `src/group-queue.ts` | `GroupQueue`: serialized processing, retry with exponential backoff |
| `src/task-scheduler.ts` | `startSchedulerLoop()`, `runTask()` |
| `src/mount-security.ts` | Validates mounts against `~/.config/nanoclaw/mount-allowlist.json` |
| `container/agent-runner/src/index.ts` | Container entrypoint: Agent SDK `query()` call with all tool config |
| `container/agent-runner/src/ipc-mcp.ts` | `createIpcMcp()`: 6 MCP tools for host communication |
| `groups/main/CLAUDE.md` | Agent's personality, instructions, and memory |

## Container Agent Configuration

The agent runs Claude Sonnet 4.5 (`claude-sonnet-4-5-20250929`) with these settings (in `container/agent-runner/src/index.ts`):

- **allowedTools**: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `mcp__nanoclaw__*`
- **permissionMode**: `bypassPermissions` (sandboxed in Docker)
- **settingSources**: `['project']` — reads `CLAUDE.md` and `.claude/` from `/workspace/group` (= `groups/main/`)
- **mcpServers**: `nanoclaw` (IPC-based, defined in `ipc-mcp.ts`)
- **hooks**: `PreCompact` — archives conversation transcripts before context compaction
- **outputFormat**: JSON schema with `outputType`, `userMessage`, `internalLog`
- **cwd**: `/workspace/group`

### Container Volume Mounts

| Container Path | Host Path | Access |
|----------------|-----------|--------|
| `/workspace/project` | Project root | read-write |
| `/workspace/group` | `groups/main/` | read-write |
| `/home/node/.claude` | `data/sessions/main/.claude/` | read-write |
| `/workspace/ipc` | `data/ipc/main/` | read-write |
| `/workspace/env-dir` | `data/env/` | read-only |
| `/workspace/extra/*` | Additional mounts (if configured) | per-config |

### Extending the Agent

- **Add tools**: Add `'Task'` to `allowedTools` for subagent support. Add MCP servers to `mcpServers` object.
- **Add skills**: Place `.md` files in `groups/main/.claude/skills/` — auto-loaded by Agent SDK.
- **Add hooks**: Add to `hooks` object in `query()` options (`PreToolUse`, `PostToolUse`, `PreCompact`, `Notification`).
- **Change instructions**: Edit `groups/main/CLAUDE.md` — no rebuild needed.
- **Change model**: Edit the `model` field in `query()` options.

Note: `container/skills/agent-browser.md` is a reference file but is NOT auto-loaded by the Agent SDK (it's not under `.claude/skills/`). The agent-browser instructions are currently embedded in `groups/main/CLAUDE.md`.

## Database Schema

```sql
chats (jid TEXT PK, name TEXT, last_message_time TEXT)
messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER)
scheduled_tasks (id TEXT PK, group_folder TEXT, chat_jid TEXT, prompt TEXT, schedule_type TEXT, schedule_value TEXT, next_run TEXT, last_run TEXT, last_result TEXT, status TEXT, created_at TEXT)
task_run_logs (id INTEGER PK, task_id TEXT, run_at TEXT, duration_ms INTEGER, status TEXT, result TEXT, error TEXT)
router_state (key TEXT PK, value TEXT)
sessions (group_folder TEXT PK, session_id TEXT)
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | — | Telegram Bot API token |
| `OWNER_CHAT_JID` | Yes | — | Owner's Telegram chat ID |
| `CLAUDE_CODE_OAUTH_TOKEN` | Yes* | — | Auth for Agent SDK (*or `ANTHROPIC_API_KEY`) |
| `ASSISTANT_NAME` | No | `Cal` | Bot display name in messages |
| `CONTAINER_IMAGE` | No | `nanoclaw-agent:latest` | Docker image name |
| `CONTAINER_TIMEOUT` | No | `300000` | Container timeout (ms) |
| `MAX_CONCURRENT_CONTAINERS` | No | `5` | Max parallel containers |
| `LOG_LEVEL` | No | `info` | Pino log level |
| `TZ` | No | System | Timezone for cron schedules |

## Skills (Claude Code)

| Skill | When to Use |
|-------|-------------|
| `/setup` | First-time installation, authentication, service configuration |
| `/customize` | Adding channels, integrations, changing behavior |
| `/debug` | Container issues, logs, troubleshooting |
| `/single-user-mode` | Convert from multi-group to single-user architecture |

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type check without emit
npm run format       # Prettier format

# Container
cd container && npm run build && cd ..   # Rebuild agent-runner TypeScript
./container/build.sh                     # Rebuild Docker image

# Service management (macOS launchd)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

After changes to host code: `npm run build` then restart service.
After changes to container code or Dockerfile: rebuild container image then restart service.
After changes to `groups/main/CLAUDE.md`: no rebuild needed (mounted live).

## Common Patterns

- **Telegram message limit**: 4096 chars. `sendMessage()` auto-splits longer messages.
- **Typing indicator**: Repeating timer every 4.5s (Telegram expires after 5s).
- **Queue retry**: Exponential backoff, 5 retries, base 5s. Resets on success.
- **Container naming**: `nanoclaw-main-{timestamp}`. Stale containers cleaned on startup.
- **Structured output fallback**: If agent can't produce valid JSON schema, falls back to text result.
- **IPv4 forced**: Telegram API connections use `https.Agent({ family: 4 })` to avoid IPv6 issues.
