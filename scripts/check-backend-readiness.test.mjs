// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { checkBackend, frontendOrigin } from './check-backend-readiness.mjs';
const backend = 'https://precise-ptarmigan-412.eu-west-1.convex.cloud';
const origin = 'https://family.example.test';
const expectedVersion = 'test-version';
const configuration = () => ({ apiVersion: expectedVersion, ready: true, checks: {
  privateEnrollment: true, uploadSite: true, allowedOrigins: true, frontendOrigin: true, livekit: true, pushKeys: true,
} });
const json = data => new Response(JSON.stringify({ status: 'success', value: data }), { headers: { 'Content-Type': 'application/json' } });
function fixture(override = () => undefined) {
  const fetchImpl = vi.fn(async (url, options) => {
    const path = options.body ? JSON.parse(options.body).path : null;
    const replaced = override({ url, options, path });
    if (replaced !== undefined) return replaced;
    if (path === 'users:me') return json(null);
    if (path === 'users:directory') return json([]);
    if (path === 'deployment:readiness') return json(configuration());
    if (options.headers.Origin === 'null') return new Response(null, { status: 403 });
    if (options.method === 'POST') return new Response('{"error":"unauthorized"}', { status: 401 });
    return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' } });
  });
  return { fetchImpl, run: extra => checkBackend({ backend, origin, expectedVersion, fetchImpl, ...extra }) };
}
describe('deployed family release guard', () => {
  it('requires all 14 read-only checks; never sends admin credentials or calls a mutation', async () => {
    const { run, fetchImpl } = fixture(); const results = await run();
    expect(results).toHaveLength(14); expect(results.every(r => r.passed)).toBe(true);
    for (const [url, options] of fetchImpl.mock.calls) {
      expect(url).not.toContain('/mutation'); expect(options.redirect).toBe('error');
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.headers.Authorization).toBeUndefined();
      if (options.body) expect(['users:me', 'users:directory', 'deployment:readiness']).toContain(JSON.parse(options.body).path);
    }
  });
  it('does not mistake stale backend code for the repaired API', async () => {
    const { run } = fixture(({path}) => path === 'deployment:readiness' ? json({ ...configuration(), apiVersion: 'old' }) : undefined);
    expect((await run()).find(r => r.name === 'Deployed API matches the source contract').passed).toBe(false);
  });
  it.each(['privateEnrollment', 'uploadSite', 'allowedOrigins', 'frontendOrigin', 'livekit', 'pushKeys'])('rejects missing %s even if the server claims ready', async key => {
    const { run } = fixture(({path}) => {
      if (path !== 'deployment:readiness') return;
      const config = configuration(); delete config.checks[key]; return json(config);
    });
    expect((await run()).some(r => !r.passed)).toBe(true);
  });
  it('rejects missing frontend configuration but still checks unauthenticated privacy', async () => {
    const { run, fetchImpl } = fixture(); const results = await run({ origin: undefined });
    expect(results.filter(r => !r.passed)).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(results.filter(r => r.passed)).toHaveLength(2);
  });
  it('reports a leaked directory as failure without recording any user data', async () => {
    const secret = 'PRIVATE FAMILY DATA DO NOT LOG';
    const { run } = fixture(({path}) => path === 'users:directory' ? json([{ name: secret }]) : undefined);
    const results = await run(); expect(results.find(r => r.name.includes('directory')).passed).toBe(false);
    expect(JSON.stringify(results)).not.toContain(secret);
  });
  it('rejects server errors even when their JSON shape claims success', async () => {
    const { run } = fixture(({path}) => path === 'users:me' ? new Response('{"status":"success","value":null}', { status: 500 }) : undefined);
    expect((await run()).find(r => r.name === 'Unknown session is not authenticated').passed).toBe(false);
  });
  it('rejects wildcard CORS preflight and a route accidentally rewritten to HTML', async () => {
    const { run } = fixture(({path, options}) => {
      if (path) return;
      if (options.method === 'POST') return new Response('<html>app fallback</html>');
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
    });
    expect((await run()).slice(-3).every(r => !r.passed)).toBe(true);
  });
  it('bounds response size and never includes raw server errors', async () => {
    const secret = 'SERVER SECRET';
    const { run } = fixture(({path}) => path === 'deployment:readiness' ? new Response(secret.repeat(8000)) : undefined);
    const results = await run(); expect(results.some(r => !r.passed)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(secret);
  });
  it('records network timeouts without treating unreachable privacy endpoints as denied', async () => {
    const { run } = fixture(() => { throw new DOMException('sensitive URL', 'TimeoutError'); });
    const results = await run(); expect(results.slice(1).every(r => !r.passed)).toBe(true);
    expect(JSON.stringify(results)).not.toContain('sensitive URL');
    expect(results.some(r => r.reason === 'request_timeout')).toBe(true);
  });
  it.each(['', undefined, 'http://family.example.test', origin + '/path', origin + '?token=secret',
    'https://user:password@family.example.test', 'https:\\family.example.test', origin + '#invite=secret'])(
    'rejects non-origin or credential-bearing frontend input %#', input => expect(frontendOrigin(input)).toBeNull());
  it('accepts an HTTPS origin with an optional root slash', () => expect(frontendOrigin(origin + '/')).toBe(origin));
});
