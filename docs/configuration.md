# Project configuration

The following example targets GitHub Actions and a project that authorizes merge after a reviewed change and a successful job named `test`. Replace the repository and check name with actual values.

```json
{
  "version": 1,
  "repository": "example/project",
  "baseBranch": "main",
  "integration": "merge",
  "requiredChecks": [{ "type": "check", "name": "test" }],
  "testCommands": ["npm test"],
  "mergeMethod": "squash",
  "maxReviewRounds": 3,
  "roles": {
    "coordinator": { "effort": "medium" },
    "task": { "effort": "medium" },
    "analyst": { "effort": "medium" },
    "architect": { "effort": "high" },
    "qa": { "effort": "medium" },
    "developer": { "effort": "high", "skills": ["test-driven-development", "systematic-debugging"] },
    "ux": { "runtime": "claude-code", "model": "opus", "effort": "medium", "skills": ["impeccable"] },
    "review": { "runtime": "claude-code", "model": "opus", "effort": "high", "skills": ["code-review-excellence"] }
  }
}
```

The two integration modes are `ready` (leave the PR open) and `merge` (allow automatic merge). Both the `verify` and `merge` commands require independent approval and at least one named CI check. Initialization selects `ready` with no checks. Until you configure CI, the task can report a reviewed PR but cannot verify readiness. A `status` entry selects a classic commit status. A `check` entry selects a completed check run by exact name and optionally by producing GitHub App ID (`appId`). An ambiguous name blocks the gate. The review command fetches the PR coordinates from GitHub and reads configuration at the base commit. Fetch the base and check out the PR head locally before running it.

Upgrading a project from 0.2.0? Move its existing `.agentic-method/config.json` to `.build-with-the-crew/config.json` and commit the move to the base branch. Current versions read only the new path. The local task journal stays in the shared Git directory.

## Skills

The plugin includes the default role instructions and their bundled resources. Each role can select packaged names such as `test-driven-development` or use `project:release-checklist` for `.agents/skills/release-checklist/SKILL.md`. Keep the full skill directory with its references and give `SKILL.md` the matching `name`. To use a skill distributed by another plugin, add a permitted, versioned copy of its skill folder to the project. The project selector is resolved in the task's checkout. For independent reviews, project skills and their resources are read from the PR base commit.

```json
{
  "developer": {
    "skills": ["test-driven-development", "project:release-checklist"],
    "optionalSkills": ["project:performance-tips"]
  }
}
```

Run `node <plugin>/scripts/method.mjs doctor` from the task checkout, or pass a role such as `doctor developer`. The JSON report lists resolved skill directories and problems by role. A missing required skill exits with status 1. An optional skill reports a warning and exits with status 0. The task pauses an affected phase and routes the fix through the coordinator. Provider authentication and skill-specific tools are separate. The first Impeccable run needs a compatible cached engine or access to its verified upstream download. [Pinned sources and licenses](../plugins/build-with-the-crew/role-skills/sources.lock.json)

## Cloud setup

Commit project skills under `.agents/skills/` on the branch a cloud task will use. For a reusable Codex Cloud environment, prepare the Crew bundle in the environment's **Install script**, using a pinned release or commit. For example, on a fresh Linux environment with access to the repository:

```sh
crew_dir="$HOME/.local/share/build-with-the-crew/v0.3.0"
mkdir -p "$(dirname "$crew_dir")"
test -d "$crew_dir/plugins/build-with-the-crew" ||
  git clone --depth 1 --branch v0.3.0 https://github.com/abertoletti/build-with-the-crew.git "$crew_dir"
```

Publish the environment and start a fresh task in your project. Give the task the absolute bundle path printed by `printf '%s\n' "$HOME/.local/share/build-with-the-crew/v0.3.0/plugins/build-with-the-crew"`. Have it read `skills/crew-task/SKILL.md` there and run `node <bundle>/scripts/method.mjs doctor` from the checkout. Use the cloud environment's secrets and network settings for any authorized external adapters. The local desktop install and its credentials are specific to that machine. [Codex Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environments)

## Reasoning effort

Set `roles.<role>.effort` in `.build-with-the-crew/config.json`. The example above is a starting point. Omit a field to keep that runtime's existing default. Effort is a request to the model. The number of reasoning tokens actually used can vary.

| Role | Where the setting takes effect |
| --- | --- |
| `coordinator` | Select the configured effort in the existing Codex chat's model controls. The plugin cannot change an active chat's setting. |
| `task` | The coordinator passes `thinking` when creating a task chat. Set this independently of the specialist roles. |
| `analyst`, `architect`, `developer`, `qa` | The task requests `reasoning_effort` when launching a native Codex agent for that role. A role performed inline uses the task chat's effort. If an explicit role setting cannot be applied, the task reports the limitation and pauses that role. |
| `ux`, `review` | The adapter sets `effort` on the named Claude subagent. A custom adapter receives `effort` in its request and must apply it or fail. |

The common configuration levels are `low`, `medium`, `high`, `xhigh` and `max`. Native Codex roles also accept `ultra` when the selected model and host support it. Model support varies. Claude's `CLAUDE_CODE_EFFORT_LEVEL` environment setting takes precedence over subagent settings. The built-in adapter rejects a conflicting environment value. Specialist receipts record the requested level. [Claude Code subagent effort](https://code.claude.com/docs/en/sub-agents#choose-an-effort-level)

## Provider adapters

The built-in runtime is `claude-code`. To use another authenticated CLI, register a trusted local wrapper that implements protocol version 1. Set the environment variable `CREW_ADAPTERS_FILE` to the absolute path of a JSON file under your control. Existing adapter settings continue to work. If you set the new variable, it takes precedence. Example for a Unix workstation:

```json
{
  "version": 1,
  "adapters": {
    "team-reviewer": {
      "command": "/usr/bin/node",
      "args": ["/opt/team-tools/reviewer.mjs"]
    }
  }
}
```

Set `roles.review.runtime` to `team-reviewer` and set its `model` to the identifier the wrapper expects. On Windows use absolute executable and script paths for your machine. The process receives the path to one request JSON as its final argument, with a temporary directory as its working directory. The request field `cwd` points to the staged attachment directory. Resolve entries in `files` relative to that field. The request also includes `role`, `brief`, `model`, `skills`, `skillRoot` and optional `context`. For a review it also receives `baseSha`, `headSha`, `diffPath` and `diffSha256`.

The wrapper emits one JSON object on stdout with `role`, `requestedModel`, the actual `model`, ordered `skills`, `summary`, `sessionId` and `agentToolUseId`. For a custom runtime, use its provider-side session ID and specialist invocation ID for `sessionId` and `agentToolUseId`. When the request specifies `effort`, also return the same level as `requestedEffort` after applying it. Review responses also include both SHAs, the diff digest and a verdict of `approved` or `changes_requested`. A failure exits nonzero. Build with the Crew checks the returned evidence against the request. The registered wrapper is responsible for obtaining truthful provider-side evidence and has the local user's process permissions. Supply your own wrapper for other runtimes.

## Recovery and merge checks

Ask the coordinator for the path to its installed `crew-coordinator/SKILL.md`. The plugin root is the directory containing `skills/` and `scripts/`. From your project, run `node <installed-plugin>/scripts/method.mjs --help` for the exact commands. They use the current Git repository. The coordinator and task skills normally invoke them on your behalf.

- `checkpoint`, `status` and `history` use task IDs and revisions. New journals live in `build-with-the-crew/` under the repository's shared Git directory. Existing journals continue to be used in place. Each write publishes a complete revision. Worktrees see the same journal. If a process stops before publication, its previous revision remains readable.
- `review` binds the result to the PR base and head, the reviewer's observed model and the diff digest. A review requesting changes goes back to the developer. `maxReviewRounds` limits attempts per PR. A recognized authentication failure before dispatch records `awaiting-auth` and preserves the round. Restore credentials and retry. The same base, head and brief reuse the latest completed review when it still matches. For a terminated process, run `review-status OWNER/REPO PR`, check the task chat or local process supervisor for the reviewer process exit, then pass the numeric review journal field `revision` to `recover-review OWNER/REPO PR REVISION`. Recovery releases that attempt and retains the round it consumed. A late result cannot supersede recovery.
- `verify` checks the matching approval and all configured CI results and re-reads the PR. `merge` also sends the verified head SHA to GitHub as a server-side precondition. After a lost response, repeat the command to inspect the server result. Enable GitHub branch rules for requirements that must apply to every client. In particular, a strictly current base or a merge queue needs server enforcement. The direct merge command respects server rejection and does not implement queue management.
- The local journal assumes a trusted workspace and operating-system user. Treat project data sent to an external CLI as a provider transfer. Its login, permissions and quotas apply. Stop the affected task on an unverifiable review, unavailable provider or exhausted budget. Ask the coordinator for progress. It uses the task chat for details and routes decisions back to that task.

## Dashboard data

The dashboard reads the task and review journals and shows up to 24 recent checkpoints per task or PR. It binds to loopback and uses a per-process access token in the link. Keep the link private. Checkpoint notes, review bodies and agent transcripts stay out of the dashboard response.

Motion highlights newly observed journal writes. A review verdict travels back toward the task, and the activity list highlights its new entry. Recorded history remains static on load. Use **Pause motion** to stop effects while updates continue, or enable reduced motion in your system settings.

`checkpoint TASK_ID EXPECTED_REVISION STAGE NOTE_FILE [CONTEXT_FILE]` accepts a JSON object with optional `title`, `threadId`, `hostId`, `branch`, `worktree` (strings) and `prNumber` (positive integer). Subsequent checkpoints preserve these fields. The dashboard joins a review to a task when the configured repository and recorded PR number match. Task chats can write native subagent start and end events with `agent-event`. If a worker cannot reach the watched journal, its events remain in the worker chat until recorded there by an authorized observer.

## Human decisions

Ask and answer product decisions in the coordinator chat. The task writes a `waiting-human` checkpoint and a structured handoff. Each request has a task and decision ID. An answer remains in the coordinator inbox until the task acknowledges receipt.

Worktrees of the same repository share an inbox. A cloud checkout and a local checkout have separate journals. For those tasks, the coordinator imports the handoff from the assigned chat and returns the authorized answer to that chat on its original host. The coordinator reconciles pending decisions when it monitors tasks and on its next turn. Instant notification of an idle chat requires a host-supported callback. Native approval dialogs follow the host's approval flow.

The local journal retains the question, answer and acknowledgement so a restart or repeated handoff does not lose the decision. Use `node <installed-plugin>/scripts/method.mjs --help` for the decision commands.
