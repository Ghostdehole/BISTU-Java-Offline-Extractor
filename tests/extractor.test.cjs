const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launch, createHarness } = require('./harness.cjs');
const JSZip = require('jszip');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

async function withPage(fn) {
  const h = await createHarness(browser);
  try { return await fn(h.page); } finally { await h.close(); }
}

test('five question types: scans, preserves requirements, finds associated labels and exact answer values', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    const types = ['Single', 'Multiple', 'TrueOrFalse', 'Blank', 'Program'];
    const values = ['A&B=1', 'B + 2'];
    window.__respond = ({ url, data }) => {
      if (url.includes('GetTopicData')) {
        const type = types[Number(data.questionType) - 1];
        return { Total: 1, DataList: [{ QuestionType: type, TopicGuid: 'fixture-' + type, Title: '<p>synthetic ' + type + '</p>', Requirement: '<pre>Required output: 42</pre>', ChapterName: 'Fixture', DegreeLevel: '中等' }] };
      }
      if (url.includes('JumpToPracticeTopic')) {
        const type = new URL(url, location.origin).searchParams.get('QuestionType');
        const inputType = type === 'Multiple' ? 'checkbox' : 'radio';
        return `<form><input type="hidden" name="Guid" value="fixture-${type}"><h2>Synthetic ${type}</h2><input id="option-a" type="${inputType}" name="UserSelect" value="A&amp;B=1"><label for="option-a">Correct ${type}<img src="/fixtures/answer.png"></label><label><input type="${inputType}" name="UserSelect" value="B + 2">Second option</label></form>`;
      }
      const selected = [].concat(data.UserSelect || []);
      return { Result: url.endsWith('Multiple') ? values.every(v => selected.includes(v)) && selected.length === 2 : selected.length === 1 && selected[0] === values[0] };
    };
    await __test.runStage1();
    await __test.runStage2();
    return { data: __test.data, images: Array.from(__test.images), calls: __ajaxCalls, stage: __test.state.stage };
  });
  assert.equal(result.data.length, 5);
  assert.equal(result.stage, 3);
  for (const item of result.data) assert.equal(item.s2_done, true, item.QuestionType);
  for (const item of result.data.slice(0, 3)) {
    assert.match(item.SniffedAnswer, new RegExp('Correct ' + item.QuestionType));
    assert.match(item.SniffedAnswer, /images\/img_\d+\.png/);
    assert.doesNotMatch(item.SniffedAnswer, /src="\/fixtures\//);
    assert.doesNotMatch(item.DetailHtml, /<script|onclick=/);
  }
  assert.match(result.data[3].DetailHtml, /Required output: 42/);
  assert.match(result.data[4].DetailHtml, /Required output: 42/);
  assert.equal(result.images.length, 1, 'same picture shared by details/answers is deduplicated');
  assert.ok(result.calls.some(c => c.data?.UserSelect === 'A&B=1'));
  assert.ok(result.calls.some(c => Array.isArray(c.data?.UserSelect) && c.data.UserSelect.includes('A&B=1')));
}));

test('list request failure retains cursor and a retry neither loses nor duplicates a page', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    let fail = true;
    window.__respond = ({ data }) => {
      if (data.questionType !== 1) return { Total: 0, DataList: [] };
      if (data.pageIndex === 2 && fail) throw new Error('synthetic network failure');
      const offset = (data.pageIndex - 1) * 10;
      return { Total: 21, DataList: Array.from({ length: Math.min(10, 21 - offset) }, (_, i) => ({ TopicGuid: 'fixture-' + (offset + i), QuestionType: 'Single', Title: 'Synthetic ' + (offset + i) })) };
    };
    let error;
    try { await __test.runStage1(); } catch (e) { error = e.message; }
    const paused = { cursor: __test.state.listProgress.pageIndex, stage: __test.state.stage, count: __test.data.length, error };
    fail = false;
    __test.state.isPaused = false;
    await __test.runStage1();
    return { paused, count: __test.data.length, ids: __test.data.map(q => q.TopicGuid), stage: __test.state.stage };
  });
  assert.ok(result.paused.error, 'network failure must be surfaced');
  assert.equal(result.paused.cursor, 2);
  assert.equal(result.paused.stage, 1);
  assert.equal(result.paused.count, 10);
  assert.equal(result.count, 21);
  assert.equal(new Set(result.ids).size, 21);
  assert.equal(result.stage, 2);
}));

test('invalid or truncated list response does not look like an empty successful question bank', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    window.__respond = () => ({ Total: 20, DataList: [] });
    let error;
    try { await __test.runStage1(); } catch (e) { error = e.message; }
    return { error, stage: __test.state.stage, cursor: __test.state.listProgress.pageIndex };
  });
  assert.ok(result.error);
  assert.equal(result.stage, 1);
  assert.equal(result.cursor, 1);
}));

test('explicit zero with null DataList is empty, but missing or null Total is invalid', () => withPage(async page => {
  const actual = await page.evaluate(async () => {
    __respond = () => ({ Total: 0, DataList: null });
    await __test.runStage1();
    const empty = { stage: __test.state.stage, count: __test.data.length };
    const invalid = [];
    for (const response of [{ Total: null, DataList: [] }, { DataList: [] }]) {
      __test.state.stage = 1;
      __test.state.listProgress = { typeIndex: 0, pageIndex: 1, totalPages: 0 };
      __respond = () => response;
      let error;
      try { await __test.runStage1(); } catch (e) { error = e.message; }
      invalid.push({ error, stage: __test.state.stage });
    }
    return { empty, invalid };
  });
  assert.deepEqual(actual.empty, { stage: 2, count: 0 });
  assert.ok(actual.invalid.every(result => result.error && result.stage === 1));
}));

test('login redirect in detail pauses extraction and leaves the question retryable', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 2;
    __test.setData([{ TopicGuid: 'fixture', QuestionType: 'Single', Title: 'Synthetic', GlobalUID: 0, s2_done: false }]);
    window.__respond = () => '<form><input type="password"><button>Sign in</button></form>';
    await __test.runStage2();
    return { stage: __test.state.stage, paused: __test.state.isPaused, done: __test.data[0].s2_done, submissions: __ajaxCalls.filter(c => c.method === 'post').length };
  });
  assert.equal(result.paused, true);
  assert.equal(result.stage, 2);
  assert.equal(result.done, false);
  assert.equal(result.submissions, 0);
}));

test('blank and program extraction needs no API key and skipped AI remains resumable', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 3;
    __test.setData(['Blank', 'Program'].map((QuestionType, GlobalUID) => ({ QuestionType, GlobalUID, Title: 'Synthetic', DetailHtml: '<p>Synthetic details</p>', NeedsAI: true, s2_done: true, s3_done: false })));
    await __test.runStage3();
    return { stage: __test.state.stage, data: __test.data };
  });
  assert.equal(result.stage, 4);
  assert.ok(result.data.every(q => q.s3_done === false && !q.SniffedAnswer));
}));

test('pause ZIP then final ZIP both retain identical image bytes and extraction scope', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __values['#input_Search'] = 'scope keyword';
    __values['#select_DegreeLevel'] = ['2', '3'];
    __chapters = [{ id: 'synthetic-chapter' }];
    __test.initializePlatformVariables();
    __test.state.stage = 4;
    __test.setImages([['http://fixture.test/picture.png', { filename: 'img_1.png', buffer: new Uint8Array([1, 2, 3, 4]).buffer, downloaded: true, failed: false }]]);
    await __test.buildZipAndDownload(false);
    await __test.buildZipAndDownload(true);
    const zips = [];
    for (const zip of __zips) zips.push({ files: Object.keys(zip.files), bytes: zip.file('images/img_1.png') ? Array.from(await zip.file('images/img_1.png').async('uint8array')) : null, state: JSON.parse(await zip.file('state.json').async('string')) });
    return zips;
  });
  assert.equal(result.length, 2);
  for (const zip of result) {
    assert.deepEqual(zip.bytes, [1, 2, 3, 4]);
    assert.equal(zip.state.globalState.scope.search, 'scope keyword');
    assert.equal(zip.state.globalState.scope.chapter, 'synthetic-chapter');
    assert.equal(zip.state.globalState.scope.degree, '2,3');
  }
}));

test('offline HTML treats metadata/AI as text and removes executable rich content', () => withPage(async page => {
  const result = await page.evaluate(() => {
    const code = 'String s = "&lt;tag&gt; &amp;";\nif (a < b && b > 0) {}';
    __test.setData([
      { GlobalUID: 0, QuestionType: 'Program', ChapterName: '<img src=x onerror="window.pwned=1">', DegreeLevel: "x' onclick='window.pwned=1", DetailHtml: '<p onclick="window.pwned=1">Safe text</p><script>window.pwned=1</script><iframe src="https://evil.invalid"></iframe><a href="javascript:alert(1)">bad link</a><img src="images/img_1.png" onerror="alert(1)">', IsAIAnswer: true, SniffedAnswer: code },
      { GlobalUID: 1, QuestionType: 'Blank', DetailHtml: '<p>Blank fixture</p>', IsAIAnswer: true, SniffedAnswer: '<img src=x onerror="alert(1)"> & exact' }
    ]);
    const html = __test.generateOfflineHtml(true);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const details = doc.querySelector('.detail-box');
    return { code, renderedCode: doc.querySelector('.code-box').textContent, chapter: doc.querySelectorAll('.meta')[1].textContent, blank: doc.querySelectorAll('.answer-box')[1].textContent, scripts: details.querySelectorAll('script,iframe,object,embed').length, handlers: Array.from(doc.querySelectorAll('.topic *')).flatMap(el => Array.from(el.attributes).filter(a => /^on/i.test(a.name) && !el.classList.contains('copy-btn')).map(a => a.name)), hrefs: Array.from(details.querySelectorAll('a')).map(a => a.getAttribute('href')), viewport: !!doc.querySelector('meta[name="viewport"]') };
  });
  assert.equal(result.renderedCode, result.code);
  assert.match(result.chapter, /<img src=x onerror=/);
  assert.match(result.blank, /<img src=x onerror="alert\(1\)"> & exact/);
  assert.equal(result.scripts, 0);
  assert.deepEqual(result.handlers, []);
  assert.ok(result.hrefs.every(href => !href || !href.startsWith('javascript:')));
  assert.equal(result.viewport, true);
}));

test('offline search/type/difficulty filters, answer visibility and theme work without network', () => withPage(async page => {
  const html = await page.evaluate(() => {
    __test.setData([
      { GlobalUID: 0, QuestionType: 'Single', ChapterName: 'Fixture', DegreeLevel: '简单', DetailHtml: '<p>Alpha synthetic question</p>', SniffedAnswer: 'A' },
      { GlobalUID: 1, QuestionType: 'Program', ChapterName: 'Fixture', DegreeLevel: '中等', DetailHtml: '<p>Beta synthetic question</p>', SniffedAnswer: 'class Test {}', IsAIAnswer: true }
    ]);
    return __test.generateOfflineHtml(true);
  });
  await page.setContent(html);
  await page.locator('#keywordFilter').fill('beta');
  await page.waitForFunction(() => document.getElementById('visibleCount').textContent === '1');
  assert.equal(await page.locator('.topic:not(.hidden)').count(), 1);
  await page.locator('#typeFilter').selectOption('Single');
  await page.waitForFunction(() => document.getElementById('visibleCount').textContent === '0');
  await page.locator('#keywordFilter').fill('');
  await page.locator('#diffFilter').selectOption('简单');
  await page.waitForFunction(() => document.getElementById('visibleCount').textContent === '1');
  assert.match(await page.locator('.topic:not(.hidden)').innerText(), /Alpha/);
  await page.locator('#toggleAnsBtn').click();
  assert.equal(await page.locator('.topic:not(.hidden) .answer-box').isVisible(), false);
  await page.locator('#toggleAnsBtn').click();
  assert.equal(await page.locator('.topic:not(.hidden) .answer-box').isVisible(), true);
  await page.locator('#themeToggle').selectOption('dark');
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('dark-mode')), true);
}));

test('engine prevents overlapping runs while a stage is waiting', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    let enterCount = 0, release, packages = 0;
    const gate = new Promise(resolve => { release = resolve; });
    __test.setEngineStage(1, async () => { enterCount++; await gate; __test.state.isPaused = true; });
    __test.setBuilder(async () => { packages++; });
    const first = __test.runEngine();
    const second = __test.runEngine();
    release();
    await Promise.all([first, second]);
    return { enterCount, packages };
  });
  assert.equal(result.enterCount, 1);
  assert.equal(result.packages, 1);
}));

test('API exhaustion can resume after replacing the key', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 3;
    __test.state.isPaused = true;
    __test.state.outOfKeys = true;
    document.getElementById('bistu-apikey').value = 'synthetic-test-key';
    let resumed = 0;
    __test.setEngineStage(3, async () => { resumed++; __test.state.isPaused = true; });
    __test.setBuilder(async () => {});
    document.getElementById('bistu-pause-btn').click();
    await new Promise(resolve => setTimeout(resolve, 20));
    return { resumed, outOfKeys: __test.state.outOfKeys, keys: __test.keyManager.getCount() };
  });
  assert.equal(result.resumed, 1);
  assert.equal(result.outOfKeys, false);
  assert.equal(result.keys, 1);
}));

function snapshot(overrides = {}) {
  return {
    schemaVersion: 1,
    globalState: { stage: 1, isPaused: true, outOfKeys: false, elapsedSeconds: 12, listProgress: { typeIndex: 0, pageIndex: 2, totalPages: 3 }, scope: { language: 'Java', degree: '3', chapter: 'original-chapter', knowledge: 'original-knowledge', search: 'original search', origin: 'http://fixture.test' } },
    allData: [], imageQueueList: [], imgCounter: 1,
    ...overrides
  };
}

async function uploadSnapshot(page, state, imageBytes) {
  const zip = new JSZip();
  zip.file('state.json', JSON.stringify(state));
  if (imageBytes) zip.file('images/img_1.png', imageBytes);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await page.locator('#bistu-file-input').setInputFiles({ name: 'synthetic-snapshot.zip', mimeType: 'application/zip', buffer });
}

test('snapshot import resumes the original scope even after page filters changed', () => withPage(async page => {
  await page.evaluate(() => {
    __values['#input_Search'] = 'different current search';
    __chapters = [{ id: 'different-current-chapter' }];
    __test.setEngineStage(1, async () => { window.__importedScope = __test.scope; __test.state.isPaused = true; });
    __test.setBuilder(async () => { window.__importFinished = true; });
  });
  await uploadSnapshot(page, snapshot());
  await page.waitForFunction(() => window.__importFinished);
  const actual = await page.evaluate(() => ({ scope: __importedScope, cursor: __test.state.listProgress.pageIndex }));
  assert.equal(actual.scope.search, 'original search');
  assert.equal(actual.scope.chapter, 'original-chapter');
  assert.equal(actual.scope.knowledge, 'original-knowledge');
  assert.equal(actual.cursor, 2);
}));

test('import repairs falsely downloaded images whose ZIP bytes are absent', () => withPage(async page => {
  await page.evaluate(() => {
    __test.setEngineStage(4, async () => { window.__importedImages = Array.from(__test.images); __test.state.isPaused = true; });
    __test.setBuilder(async () => { window.__importFinished = true; });
  });
  const state = snapshot();
  state.globalState.stage = 5;
  state.imageQueueList = [['http://fixture.test/picture.png', { filename: 'img_1.png', downloaded: true, failed: false }]];
  state.imgCounter = 2;
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => window.__importFinished);
  const actual = await page.evaluate(() => ({ images: __importedImages, stage: __test.state.stage }));
  assert.equal(actual.stage, 4);
  assert.equal(actual.images[0][1].downloaded, false);
  assert.equal(actual.images[0][1].failed, false);
  assert.equal(actual.images[0][1].buffer, null);
}));

test('legacy scanning snapshot without scope is rejected before any API request', () => withPage(async page => {
  const state = snapshot();
  delete state.globalState.scope;
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => document.getElementById('bistu-extractor-panel-log').textContent.includes('旧版扫描断点'));
  assert.equal(await page.evaluate(() => __ajaxCalls.length), 0);
  assert.equal(await page.locator('#bistu-init-actions').isVisible(), true);
}));

test('blocked ZIP dependency returns to start controls with a useful error', () => withPage(async page => {
  await page.evaluate(() => { window.JSZip = undefined; });
  await page.locator('#bistu-start-btn').click();
  await page.waitForFunction(() => document.getElementById('bistu-extractor-panel-log').textContent.includes('启动失败'));
  assert.equal(await page.locator('#bistu-init-actions').isVisible(), true);
  assert.equal(await page.locator('#bistu-start-btn').isEnabled(), true);
  assert.equal(await page.evaluate(() => __test.state.isPaused), true);
}));

test('a previously failed image is downloaded again on resume', () => withPage(async page => {
  const actual = await page.evaluate(async () => {
    __test.state.stage = 4;
    __test.setImages([['http://fixture.test/retry.png', { filename: 'img_1.png', downloaded: false, failed: true, buffer: null }]]);
    let requests = 0;
    window.__fetch = async () => { requests++; return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } }); };
    await __test.runStage4();
    const image = __test.images.values().next().value;
    return { requests, stage: __test.state.stage, downloaded: image.downloaded, failed: image.failed, bytes: image.buffer?.byteLength };
  });
  assert.equal(actual.requests, 1);
  assert.equal(actual.stage, 5);
  assert.equal(actual.downloaded, true);
  assert.equal(actual.failed, false);
  assert.equal(actual.bytes, 3);
}));

test('unpacked file:// export loads local images and works in a narrow viewport with all HTTP blocked', () => withPage(async sourcePage => {
  const html = await sourcePage.evaluate(() => {
    __test.setData([
      { GlobalUID: 0, QuestionType: 'Single', ChapterName: 'First chapter', DegreeLevel: '简单', DetailHtml: '<p>Alpha local fixture</p><img src="images/img_1.png" alt="local image">', SniffedAnswer: 'A' },
      { GlobalUID: 1, QuestionType: 'Program', ChapterName: 'Second chapter', DegreeLevel: '中等', DetailHtml: '<p>Beta local fixture</p>', IsAIAnswer: true, SniffedAnswer: 'String s = "&lt;literal&gt; &amp;";\nif (x < 2 && x > 0) {}' }
    ]);
    return __test.generateOfflineHtml(true);
  });
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'bistu-export-test-'));
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const requests = [], errors = [];
  await context.route(/^https?:\/\//, route => { requests.push(route.request().url()); return route.abort(); });
  try {
    fs.mkdirSync(path.join(folder, 'images'));
    fs.writeFileSync(path.join(folder, 'index.html'), html);
    fs.writeFileSync(path.join(folder, 'images', 'img_1.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64'));
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(path.join(folder, 'index.html')).href);
    await page.waitForFunction(() => document.querySelector('.detail-box img').naturalWidth === 1);
    await page.locator('#sourceFilter').selectOption({ label: 'Second chapter' });
    await page.waitForFunction(() => document.getElementById('visibleCount').textContent === '1');
    assert.match(await page.locator('.topic:not(.hidden)').innerText(), /Beta local fixture/);
    assert.equal(await page.locator('.code-box').textContent(), 'String s = "&lt;literal&gt; &amp;";\nif (x < 2 && x > 0) {}');
    const layout = await page.evaluate(() => ({ panelBottom: document.getElementById('control-panel').getBoundingClientRect().bottom, firstQuestion: document.querySelector('.topic:not(.hidden)').getBoundingClientRect().top, width: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(layout.firstQuestion >= layout.panelBottom, JSON.stringify(layout));
    assert.ok(layout.width <= layout.viewport, JSON.stringify(layout));
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, []);
  } finally {
    await context.close();
    const absolute = path.resolve(folder);
    if (path.dirname(absolute) !== path.resolve(os.tmpdir()) || !path.basename(absolute).startsWith('bistu-export-test-')) throw new Error('Unsafe test cleanup path');
    fs.rmSync(absolute, { recursive: true, force: true });
  }
}));

test('OCR image prefetch rejects a login HTML response instead of storing it as an offline image', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 3;
    __test.keyManager.updateKeys('synthetic-test-key');
    const url = 'http://fixture.test/picture.png';
    __test.setData([{ GlobalUID: 0, QuestionType: 'Blank', TopicGuid: 'fixture', Title: 'Synthetic image question', DetailHtml: '<p>Read the picture</p>', imgUrls: [url], NeedsAI: true, s2_done: true, s3_done: false }]);
    __test.setImages([[url, { filename: 'img_1.png', downloaded: false, failed: false, buffer: null }]]);
    const calls = [];
    window.__fetch = async target => { calls.push(target); return new Response('<html><input type="password"></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }); };
    await __test.runStage3();
    return { calls, paused: __test.state.isPaused, stage: __test.state.stage, buffer: __test.images.get(url).buffer, answered: __test.data[0].s3_done };
  });
  assert.deepEqual(result.calls, ['http://fixture.test/picture.png']);
  assert.equal(result.paused, true);
  assert.equal(result.stage, 3);
  assert.equal(result.buffer, null);
  assert.equal(result.answered, false);
}));

test('ZIP generation failure remains visible and can retry packaging at the completed extraction stage', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 5;
    let packages = 0;
    __test.setBuilder(async () => { packages++; if (packages === 1) throw new Error('synthetic ZIP failure'); });
    await __test.runEngine();
    const paused = __test.state.isPaused;
    const button = document.getElementById('bistu-pause-btn');
    const enabled = !button.disabled;
    button.click();
    await new Promise(resolve => setTimeout(resolve, 20));
    return { paused, enabled, packages, finalPaused: __test.state.isPaused };
  });
  assert.equal(result.paused, true);
  assert.equal(result.enabled, true);
  assert.equal(result.packages, 2);
  assert.equal(result.finalPaused, false);
}));
