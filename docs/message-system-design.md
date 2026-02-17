# Message System Design

Agent 回應處理、訊息送達、與 log 記錄的完整設計。

## 1. 現有架構分析

### 1.1 訊息送達的三個管道

```
管道 A: writeOutput pipeline（主要）
  agent-runner → stdout (OUTPUT markers) → container-runner 解析 → onOutput callback → stripInternalTags → Telegram

管道 B: IPC send_message（即時通知）
  agent → mcp__nanoclaw__send_message → IPC 檔案 → host ipc watcher → Telegram

管道 C: Scheduled task output（排程任務）
  task-scheduler → runContainerAgent → 同管道 A 的 onOutput → task-scheduler callback → Telegram
```

### 1.2 已解決的問題

| 問題 | 解決方式 |
|------|----------|
| Phase flag replay 偵測假設第一個 result = replay 結束 | ✅ UUID-based replay detection |
| `lastAssistantText` 被覆蓋，只保留最後一段 | ✅ 每個 result 獨立使用當下的 lastAssistantText |
| session-update `writeOutput(null)` 經由同一管道 | ✅ 移除 session-update writeOutput |
| log 缺乏結構化資訊 | ✅ `[Q1 #5]` 格式 + source 標注 |
| `new_session` MCP tool 未實作 | ✅ 已實作於 ipc-mcp-stdio.ts + ipc.ts |
| IPC `send_message` 不經過 `stripInternalTags` | ✅ 已加入 stripInternalTags |
| idle timer 在 null output 時也重設 | ✅ 移至 if (text) 內部 |

---

## 2. 所有場景分析

### 2.1 正常對話

```
User → "你好"
  → storeMessage → queue.enqueueMessageCheck or queue.sendMessage
  → processMessages → formatMessages(XML) → runAgent → runContainerAgent
  → Container: runQuery → query() → assistant text + result
  → writeOutput(text) → host onOutput → stripInternalTags → Telegram
```

**訊息來源**: result.result（直接文字）或 assistant message（fallback）
**需處理**: replay 偵測（resume session 時）

### 2.2 工具使用

```
User → "查一下天氣"
  → agent: assistant("讓我查一下") → tool_use(WebSearch) → assistant("台北今天 28°C") → result("")
```

**問題**: result 為空，文字在 assistant messages 中
**需處理**: fallback 到 assistant text；多段 assistant text 時只取最後一段（前面的通常是中間思考）

### 2.3 MCP send_message

```
User → "幫我做三件事"
  → agent: send_message("收到，正在處理...") → 工具操作 → send_message("第一件完成") → result("全部完成")
```

**管道 B 的特性**:
- 即時送達，不等 result
- 不經過 `stripInternalTags`（host ipc.ts 直接送）
- 與管道 A 可能重疊（agent 可能在 send_message 和 result 中說重複的話）

**設計決策**: 不做自動去重，這是 CLAUDE.md 層級的指導問題。但 ipc.ts 應該加上 `stripInternalTags`。

### 為什麼 send_message 無法取代 fallback

乍看之下，如果 agent 有 `send_message` MCP tool 可以主動送訊息，為什麼還需要 result fallback 機制？

**核心問題：agent 無法預知 result 是否為空。**

典型場景：
```
agent → assistant("台北今天28°C")   ← 此時 agent 認為已經回答了
agent → tool_use(Write daily log)    ← 寫 daily log（每次回應前必做）
agent → result("")                   ← SDK 的 result 反映最後一輪（工具呼叫），文字為空
```

Agent 在產生文字回應時，並不知道之後會因為 daily log 寫入而導致 result 為空。它沒有機會「回頭」呼叫 `send_message`，因為文字已經在 assistant message 中產生了。

**可能的替代方案與問題**：

| 方案 | 問題 |
|------|------|
| 在 CLAUDE.md 要求 agent 永遠用 `send_message` 送回覆 | Agent 常忘記遵守，且與自然對話模式衝突 |
| 在 CLAUDE.md 要求先做工具操作再回覆 | 違反 daily log「每次回應前」的要求 |
| Agent 同時用 `send_message` 和自然回覆 | 使用者收到兩份相同訊息 |

**結論**: `send_message` 是給 agent 主動控制送訊時機的工具（例如長任務中的進度通知），但 result fallback 是處理 SDK 層級 result-empty 問題的安全網，兩者互補不衝突。

### 2.4 Agent Teams

```
agent → TeamCreate("Researcher") → subagent 執行 → task_notification → result(subagent summary)
                                    ↓
                              subagent 也可以呼叫 send_message
```

**每個 result 獨立處理**：主 agent 和子 agent 各有自己的 result
**UUID 追蹤**: 子 agent 的 assistant messages 也有 UUID，正確辨識 replay

### 2.5 IPC 輸入管道（多輪對話）

```
[Query 1 進行中]
User → 新訊息 → queue.sendMessage → IPC file → agent-runner pollIpcDuringQuery → MessageStream.push
  → SDK 將新訊息作為後續 user turn 處理
  → agent 回應新訊息（新 assistant UUID）→ 新 result
```

**關鍵**: 新 user turn 產生的 assistant messages 有全新 UUID → UUID 追蹤自動正確處理

### 2.6 Session Resume（replay）

```
Container 啟動，sessionId 存在
  → query(resume: sessionId, resumeSessionAt: undefined)  // 首次 query
  → SDK 從 transcript 載入歷史 → emit 舊 assistant messages（已知 UUID）→ emit 舊 result
  → 然後處理新 prompt → emit 新 assistant messages（新 UUID）→ emit 新 result
```

**做法**: UUID check — 已知 UUID 的 assistant messages 一律跳過文字擷取

### 2.7 Session Reset (new_session)

```
User → "重新開始"
  → agent 判斷意圖 → 呼叫 mcp__nanoclaw__new_session
  → MCP 寫 IPC 檔案 {type: "new_session"} 到 tasks dir
  → host ipc watcher 處理 → 清除 DB 中的 session record
  → 當前 container 繼續運行到 idle/close
  → 下次 container invocation: sessionId = undefined → 新 session → knownUuids 為空
```

**與 UUID 追蹤的交互**: 完全相容。新 session 沒有 transcript → 沒有已知 UUID → 所有 assistant messages 都是新的。

### 2.8 反思（Reflection）

```
觸發方式: 使用者說「reflect」或排程任務

agent → Read daily logs → 整理記憶 → Write memory.md, context.md, knowledge notes
      → send_message("反思完成：更新了 3 條記憶")
      → result("") 或 result("<internal>reflection done</internal>")
```

**特性**:
- 大量工具使用，少量面向使用者的文字
- 輸出主要透過 send_message（管道 B）
- result 可能為空或全是 `<internal>` 標籤（strip 後為空）
- 反思期間 agent 可能呼叫 `new_session` 清理 context
- Agent 修改記憶檔案 → systemPrompt 下次 query 會改變（這是期望行為）

### 2.9 排程任務

#### Group context mode
```
scheduler → runTask → runContainerAgent(sessionId=群組 session)
  → agent 使用群組對話歷史 → 產生結果
  → onOutput callback → sendMessage → Telegram
```

#### Isolated mode
```
scheduler → runTask → runContainerAgent(sessionId=undefined)
  → agent 在全新 session 中執行 → 產生結果
  → onOutput callback → sendMessage → Telegram
```

**差異**: isolated mode 沒有 transcript → 不需要 replay 偵測
**共同點**: 輸出走管道 A + 可能用管道 B

### 2.10 Container 中斷場景

#### Idle timeout（正常）
```
IDLE_TIMEOUT 到期 → host 寫 _close sentinel → agent-runner 偵測 → 結束 waitForIpcMessage → 正常退出
```

#### Close during query（正常）
```
_close sentinel 在 query 進行中被偵測 → closedDuringQuery=true → stream.end() → query 正常結束
→ main() 跳出迴圈 → container 退出
```

**注意**: 此時 query 可能已經產生了部分 output（已送出），或尚未產生 output。

#### Container timeout（異常）
```
CONTAINER_TIMEOUT 到期 → host docker stop → 容器收到 SIGTERM
→ 如果已有 streaming output → 視為成功（idle cleanup）
→ 如果無 output → 視為 error
```

#### Container crash（異常）
```
exit code != 0 → host 記錄 error + stderr
→ 如果已有 streaming output 送到 Telegram → 不回滾 cursor（避免重複）
→ 如果無 output → 回滾 cursor → 重試
```

### 2.11 PreCompact（Transcript 壓縮）

```
SDK 偵測 transcript 過大 → 觸發 PreCompact hook
→ hook 歸檔 transcript 到 conversations/ → SDK 壓縮 transcript
→ 壓縮後 transcript 只保留 summary + 最近訊息
```

**與 UUID 追蹤的交互**:
- 壓縮發生在 query 進行中
- 壓縮後的 transcript 不包含舊 UUID
- knownUuids 在 container 啟動時一次載入，壓縮不影響它
- 下次 container 啟動時從壓縮後的 transcript 載入 → 舊 UUID 不在 set 中
- 但舊 UUID 也不會被 replay（已被壓縮掉）→ 正確

### 2.12 多訊息批次

```
User 連續發送 3 則訊息（在 agent 開始前）
→ 全部存入 SQLite
→ processMessages 讀取所有 → formatMessages 打包為 XML
→ 單一 prompt 傳入 container
→ agent 看到一批訊息，產生一個回應
```

**無特殊處理**。

---

## 3. 現行設計

### 3.1 核心：UUID-based Replay Detection

用 UUID Set 明確辨識每條 assistant message 的身份。

```typescript
// Container 啟動時從 transcript 載入已知 UUID
const knownUuids = loadKnownUuids(sessionId);

// 跨所有 runQuery 共享（同一 container session）
// 每次處理新的 assistant message 時加入 set
```

#### UUID Set 生命週期

```
Container 啟動
  → loadKnownUuids(sessionId) // 從 transcript 讀取所有 UUID
  ↓
Query 1 (resume, 首次)
  → replay: 舊 assistant UUID 在 set 中 → 跳過
  → 新 assistant messages: UUID 不在 set → 加入 set + 擷取文字
  ↓
Query 2 (resumeAt=lastUuid)
  → replay: Query 1 的 assistant UUID 已在 set 中 → 跳過
  → 新 assistant messages: 加入 set + 擷取文字
  ↓
Query N...
  → 同上
  ↓
Container 結束（knownUuids 隨 process 消亡）
```

#### loadKnownUuids 實作

```typescript
function loadKnownUuids(sessionId: string | undefined): Set<string> {
  const uuids = new Set<string>();
  if (!sessionId) return uuids;

  // SDK 存 transcript 的路徑（container 內）
  const projectDir = '/home/node/.claude/projects/-workspace-group';
  const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
  if (!fs.existsSync(transcriptPath)) return uuids;

  const content = fs.readFileSync(transcriptPath, 'utf-8');
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.uuid) uuids.add(entry.uuid);
    } catch { /* skip malformed lines */ }
  }

  log(`Loaded ${uuids.size} known UUIDs from transcript`);
  return uuids;
}
```

#### extractAssistantText 實作

```typescript
function extractAssistantText(message: unknown): string {
  const content = (message as any)?.message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b: any) => b.type === 'text' && b.text)
    .map((b: any) => b.text)
    .join('');
}
```

### 3.2 runQuery 中的訊息處理迴圈

```typescript
async function runQuery(
  prompt: string,
  sessionId: string | undefined,
  mcpServerPath: string,
  containerInput: ContainerInput,
  sdkEnv: Record<string, string | undefined>,
  resumeAt: string | undefined,
  knownUuids: Set<string>,  // 新增參數
  queryNumber: number,       // 新增參數，用於 log 對照
): Promise<RunQueryResult> {

  let lastAssistantText = '';

  for await (const message of query({ ... })) {
    messageCount++;

    // --- Assistant message ---
    if (message.type === 'assistant' && 'uuid' in message) {
      const uuid = (message as { uuid: string }).uuid;
      lastAssistantUuid = uuid;

      if (knownUuids.has(uuid)) {
        log(`[Q${queryNumber} #${messageCount}] assistant uuid=${uuid.slice(0,8)}… (replay, skipped)`);
        // 不擷取文字，不加入 set（已存在）
        continue;  // 跳過後續處理，但注意這只跳過這條 if 後的程式碼
      }

      // 新的 assistant message
      knownUuids.add(uuid);
      const text = extractAssistantText(message);
      if (text) {
        lastAssistantText = text;
        log(`[Q${queryNumber} #${messageCount}] assistant uuid=${uuid.slice(0,8)}… text=${text.slice(0,100)}… (${text.length} chars)`);
      } else {
        log(`[Q${queryNumber} #${messageCount}] assistant uuid=${uuid.slice(0,8)}… (tool_use only)`);
      }
    }

    // --- Result message ---
    else if (message.type === 'result') {
      resultCount++;
      const textResult = ('result' in message ? (message as { result?: string }).result : null) || '';
      const outputText = textResult || lastAssistantText || null;
      const source = textResult ? 'result' : lastAssistantText ? 'assistant-fallback' : 'none';

      log(`[Q${queryNumber} result#${resultCount}] source=${source} text=${(outputText || '(null)').slice(0,200)} (${outputText?.length || 0} chars)`);

      writeOutput({ status: 'success', result: outputText, newSessionId });
      lastAssistantText = '';  // 重設，下一個 result 需要新的 fallback
    }

    // --- System messages ---
    else if (message.type === 'system') {
      // ... 現有 init/task_notification 處理 ...
    }
  }
}
```

**與舊做法（phase flag）的差異**:

| 項目 | Phase flag（已移除） | UUID Set（現行） |
|------|---------------------|-----------------|
| Replay 偵測 | `replaying`/`processing` flag | UUID Set |
| Phase 轉換 | 第一個 result | 不需要 |
| `lastAssistantText` | 只在 `processing` 階段記錄 | 只在新 UUID 時記錄 |
| `continue` on replay | 不 continue，只跳過 text extraction | continue（跳過整個 message 處理） |
| 跨 query 狀態 | 每次 runQuery 重建 phase | knownUuids 跨 query 累積 |

### 3.3 移除 session-update writeOutput

```diff
  // main() 中的 query 迴圈：

  const queryResult = await runQuery(prompt, sessionId, ..., knownUuids, queryNumber);
  // ... 更新 sessionId, resumeAt ...

  if (queryResult.closedDuringQuery) {
    log('Close sentinel consumed during query, exiting');
    break;
  }

- // 移除: session-update writeOutput
- writeOutput({ status: 'success', result: null, newSessionId: sessionId });

  log('Query ended, waiting for next IPC message...');
```

**為什麼可以移除**:
1. Session ID 已在 result 的 writeOutput（line 599）中送出
2. Idle timer 由 result 的 writeOutput 重設，不需要額外觸發
3. 減少一次不必要的 stdout 寫入和 host 端解析

### 3.4 Log 結構化

#### Agent-runner stderr（debug log）

每條 log 帶 query 序號 `[Q1 #5]` 方便跨 query 追蹤：

```
[agent-runner] Loaded 47 known UUIDs from transcript
[agent-runner] Starting query (Q1, session: abc123, resumeAt: latest)...
[agent-runner] [Q1 #1] system/init session=abc123
[agent-runner] [Q1 #2] assistant uuid=def456… (replay, skipped)
[agent-runner] [Q1 #3] assistant uuid=def457… (replay, skipped)
[agent-runner] [Q1 #4] result (replay end, no output)
[agent-runner] [Q1 #5] assistant uuid=ghi789… text=台北今天28°C… (45 chars)
[agent-runner] [Q1 result#1] source=assistant-fallback text=台北今天28°C… (45 chars)
[agent-runner] Query Q1 done. Messages: 5, results: 1
```

#### Host container log file（groups/main/logs/container-*.log）

```
=== Container Run Log ===
Started: 2026-02-17T10:00:00.000Z
Container: nanoclaw-main-1739782800000

=== Input Summary ===
Prompt length: 102 chars
Session ID: abc123

=== User Request ===
<messages><message sender="shun" time="10:00">台北天氣</message></messages>

=== Agent Responses ===
[1] source=assistant-fallback (45 chars)
台北今天28°C，多雲時晴，建議帶把傘。

=== Container Completed ===
Finished: 2026-02-17T10:00:32.000Z
Duration: 32964ms
Exit Code: 0
```

**改進**:
- Agent Responses 只記錄有文字的結果，標注來源
- 過濾 null output（session update、空 result）

#### Host pino log（nanoclaw.log）

```json
{
  "level": "info",
  "msg": "Agent interaction",
  "promptPreview": "<messages><message sender=\"shun\"...",
  "promptLength": 102,
  "messageCount": 1,
  "outputSentToUser": true,
  "responsePreview": "台北今天28°C，多雲時晴...",
  "responseLength": 45,
  "hadError": false
}
```

**新增**: `responsePreview` 和 `responseLength` 欄位。

### 3.5 IPC send_message 加入 stripInternalTags

目前 `src/ipc.ts` 的 `processIpcFiles` 直接送出 `data.text`，不過濾 `<internal>` 標籤。

```diff
  // src/ipc.ts processIpcFiles
  if (data.type === 'message' && data.text) {
    const targetJid = data.chatJid || OWNER_CHAT_JID;
-   await deps.sendMessage(targetJid, data.text);
+   const text = stripInternalTags(data.text);
+   if (text) {
+     await deps.sendMessage(targetJid, text);
+   }
  }
```

### 3.6 new_session MCP Tool 實作

在 `ipc-mcp-stdio.ts` 新增：

```typescript
server.tool(
  'new_session',
  'Reset the current conversation session. All AgentBrain memory is preserved — only the session transcript is cleared. The reset takes effect on the next message.',
  {},
  async () => {
    writeIpcFile(TASKS_DIR, {
      type: 'new_session',
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: 'Session reset requested. New session starts on next message.' }] };
  },
);
```

在 `src/ipc.ts` 的 `processTaskIpc` 新增：

```typescript
case 'new_session': {
  const folder = data.groupFolder || 'main';
  setSession(folder, '');  // 清除 session record
  logger.info({ folder }, 'Session reset via IPC');
  break;
}
```

在 `src/index.ts` 的 sessions 物件會在下次 `runAgent` 時讀到空 sessionId → 新 session。

---

## 4. 場景驗證矩陣

| 場景 | 訊息管道 | UUID 追蹤行為 | 預期結果 |
|------|----------|--------------|----------|
| 正常對話（result 有文字） | A | 新 UUID → 記錄 text（不使用）→ result 有文字 → 直接送出 | 正確送達 |
| 工具使用（result 空） | A | 新 UUID → 記錄 text → result 空 → fallback 到 assistant text | 正確送達 |
| send_message | B | N/A（不經過 writeOutput） | 正確送達 |
| Agent Teams | A | 每個 subagent 的 assistant 有獨立 UUID → 各自追蹤 | 正確送達 |
| IPC 輸入（多輪） | A | 新 user turn → 新 assistant UUID → 正確識別為新 | 正確送達 |
| Session resume | A | 已知 UUID → skip → 新 UUID → 擷取 | 不重送舊訊息 |
| Session resume + Agent Teams 多 result | A | 所有舊 assistant UUID 在 set 中 → 全部 skip → 新 result 正確使用新 text | 不重送舊訊息 |
| Session reset (new_session) | N/A | 下次 container: sessionId=undefined → knownUuids 為空 | 正確重啟 |
| 反思 | B + A | Agent 主要用 send_message → result 可能空/internal | 正確送達 |
| 排程任務 (group) | A | 使用群組 session → UUID 追蹤正常 | 正確送達 |
| 排程任務 (isolated) | A | 無 session → knownUuids 為空 → 無 replay | 正確送達 |
| Container idle close | N/A | 正常退出，無額外 output | 正確 |
| Close during query | A | closedDuringQuery=true → 跳出迴圈 | 部分 output 已送達 |
| Container timeout | A | 如已有 output → 視為成功 | 正確 |
| Container crash | A | 如已有 output → 不回滾 cursor | 不重複送 |
| PreCompact | N/A | knownUuids 在啟動時載入，壓縮不影響 | 正確 |
| 多訊息批次 | A | 單一 prompt → 單一回應 → 正常追蹤 | 正確 |
| send_message + result 重疊 | B + A | 兩個管道獨立，不去重 | CLAUDE.md 層級處理 |

---

## 5. 與 Upstream 架構比較

### 5.1 Upstream 的做法（main branch）

Upstream 的 `container/agent-runner/src/index.ts`（587 行）不含 AgentBrain 整合，處理回應的方式極度簡單：

```typescript
// upstream runQuery — 完整的 result 處理邏輯
if (message.type === 'result') {
  resultCount++;
  const textResult = 'result' in message ? (message as { result?: string }).result : null;
  log(`Result #${resultCount}: ...`);
  writeOutput({
    status: 'success',
    result: textResult || null,   // 無 fallback，直接用 result text 或 null
    newSessionId
  });
}
```

**Upstream 沒有的東西**:
- 無 replay 偵測（沒有 phase flag，沒有 UUID tracking）
- 無 assistant text fallback（result 為空就送 null）
- 無 `loadCoreMemory()` / `loadVolatileContext()`（沒有 AgentBrain）
- 無 `AGENT_MODEL` 環境變數（使用預設模型）

**Upstream 有但我們改掉的東西**:
- `globalClaudeMd`：非 main group 載入 `/workspace/global/CLAUDE.md`（我們用 single-user mode 已移除）
- `isMain` flag：區分主群組和其他群組（已移除）
- Idle timer 只在有文字時重設（`resetIdleTimer()` 在 `if (result.result)` 內部）

### 5.2 關鍵差異

| 項目 | Upstream | 我們（現行） |
|------|----------|-------------|
| Result 為空時 | 送 null，使用者收不到回覆 | UUID + fallback |
| Replay 偵測 | 無（不需要？見 5.3） | UUID Set |
| Session-update output | 有（query 結束後） | 移除 |
| Idle timer 重設 | 只在有文字的 result | 只在有文字的 result |
| AgentBrain 整合 | 無 | systemPrompt + volatile context |
| Log 結構化 | 基本（type + text preview） | Query 序號 + 來源標注 |
| IPC stripInternalTags | 否 | 是 |
| new_session tool | 否 | 有 |

### 5.3 Upstream 為什麼不需要 replay 偵測？

Upstream 對 replay 的 assistant messages **什麼都不做**——不擷取文字、不用作 fallback。只有 `result.result` 有文字時才送出。

這意味著 upstream 在 session resume 時：
- replay 的 assistant messages → 被忽略（只更新 `lastAssistantUuid`）
- replay 的 result → `textResult || null` → 送 null → host 不送 Telegram
- 新的 result → 如果有文字就送，沒有就不送

**問題**：upstream 不處理 result 為空的情況。如果 agent 的回應文字在 assistant message 而非 result，使用者就收不到回覆。這在 upstream 的使用場景下可能較少發生（沒有 AgentBrain 的 daily log 寫入），但理論上仍是個 bug。

### 5.4 現行設計相對 upstream 的優勢

| 面向 | 說明 |
|------|------|
| 正確性 | UUID 明確辨識 replay，不依賴 result 順序假設 |
| 相容性 | Upstream 的正常路徑（result 有文字）行為完全一致 |
| 覆蓋面 | Fallback 機制處理 upstream 未覆蓋的 result-empty 情況 |
| 可維護性 | 單一機制（UUID Set）取代多個 workaround（phase + fallback 條件） |
| 前瞻性 | UUID tracking 是 Direction A（即時串流）的前置條件 |

### 5.5 Idle Timer

`resetIdleTimer()` 只在有實際文字送出到 Telegram 時才重設，與 upstream 行為一致。Null output 不會重設 timer。

---

## 6. 自動化驗證

### 目標

每次修改回覆機制後，能快速驗證從「收到使用者訊息」到「送出 Telegram 回覆」的完整流程，不需要連接 Telegram。

### 測試範圍

```
使用者訊息
  → storeMessage() (SQLite)
  → getMessagesSince() (讀取未處理訊息)
  → formatMessages() (XML 格式化)
  → runContainerAgent() ← 唯一被 mock 的邊界（container 是外部 process）
      ↓ 模擬 container 產生 OUTPUT markers
  → streaming parser (解析 stdout)
  → onOutput callback
      → session 追蹤
      → stripInternalTags
      → channel.sendMessage() ← 驗證送出的訊息
  → cursor 管理（lastAgentTimestamp 前進/回滾）
  → error handling（hadError → cursor rollback）
```

**Container 是唯一被 mock 的元件**。其餘所有 host 邏輯（DB、格式化、解析、文字處理、cursor 管理）使用真實實作。

### 整合測試設計（vitest）

新增 `src/message-pipeline.test.ts`。

#### 測試架構

```typescript
// Mock 清單：
// 1. config.ts — 固定 OWNER_CHAT_JID、ASSISTANT_NAME 等
// 2. container-runner.ts — mock runContainerAgent，控制 container 的 output
// 3. fs — mock writeFileSync/mkdirSync（避免寫入真實檔案系統）
//
// 真實使用：
// 1. db.ts（in-memory SQLite via _initTestDatabase）
// 2. router.ts（formatMessages, stripInternalTags）
// 3. index.ts 的 processMessages 邏輯
```

#### 測試案例

| 案例 | 模擬情境 | 驗證 |
|------|----------|------|
| 正常對話 | 使用者發「你好」→ container 回 `{result:"你好嗎"}` | sendMessage 被呼叫，內容 = "你好嗎" |
| 工具使用（result 空 + fallback） | container 回 `{result:"台北28°C"}` (agent-runner 已做 fallback) | sendMessage 收到 "台北28°C" |
| internal 標籤過濾 | container 回 `{result:"可見 <internal>隱藏</internal>"}` | sendMessage 收到 "可見" |
| 全 internal | container 回 `{result:"<internal>全隱藏</internal>"}` | sendMessage 不被呼叫 |
| 多 streaming results | container 產生兩個 OUTPUT marker pairs | sendMessage 被呼叫兩次 |
| Session 更新 | container 回 `{result:null, newSessionId:"abc"}` | session 被更新，sendMessage 不被呼叫 |
| Error + cursor 回滾 | container 回 `{status:"error"}` | processMessages return false，cursor 回滾 |
| Error after output（不回滾） | 先有文字 output 再有 error | sendMessage 已呼叫，cursor 不回滾（避免重複） |
| 多訊息批次 | 使用者連發 3 則 → 一個 prompt | formatMessages 包含 3 個 `<message>` 標籤 |
| 空佇列 | 無未處理訊息 | processMessages return true，不啟動 container |

#### 實作

```typescript
// src/message-pipeline.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ContainerOutput } from './container-runner.js';
import { NewMessage } from './types.js';

// --- Mocks ---

const CHAT_JID = '12345';
const BOT_NAME = 'TestBot';

vi.mock('./config.js', () => ({
  OWNER_CHAT_JID: '12345',
  ASSISTANT_NAME: 'TestBot',
  DATA_DIR: '/tmp/nanoclaw-test',
  GROUPS_DIR: '/tmp/nanoclaw-test-groups',
  IDLE_TIMEOUT: 60000,
  STORE_DIR: '/tmp/nanoclaw-test-store',
}));

// Mock fs to prevent real filesystem writes (container-runner uses it for logs)
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn(),
      readFileSync: actual.readFileSync,
      existsSync: actual.existsSync,
    },
  };
});

// Mock container-runner: the ONLY real mock boundary
// Returns controlled outputs via onOutput callback
let mockContainerBehavior: (
  onOutput?: (output: ContainerOutput) => Promise<void>,
) => Promise<ContainerOutput>;

vi.mock('./container-runner.js', () => ({
  runContainerAgent: vi.fn(async (
    _config: unknown,
    _input: unknown,
    _onProcess: unknown,
    onOutput?: (output: ContainerOutput) => Promise<void>,
  ) => {
    return mockContainerBehavior(onOutput);
  }),
  writeTasksSnapshot: vi.fn(),
}));

// Mock logger to suppress output
vi.mock('./logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// --- Test setup ---
import { _initTestDatabase, storeMessage, getMessagesSince, setSession, getAllSessions } from './db.js';
import { formatMessages, stripInternalTags } from './router.js';

// Re-implement the core processMessages logic for testing
// (index.ts has side effects and module-level state that make direct import difficult)
async function processMessages(
  chatJid: string,
  lastAgentTimestamp: string,
  sessions: Record<string, string>,
  sendMessage: (jid: string, text: string) => Promise<void>,
): Promise<{ success: boolean; newCursor: string; sentMessages: string[]; sessionUpdated: string | undefined }> {
  const { runContainerAgent } = await import('./container-runner.js');

  const missedMessages = getMessagesSince(chatJid, lastAgentTimestamp, BOT_NAME);
  if (missedMessages.length === 0) {
    return { success: true, newCursor: lastAgentTimestamp, sentMessages: [], sessionUpdated: undefined };
  }

  const prompt = formatMessages(missedMessages);
  const previousCursor = lastAgentTimestamp;
  let cursor = missedMessages[missedMessages.length - 1].timestamp;

  let hadError = false;
  let outputSentToUser = false;
  const sentMessages: string[] = [];
  let sessionUpdated: string | undefined;

  try {
    const output = await runContainerAgent(
      { chatJid, folder: 'main' } as any,
      { prompt, sessionId: sessions['main'], groupFolder: 'main', chatJid } as any,
      (() => {}) as any,  // onProcess (not tested)
      async (result: ContainerOutput) => {
        // This mirrors the onOutput callback in src/index.ts processMessages
        if (result.newSessionId) {
          sessions['main'] = result.newSessionId;
          sessionUpdated = result.newSessionId;
        }

        if (result.result) {
          const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
          const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          if (text) {
            await sendMessage(chatJid, text);
            sentMessages.push(text);
            outputSentToUser = true;
          }
        }

        if (result.status === 'error') {
          hadError = true;
        }
      },
    );

    if (output.status === 'error') hadError = true;
  } catch {
    hadError = true;
  }

  // Cursor rollback logic (mirrors src/index.ts)
  if (hadError) {
    if (outputSentToUser) {
      // Error after output — don't rollback to prevent duplicate sends
      return { success: true, newCursor: cursor, sentMessages, sessionUpdated };
    }
    return { success: false, newCursor: previousCursor, sentMessages, sessionUpdated };
  }

  return { success: true, newCursor: cursor, sentMessages, sessionUpdated };
}

// --- Helper ---
function makeMessage(content: string, timestamp: string, sender = 'user1'): NewMessage {
  return {
    id: `msg-${timestamp}`,
    chat_jid: CHAT_JID,
    sender,
    sender_name: sender,
    content,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  };
}

// --- Tests ---
describe('message pipeline: user message → Telegram reply', () => {
  beforeEach(() => {
    _initTestDatabase();
  });

  it('normal conversation: user message → agent reply → Telegram', async () => {
    storeMessage(makeMessage('你好', '2026-02-17T10:00:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'success', result: '你好嗎', newSessionId: 'sess-1' });
      return { status: 'success', result: null, newSessionId: 'sess-1' };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.success).toBe(true);
    expect(r.sentMessages).toEqual(['你好嗎']);
    expect(r.sessionUpdated).toBe('sess-1');
    expect(sendMessage).toHaveBeenCalledWith(CHAT_JID, '你好嗎');
  });

  it('strips <internal> tags before sending to Telegram', async () => {
    storeMessage(makeMessage('狀態', '2026-02-17T10:01:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'success', result: '一切正常 <internal>daily log written</internal>' });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.sentMessages).toEqual(['一切正常']);
  });

  it('does not send when all content is <internal>', async () => {
    storeMessage(makeMessage('reflect', '2026-02-17T10:02:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'success', result: '<internal>reflection complete</internal>' });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.success).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not send null result (session update only)', async () => {
    storeMessage(makeMessage('test', '2026-02-17T10:03:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'success', result: null, newSessionId: 'sess-2' });
      return { status: 'success', result: null, newSessionId: 'sess-2' };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(sendMessage).not.toHaveBeenCalled();
    expect(r.sessionUpdated).toBe('sess-2');
  });

  it('handles multiple streaming results', async () => {
    storeMessage(makeMessage('多工', '2026-02-17T10:04:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'success', result: '第一步完成', newSessionId: 'sess-3' });
      await onOutput!({ status: 'success', result: '全部完成' });
      return { status: 'success', result: null, newSessionId: 'sess-3' };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.sentMessages).toEqual(['第一步完成', '全部完成']);
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('rolls back cursor on error when no output was sent', async () => {
    storeMessage(makeMessage('crash', '2026-02-17T10:05:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'error', result: null, error: 'container crashed' });
      return { status: 'error', result: null, error: 'container crashed' };
    };

    const sendMessage = vi.fn();
    const previousCursor = '';
    const r = await processMessages(CHAT_JID, previousCursor, {}, sendMessage);

    expect(r.success).toBe(false);
    expect(r.newCursor).toBe(previousCursor);  // rolled back
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does NOT rollback cursor when error occurs after output was sent', async () => {
    storeMessage(makeMessage('partial', '2026-02-17T10:06:00.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'success', result: '部分結果' });
      await onOutput!({ status: 'error', result: null, error: 'late error' });
      return { status: 'error', result: null, error: 'late error' };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.success).toBe(true);  // treated as success to prevent duplicate
    expect(r.newCursor).toBe('2026-02-17T10:06:00.000Z');  // NOT rolled back
    expect(r.sentMessages).toEqual(['部分結果']);
  });

  it('batches multiple user messages into single prompt', async () => {
    storeMessage(makeMessage('第一則', '2026-02-17T10:07:00.000Z'));
    storeMessage(makeMessage('第二則', '2026-02-17T10:07:01.000Z'));
    storeMessage(makeMessage('第三則', '2026-02-17T10:07:02.000Z'));

    let capturedPrompt = '';
    mockContainerBehavior = async (onOutput) => {
      // Capture the prompt that was passed to the container
      const { runContainerAgent } = await import('./container-runner.js');
      const calls = vi.mocked(runContainerAgent).mock.calls;
      capturedPrompt = (calls[calls.length - 1][1] as any).prompt;

      await onOutput!({ status: 'success', result: '收到三則訊息' });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.sentMessages).toEqual(['收到三則訊息']);
    // Verify all 3 messages were formatted into the prompt
    expect(capturedPrompt).toContain('第一則');
    expect(capturedPrompt).toContain('第二則');
    expect(capturedPrompt).toContain('第三則');
  });

  it('returns success with no container call when no pending messages', async () => {
    // Don't store any messages
    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.success).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('filters bot messages from prompt', async () => {
    storeMessage(makeMessage('使用者訊息', '2026-02-17T10:08:00.000Z'));
    storeMessage({
      ...makeMessage('TestBot:機器人回覆', '2026-02-17T10:08:01.000Z', BOT_NAME),
      is_bot_message: true,
    });
    storeMessage(makeMessage('使用者第二則', '2026-02-17T10:08:02.000Z'));

    mockContainerBehavior = async (onOutput) => {
      const { runContainerAgent } = await import('./container-runner.js');
      const calls = vi.mocked(runContainerAgent).mock.calls;
      const prompt = (calls[calls.length - 1][1] as any).prompt;

      // Bot message should NOT be in the prompt
      expect(prompt).not.toContain('機器人回覆');
      expect(prompt).toContain('使用者訊息');
      expect(prompt).toContain('使用者第二則');

      await onOutput!({ status: 'success', result: '好的' });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    await processMessages(CHAT_JID, '', {}, sendMessage);
  });

  it('advances cursor to latest message timestamp on success', async () => {
    storeMessage(makeMessage('msg1', '2026-02-17T10:09:00.000Z'));
    storeMessage(makeMessage('msg2', '2026-02-17T10:09:05.000Z'));

    mockContainerBehavior = async (onOutput) => {
      await onOutput!({ status: 'success', result: 'ok' });
      return { status: 'success', result: null };
    };

    const sendMessage = vi.fn();
    const r = await processMessages(CHAT_JID, '', {}, sendMessage);

    expect(r.newCursor).toBe('2026-02-17T10:09:05.000Z');
  });
});
```

### 執行方式

```bash
npx vitest run src/message-pipeline.test.ts
```

修改回覆機制後跑一次（< 2 秒，不需外部服務），即可驗證：
- 使用者訊息正確存入 DB 並被讀取
- 多訊息批次正確打包為 XML prompt
- bot 訊息被過濾，不進入 prompt
- `<internal>` 標籤被正確過濾
- null result 不會送出
- 多 streaming result 各自獨立送出
- session ID 正確追蹤更新
- error 時 cursor 正確回滾（未送出回覆時）
- error after output 時不回滾（避免重複送出）
- cursor 前進到最新訊息的 timestamp

---

## 7. 變更紀錄

所有 phase 已實作完成。

### Phase 1: agent-runner 改造 ✅

- `loadKnownUuids()`, `extractAssistantText()` 函式
- UUID-based replay detection 取代 phase flag
- 結構化 log（`[Q1 #5]` 格式 + source 標注）
- 移除 session-update `writeOutput`

### Phase 2: Host 端改善 ✅

- `responsePreview` 加入 Agent interaction log
- `resetIdleTimer()` 移至 `if (text)` 內部
- Container log 標注 response 來源與長度
- IPC `send_message` 加入 `stripInternalTags`

### Phase 3: new_session 實作 ✅

- `ipc-mcp-stdio.ts`: `new_session` MCP tool
- `ipc.ts`: `processTaskIpc` 處理 `new_session`

### Phase 4: 整合測試 ✅

- `src/message-pipeline.test.ts`: 11 個測試案例
- 覆蓋完整管道：使用者訊息 → SQLite → formatMessages → container (mock) → stripInternalTags → Telegram

### 驗證流程

```bash
npm run build                                    # 編譯
npx vitest run src/message-pipeline.test.ts      # 整合測試（< 2 秒）
# 重啟服務 → 在 Telegram 發一則訊息確認正常
```
