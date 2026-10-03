const {test}=require('node:test');
const assert=require('node:assert/strict');
const {withLock}=require('./lock');
function fixture(){let owner=null,sequence=0;const writes=[];return {writes,get owner(){return owner},set owner(x){owner=x},gh:async(path,method,body)=>{if(path.endsWith('/heads/main'))return {object:{sha:'a'.repeat(40)}};if(path.endsWith('/git/tags'))return {sha:'tag'+(++sequence)};if(method==='POST'){writes.push(body);if(owner)throw Object.assign(new Error('Reference already exists'),{status:422});owner=body.sha;return {}};if(method==='DELETE'){writes.push('delete '+owner);owner=null;return {}};if(!owner)throw Object.assign(new Error('not found'),{status:404});return {object:{sha:owner}}}}}
const options={attempts:4,delay:1};
test('parallel consumer and Enterprise writers both complete without overlapping',async()=>{const f=fixture();let active=0,maximum=0,finished=0;const run=()=>withLock(f.gh,'repo',async()=>{active++;maximum=Math.max(maximum,active);await new Promise(r=>setTimeout(r,2));active--;finished++}, {...options,attempts:20});await Promise.all([run(),run()]);assert.equal(maximum,1);assert.equal(finished,2);assert.equal(f.owner,null)});
test('busy holder is never stolen and timeout identifies the retry action',async()=>{const f=fixture();f.owner='other';let entered=false;await assert.rejects(withLock(f.gh,'repo',async()=>{entered=true},options),/busy.*Retry only/);assert.equal(entered,false);assert.equal(f.owner,'other');assert.ok(!f.writes.some(x=>typeof x==='string'))});
test('uncertain successful acquisition is reconciled by our unique tag',async()=>{const f=fixture();let lost=true,entered=0;const gh=async(...args)=>{const result=await f.gh(...args);if(args[0].endsWith('/git/refs')&&lost){lost=false;throw Object.assign(new Error('502'),{status:502})}return result};await withLock(gh,'repo',async()=>entered++,options);assert.equal(entered,1);assert.equal(f.owner,null)});
test('uncertain creation that did not commit retries without entering early',async()=>{const f=fixture();let first=true;const gh=async(...args)=>{if(args[0].endsWith('/git/refs')&&first){first=false;throw new TypeError('fetch failed')}return f.gh(...args)};await withLock(gh,'repo',async()=>assert.equal(f.owner,'tag1'),options);assert.equal(f.owner,null)});
test('an uncertain delete cannot delete the next holder',async()=>{const f=fixture();let first=true;const gh=async(...args)=>{const result=await f.gh(...args);if(args[1]==='DELETE'&&first){first=false;f.owner='next-holder';throw Object.assign(new Error('502'),{status:502})}return result};await withLock(gh,'repo',async()=>{},options);assert.equal(f.owner,'next-holder');assert.equal(f.writes.filter(x=>typeof x==='string').length,1)});
test('permission failure is immediate and never enters the protected operation',async()=>{const f=fixture();let waited=0,entered=false;const gh=async(...args)=>{if(args[0].endsWith('/git/refs'))throw Object.assign(new Error('403'),{status:403});return f.gh(...args)};await assert.rejects(withLock(gh,'repo',async()=>{entered=true},{...options,wait:async()=>{waited++}}),/403/);assert.equal(waited,0);assert.equal(entered,false)});
test('a failed protected operation releases its own lock',async()=>{const f=fixture(),error=new Error('Notion failed');await assert.rejects(withLock(f.gh,'repo',async()=>{throw error},options),e=>e===error);assert.equal(f.owner,null)});

function clock(onWait = () => {}) {
  let time = 0;
  const waits = [];
  return {
    waits,
    now: () => time,
    advance: ms => { time += ms; },
    wait: async ms => { waits.push(ms); time += ms; onWait(time); },
  };
}

for (const heldMs of [105000, 120000, 240000]) {
  test(`default budget waits for a ${heldMs}ms holder without stealing`, async () => {
    const f = fixture();
    f.owner = 'worker';
    const timer = clock(time => { if (time >= heldMs) f.owner = null; });
    let entered = 0;
    await withLock(f.gh, 'repo', async () => {
      assert.ok(timer.now() >= heldMs);
      assert.equal(f.owner, 'tag1');
      entered++;
    }, timer);
    assert.equal(entered, 1);
    assert.ok(f.writes.filter(x => typeof x === 'object').length > 30);
    assert.deepEqual(f.writes.filter(x => typeof x === 'string'), ['delete tag1']);
    assert.equal(f.owner, null);
  });
}

test('default budget stops at five minutes and leaves the holder untouched', async () => {
  const f = fixture(), timer = clock();
  f.owner = 'worker';
  await assert.rejects(withLock(f.gh, 'repo', () => assert.fail('entered'), timer), /300000ms \(budget 300000ms, 150 attempts/);
  assert.equal(timer.now(), 300000);
  assert.equal(f.owner, 'worker');
  assert.equal(f.writes.length, 150);
});

test('custom deadline caps the last sleep and reports useful contention details', async () => {
  const f = fixture(), timer = clock();
  f.owner = 'other-tag';
  await assert.rejects(withLock(f.gh, 'VeamStudios/.github', () => assert.fail('entered'), {
    ...timer, timeoutMs: 5000,
  }), error => {
    assert.match(error.message, /after 5000ms \(budget 5000ms, 3 attempts/);
    assert.match(error.message, /VeamStudios\/\.github refs\/tags\/veam-release-ledger-lock/);
    assert.match(error.message, /last observed holder: other-tag; last acquisition error: 422/);
    assert.match(error.message, /Retry only this recording\/monitor job/);
    return true;
  });
  assert.deepEqual(timer.waits, [2000, 2000, 1000]);
  assert.equal(f.owner, 'other-tag');
  assert.ok(f.writes.every(x => typeof x === 'object'));
});

test('acquisition and reconciliation latency count against the deadline', async () => {
  const f = fixture(), timer = clock();
  f.owner = 'worker';
  const gh = async (...args) => {
    if (args[0].endsWith('/git/refs')) timer.advance(1200);
    if (args[0].endsWith('/git/ref/tags/veam-release-ledger-lock')) timer.advance(800);
    return f.gh(...args);
  };
  await assert.rejects(withLock(gh, 'repo', () => assert.fail('entered'), {
    ...timer, timeoutMs: 5000,
  }), /after 6000ms \(budget 5000ms, 2 attempts/);
  assert.deepEqual(timer.waits, [2000]);
  assert.equal(f.writes.length, 2);
  assert.equal(f.owner, 'worker');
});

test('an oversleep does not start another acquisition after the deadline', async () => {
  const f = fixture(), timer = clock();
  f.owner = 'worker';
  await assert.rejects(withLock(f.gh, 'repo', () => assert.fail('entered'), {
    ...timer, timeoutMs: 3000,
    wait: async ms => { timer.advance(ms + 2000); f.owner = null; },
  }), /after 4000ms.*1 attempts/);
  assert.equal(f.writes.length, 1);
});

test('an uncertain successful creation is reconciled even after the deadline', async () => {
  const f = fixture(), timer = clock();
  let entered = 0;
  const gh = async (...args) => {
    const result = await f.gh(...args);
    if (args[0].endsWith('/git/refs')) {
      timer.advance(6000);
      throw Object.assign(new Error('response lost'), { status: 502 });
    }
    return result;
  };
  await withLock(gh, 'repo', async () => { entered++; }, { ...timer, timeoutMs: 5000 });
  assert.equal(entered, 1);
  assert.equal(f.owner, null);
  assert.deepEqual(timer.waits, []);
});

test('zero budget tries once, succeeds if free, and never waits if busy', async () => {
  const f = fixture(), timer = clock();
  assert.equal(await withLock(f.gh, 'repo', async () => 'result', { ...timer, timeoutMs: 0 }), 'result');
  f.owner = 'other';
  await assert.rejects(withLock(f.gh, 'repo', () => assert.fail('entered'), { ...timer, timeoutMs: 0 }), /budget 0ms, 1 attempts/);
  assert.equal(f.owner, 'other');
  assert.deepEqual(timer.waits, []);
});

test('explicit legacy attempt cap remains supported', async () => {
  const f = fixture(), timer = clock();
  f.owner = 'other';
  await assert.rejects(withLock(f.gh, 'repo', () => assert.fail('entered'), {
    ...timer, attempts: 3, delay: 10,
  }), /after 20ms.*3 attempts/);
  assert.deepEqual(timer.waits, [10, 10]);
  assert.equal(f.writes.length, 3);
});

test('transport failures without a holder exhaust the budget without entering', async () => {
  const f = fixture(), timer = clock();
  const gh = async (...args) => {
    if (args[0].endsWith('/git/refs')) throw new TypeError('fetch failed');
    return f.gh(...args);
  };
  await assert.rejects(withLock(gh, 'repo', () => assert.fail('entered'), {
    ...timer, timeoutMs: 3000,
  }), /last observed holder: none; last acquisition error: TypeError/);
  assert.deepEqual(timer.waits, [2000, 1000]);
  assert.equal(f.owner, null);
});

test('failed ownership reads propagate immediately rather than assuming ownership', async () => {
  const f = fixture(), timer = clock(), failure = new Error('read failed');
  f.owner = 'worker';
  const gh = async (...args) => {
    if (args[0].endsWith('/git/ref/tags/veam-release-ledger-lock')) throw failure;
    return f.gh(...args);
  };
  await assert.rejects(withLock(gh, 'repo', () => assert.fail('entered'), timer), e => e === failure);
  assert.deepEqual(timer.waits, []);
  assert.equal(f.owner, 'worker');
});

test('environment budget is read per invocation and explicit options take precedence', async () => {
  const original = process.env.RELEASE_LEDGER_LOCK_WAIT_MS;
  try {
    for (const [env, override, expected] of [['4500', undefined, 4500], ['0', undefined, 0], ['4500', 1000, 1000]]) {
      process.env.RELEASE_LEDGER_LOCK_WAIT_MS = env;
      const f = fixture(), timer = clock();
      f.owner = 'other';
      await assert.rejects(withLock(f.gh, 'repo', () => assert.fail('entered'), {
        ...timer, ...(override === undefined ? {} : { timeoutMs: override }),
      }), new RegExp(`budget ${expected}ms`));
      assert.equal(timer.now(), expected);
    }
    process.env.RELEASE_LEDGER_LOCK_WAIT_MS = 'invalid';
    await assert.rejects(withLock(() => assert.fail('called GitHub'), 'repo', () => {}), /non-negative safe integer/);
  } finally {
    if (original === undefined) delete process.env.RELEASE_LEDGER_LOCK_WAIT_MS;
    else process.env.RELEASE_LEDGER_LOCK_WAIT_MS = original;
  }
});

test('invalid budgets, delays and attempt caps fail before any GitHub writes', async () => {
  for (const timeoutMs of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(withLock(() => assert.fail('called GitHub'), 'repo', () => {}, { timeoutMs }), /non-negative safe integer/);
  }
  for (const delay of [0, -1, NaN, Infinity, 1.5]) {
    await assert.rejects(withLock(() => assert.fail('called GitHub'), 'repo', () => {}, { delay }), /delay must be a positive safe integer/);
  }
  for (const attempts of [0, -1, NaN, 1.5]) {
    await assert.rejects(withLock(() => assert.fail('called GitHub'), 'repo', () => {}, { attempts }), /attempts must be a positive safe integer/);
  }
});

test('recording workflow forwards the optional budget through the composite action', () => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const workflow = readFileSync(join(__dirname, '../../workflows/record-release.yml'), 'utf8');
  const action = readFileSync(join(__dirname, 'action.yml'), 'utf8');
  assert.match(workflow, /lock_wait_ms:\n\s+description:.*\n\s+type: number\n\s+default: 300000/);
  assert.match(workflow, /lock_wait_ms: \$\{\{ inputs.lock_wait_ms \}\}/);
  assert.match(action, /lock_wait_ms:\n\s+description:.*\n\s+default: '300000'/);
  assert.match(action, /RELEASE_LEDGER_LOCK_WAIT_MS: \$\{\{ inputs.lock_wait_ms \}\}/);
});
