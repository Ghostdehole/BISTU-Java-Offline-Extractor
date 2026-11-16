'use strict';
// Synthetic PNGs only. File cases use actual temporary files, not route mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { before, after, test } = require('node:test');
const { launch, createHarness } = require('./harness.cjs');
let browser, fixture;

before(async () => {
  browser = await launch();
  const harness = await createHarness(browser);
  try {
    fixture = await harness.page.evaluate(async () => {
      const images = [], originals = [];
      for (let index = 1; index <= 12; index++) {
        const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 16;
        const drawing = canvas.getContext('2d'); drawing.fillStyle = index % 2 ? '#ff0000' : '#0000ff'; drawing.fillRect(0, 0, 32, 16);
        const buffer = await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer();
        await __test.validateImageBuffer(buffer, 'image/png');
        images.push(['https://campus.invalid/original-' + index + '.png', { filename: 'img_' + index + '.png', downloaded: true, buffer }]);
        originals.push(canvas.toDataURL('image/png').split(',')[1]);
      }
      __test.setImages(images);
      const pack = await __test.createImagePack();
      const session = await __test.bistuCrypto.createSession('synthetic-pack-reader-password');
      const encrypted = await __test.createImagePack(session);
      const image = index => `<img alt="Synthetic packed diagram ${index} > ' &quot; &amp;" src="images/img_${index}.png">`;
      const row = (GlobalUID, DetailHtml) => ({ GlobalUID, TopicGuid: 'packed-synthetic-' + GlobalUID, QuestionType: 'Blank', ChapterName: 'Synthetic assets',
        Title: '<p>Synthetic asset question ' + GlobalUID + '</p>', DetailHtml, s2_done: true });
      __test.setData([row(0, '<p>Synthetic compact image reader</p>' + originals.map((_, index) => image(index + 1)).join(''))]);
      const short = __test.generateOfflineHtml(true, true, pack.summary.id);
      const encryptedHtml = __test.generateOfflineHtml(true, true, encrypted.summary.id);
      const plain = __test.generateOfflineHtml(true, false);
      __test.setData(originals.map((_, index) => row(index, Array.from({ length: 18 }, () => '<p>Synthetic spacing preserves an ordinary long question.</p>').join('') + image(index + 1))));
      const long = __test.generateOfflineHtml(true, true, pack.summary.id);
      return { short, long, plain, originals, pack, encrypted, encryptedHtml, key: Array.from(session.key) };
    });
  } finally { await harness.close(); }
});
after(async () => { await browser?.close(); });

function observedPack(source, mutation = '') {
  return source + '\n' + mutation + `
    if (window.__BISTU_IMAGE_PACK__ && typeof window.__BISTU_IMAGE_PACK__.decode === 'function') {
      const pack = window.__BISTU_IMAGE_PACK__, decode = pack.decode;
      window.__packStats ||= {active:0,peak:0,calls:[]};
      pack.decode = async function(file,key) {
        const stats=window.__packStats; stats.calls.push(file); stats.active++; stats.peak=Math.max(stats.peak,stats.active);
        try {await new Promise(resolve=>setTimeout(resolve,15));return await decode(file,key);}
        finally {stats.active--;}
      };
    }
  `;
}
async function withReader(fn, { protocol = 'http', html, packSource, packPresent = true, rawPresent = false, encrypted = false, fastTimeout = false, holdFirstPack = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 800 } });
  const errors = [], outside = [], requested = [], state = { packPresent, rawPresent, packCalls: 0, packSource: packSource ?? observedPack(encrypted ? fixture.encrypted.source : fixture.pack.source) };
  let directory;
  const packFile = (encrypted ? fixture.encrypted : fixture.pack).summary.file;
  const documentHtml = (typeof html === 'function' ? html() : html) || (encrypted ? fixture.encryptedHtml : fixture.short);
  const writePack = source => fs.writeFileSync(path.join(directory, packFile), source);
  try {
    await context.addInitScript(({ key, fastTimeout }) => {
      if (key) window.__BISTU_UNLOCK_KEY__ = Uint8Array.from(key);
      window.__blobAudit = { created: [], revoked: [] };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const url = create(value); __blobAudit.created.push(url); return url; };
      URL.revokeObjectURL = url => { __blobAudit.revoked.push(url); revoke(url); };
      if (fastTimeout) { const timeout = window.setTimeout.bind(window); window.setTimeout = (fn, delay, ...args) => timeout(fn, delay === 15000 ? 250 : delay, ...args); }
    }, { key: encrypted ? fixture.key : null, fastTimeout });
    await context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url()); requested.push(url.pathname);
      if (protocol === 'http' && url.origin === 'http://fixture.test') {
        if (url.pathname === '/packed-reader') return route.fulfill({ contentType: 'text/html', body: documentHtml });
        if (url.pathname === '/' + packFile) {
          state.packCalls++;
          if (holdFirstPack && state.packCalls === 1) await new Promise(resolve => { state.releaseFirstPack = resolve; });
          return route.fulfill(state.packPresent
            ? { contentType: 'text/javascript', body: state.packSource }
            : { status: 404, contentType: 'text/javascript', body: '' }).catch(() => {});
        }
        const match = url.pathname.match(/^\/images\/img_(\d+)\.png$/);
        if (match) return route.fulfill(state.rawPresent
          ? { contentType: 'image/png', body: Buffer.from(fixture.originals[Number(match[1]) - 1], 'base64') }
          : { status: 404, body: 'Synthetic absent image' });
      }
      outside.push(url.origin + url.pathname); return route.abort('blockedbyclient');
    });
    let url = 'http://fixture.test/packed-reader';
    if (protocol === 'file') {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bistu-packed-reader-'));
      fs.writeFileSync(path.join(directory, 'index.html'), documentHtml);
      if (packPresent) writePack(state.packSource);
      if (rawPresent) { fs.mkdirSync(path.join(directory, 'images')); fixture.originals.forEach((data, index) => fs.writeFileSync(path.join(directory, 'images', 'img_' + (index + 1) + '.png'), Buffer.from(data, 'base64'))); }
      url = pathToFileURL(path.join(directory, 'index.html')).href;
    }
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await fn({ page, state, requested, errors, writePack });
    assert.deepEqual(errors, [], 'unexpected reader errors');
    assert.deepEqual(outside, [], 'assets must never auto-fetch campus or other external URLs');
  } finally {
    state.releaseFirstPack?.();
    await context.close();
    if (directory) {
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(directory));
      if (relative.startsWith('..') || path.isAbsolute(relative) || !path.basename(directory).startsWith('bistu-packed-reader-')) throw Error('Unsafe synthetic fixture cleanup path');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
async function waitForImages(page, { count = 12, blob = false } = {}) {
  await page.waitForFunction(({ count, blob }) => {
    const images = [...document.querySelectorAll('.detail-box img')];
    return images.length === count && images.every(image => image.complete && image.naturalWidth === 32 && image.naturalHeight === 16 &&
      image.dataset.readerParked !== 'true' && (blob ? image.src.startsWith('blob:') : !image.src.startsWith('data:image/svg')));
  }, { count, blob });
  const descriptions = await page.locator('.detail-box img').evaluateAll(images => images.map(image => image.getAttribute('alt')));
  assert.deepEqual(descriptions, Array.from({ length: count }, (_, index) => `Synthetic packed diagram ${index + 1} > ' " &`));
}
async function verifyPixels(page) {
  const pixels = await page.locator('.detail-box img').evaluateAll(images => images.map(image => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0, 1, 1); return Array.from(context.getImageData(0, 0, 1, 1).data);
  }));
  for (const [index, pixel] of pixels.entries()) assert.deepEqual(pixel, index % 2 ? [0, 0, 255, 255] : [255, 0, 0, 255]);
}

for (const protocol of ['http', 'file']) {
  test('packed reader ' + protocol + ': a package alone displays exact images with two decode workers', () => withReader(async ({ page, requested }) => {
    await waitForImages(page, { blob: true }); await verifyPixels(page);
    assert.equal(await page.locator('.img-failed').count(), 0);
    const stats = await page.evaluate(() => __packStats);
    assert.equal(stats.calls.length, 12); assert.ok(stats.peak > 0 && stats.peak <= 2);
    assert.equal(requested.filter(url => url.startsWith('/images/')).length, 0, 'working package should not request original backups');
  }, { protocol }));

  test('packed reader ' + protocol + ': missing package falls back to original image files', () => withReader(async ({ page }) => {
    await waitForImages(page);
    // Raw file:// images have opaque origins in some engines. Their native
    // decode is checked here; exact packed pixels are checked above on file://.
    if (protocol === 'http') await verifyPixels(page);
    assert.equal(await page.locator('.img-failed').count(), 0);
    assert.equal(await page.locator('.detail-box img').evaluateAll(images => images.some(image => image.src.startsWith('blob:'))), false);
  }, { protocol, packPresent: false, rawPresent: true }));
}

test('packed reader: corrupt package and wrong package ID cannot replace original backups', async () => {
  for (const source of ['window.__BISTU_IMAGE_PACK__={version:0};', observedPack(fixture.pack.source, 'window.__BISTU_IMAGE_PACK__.id="00000000000000000000000000000000";')]) {
    await withReader(async ({ page }) => {
      await waitForImages(page); await verifyPixels(page);
      assert.equal(await page.locator('.detail-box img').evaluateAll(images => images.some(image => image.src.startsWith('blob:'))), false);
      assert.equal(await page.evaluate(() => window.__packStats?.calls.length || 0), 0);
    }, { packSource: source, rawPresent: true });
  }
});

test('packed reader: a corrupt entry or undecodable packed image falls back without losing healthy entries', async () => {
  const variants = [
    'window.__BISTU_IMAGE_PACK__.files["images/img_1.png"].crc32="00000000";',
    'Object.assign(window.__BISTU_IMAGE_PACK__.files["images/img_1.png"],{encoding:"raw",data:"AQID",size:3,packedSize:3,crc32:"55bc801d"});'
  ];
  for (const mutation of variants) await withReader(async ({ page, requested }) => {
    await waitForImages(page); await verifyPixels(page);
    assert.equal(await page.locator('.detail-box img').first().evaluate(image => image.src.startsWith('blob:')), false);
    assert.equal(await page.locator('.detail-box img').last().evaluate(image => image.src.startsWith('blob:')), true);
    assert.deepEqual(requested.filter(url => url.startsWith('/images/')), ['/images/img_1.png']);
    assert.equal(await page.locator('.img-failed').count(), 0);
  }, { packSource: observedPack(fixture.pack.source, mutation), rawPresent: true });
});

for (const protocol of ['http', 'file']) {
  test('packed reader ' + protocol + ': both missing sources show one retry placeholder and recover when the package returns', () => withReader(async ({ page, state, writePack }) => {
    await page.waitForFunction(() => document.querySelectorAll('.detail-box .img-failed').length === 12);
    assert.equal(await page.locator('.detail-box .image-retry').count(), 12);
    assert.equal(await page.locator('.detail-box img').count(), 0);
    if (protocol === 'file') writePack(observedPack(fixture.pack.source)); else state.packPresent = true;
    await page.locator('.image-retry').first().click();
    await waitForImages(page, { blob: true }); await verifyPixels(page);
    assert.equal(await page.locator('.detail-box .img-failed').count(), 0);
  }, { protocol, packPresent: false }));
}

test('packed reader: unlocked encrypted entries become valid image blobs without original files or a global key', () => withReader(async ({ page }) => {
  await waitForImages(page, { blob: true }); await verifyPixels(page);
  assert.equal(await page.evaluate(() => '__BISTU_UNLOCK_KEY__' in window), false);
  assert.equal(await page.locator('.img-failed').count(), 0);
}, { encrypted: true }));

test('packed reader: a timed-out package request releases its loader so a new retry can recover', () => withReader(async ({ page, state }) => {
  await page.waitForFunction(() => document.querySelectorAll('.detail-box .img-failed').length === 12);
  assert.equal(state.packCalls, 1);
  assert.equal(await page.locator('script[src*="question-images."]').count(), 0, 'the abandoned loader removes its listeners and script node');
  await page.locator('.image-retry').first().click();
  await waitForImages(page, { blob: true }); await verifyPixels(page);
  assert.equal(state.packCalls, 2, 'retry must issue a new request instead of reusing the resolved timeout');
  state.releaseFirstPack();
  await page.waitForTimeout(50);
  assert.equal(await page.locator('.detail-box .img-failed').count(), 0);
  assert.equal(await page.locator('script[src*="question-images."]').count(), 0);
}, { fastTimeout: true, holdFirstPack: true }));

test('packed reader: offscreen blobs are released, restored on return, and all original images finish before print', () => withReader(async ({ page }) => {
  const first = page.locator('.detail-box img').first(), last = page.locator('.detail-box img').last();
  await first.waitFor(); await first.scrollIntoViewIfNeeded();
  await page.waitForFunction(() => { const image = document.querySelector('.detail-box img'); return image.complete && image.src.startsWith('blob:') && image.naturalWidth === 32; });
  const firstUrl = await first.getAttribute('src');
  await last.scrollIntoViewIfNeeded();
  await page.waitForFunction(url => __blobAudit.revoked.includes(url), firstUrl);
  assert.equal(await first.getAttribute('data-reader-parked'), 'true');
  await first.scrollIntoViewIfNeeded();
  await page.waitForFunction(previous => { const image = document.querySelector('.detail-box img'); return image.complete && image.src.startsWith('blob:') && image.src !== previous && image.naturalWidth === 32; }, firstUrl);
  await page.evaluate(() => { window.__packedPrints = []; window.print = () => __packedPrints.push([...document.querySelectorAll('.detail-box img')].every(image => image.complete && image.naturalWidth === 32 && image.src.startsWith('blob:') && image.dataset.readerParked !== 'true')); });
  await page.locator('#printBtn').click();
  await page.waitForFunction(() => window.__packedPrints?.length === 1);
  assert.deepEqual(await page.evaluate(() => __packedPrints), [true]);
  assert.ok(await page.evaluate(() => __packStats.peak <= 2));
}, { html: () => fixture.long }));

test('packed reader: protected pagehide cancels queued decodes and never creates blobs from already decrypted in-flight jobs', () => {
  const source=fixture.encrypted.source+`;{
    const decode=__BISTU_IMAGE_PACK__.decode;
    window.__heldDecoded=[];window.__decodeCalls=0;
    __BISTU_IMAGE_PACK__.decode=async function(path,key){
      __decodeCalls++;const bytes=await decode(path,key);
      await new Promise(resolve=>__heldDecoded.push(resolve));return bytes;
    };
  }`;
  return withReader(async({page})=>{
    await page.waitForFunction(()=>__heldDecoded?.length===2);
    assert.equal(await page.evaluate(()=>__blobAudit.created.length),0);
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    await page.evaluate(()=>__heldDecoded.splice(0).forEach(resolve=>resolve()));
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(()=>({blobs:__blobAudit.created.length,calls:__decodeCalls,topics:document.querySelectorAll('.topic').length})),{blobs:0,calls:2,topics:0});
  },{encrypted:true,packSource:source});
});

test('packed reader: an old offscreen decode cannot release a new lease after a rapid return', () => {
  const source=fixture.pack.source+`;{
    const decode=__BISTU_IMAGE_PACK__.decode;window.__firstImageGates=[];
    __BISTU_IMAGE_PACK__.decode=async function(path,key){
      const bytes=await decode(path,key);
      if(path==='images/img_1.png')await new Promise(resolve=>__firstImageGates.push(resolve));
      return bytes;
    };
  }`;
  return withReader(async({page})=>{
    const first=page.locator('.detail-box img').first(),last=page.locator('.detail-box img').last();
    await first.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>__firstImageGates?.length===1);
    await last.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>document.querySelector('.detail-box img').dataset.readerParked==='true');
    await first.scrollIntoViewIfNeeded();
    await page.waitForFunction(()=>__firstImageGates.length===2);
    await page.evaluate(()=>__firstImageGates[0]());await page.waitForTimeout(25);
    await page.evaluate(()=>__firstImageGates[1]());
    await page.waitForFunction(()=>{const image=document.querySelector('.detail-box img');return image?.src.startsWith('blob:')&&image.complete&&image.naturalWidth===32;});
    assert.equal(await page.locator('.img-failed').count(),0);
  },{html:()=>fixture.long,packSource:source});
});
