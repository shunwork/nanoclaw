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
2. Check `/workspace/brain/agentmind/evolution/` for records older than 60 days → move to `evolution/archive/`
3. Report number of archived files

Use Bash `mv` to move files. Archived files stay in the vault for Obsidian browsing but are not loaded or scanned.
