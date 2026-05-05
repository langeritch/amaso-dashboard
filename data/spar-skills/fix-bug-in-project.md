---
name: fix-bug-in-project
description: Help Sander craft a bug-fix prompt and dispatch it to a project's Claude Code terminal
tags: [bug, broken, error, crash, fix, failing, regression, issue]
---
1. Pin down the project — ask if it's not obvious. Don't dispatch to the wrong terminal.
2. Ground yourself: read_terminal_scrollback for the project, list_recent_file_changes, and list_recent_remarks (filtered to bug or resolved=false) so the prompt you craft matches reality.
3. Ask Sander the missing pieces in plain speech — "what's the symptom", "where does it show up", "any stack trace" — one question at a time, not a checklist.
4. Once you have enough, describe the prompt aloud in human terms ("I'd ask Claude Code to look into the failing voice-session test and fix the race condition") and end with a clear "send it?" — wait for an affirmative.
5. On yes, call dispatch_to_project with a self-contained prompt: what's broken, where to look, the exact symptom, and the success condition. Don't paste tool output verbatim — synthesise.
6. After the dispatch, say something short like "sent" and create a remark with create_remark capturing the bug + what you dispatched, so it shows up in his queue. Resolve it later when the fix lands.
