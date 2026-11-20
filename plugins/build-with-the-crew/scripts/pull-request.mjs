import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendRecord, latestRecord, loadConfig, requireRepo, storageDir } from './project.mjs';
import { invokeSpecialist } from './runtime.mjs';
import { ClaudeAuthError } from './claude-auth.mjs';

const oid = /^[a-f0-9]{40}$/;

function api(...args) {
  const json = execFileSync('gh', ['api', '--hostname', 'github.com', ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GH_PROMPT_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(json);
}

function validateReview(receipt, pr, role) {
  if (!receipt || receipt.role !== 'review' || !['approved', 'changes_requested'].includes(receipt.verdict)
      || receipt.baseSha !== pr.base.sha || receipt.headSha !== pr.head.sha
      || receipt.requestedModel !== role.model || receipt.requestedEffort !== role.effort || !receipt.model || !receipt.sessionId || !receipt.agentToolUseId
      || !/^[0-9a-f]{64}$/.test(receipt.diffSha256) || JSON.stringify(receipt.skills) !== JSON.stringify(role.skills)) {
    throw new Error('Incomplete or mismatched specialist review.');
  }
}

function revisionMatches(pr, record) {
  return record?.headSha === pr.head.sha && record?.baseSha === pr.base.sha;
}

function checkStates(request, prefix, head, required) {
  if (!required.length) throw new Error('Configure the CI checks required for this pull request.');
  const endpoint = prefix + '/commits/' + head;
  const statuses = required.some(c => c.type === 'status')
    ? request(endpoint + '/statuses?per_page=100', '--paginate', '--slurp').flat() : [];
  const runs = required.some(c => c.type === 'check')
    ? request(endpoint + '/check-runs?filter=latest&per_page=100', '--paginate', '--slurp').flatMap(p => p.check_runs) : [];
  return required.map(check => {
    if (check.type === 'status') {
      // GitHub sends newest statuses first and matches context names case-insensitively.
      const latest = statuses.find(s => s.context.toLowerCase() === check.name.toLowerCase());
      return { name: check.name, state: latest?.state ?? 'missing' };
    }
    const matching = runs.filter(r => r.name === check.name && r.head_sha === head &&
      (check.appId === undefined || r.app?.id === check.appId));
    if (matching.length !== 1) return { name: check.name, state: matching.length ? 'ambiguous' : 'missing' };
    const run = matching[0];
    return { name: check.name, state: run.status === 'completed' ? (run.conclusion ?? 'unknown') : run.status };
  });
}

export function managePull(action, repository, number, briefFile, {
  cwd = process.cwd(), request = api, review = invokeSpecialist,
  configAt = loadConfig, commonDir = storageDir,
} = {}) {
  requireRepo(repository);
  if (!['review', 'review-status', 'recover-review', 'verify', 'merge'].includes(action) || !/^[1-9]\d*$/.test(number)) throw new Error('Invalid pull request command.');
  const prefix = 'repos/' + repository;
  const endpoint = prefix + '/pulls/' + number;
  const get = () => request(endpoint);
  const pr = get();
  if (pr.base?.repo?.full_name?.toLowerCase() !== repository.toLowerCase()) throw new Error('Unexpected base repository.');
  const dir = join(commonDir(cwd), 'reviews', ...repository.toLowerCase().split('/').map(s => 'r-' + s), 'pr-' + number);
  const last = latestRecord(dir);
  const revision = last?.revision ?? 0;
  if (pr.merged === true && ['merge', 'review-status'].includes(action)) {
    if (!oid.test(pr.merge_commit_sha)) throw new Error('Missing confirmed merge SHA.');
    if (action === 'merge' && last?.state === 'integrating' && last.headSha === pr.head?.sha) {
      try {
        appendRecord(dir, revision, { repository, number, baseSha: last.baseSha, headSha: last.headSha,
          state: 'merged', origin: 'server-reconciled', mergeSha: pr.merge_commit_sha, round: last.round });
      } catch (error) {
        if (latestRecord(dir)?.mergeSha !== pr.merge_commit_sha) throw error;
      }
    }
    const recorded = latestRecord(dir);
    const origin = recorded?.state === 'merged' && recorded.mergeSha === pr.merge_commit_sha
      ? recorded.origin : 'server';
    return { status: 'merged', state: 'merged', origin, mergeSha: pr.merge_commit_sha };
  }
  if (action === 'review-status' && pr.state === 'closed') return { state: 'closed', previous: last };
  if (pr.state !== 'open' || pr.draft || !oid.test(pr.base.sha) || !oid.test(pr.head?.sha)) throw new Error('Expected an open, non-draft PR with a valid base and head.');
  // A proposed change to the project policy can only take effect after it reaches the base.
  const config = configAt(cwd, pr.base.sha);
  if (config.repository.toLowerCase() !== repository.toLowerCase() || config.baseBranch !== pr.base.ref) throw new Error('PR does not match project policy.');
  const coordinates = { repository, number, baseSha: pr.base.sha, headSha: pr.head.sha };
  const role = config.roles.review;

  if (action === 'review-status') {
    if (!last) return { ...coordinates, state: 'unreviewed', revision: 0 };
    return revisionMatches(pr, last) ? last : { ...coordinates, state: 'stale', revision, previous: last };
  }
  if (action === 'recover-review') {
    if (last?.state !== 'reviewing' || String(revision) !== briefFile) throw new Error('Expected the revision of the interrupted review.');
    return appendRecord(dir, revision, { ...coordinates, state: 'interrupted', round: last.round });
  }
  if (action === 'review') {
    const brief = readFileSync(briefFile, 'utf8').trim();
    if (!brief || Buffer.byteLength(brief) > 65536) throw new Error('Expected a review brief of 1 to 65536 bytes.');
    const briefSha256 = createHash('sha256').update(brief).digest('hex');
    if (revisionMatches(pr, last) && last.state === 'integrating') throw new Error('Merge already in progress. Reconcile its server result first.');
    if (revisionMatches(pr, last) && last.briefSha256 === briefSha256 && ['approved', 'changes_requested'].includes(last.state)) {
      validateReview(last.receipt, pr, role);
      return last.receipt;
    }
    const round = (last?.round ?? 0) + 1;
    if (round > config.maxReviewRounds) throw new Error('Review budget exhausted. Report the decision to the project owner.');
    if (last?.state === 'reviewing' && revisionMatches(pr, last)) {
      throw new Error('Review is already in progress. If its process has stopped, recover this attempt before retrying.');
    }
    const attempt = appendRecord(dir, revision, { ...coordinates, state: 'reviewing', briefSha256, round });
    let receipt;
    try {
      receipt = review({ role: 'review', cwd, brief, baseSha: pr.base.sha, headSha: pr.head.sha,
        skills: role.skills, model: role.model, effort: role.effort }, role.runtime);
      validateReview(receipt, pr, role);
    } catch (error) {
      const needsLogin = error instanceof ClaudeAuthError;
      appendRecord(dir, attempt.revision, { ...coordinates, state: needsLogin ? 'awaiting-auth' : 'failed', round: needsLogin ? round - 1 : round });
      throw error;
    }
    appendRecord(dir, attempt.revision, { ...coordinates, state: receipt.verdict, briefSha256, round, receipt });
    return receipt;
  }

  if (!revisionMatches(pr, last) || !['approved', 'integrating'].includes(last.state)) throw new Error('This base and HEAD need an approved independent review.');
  validateReview(last.receipt, pr, role);
  if (last.receipt.verdict !== 'approved') throw new Error('Changes were requested.');
  if (action === 'merge' && config.integration !== 'merge') throw new Error('Project is configured to stop at a ready PR.');
  const checks = checkStates(request, prefix, pr.head.sha, config.requiredChecks);
  const blocked = checks.filter(c => c.state !== 'success');
  if (blocked.length) throw new Error('CI has not passed: ' + blocked.map(c => c.name + '=' + c.state).join(', '));
  const refreshed = get();
  if (refreshed.state !== 'open' || refreshed.draft || refreshed.base?.ref !== config.baseBranch
      || refreshed.base?.sha !== pr.base.sha || refreshed.head?.sha !== pr.head.sha) throw new Error('PR changed during verification.');
  if (latestRecord(dir)?.revision !== revision) throw new Error('Review changed during verification.');
  if (action === 'verify') return { ...coordinates, status: 'ready', checks };

  const { receipt, round } = last;
  const integrating = appendRecord(dir, revision, { ...coordinates, state: 'integrating', round, receipt });
  // The GitHub write is conditional on the server's current head and remains subject to branch rules.
  // If the response is lost, leave the claim: a retry checks the server before repeating the request.
  const args = ['--method', 'PUT', '-f', 'sha=' + pr.head.sha];
  if (config.mergeMethod) args.push('-f', 'merge_method=' + config.mergeMethod);
  const result = request(endpoint + '/merge', ...args);
  if (result.merged !== true || !oid.test(result.sha)) throw new Error('GitHub did not confirm a merge.');
  appendRecord(dir, integrating.revision, { ...coordinates, state: 'merged', origin: 'method', round, mergeSha: result.sha });
  return { ...coordinates, status: 'merged', mergeSha: result.sha, checks };
}
