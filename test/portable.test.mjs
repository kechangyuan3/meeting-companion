import test from 'node:test';
import assert from 'node:assert/strict';
import {startMeeting} from '../server.mjs';
test('people without Codex can start the app and configure their own MOSS/Vexa services',async()=>{
  const app=await startMeeting({port:0});
  try {
    const page=await fetch(app.url);assert.equal(page.status,200);
    const cookie=page.headers.get('set-cookie').split(';')[0];
    const status=await(await fetch(`${app.url}/api/status`,{headers:{Cookie:cookie}})).json();
    assert.equal(status.backendAvailable,false);assert.equal(status.configured,false);
    const vexa=await(await fetch(`${app.url}/api/vexa/status`,{headers:{Cookie:cookie}})).json();
    assert.equal(vexa.configured,false);assert.equal(vexa.endpoint,'https://api.cloud.vexa.ai');
  } finally {await app.close();}
});
