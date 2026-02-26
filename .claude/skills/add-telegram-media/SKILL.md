---
name: add-telegram-media
description: Add Telegram photo and document reading support to NanoClaw. Agent can see, read, and optionally save media files sent by the user.
---

# Add Telegram Media Support (Photo & Document)

This skill adds the ability for the container agent to receive and read photos and documents sent via Telegram. The agent can view images (multimodal), read PDFs and text files, and optionally save important media to the AgentBrain vault for long-term recall.

**UX Note:** When asking the user questions, prefer using the `AskUserQuestion` tool instead of just outputting text.

## Prerequisites

- Telegram channel must already be set up (`/add-telegram`)
- No additional API keys or dependencies required — uses Telegram Bot API's built-in file download

---

## Architecture

```
User sends photo/document via Telegram
  → grammy event handler detects media
  → Host downloads file to data/media/main/
  → File path included in XML prompt as <attachment> tag
  → Container has /workspace/media/ mounted (read-only)
  → Agent uses Read tool to view the file
  → (Optional) Agent copies important files to /workspace/brain/media/
```

**File lifecycle:**
1. **Staging**: Downloaded to `data/media/main/` — cleaned up when container exits
2. **Persistent** (agent's choice): Copied to `AgentBrain/media/` — survives across sessions

---

## Implementation

### Step 1: Add MessageAttachment type to `src/types.ts`

Add before the `NewMessage` interface:

```typescript
export interface MessageAttachment {
  type: 'photo' | 'document';
  localPath: string;
  fileName: string;
  mimeType?: string;
  fileSize?: number;
}
```

Add `attachments?: MessageAttachment[]` field to the `NewMessage` interface.

### Step 2: Add media constants to `src/config.ts`

```typescript
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const TELEGRAM_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB (Telegram Bot API limit)
```

### Step 3: Update `src/channels/telegram.ts`

**New event handlers** (in `connect()`):
- `message:photo` — fires for photos without caption
- `message:document` — fires for documents without caption
- Existing `message:caption` already handles media with captions

**Make `handleMessage()` async** and expand its type signature to include `photo` and `document` fields from the grammy message.

**Add `downloadMedia()` private method:**
- Calls `this.bot.api.getFile(fileId)` to get the file path
- Downloads from `https://api.telegram.org/file/bot<token>/<file_path>` using `node:https.get()` with `{ family: 4 }` to force IPv4 (Node.js native `fetch()` is undici-based and ignores `https.Agent`, causing IPv6 ETIMEDOUT on networks with broken IPv6)
- Saves to `data/media/main/{messageId}_{filename}`
- Returns `MessageAttachment` or `null` on failure
- Skips documents exceeding `TELEGRAM_MAX_FILE_SIZE`

**In `handleMessage()`:**
- After extracting content, check for `msg.photo` (take last element = largest size) and `msg.document`
- Download media before calling `onMessage` callback
- Pass `attachments` array in the `NewMessage` object

Store `this.botToken` in the constructor for use in download URLs.

### Step 3.5: Update `src/db.ts` — store and retrieve attachments

Attachments must survive the DB round-trip (store → read back). Without this, attachments are lost when `getMessagesSince()` reads messages for formatting.

**Schema migration** (in `createSchema()`):
```typescript
try {
  database.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
} catch { /* column already exists */ }
```

**`storeMessage()`**: serialize `msg.attachments` as JSON string (or `null` if empty).

**`getMessagesSince()` and `getNewMessages()`**: add `attachments` to SELECT, parse JSON string back to `MessageAttachment[]` via a `parseMessageRow()` helper.

### Step 4: Update `src/router.ts` — XML attachment formatting

Add `formatAttachment()` helper that maps host paths to container paths (`/workspace/media/{basename}`):

```xml
<message sender="Alice" time="2026-02-24T10:00:00Z">
  看看這張圖
  <attachment type="photo" path="/workspace/media/123.jpg" />
</message>

<message sender="Alice" time="2026-02-24T10:01:00Z">
  這是報告
  <attachment type="document" path="/workspace/media/456_report.pdf" filename="report.pdf" mime="application/pdf" size="102400" />
</message>
```

Update `formatMessages()` to append attachment tags inside `<message>` elements.

### Step 5: Update `src/container-runner.ts` — volume mount + cleanup

**In `buildVolumeMounts()`**, add media directory mount:

```typescript
const mediaDir = path.join(MEDIA_DIR, config.folder);
fs.mkdirSync(mediaDir, { recursive: true });
mounts.push({
  hostPath: mediaDir,
  containerPath: '/workspace/media',
  readonly: true,
});
```

**In `container.on('close')`**, add cleanup:

```typescript
const mediaCleanupDir = path.join(MEDIA_DIR, config.folder);
if (fs.existsSync(mediaCleanupDir)) {
  fs.rmSync(mediaCleanupDir, { recursive: true, force: true });
  fs.mkdirSync(mediaCleanupDir, { recursive: true });
}
```

### Step 6: Setup AgentBrain media directory

```bash
mkdir -p AgentBrain/media
touch AgentBrain/media/.gitkeep
```

Add to `AgentBrain/.gitignore`:
```
media/*
!media/.gitkeep
```

### Step 7: Update `groups/main/CLAUDE.md` — agent media instructions

Add a section explaining:
- How to read attachments (use `Read` tool on the `path` attribute)
- How to persist important media (copy to `/workspace/brain/media/` with meaningful filenames)
- How to recall saved media (search `/workspace/brain/media/` or knowledge notes with `![[media/...]]`)
- Update the Container Mounts table to include `/workspace/media`

### Step 8: Build and verify

```bash
npm run typecheck
npm test
npm run build
```

No container rebuild needed — agent-runner is unchanged.

---

## Testing

### Integration tests (`tests/media-attachment.test.ts`)

Add integration tests covering:
- **DB round-trip**: photo/document attachments survive storeMessage → getMessagesSince
- **XML formatting**: `<attachment>` tags rendered correctly for photo vs document
- **End-to-end**: store → read → formatMessages produces correct XML with attachment tags
- **Edge cases**: message without attachments, photo-only (empty content), multiple attachments

### Manual tests

1. **Photo**: Send a photo to the bot → agent should describe what it sees
2. **Document (PDF)**: Send a PDF → agent should read and summarize it
3. **Photo + caption**: Send a photo with text → agent sees both
4. **Save request**: Ask agent to "remember this image" → file appears in `AgentBrain/media/`
5. **Recall**: In a new session, ask "what was that image?" → agent finds it in vault
6. **Plain text**: Send text only → behavior unchanged (regression check)

---

## Limitations

- **Telegram Bot API file size limit**: 20MB max (Telegram restriction)
- **No video/audio support**: Only photos and documents — voice notes handled by `/add-voice-transcription`
- **Staging cleanup**: Media staging dir is cleaned when container exits — files not persisted by agent are lost
- **Container mount is read-only**: Agent cannot write to `/workspace/media/`, only read. Persistent saves go to `/workspace/brain/media/`

---

## Removing Media Support

To remove the feature:

1. Revert `src/types.ts` — remove `MessageAttachment` and `attachments` field
2. Revert `src/config.ts` — remove `MEDIA_DIR` and `TELEGRAM_MAX_FILE_SIZE`
3. Revert `src/channels/telegram.ts` — remove photo/document handlers, `downloadMedia()`, restore sync `handleMessage()`
4. Revert `src/router.ts` — remove `formatAttachment()` and attachment XML logic
5. Revert `src/container-runner.ts` — remove media mount and cleanup
6. Remove media instructions from `groups/main/CLAUDE.md`
7. Rebuild: `npm run build`
