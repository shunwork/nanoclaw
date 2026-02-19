---
name: server-migration
description: Migrate NanoClaw to a new Mac. Two modes - export packs everything into a zip on the source machine, import unpacks and configures on the target. Triggers on migrate, server migration, export nanoclaw, import nanoclaw.
---

# Server Migration

Migrate NanoClaw between Macs via a single zip file.

## Usage

- `/server-migration export` — Run on **source** machine. Stops service, packs code + data into a zip.
- `/server-migration import` — Run on **target** machine. Unpacks zip, installs deps, configures service.

---

## Export (Source Machine)

### Step 1: Stop the service

```bash
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist 2>/dev/null
docker ps --filter name=nanoclaw- -q | xargs -r docker stop
```

Wait for both to complete. Warn the user: "Service stopped. Bot will not respond until import is complete on the target."

### Step 2: Create the export zip

The zip includes the **full project source** (excluding `node_modules`, `dist`, build artifacts) plus all stateful data and home-directory configs. Run from the project root (`process.cwd()`).

```bash
EXPORT_FILE="$HOME/nanoclaw-export-$(date +%Y%m%d).zip"

# Project source + data (exclude build artifacts, node_modules, .git internals)
zip -r "$EXPORT_FILE" . \
  -x "node_modules/*" \
  -x "dist/*" \
  -x "container/agent-runner/node_modules/*" \
  -x "container/agent-runner/dist/*" \
  -x ".git/*" \
  -x "AgentBrain/.git/*" \
  -x "data/ipc/*" \
  -x "logs/*"

# Heptabase OAuth tokens (outside project)
if [ -d "$HOME/.mcp-auth" ]; then
  (cd "$HOME" && zip -ur "$EXPORT_FILE" .mcp-auth/)
fi

# Mount allowlist (outside project)
if [ -f "$HOME/.config/nanoclaw/mount-allowlist.json" ]; then
  (cd "$HOME" && zip -ur "$EXPORT_FILE" .config/nanoclaw/mount-allowlist.json)
fi
```

### Step 3: Show result

Report the file path and size. Tell the user:

> Export complete: `<path>` (<size>)
>
> Transfer this file to the target Mac (AirDrop, USB, scp, etc.), then run `/server-migration import` with Claude Code on the target.
>
> **This file contains secrets (API keys, bot tokens). Delete it after import.**

### Step 4: Restart source (optional)

Ask the user: "Restart the bot on this machine, or leave it stopped for cutover?"

If restart:
```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

---

## Import (Target Machine)

### Step 1: Ask for the zip path

Use `AskUserQuestion`: "Where is the export zip file?" with a text input. Default: `~/nanoclaw-export-*.zip`

### Step 2: Choose restore method

Use `AskUserQuestion`:

- **From zip (Recommended)** — Restore project directly from the export zip. Fastest, no internet needed.
- **From GitHub** — Clone fresh from `https://github.com/shunwork/nanoclaw.git` and overlay data from zip. Use this if you want a clean git history on the target.

### Step 3a: Restore from zip

Ask the user for the target directory. Default: `~/Projects/nanoclaw`

```bash
mkdir -p <target_dir>
cd <target_dir>

# Unpack everything
unzip -o <zip_path> -d .

# Unpack home-relative files (.mcp-auth, .config/nanoclaw)
unzip -o <zip_path> '.mcp-auth/*' -d "$HOME" 2>/dev/null
unzip -o <zip_path> '.config/*' -d "$HOME" 2>/dev/null

# Re-initialize git (the .git dir was excluded from export)
git init
git remote add origin https://github.com/shunwork/nanoclaw.git
git fetch origin
git checkout -b feature/myclaw-v2
git add -A && git commit -m "Import from migration export"

# Initialize AgentBrain submodule
git submodule update --init --recursive
```

### Step 3b: Restore from GitHub

```bash
cd ~/Projects  # or user's chosen location
git clone https://github.com/shunwork/nanoclaw.git
cd nanoclaw
git checkout feature/myclaw-v2
git submodule update --init --recursive

# Overlay data from zip (overwrites repo defaults with exported state)
unzip -o <zip_path> \
  '.env' \
  'store/*' \
  'data/sessions/*' \
  'groups/*' \
  'AgentBrain/*' \
  -d .

# Unpack home-relative files
unzip -o <zip_path> '.mcp-auth/*' -d "$HOME" 2>/dev/null
unzip -o <zip_path> '.config/*' -d "$HOME" 2>/dev/null
```

### Step 4: Create required directories

```bash
mkdir -p store logs data/ipc/main/{messages,tasks,input} data/sessions/main/.claude
```

### Step 5: Install and build

```bash
# Host
npm install && npm run build

# Container agent-runner
cd container && npm install && npm run build && cd ..

# Container image (takes a few minutes)
./container/build.sh
```

### Step 6: Configure launchd

Generate the plist with correct paths for this machine:

```bash
NODE_PATH=$(which node)
PROJECT_DIR=$(pwd)

cat > ~/Library/LaunchAgents/com.nanoclaw.plist << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nanoclaw</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>--env-file=.env</string>
        <string>${PROJECT_DIR}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:${HOME}/.local/bin</string>
        <key>HOME</key>
        <string>${HOME}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${PROJECT_DIR}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_DIR}/logs/nanoclaw.error.log</string>
</dict>
</plist>
PLIST
```

### Step 7: Re-authorize Heptabase (if needed)

Check if the OAuth tokens work by testing mcp-remote:
```bash
timeout 10 npx mcp-remote@latest https://api.heptabase.com/mcp --transport http-only 2>&1 | head -5
```

If the output shows an auth error, re-authorize:
```bash
npx -y mcp-remote@latest https://api.heptabase.com/mcp --transport http-only
```

Complete the OAuth flow in the browser. No code changes needed.

### Step 8: Start and verify

```bash
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
sleep 3
launchctl list | grep nanoclaw
```

Tell the user to send a test message to the Telegram bot.

Check logs if there are issues:
```bash
tail -20 logs/nanoclaw.log
ls -t groups/main/logs/container-*.log | head -1 | xargs tail -30
```

### Step 9: Cleanup reminder

Tell the user:

> Migration complete. Remember to:
> 1. Stop the bot on the old machine (`launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist`)
> 2. Delete the export zip (it contains secrets)
> 3. Keep old machine data as backup for at least a week

---

## Notes

- Telegram uses long polling — no DNS/webhook changes needed. Just stop source, start target.
- Only one instance should run at a time to avoid duplicate responses.
- SQLite DB must be copied while the service is stopped to avoid corruption.
- `CLAUDE_CODE_OAUTH_TOKEN` in `.env` is tied to your Anthropic account, not the machine — it works on both.
- AgentBrain is a git submodule. The export includes the working tree; `git submodule update --init` may be needed if the `.git` reference is broken.
- Prerequisites on target: Node.js 22+, Docker (OrbStack recommended), Git.
