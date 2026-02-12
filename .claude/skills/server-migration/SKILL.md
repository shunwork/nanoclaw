# Skill: server-migration

Interactive guide for migrating NanoClaw to a new server or machine.

## When to Use

- User wants to move NanoClaw to a new machine, VPS, or server
- User says "migrate", "transfer to new server", "move to VPS", "server migration"
- User is setting up a backup deployment

## How to Run

This is an interactive skill. Follow these steps in order:

### Step 1: Gather Target Info

Use `AskUserQuestion` to ask:

1. **Target OS**: macOS / Ubuntu/Debian / Other Linux
2. **Connection**: SSH access info (user@host) or local setup
3. **Install path**: Where to clone the repo on the target (default: `~/Projects/nanoclaw`)

### Step 2: Migration Scope

Use `AskUserQuestion` to ask:

1. **Scope**: Essential only (DB + sessions + credentials) vs Full (includes logs, conversations, AgentBrain)

**Essential data** (always migrated):
| Data | Path | Purpose |
|------|------|---------|
| SQLite DB | `store/messages.db` | Messages, tasks, sessions |
| Agent sessions | `data/sessions/main/.claude/` | Conversation continuity |
| Credentials | `.env` | Bot token, API keys |
| Agent config | `groups/main/CLAUDE.md` | Agent personality & instructions |
| Agent skills | `groups/main/.claude/skills/` | Custom agent skills |

**Full data** (optional, adds):
| Data | Path | Purpose |
|------|------|---------|
| AgentBrain | `AgentBrain/` | Memory vault, personality |
| Container logs | `groups/main/logs/` | Historical run logs |
| Conversations | `groups/main/conversations/` | Archived transcripts |

### Step 3: Pre-Migration Checklist

Generate and display these checks for the user to run on the **source** machine:

```bash
# 1. Stop the service first
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist  # macOS
# or: systemctl --user stop nanoclaw                        # Linux

# 2. Check for running containers
docker ps --filter name=nanoclaw-

# 3. Check for uncommitted changes
cd /path/to/nanoclaw && git status

# 4. Check data sizes
du -sh store/messages.db data/sessions/ AgentBrain/ groups/main/logs/ groups/main/conversations/
```

### Step 4: Generate Transfer Commands

Based on the answers, generate rsync commands. Example for essential migration:

```bash
# From source machine — adjust paths as needed
TARGET="user@host:/path/to/nanoclaw"

# Clone repo on target first (run on target)
ssh user@host "cd /path/to && git clone https://github.com/user/nanoclaw.git && cd nanoclaw && git checkout feature/mysetting"

# Transfer essential data
rsync -avz --progress store/messages.db ${TARGET}/store/
rsync -avz --progress data/sessions/main/ ${TARGET}/data/sessions/main/
rsync -avz --progress groups/main/CLAUDE.md ${TARGET}/groups/main/
rsync -avz --progress groups/main/.claude/ ${TARGET}/groups/main/.claude/

# Transfer .env (SECURITY: uses SSH, but verify target is secure)
rsync -avz --progress .env ${TARGET}/
```

For full migration, add:
```bash
rsync -avz --progress AgentBrain/ ${TARGET}/AgentBrain/
rsync -avz --progress groups/main/logs/ ${TARGET}/groups/main/logs/
rsync -avz --progress groups/main/conversations/ ${TARGET}/groups/main/conversations/
```

**IMPORTANT**: Warn the user that `.env` contains secrets. Verify target machine security before transferring.

### Step 5: Target Setup Commands

Generate OS-specific setup commands for the target:

#### Common (all OS):
```bash
cd /path/to/nanoclaw

# Install dependencies
npm install

# Build host
npm run build

# Build container
cd container && npm install && npm run build && cd ..
./container/build.sh

# Create required directories
mkdir -p data/ipc/main/{messages,tasks} data/env data/sessions/main/.claude store groups/main/logs
```

#### macOS (launchd):
```bash
# Create plist (adjust paths in the template)
cp docs/com.nanoclaw.plist ~/Library/LaunchAgents/
# Edit the plist to set correct paths and environment
nano ~/Library/LaunchAgents/com.nanoclaw.plist

# Load and start
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

#### Linux (systemd):
```bash
# Create systemd user service
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/nanoclaw.service << 'EOF'
[Unit]
Description=NanoClaw Telegram Bot
After=network.target docker.service

[Service]
Type=simple
WorkingDirectory=/path/to/nanoclaw
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
EnvironmentFile=/path/to/nanoclaw/.env

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable nanoclaw
systemctl --user start nanoclaw
```

### Step 6: Verification

Generate verification commands:

```bash
# Check service is running
# macOS:
launchctl list | grep nanoclaw
# Linux:
systemctl --user status nanoclaw

# Check logs
tail -f logs/nanoclaw.log

# Check Docker
docker ps --filter name=nanoclaw-

# Send a test message to the bot on Telegram
# Verify response arrives
```

### Step 7: Cutover Guidance

Display:

1. **Stop source service** — prevent duplicate responses
2. **Final sync** — run rsync one more time to catch last messages
3. **Start target service** — verify it responds
4. **DNS/proxy** — if using a webhook (not applicable for long polling, but note it)
5. **Keep source as backup** — don't delete source data for at least a week

## Notes

- NanoClaw uses Telegram long polling, so no DNS/webhook changes needed — just stop source, start target
- SQLite DB should be copied while the service is stopped to avoid corruption
- Session continuity depends on `data/sessions/main/.claude/` — without it, the agent starts a fresh conversation
- AgentBrain memory is in `AgentBrain/` submodule — `git submodule update --init` on target if needed
