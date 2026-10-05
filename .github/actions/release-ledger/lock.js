const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uncertain = error => [409, 422, 500, 502, 503, 504].includes(error.status) || error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError';

// Exact Actions attempt provenance is prerequisite evidence, not recovery authority.
function lockOwner(env = process.env) {
  const repository = env.GITHUB_REPOSITORY || '';
  if (!env.GITHUB_RUN_ID) return { owner: 'worker', repository, kind: 'unknown', nonce: randomUUID(), createdAt: new Date().toISOString() };
  if (!/^[1-9]\d*$/.test(env.GITHUB_RUN_ID) || !/^[1-9]\d*$/.test(env.GITHUB_RUN_ATTEMPT || '') || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Exact GitHub lock ownership requires repository, run ID and run attempt');
  return { owner: env.GITHUB_RUN_ID, repository, kind: 'github-actions', runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT, nonce: randomUUID(), createdAt: new Date().toISOString() };
}

// Share the existing atomic ref with older writers. Contention is expected:
// consumer/Enterprise jobs and the worker must wait, never steal another holder.
async function withLock(gh, repo, fn, {
  wait = sleep, now = () => performance.now(), delay = 2000,
  timeoutMs = Number(process.env.RELEASE_LEDGER_LOCK_WAIT_MS || 300000),
  attempts = Infinity,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('Release ledger lock timeoutMs / RELEASE_LEDGER_LOCK_WAIT_MS must be a non-negative safe integer in milliseconds.');
  if (!Number.isSafeInteger(delay) || delay <= 0) throw new Error('Release ledger lock delay must be a positive safe integer in milliseconds.');
  if (attempts !== Infinity && (!Number.isSafeInteger(attempts) || attempts <= 0)) throw new Error('Release ledger lock attempts must be a positive safe integer.');
  const path = `/repos/${repo}/git/ref/tags/veam-release-ledger-lock`;
  const read = async () => { try { return await gh(path); } catch (error) { if (error.status === 404) return null; throw error; } };
  const head = await gh(`/repos/${repo}/git/ref/heads/main`);
  const tag = await gh(`/repos/${repo}/git/tags`, 'POST', {
    tag: 'veam-release-ledger-lock', object: head.object.sha, type: 'commit',
    message: JSON.stringify(lockOwner()),
  });
  // Start the contention budget after preparing our ownership tag. Use a
  // monotonic clock and count API time as well as sleeps. In-flight requests
  // still have to settle so an uncertain successful creation can be reconciled.
  const started = now();
  let acquired = false, count = 0, holder = null, lastError;
  while (count < attempts && (count === 0 || now() - started < timeoutMs)) {
    count++;
    try { await gh(`/repos/${repo}/git/refs`, 'POST', { ref: 'refs/tags/veam-release-ledger-lock', sha: tag.sha }); acquired = true; break; }
    catch (error) {
      if (!uncertain(error)) throw error;
      // A failed response may follow a successful creation. Ownership, not the
      // response status, determines whether this invocation may enter.
      const current = await read();
      if (current?.object.sha === tag.sha) { acquired = true; break; }
      holder = current?.object.sha || null;
      lastError = error.status || error.name;
      const remaining = timeoutMs - (now() - started);
      if (count >= attempts || remaining <= 0) break;
      await wait(Math.min(delay, remaining));
    }
  }
  if (!acquired) throw new Error(`Release ledger is busy: lock acquisition stopped after ${Math.ceil(now() - started)}ms (budget ${timeoutMs}ms, ${count} attempts; ${repo} refs/tags/veam-release-ledger-lock; last observed holder: ${holder || 'none'}; last acquisition error: ${lastError}). Retry only this recording/monitor job; if the holder was cancelled, inspect the lock before recovery. Never delete an active writer's lock.`);
  let result, failure;
  try { result = await fn(); } catch (error) { failure = error; }
  try {
    for (let attempt = 0; ; attempt++) {
      const current = await read();
      if (!current || (attempt > 0 && current.object.sha !== tag.sha)) break;
      if (current.object.sha !== tag.sha) throw new Error('Release lock ownership changed; operator recovery required.');
      try { await gh(path.replace('/git/ref/', '/git/refs/'), 'DELETE'); break; }
      catch (error) { if (!uncertain(error) || attempt >= 2) throw error; await wait(delay); }
    }
  } catch (error) { if (!failure) throw error; console.error('Release lock cleanup failed:', error.message); }
  if (failure) throw failure;
  return result;
}
module.exports = { withLock, lockOwner };
