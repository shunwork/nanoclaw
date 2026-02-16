# Upstream Migration Plan

## 目標

將 `feature/myclaw` 從舊架構（single-shot container, monolithic index.ts）升級至 upstream 新架構（streaming container, channel abstraction, modular code），同時保留所有客製化功能。

## 現狀

| Branch | Base | HEAD | 說明 |
|--------|------|------|------|
| `main` | `f26468c` | `f26468c` | 落後 upstream 16 commits |
| `upstream/main` | — | `c30bd62` | 最新 upstream |
| `feature/myclaw` | `f26468c` | `25c2351` | 個人部署 (22 commits) |
| `feature/customization` | `f26468c` | `755a93d` | 共享 skills (8 commits above main) |

### myclaw 客製化功能清單

| 功能 | 涉及檔案 | 說明 |
|------|----------|------|
| Telegram Bot | `src/index.ts`, `src/telegram-auth.ts` | grammy long polling，取代 WhatsApp |
| Single-user mode | `src/index.ts`, `src/config.ts`, `src/db.ts`, `src/types.ts`, `src/container-runner.ts`, `src/task-scheduler.ts`, `src/mount-security.ts` | OWNER_CHAT_JID，移除 multi-group |
| AgentBrain | `AgentBrain/` submodule, `src/container-runner.ts`, `container/agent-runner/src/index.ts` | Memory vault + personality 掛載 |
| AGENT_MODEL | `src/config.ts`, `src/container-runner.ts`, `container/agent-runner/src/index.ts` | Runtime model selection |
| Detailed logs | `src/container-runner.ts`, `src/index.ts` | Request/response in container logs |
| System prompt | `container/agent-runner/src/index.ts` | 優化 system prompt |
| Container IPC MCP | `container/agent-runner/src/ipc-mcp.ts` | Single-user 簡化（移除 register_group 等） |

### upstream 新增功能

| 功能 | 關鍵 Commit | 要採用？ |
|------|-------------|----------|
| Streaming Container | `6f02ee5` | ✅ 採用 — 多輪對話免重啟 |
| Channel 抽象化 | `2b56fec` | ✅ 採用 — 用 TelegramChannel 實作 |
| IPC 模組抽出 | `2b56fec` | ✅ 採用 — `src/ipc.ts` |
| Router 模組抽出 | `2b56fec` | ✅ 採用 — `src/router.ts` |
| ipc-mcp-stdio | `6f02ee5` | ✅ 採用 — 取代 ipc-mcp.ts |
| Claude native memory | `b3f5814` | ❌ 不採用 — 所有記憶由 AgentBrain 管理（見下方說明） |
| Timeout bug fix | `8eb80d4` | ✅ 採用 |
| Apple Container networking | `a354997` | ✅ 採用（文件） |
| Agent Teams | `6f02ee5` | ✅ 採用 — 啟用 subagent 能力（Task/TeamCreate），不啟用 Swarm 多 bot 身份 |
| WhatsApp 改進 | `acdc645` | ❌ 不需要（已改用 Telegram） |
| WhatsApp 測試 | `6863c0b` | ❌ 不需要 |
| requiresTrigger IPC fix | `b5a6757` | ❌ Single-user 不需要 trigger |
| 簡體中文 README | `c30bd62`, `abc1c06` | ❌ 不需要，merge 後移除 |

---

## Phase 0: 準備工作

### 0-1: 同步 main

```bash
git checkout main
git merge upstream/main --ff-only
```

`main` 從 `f26468c` → `c30bd62`。

### 0-2: 從 myclaw 移除 add-heptabase merge

heptabase skill 尚未 apply（沒有對應的 code change），移除後減少整合時的噪音。未來需要時再從 `customization-v2` cherry-pick。

```bash
git checkout feature/myclaw
# HEAD=25c2351 (docs), parent=09b945d (heptabase merge)
# 移除 heptabase merge，保留 docs commit
git reset --hard HEAD~2          # 回到 800e312 (AGENT_MODEL)
git cherry-pick 25c2351          # 重新套用 docs commit
```

結果：myclaw HEAD 變為新的 commit（docs: update claude.md），不含 heptabase merge。

---

## Phase 1: Upstream 整合

### 1-1: 開整合 branch

```bash
git checkout feature/myclaw
git checkout -b feature/upstream-integration
```

### 1-2: Merge upstream (via main)

```bash
git merge main -m "feat: merge upstream (streaming container, channel abstraction, modular architecture)"
```

### Commit 策略

步驟 1-3 到 1-7 都在 `feature/upstream-integration` branch 上操作。建議每個邏輯步驟各自一個 commit：

1. `git merge main` → 解衝突 → `git commit`（merge commit）
2. 建立 TelegramChannel → `git commit -m "feat: implement TelegramChannel"`
3. Single-user 簡化 → `git commit -m "feat: apply single-user simplification"`
4. AgentBrain + AGENT_MODEL + detailed logs → `git commit -m "feat: re-apply AgentBrain, AGENT_MODEL, detailed logs"`
5. 移除不需要的功能 → `git commit -m "chore: remove WhatsApp, Chinese README, disable native memory"`

這樣每步可獨立 review 和 revert，而不是一個巨大的 merge commit。

### 1-3: 預期衝突與處理策略

Merge 會在以下檔案產生衝突。每個衝突的處理策略：

#### `src/index.ts` — 衝突最大

| myclaw 改了 | upstream 改了 | 策略 |
|-------------|---------------|------|
| Telegram bot (grammy) | Channel 抽象 + WhatsApp | **以 upstream 架構為基礎**，移除 WhatsApp，加入 TelegramChannel |
| Single-user (OWNER_CHAT_JID) | Multi-group (registeredGroups) | **重新在新架構上套用 single-user 簡化** |
| Monolithic message handler | Modular (ipc.ts, router.ts) | **採用 upstream 模組化架構** |
| — | Streaming container support | **採用** |
| — | Message piping to active container | **採用** |

**處理方式**：大部分取 upstream 版本，然後重新套用 single-user + Telegram 客製化。

#### `src/container-runner.ts`

| myclaw 改了 | upstream 改了 | 策略 |
|-------------|---------------|------|
| AgentBrain mount | Streaming output, onOutput callback | **採用 upstream streaming，重新加入 AgentBrain mount** |
| AGENT_MODEL env var | IDLE_TIMEOUT, 新 env vars | **兩邊都保留** |
| Detailed logs (append) | Marker-based output parsing | **在新 output protocol 上重新實作 detailed logs** |
| Single-user (OwnerConfig) | RegisteredGroup + isMain | **重新套用 single-user 簡化** |

#### `container/agent-runner/src/index.ts` — 架構差異大

| myclaw 改了 | upstream 改了 | 策略 |
|-------------|---------------|------|
| AgentBrain 掛載（`loadCoreMemory()` → `systemPrompt`）| Streaming query loop, MessageStream | **採用 upstream streaming，重新加入 AgentBrain** — `systemPrompt` 參數在 streaming 版本的 `runQuery()` 中同樣可用 ✅ |
| Volatile context 注入（`loadVolatileContext()` → prompt 前綴）| IPC message injection | **相容** — 在初始 prompt push 進 MessageStream 前 prepend volatile context ✅ |
| `outputFormat` (JSON schema: `outputType: 'message' \| 'log'`) | **移除 structured output** — 改用 plain text + `<internal>` tag | ⚠️ **不相容** — 需要遷移 output 處理邏輯（見下方說明） |
| AGENT_MODEL env var | Agent Teams tools (Task, TeamCreate 等) | **兩邊都保留** |
| System prompt 優化 | Additional directories, skills sync | **合併 system prompt + upstream 新功能** |

**Output 處理遷移**：

myclaw 目前用 structured output 區分是否發送給用戶：
```typescript
// myclaw: agent 回傳 JSON
{ outputType: 'message', userMessage: '回覆內容' }  // → 發送到 Telegram
{ outputType: 'log', internalLog: '內部記錄' }       // → 只記 log
```

upstream 移除了 `outputFormat`，改為：
```typescript
// upstream: agent 回傳 plain text
result: '回覆內容'              // → 發送到 Telegram
result: '<internal>思考過程</internal>'  // → 過濾掉，不發送
```

**遷移方式**：
1. 移除 `AGENT_RESPONSE_SCHEMA` 和 `outputFormat` option
2. `<internal>` tag 過濾已內建於 upstream `src/router.ts` 的 `formatOutbound()` — 不需額外實作
3. 更新 `groups/main/CLAUDE.md` 指導 agent 用 `<internal>` tag 包裹不需發送的內容
4. 排程任務的 output 處理也需配合更新（upstream 排程任務也會發送 output 到用戶）

#### `container/agent-runner/src/ipc-mcp.ts` vs `ipc-mcp-stdio.ts`

myclaw 有修改過的 `ipc-mcp.ts`，upstream 刪了 `ipc-mcp.ts` 改用 `ipc-mcp-stdio.ts`。

**策略**：採用 upstream 的 `ipc-mcp-stdio.ts`，在其上套用 single-user 簡化（移除 register_group、移除 target_group_jid）。

#### `src/config.ts`

合併兩邊新增的 config。取 upstream 的 `IDLE_TIMEOUT`、`CONTAINER_MAX_OUTPUT_SIZE`，保留 myclaw 的 `OWNER_CHAT_JID`、`AGENT_MODEL`、`AGENTBRAIN_DIR`。

#### `src/db.ts`

myclaw 移除了大量 multi-group 函數，upstream 新增了 migration。**以 upstream 為基礎**，重新移除 multi-group 函數。

#### `src/types.ts`

upstream 新增 `Channel` interface。myclaw 的 `OwnerConfig` 繼續使用（single-user 需要）。合併兩邊。

#### `src/group-queue.ts`

upstream 新增 `sendMessage()`、`closeStdin()`（streaming 支援）。myclaw 改動不大。**採用 upstream 版本**。

#### 其他檔案

| 檔案 | 策略 |
|------|------|
| `src/task-scheduler.ts` | upstream 為基礎 + single-user 簡化 |
| `src/mount-security.ts` | upstream 為基礎 + single-user 簡化 |
| `container/build.sh` | 合併 |
| `container/Dockerfile` | upstream 為基礎 |
| `CLAUDE.md` | myclaw 版本（已更新） |
| `groups/main/CLAUDE.md` | myclaw 版本 |
| `package.json` | upstream（可能需要加 grammy） |

### 1-4: 建立 TelegramChannel

upstream 提供了 `Channel` interface 和 `WhatsAppChannel` 實作。需要新建 `src/channels/telegram.ts` 實作 `TelegramChannel`：

```typescript
// src/channels/telegram.ts
export class TelegramChannel implements Channel {
  name = 'telegram';
  prefixAssistantName = false; // Telegram bot 自帶名稱顯示

  constructor(token: string, callbacks: {...}) { ... }

  async connect() { /* bot.start() long polling */ }
  async sendMessage(jid, text) { /* bot.api.sendMessage, 4096 split */ }
  isConnected() { ... }
  ownsJid(jid) { return true; } // Single-user: 所有 JID 都是我的
  async disconnect() { /* bot.stop() */ }
  async setTyping(jid) { /* sendChatAction('typing'), 4.5s timer */ }
}
```

**遷移來源**：從 myclaw 的 `src/index.ts` 中提取 grammy 相關邏輯，重構為 Channel 實作。

### 1-5: 重新套用 Single-user 簡化

在 upstream 模組化架構上重新套用 single-user：

- **`src/index.ts`**：移除 `registeredGroups` map、`registerGroup()`、`syncGroupMetadata()`、trigger pattern 檢查。用 `OWNER_CHAT_JID` 取代。
- **`src/ipc.ts`**：移除 multi-group directory scanning、authorization checks。只掃 `data/ipc/main/`。移除 `register_group`、`refresh_groups` IPC 處理。修正 send_message 路徑的前綴邏輯（upstream 硬編碼 `ASSISTANT_NAME:` 前綴，但 Telegram `prefixAssistantName=false`，需改為透過 `formatOutbound()` 處理，或移除硬編碼前綴）。
- **`src/router.ts`**：簡化 — 不需要 multi-channel routing（只有一個 channel）。
- **`src/db.ts`**：移除 `registered_groups` 相關函數。
- **`container/agent-runner/src/ipc-mcp-stdio.ts`**：移除 `register_group` tool、`target_group_jid` param、`sender` param。

### 1-6: 重新套用其他客製化

| 功能 | 操作 |
|------|------|
| AgentBrain mount | 在新 `buildVolumeMounts()` 中加入 AgentBrain vault mount (`/workspace/brain`) |
| AgentBrain system prompt | 在 `runQuery()` 中將 `loadCoreMemory()` 結果作為 `systemPrompt` 注入（**與 streaming 相容**） |
| AgentBrain volatile context | 在初始 prompt push 進 MessageStream 前 prepend `loadVolatileContext()`（**與 streaming 相容**） |
| AGENT_MODEL | 在新 `config.ts` 和 `buildContainerArgs()` 中加入 |
| Detailed logs | 在新 streaming output 的 `onOutput` callback 中實作（每次收到 output marker 時 append to log file） |
| Output 處理遷移 | 移除 `outputFormat` JSON schema，改用 plain text + `<internal>` tag 過濾 |

### 1-7: 移除不需要的 upstream 功能

| 移除項 | 操作 |
|--------|------|
| `src/channels/whatsapp.ts` | 刪除整個檔案 |
| `src/whatsapp-auth.ts` | 刪除（myclaw 已無此檔） |
| WhatsApp 測試 | 刪除 `src/channels/whatsapp.test.ts` |
| Bot pool / Swarm config | 不加入 `TELEGRAM_BOT_POOL` 相關 config（Agent Swarm 多 bot 身份功能不需要） |
| Claude native memory | 在 `settings.json` 中設定 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（禁用），所有記憶由 AgentBrain 管理 |
| 簡體中文 README | 刪除 `README_zh.md` |

**保留並啟用的 upstream 功能**：
- **Agent Teams** (subagent)：`allowedTools` 包含 `Task`、`TaskOutput`、`TaskStop`、`TeamCreate`、`TeamDelete`、`SendMessage` — 讓 agent 能派生子任務平行處理
- **`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`**：在 `settings.json` 中啟用
- **`CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`**：讓 agent 讀取額外掛載目錄的 CLAUDE.md（如 AgentBrain）

### 1-8: 確認 build 和測試

注意：`container/agent-runner/package.json` 需確認已包含 upstream 新增依賴（`@modelcontextprotocol/sdk`、`zod`、`cron-parser`），這些是 `ipc-mcp-stdio.ts` 所需。

```bash
npm run build              # Host TypeScript 編譯
npm run typecheck           # 確認型別正確
cd container && npm install && npm run build && cd ..  # Agent-runner 安裝依賴 + 編譯
./container/build.sh        # Docker image rebuild
```

### 1-9: Merge 回 myclaw

```bash
git checkout feature/myclaw
git merge feature/upstream-integration --no-ff -m "feat: upgrade to upstream streaming architecture"
```

### 1-10: 功能驗證

1. 啟動服務：`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
2. 發送測試訊息到 Telegram bot — 確認收到回覆
3. 確認 streaming 模式運作：container 回覆後不會立即退出（`docker ps` 或 `container list` 應顯示仍在運行）
4. 確認多輪對話：在 idle timeout 內再發訊息，應 pipe 到同一 container（logs 不應顯示 "Spawning container"）
5. 確認排程任務正常：透過 bot 建立 "remind me in 1 minute to test"
6. 確認 AgentBrain mount：檢查 container log 中 `Core memory loaded: N chars`（N > 0 表示成功讀取 vault）
7. 確認 IPC send_message：agent 主動發訊息時，Telegram 收到的訊息不應有重複的 assistant name 前綴
8. 檢查 logs：`tail -f logs/nanoclaw.log`

---

## Phase 2: Skills 升級

### 2-1: 建立 customization-v2

```bash
git checkout main                          # 已同步至 c30bd62
git checkout -b feature/customization-v2
git merge feature/customization --no-ff -m "Merge existing skills from feature/customization"
```

這會帶入所有現有 skills，base 在新 upstream 之上。

### 2-2: 逐一升級 Skills

每個 skill 各自一個 commit。需要更新的項目：

#### `/migrate-to-telegram` → 大幅更新

舊版指導在 monolithic `index.ts` 中加入 grammy。新版需要：
- 改為建立 `src/channels/telegram.ts` (Channel interface)
- 更新 `index.ts` 的 import/wiring（模組化架構）
- 加入 streaming container 相關配置
- 移除 `src/whatsapp-auth.ts` 步驟（upstream 可能已無此檔或不同位置）

```bash
git commit -m "feat: update migrate-to-telegram skill for streaming architecture"
```

#### `/single-user-mode` → 大幅更新

舊版針對 monolithic 架構。新版需要：
- 更新 `src/index.ts` 的簡化步驟（模組化架構，index 更薄）
- 新增 `src/ipc.ts` 簡化步驟
- 新增 `src/router.ts` 簡化步驟
- 更新 `container/agent-runner/src/ipc-mcp-stdio.ts`（取代 `ipc-mcp.ts`）
- 移除 `src/channels/whatsapp.ts` 步驟
- 保留 streaming container 相關功能

```bash
git commit -m "feat: update single-user-mode skill for modular architecture"
```

#### `/set-default-model` → 輕微更新

核心邏輯不變（env var passthrough）。只需要：
- 確認 `src/config.ts` 的程式碼片段與新版吻合
- 確認 `container/agent-runner/src/index.ts` 的 query() 位置

```bash
git commit -m "feat: update set-default-model skill for streaming architecture"
```

#### `/add-heptabase` → 輕微更新

- `container-runner.ts` 的 mount 位置可能改變
- `agent-runner/src/index.ts` 的 MCP config 改為 `ipc-mcp-stdio.ts` 架構

```bash
git commit -m "feat: update add-heptabase skill for streaming architecture"
```

#### `/add-memory`, `/add-personality` → 中度更新

- `container-runner.ts` 的 volume mount 更新
- `agent-runner/src/index.ts` 的 system prompt 注入位置更新（`runQuery()` 中的 `systemPrompt` 參數）
- 確保 `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（禁用 native memory，由 AgentBrain 管理所有記憶）

```bash
git commit -m "feat: update add-memory skill for streaming architecture"
git commit -m "feat: update add-personality skill for streaming architecture"
```

#### `/detailed-logs`, `/server-migration` → 中度更新

- Detailed logs：streaming output 改變了 log 寫入時機（`onOutput` callback vs 一次性寫入）
- Server migration：路徑和服務管理不變，但需要更新檔案清單

```bash
git commit -m "feat: update detailed-logs skill for streaming architecture"
git commit -m "feat: update server-migration skill for streaming architecture"
```

#### 其他 skills（`/setup`, `/debug`, `/customize`, `/add-gmail`, `/x-integration`）

這些 skill 來自 upstream 原有的。upstream merge 會帶入最新版本。如果有需要可以在 `customization-v2` 上微調，但通常不需要。

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

**與舊流程的差異**：

| | 舊流程 | 新流程 |
|--|--------|--------|
| 取得 skill | `git merge --no-ff` | `git cherry-pick` |
| Merge commit | 有（保留來源紀錄） | 無（扁平 commit） |
| 歷史可追溯性 | merge commit 明確顯示 skill 來自 customization | commit message 標註來源即可 |
| 操作簡單度 | 需要 `--no-ff` flag | 直接 cherry-pick |

> 選擇 cherry-pick 的原因：`customization-v2` 和 `myclaw` 共享同一個 upstream base，cherry-pick 不會帶入額外差異。如果偏好保留 merge 痕跡，也可以繼續用 `merge --no-ff`。

---

## Phase 3: 收尾

### 3-1: 更新 CLAUDE.md

- Branch Strategy 加入 `feature/customization-v2`
- 更新 Architecture Overview 反映 streaming + channel abstraction
- 更新 Key Files table
- 更新 Container Agent Configuration

### 3-2: 更新 MEMORY.md

- 新增 streaming architecture 相關筆記
- 更新 Key Patterns（新 output protocol、idle timeout）

### 3-3: Push customization-v2 到 origin

```bash
git push origin feature/customization-v2
```

`feature/customization` 保留不刪（歷史參考），未來所有新 skill 在 `customization-v2` 開發。

### 3-4: 可選清理

- 確認 `feature/myclaw` 正常後，可以刪除 `feature/mysetting`（已被 myclaw 取代）
- 確認 `customization-v2` 正常後，`feature/customization` 可以 archive

---

## 執行順序與預估工作量

| Phase | 步驟 | 說明 | 複雜度 |
|-------|------|------|--------|
| 0 | 0-1 | Sync main | 簡單 |
| 0 | 0-2 | 移除 heptabase merge | 簡單 |
| 1 | 1-1 ~ 1-2 | 開 branch + merge | 簡單 |
| 1 | 1-3 | **解衝突** | ⚠️ 高 — `index.ts`、`container-runner.ts`、`agent-runner` |
| 1 | 1-4 | 建立 TelegramChannel | 中 — 從 myclaw 提取重構 |
| 1 | 1-5 | 重新套用 single-user | 中 — 在新架構上重做 |
| 1 | 1-6 | 重新套用 AgentBrain 等 | 低 — mount + env 調整 |
| 1 | 1-7 | 移除不需要的功能 | 低 — 刪除檔案 |
| 1 | 1-8 | Build + typecheck | 低 |
| 1 | 1-9 | Merge 回 myclaw | 簡單 |
| 1 | 1-10 | 驗證 | 中 |
| 2 | 2-1 | 建立 customization-v2 | 簡單 |
| 2 | 2-2 | 升級各 skill | 中 — 需要逐一更新內容 |
| 3 | 3-1 ~ 3-4 | 收尾 | 低 |

**整體風險**：Phase 1 的衝突解決是最大挑戰。`src/index.ts` 兩邊改動完全不同（myclaw 簡化、upstream 模組化），無法自動 merge，需要手動逐段處理。建議在解衝突前先通讀 upstream 的 `index.ts`、`ipc.ts`、`router.ts` 完整理解新架構。

---

## 可行性評估

此計畫 **可行**。以下是對原始提議的調整：

1. ✅ **Phase 0-2**（移除 heptabase）— 完全可行
2. ✅ **Phase 1**（upstream 整合）— 可行但工作量最大
   - 2-1 ✅ 從 myclaw 開 branch
   - 2-2 ✅ merge + 解衝突 + 移除不需要的功能
   - 2-3 ✅ refactor 客製化功能（TelegramChannel、streaming logs）
   - 2-4 ✅ merge 回 myclaw
3. ✅ **Phase 2**（skills 升級）— 可行
   - 3-1 ✅ 從 main 開 customization-v2
   - 3-2 ✅ merge 原 customization
   - 3-3 ✅ 逐一升級 skills
   - 3-4 ✅ 未來用 cherry-pick

**唯一調整**：原方案 3-4 提議用 cherry-pick 取代 merge --no-ff。兩者皆可行，cherry-pick 更簡潔，merge --no-ff 保留更多歷史。計畫中兩者都說明了，可依偏好選擇。
