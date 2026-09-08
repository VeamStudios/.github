// Keep the inline governance parser aligned; work-item-links.test.js compares both.
function parseWorkItemLinks(input) {
  const body = String(input ?? '').replace(/\r\n?/g, '\n');
  const listedUrls = [];
  const ids = [];
  const invalidEntries = [];
  const addEntry = (entry) => {
    const value = entry.trim();
    const markdownLink = value.match(/^\[[^\]\n]+\]\((https:\/\/[^\s)]+)\)$/);
    const url = markdownLink?.[1] ?? value;
    let parsed;
    try { parsed = new URL(url); } catch {}
    const id = parsed?.pathname.match(/([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/?$/i)?.[1];
    if (parsed?.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.port && /^(?:[a-z0-9-]+\.)?notion\.(?:so|site|com)$/i.test(parsed.hostname) && id && !/\s/.test(url)) {
      const normalized = id.replace(/-/g, '').toLowerCase();
      if (!ids.includes(normalized)) { ids.push(normalized); listedUrls.push(url); }
    } else {
      invalidEntries.push(value || '(empty entry)');
    }
  };

  const lines = body.split('\n');
  let inWorkItemsList = false;
  for (const line of lines) {
    const singular = line.match(
      /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Notion\s+)?Work\s*Item(?:\*\*)?\s*:\s*(?:\*\*)?\s*(.+?)\s*$/i,
    );
    if (singular) {
      inWorkItemsList = false;
      addEntry(singular[1]);
      continue;
    }

    const pluralHeader =
      /^\s*(?:#{1,6}\s*)?(?:\*\*)?(?:Notion\s+)?Work\s*Items(?:\*\*)?\s*:\s*(?:\*\*)?\s*$/i.test(
        line,
      );
    if (pluralHeader) {
      inWorkItemsList = true;
      continue;
    }

    if (!inWorkItemsList) continue;
    if (!line.trim()) {
      inWorkItemsList = false;
      continue;
    }

    if (/^\s*#{1,6}\s+/.test(line)) {
      inWorkItemsList = false;
      continue;
    }

    const bullet = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!bullet) {
      invalidEntries.push(line.trim());
      continue;
    }
    addEntry(bullet[1]);
  }
  return { ids: ids.sort(), listedUrls, invalidEntries };
}
module.exports = { parseWorkItemLinks };
