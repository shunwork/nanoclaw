# Skill: detailed-logs

Enable detailed request/response logging in container log files and structured pino output.

## When to Use

- User wants to see what the agent received and responded with
- Debugging agent behavior or unexpected responses
- Auditing conversation flow
- User says "detailed logs", "enable logging", "log requests and responses"

## What It Does

Enhances two logging paths:

### 1. Container Log Files (`groups/main/logs/container-*.log`)

In non-verbose mode, appends request/response content after the operational log. The container output is streamed via `onOutput` callbacks and collected in `streamedResults: string[]`, then appended to the log file in the `container.on('close')` handler:

```
=== User Request ===
<messages><message sender="shun" time="14:07">...</message></messages>

=== Agent Response ===
...streamed response lines...
Internal reasoning:
...more response...
```

Content is truncated:
- User prompt: 2000 chars max
- Agent response (streamed results): 2000 chars max

For error cases, the error message is appended instead.

### 2. Structured Pino Log (`logs/nanoclaw.log`)

Adds an "Agent interaction" log line after each agent call with:
- `promptPreview`: first 200 chars of prompt (newlines replaced with spaces)
- `promptLength`: total prompt character count
- `messageCount`: number of missed messages processed
- `outputSentToUser`: boolean, whether a message was sent to Telegram
- `hadError`: boolean, whether an error occurred
- `status`: final output status (message, log, or error)

Example:
```json
{
  "promptPreview": "You are Cal, a personal assistant...",
  "promptLength": 5234,
  "messageCount": 3,
  "outputSentToUser": true,
  "hadError": false,
  "status": "message",
  "msg": "Agent interaction"
}
```

## Files Modified

| File | Change |
|------|--------|
| `src/container-runner.ts` | Collects streamed output via `onOutput` callbacks; appends request/response sections to log file in `container.on('close')` handler |
| `src/index.ts` | Structured pino logger call after agent interaction with preview fields and metadata |

## Implementation

The changes are applied directly by this skill. After applying:

```bash
npm run build        # Recompile host
# Restart the service (launchctl unload/load or restart process)
```

No container rebuild needed — these are host-side changes only.

## How It Works

**Container Output Streaming:**
- `runContainerAgent()` uses `onOutput` callback to collect streamed results
- Each streamed output line is pushed to `streamedResults: string[]`
- When container closes, the full streamed output is appended to the log file

**Pino Structured Logging:**
- After `query()` resolves, host logs structured metadata with previews
- Prompt and response are truncated to reasonable lengths for log readability
- Useful for analytics, debugging, and auditing agent behavior

## Verification

1. Send a test message to the bot
2. Check the latest `groups/main/logs/container-*.log` — should have `=== User Request ===` and `=== Agent Response ===` sections
3. Tail pino output (`logs/nanoclaw.log`) for `"msg":"Agent interaction"` lines with preview fields and metadata

## Customization

To disable detailed logs:
- Set `verbose: false` in `src/config.ts` — container log will omit request/response sections
- Remove the pino structured logging call in `src/index.ts` if you prefer less verbose logs

To adjust truncation limits:
- **Prompt truncation**: edit `prompt.slice(0, 2000)` in `src/container-runner.ts`
- **Response truncation**: edit `streamedResults.join('').slice(0, 2000)` in `src/container-runner.ts`
- **Preview truncation**: edit `prompt.slice(0, 200)` in `src/index.ts`
