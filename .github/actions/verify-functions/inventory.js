// Use the same compiled function definitions as deployment; a failed new function
// creation would otherwise be invisible in a provider-only inventory.
const fs = require('node:fs'), path = require('node:path');
const app = require(path.resolve('dist/app')).createDummyApplication();
const definitions = require(path.resolve('dist/load-cloud-functions')).loadCloudFunctions('js');
const names = definitions.map(({ definition }) => definition(app).functionName).sort();
if (!names.length || new Set(names).size !== names.length || names.some(name => !/^[A-Za-z0-9_-]+$/.test(name))) throw new Error('Cannot resolve the expected compiled function inventory');
fs.appendFileSync(process.env.GITHUB_ENV, `VERIFY_EXPECTED_FUNCTIONS=${JSON.stringify(names)}\n`);
