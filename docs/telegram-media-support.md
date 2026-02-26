# Plan: Telegram 圖片與檔案讀取支援

## Context

目前 NanoClaw 的 Telegram 通道只處理純文字和 caption。使用者傳送的圖片（photo）和檔案（document）會被完全忽略 — agent 看不到也無法處理。

目標：讓 container agent 能**看到並讀取**使用者透過 Telegram 傳來的圖片與檔案，並且能自主決定是否將重要媒體保存到 AgentBrain vault 中，供跨 session 回憶使用。

## 設計策略

**核心思路**：Host 端下載 Telegram 檔案到本地 → 掛載進 container → XML prompt 中告訴 agent 檔案路徑 → agent 用 `Read` tool 讀取 → agent 自行決定是否存入 AgentBrain vault。

Agent SDK 的 `Read` tool 原生支援讀取圖片（multimodal），所以圖片不需要特殊處理。PDF、文字檔案等也都能直接讀取。

### 檔案生命週期（兩階段）

```
階段 1：暫存（Staging）
  Telegram 訊息 → Host 下載到 data/media/main/
  掛載為 /workspace/media/ (read-only)
  Agent 可以立即用 Read tool 讀取

階段 2：持久化（Agent 自主決定）
  Agent 認為重要的檔案 → cp 到 /workspace/brain/media/
  Agent 在知識筆記或每日記錄中用 ![[media/...]] 引用
  隨 AgentBrain vault 持久保存

暫存清理：
  Container 結束時，host 清理 data/media/main/ 中的暫存檔案
  已被 agent 存入 AgentBrain 的檔案不受影響
```

**為什麼讓 agent 決定？**
- 不是每張圖、每個檔案都值得長期保存
- Agent 最了解對話脈絡，知道哪些媒體有長期參考價值
- 符合 AgentBrain 「agent 自主管理記憶」的設計哲學
- 避免無限累積不重要的媒體檔案

## 修改範圍

### 1. `src/channels/telegram.ts` — 媒體偵測與下載

**新增 grammy event handler**：
- 加入 `message:photo` handler（不帶 caption 的圖片）
- 加入 `message:document` handler（不帶 caption 的純檔案）
- 現有的 `message:caption` 已能捕捉帶 caption 的媒體

**擴展 `handleMessage()` 的型別簽名**：
- 加入 `photo`, `document` 欄位到 ctx.message 型別

**新增 `downloadMedia()` 方法**：
- 從 `msg.photo`（取最大尺寸, 即陣列最後一個）或 `msg.document` 取得 `file_id`
- 呼叫 `this.bot.api.getFile(file_id)` 取得 `file_path`
- 用 `fetch` 從 `https://api.telegram.org/file/bot<token>/<file_path>` 下載
- 存到 `data/media/main/{message_id}_{original_filename}` (document) 或 `{message_id}.jpg` (photo)
- 回傳本地檔案路徑

**修改 `handleMessage()`**：
- 偵測 `msg.photo` 或 `msg.document`
- 下載完成後才呼叫 `onMessage` callback（確保 agent 收到訊息時檔案已就緒）
- 下載失敗時仍然傳遞訊息，只是沒有 attachment（log warning）
- 將媒體資訊（本地路徑、類型、原始檔名、大小）附加到 message

### 2. `src/types.ts` — 擴展 NewMessage 介面

```typescript
export interface MessageAttachment {
  type: 'photo' | 'document';
  localPath: string;      // Host 端的絕對路徑
  fileName: string;       // 原始檔名或生成的檔名
  mimeType?: string;      // document 的 MIME type
  fileSize?: number;      // 檔案大小 (bytes)
}

// NewMessage 新增欄位：
export interface NewMessage {
  // ... existing fields ...
  attachments?: MessageAttachment[];
}
```

### 3. `src/router.ts` — XML 格式加入附件資訊

擴展 `formatMessages()` 讓附件出現在 XML 中：

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

Agent 看到 `path` 後可以用 `Read` tool 讀取檔案。

### 4. `src/container-runner.ts` — 掛載 media 目錄

在 `buildVolumeMounts()` 中新增：

```typescript
// Media files (downloaded from Telegram)
const mediaDir = path.join(DATA_DIR, 'media', config.folder);
fs.mkdirSync(mediaDir, { recursive: true });
mounts.push({
  hostPath: mediaDir,
  containerPath: '/workspace/media',
  readonly: true,  // Agent 只需要讀取暫存區
});
```

注意：Agent 要持久化的檔案會自行 `cp` 到 `/workspace/brain/media/`（AgentBrain 已是 read-write mount）。

### 5. `src/container-runner.ts` — Container 結束後清理暫存 media

在 container 結束的 cleanup 邏輯中，加入清理 `data/media/main/` 的步驟：

```typescript
// Clean up staging media files after container exits
const mediaDir = path.join(DATA_DIR, 'media', groupFolder);
if (fs.existsSync(mediaDir)) {
  fs.rmSync(mediaDir, { recursive: true, force: true });
  fs.mkdirSync(mediaDir, { recursive: true });
}
```

### 6. `src/config.ts` — 新增 media 相關常數

```typescript
export const MEDIA_DIR = path.join(DATA_DIR, 'media');
export const TELEGRAM_MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB (Telegram Bot API limit)
```

### 7. AgentBrain vault — 新增 `media/` 目錄

在 `AgentBrain/` 中建立 media 目錄結構：

```
AgentBrain/
└── media/           # Agent 自主保存的媒體檔案
    └── .gitkeep     # 確保目錄存在
```

不做更細的子目錄分類 — 讓 agent 自行用有意義的檔名組織（例如 `2026-02-24_project-architecture.png`）。

在 `AgentBrain/.gitignore` 中加入 `media/` 以避免大型二進位檔案進入 git（或由使用者自行決定是否 commit 媒體檔案）。

### 8. `groups/main/CLAUDE.md` — Agent 媒體處理指令

在 agent 的系統指令中加入：

```markdown
## 媒體附件處理

收到 `<attachment>` 標籤時：
- 用 `Read` tool 讀取 `path` 指向的檔案（圖片直接 Read，PDF 用 pages 參數）
- 暫存檔案在 `/workspace/media/`，container 結束後會被清理

### 保存重要媒體

如果媒體有長期參考價值（使用者明確要求保存、重要文件、關鍵截圖等）：
1. 用 `cp` 將檔案從 `/workspace/media/` 複製到 `/workspace/brain/media/`
2. 使用有意義的檔名：`YYYY-MM-DD_描述.ext`（例如 `2026-02-24_system-architecture.png`）
3. 在每日記錄或知識筆記中用 Obsidian 語法引用：`![[media/2026-02-24_system-architecture.png]]`
4. 不需要保存的媒體就不要複製 — 直接在暫存區讀取並回應即可

### 回憶已保存的媒體

之前保存的媒體可以在 `/workspace/brain/media/` 中找到，使用者提到「之前那張圖」或「上次那個檔案」時：
1. `ls /workspace/brain/media/` 或搜尋知識筆記中的 `![[media/` 引用
2. 用 `Read` tool 讀取找到的檔案
```

## 不需要修改的部分

- **DB schema**：不改。附件資訊透過即時格式化傳遞，不需要額外 column。
- **ContainerInput**：不改。媒體透過 volume mount 傳遞，不走 stdin。
- **agent-runner**：不改。Agent 透過 Read tool 讀取已掛載的檔案即可。
- **IPC**：不改。多輪對話中的附件同樣走 volume mount + XML 路徑。
- **AgentBrain index.md**：不需要新增 type — 媒體檔案不是 markdown，由知識筆記引用即可。

## 實作順序

1. `src/types.ts` — 加入 `MessageAttachment` 介面
2. `src/config.ts` — 加入 media 常數
3. `src/channels/telegram.ts` — 媒體偵測、下載、event handlers
4. `src/router.ts` — XML attachment 格式化
5. `src/container-runner.ts` — volume mount + cleanup
6. `AgentBrain/media/` — 建立目錄 + .gitignore
7. `groups/main/CLAUDE.md` — agent 媒體處理指令
8. Typecheck + test + build

## Verification

1. **Typecheck**: `npm run typecheck`
2. **Test**: `npm test` 確認現有測試不壞
3. **Build**: `npm run build` && container rebuild (if needed, but agent-runner unchanged)
4. **手動測試**:
   - 傳一張圖片給 bot → agent 能描述圖片內容
   - 傳一個 PDF 檔案 → agent 能讀取並摘要
   - 傳一個帶 caption 的圖片 → agent 能同時看到文字和圖片
   - 請 agent「記住這張圖」→ 檔案出現在 `AgentBrain/media/`
   - 新 session 中問「之前那張圖」→ agent 能從 vault 中找到並讀取
   - 傳純文字 → 行為不變（regression check）
