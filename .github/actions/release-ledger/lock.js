const { randomUUID } = require('node:crypto');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const uncertain = error => [409, 422, 500, 502, 503, 504].includes(error.status) || error instanceof TypeError || error.name === 'TimeoutError' || error.name === 'AbortError';

// Share the existing atomic ref with older writers. Contention is expected:
// consumer/Enterprise jobs and the worker must wait, never steal another holder.
async function withLock(gh, repo, fn, { wait = sleep, attempts = 30, delay = 2000 } = {}) {
  const path = `/repos/${repo}/git/ref/tags/veam-release-ledger-lock`;
  const read = async () => { try { return await gh(path); } catch (error) { if (error.status === 404) return null; throw error; } };
  const head = await gh(`/repos/${repo}/git/ref/heads/main`);
  const tag = await gh(`/repos/${repo}/git/tags`, 'POST', {
    tag: 'veam-release-ledger-lock', object: head.object.sha, type: 'commit',
    message: JSON.stringify({ owner: process.env.GITHUB_RUN_ID || 'worker', repository: process.env.GITHUB_REPOSITORY || '', nonce: randomUUID(), createdAt: new Date().toISOString() }),
  });
  let acquired = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await gh(`/repos/${repo}/git/refs`, 'POST', { ref: 'refs/tags/veam-release-ledger-lock', sha: tag.sha }); acquired = true; break; }
    catch (error) {
      if (!uncertain(error)) throw error;
      // A failed response may follow a successful creation. Ownership, not the
      // response status, determines whether this invocation may enter.
      const current = await read();
      if (current?.object.sha === tag.sha) { acquired = true; break; }
      if (attempt + 1 < attempts) await wait(delay);
    }
  }
  if (!acquired) throw new Error('Release ledger is busy: waited for another writer. Retry only this recording/monitor job; if the holder was cancelled, inspect the lock before recovery.');
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
module.exports = { withLock };
