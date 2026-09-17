import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
// Disposable backend only. The unissued well-formed code additionally exercises
// the Node -> database callback, which an early validation error never reaches.
assert.equal(process.env.CONVEX_SELF_HOSTED_URL, 'http://127.0.0.1:3210');
const results = [];
for (const [name, code] of [['validation', 'invalid'], ['internal callback', 'A'.repeat(43)]]) {
  const response = await fetch('http://127.0.0.1:3210/api/action', {
    method: 'POST', signal: AbortSignal.timeout(20000), headers: {'Content-Type':'application/json'},
    body: JSON.stringify({path:'livekit:redeemScreenShareHandoff',args:{code},format:'json'}),
  });
  const data = await response.json();
  const reason = String(data.errorMessage ?? '').replace(/[a-f0-9]{64,}/gi, '[digest]').slice(0, 3000);
  const result = { name, httpStatus:response.status, status:data.status, passed:data.status==='error' && /handoff_invalid/.test(reason), reason };
  results.push(result);
  writeFileSync('e2e-results/node-runtime.json', JSON.stringify({results}, null, 2));
  console.log(JSON.stringify(result));
  assert.ok(result.passed, 'The isolated Node action runtime and its database callback must execute before browser tests');
}

// The deployed Node action, not a mocked configuration helper. This request
// cannot create family identities or expose the generated test keys.
const response = await fetch('http://127.0.0.1:3210/api/action', {
  method: 'POST', signal: AbortSignal.timeout(20000), headers: {'Content-Type':'application/json'},
  body: JSON.stringify({path:'deployment:readiness',args:{frontendOrigin:'https://garma-ci.test'},format:'json'}),
});
const readiness = await response.json();
const expectedVersion = (await import('node:fs')).readFileSync('src/convex/policy.ts','utf8')
  .match(/export const API_VERSION = "([^"\s]+)";/)?.[1];
assert.ok(expectedVersion);
assert.equal(response.status,200);
assert.equal(readiness.status,'success');
assert.equal(readiness.value.apiVersion,expectedVersion);
assert.equal(readiness.value.ready,true);
assert.deepEqual(readiness.value.checks,{privateEnrollment:true,uploadSite:true,allowedOrigins:true,frontendOrigin:true,livekit:true,pushKeys:true});
writeFileSync('e2e-results/deployment-configuration.json',JSON.stringify({
  commit:process.env.GITHUB_SHA, passed:true, apiVersion:expectedVersion,
  checks:readiness.value.checks, scope:'Isolated configuration validation; no push delivery claim.',
},null,2));
console.log('PASS: deployed private-family configuration action');
