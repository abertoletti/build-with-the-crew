import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authenticationFailedBeforeDispatch, ClaudeAuthError, requireSubscription } from '../plugins/build-with-the-crew/scripts/claude-auth.mjs';

test('accepts both subscription modes reported by the CLI and rejects other credential sources', () => {
  for (const authMethod of ['oauth_token', 'claude.ai']) {
    const status = { loggedIn: true, apiProvider: 'firstParty', authMethod };
    requireSubscription(status);
    assert.throws(() => requireSubscription({ ...status, loggedIn: false }), ClaudeAuthError);
    assert.throws(() => requireSubscription({ ...status, apiProvider: 'bedrock' }), ClaudeAuthError);
  }
  assert.throws(() => requireSubscription({ loggedIn: true, apiProvider: 'firstParty', authMethod: 'api_key' }), ClaudeAuthError);
});

test('only an authentication event before dispatch qualifies for recovery without charging a round', () => {
  const denied = JSON.stringify({ type: 'assistant', error: 'authentication_failed' });
  const dispatch = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent' }] } });
  assert.equal(authenticationFailedBeforeDispatch(denied), true);
  assert.equal(authenticationFailedBeforeDispatch([dispatch, denied].join('\n')), false);
  assert.equal(authenticationFailedBeforeDispatch('not JSON'), false);
  assert.equal(authenticationFailedBeforeDispatch(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: denied }] } })), false);
});
