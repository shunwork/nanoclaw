# Direction A: Stream Assistant Text Immediately

## When to Consider

If current approach (fallback on result) proves insufficient:
- User complains about delayed responses (waiting for tool calls to finish)
- Agent frequently produces text early + long tool operations
- Need real-time streaming feel in Telegram

## Architecture

Instead of waiting for `result` message, emit output whenever the agent produces text in an `assistant` message.

### Agent-Runner Changes (`container/agent-runner/src/index.ts`)

UUID-based replay detection is already implemented. The remaining change is to emit `writeOutput` from assistant text blocks instead of waiting for result:

```typescript
// In runQuery(), the assistant message handler already extracts text.
// Change: emit immediately instead of storing in lastAssistantText.

if (message.type === 'assistant' && 'uuid' in message) {
  const uuid = (message as { uuid: string }).uuid;
  if (knownUuids.has(uuid)) continue; // replay, skip

  knownUuids.add(uuid);
  const text = extractAssistantText(message);
  if (text) {
    // Direction A: emit immediately instead of lastAssistantText = text
    writeOutput({ status: 'success', result: text, newSessionId });
  }
}
```

### Host-Side Changes

Minimal — host already handles streaming output (multiple `writeOutput` calls per container run). The `onOutput` callback in `processMessages()` sends each result to Telegram.

### Edge Cases

- **Multiple text blocks**: Model says "let me check..." then later "here's what I found". Both get sent as separate Telegram messages. This is actually good UX.
- **Empty text between tool calls**: Assistant messages with only `tool_use` blocks have no text. These are automatically skipped.
- **IPC send_message overlap**: Agent might use `mcp__nanoclaw__send_message` AND produce text output. User could get duplicate content. Solution: add CLAUDE.md instruction to use one or the other.

### Migration from Current Design

1. ~~Add UUID tracking for replay detection~~ (done)
2. Emit `writeOutput()` from assistant text blocks
3. Remove `lastAssistantText` fallback logic
4. Keep the `result` handler but only for error status
5. Test with both new sessions and resumed sessions
