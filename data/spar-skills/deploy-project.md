---
name: deploy-project
description: Ship a project to production via the deploy_project tool
tags: [deploy, ship, push, production, live, release, prod]
---
1. If Sander hasn't named the project, ask which one — don't guess. Use list_projects only when he's vague enough that you actually need it.
2. Check the project's terminal state with read_terminal_scrollback. If something is mid-flight (state="thinking" or a permission_gate is open), tell him and stop — deploying on top of an in-progress task is how branches get clobbered.
3. Briefly confirm the deploy aloud ("deploy badkamerstijl?") and wait for a clear yes. Skip the confirm if autopilot is on AND he just told you to deploy in this turn — otherwise always ask.
4. Call deploy_project. Don't read the project_id back at him.
5. After the tool returns, say something short — "shipped" or "live" — and only mention the URL if he asks. If the tool reports a failure, summarise the reason in one sentence and ask whether to retry.
