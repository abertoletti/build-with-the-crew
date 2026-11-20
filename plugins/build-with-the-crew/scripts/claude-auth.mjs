export const authExitCode = 78;

export class ClaudeAuthError extends Error {
  constructor() {
    super('Claude subscription authentication is unavailable. Use claude auth login, or run claude setup-token for unattended work and supply CLAUDE_CODE_OAUTH_TOKEN to the Codex process.');
    this.code = 'CLAUDE_AUTH_REQUIRED';
  }
}

export function requireSubscription(status) {
  if (status?.loggedIn !== true || status.apiProvider !== 'firstParty' ||
      !['claude.ai', 'oauth_token'].includes(status.authMethod)) throw new ClaudeAuthError();
}

// Only refund a round for a runtime-classified error before any specialist dispatch.
export function authenticationFailedBeforeDispatch(output) {
  let denied = false;
  for (const line of String(output ?? '').split(/\r?\n/).filter(s => s.trim())) {
    let event;
    try { event = JSON.parse(line); } catch { return false; }
    if (event.parent_tool_use_id || (Array.isArray(event.message?.content) &&
      event.message.content.some(b => b.type === 'tool_use'))) return false;
    if (event.type === 'assistant' && event.error === 'authentication_failed') denied = true;
  }
  return denied;
}
