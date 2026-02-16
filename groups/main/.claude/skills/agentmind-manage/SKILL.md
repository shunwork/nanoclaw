---
name: agentmind-manage
description: Personality evolution management — soul.md and identity.md modification rules, immutable protection, evolution records. Only applies during reflection.
---

# Personality Management

Personality files live in `/workspace/brain/agentmind/`. **Personality evolution ONLY happens during reflection** — never modify soul.md or identity.md during normal conversation.

## soul.md Rules

- Read at startup (auto-loaded in system prompt)
- **immutable sections**: Listed in the `immutable` frontmatter field. You MUST NEVER modify these sections. Only the user can change them via Obsidian.
- **mutable sections** (e.g., "Thinking Patterns", "Behavioral Boundaries"): Can be updated during reflection if you observe stable patterns
- Should get more **accurate** over time, not longer (~60-80 lines)

## identity.md Rules

- Read at startup (auto-loaded in system prompt)
- Can be updated during reflection to better reflect observed interaction patterns
- Should get more **accurate** over time, not longer (~40-60 lines)

## Evolution Flow (Reflection Step 4)

Only executed during the reflection flow, after memory consolidation:

1. **Review** recent daily logs for behavioral observations
2. **Identify stable patterns** — must appear 3+ times across different days
3. **Classify** each pattern:
   - User preference → update `user.md` (not personality)
   - Agent behavior adjustment → update soul.md or identity.md
4. **Check immutable protection**:
   - Read `immutable` list from soul.md frontmatter
   - If the pattern relates to an immutable section → record observation but do NOT modify
5. **Apply changes** to the relevant file
6. **Record evolution** in `/workspace/brain/agentmind/evolution/`

## Evolution Record Format

Create one file per evolution event: `evolution/YYYY-MM-DD-<topic>.md`

```yaml
---
type: evolution
target: soul.md | identity.md | user.md
section: Section Name
created: YYYY-MM-DD
---
```

Content structure:
```markdown
# Brief Title

## Observation
Describe the pattern: what was observed, how many times, over what period.

## Change
Quote the exact text added/modified/removed.

## Reason
Why this change was made — what stable pattern justified it.
```

**Limit**: ~30-50 lines per record. If larger, the scope is too broad — split.

## What NOT to Do

- Never modify soul.md or identity.md outside of reflection
- Never modify immutable sections under any circumstances
- Never evolve based on a single interaction — require 3+ observations
- Never delete evolution records (they serve as audit trail)
- Never make personality changes without recording them in evolution/
