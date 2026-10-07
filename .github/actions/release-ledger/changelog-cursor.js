'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const MAX_INPUT = 4 * 1024 * 1024;
const MAX_OUTPUT = 1024 * 1024;

class CursorAssessmentError extends Error {
  constructor(code, message, stage = 'provider', exitCode) {
    super(message); this.name = 'CursorAssessmentError'; this.code = code; this.stage = stage;
    if (Number.isInteger(exitCode)) this.exitCode = exitCode;
  }
}
function processFailure(stderr, stage, exitCode) {
  let category = 'cli_process';
  if (/unauthenticated|unauthorized|invalid.{0,20}(api.key|token)|authentication|not logged in|login required|401/i.test(stderr)) category = 'authentication';
  else if (/model.{0,60}(not found|unavailable|invalid|not supported|denied)|unknown model/i.test(stderr)) category = 'model';
  else if (/workspace.{0,40}trust|untrusted|trust.{0,40}(workspace|directory)/i.test(stderr)) category = 'workspace_trust';
  else if (/missing field|unknown variant|invalid type|failed to (parse|read).{0,30}policy|invalid.{0,20}policy/i.test(stderr)) category = 'sandbox_policy';
  else if (/Landlock V3.*not supported|unsupported kernel features|Sandbox requires kernel/i.test(stderr)) category = 'sandbox_kernel';
  else if (/partially enforced|ruleset was NOT enforced|not_enforced/i.test(stderr)) category = 'sandbox_enforcement';
  else if (/Step 5.5|Step 6\/7|seccomp.*failed|Failed to apply seccomp/i.test(stderr)) category = 'sandbox_seccomp';
  else if (/AppArmor|user namespace|UnshareError|unshare/i.test(stderr)) category = 'sandbox_namespace';
  else if (/Sandbox binary not found|binary path was not configured|ENOENT/i.test(stderr)) category = 'sandbox_helper';
  else if (/Landlock|failed to apply landlock/i.test(stderr)) category = 'sandbox_landlock';
  else if (/sandbox|bwrap|bubblewrap/i.test(stderr)) category = 'sandbox';
  else if (/ECONN|ENOTFOUND|ETIMEDOUT|network|fetch failed|connection|TLS|certificate/i.test(stderr)) category = 'network';
  const error = new CursorAssessmentError(category, `Changelog assessment provider failed (${category}).`, stage, exitCode);
  // Only this native helper runs without credentials, source, model or prompt.
  // Never expose provider stderr through this diagnostic field.
  if (stage === 'sandbox-preflight') error.nativeDiagnostic = stderr.slice(0, 4096).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
  return error;
}
function execute(executable, args, { cwd, env, timeoutMs, onLine, stage = 'provider' }) {
  return new Promise((resolve, reject) => {
    let child, done = false, output = '', pending = '', bytes = 0, stderr = '';
    const decoder = new StringDecoder('utf8');
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error && child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
      if (error && !(error instanceof CursorAssessmentError)) error = new CursorAssessmentError('cli_execution', error.message, stage);
      error ? reject(error) : resolve(output);
    };
    const timer = setTimeout(() => finish(new CursorAssessmentError('timeout', 'Changelog assessment timed out. Rerun the check.', stage)), timeoutMs);
    try { child = spawn(executable, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { finish(new CursorAssessmentError('process_start', 'Changelog assessment process could not start.', stage)); return; }
    child.on('error', () => finish(new CursorAssessmentError('process_start', 'Changelog assessment process could not start.', stage)));
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) { finish(new CursorAssessmentError('output_limit', 'Changelog assessment exceeded its output limit.', stage)); return; }
      const value = decoder.write(chunk);
      output += value;
      if (onLine) {
        pending += value;
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          if (line.trim()) try { onLine(line); } catch { finish(new CursorAssessmentError('invalid_event', 'Changelog assessment returned an invalid event or attempted a forbidden tool.', stage)); return; }
        }
      }
    });
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString('utf8')).slice(0, 65536);
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT) finish(new CursorAssessmentError('output_limit', 'Changelog assessment exceeded its output limit.', stage));
      // Never log provider stderr: it may contain source, prompt or credentials.
    });
    child.on('close', code => {
      if (done) return;
      const tail = decoder.end(); output += tail; pending += tail;
      if (code !== 0) { finish(processFailure(stderr, stage, code)); return; }
      if (onLine && pending.trim()) try { onLine(pending); } catch { finish(new CursorAssessmentError('invalid_event', 'Changelog assessment returned an invalid event or attempted a forbidden tool.', stage)); return; }
      finish();
    });
  });
}

async function runAssessment(evidence, { executable, expectedVersion, model, apiKey, timeoutMs = 180000 } = {}) {
  if (!path.isAbsolute(executable || '') || !/^[A-Za-z0-9._-]+$/.test(expectedVersion || '') || !/^[A-Za-z0-9._:/-]+$/.test(model || '') || typeof apiKey !== 'string' || !apiKey || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) throw new CursorAssessmentError('configuration', 'Changelog assessment requires a pinned executable/version, approved model and existing provider credential.');
  const encoded = JSON.stringify(evidence);
  if (!encoded || Buffer.byteLength(encoded) > MAX_INPUT) throw new CursorAssessmentError('input_limit', 'Complete changelog evidence exceeds the assessment input limit.');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'changelog-assessment-'));
  try {
    const workspace = path.join(root, 'evidence'), config = path.join(root, 'config');
    await fs.mkdir(workspace); await fs.mkdir(config);
    const evidencePath = path.join(workspace, 'evidence.json');
    await fs.writeFile(evidencePath, encoded, { mode: 0o400 });
    await fs.writeFile(path.join(config, 'cli-config.json'), JSON.stringify({
      version: 1, editor: { vimMode: false }, approvalMode: 'allowlist',
      sandbox: { mode: 'enabled', networkAccess: 'user_config_only', readBoundary: 'workspace' },
      permissions: { allow: [`Read(${evidencePath})`], deny: ['Shell(*)', 'Write(**)', 'WebFetch(*)', 'Mcp(*:*)'] },
    }), { mode: 0o600 });
    await fs.mkdir(path.join(workspace, '.cursor'));
    await fs.writeFile(path.join(workspace, '.cursor', 'sandbox.json'), JSON.stringify({ type: 'workspace_readonly', networkPolicy: { default: 'deny', deny: ['*'] }, disableTmpWrite: true }), { mode: 0o400 });
    await fs.writeFile(path.join(config, 'mcp.json'), '{"mcpServers":{}}', { mode: 0o600 });
    const env = { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', CURSOR_CONFIG_DIR: config, ...(process.env.HOME ? { HOME: process.env.HOME } : {}) };
    const version = await execute(executable, ['--version'], { cwd: workspace, env, timeoutMs: Math.min(timeoutMs, 10000), stage: 'version' });
    if (version.trim() !== expectedVersion) throw new CursorAssessmentError('version_mismatch', 'Changelog assessment executable version differs from its reviewed pin.', 'version');
    const prompt = await fs.readFile(path.join(__dirname, 'changelog-cursor-prompt.md'), 'utf8');
    let terminal, completeRead = false;
    const reads = new Set();
    const onLine = line => {
      const event = JSON.parse(line);
      if (!event || typeof event !== 'object' || event.is_error === true || event.error || terminal) throw Error('Unexpected event');
      if (event.type === 'tool_call') {
        const call = event.tool_call;
        if (!call || Object.keys(call).length !== 1 || !call.readToolCall) throw Error('Forbidden tool');
        if (event.subtype === 'started') {
          const supplied = call.readToolCall.args?.path;
          if (typeof supplied !== 'string' || path.resolve(workspace, supplied) !== evidencePath || !event.call_id) throw Error('Forbidden read');
          reads.add(event.call_id);
        } else if (event.subtype === 'completed') {
          const success = call.readToolCall.result?.success;
          if (!reads.delete(event.call_id) || !success || success.exceededLimit !== false ||
              success.content !== encoded || success.totalChars !== encoded.length ||
              success.totalLines !== 1 || success.isEmpty !== false) throw Error('Incomplete evidence read');
          completeRead = true;
        } else throw Error('Unknown tool event');
      } else if (event.type === 'result') {
        if (event.subtype !== 'success' || event.is_error !== false || typeof event.result !== 'string' || reads.size || !completeRead) throw Error('Failed result');
        terminal = event;
      } else if (event.type === 'system') {
        if (event.subtype !== 'init') throw Error('Unknown system event');
      } else if (event.type !== 'assistant' && event.type !== 'user') throw Error('Unknown event');
    };
    // Trust only this newly created evidence directory and our own policy files,
    // never the product checkout or any PR-supplied project configuration.
    await execute(executable, ['--print', '--trust', '--mode=ask', '--sandbox', 'enabled', '--output-format', 'stream-json', '--model', model, '--workspace', workspace, `${prompt}\nRead the complete evidence.json in this workspace. Return only the requested JSON.`], { cwd: workspace, env: { ...env, CURSOR_API_KEY: apiKey }, timeoutMs, onLine });
    if (!terminal) throw new CursorAssessmentError('missing_terminal', 'Changelog assessment did not return a successful terminal result.');
    let assessment;
    try { assessment = JSON.parse(terminal.result); } catch { throw new CursorAssessmentError('policy_json', 'Changelog assessment did not return policy JSON.'); }
    if (!assessment || typeof assessment !== 'object' || Array.isArray(assessment) || assessment.schemaVersion !== 1 || assessment.repository !== evidence.repository || assessment.head !== evidence.head || assessment.base !== evidence.base || assessment.evidenceDigest !== evidence.digest || !['pass', 'missing_note', 'review'].includes(assessment.outcome) || !Array.isArray(assessment.findings)) throw new CursorAssessmentError('policy_identity', 'Changelog assessment returned invalid or stale policy identity.');
    // The caller MUST apply changelog-assessment.js semantic/reference validation.
    return assessment;
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
async function preflightSandbox(executable, { timeoutMs = 15000 } = {}) {
  if (!path.isAbsolute(executable || '')) throw new CursorAssessmentError('configuration', 'An absolute pinned Cursor executable path is required.', 'sandbox-preflight');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'changelog-sandbox-preflight-'));
  try {
    const helper = path.join(path.dirname(executable), 'cursorsandbox');
    const policy = path.join(root, 'policy.json');
    await fs.writeFile(policy, JSON.stringify({ sandbox: { type: 'workspace_readonly', cwd: root, readBoundary: 'workspace', hardcodedReadPaths: ['/bin', '/usr', '/lib', '/lib64', '/etc/ld.so.cache'], additionalReadonlyPaths: {}, networkAccess: false } }), { mode: 0o400 });
    await execute(helper, ['--policy', policy, '--preflight-only', '--', '/bin/true'], { cwd: root, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' }, timeoutMs, stage: 'sandbox-preflight' });
    return { supported: true };
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}
if (require.main === module && process.argv[2] === '--sandbox-preflight') {
  preflightSandbox(process.env.CURSOR_EXECUTABLE).then(() => console.log('Cursor sandbox preflight: supported.')).catch(error => {
    const code = error instanceof CursorAssessmentError ? error.code : 'unexpected_execution';
    const status = Number.isInteger(error.exitCode) ? `; exit=${error.exitCode}` : '';
    console.error(`Cursor sandbox preflight: ${code}${status}.`);
    if (error instanceof CursorAssessmentError && error.stage === 'sandbox-preflight' && typeof error.nativeDiagnostic === 'string') {
      // A single JSON-escaped line with a fixed prefix cannot create Actions commands.
      console.error('Native sandbox diagnostic (credential-free): ' + JSON.stringify(error.nativeDiagnostic));
    }
    process.exitCode = 1;
  });
}
module.exports = { runAssessment, preflightSandbox, CursorAssessmentError };
