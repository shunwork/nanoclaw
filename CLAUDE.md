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
           └── runContainerAgent() → Docker Container
                  ├── Claude Agent SDK (query())
                  ├── Tools: Bash, Read/Write/Edit/Glob/Grep, WebSearch/WebFetch, Task/Teams
                  ├── agent-browser (Chromium-based)
                  └── MCP nanoclaw: send_message, schedule_task, list/pause/resume/cancel_task
                         ↓
                  IPC (file-based) → host polls → sendMessage() / createTask()
```

### Message Flow

1. Telegram message → `bot.on('message:text')` → `storeMessage()` to SQLite + `queue.enqueueMessageCheck()`
2. Queue waits for container slot → `processMessages()` → reads unprocessed messages from DB, formats as XML prompt
3. `runContainerAgent()` → spawns Docker container, pipes JSON via stdin
4. Container runs `agent-runner` → calls Agent SDK `query()` with tools
5. Agent produces text results (multiple possible via streaming), wrapped in `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` pairs
6. Host parses each result → strips `<internal>...</internal>` tags → sends remainder to Telegram

### Multi-Turn Container

Containers stay alive between messages. After the initial query completes:
1. Host writes follow-up messages as JSON files to `data/ipc/main/input/`
2. Agent-runner polls `/workspace/ipc/input/` and feeds messages into a new `query()` call
3. When idle too long, host writes `_close` sentinel → container exits gracefully

### IPC Flow (container → host)

Container writes JSON files to `/workspace/ipc/{messages,tasks}/`. Host's `startIpcWatcher()` polls every 1s:
- **messages/**: `send_message` calls → host sends to Telegram immediately
- **tasks/**: `schedule_task`, `pause_task`, `resume_task`, `cancel_task`, `new_session` → host writes to SQLite

### Task Scheduler Flow

`startSchedulerLoop()` polls SQLite every 60s for due tasks → `queue.enqueueTask()` → `runTask()` → same `runContainerAgent()` pipeline. Tasks support cron, interval, and one-time schedules.

### Session Continuity

Agent SDK sessions are stored in `data/sessions/main/.claude/`. The host tracks `sessionId` and passes it as `resume` option to `query()`, enabling multi-turn conversations across separate container invocations.

## Directory Structure

```
src/                        Host process (TypeScript, compiled to dist/)
  index.ts                  Main: Telegram bot, message routing, IPC watcher
  channels/telegram.ts      TelegramChannel: grammy bot, typing indicator, message splitting
  config.ts                 OWNER_CHAT_JID, ASSISTANT_NAME, AGENT_MODEL, paths, timeouts
  container-runner.ts       Docker container spawn, volume mounts, streaming output parsing
  task-scheduler.ts         Scheduled task execution loop
  db.ts                     SQLite: messages, tasks, sessions, router state
  group-queue.ts            Serialized queue with retry backoff, concurrency limit
  mount-security.ts         Validates additional mounts against external allowlist
  ipc.ts                    IPC watcher: polls data/ipc/main/ for container messages
  router.ts                 Message formatting (XML) and outbound text processing
  env.ts                    .env file reader (selective key loading)
  types.ts                  OwnerConfig, ContainerConfig, ScheduledTask, etc.
  logger.ts                 Pino logger with pino-pretty

container/                  Docker container image
  Dockerfile                Node 22-slim + Chromium + agent-browser + claude-code
  build.sh                  Docker build wrapper
  agent-runner/src/
    index.ts                Reads ContainerInput from stdin, runs query() loop, streams output
    ipc-mcp-stdio.ts        Standalone MCP server: send_message, schedule/list/pause/resume/cancel, new_session
  skills/
    agent-browser.md        Browser automation reference (not auto-loaded, see notes below)

AgentBrain/                 Obsidian-compatible vault (git submodule)
  agentmind/                soul.md, identity.md, evolution/
  memory/                   user.md, tool.md, context.md, memory.md, daily/
  knowledge/                Knowledge notes with wiki-links

groups/main/                Agent workspace (mounted → /workspace/group)
  CLAUDE.md                 Agent's system instructions and persistent memory
  conversations/            Auto-archived past conversations (by PreCompact hook)
  logs/                     Per-run container logs
  .claude/skills/           Agent SDK auto-discovered skills (if any)

store/messages.db           SQLite database (messages, scheduled_tasks, task_run_logs, etc.)
data/ipc/main/              IPC files: messages/, tasks/, input/ (ephemeral)
data/sessions/main/.claude/ Agent SDK session transcripts
data/env/                   (Legacy — secrets now passed via stdin JSON)

tests/                      Integration and unit tests (vitest)
  message-pipeline.test.ts  User message → Telegram reply pipeline
  group-queue.test.ts       Queue concurrency, retry, priority
  session-reset.test.ts     IPC new_session and wrappedOnOutput logic

.claude/skills/             Claude Code skills (for development, NOT for container agent)
docs/                       REQUIREMENTS.md, SECURITY.md, SPEC.md, SDK_DEEP_DIVE.md, DEBUG_CHECKLIST.md, message-system-design.md
```

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Main: Telegram bot, message routing, IPC watcher, graceful shutdown |
| `src/channels/telegram.ts` | `TelegramChannel`: grammy bot, typing timer, 4096-char message split |
| `src/config.ts` | `OWNER_CHAT_JID`, `ASSISTANT_NAME`, `AGENT_MODEL`, paths, timeouts |
| `src/container-runner.ts` | `runContainerAgent()`, `buildVolumeMounts()`, `writeTasksSnapshot()` |
| `src/db.ts` | All SQLite operations: messages, tasks, sessions, router state |
| `src/group-queue.ts` | `GroupQueue`: serialized processing, retry with exponential backoff |
| `src/task-scheduler.ts` | `startSchedulerLoop()`, `runTask()` |
| `src/ipc.ts` | `startIpcWatcher()`: polls IPC dirs, processes messages and task commands |
| `src/router.ts` | `formatMessages()`: XML formatting; `formatOutbound()`: text cleanup |
| `src/mount-security.ts` | Validates mounts against `~/.config/nanoclaw/mount-allowlist.json` |
| `container/agent-runner/src/index.ts` | Container entrypoint: query loop, AgentBrain loading, streaming output |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | Standalone MCP server: 7 tools for host communication |
| `groups/main/CLAUDE.md` | Agent's personality, instructions, and memory |

## Container Agent Configuration

The agent runs the model specified by `AGENT_MODEL` env var (default: `claude-sonnet-4-6`) with these settings (in `container/agent-runner/src/index.ts`):

- **allowedTools**: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`, `WebSearch`, `WebFetch`, `Task`, `TaskOutput`, `TaskStop`, `TeamCreate`, `TeamDelete`, `SendMessage`, `TodoWrite`, `ToolSearch`, `Skill`, `NotebookEdit`, `mcp__nanoclaw__*`
- **permissionMode**: `bypassPermissions` (sandboxed in Docker container)
- **settingSources**: `['project', 'user']` — reads `CLAUDE.md` and `.claude/` from `/workspace/group`
- **mcpServers**: `nanoclaw` (standalone stdio process, defined in `ipc-mcp-stdio.ts`)
- **hooks**: `PreCompact` (archives transcripts), `PreToolUse/Bash` (strips secrets from Bash env)
- **systemPrompt**: AgentBrain core memory injected via `loadCoreMemory()` (soul, identity, user, tool, long-term memory)
- **cwd**: `/workspace/group`

### AgentBrain Integration

On container startup, the agent-runner loads memory from `/workspace/brain/`:
- **Core memory** → injected into `systemPrompt` (stable, cacheable): soul.md, identity.md, user.md, tool.md, memory.md
- **Volatile context** → prepended to first prompt only (new sessions): context.md, yesterday's daily log, today's daily log

### Container Volume Mounts

| Container Path | Host Path | Access |
|----------------|-----------|--------|
| `/workspace/project` | Project root | read-write |
| `/workspace/group` | `groups/main/` | read-write |
| `/workspace/brain` | `AgentBrain/` | read-write |
| `/home/node/.claude` | `data/sessions/main/.claude/` | read-write |
| `/workspace/ipc` | `data/ipc/main/` | read-write |
| `/app/src` | `container/agent-runner/src/` | read-only |
| `/workspace/extra/*` | Additional mounts (if configured) | per-config |

Secrets (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) are passed via stdin JSON, not mounted as files.

### Extending the Agent

- **Add MCP servers**: Add to `mcpServers` object in `container/agent-runner/src/index.ts`.
- **Add skills**: Place `.md` files in `groups/main/.claude/skills/` — auto-loaded by Agent SDK.
- **Add hooks**: Add to `hooks` object in `query()` options (`PreToolUse`, `PostToolUse`, `PreCompact`, `Notification`).
- **Change instructions**: Edit `groups/main/CLAUDE.md` — no rebuild needed.
- **Change model**: Set `AGENT_MODEL` in `.env` and restart — no rebuild needed.

Note: `container/skills/agent-browser.md` is a reference file but is NOT auto-loaded by the Agent SDK (it's not under `.claude/skills/`). The agent-browser instructions are currently embedded in `groups/main/CLAUDE.md`.

## Database Schema

```sql
chats (jid TEXT PK, name TEXT, last_message_time TEXT)
messages (id TEXT, chat_jid TEXT, sender TEXT, sender_name TEXT, content TEXT, timestamp TEXT, is_from_me INTEGER)
scheduled_tasks (id TEXT PK, group_folder TEXT, chat_jid TEXT, prompt TEXT, schedule_type TEXT, schedule_value TEXT, context_mode TEXT, next_run TEXT, last_run TEXT, last_result TEXT, status TEXT, created_at TEXT)
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
| `AGENT_MODEL` | No | `claude-sonnet-4-6` | Claude model for agents |
| `ASSISTANT_NAME` | No | `Cal` | Bot display name in messages |
| `CONTAINER_IMAGE` | No | `nanoclaw-agent:latest` | Container image name |
| `CONTAINER_TIMEOUT` | No | `1800000` | Container timeout (ms, 30 min) |
| `IDLE_TIMEOUT` | No | `1800000` | Idle timeout before closing container (ms, 30 min) |
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
| `/add-memory` | Add AgentBrain memory system (vault, knowledge, reflection) |
| `/add-personality` | Add AgentBrain personality module (soul, identity, evolution) |
| `/set-default-model` | Change the Claude model used by agents |
| `/server-migration` | Migrate NanoClaw to a new machine |
| `/detailed-logs` | Add request/response logging to container logs |
| `/add-heptabase` | Add Heptabase MCP integration |

## Branch Strategy

This is a fork of [gavrielc/nanoclaw](https://github.com/gavrielc/nanoclaw). Branches serve different purposes:

| Branch | Purpose | Merges from |
|--------|---------|-------------|
| `main` | Track upstream. Never commit custom changes here. | `upstream/main` |
| `feature/customization-v2` | Shareable skills (`.claude/skills/` only). PR-able back to upstream. | `main` |
| `feature/myclaw-v2` | Personal deployment. All customizations (Telegram, model, env, preferences). | `main`, `feature/customization-v2` |

**Rules:**
- Sync upstream: `git fetch upstream && git checkout main && git merge upstream/main`
- After syncing main, rebase both branches: `git checkout feature/myclaw-v2 && git rebase main`
- `feature/customization-v2` should never contain `src/` code changes — only skill files
- Personal config changes (tokens, assistant name, language) only go on `feature/myclaw-v2`

**Adding new features (skill → code workflow):**
1. Create the skill file on `feature/customization-v2` and commit
2. Switch to `feature/myclaw-v2`, merge from `feature/customization-v2` with `--no-ff` to preserve merge history
3. Apply the code changes (`src/`, `container/`, `CLAUDE.md`, etc.) on `feature/myclaw-v2` and commit

```bash
# Example: adding a new integration
git checkout feature/customization-v2
# ... create .claude/skills/add-foo/SKILL.md, commit ...
git checkout feature/myclaw-v2
git merge feature/customization-v2 --no-ff -m "Merge skill: add-foo from feature/customization-v2"
# ... apply code changes, commit ...
```

**Security: Before committing or pushing `feature/myclaw-v2` (or branches based on it), always review the diff for secrets, tokens, API keys, personal info, or hardcoded credentials. The repo is public.**

## Development

Run commands directly — don't tell the user to run them.

```bash
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript to dist/
npm run typecheck    # Type check without emit
npm run test         # Run unit/integration tests (vitest)
npm run format       # Prettier format

# Container
cd container && npm run build && cd ..   # Rebuild agent-runner TypeScript
./container/build.sh                     # Rebuild Docker container image

# Service management (macOS launchd)
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Change workflow

Always follow this order before restarting the service:

1. **Typecheck**: `npm run typecheck` (and `cd container/agent-runner && npx tsc --noEmit` if container code changed)
2. **Test**: `npm test` — all tests must pass
3. **Build**: `npm run build` (and `cd container && npm run build && cd .. && ./container/build.sh` if container code changed)
4. **Restart**: `launchctl unload` + `launchctl load`

After changes to `groups/main/CLAUDE.md`: no rebuild needed (mounted live).

## Common Patterns

- **Telegram message limit**: 4096 chars. `sendMessage()` auto-splits longer messages.
- **Typing indicator**: Repeating timer every 4.5s (Telegram expires after 5s).
- **Queue retry**: Exponential backoff, 5 retries, base 5s. Resets on success.
- **Container naming**: `nanoclaw-main-{timestamp}`. Stale containers cleaned on startup.
- **Internal tags**: Agent wraps non-user content in `<internal>...</internal>`. Host strips before sending (both result pipeline and IPC send_message).
- **Replay detection**: UUID-based — agent-runner loads known UUIDs from session transcript at startup, skips replayed assistant messages during session resume.
- **Result fallback**: When `result.result` is empty (e.g., agent's last turn was tool calls), falls back to text from assistant messages.
- **Session reset**: Agent calls `new_session` MCP tool → IPC → host clears session record → next container starts fresh.
- **IPv4 forced**: Telegram API connections use `https.Agent({ family: 4 })` to avoid IPv6 issues.
- **Streaming output**: Multiple `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` pairs per container run.
