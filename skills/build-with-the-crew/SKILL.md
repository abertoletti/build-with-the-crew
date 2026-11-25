---
name: build-with-the-crew
description: Set up Build with the Crew in Codex Desktop and verify the specialist skills available to its task chats. Use when someone asks to install the Crew plugin, configure it for a repository, or check whether a project is ready to assign tasks.
---

# Build with the Crew

Assign work in one Codex Desktop coordinator chat. Each task gets its own chat and Git worktree. The task calls the configured specialists and takes changes through independent review, tests, and pull request readiness. The project's integration settings determine whether it can also merge.

## Install the plugin

This entry skill guides setup. The Codex plugin supplies the coordinator, task workflow, default role skills, scripts, and local dashboard.

Check whether `build-with-the-crew@crew-tools` is already installed and enabled in Codex. If installation is needed and the user asked for it, register the marketplace and add the plugin in their Codex profile. Skip marketplace registration if the official source is already present.

```sh
codex plugin marketplace add abertoletti/build-with-the-crew
codex plugin add build-with-the-crew@crew-tools
```

If the CLI is unavailable, give the user the [installation instructions](https://github.com/abertoletti/build-with-the-crew#install). After a new installation, start a fresh Codex Desktop chat in the target Git repository and use the plugin's `crew-coordinator` skill.

## Configure and verify

Ask the coordinator to configure the project when requested. It uses the repository's test commands, CI checks, and intended base branch to set up `.build-with-the-crew/config.json`. The default integration mode leaves a reviewed PR open for a human.

Locate the active plugin bundle from the installed `crew-coordinator` skill. From the configured project checkout, run `node <plugin>/scripts/method.mjs doctor`. Report missing required skills and optional warnings with the affected role. Repeat the check from the actual task environment when it differs from the coordinator's. Use the [cloud setup guide](https://github.com/abertoletti/build-with-the-crew/blob/main/docs/configuration.md#cloud-setup) for a remote execution environment.

See the [project documentation](https://github.com/abertoletti/build-with-the-crew/blob/main/docs/configuration.md) for role overrides, external provider setup, and recovery.
