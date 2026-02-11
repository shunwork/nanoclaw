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

## Embeds

- `![[Note Name]]` embeds entire note
- `![[Note Name#Heading]]` embeds section
- `![[image.png]]` embeds image
