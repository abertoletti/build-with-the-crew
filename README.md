# Build with the Crew

Take a task from brief to reviewed pull request with your own team of AI agents. Build with the Crew is a Codex Desktop plugin. You work with one coordinator and configure the crew once per project.

> Open two task chats with separate worktrees. Add CSV export to the reports page in one, and fix the date filter in the other. Run the tests and have both changes reviewed.

The coordinator gives each task its own goal, branch and working copy. You can ask how the date fix is going while the export task is still running. If the export needs a product decision, the date fix can continue independently.

## How the crew works

1. **Define the change.** The task chat turns your brief into acceptance criteria. It brings in architecture or UX when the change calls for it. A UI task can send a screenshot to the UX specialist with the bundled Impeccable skill.
2. **Implement and test.** The developer works in the task's worktree. QA exercises the change using the project's test commands. Each task opens its own PR, so you can follow the diff and test results separately.
3. **Review and correct.** An independent reviewer inspects the PR diff. If it finds a defect, the task fixes the code, reruns the tests and requests another review. The previous approval cannot authorize the new commit.
4. **Finish at the PR.** By default the task leaves the reviewed PR open for you. With automatic merge enabled, the plugin checks the approved base and head and requires every configured CI check to pass. Deployment belongs to your project's pipeline.

## Why use it

- **Less coordination by hand.** Give the brief once. The task chat carries the acceptance criteria, reviewer feedback and test results through corrections.
- **A crew you can reuse.** Select skills for analysis, architecture, development, QA, UX and review. Set reasoning effort by role and choose the model and runtime for UX and review. The Claude Code adapter is built in. Other external CLIs need a compatible adapter.
- **Work you can resume.** Each task records checkpoints locally. Keep Codex running and the workstation awake for unattended work. After a restart, ask the coordinator to resume from the recorded branch, PR and review state.

## Install

You need Codex Desktop and its CLI, Git, Node.js 22 or later, and an authenticated GitHub CLI (`gh`) for github.com. Install the Claude Code CLI and sign in with a Claude subscription to use the built-in reviewer. On Windows, put the native `claude.exe` on your PATH.

Run these commands once per Codex profile:

```sh
codex plugin marketplace add abertoletti/build-with-the-crew
codex plugin add build-with-the-crew@crew-tools
```

Codex installs both workflow skills, the role skills and the supporting scripts together. Node.js runs the scripts. Installation uses the Codex plugin manager directly.

If you installed the local preview, remove it with `codex plugin remove metodo@metodo-locale` after installing the new plugin, then open a fresh chat. Existing project settings and task journals are compatible.

### Authenticate Claude

For interactive work, run `claude auth login`. For unattended work, run `claude setup-token` in your own terminal and supply the resulting secret as `CLAUDE_CODE_OAUTH_TOKEN` to the process launching Codex. Restart Codex if its environment changed. Keep the token in your secret manager. [Claude Code authentication](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)

### Configure your project

Open a fresh Codex Desktop chat in your Git repository and ask:

> Configure Build with the Crew for pull requests to main. Use this project's test commands and CI checks.

Land the generated `.agentic-method/config.json` on the remote base branch before assigning the first task. The default `ready` mode leaves reviewed PRs open. To allow automatic merge, set `integration` to `merge` and configure at least one required CI check. [Configuration and recovery](docs/configuration.md)

## Test

Run these commands from a clone of this repository.

| Command | What it exercises |
| --- | --- |
| `npm test` | Offline tests for task state, review and merge gates, and bundled skill integrity |
| `npm run test:install` | Install, discovery and upgrade in a temporary Codex profile. Requires PowerShell 7.2+ |
| `npm run test:review:live` | Two real Claude reviews of synthetic code, before and after a correction |
| `npm run test:token:live` | One real review using the secret supplied via `CLAUDE_CODE_OAUTH_TOKEN` |
| `npm run test:ux:live` | A real UX review of the bundled pickup screen using Impeccable. Requires PowerShell 7.2+ |

Live tests use your Claude subscription quota.

## License

Original code is MIT. Bundled skills retain their upstream licenses. [License](LICENSE) | [Third-party notices](plugins/metodo/role-skills/_licenses/)
