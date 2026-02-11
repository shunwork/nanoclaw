# AgentBrain 設計提案

> Session + Context 混合模式，Obsidian Vault 架構，Agent 全權管理記憶、知識、人格

---

## 設計哲學

### 核心原則

1. **Session + Context 混合**：保留 session resume 提供 tool call continuity，搭配 AgentBrain vault 提供跨 session 持久記憶。Agent 可自主決定何時 reset session。
2. **檔案是持久記憶的唯一來源**：所有需要跨 session 存活的知識都在 AgentBrain vault 中，以 Obsidian 相容 markdown 儲存。
3. **Agent 全權管理**：AgentBrain vault 整體 mount 給 agent，agent 透過 skills 定義的規範自主讀寫，包括人格和使用者 profile 的演進。
4. **人機共讀**：所有檔案可用 Obsidian 直接開啟瀏覽、編輯，使用者隨時可以介入。
5. **演進有節制**：人格與使用者 profile 的演進只在反思階段發生，避免 agent 過度適應單次對話的雜訊。演進由 agent 自主完成，不需使用者確認。
6. **所有檔案有容量意識**：Vault 中的每種檔案都有容量上限，防止任何單一檔案無限增長。反思階段負責整體容量管控——新增內容時同時審視舊內容，合併、精簡、淘汰過時資訊。時效性資料（daily log、evolution 記錄）超過保留期限後歸檔。
7. **Skills-first**：所有新功能以 skill 形式加入，操作邏輯封裝在 skill 中，CLAUDE.md 保持精簡。

---

## 架構總覽

### 系統層級

```
使用者 (Telegram)
    ↕
Host Process (src/index.ts)
    ├── SQLite (messages, tasks, sessions)
    ├── Session 管理 (resume / reset)
    └── Container Agent
            ├── Agent SDK (query, session resume)
            ├── groups/main/CLAUDE.md (操作指令)
            ├── groups/main/.claude/skills/ (技能定義)
            └── AgentBrain/ (Obsidian vault, 記憶+知識+人格)
```

### AgentBrain Vault 結構

```
AgentBrain/                       ← 獨立 Obsidian vault，mount 給 agent 全權管理
├── index.md                      ← Agent 記憶操作規範（vault 的 README）
│
├── agentmind/                    ← Agent 人格
│   ├── soul.md                   ← 行為哲學、核心價值、反模式
│   ├── identity.md               ← 對外形象、溝通風格、名稱
│   └── evolution/                ← 人格演進記錄（保留 60 天）
│       ├── YYYY-MM-DD-<topic>.md
│       └── archive/              ← 超過 60 天的記錄歸檔
│
├── memory/                       ← Agent 記憶
│   ├── user.md                   ← 使用者 profile：偏好、背景、習慣
│   ├── tool.md                   ← 工具知識：使用經驗、踩過的坑、最佳實踐
│   ├── context.md                ← 當前工作上下文：進行中/準備進行的事項
│   ├── memory.md                 ← 長期記憶：從每日日誌固化的重要知識
│   └── daily/                    ← 每日日誌（append-only，保留 60 天）
│       ├── YYYY-MM-DD.md
│       └── archive/              ← 超過 60 天的日誌歸檔
│
├── knowledge/                    ← 知識庫
│   ├── {topic}.md                ← 主題筆記
│   ├── {entity}.md               ← 實體筆記（人、組織、工具、概念）
│   └── moc_{topic}.md            ← Map of Content 索引
│
└── .obsidian/                    ← Obsidian 設定（可選，人類瀏覽用）
```

### Container Mount 變更

| Container 路徑 | Host 路徑 | 存取權限 | 說明 |
|----------------|-----------|---------|------|
| `/workspace/project` | 專案根目錄 | read-write | 不變 |
| `/workspace/group` | `groups/main/` | read-write | 不變（CLAUDE.md + skills） |
| `/workspace/brain` | `AgentBrain/` | **read-write** | **新增：Agent 記憶+知識+人格** |
| `/home/node/.claude` | `data/sessions/main/.claude/` | read-write | 不變（session 資料） |
| `/workspace/ipc` | `data/ipc/main/` | read-write | 不變 |

### Skills 結構（容器 Agent 使用）

```
groups/main/.claude/skills/
├── obsidian-markdown/            ← kepano 官方：Markdown 讀寫規範
├── obsidian-bases/               ← kepano 官方：結構化查詢
├── agentbrain-manage/            ← 自訂：AgentBrain 總管理（啟動載入、反思觸發）
├── memory-manage/                ← 自訂：記憶管理（日誌、context、長期記憶）
├── knowledge-manage/             ← 自訂：知識庫管理（建立/更新知識、MOC 維護）
└── agentmind-manage/             ← 自訂：人格管理（演進、反思中的人格更新）
```

---

## Part 1：記憶模組

### 1.1 記憶檔案規格

#### `memory/user.md` — 使用者 Profile

記錄使用者的身份、偏好、背景知識。Agent 在反思階段自主更新。

```markdown
---
type: user
updated: 2026-02-11
---

# 使用者

## 身份
<!-- 姓名、角色、工作領域 -->

## 偏好
- 語言：繁體中文
- 回覆風格：精簡、技術導向
- 不喜歡的：冗長解釋、客套寒暄

## 技術背景
<!-- Agent 應假設使用者已知的技術 -->

## 溝通習慣
<!-- 從互動中觀察到的模式，反思階段更新 -->
```

**讀寫規則**：
- 讀取：每次 agent 啟動時自動載入
- 寫入：**僅在反思階段**自主更新（防止單次對話的雜訊被過度捕捉）
- 使用者可隨時手動編輯（Obsidian 或直接修改檔案）

#### `memory/tool.md` — 工具知識

記錄 agent 使用各種工具的經驗和最佳實踐。

```markdown
---
type: tool
updated: 2026-02-11
---

# 工具知識

## agent-browser
- 開啟頁面後先 `snapshot -i` 查看互動元素
- 某些網站需要等待 JS 載入完成
- Cookie consent 彈窗需要先處理

## Bash
- 容器內路徑：/workspace/group, /workspace/brain, /workspace/project
- SQLite 資料庫在 /workspace/project/store/messages.db

## WebSearch
- 搜尋繁體中文內容時加上「繁體」或直接用中文關鍵字
- 技術搜尋使用英文效果較佳
```

**讀寫規則**：
- 讀取：每次 agent 啟動時自動載入
- 寫入：對話中遇到工具使用的新發現時即時更新（不需等反思）
- 工具知識是純客觀的經驗紀錄，不涉及主觀判斷，因此不受反思限制

#### `memory/context.md` — 當前工作上下文

記錄進行中和準備進行的事項。Agent 在每次對話結束時更新。

```markdown
---
type: context
updated: 2026-02-11T14:30:00
---

# 當前上下文

## 進行中
- 實作 AgentBrain 記憶模組 — 正在設計 skill 結構
- 研究 [[Obsidian Plugin API]] 的限制

## 準備進行
- 設定 X 整合
- 整理 NanoClaw 文件

## 待跟進
- 確認 agent-browser 的 headless 模式是否支援新版 Chrome — 來源：[[2026-02-10]]
```

**讀寫規則**：
- 讀取：每次 agent 啟動時自動載入
- 寫入：每次對話結束時，如果工作上下文有變化就更新
- 這是 agent 的「工作記事板」，自由讀寫

#### `memory/memory.md` — 長期記憶

從每日日誌中固化的重要知識。反思階段整理，有容量上限意識。

```markdown
---
type: memory
updated: 2026-02-11
---

# 長期記憶

## 重要事實
- NanoClaw 從 WhatsApp 遷移到 Telegram (2026-02)
- AgentBrain vault 採用 Session + Context 混合模式

## 經驗教訓
- Container 內 IPv6 不穩定，Telegram API 需強制 IPv4
- Session transcript 是最大的 context 消耗來源，需要控制

## 未解決的問題
- 長期使用後 daily/ 的清理策略
- Vector search 是否值得引入
```

**讀寫規則**：
- 讀取：每次 agent 啟動時自動載入
- 寫入：**僅在反思階段**，從 daily/ 日誌中提取重點固化
- **容量控制**：memory.md 不可無限增長。每次反思新增記憶時，同時審視現有內容：
  - 過時的事實 → 移除或更新
  - 重複或相似的條目 → 合併精簡
  - 已解決的「未解決問題」→ 移至「經驗教訓」或移除
  - 目標：維持在 ~150-200 行以內，確保每條記憶都有當下的參考價值

#### `memory/daily/YYYY-MM-DD.md` — 每日日誌

每天一個檔案，append-only 記錄每次對話的摘要。

```markdown
---
type: log
created: 2026-02-11
updated: 2026-02-11
---

# 2026-02-11

## 14:30 — AgentBrain 設計討論
**摘要**：討論了記憶與人格模組的架構設計。
**結論**：
- AgentBrain 作為獨立 Obsidian vault
- 人格演進限制在反思階段
- 知識庫使用 MOC + wiki-link 組織
**新建/更新**：[[NanoClaw]], [[Obsidian]]
**待跟進**：確認 obsidian 官方 skills 的最新版本

## 16:00 — X 整合測試
**摘要**：測試了 X 發文功能，發現 OAuth 需要重新配置。
**結論**：
- OAuth token 過期，需要重新授權
**待跟進**：重新設定 X OAuth
```

**讀寫規則**：
- 讀取：啟動時載入今天 + 昨天的日誌
- 寫入：每次對話結束時 append 摘要條目（即時寫入）
- Append-only，不修改已寫入的條目
- 反思階段會讀取近 7 天日誌來固化重點到 memory.md
- **保留期限**：60 天。超過 60 天的日誌在反思時移至 `daily/archive/`。歸檔日誌保留在 vault 中可用 Obsidian 瀏覽，但 agent 啟動時不載入、反思時不掃描

### 1.2 記憶生命週期

```
對話開始（Agent 啟動）
    │
    ├─ 自動載入 core memory：
    │   user.md, tool.md, context.md, memory.md
    │   + 今天/昨天的 daily log
    │
    ├─ 根據使用者訊息，按需搜尋 knowledge/
    │
    │   ── 對話進行中 ──
    │
    ├─ 即時更新：
    │   ├─ tool.md — 工具使用新發現
    │   └─ knowledge/ — 新知識（使用者提供或研究所得）
    │
    │   ── 對話結束 ──
    │
    ├─ 結束更新：
    │   ├─ daily/YYYY-MM-DD.md — append 對話摘要
    │   └─ context.md — 更新工作上下文（如有變化）
    │
    │   ── 反思階段（定期觸發）──
    │
    └─ 反思更新：
        ├─ memory.md — 從 daily/ 固化重點 + 審視舊記憶
        ├─ user.md — 更新使用者 profile（觀察到的穩定模式）
        ├─ knowledge/ — 整理知識庫（去重、補連結、更新 MOC）
        └─ agentmind/ — 人格演進（見 Part 3）
```

### 1.3 Session 混合模式

#### 基本模式：保留 Session Resume

- 預設行為與現在相同：session resume 提供 tool call continuity
- Session transcript 仍是短期工作記憶的主要載體
- AgentBrain 的 core memory 以 prompt prefix 注入，作為跨 session 的持久上下文

#### Agent 管理 Session Reset

Agent 透過 `agentbrain-manage` skill 中的指引，在以下情況自主決定 reset session：

**建議 reset 的時機：**
- 話題完全改變（例如從寫程式轉到討論行程）
- 感覺 context 開始混亂或包含過多不相關的工具呼叫歷史
- 使用者要求重新開始或清除歷史
- 長時間未互動後回來（session 中的上下文已過時）

**不建議 reset 的時機：**
- 正在進行多步驟任務（tool call continuity 很重要）
- 剛 reset 不久（避免頻繁 reset）

**機制**：Agent 呼叫 `new_session` MCP tool，host 端收到 IPC 後清除 session record，下次 invocation 自動建立新 session。

**使用者觸發方式**：使用者在 Telegram 中說「重新開始」「reset」等，agent 判斷意圖後呼叫 `new_session` MCP tool 執行 reset。不需要 host 端的特殊指令處理——所有 reset 都統一經由 agent 的 MCP tool 完成。

#### 與記憶的關係

Session reset 不影響 AgentBrain 中的任何檔案。Agent 的長期記憶、知識、人格在 reset 後完全保留——只有短期的工具呼叫歷史和對話細節會丟失。

```
Reset 前：
  Session transcript (10-50K tokens) + AgentBrain memory (8-14K tokens)

Reset 後：
  新 session (0 tokens) + AgentBrain memory (8-14K tokens，不變)
```

這確保了 reset 是安全的——agent 不會「失憶」，只是「清醒過來重新開始」。

### 1.4 `index.md` — AgentBrain 操作規範

AgentBrain vault 根目錄的 `index.md` 是 agent 的記憶操作手冊，定義 vault 的使用慣例：

```markdown
---
type: index
updated: 2026-02-11
---

# AgentBrain 操作規範

本 vault 是你（Cal）的記憶、知識與人格資料庫。你擁有完整的讀寫權限。

## Frontmatter 規格

每個 .md 檔必須有 YAML frontmatter，必填欄位：
- `type`：檔案類型（見類型表）
- `updated`：最後更新日期 YYYY-MM-DD

### 類型表
| type | 用途 | 位置 |
|------|------|------|
| user | 使用者 profile | memory/user.md |
| tool | 工具知識 | memory/tool.md |
| context | 工作上下文 | memory/context.md |
| memory | 長期記憶 | memory/memory.md |
| log | 每日日誌 | memory/daily/ |
| knowledge | 知識筆記 | knowledge/ |
| moc | Map of Content | knowledge/moc_*.md |
| soul | Agent 人格哲學 | agentmind/soul.md |
| identity | Agent 對外形象 | agentmind/identity.md |
| evolution | 人格演進記錄 | agentmind/evolution/ |

## 連結規則

- 知識筆記之間使用 `[[wiki-link]]` 互相連結
- 連結 heading 用 `[[筆記名#Heading]]`
- 新建筆記時更新相關筆記中的連結
- 每日日誌中引用知識筆記也使用 wiki-link

## 防重複

建立新知識筆記前，先搜尋 knowledge/ 是否已存在同主題筆記。
存在則更新，不新建。

## 記憶更新時機

| 檔案 | 何時讀 | 何時寫 | 限制 |
|------|--------|--------|------|
| user.md | 啟動時 | 反思階段 | 僅反思時更新，agent 自主決定 |
| tool.md | 啟動時 | 即時 | 工具經驗即時記錄 |
| context.md | 啟動時 | 對話結束 | 每次結束時更新 |
| memory.md | 啟動時 | 反思階段 | 僅反思時固化，同時審視舊記憶 |
| daily/ | 啟動時（今天+昨天） | 對話結束 | Append-only |
| knowledge/ | 按需搜尋 | 即時 | 搜尋後建立/更新 |
| soul.md | 啟動時 | 反思階段 | 僅反思時，immutable 段落不可修改 |
| identity.md | 啟動時 | 反思階段 | 僅反思時，agent 自主決定 |

## 容量控制

Vault 中每種檔案都有容量上限和超限策略，在反思階段統一管控。

### 容量上限表

| 檔案 | 上限 | 超限策略 |
|------|------|---------|
| memory.md | ~150-200 行 | 合併精簡、淘汰過時條目、細節下沉到 knowledge/ |
| user.md | ~60-80 行 | 合併相似偏好、精簡描述 |
| tool.md | ~80-120 行 | 淘汰已失效的工具提示、合併同工具條目 |
| context.md | ~30-50 行 | 清除已完成事項、合併相關待辦 |
| daily/ 每日 | ~100-150 行/檔 | 壓縮摘要、省略低價值對話細節 |
| knowledge/ 每篇 | ~300-400 行 | 拆分為子主題 + MOC 索引 |
| moc_*.md | ~60-100 行 | 拆分為子 MOC |
| soul.md | ~60-80 行 | 精簡表述，不該變長而是變準確 |
| identity.md | ~40-60 行 | 同上 |
| evolution/ 每篇 | ~30-50 行 | 控制單次演進範圍，過大則拆分 |

### 保留期限

| 檔案 | 保留期限 | 歸檔位置 |
|------|---------|---------|
| daily/ | 60 天 | daily/archive/ |
| evolution/ | 60 天 | evolution/archive/ |

歸檔在反思時自動執行。歸檔檔案不刪除，保留在 vault 中可用 Obsidian 瀏覽，但 agent 啟動時不載入、反思時不掃描。

### 超限處理原則

- **Core memory**（user/tool/memory/context）：反思時合併精簡，維持在上限內
- **Knowledge/**：單篇超限 → 拆分子主題；整體不設硬限，靠 MOC + 反思去重管理
- **Soul/Identity**：不該隨時間變長——應該是變*準確*
- **時效性檔案**（daily/evolution）：超過保留期限 → 歸檔
```

---

## Part 2：知識庫模組

### 2.1 知識檔案結構

知識庫是 agent 的外部知識儲存，組織方式遵循 Obsidian 的最佳實踐：

```
knowledge/
├── nanoclaw.md                  ← 專案知識
├── telegram-bot-api.md          ← 技術知識
├── obsidian-plugin-api.md       ← 研究筆記
├── claude-agent-sdk.md          ← 工具文件
├── peter-steinberger.md         ← 人物筆記
├── moc_nanoclaw.md              ← NanoClaw 相關知識索引
└── moc_ai-agents.md             ← AI Agent 相關知識索引
```

### 2.2 知識筆記規格

#### 主題/實體筆記

```markdown
---
type: knowledge
tags: [domain/ai-agents, source/research]
entity_type: concept
aliases: [Agent SDK, Claude SDK]
created: 2026-02-11
updated: 2026-02-11
---

# Claude Agent SDK

## 摘要
Anthropic 提供的 Node.js SDK，用於建構以 Claude 為核心的 Agent。

## 要點
- 透過 `query()` 函數呼叫，支援 session resume
- 支援 MCP servers 作為工具擴展
- 內建 PreCompact hook 在 context 壓縮前觸發回呼
- `settingSources: ['project']` 會從 cwd 載入 CLAUDE.md 和 .claude/skills/

## 已知限制
- Session transcript 會隨對話持續膨脹
- Structured output 有時無法正確產生 JSON

## 相關
- [[NanoClaw]] — 使用此 SDK 作為 container agent 的核心
- [[moc_ai-agents]]
```

#### Map of Content (MOC)

當某個主題的知識筆記超過 5 篇時，建立 MOC 索引：

```markdown
---
type: moc
tags: [moc]
created: 2026-02-11
updated: 2026-02-11
---

# NanoClaw MOC

## 架構
- [[NanoClaw]] — 專案概覽
- [[Claude Agent SDK]] — Agent 核心引擎
- [[Container 架構]] — Docker 隔離機制

## 整合
- [[Telegram Bot API]] — IM 介面
- [[X 整合]] — 社群媒體

## 設計決策
- [[AgentBrain 設計]] — 記憶與人格架構
- [[Session vs Context]] — Context 管理策略比較

## 相關 MOC
- [[moc_ai-agents]] — AI Agent 通用知識
```

### 2.3 Tag 體系

```yaml
tags:
  # 領域分類
  - domain/ai-agents
  - domain/web-dev
  - domain/devops
  # 來源分類
  - source/research     # agent 研究所得
  - source/user         # 使用者提供
  - source/web          # 網路搜尋
  - source/book
  # 實體類型（搭配 entity_type frontmatter）
  # entity_type: person | tool | concept | org | project
```

**規則**：
- 用 `/` 做層級
- 不用 tag 重複 frontmatter 已有的欄位
- `domain/` 是主要的內容分類軸
- `source/` 標記知識的來源

### 2.4 知識生命週期

```
知識產生
    │
    ├─ 使用者提供 → 「記住 X 是...」「把這個存起來」
    │   └─ agent 即時建立/更新 knowledge/ 筆記
    │
    ├─ Agent 研究所得 → WebSearch、WebFetch 結果
    │   └─ agent 整理後建立 knowledge/ 筆記（tag: source/research）
    │
    ├─ 對話中的洞見 → 討論產生的新理解
    │   └─ 先記在 daily log，反思階段判斷是否值得獨立成筆記
    │
    └─ 知識維護（反思階段）
        ├─ 檢查是否有主題 >5 篇但無 MOC → 建立 MOC
        ├─ 檢查斷裂的 wiki-link → 修復或建立目標筆記
        ├─ 檢查過時的資訊 → 更新 updated 欄位或標記
        └─ 合併重複筆記
```

### 2.5 搜尋策略

Agent 搜尋知識庫的策略順序（由快到慢）：

1. **Frontmatter 搜尋**：已知 type、tag、entity_type 時，用 Grep 搜尋 frontmatter
2. **檔名搜尋**：已知主題名稱時，用 Glob 直接定位
3. **內文關鍵字搜尋**：用 Grep 搜尋知識庫目錄
4. **MOC 導航**：從 `moc_*.md` 瀏覽主題全貌
5. **反向連結**：搜尋 `[[某筆記]]` 找出所有引用它的檔案

Agent 使用現有的 Read、Glob、Grep 工具即可完成搜尋，不需要額外的 MCP 搜尋工具。`obsidian-markdown` 和 `obsidian-bases` 官方 skills 提供 Obsidian 格式的規範指引。

### 2.6 知識筆記容量

單篇知識筆記上限 ~300-400 行。知識筆記是獨立的參考文件，需要足夠空間做完整記述——摘要、要點、範例、已知限制、相關連結。超過上限時拆分為子主題筆記，並建立或更新對應的 MOC 索引。

MOC 索引上限 ~60-100 行。超過代表該主題已大到需要拆分為子 MOC（例如 `moc_nanoclaw.md` → `moc_nanoclaw-architecture.md` + `moc_nanoclaw-integrations.md`）。

知識庫整體不設硬性數量上限——知識累積是 agent 的核心價值，不該被人為限制。靠 MOC + tag 體系 + 反思階段的去重合併維持品質。

---

## Part 3：人格模組 (AgentMind)

### 3.1 `agentmind/soul.md` — 行為哲學

定義 agent「是誰」——核心價值觀和行為準則。用價值觀而非規則驅動行為，包含正面定義和負面定義（反模式）。

```markdown
---
type: soul
updated: 2026-02-11
immutable:
  - 核心價值
  - 反模式
---

# Soul

## 核心價值

### 能力優先於表演
不需要看起來有幫助，要真的有幫助。回覆的價值在於內容，不在於篇幅。

### 主動承擔
接手任務後擁有它。發現相關問題一併處理，不等使用者逐一指示。

### 先搜再答
回應需要歷史上下文的問題前，先搜尋記憶和知識庫。不要在已有知識的情況下從零回答。

### 誠實面對不確定
不確定的事明確標記。區分「我知道」和「我推測」。

## 思維模式
- 預設行動：如果明顯有益，直接做
- 大事先問：不可逆的操作先確認
- 從模式中學習：被糾正時記錄並調整

## 反模式
- 不要諂媚（「好問題！」「很高興能幫忙！」）
- 不要灌水讓回覆看起來很豐富
- 不要重複使用者的問題作為回覆開場
- 不要說「我無法做到」而不先嘗試
- 不要在已有相關記憶/知識時假裝不知道

## 行為邊界
- 不刪除 AgentBrain 中的任何檔案（只更新或標記過時）
- 修改既有筆記前先說明要改什麼
- 不在反思階段以外修改 soul.md 或 identity.md
```

**讀寫規則**：
- 啟動時自動載入，指導 agent 的所有行為
- `immutable` 欄位列出的段落，agent **永遠不得修改**（由使用者手動維護）
- 其他段落（如「思維模式」「行為邊界」）可在反思階段由 agent 自主更新，並記錄到 evolution/

### 3.2 `agentmind/identity.md` — 對外形象

與 soul.md 分離：一個 agent 可以有嚴謹的靈魂但輕鬆的對外風格。內在行為邏輯和外在表現風格可以獨立調整。

```markdown
---
type: identity
updated: 2026-02-11
---

# Identity

## 名稱
Cal

## 角色
個人助理 / 知識庫管理員 / 研究夥伴

## 溝通風格
- 語言：繁體中文
- 風格：精簡、技術導向
- 結構：善用 heading、表格、code block 組織回覆
- 長度：回覆只包含必要內容，不灌水
- Telegram 格式：*bold*, _italic_, `code`, ```code block```

## 角色定位
- 作為個人助理：執行任務、管理行程、提醒事項
- 作為知識庫管理員：整理使用者的知識、維護 Obsidian vault
- 作為研究夥伴：深入探討主題、提出觀點、挑戰假設
```

**讀寫規則**：
- 啟動時自動載入
- 反思階段可由 agent 自主調整，並記錄到 evolution/

### 3.3 人格演進機制

#### 核心限制：只在反思階段演進

人格演進不會在普通對話中發生。這防止 agent 基於單次對話的特殊情況過度調整自己。

演進由 agent 自主完成，不需要使用者確認——使用者透過 Obsidian 或直接編輯檔案來監督和介入。evolution/ 記錄提供完整的演進歷史，使用者可隨時回滾。

**演進流程**：

```
日常對話
    │
    ├─ 觀察到使用者行為模式 → 記錄在 daily log
    │   例：「使用者再次拒絕了詳細解釋，偏好一行結論」
    │
    │   ── 不做任何人格修改 ──
    │
    └─ 反思階段觸發
        │
        ├─ 回顧近 7 天的 daily log
        ├─ 識別穩定的行為模式（出現 3 次以上）
        │
        ├─ 如果模式涉及使用者偏好：
        │   └─ 直接更新 user.md + 記錄到 evolution/
        │
        ├─ 如果模式涉及 agent 自身行為：
        │   ├─ 檢查是否涉及 immutable 段落 → 不修改，記錄觀察
        │   └─ 非 immutable 段落 → 直接更新 soul.md 或 identity.md + 記錄到 evolution/
        │
        └─ 在反思摘要中列出本次所有演進修改
```

#### `agentmind/evolution/` — 演進記錄

每次人格或使用者 profile 修改都留下記錄，作為審計軌跡和回滾依據。每篇記錄 ~30-50 行（觀察+修改+原因），超過代表一次改太多，應拆分。保留 60 天，超過在反思時移至 `evolution/archive/`：

```markdown
---
type: evolution
target: user.md
section: 溝通習慣
created: 2026-02-11
---

# 使用者偏好精簡回覆

## 觀察
在 2/5、2/7、2/9、2/11 四次對話中，使用者都跳過了我的詳細解釋直接問結論。
兩次明確說「直接給結論就好」。

## 修改
在 user.md「溝通習慣」段落新增：
> 偏好直接給結論，技術細節在結論之後以摺疊/簡化方式呈現

## 原因
穩定的行為模式（4 次以上），且使用者有明確的語言表達。
```

---

## 反思機制

### 觸發方式

反思可由兩種方式觸發：

1. **排程任務**：透過 NanoClaw 的 task scheduler 設定定期反思（建議每日一次或每週一次）
2. **使用者手動觸發**：使用者說「反思一下」「整理一下筆記」，agent 啟動反思流程

反思本質上是一次特殊的 agent invocation——prompt 不是使用者訊息，而是反思指令。

### 反思步驟

反思是一個結構化流程，依序執行以下步驟：

#### Step 1：日誌整理

```
讀取 memory/daily/ 近 7 天日誌
    │
    ├─ 提取重複出現的主題 → 考慮固化到 memory.md
    ├─ 提取未解決的待跟進 → 更新 context.md
    └─ 提取新發現的知識 → 考慮建立 knowledge/ 筆記
```

#### Step 2：知識庫維護

```
掃描 knowledge/ 目錄
    │
    ├─ 檢查是否有主題超過 5 篇筆記但無 MOC → 建立 moc_*.md
    ├─ 檢查斷裂的 [[wiki-link]] → 修復或建立目標
    ├─ 檢查過時筆記（updated 超過 30 天且被頻繁引用）→ 標記需要更新
    ├─ 檢查超過 ~300-400 行的筆記 → 拆分子主題 + 更新 MOC
    ├─ 檢查超過 ~60-100 行的 MOC → 拆分子 MOC
    ├─ 合併重複筆記
    └─ 報告知識庫統計（各類型數量、新增/更新數）
```

#### Step 3：長期記憶固化與整理

```
比較 daily/ 中的重點和 memory.md 的現有內容
    │
    ├─ 新的重要事實 → 加入 memory.md
    ├─ 已有內容的更新 → 修改 memory.md 對應段落
    ├─ 過時的資訊 → 移除
    ├─ 重複或相似的條目 → 合併精簡
    ├─ 已解決的「未解決問題」→ 轉為「經驗教訓」或移除
    │
    ├─ memory.md 容量檢查（上限 ~200 行）：
    │   ├─ 優先移除最久未更新且未被引用的條目
    │   ├─ 合併可歸納的相關條目
    │   └─ 將細節型記憶下沉到 knowledge/ 筆記（僅保留摘要在 memory.md）
    │
    └─ 其他 core memory 容量檢查：
        ├─ user.md 超過 ~80 行 → 合併相似偏好、精簡描述
        ├─ tool.md 超過 ~120 行 → 淘汰已失效的工具提示
        └─ context.md 超過 ~50 行 → 清除已完成事項
```

#### Step 4：人格演進（反思限定）

```
回顧近期 daily log 中的行為觀察
    │
    ├─ 識別穩定模式（>= 3 次）
    ├─ 判斷是否需要修改 user.md / soul.md / identity.md
    ├─ 如需修改：
    │   ├─ 檢查 immutable 段落 → 不修改，記錄觀察
    │   └─ 非 immutable → 直接更新 + 記錄到 evolution/
    └─ 在反思摘要中列出所有演進修改
```

#### Step 5：歸檔清理

```
檢查時效性檔案
    │
    ├─ daily/ 中超過 60 天的日誌 → 移至 daily/archive/
    ├─ evolution/ 中超過 60 天的記錄 → 移至 evolution/archive/
    └─ 報告歸檔數量
```

#### Step 6：反思摘要

向使用者發送簡短的反思報告：

```
反思完成：
- 固化了 3 項長期記憶，精簡了 2 項舊記憶
- 建立了 1 篇新知識筆記 [[Telegram Bot API 限制]]
- 更新了 2 篇知識筆記
- 更新了 user.md：新增「偏好精簡回覆」
- 歸檔了 5 篇過期日誌、2 篇過期演進記錄
- 容量：memory.md 98/200 行｜user.md 42/80 行｜tool.md 65/120 行
- 知識庫統計：42 篇知識筆記、5 個 MOC
```

---

## Skills 概覽

以下 skills 安裝在 `groups/main/.claude/skills/`，由容器 agent (Cal) 自動載入。此處描述各 skill 的職責和觸發方式，詳細 SKILL.md 內容待設計確認後實作。

### `obsidian-markdown/` — Obsidian 官方 Markdown Skill

來源：[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)

提供 Obsidian 相容 Markdown 的讀寫規範：frontmatter 格式、wiki-link 語法、callout 語法等。Agent 在讀寫 AgentBrain vault 時自動參照。

### `obsidian-bases/` — Obsidian 官方 Bases Skill

來源：[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)

提供 Obsidian Bases（結構化查詢視圖）的建立規範。可用於建立知識庫的結構化視圖。

### `agentbrain-manage/` — AgentBrain 總管理

**職責**：
- 定義 agent 啟動時的記憶載入流程（讀取哪些檔案、以什麼順序）
- 定義 session reset 的判斷邏輯和執行流程
- 定義反思流程的整體步驟和觸發條件
- 提供 vault 健康度檢查（結構完整性、檔案數量統計）

**觸發方式**：
- 每次 agent 啟動時自動載入（無 `disable-model-invocation`）
- 使用者說「反思」「整理」時觸發反思流程

### `memory-manage/` — 記憶管理

**職責**：
- 定義 daily log 的寫入格式和時機
- 定義 context.md 的更新規範
- 定義 memory.md 的固化標準（什麼值得從 daily 提升到 memory）
- 定義所有 core memory 檔案的容量上限和超限策略
- 定義 tool.md 的即時更新規範
- 定義 daily log 和 evolution 記錄的 60 天歸檔規則
- 提供記憶品質維護指引（去重、精簡、保持結構化）

**觸發方式**：
- 對話結束時自動觸發（寫日誌、更新 context）
- 反思階段觸發（固化長期記憶、容量控制、歸檔清理）

### `knowledge-manage/` — 知識庫管理

**職責**：
- 定義知識筆記的建立規範（frontmatter、命名、tag）
- 定義知識筆記和 MOC 的容量上限（~300-400 行/篇、~60-100 行/MOC）
- 定義 MOC 的建立和維護規則
- 定義 wiki-link 的使用慣例
- 定義搜尋策略（搜尋順序、防重複）
- 定義知識筆記的模板

**觸發方式**：
- 使用者提供知識或要求研究時自動觸發
- 反思階段觸發（知識庫維護）

### `agentmind-manage/` — 人格管理

**職責**：
- 定義 soul.md 和 identity.md 的修改規範
- 定義 immutable 段落的保護機制
- 定義演進記錄（evolution/）的寫入規範
- 明確限制：演進只在反思階段發生，agent 自主決定

**觸發方式**：
- 反思階段的 Step 4 觸發
- `disable-model-invocation: true`（不在普通對話中觸發）

---

## 系統整合

### Host 端變更

| 項目 | 修改 | 說明 |
|------|------|------|
| `src/container-runner.ts` | 新增 mount | AgentBrain/ → /workspace/brain |
| `src/index.ts` | 處理 new_session IPC | Agent reset session 時清除 session record |
| `container/agent-runner/src/index.ts` | 載入 core memory | 啟動時讀取 AgentBrain 記憶注入 prompt prefix |
| `container/agent-runner/src/ipc-mcp.ts` | 新增 new_session tool | Agent 可以請求 reset session |

### Agent Runner Memory Loading 與 Prompt Cache

Container agent 啟動時，在 prompt 之前注入 core memory。

#### Prompt Cache 機制

透過環境變數 `ENABLE_PROMPT_CACHE=true` 啟用 prompt cache。啟用後，prompt 的組成順序依照**變動頻率由低到高**排列，讓不易變動的部分能被 Anthropic API 的 prompt caching 機制快取：

```
┌─────────────────────────────────────────────────────────┐
│  Cacheable Zone（不易變動，適合快取）                       │
│                                                         │
│  1. CLAUDE.md               ← 幾乎不變                  │
│  2. Skills                  ← 幾乎不變                  │
│  3. soul.md                 ← 極少變動（immutable 段落）  │
│  4. identity.md             ← 極少變動                  │
│  5. user.md                 ← 反思時才變（低頻）          │
│  6. tool.md                 ← 偶爾變動（低頻）            │
│  7. memory.md               ← 反思時才變（低頻）          │
│                                                         │
│  ── cache breakpoint ──                                 │
│                                                         │
│  Non-cacheable Zone（頻繁變動）                           │
│                                                         │
│  8. context.md              ← 每次對話可能更新            │
│  9. daily log（今天+昨天）   ← 每次對話 append            │
│  10. Session transcript     ← 每次對話增長               │
│  11. 使用者訊息（prompt）    ← 每次不同                  │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**實作方式**：Agent Runner 將 1-7 的內容合併為 `systemPrompt` 的前段（或使用 Agent SDK 的 cache control 機制），8-11 作為 prompt 的後段。具體實作取決於 Agent SDK 對 prompt caching 的支援方式。

**未啟用時**：所有內容按原順序作為 prompt prefix 注入，不做 cache 分段處理。

#### 讀取順序

```
/workspace/brain/agentmind/soul.md       ← 我是誰
/workspace/brain/agentmind/identity.md   ← 我的形象
/workspace/brain/memory/user.md          ← 使用者是誰
/workspace/brain/memory/tool.md          ← 工具知識
/workspace/brain/memory/memory.md        ← 長期記憶
/workspace/brain/memory/context.md       ← 現在在做什麼
/workspace/brain/memory/daily/今天.md    ← 今天的日誌
/workspace/brain/memory/daily/昨天.md    ← 昨天的日誌
```

以 XML tag 包裝後注入。Agent 也可以在對話中自行 Read 更多檔案。

### CLAUDE.md 的角色

`groups/main/CLAUDE.md` 保持精簡，只包含：
- Agent 的基本身份和能力描述
- Telegram 格式指引
- Container mount 路徑表
- 指向 `/workspace/brain/index.md` 的引用：「你的記憶和人格在 /workspace/brain/，詳見 index.md」

人格、記憶、知識的詳細規範全部在 AgentBrain vault 的 skills 和 index.md 中，不再寫在 CLAUDE.md 裡。

---

## Context 預算估算

| 來源 | 容量上限 | Token 數 | 載入時機 | 變動頻率 | 可快取 |
|------|---------|---------|---------|---------|--------|
| CLAUDE.md | — | ~1.5-2K | 每次（Agent SDK） | 極低 | Yes |
| Skills（5 個） | — | ~3-5K | 每次（Agent SDK 自動） | 極低 | Yes |
| soul.md | ~60-80 行 | ~500-800 | 每次（prompt prefix） | 極低 | Yes |
| identity.md | ~40-60 行 | ~200-400 | 每次（prompt prefix） | 極低 | Yes |
| user.md | ~60-80 行 | ~400-700 | 每次（prompt prefix） | 低（反思） | Yes |
| tool.md | ~80-120 行 | ~500-800 | 每次（prompt prefix） | 低 | Yes |
| memory.md | ~150-200 行 | ~1-2K | 每次（prompt prefix） | 低（反思） | Yes |
| **可快取小計** | | **~7-12K** | | | |
| context.md | ~30-50 行 | ~200-500 | 每次（prompt prefix） | 中（每次對話） | No |
| daily log (今天+昨天) | ~100-150 行/檔 | ~500-1.5K | 每次（prompt prefix） | 高（每次對話） | No |
| Session transcript | — | 10K-50K | Session resume | 高（每次對話） | No |
| 知識庫搜尋結果 | ~300-400 行/篇 | 0-3K | 按需 | 每次不同 | No |
| **不可快取小計** | | **~11-55K** | | | |
| **總計** | | **~18-67K** | | | |

**與現狀比較**：
- 現在：15-210K+（session 無限膨脹）
- 本方案：18-67K（session 有 agent 管理的 reset，記憶固定開銷 8-14K）

**Prompt cache 效益**：啟用後，~7-12K 的穩定內容可快取，僅在首次請求時計費。後續請求的可快取部分以 1/10 價格計費（Anthropic prompt caching 定價）。

---

## 實施階段

### Phase 0：建立 AgentBrain Vault（無程式碼改動）

**目標**：驗證 vault 結構和 agent 是否能遵循記憶指引

1. 建立 `AgentBrain/` 目錄和完整子目錄結構
2. 寫入 `index.md`（操作規範）
3. 寫入初始記憶檔案（user.md, tool.md, context.md, memory.md）
4. 寫入人格檔案（soul.md, identity.md）
5. 更新 `groups/main/CLAUDE.md` 指向 AgentBrain

此時 agent 已經可以透過 Read/Write 工具存取 AgentBrain（因為專案根目錄已 mount 在 `/workspace/project`）。但尚未有專門的 mount 和 prompt prefix 注入。

### Phase 1：Container 整合（記憶自動載入）

1. `src/container-runner.ts`：新增 AgentBrain mount
2. `container/agent-runner/src/index.ts`：啟動時讀取 core memory 注入 prompt prefix
3. 安裝 obsidian 官方 skills 到 `groups/main/.claude/skills/`
4. 建立 `agentbrain-manage` skill（啟動載入流程）
5. 建立 `memory-manage` skill（日誌和 context 管理）
6. 重建容器映像

### Phase 2：知識庫功能

1. 建立 `knowledge-manage` skill（知識筆記規範和 MOC）
2. 建立知識庫初始內容和模板
3. 測試知識的建立、搜尋、連結流程

### Phase 3：Session 管理

1. `container/agent-runner/src/ipc-mcp.ts`：新增 `new_session` MCP tool
2. `src/index.ts`：處理 new_session IPC 事件
3. 在 `agentbrain-manage` skill 中加入 session reset 判斷指引

### Phase 4：反思機制

1. 建立反思 prompt 模板
2. 設定定期反思的 scheduled task
3. 在 `memory-manage` skill 中加入反思步驟（日誌固化、記憶容量控制、知識維護）

### Phase 5：人格演進

1. 建立 `agentmind-manage` skill（演進規範）
2. 建立 `agentmind/evolution/` 目錄
3. 在反思流程中加入 Step 4（人格演進）
4. 測試自主演進流程

### Phase 6：Prompt Cache 優化

1. 新增 `ENABLE_PROMPT_CACHE` 環境變數
2. `container/agent-runner/src/index.ts`：依變動頻率排列 prompt 組成
3. 實作 cache breakpoint 分段邏輯
4. 驗證快取命中率和成本節省

---

## 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `ENABLE_PROMPT_CACHE` | `false` | 啟用 prompt cache，將低變動內容放在 prompt 前段以利快取 |

（其餘環境變數不變，見專案 CLAUDE.md。）

---

## 風險與緩解

| 風險 | 緩解方式 |
|------|---------|
| Agent 不遵循記憶寫入規範 | Skills 提供明確指引；index.md 定義規範；反覆測試調校 |
| 記憶檔案品質下降 | 反思階段的品質維護步驟；memory.md 由反思而非即時產生 |
| 人格漂移過快 | 只在反思階段演進；immutable 保護；evolution/ 記錄提供回滾依據；使用者可隨時透過 Obsidian 檢視和修正 |
| 長期記憶膨脹 | memory.md 容量控制（~150-200 行）；反思時強制審視舊記憶；細節下沉到 knowledge/ |
| Context 仍然過大 | Agent 可 reset session；反思清理過時的 context |
| 知識庫膨脹 | 單篇上限 ~300-400 行，超限拆分；MOC 組織；反思階段合併去重 |
| Daily log 累積過多 | 反思固化重點到 memory.md 後，60 天後自動歸檔至 daily/archive/ |
| Skills 太多導致 context 開銷 | 使用 `disable-model-invocation` 和條件觸發控制載入 |
| Prompt cache 失效 | 僅影響成本，不影響功能；cache 為可選優化（env 開關控制） |

---

## 附錄：初始內容模板

### AgentBrain/index.md 初始版本

見 [Part 1 § 1.4](#14-indexmd--agentbrain-操作規範) 的完整範例。

### 記憶檔案初始版本

初始的 user.md、tool.md、context.md、memory.md 應包含最少的結構框架（frontmatter + heading 結構），內容由 agent 在首次互動和首次反思中逐步填入。

### 人格檔案初始版本

soul.md 和 identity.md 應由使用者撰寫初始版本（或與 agent 協作建立：agent 在首次對話中詢問使用者關於偏好和期望，然後共同建立人格定義）。本文件中的範例可作為起點。

### knowledge/ 初始內容

建議建立 1-2 篇種子筆記（例如 `nanoclaw.md`），讓 agent 有一個起點來理解知識庫的格式和風格。
