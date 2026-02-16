# Direction A: Stream Assistant Text Immediately

## When to Consider

If Direction B (fallback on result) proves insufficient:
- User complains about delayed responses (waiting for tool calls to finish)
- Agent frequently produces text early + long tool operations
- Need real-time streaming feel in Telegram

## Architecture

Instead of waiting for `result` message, emit output whenever the agent produces text in an `assistant` message.

### Agent-Runner Changes (`container/agent-runner/src/index.ts`)

```typescript
// In runQuery(), inside the for-await loop:

if (message.type === 'assistant' && 'uuid' in message) {
  const content = (message as any).message?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((b: any) => b.type === 'text' && b.text)
      .map((b: any) => b.text)
      .join('');
    if (text && !isReplay) {
      writeOutput({ status: 'success', result: text, newSessionId });
    }
  }
}
```

### Replay Detection (the hard part)

During session resume, old assistant messages are replayed. Sending them would re-deliver old conversation text. Options:

1. **Timestamp comparison**: New messages have timestamps within a few seconds of `Date.now()`. Replayed messages have old timestamps. Fragile if clocks are off.

2. **UUID tracking**: Load the session transcript's last N UUIDs before starting. Skip messages with known UUIDs. Requires reading the `.jsonl` file.

3. **Phase flag (current Direction B approach)**: Wait for the first `result` message to mark end of replay. But in Direction A we want to emit BEFORE the result.

4. **SDK enhancement**: Check if the SDK provides an `isReplay` flag on messages. As of SDK v0.2.34, this is not available. Monitor future releases.

**Recommended**: Option 2 (UUID tracking). Load last 50 UUIDs from the session transcript at startup. Skip any message whose UUID is in this set.

```typescript
// Before query():
const knownUuids = new Set<string>();
if (sessionId) {
  const transcriptPath = `/home/node/.claude/projects/-workspace-group/${sessionId}.jsonl`;
  if (fs.existsSync(transcriptPath)) {
    const lines = fs.readFileSync(transcriptPath, 'utf-8').trim().split('\n');
    for (const line of lines.slice(-50)) {
      try {
        const entry = JSON.parse(line);
        if (entry.uuid) knownUuids.add(entry.uuid);
      } catch {}
    }
  }
}

// In the loop:
if (message.type === 'assistant' && 'uuid' in message) {
  const uuid = (message as { uuid: string }).uuid;
  if (!knownUuids.has(uuid)) {
    // This is a NEW message, safe to emit
    // ... extract and emit text
  }
}
```

### Host-Side Changes

Minimal — host already handles streaming output (multiple `writeOutput` calls per container run). The `onOutput` callback in `processMessages()` sends each result to Telegram.

One concern: the host strips `<internal>` tags. This already works for streamed results.

### Edge Cases

- **Multiple text blocks**: Model says "let me check..." then later "here's what I found". Both get sent as separate Telegram messages. This is actually good UX.
- **Empty text between tool calls**: Assistant messages with only `tool_use` blocks have no text. These are automatically skipped.
- **IPC send_message overlap**: Agent might use `mcp__nanoclaw__send_message` AND produce text output. User could get duplicate content. Solution: add CLAUDE.md instruction to use one or the other.

### Migration from Direction B

1. Remove the `lastAssistantText` fallback logic
2. Add UUID tracking for replay detection
3. Emit `writeOutput()` from assistant text blocks
4. Keep the `result` handler but only for error status
5. Test with both new sessions and resumed sessions
