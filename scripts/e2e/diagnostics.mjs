// Synthetic CI only: retain failure reasons without token-bearing URLs/values.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
const redact = value => String(value)
  .replace(/https?:\/\/[^\s"'<>]+/g, raw => { try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[url]'; } })
  .replace(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, '[jwt]')
  .replace(/\b[a-f0-9]{64,}\b/gi, '[digest-or-token]')
  .replace(/garma-isolated-browser-test-invitation-2026/g, '[test-invite]').slice(0, 2000);
export function observeBrowser() {
  const diagnostics = { console: [], failedRequests: [] };
  const save = (path = 'e2e-results/diagnostics.json') => {
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify(diagnostics, null, 2));
  };
  const attach = (page, device) => {
    page.on('console', message => {
      if (!['error', 'warning'].includes(message.type())) return;
      diagnostics.console.push({device, type: message.type(), text: redact(message.text())});
      diagnostics.console = diagnostics.console.slice(-60); save();
    });
    page.on('requestfailed', request => {
      const url = new URL(request.url());
      diagnostics.failedRequests.push({device, method: request.method(), endpoint: url.origin + url.pathname,
        error: redact(request.failure()?.errorText)});
      diagnostics.failedRequests = diagnostics.failedRequests.slice(-60); save();
    });
  };
  return {attach, save};
}
