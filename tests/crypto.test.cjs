'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const nodeCrypto = require('node:crypto');
const source = fs.readFileSync(path.join(__dirname,'..','BISTU_Java_Extractor.user.js'),'utf8');
const start = source.indexOf('    // BEGIN VENDORED OFFLINE CRYPTO');
const end = source.indexOf('    // END VENDORED OFFLINE CRYPTO');
assert.ok(start >= 0 && end > start,'userscript contains the vendored production adapter');
const factory = source.slice(start,end);
function adapter(native) {
  return vm.runInNewContext(factory + '\nbistuCrypto;', {
    crypto:native ? nodeCrypto.webcrypto : {getRandomValues:array => nodeCrypto.webcrypto.getRandomValues(array)},
    TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,DataView,setTimeout,clearTimeout,btoa,atob,console
  });
}
const password = 'Synthetic-only password 2026!';
const salt = Buffer.from('00112233445566778899aabbccddeeff','hex');
const config = {version:1,kdf:'PBKDF2-SHA256',iterations:600000,salt:salt.toString('base64'),cipher:'AES-256-GCM'};

test('production PBKDF2 native and insecure-context fallback equal independent Node SHA-256 derivation',async () => {
  const expected = nodeCrypto.pbkdf2Sync(password,salt,600000,32,'sha256');
  for (const native of [true,false]) assert.deepEqual(Buffer.from(await adapter(native).deriveKey(password,config)),expected);
});

test('AES-256-GCM native and Noble outputs interoperate with independent Node including authenticated file paths',async () => {
  const key = Uint8Array.from({length:32},(_,index) => index), plain = Buffer.from('题干 <code>"x  y"</code>\r\n\0 unchanged','utf8');
  const aad = 'bistu-image:images/img_7.png';
  for (const native of [true,false]) {
    const crypto = adapter(native), record = await crypto.encryptBytes(plain,key,aad);
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm',key,Buffer.from(record.iv,'base64'));
    cipher.setAAD(Buffer.from(aad));
    const expected = Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
    assert.deepEqual(Buffer.from(record.data,'base64'),expected);
    assert.deepEqual(Buffer.from(await adapter(!native).decryptBytes(record,key,aad)),plain);
    await assert.rejects(crypto.decryptBytes(record,key,'bistu-image:images/img_8.png'),/密码错误|损坏/);
    const changed = Buffer.from(record.data,'base64'); changed[changed.length - 1] ^= 1;
    await assert.rejects(crypto.decryptBytes({...record,data:changed.toString('base64')},key,aad),/密码错误|损坏/);
  }
});

test('reader, state and report envelopes conceal content, reject wrong passwords and cross-purpose import',async () => {
  const crypto = adapter(false), session = await crypto.createSession(password);
  assert.equal(session.config.iterations,600000);
  for (const purpose of ['reader','state','report']) {
    const text = 'SYNTHETIC_PRIVATE_' + purpose + '\n中文😀\r\n';
    const envelope = await crypto.encryptText(text,session,purpose);
    assert.equal(JSON.stringify(envelope).includes('SYNTHETIC_PRIVATE_'),false);
    assert.equal(JSON.stringify(envelope).includes(password),false);
    assert.equal((await adapter(true).decryptText(envelope,password,purpose)).text,text);
    await assert.rejects(crypto.decryptText(envelope,password,purpose === 'state' ? 'reader' : 'state'),/类型不匹配/);
    if (purpose === 'state') await assert.rejects(adapter(true).decryptText(envelope,'Wrong password for synthetic state',purpose),/密码错误|损坏/);
  }
});

test('fresh exports use fresh salt, each file has a unique 96-bit IV, and insecure randomness is never substituted',async () => {
  const crypto = adapter(true), key = new Uint8Array(32);
  const first = await crypto.createSession(password), second = await crypto.createSession(password);
  assert.notEqual(first.config.salt,second.config.salt);
  const records = await Promise.all(Array.from({length:100},(_,index) => crypto.encryptBytes(Uint8Array.of(index),key,'test-file:' + index)));
  assert.equal(new Set(records.map(record => record.iv)).size,100);
  assert.ok(records.every(record => Buffer.from(record.iv,'base64').length === 12));
  const missingRng = vm.runInNewContext(factory + '\nbistuCrypto;', {crypto:{},TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,DataView,setTimeout,clearTimeout,btoa,atob});
  await assert.rejects(missingRng.createSession(password),/安全随机数/);
});

test('malformed parameters, noncanonical data and excessive KDF work are rejected before decryption',async () => {
  const crypto = adapter(false), key = new Uint8Array(32);
  await assert.rejects(crypto.deriveKey(password,{...config,iterations:599999}),/参数/);
  await assert.rejects(crypto.deriveKey(password,{...config,iterations:999999999}),/参数/);
  await assert.rejects(crypto.createSession('short'),/12–256/);
  await assert.rejects(crypto.decryptBytes({iv:'bad',data:'bad'},key,'test'),/编码/);
  await assert.rejects(crypto.decryptBytes({iv:Buffer.alloc(12).toString('base64'),data:''},key,'test'),/不完整/);
});

test('locked HTML embeds only ciphertext and disables password autofill without persistent secret storage',async () => {
  const start = source.indexOf('    async function generateProtectedHtml('), end = source.indexOf('    function offlineLegacyReviewCurrent(',start);
  assert.ok(start >= 0 && end > start);
  const helper = source.slice(start,end);
  const build = vm.runInNewContext(factory + '\nconst SCRIPT_VERSION="synthetic";\n' + helper + '\n(async () => generateProtectedHtml("<!doctype html><p>PRIVATE_SYNTHETIC_READER</p>",await bistuCrypto.createSession("Synthetic-only password 2026!")))', {
    crypto:nodeCrypto.webcrypto,TextEncoder,TextDecoder,Uint8Array,ArrayBuffer,DataView,setTimeout,clearTimeout,btoa,atob
  });
  const html = await build();
  assert.ok(!html.includes('PRIVATE_SYNTHETIC_READER') && !html.includes(password));
  const passwordInputs = [...html.matchAll(/<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/g)].map(match => match[0]).filter(input => /\bid="unlockPassword"/.test(input));
  assert.equal(passwordInputs.length,1);
  assert.match(passwordInputs[0], /\btype="password"/);
  assert.match(passwordInputs[0], /\bautocomplete="off"/);
  assert.doesNotMatch(html,/localStorage|sessionStorage|indexedDB|document\.cookie/);
  assert.match(html,/password\.value = ''/);
});

test('a 16 MiB reader envelope decodes on native and insecure-context backends without regexp stack overflow',async () => {
  const text = '<!doctype html><p>' + '0123456789abcdef'.repeat(1024 * 1024) + '</p>';
  const native = adapter(true), session = await native.createSession(password);
  const envelope = await native.encryptText(text,session,'reader');
  assert.ok(envelope.data.length > 16 * 1024 * 1024);
  for (const backend of [native,adapter(false)]) {
    const actual = await backend.decryptText(envelope,password,'reader');
    assert.equal(actual.text.length,text.length);
    assert.ok(actual.text === text,'large HTML must remain byte-exact');
    actual.key.fill(0);
  }
});
