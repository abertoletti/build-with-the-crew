---
name: metodo-coordinator
description: Coordinate software delivery across task chats and Git worktrees in Codex Desktop. Use when assigning one or more development tasks through the Build with the Crew plugin, configuring a project for this method, or checking the progress of its tasks.
---

Work in the user's language. Resolve the installed plugin root two directories above this skill. Run its `scripts/method.mjs` with Node from the intended repository. Never assume that the plugin directory is the project directory.

## Set up a repository

Identify the GitHub repository, base branch, existing test commands and CI checks from the project. Run `node <plugin>/scripts/method.mjs init OWNER/REPO BASE` once. Subsequent `config` reads the effective configuration. Discuss project-specific settings and edit the existing file on request. Record check names and optional producing GitHub App IDs from an actual pull request. Commit the configuration to the intended base branch through the project's usual process so the integration gate can read it. The default integration mode delivers a reviewed PR ready for a human. Configure `merge` with the owner's authorization when the method should integrate automatically. Use a real configured check in addition to the independent review.

Read the effective role settings with `config`. If `roles.coordinator.effort` is set, compare it with the current chat setting when visible. If it differs or cannot be verified, ask the user to select or confirm the level in the chat's model controls. A running chat cannot change its own effort through a prompt.

## Assign and observe

Use an explicit, stable task ID per independent outcome and preserve it across retries. Keep acceptance criteria, allowed external providers/data, intended base and integration policy in the task brief. For two independent tasks register and dispatch both before waiting on either. Do not combine tasks that require a human decision with unrelated work.

1. From the project root, write the brief to a local temporary text file. Use `checkpoint ID 0 assigned NOTE_FILE` on the bundled CLI. `status ID` returns the latest revision. Reconcile an existing assignment with its recorded chat and the host's chat list before starting or retrying a dispatch. Expected revision 0 creates revision 1 with the original brief. The journal is shared among the repository's worktrees.
2. Use Codex Desktop's actual project and chat tools. For an authorized task chat and worktree, request a separate chat in that project with a dedicated worktree. When `roles.task.effort` is set, pass it in the new chat tool's `thinking` field. If the tool cannot apply it, surface the limitation before dispatch. Send its objective and explicitly request a native goal through completion, the role `metodo-task`, the task ID, checkout, brief, authorized provider and the expected result. Keep the chat or pending worktree setup ID in the local journal. If the host lacks those tools or requires explicit authorization for the new chat, surface the exact missing capability. Never represent a tool invocation as completed before the host acknowledges it.
3. The task chat owns its branch and PR. Keep the coordinator available for conversation. For a status question, consult the journal and the host's latest chat status. Use bounded multi-chat waits while monitoring active tasks. After a restart reconcile IDs with chats, worktrees and open PRs before resuming. Delivery of updates to an idle coordinator depends on the host. When one task pauses, continue its independent peers.

All `method.mjs` subcommands operate on the current repository. From a different directory use the execution tool's working-directory parameter.

## Resume after an authentication failure

When Claude reports a subscription authentication failure or a PR shows `awaiting-auth`, pause the affected external calls and let independent work continue. Offer `claude auth login` for interactive use or `claude setup-token` for unattended subscription work. The user supplies the generated secret via `CLAUDE_CODE_OAUTH_TOKEN` to the process launching Codex and restarts Codex if its environment changed. Keep the token out of chat, repository files, briefs and logs. After the user's confirmation, resume from the recorded task and PR. For connectivity, quota and reviewer errors, report their actual cause.
