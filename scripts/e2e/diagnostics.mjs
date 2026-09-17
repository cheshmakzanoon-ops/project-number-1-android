// Synthetic CI only: retain failure reasons without token-bearing URLs/values.
import { mkdirSync, writeFileSync } from 'node:fs';
const diagnostics = { console: [], failedRequests: [] };
const redact = value => String(value)
  .replace(/https?:\/\/[^\s"'<>]+/g, raw => { try { const url = new URL(raw); return url.origin + url.pathname; } catch { return '[url]'; } })
  .replace(/[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/g, '[jwt]')
  .replace(/\b[a-f0-9]{64,}\b/gi, '[digest-or-token]')
  .replace(/garma-isolated-browser-test-invitation-2026/g, '[test-invite]').slice(0, 2000);
const save = () => { mkdirSync('e2e-results', {recursive: true}); writeFileSync('e2e-results/diagnostics.json', JSON.stringify(diagnostics, null, 2)); };
export function observeBrowser(page, device) {
  page.on('console', message => {
    if (!['error', 'warning'].includes(message.type())) return;
    diagnostics.console.push({ device, type: message.type(), text: redact(message.text()) });
    diagnostics.console = diagnostics.console.slice(-60); save();
  });
  page.on('requestfailed', request => {
    const url = new URL(request.url());
    diagnostics.failedRequests.push({ device, method: request.method(), endpoint: url.origin + url.pathname,
      error: request.failure()?.errorText });
    diagnostics.failedRequests = diagnostics.failedRequests.slice(-60); save();
  });
}
