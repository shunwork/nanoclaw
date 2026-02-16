# Upstream Architecture Reference

Migration 參考文件。描述 upstream `main` (`c30bd62`) 的新架構機制，供 `feature/myclaw` 整合時參考。

---

## 1. Streaming Container

### 概念

舊架構（single-shot）：每則訊息啟動一個 container → agent 回覆 → container 退出。
新架構（streaming）：container 啟動後保持存活，透過 IPC 接收後續訊息，agent 可進行多輪對話而不重啟。

### Container 內部流程 (`container/agent-runner/src/index.ts`)

```
main():
  stdin → ContainerInput (prompt, sessionId, groupFolder, chatJid, isMain)
  清除舊的 _close sentinel
  drain 已存在的 IPC input messages → 併入 initial prompt

  while (true):
    runQuery(prompt, sessionId, resumeAt)
      MessageStream.push(prompt)   ← async iterable，防止 isSingleUserTurn
      pollIpcDuringQuery()         ← 500ms polling IPC input，新訊息 push 到 stream
      for await (message of query({ prompt: stream, ... })):
        追蹤 lastAssistantUuid（用於 resumeAt）
        遇到 result → writeOutput(marker pair)
      return { newSessionId, lastAssistantUuid, closedDuringQuery }

    if closedDuringQuery → break
    writeOutput({ result: null })  ← session update marker（通知 host 更新 sessionId）
    waitForIpcMessage()            ← blocking poll，等新訊息或 _close
    if _close → break
    prompt = nextMessage           ← 下一輪 query 的 prompt
```

### MessageStream class

```typescript
class MessageStream {
  push(text: string): void     // 加入新訊息到 queue
  end(): void                  // 結束 stream，讓 query() 完成
  [Symbol.asyncIterator]()     // SDK 消費用
}
```

作用：`query()` 的 `prompt` 參數接受 `AsyncIterable`。MessageStream 讓 SDK 的 `isSingleUserTurn=false`，使 agent teams subagent 能跑完而不被提前終止。

### Output Protocol

Container 透過 stdout 輸出 marker pairs：

```
---NANOCLAW_OUTPUT_START---
{"status":"success","result":"回覆文字","newSessionId":"abc123"}
---NANOCLAW_OUTPUT_END---
```

- **一次 container 生命週期內可以輸出多個 marker pair**（每次 query result 一個）
- `result: null` = session update marker（只追蹤 sessionId，不發送訊息）
- `result: "文字"` = agent 的回覆（發送到用戶）
- Host 即時解析 marker pair，不等 container 退出

### Container 生命週期管理

```
Host:
  spawn container → stdin write(ContainerInput) → stdin.end()
  stdout 即時解析 OUTPUT_START/END markers
  每收到 marker → 呼叫 onOutput callback → 重置 timeout
  idle timeout (30min) → queue.closeStdin(jid) → 寫 _close sentinel
  container 收到 _close → 退出 query loop → process exit
  host 偵測到 container 退出 → 回收 queue slot
```

### Timeout 機制

| Timeout | 預設值 | 作用 |
|---------|--------|------|
| `IDLE_TIMEOUT` | 30min | container 保持存活的最長閒置時間 |
| `CONTAINER_TIMEOUT` | 30min | hard kill timeout（`≥ IDLE_TIMEOUT + 30s`） |

- 每次收到 output marker → 重置 hard timeout
- stderr 不重置 timeout（SDK 持續輸出 debug log）
- Timeout after output = idle cleanup（success），不是 error

### 與 myclaw 客製化的相容性

| myclaw 功能 | 相容？ | 說明 |
|-------------|--------|------|
| `loadCoreMemory()` → `systemPrompt` | ✅ | `runQuery()` 的 `systemPrompt` 參數同樣可用 |
| `loadVolatileContext()` → prompt 前綴 | ✅ | 在 initial prompt push 進 MessageStream 前 prepend |
| `outputFormat` (JSON schema) | ❌ | upstream 移除了 structured output，改用 plain text + `<internal>` tag |
| `AGENT_MODEL` env var | ✅ | 在 `runQuery()` 的 `query()` options 中加入 `model` |

---

## 2. IPC 系統

### 目錄結構

```
data/ipc/{groupFolder}/
├── messages/           # container → host：send_message 輸出
│   └── *.json          # { type:"message", chatJid, text, sender?, timestamp }
├── tasks/              # container → host：task 操作
│   └── *.json          # { type:"schedule_task"|"pause_task"|... }
├── input/              # host → container：後續訊息注入（NEW）
│   ├── *.json          # { type:"message", text:"..." }
│   └── _close          # 關閉 sentinel（觸發 container 優雅退出）
├── current_tasks.json  # host 寫入的 snapshot（container 讀取）
└── available_groups.json # host 寫入的 snapshot（container 讀取，main only）
```

### 雙向 IPC 流向

```
Container → Host (file-based polling, 1s interval):
  ipc-mcp-stdio.ts 呼叫 send_message
    → writeIpcFile('messages/', { type:'message', chatJid, text })
    → host ipc.ts processIpcFiles() 讀取 → sendMessage() → Telegram

  ipc-mcp-stdio.ts 呼叫 schedule_task
    → writeIpcFile('tasks/', { type:'schedule_task', ... })
    → host ipc.ts processTaskIpc() 讀取 → createTask() → SQLite

Host → Container (file-based polling, 500ms interval):
  用戶在 Telegram 發送新訊息（container 仍在運行中）
    → queue.sendMessage(jid, text)
    → 寫入 ipc/{groupFolder}/input/{timestamp}.json
    → agent-runner pollIpcDuringQuery() 讀取 → MessageStream.push(text)

  Idle timeout 到期
    → queue.closeStdin(jid)
    → 寫入 ipc/{groupFolder}/input/_close
    → agent-runner shouldClose() 偵測 → stream.end() → container 退出
```

### 原子寫入

所有 IPC 檔案寫入使用 temp file + rename 確保原子性：

```typescript
function writeIpcFile(dir: string, data: object): string {
  const filepath = path.join(dir, `${Date.now()}-${random}.json`);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data));
  fs.renameSync(tempPath, filepath);  // atomic on same filesystem
  return filename;
}
```

### Host 端 IPC Watcher (`src/ipc.ts`)

```typescript
export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<void>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroupMetadata: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (...) => void;
}

export function startIpcWatcher(deps: IpcDeps): void
```

- 掃描 `data/ipc/` 下所有 group 目錄
- 身份驗證：**目錄名 = source group identity**（container 只能寫入自己的 IPC 目錄）
- 授權模型：main group 可以操作所有 group，non-main 只能操作自己
- 錯誤處理：parse 失敗的 IPC 檔案移至 `ipc/errors/`

### Single-user 簡化方向

- 只掃描 `data/ipc/main/`（移除 multi-group scanning）
- 移除授權檢查（single user = full trust）
- 移除 `register_group`、`refresh_groups` 處理
- `IpcDeps` 簡化：移除 `registeredGroups`、`registerGroup`、`syncGroupMetadata`、`getAvailableGroups`、`writeGroupsSnapshot`

---

## 3. IPC MCP Server (`container/agent-runner/src/ipc-mcp-stdio.ts`)

### 與舊版 `ipc-mcp.ts` 的差異

| | 舊版 `ipc-mcp.ts` | 新版 `ipc-mcp-stdio.ts` |
|--|-------------------|------------------------|
| 傳輸 | 嵌入 agent-runner 的 `query()` 呼叫中 | **獨立 process**，stdio transport |
| 啟動方式 | `createIpcMcp()` 回傳 inline MCP config | `node ipc-mcp-stdio.js` 獨立啟動 |
| Context | 函數參數傳入 | **環境變數**：`NANOCLAW_CHAT_JID`, `NANOCLAW_GROUP_FOLDER`, `NANOCLAW_IS_MAIN` |
| Subagent 繼承 | ❌ 不可繼承 | ✅ **subagent 自動繼承** MCP server |
| 依賴 | SDK internal MCP | `@modelcontextprotocol/sdk` + `StdioServerTransport` |

### MCP Server 配置（agent-runner 端）

```typescript
mcpServers: {
  nanoclaw: {
    command: 'node',
    args: [mcpServerPath],       // ipc-mcp-stdio.js 的路徑
    env: {
      NANOCLAW_CHAT_JID: containerInput.chatJid,
      NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
      NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
    },
  },
},
```

### 提供的 MCP Tools（6+1 個）

| Tool | 參數 | 說明 |
|------|------|------|
| `send_message` | `text`, `sender?` | 立即發送訊息到用戶。`sender` 用於 Swarm 多 bot 身份 |
| `schedule_task` | `prompt`, `schedule_type`, `schedule_value`, `context_mode`, `target_group_jid?` | 建立排程任務 |
| `list_tasks` | — | 讀取 `current_tasks.json` |
| `pause_task` | `task_id` | 暫停排程任務 |
| `resume_task` | `task_id` | 恢復排程任務 |
| `cancel_task` | `task_id` | 刪除排程任務 |
| `register_group` | `jid`, `name`, `folder`, `trigger` | 註冊新群組（main only） |

### Single-user 簡化方向

- 移除 `register_group` tool
- `schedule_task`：移除 `target_group_jid` 參數（always use own chatJid）
- `list_tasks`：移除 `isMain` 過濾（always show all）
- `send_message`：移除 `sender` 參數（no swarm）
- 環境變數可簡化（`NANOCLAW_IS_MAIN` always '1'）

---

## 4. Channel 抽象化

### Channel Interface (`src/types.ts`)

```typescript
export interface Channel {
  name: string;                                        // 'whatsapp' | 'telegram'
  connect(): Promise<void>;                            // 建立連線
  sendMessage(jid: string, text: string): Promise<void>; // 發送訊息
  isConnected(): boolean;                              // 連線狀態
  ownsJid(jid: string): boolean;                       // 此 JID 是否屬於這個 channel
  disconnect(): Promise<void>;                         // 斷開連線
  setTyping?(jid: string, isTyping: boolean): Promise<void>; // optional typing indicator
  prefixAssistantName?: boolean;                       // 是否在訊息前加 assistant name
}

export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;
export type OnChatMetadata = (chatJid: string, timestamp: string, name?: string) => void;
```

### WhatsApp 實作模式（`src/channels/whatsapp.ts`，作為 TelegramChannel 參考）

```typescript
export class WhatsAppChannel implements Channel {
  name = 'whatsapp';
  prefixAssistantName = true;  // WhatsApp 不顯示 bot 名稱，需要前綴

  constructor(opts: WhatsAppChannelOpts) { ... }

  async connect() { /* Baileys socket + event handlers */ }
  async sendMessage(jid, text) { /* 發送，斷線時 queue */ }
  isConnected() { return this.connected; }
  ownsJid(jid) { return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net'); }
  async disconnect() { this.sock.end(); }
  async setTyping(jid) { this.sock.sendPresenceUpdate('composing', jid); }
}
```

### TelegramChannel 實作方向

```typescript
export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false;  // Telegram bot 自帶名稱顯示

  private bot: Bot;
  private connected = false;
  private typingTimers = new Map<string, NodeJS.Timeout>();

  constructor(token: string, opts: TelegramChannelOpts) {
    this.bot = new Bot(token, {
      client: { baseFetchConfig: { agent: ipv4Agent } },  // force IPv4
    });
  }

  async connect() {
    // 註冊 message handlers → opts.onMessage callback
    this.bot.on('message:text', (ctx) => { ... });
    this.bot.on('message:photo', (ctx) => { ... });
    // long polling start
    this.bot.start({ onStart: () => { this.connected = true; } });
  }

  async sendMessage(jid: string, text: string) {
    // 4096 char limit split
    const chunks = splitMessage(text, 4096);
    for (const chunk of chunks) {
      await this.bot.api.sendMessage(Number(jid), chunk);
    }
  }

  isConnected() { return this.connected; }
  ownsJid(jid: string) { return true; }  // single-user: 所有 JID 都是我的
  async disconnect() { await this.bot.stop(); }

  async setTyping(jid: string, isTyping: boolean) {
    if (!isTyping) {
      // 停止 typing indicator
      const timer = this.typingTimers.get(jid);
      if (timer) { clearInterval(timer); this.typingTimers.delete(jid); }
      return;
    }
    // 重複 timer，Telegram typing indicator 5 秒後過期
    await this.bot.api.sendChatAction(Number(jid), 'typing');
    const timer = setInterval(async () => {
      await this.bot.api.sendChatAction(Number(jid), 'typing');
    }, 4500);
    this.typingTimers.set(jid, timer);
  }
}
```

**Single-user 簡化**：`onChatMetadata` callback 可省略 — 用於 multi-group 的 group discovery，single-user 不需要。
```

### Channel 在 index.ts 中的使用

```typescript
// 建立 channel（single-user 版本，省略 onChatMetadata）
const channels: Channel[] = [];
const telegram = new TelegramChannel(TELEGRAM_BOT_TOKEN, {
  onMessage: (chatJid, message) => {
    storeMessage(message);
    queue.enqueueMessageCheck(chatJid);
  },
  // onChatMetadata 省略 — single-user 不需要 group discovery
});
channels.push(telegram);
await telegram.connect();

// 發送訊息（router.ts 負責找到正確的 channel）
import { formatOutbound, routeOutbound } from './router.js';

const text = formatOutbound(channel, rawAgentOutput);  // stripInternalTags + prefix
if (text) await routeOutbound(channels, jid, text);
```

---

## 5. Router 模組 (`src/router.ts`)

### 職責

純函數模組，負責：
1. 訊息格式化（DB messages → XML prompt）
2. 輸出處理（agent output → 過濾 `<internal>` → 加前綴 → 發送）
3. Channel routing（找到擁有該 JID 的 channel）

### 核心函數

```typescript
// 將 NewMessage[] 格式化為 XML prompt
function formatMessages(messages: NewMessage[]): string
// 輸入: [{sender_name:"shun", timestamp:"14:07", content:"你好"}]
// 輸出: <messages>
//         <message sender="shun" time="14:07">你好</message>
//       </messages>

// 過濾 <internal> tags
function stripInternalTags(text: string): string
// 輸入: "回覆<internal>思考過程</internal>"
// 輸出: "回覆"

// 加上 assistant name 前綴（如果 channel 需要）
function formatOutbound(channel: Channel, rawText: string): string
// WhatsApp: "Cal: 回覆"
// Telegram: "回覆"（bot 自帶名稱）

// 找到正確的 channel 發送
function routeOutbound(channels: Channel[], jid: string, text: string): Promise<void>

// XML 跳脫
function escapeXml(s: string): string
```

### `<internal>` tag 機制

upstream 移除了 structured output（`outputFormat` JSON schema），改用 `<internal>` tag：

```
Agent 輸出: "今天天氣很好！<internal>用戶問天氣，查了 API</internal>"
                                                    ↓ stripInternalTags()
發送給用戶: "今天天氣很好！"
記錄到 log:  完整的原始輸出（含 <internal>）
```

**取代了 myclaw 的 `outputType: 'message' | 'log'` 機制。** Agent 不再需要決定整個回覆是 message 還是 log — 它可以在同一回覆中混合公開文字和內部思考。

### Single-user 簡化方向

- `routeOutbound` 可簡化（只有一個 channel，直接呼叫）
- `formatOutbound` 的 `prefixAssistantName` 邏輯保留（TelegramChannel 設為 false）
- 其餘函數無需變更

---

## 6. 模組間協作：完整訊息流

### 正常訊息處理

```
1. Telegram 收到訊息
   TelegramChannel.onMessage(chatJid, message)
     → storeMessage(message) → SQLite
     → queue.enqueueMessageCheck(chatJid)

2. Queue slot 可用
   queue.processMessagesFn(chatJid) → processMessages(chatJid)
     → getNewMessages(chatJid) → DB 查詢未處理訊息
     → formatMessages(messages) → XML prompt
     → runContainerAgent(config, input, onProcess, onOutput)

3. Container 啟動
   buildVolumeMounts() → 建立所有 mount（含 ipc/input/）
   spawn('container', args) → stdin.write(ContainerInput) → stdin.end()
   queue.registerProcess(jid, proc, containerName, groupFolder)

4. Agent-runner 執行
   main() → readStdin() → runQuery(prompt, sessionId)
     query({ prompt: MessageStream, ... }) → SDK 處理
     agent 產生結果 → writeOutput(marker pair) → stdout

5. Host 即時解析 stdout
   container.stdout.on('data') → 解析 OUTPUT_START/END markers
     → onOutput(parsed) → formatOutbound(channel, result)
       → stripInternalTags(result) → routeOutbound(channels, jid, text)
         → TelegramChannel.sendMessage(jid, text) → Telegram API
     → 重置 timeout timer

6. 後續訊息（container 仍存活）
   新 Telegram 訊息到達 → storeMessage() → queue.sendMessage(jid, text)
     → 寫入 ipc/{groupFolder}/input/*.json
     → agent-runner pollIpcDuringQuery() 讀取 → MessageStream.push(text)
     → SDK 繼續 query，產生新結果 → 回到步驟 5

7. 閒置退出
   30min 無 output → queue.closeStdin(jid) → _close sentinel
     → agent-runner 退出 query loop → container process exit
     → host 偵測 close event → timeout after output = success
     → queue slot 回收，drainGroup() 檢查待處理工作
```

### IPC send_message 流（container 主動發送）

```
Agent 呼叫 MCP tool send_message("進度更新")
  → ipc-mcp-stdio.ts writeIpcFile('messages/', { type:'message', chatJid, text })
  → host ipc.ts processIpcFiles() 讀取 messages/*.json
  → 授權檢查（isMain || sourceGroup matches target）
  → deps.sendMessage(chatJid, `${ASSISTANT_NAME}: ${text}`)   ← ⚠️ 見下方注意
  → routeOutbound → TelegramChannel.sendMessage()
```

> **⚠️ 前綴不一致問題**：upstream IPC watcher 硬編碼 `ASSISTANT_NAME:` 前綴，但正常 output 流經 `formatOutbound()` 時會根據 `channel.prefixAssistantName` 決定。對 Telegram（`prefixAssistantName=false`），IPC 訊息會多出前綴而正常回覆沒有。**migration 時需修正**：IPC send_message 路徑應改為透過 `formatOutbound(channel, text)` 統一處理，或直接移除硬編碼前綴。

### 排程任務流

```
Agent 呼叫 MCP tool schedule_task(...)
  → ipc-mcp-stdio.ts writeIpcFile('tasks/', { type:'schedule_task', ... })
  → host ipc.ts processTaskIpc() 讀取 → createTask() → SQLite

Host startSchedulerLoop() 每 60s 檢查 getDueTasks()
  → queue.enqueueTask(jid, taskId, fn)
  → fn = runTask() → runContainerAgent(config, taskInput, onProcess, onOutput)
  → 同正常訊息處理流程（步驟 3-5）
```

---

## 7. Container Runner Streaming 機制 (`src/container-runner.ts`)

### `runContainerAgent()` 簽名

```typescript
export async function runContainerAgent(
  group: RegisteredGroup,
  input: ContainerInput,
  onProcess: (proc: ChildProcess, containerName: string) => void,
  onOutput?: (output: ContainerOutput) => Promise<void>,  // NEW: streaming callback
): Promise<ContainerOutput>
```

- `onProcess`：container spawn 後立即呼叫，用於在 queue 中註冊 process
- `onOutput`：**optional**。提供時啟用 streaming mode，每收到 output marker pair 呼叫一次

### Streaming Output 解析

```typescript
// stdout chunk 累積到 parseBuffer
parseBuffer += chunk;

// 迴圈解析所有完整的 marker pair
while ((startIdx = parseBuffer.indexOf(OUTPUT_START_MARKER)) !== -1) {
  const endIdx = parseBuffer.indexOf(OUTPUT_END_MARKER, startIdx);
  if (endIdx === -1) break;  // 不完整，等下一個 chunk

  const jsonStr = parseBuffer.slice(startIdx + MARKER_LENGTH, endIdx).trim();
  parseBuffer = parseBuffer.slice(endIdx + END_MARKER_LENGTH);

  const parsed: ContainerOutput = JSON.parse(jsonStr);
  resetTimeout();  // 活動偵測 → 重置 hard timeout
  outputChain = outputChain.then(() => onOutput(parsed));  // 序列化呼叫
}
```

### 非 streaming 模式（Legacy）

當 `onOutput` 未提供時，container close 後從累積的 stdout 解析最後一個 marker pair：

```typescript
if (!onOutput) {
  // Legacy: 解析 stdout 中最後一個 OUTPUT_START/END pair
  const startIdx = stdout.indexOf(OUTPUT_START_MARKER);
  const endIdx = stdout.indexOf(OUTPUT_END_MARKER);
  // ...
}
```

### Container 退出處理

| 狀態 | 處理 |
|------|------|
| `code === 0` + streaming + `onOutput` | 等 `outputChain` 完成 → resolve success |
| `code === 0` + no streaming | Legacy parse → resolve parsed output |
| `code !== 0` | resolve error（含 stderr 末 200 chars） |
| timeout + had output | **Success**（idle cleanup，不是 error） |
| timeout + no output | **Error**（真正的 timeout） |

### Volume Mounts 建構 (`buildVolumeMounts()`)

```typescript
// Main group mounts（single-user 只用這個）
/workspace/project     ← 專案根目錄 (read-write)
/workspace/group       ← groups/main/ (read-write)
/home/node/.claude     ← data/sessions/main/.claude/ (read-write)
/workspace/ipc         ← data/ipc/main/ (read-write)，含 input/ 子目錄
/workspace/env-dir     ← data/env/ (read-only)
/app/src               ← container/agent-runner/src/ (read-only，開發時即時更新)

// Non-main group 額外 mount
/workspace/global      ← groups/global/ (read-only)

// Additional mounts（validated against allowlist）
/workspace/extra/*     ← 外部目錄

// Settings.json 自動建立
// upstream 預設啟用 agent teams + additional CLAUDE.md + auto memory
// myclaw 覆寫：禁用 auto memory（由 AgentBrain 管理）
data/sessions/main/.claude/settings.json

// Skills sync（每次啟動時從 container/skills/ 複製到 .claude/skills/）
```

### myclaw 需要新增的 mount

```typescript
// AgentBrain vault mount（在 buildVolumeMounts 中加入）
mounts.push({
  hostPath: AGENTBRAIN_DIR,
  containerPath: '/workspace/brain',
  readonly: false,
});
```

---

## 8. Agent Teams 基礎設施

### 啟用方式

1. `settings.json` 中設定 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1'`
2. `allowedTools` 中加入：`Task`, `TaskOutput`, `TaskStop`, `TeamCreate`, `TeamDelete`, `SendMessage`
3. `ipc-mcp-stdio.ts` 使用 stdio transport → **subagent 自動繼承 MCP server**

### 工作原理

```
Main agent（透過 Task tool 建立 subagent）
  → SDK spawn 子 process
  → 子 process 繼承 nanoclaw MCP server（因為是 stdio，可被繼承）
  → subagent 可以呼叫 send_message, schedule_task 等
  → subagent 完成 → 結果回傳給 main agent
```

### MessageStream 的作用

`isSingleUserTurn=false`：SDK 不會在第一個 result 後終止 query。這讓 agent teams 的 subagent 能完成工作後再匯報結果，而不是 main agent 一回覆就結束。

### Swarm（多 bot 身份）vs Teams（subagent）

| | Agent Teams | Agent Swarm |
|--|-------------|-------------|
| 功能 | main agent 派生 subagent 處理子任務 | 每個 subagent 以不同 bot 身份出現在 chat |
| 需要 | `AGENT_TEAMS=1` + streaming | Teams + Telegram Bot Pool config |
| 對 single-user 有用 | ✅ | ❌ |
| myclaw 採用 | ✅ | ❌ |
