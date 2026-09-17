import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
// A malformed code never reads accounts, mutates data or mints a token, but
// unlike a schema error it does exercise the actual Node action runtime.
assert.equal(process.env.CONVEX_SELF_HOSTED_URL, 'http://127.0.0.1:3210');
const response = await fetch('http://127.0.0.1:3210/api/action', {
  method: 'POST', signal: AbortSignal.timeout(20000), headers: {'Content-Type':'application/json'},
  body: JSON.stringify({path:'livekit:redeemScreenShareHandoff',args:{code:'invalid'},format:'json'}),
});
const data = await response.json();
const reason = String(data.errorMessage ?? '').replace(/[a-f0-9]{64,}/gi, '[digest]').slice(0, 3000);
const result = { httpStatus:response.status, status:data.status, passed:data.status==='error' && /handoff_invalid/.test(reason), reason };
writeFileSync('e2e-results/node-runtime.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
assert.ok(result.passed, 'The isolated Node action runtime must execute application code before browser tests');
