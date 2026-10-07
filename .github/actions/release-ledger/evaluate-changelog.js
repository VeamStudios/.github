'use strict';
// Public, synthetic acceptance examples. Never substitute these for real-PR accuracy evidence.
const { evidenceDigest } = require('./changelog-evidence');
const { runAssessment } = require('./changelog-cursor');
const { validateAssessment } = require('./changelog-assessment');
const CLI_VERSION = '2026.10.01-e373342';
const MODEL = 'grok-4.6';
function fixture(files, entries = []) {
  const body = { schemaVersion: 1, repository: 'VeamStudios/ChangelogSyntheticExamples', head: '1'.repeat(40), base: '2'.repeat(40), releaseCommit: '3'.repeat(40), files, entries };
  return { ...body, digest: evidenceDigest(body) };
}
const feature = {
  path: 'src/export.js', status: 'modified',
  before: 'export const exportFormats = ["pdf"];\nexport function exportReport(report, format) {\n  if (format !== "pdf") throw new Error("Unsupported format");\n  return report.toPDF();\n}\n',
  after: 'export const exportFormats = ["pdf", "csv"];\nexport function exportReport(report, format) {\n  if (format === "csv") return report.toCSV();\n  if (format !== "pdf") throw new Error("Unsupported format");\n  return report.toPDF();\n}\n',
};
function cases() {
  return [
    { name: 'missing-feature', expectedOutcome: 'missing_note', expectedDisposition: 'missing', evidence: fixture([{ ...feature }]) },
    { name: 'existing-upcoming-coverage', expectedOutcome: 'pass', expectedDisposition: 'covered', evidence: fixture([{ ...feature }], [{ id: 'upcoming-csv', path: 'CHANGELOG.md', line: 5, heading: 'New', text: 'Export reports as CSV files in addition to PDF.', eligible: true }]) },
    { name: 'maintenance-only', expectedOutcome: 'pass', expectedDisposition: 'exempt', evidence: fixture([{ path: 'tests/add.test.js', status: 'modified', before: 'import assert from "node:assert/strict";\nimport { add } from "../src/add.js";\nassert.equal(add(1, 2), 3);\n', after: 'import assert from "node:assert/strict";\nimport { add } from "../src/add.js";\nassert.equal(add(1, 2), 3);\nassert.equal(add(0, 0), 0);\n' }]) },
  ];
}
async function evaluate(options, dependencies = {}) {
  const assess = dependencies.runAssessment || runAssessment;
  const validate = dependencies.validateAssessment || validateAssessment;
  const totals = { total: 3, passed: 0, mismatched: 0, errors: 0 };
  for (const example of cases()) {
    try {
      const response = await assess(example.evidence, { ...options, expectedVersion: CLI_VERSION, model: MODEL, timeoutMs: 60000 });
      validate(example.evidence, response);
      if (response.outcome === example.expectedOutcome && response.findings.some(finding => finding.disposition === example.expectedDisposition)) totals.passed++;
      else totals.mismatched++;
    } catch { totals.errors++; }
  }
  return { ...totals, exitCode: totals.passed === totals.total ? 0 : 1 };
}
async function main(env = process.env, dependencies) {
  const outcome = await evaluate({ executable: env.CURSOR_EXECUTABLE, apiKey: env.CURSOR_API_KEY }, dependencies);
  console.log(`Synthetic changelog acceptance: ${outcome.passed}/${outcome.total} passed; ${outcome.mismatched} mismatched; ${outcome.errors} execution/validation errors.`);
  console.log('These synthetic examples do not establish real-PR semantic accuracy.');
  return outcome.exitCode;
}
if (require.main === module) main().then(code => { process.exitCode = code; }).catch(() => { console.error('Synthetic changelog acceptance could not complete.'); process.exitCode = 1; });
module.exports = { cases, evaluate, main, CLI_VERSION, MODEL };
