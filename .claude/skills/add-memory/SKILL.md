---
name: add-memory
description: Add AgentBrain memory system to NanoClaw. Creates the Obsidian-compatible vault with memory/knowledge management, container integration, session control, and scheduled reflection. Based on docs/agentbrain-design.md.
---

# Add AgentBrain Memory System

Implements the AgentBrain memory and knowledge system from `docs/agentbrain-design.md`. Creates an Obsidian-compatible vault (`AgentBrain/`) that the container agent reads/writes, with automatic memory loading into prompt prefix, knowledge management, session control, and a reflection mechanism.

**Reference**: Read `docs/agentbrain-design.md` for full design rationale before starting.

## Step 1: Create Vault Directory Structure

```bash
mkdir -p AgentBrain/agentmind/evolution/archive
mkdir -p AgentBrain/memory/daily/archive
mkdir -p AgentBrain/knowledge
mkdir -p AgentBrain/.obsidian
```

## Step 2: Write `AgentBrain/index.md`

This is the vault's operation manual. The agent reads it on startup.

```markdown
---
type: index
updated: YYYY-MM-DD  # use today's date
---

# AgentBrain

This vault is your (Cal's) memory, knowledge, and personality database. You have full read-write access.

## Vault Path

Inside the container: `/workspace/brain/`

## Frontmatter

Every .md file must have YAML frontmatter with at least:
- `type`: file type (see table below)
- `updated`: last update date YYYY-MM-DD

### Type Table

| type | Purpose | Location |
|------|---------|----------|
| user | User profile | memory/user.md |
| tool | Tool knowledge | memory/tool.md |
| context | Work context | memory/context.md |
| memory | Long-term memory | memory/memory.md |
| log | Daily log | memory/daily/ |
| knowledge | Knowledge note | knowledge/ |
| moc | Map of Content | knowledge/moc_*.md |
| soul | Agent philosophy | agentmind/soul.md |
| identity | Agent persona | agentmind/identity.md |
| evolution | Evolution record | agentmind/evolution/ |

## Link Rules

- Use `[[wiki-link]]` between knowledge notes
- Link headings: `[[Note Name#Heading]]`
- Update related notes when creating new ones
- Daily logs also use wiki-links to reference knowledge

## Dedup

Before creating a knowledge note, search `knowledge/` for existing notes on the same topic. Update existing notes instead of creating duplicates.

## Update Timing

| File | Read | Write | Constraint |
|------|------|-------|------------|
| user.md | Startup | Reflection only | Agent decides autonomously |
| tool.md | Startup | Immediate | Record tool experience as it happens |
| context.md | Startup | End of conversation | Update if work context changed |
| memory.md | Startup | Reflection only | Consolidate from daily logs, review old entries |
| daily/ | Startup (today+yesterday) | End of conversation | Append-only |
| knowledge/ | On-demand search | Immediate | Search before create, update existing |
| soul.md | Startup | Reflection only | immutable sections never modified |
| identity.md | Startup | Reflection only | Agent decides autonomously |

## Capacity Limits

| File | Limit | Over-limit Strategy |
|------|-------|-------------------|
| memory.md | ~150-200 lines | Merge, prune outdated, move details to knowledge/ |
| user.md | ~60-80 lines | Merge similar preferences |
| tool.md | ~80-120 lines | Remove obsolete tips |
| context.md | ~30-50 lines | Clear completed items |
| daily/ per day | ~100-150 lines | Compress summaries |
| knowledge/ per note | ~300-400 lines | Split into sub-topics + MOC |
| moc_*.md | ~60-100 lines | Split into sub-MOCs |
| soul.md | ~60-80 lines | Refine, don't grow |
| identity.md | ~40-60 lines | Refine, don't grow |
| evolution/ per entry | ~30-50 lines | Limit scope per evolution |

## Retention

| Files | Retention | Archive Location |
|-------|-----------|-----------------|
| daily/ | 60 days | daily/archive/ |
| evolution/ | 60 days | evolution/archive/ |

Archival happens during reflection. Archived files stay in vault (browsable in Obsidian) but are not loaded at startup or scanned during reflection.

## Over-limit Principles

- **Core memory** (user/tool/memory/context): Merge and prune during reflection
- **Knowledge/**: Split when single note exceeds limit; no hard cap on total count — managed via MOC + dedup
- **Soul/Identity**: Should get more *accurate*, not longer
- **Time-based** (daily/evolution): Archive after retention period
```

## Step 3: Write Initial Memory Files

### `AgentBrain/memory/user.md`

```markdown
---
type: user
updated: YYYY-MM-DD
---

# User

## Identity
<!-- Name, role, domain -->

## Preferences
- Language: Traditional Chinese
- Timezone: <!-- e.g., Asia/Taipei (UTC+8) -->

## Technical Background
<!-- Discovered through conversation -->

## Interests
<!-- Topics the user cares about -->
```

### `AgentBrain/memory/tool.md`

```markdown
---
type: tool
updated: YYYY-MM-DD
---

# Tool Knowledge

## agent-browser
- Run `agent-browser open <url>` to start, then `agent-browser snapshot -i` to see interactive elements
- Some sites need JS load time
- Handle cookie consent popups first

## Bash
- Container paths: /workspace/group, /workspace/brain, /workspace/project
- SQLite database at /workspace/project/store/messages.db

## WebSearch
- Use Chinese keywords for Traditional Chinese content
- English keywords work better for technical searches
```

### `AgentBrain/memory/context.md`

```markdown
---
type: context
updated: YYYY-MM-DD
---

# Current Context

## In Progress
<!-- Currently active work items -->

## Up Next
<!-- Planned work items -->

## Follow Up
<!-- Items to revisit, with source references -->
```

### `AgentBrain/memory/memory.md`

```markdown
---
type: memory
updated: YYYY-MM-DD
---

# Long-term Memory

## Important Facts
<!-- Consolidated from daily logs during reflection -->

## Lessons Learned
<!-- Experience and insights -->

## Open Questions
<!-- Unresolved items -->
```

## Step 4: Write Placeholder Personality Files

Create minimal templates. The `add-personality` skill will fill these with meaningful content later.

### `AgentBrain/agentmind/soul.md`

```markdown
---
type: soul
updated: YYYY-MM-DD
immutable: []
---

# Soul

<!-- Run the add-personality skill to define core values and behavior philosophy -->
```

### `AgentBrain/agentmind/identity.md`

```markdown
---
type: identity
updated: YYYY-MM-DD
---

# Identity

## Name
Cal

## Role
Personal assistant

## Communication Style
- Language: Traditional Chinese (繁體中文)
- Write like a normal person texting — plain text, no markdown formatting
```

## Step 5: Create Initial Knowledge Seed

### `AgentBrain/knowledge/nanoclaw.md`

```markdown
---
type: knowledge
tags: [domain/ai-agents, source/research]
entity_type: project
aliases: [NanoClaw]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---

# NanoClaw

## Summary
Personal Claude assistant. Single-user Node.js host serving one Telegram private chat via Docker-isolated Claude Agent SDK containers.

## Architecture
- Host: Node.js + grammy (Telegram bot, long polling)
- Agent: Claude Sonnet 4.5 in Docker container
- IPC: File-based (container writes JSON, host polls)
- Database: SQLite (messages, tasks, sessions)
- Memory: AgentBrain Obsidian vault

## Key Components
- Container isolation for security
- Task scheduler (cron/interval/once)
- Session resume for conversation continuity
- AgentBrain vault for persistent memory and knowledge

## Related
- [[Claude Agent SDK]]
```

## Step 6: Add AgentBrain Mount to Container

In `src/container-runner.ts`, inside `buildVolumeMounts()`, add the AgentBrain mount **after** the group folder mount and **before** the sessions directory mount:

```typescript
// AgentBrain vault
const brainDir = path.join(projectRoot, 'AgentBrain');
fs.mkdirSync(brainDir, { recursive: true });
mounts.push({
  hostPath: brainDir,
  containerPath: '/workspace/brain',
  readonly: false,
});
```

Also add `AGENTBRAIN_DIR` to `src/config.ts`:

```typescript
export const AGENTBRAIN_DIR = path.resolve(PROJECT_ROOT, 'AgentBrain');
```

Then import and use `AGENTBRAIN_DIR` instead of computing the path inline.

Also in `buildContainerArgs()`, pass the host's timezone to the container so `new Date()` uses the correct local time:

```typescript
// After '--name', containerName:
args.push('-e', `TZ=${TIMEZONE}`);
```

Import `TIMEZONE` from `./config.js`.

## Step 7: Add Memory Loading to Agent Runner

In `container/agent-runner/src/index.ts`, add a `loadCoreMemory()` function that reads vault files and returns XML-wrapped content for injection into the system prompt.

### Add the function before `main()`:

```typescript
function loadCoreMemory(): string {
  const brainDir = '/workspace/brain';
  const files = [
    { path: 'agentmind/soul.md', tag: 'soul' },
    { path: 'agentmind/identity.md', tag: 'identity' },
    { path: 'memory/user.md', tag: 'user-profile' },
    { path: 'memory/tool.md', tag: 'tool-knowledge' },
    { path: 'memory/memory.md', tag: 'long-term-memory' },
    { path: 'memory/context.md', tag: 'current-context' },
  ];

  const sections: string[] = [];

  for (const f of files) {
    const fullPath = path.join(brainDir, f.path);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8').trim();
      if (content) {
        sections.push(`<${f.tag}>\n${content}\n</${f.tag}>`);
      }
    }
  }

  // Load daily logs: today + yesterday
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const dailyDir = path.join(brainDir, 'memory', 'daily');
  for (const date of [yesterday, today]) {
    const dateStr = date.toISOString().split('T')[0];
    const logPath = path.join(dailyDir, `${dateStr}.md`);
    if (fs.existsSync(logPath)) {
      const content = fs.readFileSync(logPath, 'utf-8').trim();
      if (content) {
        sections.push(`<daily-log date="${dateStr}">\n${content}\n</daily-log>`);
      }
    }
  }

  if (sections.length === 0) return '';
  return `<agentbrain>\n${sections.join('\n\n')}\n</agentbrain>`;
}
```

### Modify `main()` to use it:

In the `query()` call, change `systemPrompt: undefined` to:

```typescript
const coreMemory = loadCoreMemory();
log(`Core memory loaded: ${coreMemory.length} chars`);

// In query() options:
systemPrompt: coreMemory || undefined,
```

The order of XML tags in `loadCoreMemory()` follows the **prompt cache optimization order** from the design: low-change files first (soul, identity, user, tool, memory), high-change files last (context, daily logs). This maximizes cache hit rate if prompt caching is enabled later.

## Step 8: Create Container Agent Skills

Create the skills directory:

```bash
mkdir -p groups/main/.claude/skills/agentbrain-manage
mkdir -p groups/main/.claude/skills/memory-manage
mkdir -p groups/main/.claude/skills/knowledge-manage
mkdir -p groups/main/.claude/skills/obsidian-markdown
```

### 8a: `groups/main/.claude/skills/agentbrain-manage/SKILL.md`

```markdown
---
name: agentbrain-manage
description: AgentBrain vault management — startup procedures, session management, and reflection orchestration.
---

# AgentBrain Management

Your persistent memory, knowledge, and personality live in `/workspace/brain/` (an Obsidian-compatible vault). Core memory files are auto-loaded into your context at startup. Read `/workspace/brain/index.md` for the full operation manual.

## Startup

Your core memory is automatically injected into your system prompt:
- soul.md, identity.md (who you are)
- user.md, tool.md, memory.md (what you know)
- context.md (what you're working on)
- Today's and yesterday's daily logs

You do NOT need to manually Read these files unless you want to update them.

## During Conversation

- **`/workspace/brain/memory/tool.md`**: Update immediately when you discover something new about tools
- **`/workspace/brain/knowledge/`**: Create or update notes when the user provides knowledge or you research something
- Search `/workspace/brain/knowledge/` before creating new notes (avoid duplicates)

## Every Response — Daily Log

**You MUST write a daily log entry before EVERY structured output response**, unless the interaction is trivially short (a single greeting or acknowledgment with no substance).

Each agent invocation is independent — you don't know if the user will send another message or not. Treat every meaningful interaction as worth logging. If reflection has no daily logs to work with, the entire memory system loses value.

**IMPORTANT: Your structured output response is your LAST action. Once you produce it, your turn ends — no more tool calls can happen. You MUST complete all file writes BEFORE responding.**

Before producing your final structured output:
1. Use Write/Edit to append a summary to today's daily log at `/workspace/brain/memory/daily/YYYY-MM-DD.md` (create the file if it doesn't exist)
2. Use Write/Edit to update `/workspace/brain/memory/context.md` if work context has changed
3. Only AFTER the writes succeed, produce your structured output response

What to log:
- Questions discussed and answers given
- Tasks scheduled or completed
- Knowledge shared by the user (preferences, facts, opinions)
- Decisions made
- Observations about user behavior or preferences (useful for reflection)

Daily log entry format:
```
## HH:MM — Topic
**Summary**: One-line description.
**Conclusions**:
- Key takeaway 1
- Key takeaway 2
**Created/Updated**: [[Note1]], [[Note2]]
**Follow up**: Items to revisit
```

## Session Reset

Call `new_session` MCP tool when:
- Topic completely changes (coding → scheduling)
- Context feels cluttered with irrelevant tool history
- User says "reset", "fresh start", "restart"
- Long idle period (context is stale)

Do NOT reset when:
- In the middle of a multi-step task
- Session was recently reset

Session reset clears only the transcript. All AgentBrain files are preserved.

## Reflection

When the user says "reflect", "review notes", "tidy up", or when a reflection scheduled task runs:

Execute these steps in order:
1. **Daily log consolidation** (memory-manage skill)
2. **Knowledge maintenance** (knowledge-manage skill)
3. **Long-term memory fixation** (memory-manage skill)
4. **Personality evolution** (agentmind-manage skill, if present)
5. **Archive cleanup** (memory-manage skill)
6. **Send summary** via `send_message` with counts of changes made

## Vault Health Check

When asked to check vault health:
- List all files and their line counts
- Flag files over capacity limits
- Check for broken [[wiki-links]]
- Report statistics (knowledge count, MOC count, daily log count)
```

### 8b: `groups/main/.claude/skills/memory-manage/SKILL.md`

```markdown
---
name: memory-manage
description: Memory file management — daily logs, context updates, long-term memory, capacity control, and archival.
---

# Memory Management

See `/workspace/brain/index.md` for the full vault spec.

## Daily Log

- **Path**: `/workspace/brain/memory/daily/YYYY-MM-DD.md` (use this exact path)
- **When**: Append at end of every conversation, BEFORE producing structured output
- **Format**: Append-only, never modify existing entries
- **Create file if it doesn't exist** with this frontmatter:
  ```yaml
  ---
  type: daily-log
  date: YYYY-MM-DD
  created: YYYY-MM-DDTHH:MM:SSZ
  updated: YYYY-MM-DDTHH:MM:SSZ
  ---

  # Daily Log: YYYY-MM-DD
  ```
- **Append entries** in this format:
  ```
  ## HH:MM — Topic
  **Summary**: One sentence.
  **Conclusions**:
  - Point 1
  - Point 2
  **Created/Updated**: [[Note1]], [[Note2]]
  **Follow up**: Item to revisit — source: [[YYYY-MM-DD]]
  ```
- **Limit**: ~100-150 lines per day. Compress if needed.

## Context

- **Path**: `/workspace/brain/memory/context.md`
- **When**: Update at end of conversation if work context changed
- **Content**: In progress items, up next, follow-ups
- **Limit**: ~30-50 lines. Clear completed items.

## Tool Knowledge

- **Path**: `/workspace/brain/memory/tool.md`
- **When**: Update immediately when discovering tool behavior
- **Content**: Objective tool experience (not subjective opinions)
- **Limit**: ~80-120 lines. Remove obsolete entries.

## Reflection: Long-term Memory Fixation

During reflection, review the last 7 days of daily logs (`/workspace/brain/memory/daily/`) and consolidate into `/workspace/brain/memory/memory.md`:

1. **Extract** repeated themes → add to memory.md
2. **Extract** unresolved follow-ups → update context.md
3. **Extract** new knowledge → consider creating `/workspace/brain/knowledge/` notes
4. **Review** existing memory.md entries:
   - Outdated facts → remove or update
   - Duplicate/similar entries → merge
   - Resolved "open questions" → move to "lessons learned" or remove
5. **Capacity check** (~150-200 lines):
   - Remove least-recently-relevant entries first
   - Merge related entries
   - Move detailed entries to knowledge/ (keep only summary in memory.md)

Also check other core memory capacity:
- user.md > ~80 lines → merge similar preferences
- tool.md > ~120 lines → prune obsolete tips
- context.md > ~50 lines → clear completed items

## Reflection: Archive Cleanup

During reflection:
1. Check `/workspace/brain/memory/daily/` for files older than 60 days → move to `/workspace/brain/memory/daily/archive/`
2. Check `/workspace/brain/agentmind/evolution/` for records older than 60 days → move to `/workspace/brain/agentmind/evolution/archive/`
3. Report number of archived files

Use Bash `mv` to move files. Archived files stay in the vault for Obsidian browsing but are not loaded or scanned.
```

### 8c: `groups/main/.claude/skills/knowledge-manage/SKILL.md`

```markdown
---
name: knowledge-manage
description: Knowledge base management — note creation, search, MOC maintenance, and quality control.
---

# Knowledge Management

Knowledge notes live in `/workspace/brain/knowledge/`. See `/workspace/brain/index.md` for the full spec.

## Creating a Knowledge Note

**Before creating**: Search existing notes first!
```
Glob: /workspace/brain/knowledge/*.md
Grep: <search term> in /workspace/brain/knowledge/
```

**Frontmatter**:
```yaml
---
type: knowledge
tags: [domain/<category>, source/<origin>]
entity_type: concept | person | tool | org | project
aliases: [Alternative Name]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

**Structure**:
```markdown
# Title

## Summary
One paragraph overview.

## Key Points
- Point 1
- Point 2

## Known Limitations
- Limitation 1

## Related
- [[Related Note 1]] — brief context
- [[moc_topic]]
```

**Limit**: ~300-400 lines per note. If larger, split into sub-topics and create/update a MOC.

## Tag System

```yaml
tags:
  - domain/ai-agents    # Content domain
  - domain/web-dev
  - domain/devops
  - source/research      # Agent's research
  - source/user          # User provided
  - source/web           # From web search
```

Rules:
- Use `/` for hierarchy
- Don't duplicate frontmatter fields in tags
- `domain/` is the primary classification axis
- `source/` marks knowledge origin

## Map of Content (MOC)

Create `moc_<topic>.md` when a topic has >5 related notes.

```yaml
---
type: moc
tags: [moc]
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

Structure: Group related notes under headings with `[[wiki-links]]`.
Limit: ~60-100 lines. Split into sub-MOCs if larger.

## Search Strategy (fastest to slowest)

1. **Frontmatter search**: `Grep` for type/tag/entity_type in frontmatter
2. **Filename search**: `Glob` for known topic names
3. **Content search**: `Grep` keywords in knowledge/
4. **MOC navigation**: Read `moc_*.md` for topic overview
5. **Backlinks**: `Grep` for `[[Note Name]]` to find all references

## Reflection: Knowledge Maintenance

During reflection:
1. Check for topics with >5 notes but no MOC → create one
2. Check for broken `[[wiki-links]]` → fix or create target
3. Check notes with `updated` >30 days and frequently referenced → flag for review
4. Check notes >300 lines → split into sub-topics + update MOC
5. Check MOCs >100 lines → split into sub-MOCs
6. Merge duplicate notes
7. Report statistics (total notes, MOC count, new/updated count)
```

### 8d: `groups/main/.claude/skills/obsidian-markdown/SKILL.md`

Fetch the official skill from kepano/obsidian-skills if possible. If WebFetch fails, write a minimal version:

```markdown
---
name: obsidian-markdown
description: Obsidian-compatible Markdown conventions for reading and writing vault files.
---

# Obsidian Markdown

When reading or writing files in the AgentBrain vault (`/workspace/brain/`), follow these Obsidian-compatible conventions.

## Frontmatter

YAML frontmatter between `---` markers at the top of every file. Use standard YAML types.

## Links

- Internal links: `[[Note Name]]` or `[[Note Name|Display Text]]`
- Heading links: `[[Note Name#Heading]]`
- Block links: `[[Note Name#^block-id]]`
- Do NOT use standard markdown links for internal vault references

## Callouts

```markdown
> [!note] Title
> Content

> [!warning] Title
> Content
```

Types: note, tip, warning, danger, info, abstract, todo, example, quote, bug, success, failure, question

## Tags

- Inline: `#tag/subtag`
- Frontmatter: `tags: [tag1, tag2]`
- Use `/` for hierarchy

## Formatting

- Bold: `**text**` or `__text__`
- Italic: `*text*` or `_text_`
- Highlight: `==text==`
- Strikethrough: `~~text~~`
- Code: `` `inline` `` or fenced blocks with language

## Math

- Inline: `$formula$`
- Block: `$$formula$$`

## Embeds

- `![[Note Name]]` embeds entire note
- `![[Note Name#Heading]]` embeds section
- `![[image.png]]` embeds image
```

## Step 9: Add Session Reset MCP Tool

### In `container/agent-runner/src/ipc-mcp.ts`

Add a `new_session` tool to the tools array in `createIpcMcp()`:

```typescript
tool(
  'new_session',
  'Reset the current conversation session. Use when the topic has completely changed, context feels cluttered, or the user requests a fresh start. All AgentBrain memory is preserved — only the session transcript is cleared. The reset takes effect on the next message.',
  {},
  async () => {
    const data = {
      type: 'new_session',
      groupFolder,
      timestamp: new Date().toISOString()
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{
        type: 'text',
        text: 'Session reset requested. The new session will start on the next message.'
      }]
    };
  }
),
```

### In `src/index.ts`

Add a handler in the `processTaskIpc` switch statement:

```typescript
case 'new_session':
  sessionId = undefined;
  setSession('main', '');
  logger.info('Session reset via IPC');
  break;
```

## Step 10: Set Up Reflection Mechanism

After deployment, guide the user to set up a daily reflection scheduled task. The agent can create this via `schedule_task` MCP tool, or the user can ask the agent to set it up.

**Reflection prompt template** (for a daily cron task, e.g., `0 23 * * *` at 11 PM):

```
[REFLECTION TASK]

Execute the full AgentBrain reflection flow as defined in your agentbrain-manage skill:

1. Read the last 7 days of daily logs from /workspace/brain/memory/daily/
2. Consolidate: extract recurring themes, unresolved follow-ups, new knowledge
3. Update memory.md: add new entries, prune outdated, merge duplicates (keep under 200 lines)
4. Review core memory capacity: user.md (<80 lines), tool.md (<120 lines), context.md (<50 lines)
5. Maintain knowledge base: check for missing MOCs, broken links, oversized notes
6. If agentmind-manage skill is present: run personality evolution (Step 4)
7. Archive files older than 60 days (daily/ → daily/archive/, evolution/ → evolution/archive/)
8. Send a reflection summary via send_message with counts of all changes

Use context_mode: isolated for this task.
```

Tell the user:
> The reflection mechanism uses NanoClaw's existing task scheduler. Ask Cal to "set up daily reflection at 11 PM" and it will create the scheduled task automatically. Or you can create it manually by sending a message like:
>
> "Schedule a daily reflection task at 11 PM every night"

## Step 11: Update `groups/main/CLAUDE.md`

Replace the current CLAUDE.md with a simplified version that references AgentBrain. Keep:
- Agent identity and capabilities
- Communication tools description
- Container mount table (add the new `/workspace/brain` mount)

Remove:
- Telegram formatting guide (identity.md handles communication style now)

Also remove:
- The "Memory" section about `conversations/` folder (replaced by AgentBrain)
- Any instructions about creating ad-hoc memory files

Add:
```markdown
## AgentBrain

Your persistent memory, knowledge, and personality live in `/workspace/brain/` (an Obsidian-compatible vault). Core memory files are auto-loaded into your context at startup. Your skills define how to manage them.

### Key Paths (absolute, use these exactly)

| File | Absolute Path |
|------|---------------|
| Daily log | `/workspace/brain/memory/daily/YYYY-MM-DD.md` |
| Context | `/workspace/brain/memory/context.md` |
| Tool knowledge | `/workspace/brain/memory/tool.md` |
| User profile | `/workspace/brain/memory/user.md` |
| Long-term memory | `/workspace/brain/memory/memory.md` |
| Knowledge notes | `/workspace/brain/knowledge/<topic>.md` |
| Soul | `/workspace/brain/agentmind/soul.md` |
| Identity | `/workspace/brain/agentmind/identity.md` |
| Vault manual | `/workspace/brain/index.md` |

**CRITICAL: Your structured output response is your LAST action — once you produce it, your turn ends and no more tool calls can execute. You MUST complete ALL file operations (daily log writes, context updates, knowledge notes, etc.) BEFORE producing your final structured output response. Never say "I'll write it now" in the response — write it first, then respond.**

**DAILY LOG: Write a daily log entry before EVERY response** (unless trivially short like a single greeting). Each invocation is independent — treat every meaningful interaction as worth logging. See the agentbrain-manage skill for format.
```

Update the Container Mounts table to add:
```markdown
| `/workspace/brain` | `AgentBrain/` | read-write |
```

## Step 12: Build and Verify

```bash
# Rebuild host
npm run build

# Rebuild container agent
cd container && npm run build && cd ..

# Rebuild container image
./container/build.sh

# Restart service
launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
```

### Verification

1. Send a message to Cal in Telegram — it should respond normally
2. Check container logs for "Core memory loaded: N chars" line:
   ```bash
   cat groups/main/logs/container-*.log | grep "Core memory"
   ```
3. Ask Cal: "What's in your AgentBrain vault?" — it should describe the vault structure
4. Ask Cal: "Write something in your daily log" — it should append to `/workspace/brain/memory/daily/YYYY-MM-DD.md`
5. Ask Cal: "Reset your session" — it should call `new_session` and confirm
6. Verify the vault files in Obsidian (open `AgentBrain/` as a vault)

## Optional: Prompt Cache (Phase 6)

Add `ENABLE_PROMPT_CACHE=true` to `.env` and implement cache-aware prompt assembly in the agent runner. The `loadCoreMemory()` function already orders content by change frequency (low-change first). Implementation details:

1. Add `ENABLE_PROMPT_CACHE` env var support to container (pass via `data/env/`)
2. In `loadCoreMemory()`, when cache is enabled, split output into two parts:
   - Cacheable: soul → identity → user → tool → memory (low-change)
   - Non-cacheable: context → daily logs (high-change)
3. Use Agent SDK's cache control mechanism to mark the split point

This is an optimization step — skip until memory system is validated and working.
