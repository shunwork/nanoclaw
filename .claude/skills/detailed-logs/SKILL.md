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

Appends request/response content after the operational log (non-verbose mode only — verbose already dumps full stdout/stderr):

```
=== User Request ===
<messages><message sender="shun" time="14:07">...</message></messages>

=== Agent Response ===
Output Type: message
User Message (45 chars):
...response text...
Internal Log:
...agent reasoning...
```

Content is truncated: user message to 2000 chars, internal log to 500 chars, prompt to 2000 chars.

For error cases, the error message is appended instead.

### 2. Structured Pino Log (`logs/nanoclaw.log`)

Adds an "Agent interaction" log line after each agent call with:
- `outputType`: message or log
- `promptPreview`: first 200 chars of prompt (newlines replaced)
- `responsePreview`: first 200 chars of response (newlines replaced)
- `promptLength`: total prompt character count
- `responseLength`: total response character count

## Files Modified

| File | Change |
|------|--------|
| `src/container-runner.ts` | Two-phase logging: append request/response after output parsing |
| `src/index.ts` | Structured pino log after `runAgent()` returns |

## Implementation

The changes are applied directly by this skill. After applying:

```bash
npm run build        # Recompile host
# Restart the service (launchctl unload/load or restart process)
```

No container rebuild needed — these are host-side changes only.

## Verification

1. Send a test message to the bot
2. Check the latest `groups/main/logs/container-*.log` — should have `=== User Request ===` and `=== Agent Response ===` sections
3. Check pino output for `"msg":"Agent interaction"` lines with preview fields
