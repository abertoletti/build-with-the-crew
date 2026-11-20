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

The skill catalog is installed with the plugin. It includes Superpowers, Impeccable and specialist instructions for product analysis, architecture, code review and QA. The project can select different packaged skills per role. The first Impeccable run needs its compatible engine in cache or network access for its upstream verified download. [Pinned sources and licenses](../plugins/build-with-the-crew/role-skills/sources.lock.json)

Upgrading a project from 0.2.0? Move its existing `.agentic-method/config.json` to `.build-with-the-crew/config.json` and commit the move to the base branch. Version 0.2.1 reads only the new path. The local task journal stays in the shared Git directory.

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

The built-in runtime is `claude-code`. To use another authenticated CLI, register a trusted local wrapper that implements protocol version 1. Set the environment variable `METODO_ADAPTERS_FILE` to the absolute path of a JSON file under your control. Example for a Unix workstation:

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

Ask the coordinator for the path to its installed `metodo-coordinator/SKILL.md`. The plugin root is the directory containing `skills/` and `scripts/`. From your project, run `node <installed-plugin>/scripts/method.mjs --help` for the exact commands. They use the current Git repository. The coordinator and task skills normally invoke them on your behalf.

- `checkpoint`, `status` and `history` use task IDs and revisions. The journal lives under the repository's shared Git directory in `metodo/`. Each write publishes a complete revision. Worktrees see the same journal. If a process stops before publication, its previous revision remains readable.
- `review` binds the result to the PR base and head, the reviewer's observed model and the diff digest. A review requesting changes goes back to the developer. `maxReviewRounds` limits attempts per PR. A recognized authentication failure before dispatch records `awaiting-auth` and preserves the round. Restore credentials and retry. The same base, head and brief reuse the latest completed review when it still matches. For a terminated process, run `review-status OWNER/REPO PR`, check the task chat or local process supervisor for the reviewer process exit, then pass the numeric review journal field `revision` to `recover-review OWNER/REPO PR REVISION`. Recovery releases that attempt and retains the round it consumed. A late result cannot supersede recovery.
- `verify` checks the matching approval and all configured CI results and re-reads the PR. `merge` also sends the verified head SHA to GitHub as a server-side precondition. After a lost response, repeat the command to inspect the server result. Enable GitHub branch rules for requirements that must apply to every client. In particular, a strictly current base or a merge queue needs server enforcement. The direct merge command respects server rejection and does not implement queue management.
- The local journal assumes a trusted workspace and operating-system user. Treat project data sent to an external CLI as a provider transfer. Its login, permissions and quotas apply. Stop the affected task on an unverifiable review, unavailable provider or exhausted budget. Ask the coordinator for progress. It uses the task chat for details and routes decisions back to that task.
