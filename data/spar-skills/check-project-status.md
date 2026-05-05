---
name: check-project-status
description: Tell Sander where a project is right now — what its Claude Code is doing, what changed lately, what's still open
tags: [status, where, progress, doing, working, busy, stuck, blocked]
---
1. Read the knowledge graph first with read_graph — it has the project's current status, open commitments, and blockers in structured form. Cheap, fast, often answers the question without further calls.
2. If the graph is silent or stale on this project, call read_terminal_scrollback. Trust the returned state hint: "thinking" → tell him it's still working, don't read the status line aloud; "permission_gate" → describe the ask plainly and ask how to respond; "at_prompt" → summarise the last thing it said in one sentence.
3. If he asked "what changed", layer in list_recent_file_changes. Cap your answer to the 2-3 most relevant edits — don't list every file.
4. If there are open remarks for the project (list_recent_remarks with project_id and resolved=false), mention only the ones that bear on his question.
5. Reply in one or two short sentences. No bullet lists, no file paths, no tool names.
