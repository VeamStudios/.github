// Required PR Work Item gate. Only `feat` titles (including scoped and breaking
// forms) need a Work Items link; every other prefix passes.
const { parseWorkItemLinks } = require('./work-item-links');

function workItemGate({ title, body }) {
  if (!/^feat(?:\([^)]+\))?!?:/i.test(String(title ?? '').trim())) {
    return { ok: true, summary: 'Work Item link is only required for `feat` PR titles.' };
  }
  const { listedUrls, invalidEntries } = parseWorkItemLinks(body);
  if (invalidEntries.length) {
    return { ok: false, summary: 'Every entry under `Work Items:` must be a valid Notion Work Item URL.' };
  }
  if (!listedUrls.length) {
    return { ok: false, summary: 'Feature PRs need a `Work Items:` list with at least one Notion Work Item URL in the description. To create one, open the Notion Work Item check and click Create work item.' };
  }
  return { ok: true, summary: `${listedUrls.length} Work Item link${listedUrls.length === 1 ? '' : 's'} found.` };
}

module.exports = { workItemGate };
