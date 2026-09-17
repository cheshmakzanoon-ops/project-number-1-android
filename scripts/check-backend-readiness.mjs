import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function frontendOrigin(value) {
  if (typeof value !== 'string' || !value || value !== value.trim() || /[\\\s]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
      ? url.origin : null;
  } catch { return null; }
}

async function boundedJSON(response) {
  if (!response.body) throw new Error('invalid_response');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65_536) { await reader.cancel(); throw new Error('response_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Only read-only queries/actions and unauthenticated upload probes. Never sends an admin/device credential. */
export async function checkBackend({ backend, origin, expectedVersion, fetchImpl = fetch }) {
  const results = [];
  const add = (name, passed, reason, httpStatus) => results.push({ name, passed: Boolean(passed), reason,
    ...(httpStatus === undefined ? {} : { httpStatus }) });
  const request = async (url, options, json = true) => {
    try {
      const response = await fetchImpl(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const data = json ? await boundedJSON(response) : null;
      if (!json) await response.body?.cancel();
      return { status: response.status, headers: response.headers, data };
    } catch (error) {
      // Raw errors and response contents can contain secrets/user data; never log them.
      return { failure: error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'request_timeout' : 'unreachable_or_invalid_response' };
    }
  };
  const api = (type, path, args) => request(`${backend}/api/${type}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  const validOrigin = frontendOrigin(origin);
  add('Exact HTTPS frontend origin supplied', validOrigin !== null, validOrigin ? 'valid_origin' : 'frontend_origin_missing_or_invalid');
  // Unissued token: these two queries must never return an identity or directory.
  const token = 'garma-readiness-unregistered-session-no-user-data';
  const identity = await api('query', 'users:me', { token });
  add('Unknown session is not authenticated', identity.status === 200 && identity.data?.status === 'success' && identity.data.value === null,
    identity.failure ?? 'identity_response_checked', identity.status);
  const directory = await api('query', 'users:directory', { token });
  add('Unknown session cannot read the directory', directory.status === 200 && directory.data?.status === 'success' &&
    Array.isArray(directory.data.value) && directory.data.value.length === 0,
    directory.failure ?? 'directory_response_checked_without_logging_data', directory.status);

  if (!validOrigin) {
    add('Deployed release configuration', false, 'frontend_origin_required_for_configuration_and_upload_checks');
    return results;
  }
  const configuration = await api('action', 'deployment:readiness', { frontendOrigin: validOrigin });
  const value = configuration.status === 200 && configuration.data?.status === 'success' ? configuration.data.value : null;
  add('Deployed API matches the source contract', typeof expectedVersion === 'string' && expectedVersion.length > 0 && value?.apiVersion === expectedVersion,
    configuration.failure ?? 'api_version_must_match', configuration.status);
  for (const [key, name] of Object.entries({ privateEnrollment: 'Private family invitation configured', uploadSite: 'HTTPS upload site configured',
    allowedOrigins: 'Upload allowlist contains only valid HTTPS origins', frontendOrigin: 'This frontend is allowed to upload',
    livekit: 'Secure LiveKit endpoint and server credentials configured', pushKeys: 'Web Push public and private keys match' })) {
    add(name, value?.checks?.[key] === true, value?.checks?.[key] === true ? 'configuration_validated' : `${key}_missing_or_invalid`, configuration.status);
  }
  add('Backend configuration verdict is ready', value?.ready === true, 'configuration_only_not_delivery_proof', configuration.status);

  // The endpoint is derived only from the checked-in canonical cloud URL, never a backend response.
  const host = new URL(backend);
  if (host.protocol !== 'https:' || !host.hostname.endsWith('.convex.cloud')) {
    add('Canonical upload endpoint', false, 'unsupported_backend_origin');
    return results;
  }
  host.hostname = host.hostname.slice(0, -'.cloud'.length) + '.site';
  const upload = host.origin + '/media/upload';
  const preflight = await request(upload, { method: 'OPTIONS', headers: { Origin: validOrigin,
    'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' } }, false);
  const list = header => (preflight.headers?.get(header) ?? '').toLowerCase().split(',').map(s => s.trim());
  add('Upload preflight permits this frontend and required headers', preflight.status === 204 &&
    preflight.headers.get('Access-Control-Allow-Origin') === validOrigin && list('Access-Control-Allow-Methods').includes('post') &&
    ['authorization', 'content-type'].every(h => list('Access-Control-Allow-Headers').includes(h)),
    preflight.failure ?? 'preflight_contract_checked', preflight.status);
  const unauthorized = await request(upload, { method: 'POST', headers: { Origin: validOrigin, 'Content-Type': 'image/png' } });
  add('Upload rejects missing authentication without storing a file', unauthorized.status === 401 && unauthorized.data?.error === 'unauthorized',
    unauthorized.failure ?? 'unauthenticated_upload_rejected', unauthorized.status);
  // An opaque Origin is never a valid family web origin. OPTIONS does not create data.
  const foreign = await request(upload, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'POST' } }, false);
  add('Upload rejects opaque origins', foreign.status === 403 && !foreign.headers.get('Access-Control-Allow-Origin'),
    foreign.failure ?? 'opaque_origin_rejected', foreign.status);
  return results;
}

async function main() {
  const root = new URL('../', import.meta.url);
  const source = readFileSync(new URL('src/main.tsx', root), 'utf8');
  const policy = readFileSync(new URL('src/convex/policy.ts', root), 'utf8');
  const backend = source.match(/const CONVEX_URL = "(https:\/\/[^"\s]+)";/)?.[1];
  const version = policy.match(/export const API_VERSION = "([^"\s]+)";/)?.[1];
  if (!backend || !version || frontendOrigin(backend) !== backend || !new URL(backend).hostname.endsWith('.convex.cloud')) {
    throw new Error('Canonical backend or source contract is missing');
  }
  const results = await checkBackend({ backend, origin: process.env.GARMA_FRONTEND_ORIGIN, expectedVersion: version });
  const report = { checkedAt: new Date().toISOString(), commit: process.env.GITHUB_SHA ?? null, backend,
    scope: 'Read-only configuration, API-version, privacy and unauthenticated upload checks. No users, calls, messages or files created; not phone, media or push delivery acceptance.', results };
  writeFileSync('backend-readiness.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    '\n## Backend readiness\n' + results.map(r => `- ${r.passed ? 'PASS' : 'FAIL'}: ${r.name} (${r.reason})`).join('\n') + '\n');
  if (results.some(r => !r.passed)) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('Backend readiness could not complete; no release approval.'); process.exitCode = 1; });
}
