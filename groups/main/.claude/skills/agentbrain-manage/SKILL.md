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

When the user says "reflect", "review notes", "tidy up", or when a reflection scheduled task runs, execute these steps in order:

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
