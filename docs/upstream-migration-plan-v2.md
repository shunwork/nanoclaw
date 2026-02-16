# Upstream Migration Plan v2 — Fresh Rebase

## 策略變更

v1 計畫採用 `git merge upstream/main` 解衝突的方式。模擬 merge 後發現 **38+ 個衝突區塊分布在 16 個檔案**，且核心檔案（`index.ts` 16 個、`container-runner.ts` 10 個、`agent-runner` 4 個）的解衝突策略本質上都是「取 upstream 版本，重新套用客製化」。

**v2 改為 Fresh Rebase**：從 `upstream/main` 開新 branch，逐一加入客製化功能。每步可編譯測試，不需處理 merge conflict。

### 兩種策略對比

| | v1: Merge 解衝突 | v2: Fresh Rebase |
|--|------------------|------------------|
| 起點 | myclaw + merge upstream | upstream clean code |
| 衝突處理 | 38+ conflict blocks，手動判斷 | 無衝突 |
| 過程中可否編譯測試 | ❌ 解衝突期間 broken state | ✅ 每步都可編譯 |
| 意外保留舊邏輯的風險 | 高（conflict marker 中容易遺漏） | 低（從乾淨 upstream 開始） |
| 出 bug 時定位 | 難（不知是哪段 conflict resolution 出錯） | 易（每個 commit 對應一個功能） |
| Git 歷史 | merge commit 連接兩邊歷史 | 新 branch，commit message 標註來源 |
| 實際工作量 | ≈ 相同（衝突解決 = 重寫） | ≈ 相同（直接重寫） |

---

## 現狀

| Branch | Base | HEAD | 說明 |
|--------|------|------|------|
| `main` | `f26468c` | `f26468c` | 落後 upstream 16 commits |
| `upstream/main` | — | `c30bd62` | 最新 upstream |
| `feature/myclaw` | `f26468c` | `25c2351` | 個人部署 (22 commits) |
| `feature/customization` | `f26468c` | `755a93d` | 共享 skills (8 commits above main) |

### myclaw 客製化功能清單

| # | 功能 | 涉及檔案 | 複雜度 |
|---|------|----------|--------|
| C1 | Telegram Bot | `src/index.ts`, `src/telegram-auth.ts` | 高 — 需重構為 TelegramChannel |
| C2 | Single-user mode | `src/index.ts`, `src/ipc.ts`, `src/router.ts`, `src/config.ts`, `src/db.ts`, `src/types.ts`, `src/container-runner.ts`, `src/task-scheduler.ts`, `src/mount-security.ts` | 高 — 每個模組都要簡化 |
| C3 | AgentBrain | `AgentBrain/` submodule, `src/container-runner.ts`, `container/agent-runner/src/index.ts` | 中 — mount + system prompt |
| C4 | AGENT_MODEL | `src/config.ts`, `src/container-runner.ts`, `container/agent-runner/src/index.ts` | 低 — env var passthrough |
| C5 | Detailed logs | `src/container-runner.ts`, `src/index.ts` | 中 — streaming output 上重新實作 |
| C6 | System prompt 優化 | `container/agent-runner/src/index.ts` | 低 — core memory injection |
| C7 | Output 處理遷移 | `container/agent-runner/src/index.ts`, `groups/main/CLAUDE.md` | 中 — outputFormat → `<internal>` tag |

### upstream 新功能採用清單

| 功能 | 要採用？ | 說明 |
|------|----------|------|
| Streaming Container | ✅ | 多輪對話免重啟 |
| Channel 抽象化 | ✅ | TelegramChannel 實作 |
| IPC 模組 (`src/ipc.ts`) | ✅ | 取代 monolithic index.ts 中的 IPC 邏輯 |
| Router 模組 (`src/router.ts`) | ✅ | 取代 structured output，用 `<internal>` tag |
| ipc-mcp-stdio | ✅ | 取代 ipc-mcp.ts，支援 subagent 繼承 |
| Agent Teams | ✅ | 啟用 subagent（Task/TeamCreate），不啟用 Swarm |
| Timeout bug fix | ✅ | 已含在 streaming 架構中 |
| Claude native memory | ❌ | 所有記憶由 AgentBrain 管理 |
| WhatsApp 改進 / 測試 | ❌ | 已改用 Telegram |
| requiresTrigger IPC fix | ❌ | Single-user 不需要 trigger |
| 簡體中文 README | ❌ | 不需要 |
| Agent Swarm (多 bot 身份) | ❌ | Single-user 不需要 |

---

## Phase 0: 準備工作

### 0-1: 同步 main

```bash
git fetch upstream
git checkout main
git merge upstream/main --ff-only
```

`main` 從 `f26468c` → `c30bd62`。

### 0-2: 備份 myclaw

```bash
git branch feature/myclaw-archive feature/myclaw
```

保留舊 branch 作為參考（提取客製化程式碼時對照用）。

---

## Phase 1: 從 upstream 重建

### 1-1: 建立新 branch

```bash
git checkout main -b feature/myclaw-v2
```

此時 codebase = upstream `c30bd62`，包含 WhatsApp、multi-group、streaming、Agent Teams。

### Commit 策略

每個功能一個 commit，按依賴順序執行。每步完成後可 `npm run typecheck` 驗證：

```
C1: feat: implement TelegramChannel
C2: feat: apply single-user simplification
C3: feat: integrate AgentBrain memory system
C4: feat: add AGENT_MODEL runtime model selection
C5: feat: add detailed container logging
C6: chore: remove unused features (WhatsApp, Chinese README, native memory)
C7: chore: bring over docs, skills, and config from myclaw
```

### 1-2: [C1] 實作 TelegramChannel

**新建** `src/channels/telegram.ts`，實作 `Channel` interface：

```typescript
export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false;  // Telegram bot 自帶名稱顯示

  async connect() { /* bot.start() long polling, IPv4 forced */ }
  async sendMessage(jid, text) { /* 4096 char split */ }
  isConnected() { ... }
  ownsJid(jid) { return true; }  // Single-user: 所有 JID 都是我的
  async disconnect() { /* bot.stop() */ }
  async setTyping(jid, isTyping) { /* 4.5s repeating timer / clearInterval */ }
}
```

**來源**：從 `feature/myclaw-archive` 的 `src/index.ts` 提取 grammy 相關邏輯，參考 upstream `src/channels/whatsapp.ts` 的 Channel 結構。

**修改** `src/index.ts`：
- 將 channel 建立從 `WhatsAppChannel` 改為 `TelegramChannel`
- 更新 `package.json`：加入 `grammy` 依賴

**搬移** `src/telegram-auth.ts`：
- 從 `feature/myclaw-archive` 直接 copy（若仍需要 auth flow）

**驗證**：`npm run typecheck` 通過

```bash
git add src/channels/telegram.ts src/index.ts src/telegram-auth.ts package.json package-lock.json
git commit -m "feat: implement TelegramChannel"
```

### 1-3: [C2] Single-user 簡化

在 upstream 模組化架構上套用 single-user 模式。參考 `feature/myclaw-archive` 的簡化邏輯，但套用在新架構的對應模組上。

#### `src/config.ts`
- 加入 `OWNER_CHAT_JID` 從環境變數讀取
- 移除 `TRIGGER_PATTERN`（single-user 不需要）

#### `src/index.ts`
- 移除 `registeredGroups` map 和所有引用
- 移除 `registerGroup()`、`syncGroupMetadata()`、`getAvailableGroups()`
- 移除 `GROUP_SYNC_INTERVAL_MS` 和相關 timer
- 移除 trigger pattern 檢查 — 所有來自 `OWNER_CHAT_JID` 的訊息都處理
- 移除 `my_chat_member` handler
- 簡化 `processMessages()`：直接用 owner config，不查 `registeredGroups`
- 啟動時驗證 `OWNER_CHAT_JID` 已設定

#### `src/ipc.ts`
- 只掃描 `data/ipc/main/`（移除 multi-group directory scanning）
- 移除授權檢查（single user = full trust）
- 移除 `register_group`、`refresh_groups` IPC 處理
- 修正 send_message 前綴邏輯：移除硬編碼 `ASSISTANT_NAME:` 前綴，改透過 `formatOutbound()` 統一處理
- 簡化 `IpcDeps`：移除 `registeredGroups`、`registerGroup`、`syncGroupMetadata`、`getAvailableGroups`、`writeGroupsSnapshot`

#### `src/router.ts`
- 簡化 `routeOutbound` — 只有一個 channel

#### `src/db.ts`
- 移除 `registered_groups` 相關函數
- 保留 `chats` table（messages FK 需要）

#### `src/types.ts`
- 加入 `OwnerConfig` interface
- 保留 `Channel` interface

#### `src/container-runner.ts`
- `buildVolumeMounts()` 簡化：移除 `isMain` 分支，always main
- `runContainerAgent()` 使用 `OwnerConfig` 取代 `RegisteredGroup`
- 移除 `writeGroupsSnapshot()`

#### `src/task-scheduler.ts`
- 移除 `registeredGroups` 依賴，直接用 owner config
- 移除 group lookup

#### `src/mount-security.ts`
- 移除 `isMain` 相關邏輯

#### `src/group-queue.ts`
- 功能保留（仍需序列化處理和 retry）
- 可選擇性 rename（`GroupQueue` → `MessageQueue`）

#### `container/agent-runner/src/ipc-mcp-stdio.ts`
- 移除 `register_group` tool
- `schedule_task`：移除 `target_group_jid` 參數
- `send_message`：移除 `sender` 參數
- `list_tasks`：移除 `isMain` 過濾
- `NANOCLAW_IS_MAIN` env var 可保留（always '1'）或移除

**驗證**：`npm run typecheck` 通過

```bash
git add -A
git commit -m "feat: apply single-user simplification"
```

### 1-4: [C3] AgentBrain 整合

#### AgentBrain submodule
```bash
git submodule add <AgentBrain-repo-url> AgentBrain
```

#### `src/config.ts`
- 加入 `AGENTBRAIN_DIR` 路徑

#### `src/container-runner.ts` — `buildVolumeMounts()`
加入 AgentBrain vault mount：
```typescript
fs.mkdirSync(AGENTBRAIN_DIR, { recursive: true });
mounts.push({
  hostPath: AGENTBRAIN_DIR,
  containerPath: '/workspace/brain',
  readonly: false,
});
```

#### `container/agent-runner/src/index.ts`

加入 `loadCoreMemory()` 和 `loadVolatileContext()` 函數（從 `feature/myclaw-archive` 的 `container/agent-runner/src/index.ts` 搬移）：

- **`loadCoreMemory()`** → 讀取 `/workspace/brain` 中的 soul.md、identity.md、user.md、tool.md、memory.md → 作為 `systemPrompt` 參數傳入 `query()`
  - **與 streaming 相容**：`runQuery()` 的 `systemPrompt` 參數在 streaming 版本中同樣可用 ✅

- **`loadVolatileContext()`** → 讀取 context.md + daily logs → 在初始 prompt push 進 MessageStream 前 prepend
  - **與 streaming 相容**：只在 `main()` 的初始 prompt 建構階段執行，不影響 streaming loop 的 `prompt = nextMessage` ✅
  - Session reset 時也正確運作：`runQuery()` 回傳 `closedDuringQuery` 或新 sessionId，`main()` 的 while loop 下一輪會用新 prompt，此時 `loadVolatileContext()` 已在初始化階段完成

**驗證**：`npm run typecheck` 通過

```bash
git add -A
git commit -m "feat: integrate AgentBrain memory system"
```

### 1-5: [C4] AGENT_MODEL

#### `src/config.ts`
```typescript
export const AGENT_MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-5-20250929';
```

#### `src/container-runner.ts` — `buildContainerArgs()`
```typescript
args.push('-e', `AGENT_MODEL=${AGENT_MODEL}`);
```

#### `container/agent-runner/src/index.ts` — `runQuery()`
```typescript
model: process.env.AGENT_MODEL || 'claude-sonnet-4-5-20250929',
```

**驗證**：`npm run typecheck` 通過

```bash
git add src/config.ts src/container-runner.ts container/agent-runner/src/index.ts
git commit -m "feat: add AGENT_MODEL runtime model selection"
```

### 1-6: [C5] Detailed Container Logging

在 streaming output 的 `onOutput` callback 中實作。

upstream streaming 架構中，每次收到 output marker pair 時 `onOutput(parsed)` 被呼叫。在此 callback 中（或 container close 後）append 到 log file：

```
=== User Request ===
<prompt text, truncated to 2000 chars>

=== Agent Response ===
Output Type: message
User Message (N chars):
<response text, truncated to 2000 chars>
Internal Log:
<internal log, truncated to 500 chars>
```

**注意**：upstream 的 output 是 plain text（不是 JSON），所以 log 格式需要調整：
- `result` 是字串（agent 的回覆文字）
- 不再有 `outputType` / `userMessage` / `internalLog` 欄位
- `<internal>` tag 內的內容在 log 中保留（stripInternalTags 只在發送時過濾）

也在 host `src/index.ts` 的 `processMessages()` 中加入 pino structured log：
```typescript
logger.info({
  promptPreview: prompt.slice(0, 200).replace(/\n/g, ' '),
  responsePreview: result?.slice(0, 200)?.replace(/\n/g, ' '),
  promptLength: prompt.length,
  responseLength: result?.length || 0,
}, 'Agent interaction');
```

**驗證**：`npm run typecheck` 通過

```bash
git add src/container-runner.ts src/index.ts
git commit -m "feat: add detailed container logging"
```

### 1-7: [C6] 移除不需要的功能

| 操作 | 檔案 |
|------|------|
| 刪除 WhatsApp channel | `src/channels/whatsapp.ts` |
| 刪除 WhatsApp auth | `src/whatsapp-auth.ts` |
| 刪除 WhatsApp 測試 | `src/channels/whatsapp.test.ts` |
| 刪除簡體中文 README | `README_zh.md` |
| 禁用 Claude native memory | `settings.json` 中 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| 啟用 Agent Teams | `settings.json` 中 `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` |
| 啟用額外 CLAUDE.md | `settings.json` 中 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` |
| 不加入 Bot Pool / Swarm config | 確認未引入 `TELEGRAM_BOT_POOL` 相關代碼 |

Agent Teams 啟用後，確認 `allowedTools` 包含：
```typescript
'Task', 'TaskOutput', 'TaskStop', 'TeamCreate', 'TeamDelete', 'SendMessage'
```

```bash
git rm src/channels/whatsapp.ts src/whatsapp-auth.ts src/channels/whatsapp.test.ts README_zh.md
git add -A
git commit -m "chore: remove WhatsApp, Chinese README; configure Agent Teams and disable native memory"
```

### 1-8: [C7] 搬移 docs、skills、config

從 `feature/myclaw-archive` 搬移非程式碼檔案：

| 來源 (myclaw-archive) | 目標 | 方式 |
|----------------------|------|------|
| `CLAUDE.md` | `CLAUDE.md` | 覆寫（myclaw 版本更完整） |
| `groups/main/CLAUDE.md` | `groups/main/CLAUDE.md` | 覆寫 |
| `groups/main/.claude/skills/*` | 同路徑 | copy |
| `.claude/skills/*` (myclaw-only) | 同路徑 | copy |
| `docs/agentbrain-design.md` | 同路徑 | copy |
| `tutorial/TUTORIAL.md` | 同路徑 | copy |

```bash
# 從 myclaw-archive 提取檔案
git checkout feature/myclaw-archive -- \
  CLAUDE.md \
  groups/main/CLAUDE.md \
  "groups/main/.claude/skills/" \
  docs/agentbrain-design.md \
  tutorial/TUTORIAL.md

# myclaw-only skills（upstream 沒有的）
git checkout feature/myclaw-archive -- \
  .claude/skills/add-heptabase/ \
  .claude/skills/add-memory/ \
  .claude/skills/add-personality/ \
  .claude/skills/detailed-logs/ \
  .claude/skills/migrate-to-telegram/ \
  .claude/skills/server-migration/ \
  .claude/skills/set-default-model/ \
  .claude/skills/single-user-mode/
```

**注意**：`CLAUDE.md` 需要更新以反映新架構（Phase 3 會做）。此步先搬移，後續再更新內容。

**注意**：upstream 的 skills（`setup`、`debug`、`customize`、`add-gmail`、`x-integration`、`add-telegram`、`add-telegram-swarm`）已經在 `main` branch 上，不需要搬移。如果 myclaw 有修改過這些 skill，需要手動合併差異。

```bash
git add -A
git commit -m "chore: bring over docs, skills, and config from myclaw"
```

### 1-9: Build 和 typecheck

```bash
npm install                    # 安裝 grammy 等新依賴
npm run build                  # Host TypeScript 編譯
npm run typecheck              # 確認型別正確
cd container && npm install && npm run build && cd ..   # Agent-runner 依賴 + 編譯
./container/build.sh           # Docker image rebuild
```

**container/agent-runner 依賴確認**：upstream 的 `ipc-mcp-stdio.ts` 需要：
- `@modelcontextprotocol/sdk`
- `zod`
- `cron-parser`

這些應已在 upstream 的 `container/agent-runner/package.json` 中。但若有遺漏需手動加入。

### 1-10: 替換 myclaw branch

```bash
git branch -m feature/myclaw feature/myclaw-old    # 重命名舊 branch
git branch -m feature/myclaw-v2 feature/myclaw      # 新 branch 取用 myclaw 名稱
```

此時 `feature/myclaw-archive` 和 `feature/myclaw-old` 都指向舊 commit（冗餘，保留 archive 即可）：
```bash
git branch -d feature/myclaw-old
```

### 1-11: 功能驗證

1. 啟動服務：`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
2. 發送測試訊息到 Telegram bot — 確認收到回覆
3. 確認 streaming 模式：container 回覆後不會立即退出
   - `docker ps` 應顯示 container 仍在運行
4. 確認多輪對話：在 idle timeout 內再發訊息
   - logs 不應顯示 "Spawning container"（訊息 pipe 到同一 container）
5. 確認排程任務：透過 bot 建立 "remind me in 1 minute to test"
6. 確認 AgentBrain：檢查 container log 中 `Core memory loaded: N chars`（N > 0）
7. 確認 IPC send_message：agent 主動發訊息時不應有重複 assistant name 前綴
8. 確認 `<internal>` tag 過濾：agent 內部思考不應出現在 Telegram 訊息中
9. 檢查 logs：`tail -f logs/nanoclaw.log` — 應有 "Agent interaction" 結構化 log
10. 確認 Agent Teams：測試 agent 能否使用 Task tool 派生子任務

### 1-12: 搬移遷移文件

```bash
# 搬移 upstream-migration-plan.md 和 architecture ref 到新 branch（如果需要保留）
git checkout feature/myclaw-archive -- \
  docs/upstream-migration-plan.md \
  docs/upstream-migration-plan-v2.md \
  docs/upstream-architecture-reference.md
git add docs/
git commit -m "docs: bring over migration planning documents"
```

---

## Phase 2: Skills 升級

### 2-1: 建立 customization-v2

```bash
git checkout main                          # 已同步至 c30bd62
git checkout -b feature/customization-v2
git merge feature/customization --no-ff -m "Merge existing skills from feature/customization"
```

帶入所有現有 skills，base 在新 upstream 之上。

### 2-2: 逐一升級 Skills

每個 skill 各自一個 commit。需要更新的項目：

#### `/migrate-to-telegram` → 大幅更新

舊版指導在 monolithic `index.ts` 中加入 grammy。新版需要：
- 改為建立 `src/channels/telegram.ts` (Channel interface)
- 更新 `index.ts` 的 import/wiring（模組化架構）
- 加入 streaming container 相關配置
- 更新 `src/whatsapp-auth.ts` 移除步驟

#### `/single-user-mode` → 大幅更新

舊版針對 monolithic 架構。新版需要：
- 更新 `src/index.ts` 簡化步驟（模組化架構，index 更薄）
- 新增 `src/ipc.ts` 簡化步驟
- 新增 `src/router.ts` 簡化步驟
- 更新 `container/agent-runner/src/ipc-mcp-stdio.ts`（取代 `ipc-mcp.ts`）
- 移除 `src/channels/whatsapp.ts` 步驟

#### `/set-default-model` → 輕微更新

- 確認 `src/config.ts` code 與新版吻合
- 確認 `container/agent-runner/src/index.ts` 的 `runQuery()` 位置

#### `/add-heptabase` → 輕微更新

- `container-runner.ts` mount 位置更新
- MCP server 改為 `ipc-mcp-stdio.ts` 架構

#### `/add-memory`, `/add-personality` → 中度更新

- `container-runner.ts` volume mount 更新
- `agent-runner/src/index.ts` system prompt 注入位置（`runQuery()` 中的 `systemPrompt`）
- 確保 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`

#### `/detailed-logs`, `/server-migration` → 中度更新

- Detailed logs：streaming output `onOutput` callback 上重新實作
- Server migration：路徑和服務管理不變，更新檔案清單

#### 其他 skills

`/setup`、`/debug`、`/customize`、`/add-gmail`、`/x-integration` 來自 upstream。`main` branch 已有最新版。如需微調可在 `customization-v2` 上修改。

### 2-3: 未來工作流程

```bash
# 新 skill 開發
git checkout feature/customization-v2
# ... 建立 .claude/skills/new-skill/SKILL.md, commit ...

# 取得 skill 到 myclaw
git checkout feature/myclaw
git cherry-pick <skill-commit-hash>
# ... apply code changes on myclaw, commit ...
```

Cherry-pick 或 `merge --no-ff` 皆可。`customization-v2` 和 `myclaw` 共享同一 upstream base。

---

## Phase 3: 收尾

### 3-1: 更新 CLAUDE.md

- Architecture Overview：反映 streaming + channel abstraction + modular code
- Key Files table：加入 `src/ipc.ts`、`src/router.ts`、`src/channels/telegram.ts`
- Container Agent Configuration：更新 streaming、Agent Teams、`<internal>` tag
- Branch Strategy：加入 `feature/customization-v2`，移除 `feature/customization` 相關

### 3-2: 更新 groups/main/CLAUDE.md

- 指導 agent 用 `<internal>` tag 包裹不需發送的內容（取代 `outputType: log`）
- 更新 MCP tools 說明（`ipc-mcp-stdio.ts` 的 simplified tools）

### 3-3: 更新 MEMORY.md

- 新增 streaming architecture 相關筆記
- 更新 Key Patterns：新 output protocol、idle timeout、`<internal>` tag

### 3-4: Push customization-v2 到 origin

```bash
git push origin feature/customization-v2
```

`feature/customization` 保留不刪（歷史參考）。

### 3-5: 清理

- 確認 myclaw 正常後刪除 `feature/myclaw-archive`
- 確認後可刪除 `feature/mysetting`
- 確認 `customization-v2` 正常後 `feature/customization` 可 archive

---

## 執行順序與複雜度

| Phase | 步驟 | 說明 | 複雜度 |
|-------|------|------|--------|
| 0 | 0-1 | Sync main | 簡單 |
| 0 | 0-2 | 備份 myclaw | 簡單 |
| 1 | 1-1 | 從 main 開 branch | 簡單 |
| 1 | 1-2 | **[C1] TelegramChannel** | 中 — 從 myclaw 提取重構為 Channel |
| 1 | 1-3 | **[C2] Single-user 簡化** | ⚠️ 高 — 每個模組都要改 |
| 1 | 1-4 | [C3] AgentBrain | 中 — mount + system prompt |
| 1 | 1-5 | [C4] AGENT_MODEL | 低 — 3 個檔案小改 |
| 1 | 1-6 | [C5] Detailed logs | 中 — streaming callback |
| 1 | 1-7 | [C6] 移除不需要的功能 | 低 — 刪除檔案 |
| 1 | 1-8 | [C7] 搬移 docs/skills | 低 — copy 檔案 |
| 1 | 1-9 | Build + typecheck | 低 |
| 1 | 1-10 | 替換 branch | 簡單 |
| 1 | 1-11 | 功能驗證 | 中 |
| 2 | 2-1 | 建立 customization-v2 | 簡單 |
| 2 | 2-2 | 升級各 skill | 中 — 逐一更新 |
| 3 | 3-1 ~ 3-5 | 收尾 | 低 |

### 與 v1 風險對比

| 風險 | v1 (Merge) | v2 (Fresh Rebase) |
|------|-----------|-------------------|
| 衝突解決出錯 | ⚠️ 高 — 38+ conflict blocks | ✅ 無衝突 |
| 意外保留舊邏輯 | ⚠️ 高 — conflict marker 中遺漏 | ✅ 從乾淨 upstream 開始 |
| 中途 broken state | ⚠️ 解衝突期間無法測試 | ✅ 每步可 typecheck |
| 回溯 bug 難度 | ⚠️ 衝突解決混在一個 commit | ✅ 每個功能一個 commit |
| 遺漏客製化 | 中 — 需對照 myclaw diff | 中 — 同樣需要對照 |

**最高風險步驟**仍是 1-3 (Single-user 簡化)，因為需要改動最多模組。但在 v2 中，這步操作在可編譯的 upstream code 上進行，有類型檢查保護，比在 merge conflict 環境中安全得多。

---

## 參考資料

- 舊版計畫：`docs/upstream-migration-plan.md`（v1 merge 策略，留存參考）
- 架構參考：`docs/upstream-architecture-reference.md`（upstream 新功能機制詳解）
- myclaw 客製化參考：`feature/myclaw-archive` branch（舊 codebase 完整保留）
