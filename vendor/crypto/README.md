# Offline crypto bundle

The userscript includes the minimum AES-GCM, SHA-256 and asynchronous PBKDF2 code from `@noble/ciphers` 2.4.0 and `@noble/hashes` 2.4.0. Native WebCrypto is preferred; the bundled implementation is used when `crypto.subtle` is unavailable on an HTTP origin. Secure randomness still requires `crypto.getRandomValues`.

Upstream documentation: [noble-ciphers](https://github.com/paulmillr/noble-ciphers), [noble-hashes](https://github.com/paulmillr/noble-hashes). Both upstream projects publish security audits; this integration is separately tested, not itself an independently audited cryptographic product. The complete MIT license texts are included here and embedded in exported crypto factories.

New exports derive a 256-bit key with PBKDF2-HMAC-SHA256, 600,000 iterations and a random 16-byte salt. Every encryption has a fresh random 12-byte IV; AES-GCM appends a 16-byte authentication tag. Envelope purpose and image path are authenticated as additional data. The password is never serialized. Decoding rejects unsupported parameters rather than running attacker-chosen work factors.

Rebuild using pinned dependencies:

```sh
pnpm --dir vendor/crypto install --frozen-lockfile --ignore-scripts
node scripts/build-crypto.cjs
node --test tests/crypto.test.cjs
```

`node scripts/build-crypto.cjs --embed-only` updates the userscript from the checked-in bundle and adapter without downloading dependencies. `adapter.template.js` owns the integration; `crypto-factory.js` and the marked userscript block are generated. No runtime CDN, `eval`, or external request is required.

The optional original `images/` backup remains plaintext by explicit user choice. Password-protected web publication consists of `index.html` and the encrypted image pack, not the entire backup directory. A strong, separately shared password is necessary; encryption does not stop an authorized reader from copying unlocked content.
