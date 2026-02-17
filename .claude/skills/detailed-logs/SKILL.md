# Skill: detailed-logs

Enable detailed logging in container log files and structured pino host log.

## When to Use

- User wants to see what the agent received and responded with
- Debugging agent behavior or unexpected responses
- Auditing conversation flow
- User says "detailed logs", "enable logging", "log requests and responses"

## Architecture

### 1. Container Log Files (`groups/main/logs/container-*.log`)

Real-time stderr capture — every `[agent-runner]` line is appended as it arrives, including multi-turn conversations. Format:

```
=== nanoclaw-main-1771341316097 ===
Started: 2026-02-17T15:15:16.098Z
Session: 639eb607-0ba2-41ac-a5b8-70699248c9e3
Prompt: 192 chars

[agent-runner] Received input for group: main
[agent-runner] Loaded 209 known UUIDs from transcript
[agent-runner] Starting query Q1 (session: 639eb607-..., resumeAt: latest, knownUuids: 209)...
[agent-runner] Core memory loaded: 5707 chars
[agent-runner] [Q1 #1] system/init session=639eb607-...
[agent-runner] [Q1 #2] assistant uuid=e05f5482… text=回覆內容… (315 chars)
[agent-runner] [Q1 #3] assistant uuid=fe418faa…
  → Read { file_path: "/workspace/brain/memory/context.md" }
[agent-runner] [Q1 #5] assistant uuid=1e69e94a…
  → Edit { file_path: "/workspace/group/CLAUDE.md", old_string: "## Communication…" }
[agent-runner] [Q1 result#1] source=assistant-fallback text=回覆… (315 chars)
[agent-runner] Piping IPC message into active query (131 chars)
[agent-runner] [Q1 #10] system/init session=639eb607-...
[agent-runner] [Q1 #11] assistant uuid=afedc820… text=第二輪回覆… (179 chars)
[agent-runner] [Q1 result#2] source=result text=第二輪回覆… (179 chars)
[agent-runner] Query Q1 done. Messages: 12, results: 2, closedDuringQuery: false

=== Completed ===
Duration: 215324ms
Exit code: 0
```

Key properties:
- **Real-time append** — each stderr line written as it arrives
- **Multi-turn captured** — piped IPC messages and subsequent results all logged
- **Tool parameters shown** — each tool_use block on its own line with `→` prefix, values truncated to 80 chars
- **tool_use_summary events** logged when available from SDK
- **No stdout** — OUTPUT markers are protocol, not useful for debugging

### 2. Structured Pino Log (`logs/nanoclaw.log`)

Key log lines at INFO level:

| Log message | Fields |
|-------------|--------|
| `Message received` | `chatJid`, `sender`, `preview` (100 chars), `length` |
| `Processing messages` | `messageCount` |
| `Enqueued for new container` | — |
| `Piped to active container` | `count` |
| `Session updated` | `folder`, `sessionId` |
| `Agent output` | `preview` (200 chars, newlines replaced), `length` |
| `Agent interaction` | `promptPreview`, `promptLength`, `messageCount`, `outputSentToUser`, `responsePreview`, `hadError`, `status` |

## Files Modified

| File | Change |
|------|--------|
| `src/container-runner.ts` | Real-time stderr append to log file, minimal header/footer |
| `src/index.ts` | Structured pino fields (message preview, session updates, typing fix) |
| `container/agent-runner/src/index.ts` | Tool name + parameters logging, tool_use_summary events |

## Implementation

Changes are already applied. After modifying these files:

```bash
npm run build                              # Recompile host
cd container/agent-runner && npm run build  # Recompile agent-runner
./container/build.sh                       # Rebuild container image
# Restart service (launchctl unload/load)
```

## Verification

1. Send a test message to the bot
2. Check `groups/main/logs/container-*.log` — should show `[agent-runner]` lines with tool parameters
3. Check `logs/nanoclaw.log` — should have "Message received" with `preview` field
4. Send a follow-up message (multi-turn) — verify second turn appears in the same container log file
5. Check `docker logs <container>` matches the container log file content
