# Build with the Crew privacy policy

Build with the Crew coordinates coding tasks in the Codex desktop app. The plugin has no publisher-operated backend and sends no analytics or telemetry to its publisher. It uses your existing GitHub connection and the specialist CLI you configure to do the work you request.

## Data used and recipients

- **Codex.** You supply task briefs and may let Codex access project files, test output and local task records needed for the assignment. Codex handles that context and conversation history under your OpenAI account and workspace settings.
- **GitHub.** Git and GitHub CLI use your existing account to fetch repository and pull request information and to publish branches or pull requests as requested. If you enable automatic merge, the plugin requests a merge when the configured review and CI requirements are met. GitHub retains repository content and activity under your GitHub settings and the repository owner's policies.
- **External specialists.** The provider you configure can receive task briefs, PR diffs, screenshots and selected project context for review or UX work. This material can contain names or other personal information present in the project. The workflow instructs the task agent to confirm that you have authorized the provider and the material before sending it. The bundled adapter uses Claude Code and its existing sign-in. Provider processing and retention are governed by your agreement and settings with that provider. Custom adapters follow their own data handling. The Impeccable launcher may download its upstream engine when it is missing locally.
- **Support.** If you choose to post a GitHub issue, the information you include goes to GitHub and is visible to people who can view that issue. Use the reporting link below and omit private code, credentials and personal information.

## Local retention and controls

The plugin keeps task briefs, decisions, status, pull request identifiers, commit IDs, diff hashes, review results, specialist model IDs and provider session IDs under the repository's shared Git directory. New projects use `build-with-the-crew/` and existing projects keep using their existing journal. These records stay on your computer until you delete them. They support resuming work and checking review history. The adapters remove their own staging directories when a call finishes or returns an error. A forced stop may leave staged copies, and task briefs written separately may also remain in the local temporary directory until deleted.

You can control the files and repositories Codex can access, choose the specialist provider and material to share, or decline to send that material. The journal contains separate task and review records. You can delete the relevant local records after work is complete. If you remove a review record, the plugin needs a new review before it can verify that pull request. Manage conversations, GitHub content and external provider data through the controls offered by each service. The plugin uses the CLIs' own authentication and does not ask for credentials in a chat or task brief.

[Report a privacy question](https://github.com/abertoletti/build-with-the-crew/issues)
