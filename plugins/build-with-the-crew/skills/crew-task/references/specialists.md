# External UX and code review

If Claude reports an authentication error, notify the coordinator and wait for credentials to be renewed before the next provider call. A review recorded as `awaiting-auth` can be retried on the same PR after recovery.

For Claude Code use the locally authenticated CLI and the installed plugin's scripts. The project chooses each specialist's model and skills with `roles.ux` or `roles.review`. The independent review command constructs the request from trusted base configuration and the real PR. That command manages the receipt used by verify and merge.

For a UX assessment use `node <plugin>/scripts/method.mjs ux REQUEST.json` from the project. Write the temporary JSON outside the worktree. Give it a narrowly scoped `brief`, explicit relative paths in `files` and authorized project `context`. The method resolves the project's configured runtime, model and skills. Include a rendered screenshot when asking for visual observations. If using Impeccable, run `sh <plugin>/role-skills/impeccable/scripts/impeccable context --target <target>` in the project or invoke `impeccable.cmd` on Windows. Include its authorized output in the request. Report any unavailable resource. The upstream launcher may need a network download on first use. Check the provider and the actual material covered by the user's authorization before transmitting anything.

Inspect the returned model, skill identifiers and provider evidence (`sessionId` and `agentToolUseId`) before attributing the result. Print concise progress and findings in the task chat for the coordinator. Treat a nonzero adapter exit as a failed specialist call and retain its error. Never substitute the dispatcher's opinion or a previous SHA's approval.
