'use strict';
// Exact production pack functions, isolated without a browser, network or API key.
const assert = require('node:assert/strict');
const {test} = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');
const JSZip = require('jszip');
const source = fs.readFileSync(path.join(__dirname,'..','BISTU_Java_Extractor.user.js'),'utf8');
const helpers = source.slice(source.indexOf('    function imagePackInflateFactory()'),source.indexOf('    async function buildZipAndDownload'));
const mime = source.slice(source.indexOf('    function imageMime('),source.indexOf('    async function aiImageDataUrl'));
const cryptoFactory = source.slice(source.indexOf('    function createBistuCrypto()'),source.indexOf('    const bistuCrypto = createBistuCrypto();'));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMZkAAAAASUVORK5CYII=','base64');
const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><desc>'+'A distinct repeated sample. '.repeat(8192)+'</desc><rect width="80" height="80" fill="red"/></svg>');
function context(extra={}) {
  return vm.createContext({Uint8Array,ArrayBuffer,DataView,TextEncoder,TextDecoder,atob,btoa,
    crypto:webcrypto,window:{btoa},JSZip,Map,console,setTimeout,clearTimeout,...extra});
}
function builder(entries=[['source-a',{filename:'img_1.png',buffer:png}],['source-b',{filename:'img_2.svg',buffer:svg}]]) {
  const ctx=context({imageQueue:new Map(entries),yieldThread:async()=>{},bufferToBase64:value=>Buffer.from(value).toString('base64')});
  vm.runInContext(cryptoFactory+';const bistuCrypto=createBistuCrypto();'+mime+helpers+';globalThis.packHelpers={createImagePack,installImagePack,imagePackCrc32,imagePackInflateFactory,compressImagePackBytes};globalThis.packCrypto=bistuCrypto;',ctx);
  return ctx;
}
function reader(packSource,extra={}) {
  const ctx=context(extra);
  // No JSZip, browser decoder, DecompressionStream or fetch is available to the pack.
  delete ctx.JSZip;delete ctx.console;
  vm.runInContext(packSource,ctx);
  return ctx.window.__BISTU_IMAGE_PACK__;
}
function replaceEntry(pack,file,change) {Object.assign(pack.files[file],change);return pack;}

test('a 16 MiB raw image pack validates base64 without regexp recursion or byte loss',async()=>{
  const bytes=Buffer.alloc(16*1024*1024);
  for(let index=0;index<bytes.length;index++) bytes[index]=(index*31+17)&255;
  const ctx=builder(),file='images/img_1.png';
  const manifest={version:1,files:{[file]:{encoding:'raw',data:bytes.toString('base64'),size:bytes.length,packedSize:bytes.length,crc32:ctx.packHelpers.imagePackCrc32(bytes),mime:'image/png'}}};
  ctx.packHelpers.installImagePack(manifest,()=>{throw Error('raw data must not inflate');},ctx.packHelpers.imagePackCrc32,null);
  const actual=await ctx.window.__BISTU_IMAGE_PACK__.decode(file);
  assert.equal(actual.length,bytes.length);
  assert.ok(Buffer.from(actual).equals(bytes));
});

test('standalone pack preserves raw and level-9 DEFLATE image bytes without eager decoding',async()=>{
  const ctx=builder(), originalPng=Buffer.from(png),originalSvg=Buffer.from(svg);
  const built=await ctx.packHelpers.createImagePack(),pack=reader(built.source);
  assert.match(pack.id,/^[0-9a-f]{32}$/);assert.equal(built.summary.id,pack.id);
  assert.equal(built.summary.file,'question-images.'+pack.id+'.pack.js');
  assert.ok(['raw','deflate'].includes(pack.files['images/img_1.png'].encoding));
  assert.equal(pack.files['images/img_2.svg'].encoding,'deflate');
  assert.equal(built.summary.count,2);assert.equal(built.summary.rawFiles+built.summary.compressedFiles,2);assert.ok(built.summary.compressedFiles>=1);
  assert.equal(built.summary.originalBytes,png.length+svg.length);
  assert.equal(built.summary.scriptBytes,Buffer.byteLength(built.source));
  assert.ok(built.summary.encodedBytes < built.summary.originalBytes);
  assert.deepEqual(Buffer.from(await pack.decode('images/img_1.png')),png);
  assert.deepEqual(Buffer.from(await pack.decode('images/img_2.svg')),svg);
  assert.deepEqual(png,originalPng);assert.deepEqual(svg,originalSvg);
  const another=await ctx.packHelpers.createImagePack();assert.notEqual(another.summary.id,built.summary.id);
  let calls=0;const lazy=context();
  const manifest=JSON.parse(JSON.stringify(pack));
  Object.assign(manifest.files['images/img_1.png'],{encoding:'raw',data:png.toString('base64'),packedSize:png.length});
  const install=vm.runInContext('('+ctx.packHelpers.installImagePack.toString()+')',lazy);
  install(manifest,()=>{calls++;return ctx.packHelpers.imagePackInflateFactory();},ctx.packHelpers.imagePackCrc32,null);
  assert.equal(calls,0);await lazy.window.__BISTU_IMAGE_PACK__.decode('images/img_1.png');assert.equal(calls,0);
  await lazy.window.__BISTU_IMAGE_PACK__.decode('images/img_2.svg');assert.equal(calls,1);
});

test('pack rejects corruption, wrong sizes, missing files and excessive inflate output',async()=>{
  const built=await builder().packHelpers.createImagePack();
  await assert.rejects(reader(built.source).decode('images/img_404.png'),/不存在/);
  const file='images/img_2.svg';
  for (const change of [{crc32:'00000000'},{data:'%%%='},{size:1000},{packedSize:0},{encoding:'gzip'}]) {
    await assert.rejects(replaceEntry(reader(built.source),file,change).decode(file));
  }
  const truncated=reader(built.source),entry=truncated.files[file],bytes=Buffer.from(entry.data,'base64').subarray(0,entry.packedSize-2);
  entry.data=bytes.toString('base64');entry.packedSize=bytes.length;
  await assert.rejects(truncated.decode(file),/压缩内容损坏|长度/);
  const raw=reader(built.source),rawEntry=raw.files['images/img_1.png'],changed=Buffer.from(png);changed[0]^=1;
  Object.assign(rawEntry,{encoding:'raw',data:changed.toString('base64'),packedSize:changed.length});
  await assert.rejects(raw.decode('images/img_1.png'),/校验失败/);
});

test('compression failure keeps original bytes and invalid image paths fail before packaging',async()=>{
  const ctx=builder();vm.runInContext('compressImagePackBytes=async()=>{throw new Error("synthetic compressor unavailable")}',ctx);
  const built=await ctx.packHelpers.createImagePack(),pack=reader(built.source);
  assert.equal(built.summary.compressionFallbacks,2);assert.equal(built.summary.rawFiles,2);
  assert.deepEqual(Buffer.from(await pack.decode('images/img_2.svg')),svg);
  for (const entries of [
    [['a',{filename:'../private.png',buffer:png}]],
    [['a',{filename:'img_1.png',buffer:png}],['b',{filename:'img_1.png',buffer:svg}]],
    [['a',{filename:'img_1.png',buffer:Buffer.alloc(0)}]]
  ]) await assert.rejects(builder(entries).packHelpers.createImagePack());
});

test('encrypted pack decrypts each image independently and rejects wrong keys, moved entries and tampering',async()=>{
  const ctx=builder(),password='synthetic-pack-passphrase-ONLY';
  const session=await ctx.packCrypto.createSession(password),built=await ctx.packHelpers.createImagePack(session);
  assert.ok(!built.source.includes(password));assert.ok(!built.source.includes(Buffer.from(session.key).toString('base64')));
  const pack=reader(built.source),file='images/img_2.svg';
  assert.equal(pack.crypto.iterations,600000);assert.equal(built.summary.encryptedFiles,2);
  assert.equal(built.summary.payloadBytes,built.summary.encodedBytes+32);
  assert.notEqual(pack.files['images/img_1.png'].iv,pack.files[file].iv);
  assert.ok(!built.source.includes(svg.toString('base64')));
  assert.deepEqual(Buffer.from(await pack.decode(file,session.key)),svg);
  await assert.rejects(pack.decode(file),/解锁/);
  await assert.rejects(reader(built.source).decode(file,new Uint8Array(32)),/密码错误|损坏/);
  const moved=reader(built.source);moved.files['images/img_3.svg']={...moved.files[file]};
  await assert.rejects(moved.decode('images/img_3.svg',session.key),/密码错误|损坏/);
  const corrupt=reader(built.source),data=Buffer.from(corrupt.files[file].data,'base64');data[4]^=1;corrupt.files[file].data=data.toString('base64');
  await assert.rejects(corrupt.decode(file,session.key),/密码错误|损坏/);
  // Insecure HTTP lacks SubtleCrypto: the embedded offline decoder must still work.
  const noSubtle=reader(built.source,{crypto:{getRandomValues:array=>webcrypto.getRandomValues(array)}});
  assert.deepEqual(Buffer.from(await noSubtle.decode(file,session.key)),svg);
  session.key.fill(0);
});

test('ZIP export binds its versioned pack and protects reader/state/report while keeping exact original-image backups',async()=>{
  for (const exportProtection of ['none','password']) {
    const ctx=builder(),secret='QUESTION_OPTION_ANSWER_SENTINEL',password='synthetic-export-password';
    Object.assign(ctx,{Blob,URL,SCRIPT_VERSION:'synthetic',panelOperation:'idle',engineRunning:false,
      latestPackage:null,taskHasStarted:false,imgCounter:2,globalState:{stage:5},allData:[{Title:secret,Answer:secret}],
      getSettings:()=>({exportProtection}),getExportPassword:()=>password,homeworkEnabled:()=>false,
      refreshPanelControls:()=>{},addLog:()=>{},getFormattedTime:()=> 'synthetic',
      generateExtractionReport:()=>({synthetic:secret}),generateOfflineHtml:(final,available,id)=>'<html data-pack-id="'+id+'">'+secret+'</html>',
      document:{getElementById:()=>({})}});
    const protectedHtml=source.slice(source.indexOf('    async function generateProtectedHtml('),source.indexOf('    function offlineLegacyReviewCurrent'));
    const buildCode=source.slice(source.indexOf('    async function buildZipAndDownload('),source.indexOf('    function offlineQuestionClassification'));
    vm.runInContext(protectedHtml+buildCode+';globalThis.buildZip=buildZipAndDownload;'+
      'const originalSession=packCrypto.createSession;packCrypto.createSession=async password=>{const session=await originalSession(password);globalThis.exportKey=session.key;return session;};',ctx);
    await ctx.buildZip(true);
    const zip=await JSZip.loadAsync(await ctx.latestPackage.blob.arrayBuffer()),names=Object.keys(zip.files);
    const packName=names.find(name=>/^question-images\.[0-9a-f]{32}\.pack\.js$/.test(name));
    assert.ok(packName);assert.ok(!names.includes('question-images.pack.js'));
    assert.deepEqual(await zip.file('images/img_1.png').async('nodebuffer'),png);
    assert.deepEqual(await zip.file('images/img_2.svg').async('nodebuffer'),svg);
    const html=await zip.file('index.html').async('string'),stateText=await zip.file('state.json').async('string'),reportText=await zip.file('extraction-report.json').async('string');
    const pack=reader(await zip.file(packName).async('string'));
    let state,report,readerHtml;
    if (exportProtection==='password') {
      for (const text of [html,stateText,reportText]) {assert.ok(!text.includes(secret));assert.ok(!text.includes(password));}
      const restored=await ctx.packCrypto.decryptText(JSON.parse(stateText),password,'state');state=JSON.parse(restored.text);
      report=JSON.parse((await ctx.packCrypto.decryptText(JSON.parse(reportText),password,'report')).text);
      const envelope=JSON.parse(html.match(/\{"format":"bistu-encrypted","version":1,"crypto":.*?,"data":"[A-Za-z0-9+/=]+"\}/)[0]);
      readerHtml=(await ctx.packCrypto.decryptText(envelope,password,'reader')).text;
      assert.deepEqual(Buffer.from(await pack.decode('images/img_2.svg',restored.key)),svg);
      assert.ok(Array.from(ctx.exportKey).every(value=>value===0),'export session raw key is cleared after packaging');
      restored.key.fill(0);
    } else {state=JSON.parse(stateText);report=JSON.parse(reportText);readerHtml=html;}
    assert.equal(state.allData[0].Title,secret);assert.ok(!JSON.stringify(state).includes(password));
    assert.equal(report.imagePack.id,pack.id);assert.equal(report.imagePack.file,packName);
    assert.ok(readerHtml.includes('data-pack-id="'+pack.id+'"'));assert.ok(readerHtml.includes(secret));
    assert.equal(ctx.panelOperation,'idle');assert.equal(ctx.latestPackage.isFinal,true);
  }
});
