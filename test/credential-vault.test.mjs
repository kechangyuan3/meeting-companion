import test from 'node:test';
import assert from 'node:assert/strict';
import {createCredentialVault} from '../cloud/public/credential-vault.js';

const alice = {appId: 'example-a', apiKey: 'fixture-alice-key', apiSecret: 'fixture-alice-secret'};
function memory() {
  let record;
  return {get: async () => structuredClone(record), put: async value => {record = structuredClone(value);}, clear: async () => {record = undefined;}};
}
test('browser credentials survive a new vault instance without storing plaintext or an exportable key', async () => {
  const store = memory();
  await createCredentialVault({store}).save(alice);
  const saved = await store.get();
  assert.equal(saved.key.extractable, false);
  await assert.rejects(crypto.subtle.exportKey('raw', saved.key));
  assert.doesNotMatch(JSON.stringify(saved), /fixture-alice|example-a/);
  assert.doesNotMatch(new TextDecoder().decode(saved.encrypted), /fixture-alice|example-a/);
  assert.deepEqual(await createCredentialVault({store}).load(), alice);
});
test('separate browser stores are isolated; clear removes both the ciphertext and key', async () => {
  const a = memory(), b = memory();
  const vault = createCredentialVault({store: a});
  await vault.save(alice);
  assert.equal(await createCredentialVault({store: b}).load(), null);
  await vault.clear();
  assert.equal(await a.get(), undefined);
  assert.equal(await createCredentialVault({store: a}).load(), null);
});
test('tampering fails closed without exposing credential values in the error', async () => {
  const store = memory(), vault = createCredentialVault({store});
  await vault.save(alice);
  const saved = await store.get();
  new Uint8Array(saved.encrypted)[0] ^= 1;
  await store.put(saved);
  await assert.rejects(vault.load(), error => /无法读取/.test(error.message) && !/fixture-alice/.test(error.message));
});
test('clearing during an in-progress save wins; invalid input never replaces existing credentials', async () => {
  const store = memory(), vault = createCredentialVault({store});
  await Promise.all([vault.save(alice), vault.clear()]);
  assert.equal(await vault.load(), null);
  await vault.save(alice);
  await assert.rejects(vault.save({...alice, apiSecret: ''}));
  assert.deepEqual(await vault.load(), alice);
});
