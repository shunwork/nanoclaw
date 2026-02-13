---
name: add-heptabase
description: Add Heptabase MCP integration to NanoClaw. Gives the agent read/write access to your Heptabase workspace (cards, whiteboards, journals). Uses mcp-remote with OAuth token caching. Triggers on "add heptabase", "heptabase mcp", "heptabase integration".
---

# Add Heptabase MCP Integration

This skill adds Heptabase access to the NanoClaw agent via the official [Heptabase MCP server](https://support.heptabase.com/en/articles/12679581-how-to-use-heptabase-mcp). The agent can read, create, and modify cards, whiteboards, and journal entries.

Heptabase MCP uses **HTTP transport + OAuth 2.1**, which requires a one-time browser-based authorization. We use [`mcp-remote`](https://github.com/geelen/mcp-remote) as a stdio bridge that handles OAuth token caching and automatic refresh.

## Prerequisites

1. A Heptabase account with an active subscription
2. NanoClaw running (container agent functional)
3. A web browser on the host machine (for one-time OAuth)

---

## Step 1: OAuth Authorization (Host Machine)

Run `mcp-remote` on the host to complete the one-time OAuth flow:

```bash
npx -y mcp-remote@latest https://api.heptabase.com/mcp --transport http-only
```

This will:
1. Open your browser to Heptabase's authorization page
2. After you authorize, store the OAuth tokens at `~/.mcp-auth/`

Wait for the user to confirm authorization is complete, then verify tokens were saved:

```bash
ls ~/.mcp-auth/ && echo "OAuth tokens saved successfully" || echo "ERROR: No tokens found"
```

If no tokens are found, retry the authorization. If the browser didn't open automatically, check the terminal output for a URL to open manually.

### Token Refresh

`mcp-remote` automatically refreshes expired access tokens using the stored refresh token. If the refresh token itself expires (typically after extended inactivity), re-run the authorization command above.

---

## Step 2: Mount Token Cache into Container

Read `src/container-runner.ts` and find the `buildVolumeMounts` function.

Add this mount block (after the `.claude` sessions mount is a good location):

```typescript
// Heptabase MCP OAuth token cache (used by mcp-remote)
const mcpAuthDir = path.join(HOME_DIR, '.mcp-auth');
if (fs.existsSync(mcpAuthDir)) {
  mounts.push({
    hostPath: mcpAuthDir,
    containerPath: '/home/node/.mcp-auth',
    readonly: false,  // mcp-remote needs write access for token refresh
  });
}
```

Where `HOME_DIR` is the home directory variable already defined in `src/config.ts` (used for `MOUNT_ALLOWLIST_PATH`). If it's not accessible in `buildVolumeMounts`, use:

```typescript
const HOME_DIR = process.env.HOME || '/Users/user';
```

---

## Step 3: Add Heptabase MCP to Agent Runner

Read `container/agent-runner/src/index.ts` and find the `mcpServers` config in the `query()` call.

Add `heptabase` to the `mcpServers` object:

```typescript
heptabase: {
  command: 'npx',
  args: ['-y', 'mcp-remote@latest', 'https://api.heptabase.com/mcp', '--transport', 'http-only'],
}
```

Find the `allowedTools` array and add:

```typescript
'mcp__heptabase__*'
```

The result should look like:

```typescript
mcpServers: {
  nanoclaw: ipcMcp,
  heptabase: {
    command: 'npx',
    args: ['-y', 'mcp-remote@latest', 'https://api.heptabase.com/mcp', '--transport', 'http-only'],
  }
},
allowedTools: [
  'Bash',
  'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch',
  'mcp__nanoclaw__*',
  'mcp__heptabase__*'
],
```

---

## Step 4: Update Agent Instructions

Append to `groups/main/CLAUDE.md` so the agent knows about its Heptabase capabilities:

```markdown

## Heptabase

You have access to Heptabase via MCP tools (prefixed with `mcp__heptabase__`). Use these to:
- Search and read cards
- Create new cards and journal entries
- Organize cards into whiteboards
- Browse whiteboard structures

When the user asks about their notes, knowledge base, or wants to save/organize information, use the Heptabase tools.
```

---

## Step 5: Build and Restart

Rebuild the container (mcp-remote needs to be available inside):

```bash
cd container && npm run build && cd .. && ./container/build.sh
```

Build the host (container-runner mount changes):

```bash
npm run build
```

Restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

Verify it started:

```bash
sleep 3 && launchctl list | grep nanoclaw
```

---

## Step 6: Test

Tell the user:

> Heptabase integration is ready! Test it by sending a message like:
>
> "Search my Heptabase cards about [topic]"
>
> or:
>
> "Create a new card in Heptabase titled [title]"

Monitor logs for MCP connection:

```bash
tail -f logs/nanoclaw.log
```

Also check the container log for MCP server status:

```bash
ls -t groups/main/logs/container-*.log | head -1 | xargs cat | head -30
```

The init message should show `heptabase` as a connected MCP server.

---

## Troubleshooting

### MCP server shows "failed" status

Check that OAuth tokens exist and are accessible:

```bash
ls -la ~/.mcp-auth/
```

If empty or missing, re-run Step 1 authorization.

### OAuth token expired / refresh failed

Re-authorize on the host:

```bash
npx -y mcp-remote@latest https://api.heptabase.com/mcp --transport http-only
```

No rebuild needed — the mounted `~/.mcp-auth/` directory is shared live.

### Container can't reach Heptabase API

Verify the container has network access:

```bash
docker run --rm nanoclaw-agent:latest curl -s https://api.heptabase.com/mcp | head -5
```

### npx mcp-remote not found in container

The container uses `node:22-slim` which includes npm/npx. If there's an issue, check:

```bash
docker run --rm nanoclaw-agent:latest npx --version
```

### Slow startup (mcp-remote downloading)

First run in a new container downloads `mcp-remote` via npx. Subsequent runs use the npm cache. To pre-install for faster startup, add to `container/Dockerfile` before the `USER node` line:

```dockerfile
RUN npm install -g mcp-remote
```

Then rebuild the container image.

---

## Removing Heptabase Integration

1. Remove from `container/agent-runner/src/index.ts`:
   - Delete `heptabase` from `mcpServers`
   - Remove `'mcp__heptabase__*'` from `allowedTools`

2. Remove from `src/container-runner.ts`:
   - Delete the `~/.mcp-auth` mount block

3. Remove Heptabase section from `groups/main/CLAUDE.md`

4. Rebuild:
   ```bash
   cd container && npm run build && cd .. && ./container/build.sh
   npm run build
   launchctl kickstart -k gui/$(id -u)/com.nanoclaw
   ```

5. Optionally clean up tokens:
   ```bash
   rm -rf ~/.mcp-auth/
   ```
