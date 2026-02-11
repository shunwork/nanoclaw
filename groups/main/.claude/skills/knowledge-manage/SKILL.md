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
