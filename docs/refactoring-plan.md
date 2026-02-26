# Refactoring Plan

## Overview

隨著功能迭代，部分模組已經變成 god file，也累積了一些 dead code 和重複邏輯。
本計畫按優先級整理，目標是改善可讀性和維護性，不改變任何外部行為。

---

## High Priority — 拆分過大模組

### H1. 拆分 `container/agent-runner/src/index.ts` (834 行)

目前是 god file，混合了 AgentBrain 載入、transcript 歸檔、IPC polling、session 管理、query 迴圈。

**拆分方案：**

| 新檔案 | 職責 | 從 index.ts 搬出的函式 |
|--------|------|----------------------|
| `memory.ts` | AgentBrain 載入 | `loadCoreMemory()`, `loadVolatileContext()`, `resolveSessionAge()` |
| `transcript.ts` | Transcript 歸檔與格式化 | `formatTranscriptMarkdown()`, `archiveTranscript()`, PreCompact hook logic |
| `output.ts` | 輸出處理 | `wrappedOnOutput()`, OUTPUT marker 解析邏輯 |
| `index.ts` | 精簡為入口 | `main()`, `runQuery()` (呼叫上述模組), IPC input polling |

`runQuery` (190 行) 內的 assistant-message logging block 抽成 helper。

### H2. 精簡 `src/container-runner.ts` (540 行)

- 搬 `writeTasksSnapshot()` 到 `src/task-utils.ts`，並讓它直接接受 `ScheduledTask[]`（內部做 mapping），消除 `index.ts` 和 `task-scheduler.ts` 兩處的重複 mapping boilerplate
- `buildVolumeMounts()` 內的 filesystem setup（`mkdirSync` 等）考慮抽成 `ensureWorkspaceDirs()` helper

### H3. 抽出 schedule 計算共用邏輯

`nextRun` 計算邏輯重複出現在三處：
- `src/ipc.ts:122-155`
- `src/task-scheduler.ts:134-143`
- `container/agent-runner/src/ipc-mcp-stdio.ts:97-122`（驗證部分）

**注意：`src/` 與 `container/` 是獨立部署單元，不能共用模組。**

- `src/` 側：抽出 `src/schedule-utils.ts`，統一 `computeNextRun(scheduleType, scheduleValue, timezone): string`，供 `ipc.ts` 和 `task-scheduler.ts` 使用
- `container/` 側：`ipc-mcp-stdio.ts` 內的驗證邏輯保留原地，但整理為獨立函式以提升可讀性（不跨邊界共用）

---

## Medium Priority — 清除 dead code 與重複

### M1. 刪除 dead code

| 位置 | 內容 |
|------|------|
| `src/db.ts:67-75` | `registered_groups` 表 — 多群組時代遺留，從未使用 |
| `src/db.ts:207` | `getNewMessages()` — 已匯出但從未被 import |
| `src/db.ts:285` | `getTasksForGroup()` — 已匯出但從未被 import |
| `src/db.ts:433-473` | `migrateJsonState()` — 遷移舊版 JSON 檔，已無實際作用 |
| `src/router.ts:44-59` | `routeOutbound()`, `findChannel()` — 多頻道抽象，從未接入 |
| `src/index.ts:35-36` | 標註 "backwards compatibility during refactor" 的 re-export — 無人 import |

### M2. 共用 logger

`src/mount-security.ts:16-19` 自建了一個獨立的 pino instance，應改用 `src/logger.ts` 的共用 logger。

### M3. 抽出 idle timer factory

`src/index.ts:99-107` 和 `src/task-scheduler.ts:72-79` 的 idle timer 邏輯幾乎一樣。
抽成 `createIdleTimer(queue, chatJid, timeout): { reset, clear }` 放在 `src/group-queue.ts` 或新建 `src/timer-utils.ts`。

---

## Low Priority — 修正與一致性

### L1. 修正 hardcoded assistant name (bug)

`container/agent-runner/src/index.ts:276` 寫死了 `'Andy'`，應改用 `process.env.ASSISTANT_NAME || 'Cal'`。

### L2. db.ts schema 與 migration 分離

目前 `createSchema()` 混合了建表和 migration。考慮分成：
- `createSchema()` — 只做 CREATE TABLE IF NOT EXISTS
- `runMigrations()` — ALTER TABLE、schema evolution

### L3. 統一 env 讀取方式

`src/config.ts` 用 `readEnvFile()` 讀部分變數，但 `telegram.ts` 直接讀 `process.env.TELEGRAM_BOT_TOKEN`。考慮統一策略（都在 config.ts 集中讀取並匯出）。

---

## Test Refactoring — source code 重構完成後執行

### T1. 建立 `tests/test-helpers.ts` 共用測試基礎設施

目前四個測試檔各自重複定義相同的 mock 和 factory，應集中管理：

| 共用項目 | 重複出現位置 | 說明 |
|----------|-------------|------|
| Config mock | 全部 4 個測試檔 | 結構相同但值略有不同，改為 `mockConfig(overrides?)` factory |
| fs mock | message-pipeline, group-queue, session-reset | 幾乎一樣，抽成 `mockFs()` |
| Logger mock | message-pipeline, session-reset, media-attachment | 完全一樣，抽成 `mockLogger()` |
| `makeMessage()` | message-pipeline, media-attachment | media-attachment 版是 superset，統一為一個含 optional attachments 的版本 |
| Test constants | message-pipeline, media-attachment | `CHAT_JID`, `BOT_NAME` 等重複定義 |
| DB setup | message-pipeline, media-attachment, session-reset | `_initTestDatabase()` + `storeChatMetadata()` pattern 重複 |

### T2. 更新 `vitest.config.ts`

加入 `setupFiles: ['tests/setup.ts']` 自動載入共用 mock，減少每個測試檔的 boilerplate。

### T3. 讓 `wrappedOnOutput` 可獨立測試

`session-reset.test.ts` 手動重寫了 `createWrappedOnOutput()` 來模擬 `src/index.ts` 的邏輯。
若 index.ts 改了，測試不會察覺。應從 index.ts export 真正的 wrapping 邏輯，測試直接引用。

（此項與 H1/H2 的 source refactor 有關 — 拆分後自然會產生可獨立 import 的函式。）

### T4. 拆分過大的測試案例

`message-pipeline.test.ts` 部分測試同時驗證 prompt 組裝 + response 處理，應拆成獨立案例：
- prompt composition（XML 格式、多訊息 batching、bot 訊息過濾）
- response handling（sendMessage 呼叫、錯誤處理）

---

## 不在本次範圍

- 功能變更或新功能
- container Dockerfile 變更

## 執行進度

**Phase 1 — Source code refactoring：**

| # | 項目 | 狀態 | 備註 |
|---|------|------|------|
| 1 | M1 (dead code) | ✅ 完成 | 刪除 registered_groups, getNewMessages, getTasksForGroup, migrateJsonState, routeOutbound/findChannel, backwards-compat re-export |
| 2 | L1 (bug fix) | ✅ 完成 | 加入 assistantName 到 ContainerInput，修正 hardcoded 'Andy'，thread through formatTranscriptMarkdown/createPreCompactHook |
| 3 | H3 (schedule-utils) | ✅ 完成 | 新建 src/schedule-utils.ts；container 側整理為 validateScheduleValue() |
| 4 | H2 (container-runner 精簡) | ✅ 完成 | writeTasksSnapshot 搬到 src/task-utils.ts，直接接受 ScheduledTask[] |
| 5 | M2+M3 (logger, idle timer) | ✅ 完成 | mount-security 改用共用 logger；新建 src/idle-timer.ts |
| 6 | H1 (agent-runner 拆分) | ✅ 完成 | 拆成 logging, types, memory, transcript, hooks, ipc-input 六個模組 |
| 7 | L2+L3 (schema, env) | ✅ 完成 | createSchema/runMigrations 分離；TELEGRAM_BOT_TOKEN 集中到 config.ts |

**Phase 2 — Test refactoring：**

| # | 項目 | 狀態 | 備註 |
|---|------|------|------|
| 8 | T1 (test-helpers) | ✅ 完成 | 建立 tests/test-helpers.ts；四個測試檔全部改用共用 helpers |
| 9 | T2 (vitest setupFiles) | ⏭️ 跳過 | vi.mock 必須在每個檔案內呼叫（hoisting 限制），setupFiles 無法取代 |
| 10 | T3 (wrappedOnOutput export) | ⏭️ 跳過 | 需修改 src/index.ts 匯出結構，風險大於收益，留待後續需求驅動 |
| 11 | T4 (拆分測試案例) | ⏭️ 跳過 | 目前測試結構清晰，無迫切需要 |

所有項目執行後皆通過 32/32 測試。
