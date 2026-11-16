'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname,'..');
const vendor = path.join(root,'vendor','crypto');
// Rebuild dependencies live only in vendor/crypto; production is one userscript.
if (!process.argv.includes('--embed-only')) {
  const esbuild = require(path.join(vendor,'node_modules','esbuild'));
  esbuild.buildSync({entryPoints:[path.join(vendor,'entry.mjs')],absWorkingDir:vendor,bundle:true,format:'iife',globalName:'BistuNoble',platform:'browser',target:['es2020'],minify:true,legalComments:'none',tsconfigRaw:{compilerOptions:{}},outfile:path.join(vendor,'noble.min.js')});
}
const licenses = ['LICENSE-noble-ciphers.txt','LICENSE-noble-hashes.txt'].map(name => name + '\n' + fs.readFileSync(path.join(vendor,name),'utf8')).join('\n\n');
const bundle = '/*!\n@noble/ciphers 2.4.0; @noble/hashes 2.4.0\n' + licenses + '\n*/\n' + fs.readFileSync(path.join(vendor,'noble.min.js'),'utf8');
const factory = fs.readFileSync(path.join(vendor,'adapter.template.js'),'utf8').replace('/* BISTU_NOBLE_BUNDLE */',bundle);
fs.writeFileSync(path.join(vendor,'crypto-factory.js'),factory);
const file = path.join(root,'BISTU_Java_Extractor.user.js');
let source = fs.readFileSync(file,'utf8');
const begin = '    // BEGIN VENDORED OFFLINE CRYPTO';
const end = '    // END VENDORED OFFLINE CRYPTO';
const block = begin + '\n' + factory.split(/\r?\n/).map(line => line ? '    ' + line : '').join('\n') + '\n    const bistuCrypto = createBistuCrypto();\n' + end;
if (source.includes(begin)) source = source.slice(0,source.indexOf(begin)) + block + source.slice(source.indexOf(end) + end.length);
else source = source.replace('    function offlineLegacyReviewCurrent(item) {',block + '\n\n    function offlineLegacyReviewCurrent(item) {');
if (!source.includes(begin)) throw new Error('Crypto insertion anchor not found');
fs.writeFileSync(file,source.replace(/\r?\n/g,'\r\n'));
console.log('Embedded offline crypto factory (' + Buffer.byteLength(factory) + ' bytes).');
