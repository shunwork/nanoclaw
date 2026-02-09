---
name: set-default-model
description: Change the default Claude model used by NanoClaw agents. Use when user wants to switch models (e.g., Sonnet, Opus, Haiku) for cost, speed, or capability reasons. Triggers on "change model", "set model", "use sonnet", "use opus", "use haiku", "default model".
---

# Set Default Model

Change the Claude model that NanoClaw agents use by default.

## Available Models

Ask the user which model they want:

> Which Claude model should agents use by default?
>
> **Option 1: Claude Sonnet 4.5** (Recommended)
> - Best balance of speed and capability
> - Model ID: `claude-sonnet-4-5-20250929`
>
> **Option 2: Claude Opus 4.6**
> - Most capable, slower and more expensive
> - Model ID: `claude-opus-4-6`
>
> **Option 3: Claude Haiku 4.5**
> - Fastest and cheapest, less capable
> - Model ID: `claude-haiku-4-5-20251001`

Store their choice for the step below.

## Implementation

Read `container/agent-runner/src/index.ts` and find the `query()` call (around line 270). Add or update the `model` property in the `options` object:

```typescript
for await (const message of query({
  prompt,
  options: {
    model: 'MODEL_ID_HERE',  // Add or update this line
    cwd: '/workspace/group',
    resume: input.sessionId,
    // ... rest of options
  }
})) {
```

Replace `MODEL_ID_HERE` with the model ID from the user's choice.

If no `model` property exists, the agent uses whatever model is the Claude Code default. Adding it explicitly locks the model.

## Rebuild Container

The agent runner runs inside the container, so you must rebuild:

```bash
cd container && ./build.sh
```

Wait for the build to complete, then restart the service:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

If using `npm run dev` instead of launchd, just restart the dev server.

## Verify

Check the logs after sending a test message:

```bash
tail -f logs/nanoclaw.log
```

The agent should complete successfully. Model choice affects response speed and quality but not the log format.

## Reverting to Default

To use the Claude Code default model (whatever is current), simply remove the `model` line from the `query()` options and rebuild the container.
