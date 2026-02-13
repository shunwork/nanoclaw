---
name: set-default-model
description: Change the default Claude model used by NanoClaw agents. Use when user wants to switch models (e.g., Sonnet, Opus, Haiku) for cost, speed, or capability reasons. Triggers on "change model", "set model", "use sonnet", "use opus", "use haiku", "default model".
---

# Set Default Model

Change the Claude model that NanoClaw agents use by default.

## Available Models

Ask the user which model they want using `AskUserQuestion`:

- **Claude Sonnet 4.5** (Recommended) — Best balance of speed and capability. Model ID: `claude-sonnet-4-5-20250929`
- **Claude Opus 4.6** — Most capable, slower and more expensive. Model ID: `claude-opus-4-6`
- **Claude Haiku 4.5** — Fastest and cheapest, less capable. Model ID: `claude-haiku-4-5-20251001`

## Implementation

The model is controlled by the `AGENT_MODEL` environment variable, which the host passes into the container at runtime.

### If the code changes are already applied

Just set the env var in `.env`:

```
AGENT_MODEL=claude-sonnet-4-5-20250929
```

Then restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

No container rebuild needed — the env var is passed through at runtime.

### If the code changes are NOT applied yet

Three files need changes:

1. **`src/config.ts`** — Add the env var:
   ```typescript
   export const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-5-20250929';
   ```

2. **`src/container-runner.ts`** — Import `AGENT_MODEL` from config, then pass it to the container in `buildContainerArgs()`:
   ```typescript
   args.push('-e', `AGENT_MODEL=${AGENT_MODEL}`);
   ```

3. **`container/agent-runner/src/index.ts`** — Read from env in the `query()` call:
   ```typescript
   model: process.env.AGENT_MODEL || 'claude-sonnet-4-5-20250929',
   ```

Then build and rebuild:

```bash
npm run build
cd container && npm run build && cd .. && ./container/build.sh
```

## Verify

After restarting, send a test message and check logs:

```bash
tail -f logs/nanoclaw.log
```

The agent should complete successfully. Model choice affects response speed and quality but not the log format.

## Reverting to Default

Remove `AGENT_MODEL` from `.env` (or set it to `claude-sonnet-4-5-20250929`) and restart the service.
