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
    __test.state.sourceTotals = { Single: 1, Program: 1 };
    __test.setData([
      { GlobalUID: 0, TopicGuid: 'report-single', QuestionType: 'Single', s2_done: true, DetailHtml: '<p>Report fixture</p>', SniffedAnswer: 'A' },
      { GlobalUID: 1, TopicGuid: 'report-program', QuestionType: 'Program', s2_done: true, DetailHtml: '<p>Report program fixture</p>', SniffedAnswer: 'class Report {}', AnswerSource: 'platform-reference' }
    ]);
    __test.setImages([['http://fixture.test/picture.png', { filename: 'img_1.png', buffer: new Uint8Array([1, 2, 3, 4]).buffer, downloaded: true, failed: false }]]);
    await __test.buildZipAndDownload(false);
    await __test.buildZipAndDownload(true);
    const zips = [];
    for (const zip of __zips) zips.push({ files: Object.keys(zip.files), bytes: zip.file('images/img_1.png') ? Array.from(await zip.file('images/img_1.png').async('uint8array')) : null, state: JSON.parse(await zip.file('state.json').async('string')), report: JSON.parse(await zip.file('extraction-report.json').async('string')) });
    return zips;
  });
  assert.equal(result.length, 2);
  for (const zip of result) {
    assert.deepEqual(zip.bytes, [1, 2, 3, 4]);
    assert.equal(zip.state.globalState.scope.search, 'scope keyword');
    assert.equal(zip.state.globalState.scope.chapter, 'synthetic-chapter');
    assert.equal(zip.state.globalState.scope.degree, '2,3');
    assert.equal(zip.report.exporterVersion, require('../package.json').version);
    assert.equal(zip.report.source.version, require('../package.json').version);
    assert.equal(zip.report.totalQuestions, 2);
    assert.equal(zip.report.duplicateIds, 0);
    assert.deepEqual(zip.report.images, { expected: 1, included: 1, failed: 0, sourceUnavailable: 0, pending: 0, missingAtSource: [] });
    assert.equal(zip.report.imagesComplete, true);
    assert.equal(zip.report.byType.find(row => row.type === 'Single').expected, 1);
    assert.equal(zip.report.byType.find(row => row.type === 'Single').verifiedAnswers, 1);
    assert.equal(zip.report.byType.find(row => row.type === 'Program').referencePrograms, 1);
    assert.equal(zip.report.byType.find(row => row.type === 'Blank').expected, null);
  }
  assert.equal(result[0].report.complete, false);
  assert.equal(result[1].report.complete, true);
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
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    window.__fetch = async () => { requests++; return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }); };
    await __test.runStage4();
    const image = __test.images.values().next().value;
    return { requests, stage: __test.state.stage, downloaded: image.downloaded, failed: image.failed, bytes: image.buffer?.byteLength, expectedBytes: png.byteLength };
  });
  assert.equal(actual.requests, 1);
  assert.equal(actual.stage, 5);
  assert.equal(actual.downloaded, true);
  assert.equal(actual.failed, false);
  assert.equal(actual.bytes, actual.expectedBytes);
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
    if (await page.locator('#filterDetails').count() && await page.locator('#filterDetails').getAttribute('open') === null) await page.locator('#filterDetails > summary').click();
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

test('a genuine matching empty-options practice page is retained with a warning and never submits answers', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 2;
    __test.setData([{ TopicGuid: 'synthetic-placeholder', QuestionType: 'Single', Title: '<p>Synthetic <b>unavailable</b> question</p>', GlobalUID: 0, s2_done: false }]);
    __respond = () => '<!doctype html><title>单选题练习</title><form><input id="hidden_TopicGuid" type="hidden" value="synthetic-placeholder"><div class="panel"><div class="panel-heading">单选题练习</div><div class="panel-body"> Synthetic unavailable\n question <ul class="list-group"></ul></div></div></form>';
    await __test.runStage2();
    return { row: __test.data[0], stage: __test.state.stage, paused: __test.state.isPaused, submissions: __ajaxCalls.filter(call => call.method === 'post').length };
  });
  assert.equal(result.stage, 3);
  assert.equal(result.paused, false);
  assert.equal(result.row.s2_done, true);
  assert.equal(result.row.NeedsAI, false);
  assert.equal(result.row.SniffedAnswer, '');
  assert.ok(result.row.ExtractionWarning);
  assert.match(result.row.DetailHtml, /Synthetic unavailable/);
  assert.equal(result.submissions, 0);
}));

test('empty-options exceptions still reject mismatched, incomplete and login page structures', () => withPage(async page => {
  const results = await page.evaluate(async () => {
    const base = '<!doctype html><title>单选题练习</title><form><input id="hidden_TopicGuid" type="hidden" value="synthetic-placeholder"><div class="panel"><div class="panel-heading">单选题练习</div><div class="panel-body">Synthetic unavailable question<ul class="list-group"></ul></div></div></form>';
    const variants = [
      ['wrong document title', base.replace('<title>单选题练习</title>', '<title>Login</title>')],
      ['wrong panel heading', base.replace('<div class="panel-heading">单选题练习</div>', '<div class="panel-heading">不同页面</div>')],
      ['wrong question text', base.replace('Synthetic unavailable question', 'Different question')],
      ['wrong identity', base.replace('value="synthetic-placeholder"', 'value="different-identity"')],
      ['missing identity', base.replace('id="hidden_TopicGuid"', 'id="unknown"')],
      ['missing list', base.replace('<ul class="list-group"></ul>', '')],
      ['nonempty list', base.replace('<ul class="list-group"></ul>', '<ul class="list-group"><li>Unexpected option text</li></ul>')],
      ['password input', base.replace('</form>', '<input type="password"></form>')],
      ['empty question title', base.replace('Synthetic unavailable question', '')]
    ];
    const results = [];
    for (const [name, html] of variants) {
      __test.state.stage = 2;
      __test.state.isPaused = false;
      __test.state.lastError = null;
      __test.setData([{ TopicGuid: 'synthetic-placeholder', QuestionType: 'Single', Title: name === 'empty question title' ? '' : 'Synthetic unavailable question', GlobalUID: 0, s2_done: false }]);
      __respond = () => html;
      await __test.runStage2();
      results.push({ name, paused: __test.state.isPaused, done: __test.data[0].s2_done, warning: !!__test.data[0].ExtractionWarning });
    }
    return { results, submissions: __ajaxCalls.filter(call => call.method === 'post').length };
  });
  for (const result of results.results) {
    assert.equal(result.paused, true, result.name);
    assert.equal(result.done, false, result.name);
    assert.equal(result.warning, false, result.name);
  }
  assert.equal(results.submissions, 0);
}));

test('Program PlainExample is retained verbatim as an unverified platform reference without AI calls', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    const code = '\r\nclass Fixture {\r\n  String s = "&lt;literal&gt; &amp; <img src=\\"remote.png\\">";\r\n  boolean less = 1 < 2 && 2 > 1;\r\n}\r\n';
    __test.state.stage = 2;
    __test.keyManager.updateKeys('synthetic-test-key');
    __test.setData([{ GlobalUID: 0, TopicGuid: 'synthetic-program', QuestionType: 'Program', Title: '<p>Program fixture</p>', Requirement: '<p>Keep exact output</p>', PlainExample: code, s2_done: false, s3_done: false }]);
    await __test.runStage2();
    await __test.runStage3();
    return { code, row: __test.data[0], stage: __test.state.stage, requests: __ajaxCalls.length, imageCount: __test.images.size, html: __test.generateOfflineHtml(true) };
  });
  assert.equal(result.row.SniffedAnswer, result.code);
  assert.equal(result.row.AnswerSource, 'platform-reference');
  assert.equal(result.row.NeedsAI, false);
  assert.equal(result.row.IsAIAnswer, false);
  assert.equal(result.row.s2_done, true);
  assert.equal(result.stage, 4);
  assert.equal(result.requests, 0);
  assert.equal(result.imageCount, 0, 'code containing an img tag is text, not a downloadable resource');
  await page.setContent(result.html);
  assert.match(await page.locator('.reference-answer').innerText(), /平台返回的参考程序（未运行验证）/);
  assert.equal(await page.locator('.reference-answer .code-box').textContent(), result.code);
  assert.equal(await page.locator('.reference-answer img').count(), 0);
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedReference = text; } } });
    document.execCommand = command => { if (command === 'copy') window.__copiedReference = document.querySelector('textarea').value; return true; };
  });
  await page.locator('.reference-answer .copy-btn').click();
  await page.waitForFunction(() => window.__copiedReference !== undefined);
  assert.equal(await page.evaluate(() => window.__copiedReference), result.code);
}));

test('offline warnings remain visible when answers are hidden and summary distinguishes answer sources', () => withPage(async page => {
  const html = await page.evaluate(() => {
    __test.setData([
      { GlobalUID: 0, QuestionType: 'Single', DetailHtml: '<p>Unavailable choice fixture</p>', ExtractionWarning: 'Synthetic missing options <img src=x onerror="alert(1)">', NeedsAI: false, SniffedAnswer: '' },
      { GlobalUID: 1, QuestionType: 'Program', DetailHtml: '<p>Reference program fixture</p>', AnswerSource: 'platform-reference', SniffedAnswer: 'class Fixture {}', IsAIAnswer: false },
      { GlobalUID: 2, QuestionType: 'Single', DetailHtml: '<p>Validated choice fixture</p>', SniffedAnswer: 'A' },
      { GlobalUID: 3, QuestionType: 'Blank', DetailHtml: '<p>AI fixture</p>', SniffedAnswer: 'synthetic AI text', IsAIAnswer: true },
      { GlobalUID: 4, QuestionType: 'Single', DetailHtml: '<p>Second missing choice fixture</p>', ExtractionWarning: 'Synthetic second missing options', NeedsAI: false, SniffedAnswer: '' }
    ]);
    return __test.generateOfflineHtml(true);
  });
  await page.setContent(html);
  assert.equal(await page.locator('#extraction-summary').getAttribute('data-warning-count'), '2');
  assert.equal(await page.locator('#extraction-summary').getAttribute('data-platform-reference-count'), '1');
  assert.equal(await page.locator('#extraction-summary').getAttribute('data-validated-answer-count'), '1');
  assert.equal(await page.locator('#extraction-summary').getAttribute('data-ai-answer-count'), '1');
  assert.equal(await page.locator('.extraction-warning').count(), 2);
  assert.equal(await page.locator('.extraction-warning img').count(), 0);
  await page.locator('#toggleAnsBtn').click();
  for (const warning of await page.locator('.extraction-warning').all()) assert.equal(await warning.isVisible(), true);
  for (const answer of await page.locator('.answer-box').all()) assert.equal(await answer.isVisible(), false);
}));

test('legacy Program snapshot reprocesses omitted PlainExample while preserving migrated reference answers', () => withPage(async page => {
  await page.evaluate(() => {
    __test.setEngineStage(2, async () => { window.__legacyRows = __test.data; window.__legacyStage = __test.state.stage; __test.state.isPaused = true; });
    __test.setBuilder(async () => { window.__legacyImportFinished = true; });
  });
  const state = snapshot();
  state.globalState.stage = 5;
  state.globalState.version = '7.10.0';
  state.allData = [
    { GlobalUID: 0, TopicGuid: 'legacy-program', QuestionType: 'Program', Title: 'Legacy fixture', DetailHtml: '<p>Legacy fixture</p>', PlainExample: 'class Legacy {}', s2_done: true, s3_done: true, NeedsAI: true },
    { GlobalUID: 1, TopicGuid: 'migrated-program', QuestionType: 'Program', Title: 'Migrated fixture', DetailHtml: '<p>Migrated fixture</p>', PlainExample: 'class Migrated {}', AnswerSource: 'platform-reference', SniffedAnswer: 'class Migrated {}', s2_done: true, s3_done: true, NeedsAI: false }
  ];
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => window.__legacyImportFinished);
  const actual = await page.evaluate(() => ({ stage: __legacyStage, rows: __legacyRows }));
  assert.equal(actual.stage, 2);
  assert.equal(actual.rows[0].s2_done, false);
  assert.equal(actual.rows[0].s3_done, false);
  assert.equal(actual.rows[1].s2_done, true);
  assert.equal(actual.rows[1].AnswerSource, 'platform-reference');
}));

test('platform menu drives reordered numeric IDs, enum IDs and supported type subsets', () => withPage(async page => {
  const results = await page.evaluate(async () => {
    const results = [];
    for (const useEnums of [false, true]) {
      const programId = useEnums ? 'Program' : '47';
      const singleId = useEnums ? 'Single' : '12';
      document.querySelector('#select_QuestionType').innerHTML = `<option value="">请选择</option><option value="${programId}">Programming</option><option value="${singleId}">单项选择题</option>`;
      __test.initializePlatformVariables();
      __test.state.stage = 1;
      __test.state.isPaused = false;
      __test.state.listProgress = { typeIndex: 0, pageIndex: 1, totalPages: 0 };
      __test.state.sourceTotals = {};
      __test.setData([]);
      const calls = [];
      __respond = ({ data }) => {
        calls.push(data.questionType);
        const type = String(data.questionType) === programId ? 'Program' : 'Single';
        return { Total: 1, DataList: [{ TopicGuid: `synthetic-${type}`, QuestionType: type, Title: 'Synthetic menu fixture' }] };
      };
      await __test.runStage1();
      results.push({ calls, stage: __test.state.stage, types: __test.data.map(row => row.QuestionType), definitions: __test.state.scope.typeDefinitions, totals: __test.state.sourceTotals });
    }
    return results;
  });
  assert.deepEqual(results[0].calls, [47, 12]);
  assert.deepEqual(results[1].calls, ['Program', 'Single']);
  for (const result of results) {
    assert.equal(result.stage, 2);
    assert.deepEqual(result.types, ['Program', 'Single']);
    assert.deepEqual(result.totals, { Program: 1, Single: 1 });
    assert.equal(result.definitions.length, 2);
  }
}));

test('preflight refuses unknown, duplicate, conflicting, empty and missing platform type menus', () => withPage(async page => {
  const results = await page.evaluate(() => {
    const original = document.querySelector('#select_QuestionType').outerHTML;
    const variants = [
      ['unknown', '<option value="9">Essay</option>'],
      ['duplicate ID', '<option value="1">单选题</option><option value="1">填空题</option>'],
      ['duplicate semantic', '<option value="1">单选题</option><option value="7">Single choice</option>'],
      ['conflicting enum', '<option value="Single">填空题</option>'],
      ['empty menu', '<option value="">请选择</option>'],
      ['missing menu', null]
    ];
    return variants.map(([name, markup]) => {
      document.querySelector('#select_QuestionType')?.remove();
      document.body.insertAdjacentHTML('afterbegin', original);
      if (markup === null) document.querySelector('#select_QuestionType').remove();
      else document.querySelector('#select_QuestionType').innerHTML = markup;
      let error;
      try { __test.initializePlatformVariables(); } catch (e) { error = e.message; }
      return { name, error, requests: __ajaxCalls.length };
    });
  });
  for (const result of results) {
    assert.ok(result.error, result.name);
    assert.equal(result.requests, 0, result.name);
  }
}));

test('stored type mapping tolerates reordered menus but rejects changed IDs or membership before scanning', () => withPage(async page => {
  const actual = await page.evaluate(async () => {
    document.querySelector('#select_QuestionType').innerHTML = '<option value="47">程序题</option><option value="12">单选题</option>';
    __test.initializePlatformVariables();
    const scope = JSON.parse(JSON.stringify(__test.state.scope));
    document.querySelector('#select_QuestionType').innerHTML = '<option value="12">单选题</option><option value="47">程序题</option>';
    __test.restorePlatformVariables(scope, 1);
    const preservedOrder = scope.typeDefinitions.map(type => type.id);
    const failures = [];
    for (const markup of ['<option value="13">单选题</option><option value="47">程序题</option>', '<option value="12">单选题</option>']) {
      document.querySelector('#select_QuestionType').innerHTML = markup;
      __test.state.scope = JSON.parse(JSON.stringify(scope));
      let error;
      try { await __test.runStage1(); } catch (e) { error = e.message; }
      failures.push(error);
    }
    return { preservedOrder, failures, requests: __ajaxCalls.length };
  });
  assert.deepEqual(actual.preservedOrder, [47, 12]);
  assert.ok(actual.failures.every(Boolean));
  assert.equal(actual.requests, 0);
}));

test('legacy scan without stored type definitions cannot resume after menu order, IDs or membership change', () => withPage(async page => {
  const actual = await page.evaluate(() => {
    const legacy = JSON.parse(JSON.stringify(__test.state.scope));
    delete legacy.typeDefinitions;
    __test.restorePlatformVariables(JSON.parse(JSON.stringify(legacy)), 1);
    const options = [
      '<option value="2">多选题</option><option value="1">单选题</option><option value="3">判断题</option><option value="4">填空题</option><option value="5">程序题</option>',
      '<option value="11">单选题</option><option value="2">多选题</option><option value="3">判断题</option><option value="4">填空题</option><option value="5">程序题</option>',
      '<option value="1">单选题</option>'
    ];
    return options.map(markup => {
      document.querySelector('#select_QuestionType').innerHTML = markup;
      try { __test.restorePlatformVariables(JSON.parse(JSON.stringify(legacy)), 1); return false; } catch (_) { return true; }
    });
  });
  assert.deepEqual(actual, [true, true, true]);
}));

test('import re-fetches untrusted completed objective details while retaining matching modern placeholders', () => withPage(async page => {
  await page.evaluate(() => {
    __test.setEngineStage(2, async () => { window.__objectiveRows = __test.data; window.__objectiveStage = __test.state.stage; __test.state.isPaused = true; });
    __test.setBuilder(async () => { window.__objectiveImportFinished = true; });
  });
  const state = snapshot();
  state.globalState.stage = 5;
  state.globalState.version = '7.9';
  const base = { QuestionType: 'Single', Title: 'Synthetic statement', s2_done: true, s3_done: true };
  const placeholder = { ...base, Title: 'Synthetic skipped item', SniffedAnswer: '', AnswerSource: null, IsAIAnswer: false, NeedsAI: false,
    ExtractionWarning: '平台本题未提供选项，已保留原文；无可验证的答案。',
    DetailHtml: '<div class="panel panel-default"><div class="panel-heading">单选题练习</div><div class="panel-body">Synthetic skipped item</div><ul class="list-group"></ul></div>' };
  state.allData = [
    { ...base, GlobalUID: 0, TopicGuid: 'old-network-error', DetailHtml: '<div>详情页抓取失败，原题丢失。</div>', SniffedAnswer: 'Untrusted cached answer', IsAIAnswer: true, NeedsAI: true },
    { ...base, GlobalUID: 1, TopicGuid: 'arbitrary-warning', DetailHtml: '<p>Not a practice detail</p>', ExtractionWarning: 'Trust me', NeedsAI: false },
    { ...base, GlobalUID: 2, TopicGuid: 'valid-options', DetailHtml: '<label><input type="radio" value="A">Original option A</label>', SniffedAnswer: 'Original option A', AnswerSource: 'platform-verified', IsAIAnswer: false, NeedsAI: false },
    { ...placeholder, GlobalUID: 3, TopicGuid: 'valid-placeholder' },
    { ...placeholder, GlobalUID: 4, TopicGuid: 'mismatched-placeholder', Title: 'Different statement' },
    { ...base, GlobalUID: 5, TopicGuid: 'login-with-options', DetailHtml: '<input type="password"><label><input type="radio">Remember login</label>' }
  ];
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => window.__objectiveImportFinished);
  const actual = await page.evaluate(() => ({ rows: __objectiveRows, stage: __objectiveStage }));
  assert.equal(actual.stage, 2);
  for (const index of [0, 1, 4, 5]) {
    assert.equal(actual.rows[index].s2_done, false, 'untrusted detail ' + index);
    assert.equal(actual.rows[index].s3_done, false);
    for (const field of ['DetailHtml', 'SniffedAnswer', 'AnswerSource', 'IsAIAnswer', 'NeedsAI', 'ExtractionWarning']) assert.equal(Object.hasOwn(actual.rows[index], field), false, field);
  }
  assert.equal(actual.rows[2].s2_done, true);
  assert.equal(actual.rows[2].SniffedAnswer, 'Original option A');
  assert.equal(actual.rows[3].s2_done, true);
  assert.equal(actual.rows[3].ExtractionWarning, placeholder.ExtractionWarning);
}));

test('import of verified choice and matching placeholder does not repeat answer submissions', () => withPage(async page => {
  const state = snapshot();
  state.globalState.stage = 5;
  state.allData = [
    { GlobalUID: 0, TopicGuid: 'verified-choice', QuestionType: 'Single', Title: 'Verified synthetic choice', DetailHtml: '<label><input type="radio" value="A">Choice A</label>', SniffedAnswer: 'Choice A', AnswerSource: 'platform-verified', IsAIAnswer: false, NeedsAI: false, s2_done: true, s3_done: true },
    { GlobalUID: 1, TopicGuid: 'verified-placeholder', QuestionType: 'Single', Title: 'Skipped fixture', DetailHtml: '<div class="panel"><div class="panel-heading">单选题练习</div><div class="panel-body">Skipped fixture</div><ul class="list-group"></ul></div>', SniffedAnswer: '', AnswerSource: null, IsAIAnswer: false, NeedsAI: false, s2_done: true, s3_done: false, ExtractionWarning: '平台本题未提供选项，已保留原文；无可验证的答案。' }
  ];
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => window.__zips.length > 0);
  const actual = await page.evaluate(async () => ({ calls: __ajaxCalls.length, stage: __test.state.stage, report: JSON.parse(await __zips[0].file('extraction-report.json').async('string')) }));
  assert.equal(actual.calls, 0);
  assert.equal(actual.stage, 5);
  assert.equal(actual.report.complete, true);
  assert.equal(actual.report.byType.find(row => row.type === 'Single').details, 2);
  assert.equal(actual.report.byType.find(row => row.type === 'Single').platformContentNotices, 1);
}));

test('image validation decodes real PNG and SVG bytes and rejects nonempty corrupted image data', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='), char => char.charCodeAt(0)).buffer;
    const svg = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="2" height="3"><rect width="2" height="3" fill="red"/></svg>').buffer;
    const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
    const created = [], revoked = [];
    URL.createObjectURL = blob => { const url = originalCreate.call(URL, blob); created.push(url); return url; };
    URL.revokeObjectURL = url => { revoked.push(url); return originalRevoke.call(URL, url); };
    try {
      const pngValid = await __test.validateImageBuffer(png, 'image/png') === png;
      const svgValid = await __test.validateImageBuffer(svg) === svg;
      let corruptError;
      try { await __test.validateImageBuffer(new Uint8Array([1, 2, 3]).buffer, 'image/png'); } catch (error) { corruptError = error.message; }
      return { pngValid, svgValid, corruptError, allUrlsRevoked: created.length === 3 && created.every(url => revoked.includes(url)) };
    } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
  });
  assert.equal(result.pngValid, true);
  assert.equal(result.svgValid, true);
  assert.match(result.corruptError, /无法解码/);
  assert.equal(result.allUrlsRevoked, true);
}));

test('image decode timeout rejects and releases its object URL', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    const OriginalImage = window.Image, originalRevoke = URL.revokeObjectURL;
    let revoked = 0, removed = 0;
    window.Image = function() { return { naturalWidth: 0, naturalHeight: 0, removeAttribute() { removed++; } }; };
    URL.revokeObjectURL = url => { revoked++; return originalRevoke.call(URL, url); };
    try {
      let message;
      try { await __test.validateImageBuffer(new Uint8Array([1]).buffer, 'image/png', 15); } catch (error) { message = error.message; }
      return { message, revoked, removed };
    } finally { window.Image = OriginalImage; URL.revokeObjectURL = originalRevoke; }
  });
  assert.match(result.message, /解码超时/);
  assert.equal(result.revoked, 1);
  assert.equal(result.removed, 1);
}));

test('nonempty corrupt image responses pause download instead of reporting completion', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 4;
    __test.setImages([['http://fixture.test/corrupt.png', { filename: 'img_1.png', downloaded: false, failed: false, buffer: null }]]);
    let attempts = 0;
    __fetch = async () => { attempts++; return new Response(new Uint8Array([1,2,3]), { status: 200, headers: { 'Content-Type': 'image/png' } }); };
    await __test.runStage4();
    const image = __test.images.values().next().value;
    return { attempts, stage: __test.state.stage, paused: __test.state.isPaused, downloaded: image.downloaded, failed: image.failed, buffer: image.buffer };
  });
  assert.equal(result.attempts, 3);
  assert.equal(result.stage, 4);
  assert.equal(result.paused, true);
  assert.equal(result.downloaded, false);
  assert.equal(result.failed, true);
  assert.equal(result.buffer, null);
}));

test('snapshot import keeps decodable images and retries only corrupt archived bytes', () => withPage(async page => {
  await page.evaluate(() => {
    __test.setEngineStage(4, async () => {
      window.__decodedImport = Array.from(__test.images.values()).map(image => ({ filename: image.filename, downloaded: image.downloaded, failed: image.failed, bytes: image.buffer?.byteLength || 0 }));
      __test.state.isPaused = true;
    });
    __test.setBuilder(async () => { window.__decodedImportFinished = true; });
  });
  const state = snapshot();
  state.globalState.stage = 5;
  state.imgCounter = 3;
  state.imageQueueList = [
    ['http://fixture.test/good.png', { filename: 'img_1.png', downloaded: true, failed: false }],
    ['http://fixture.test/corrupt.png', { filename: 'img_2.png', downloaded: true, failed: false }]
  ];
  const zip = new JSZip();
  zip.file('state.json', JSON.stringify(state));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=', 'base64');
  zip.file('images/img_1.png', png);
  zip.file('images/img_2.png', Buffer.from([1,2,3]));
  await page.locator('#bistu-file-input').setInputFiles({ name: 'synthetic-images.zip', mimeType: 'application/zip', buffer: await zip.generateAsync({ type: 'nodebuffer' }) });
  await page.waitForFunction(() => window.__decodedImportFinished);
  const actual = await page.evaluate(() => ({ images: __decodedImport, stage: __test.state.stage, requests: __ajaxCalls.length }));
  assert.equal(actual.stage, 4);
  assert.deepEqual(actual.images[0], { filename: 'img_1.png', downloaded: true, failed: false, bytes: png.byteLength });
  assert.deepEqual(actual.images[1], { filename: 'img_2.png', downloaded: false, failed: false, bytes: 0 });
  assert.equal(actual.requests, 0);
}));

test('confirmed 404 and 410 images retain source metadata while later downloads complete', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 4;
    __test.setImages([
      ['http://fixture.test/missing.png', { filename: 'img_1.png', buffer: null, downloaded: false, failed: false, alt: 'Synthetic missing diagram' }],
      ['http://fixture.test/gone.png', { filename: 'img_2.png', buffer: null, downloaded: false, failed: false, alt: 'Synthetic removed diagram' }],
      ['http://fixture.test/good.png', { filename: 'img_3.png', buffer: null, downloaded: false, failed: false }]
    ]);
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const attempts = {};
    __fetch = async url => {
      attempts[url] = (attempts[url] || 0) + 1;
      if (url.includes('missing')) return new Response('', { status: 404 });
      if (url.includes('gone')) return new Response('', { status: 410 });
      return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } });
    };
    await __test.runStage4();
    await __test.buildZipAndDownload(true);
    return { stage: __test.state.stage, paused: __test.state.isPaused, attempts,
      report: JSON.parse(await __zips[0].file('extraction-report.json').async('string')),
      state: JSON.parse(await __zips[0].file('state.json').async('string')),
      archivedImages: Object.keys(__zips[0].files).filter(name => /^images\/img_/.test(name)) };
  });
  assert.equal(result.stage, 5);
  assert.equal(result.paused, false);
  assert.equal(result.attempts['http://fixture.test/missing.png'], 3);
  assert.equal(result.attempts['http://fixture.test/gone.png'], 3);
  assert.equal(result.report.complete, true);
  assert.equal(result.report.imagesComplete, false);
  assert.equal(result.report.images.expected, 3);
  assert.equal(result.report.images.included, 1);
  assert.equal(result.report.images.sourceUnavailable, 2);
  assert.equal(result.report.images.failed, 0);
  assert.equal(result.report.images.pending, 0);
  assert.deepEqual(result.archivedImages, ['images/img_3.png']);
  assert.deepEqual(result.report.images.missingAtSource.map(image => image.status), [404, 410]);
  const missing = result.state.imageQueueList[0][1];
  assert.equal(missing.sourceUnavailable, true);
  assert.equal(missing.downloaded, false);
  assert.equal(missing.failed, false);
  assert.equal(missing.status, 404);
  assert.equal(missing.originalUrl, 'http://fixture.test/missing.png');
  assert.equal(missing.alt, 'Synthetic missing diagram');
}));

test('temporary image failures finish the bounded queue before pausing and mixed statuses are not permanent', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 4;
    const names = ['mixed', 'server', 'corrupt', 'good1', 'good2', 'good3'];
    __test.setImages(names.map((name, index) => [`http://fixture.test/${name}.png`, { filename: `img_${index + 1}.png`, buffer: null, downloaded: false, failed: false }]));
    const valid = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    const attempts = {}; let active = 0, maxActive = 0;
    __fetch = async url => {
      attempts[url] = (attempts[url] || 0) + 1; active++; maxActive = Math.max(maxActive, active);
      await new Promise(resolve => setTimeout(resolve, 15)); active--;
      if (url.includes('mixed')) return new Response('', { status: attempts[url] === 2 ? 500 : 404 });
      if (url.includes('server')) return new Response('', { status: 503 });
      if (url.includes('corrupt')) return new Response(new Uint8Array([1,2,3]), { status: 200, headers: { 'Content-Type': 'image/png' } });
      return new Response(valid, { status: 200, headers: { 'Content-Type': 'image/png' } });
    };
    await __test.runStage4();
    await __test.buildZipAndDownload(false);
    return { stage: __test.state.stage, paused: __test.state.isPaused, maxActive, attempts,
      images: Array.from(__test.images.values()).map(image => ({ downloaded: image.downloaded, failed: image.failed, sourceUnavailable: image.sourceUnavailable, status: image.status })),
      report: JSON.parse(await __zips[0].file('extraction-report.json').async('string')) };
  });
  assert.equal(result.stage, 4);
  assert.equal(result.paused, true);
  assert.equal(result.maxActive, 3);
  assert.equal(Object.keys(result.attempts).length, 6, 'later images are attempted despite earlier failures');
  assert.ok(result.images.slice(0, 3).every(image => image.failed && !image.sourceUnavailable && !image.downloaded));
  assert.ok(result.images.slice(3).every(image => image.downloaded && !image.failed));
  assert.equal(result.report.complete, false);
  assert.equal(result.report.images.failed, 3);
  assert.equal(result.report.images.included, 3);
  assert.equal(result.report.images.pending, 0);
  assert.deepEqual(result.report.images.missingAtSource, []);
}));

test('import remembers missing-source metadata but retries the URL and clears it after recovery', () => withPage(async page => {
  await page.evaluate(() => {
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='), char => char.charCodeAt(0));
    window.__recoveredRequests = 0;
    __fetch = async () => { __recoveredRequests++; return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png' } }); };
  });
  const state = snapshot();
  state.globalState.stage = 5; state.imgCounter = 2;
  state.imageQueueList = [['http://fixture.test/recovered.png', { filename: 'img_1.png', downloaded: false, failed: false, sourceUnavailable: true, status: 404, originalUrl: 'http://fixture.test/recovered.png', alt: 'Recovered synthetic diagram' }]];
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => __zips.length > 0);
  const actual = await page.evaluate(async () => ({ requests: __recoveredRequests, image: { ...__test.images.values().next().value, buffer: undefined }, report: JSON.parse(await __zips[0].file('extraction-report.json').async('string')) }));
  assert.equal(actual.requests, 1);
  assert.equal(actual.image.downloaded, true);
  assert.equal(actual.image.sourceUnavailable, false);
  assert.equal(actual.image.status, null);
  assert.equal(actual.image.alt, 'Recovered synthetic diagram');
  assert.equal(actual.report.complete, true);
  assert.equal(actual.report.imagesComplete, true);
  assert.equal(actual.report.images.sourceUnavailable, 0);
}));
test('scope preflight refuses missing filters or unavailable chapters without widening the query', () => withPage(async page => {
  const result = await page.evaluate(() => {
    const failures = [];
    const beforeScope = JSON.stringify(__test.state.scope);
    for (const selector of ['#select_DegreeLevel', '#select_KnoGuid', '#input_Search', '#ul_Tree']) {
      const element = document.querySelector(selector);
      const next = element.nextSibling;
      const parent = element.parentNode;
      element.remove();
      let error;
      try { __test.initializePlatformVariables(); } catch (e) { error = e.message; }
      failures.push({ name: selector, error, scopeUnchanged: JSON.stringify(__test.state.scope) === beforeScope });
      parent.insertBefore(element, next);
    }
    const originalTree = $.fn.zTree.getZTreeObj;
    for (const [name, getter] of [
      ['not initialized', () => null],
      ['read failure', () => ({ getSelectedNodes: () => { throw new Error('Unavailable'); } })],
      ['missing selection', () => ({ getSelectedNodes: () => null })],
      ['invalid chapter', () => ({ getSelectedNodes: () => [{}] })]
    ]) {
      $.fn.zTree.getZTreeObj = getter;
      let error;
      try { __test.initializePlatformVariables(); } catch (e) { error = e.message; }
      failures.push({ name, error, scopeUnchanged: JSON.stringify(__test.state.scope) === beforeScope });
    }
    $.fn.zTree.getZTreeObj = originalTree;
    __values['#select_LanguageType'] = undefined;
    __chapters = [];
    __test.initializePlatformVariables();
    return { failures, scope: __test.state.scope, requests: __ajaxCalls.length, hasLanguageControl: !!document.querySelector('#select_LanguageType') };
  });
  for (const failure of result.failures) {
    assert.ok(failure.error, failure.name);
    assert.equal(failure.scopeUnchanged, true, failure.name);
  }
  assert.equal(result.requests, 0);
  assert.equal(result.hasLanguageControl, false);
  assert.equal(result.scope.language, 'Java');
  assert.equal(result.scope.chapter, '');
}));

test('lazy images, srcset-only images and matching picture sources become local image files', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.setData([{ GlobalUID: 0, TopicGuid: 'responsive-images', QuestionType: 'Program', Title: '<p>Responsive image fixtures</p><img data-src="/lazy.png" src="/placeholder.png"><img srcset="/small.png 1x, /large.png?crop=1,2 2x"><picture><source media="(max-width: 1px)" srcset="/not-matching.png 1x"><source type="image/webp" srcset="/picture-small.webp 640w, /picture-large.webp 1280w"><img src="/fallback.png"></picture>', Requirement: '', PlainExample: 'class Images {}', s2_done: false, imgUrls: [] }]);
    await __test.runStage2();
    const detail = new DOMParser().parseFromString(__test.data[0].DetailHtml, 'text/html');
    return { row: __test.data[0], urls: Array.from(__test.images.keys()), sources: Array.from(detail.querySelectorAll('img'), image => image.getAttribute('src')), onlineOverrides: detail.querySelectorAll('[srcset], [data-src], [data-srcset], picture > source').length, paused: __test.state.isPaused };
  });
  assert.equal(result.paused, false);
  assert.equal(result.row.s2_done, true);
  assert.deepEqual(result.urls, ['http://fixture.test/lazy.png', 'http://fixture.test/large.png?crop=1,2', 'http://fixture.test/picture-large.webp']);
  assert.equal(result.sources.length, 3);
  for (const src of result.sources) assert.match(src, /^images\/img_\d+\.(?:png|webp)$/);
  assert.equal(result.onlineOverrides, 0);
}));

test('unsupported visible rich resources pause extraction instead of claiming complete fidelity', () => withPage(async page => {
  const results = await page.evaluate(async () => {
    const cases = [
      ['inline SVG', '<svg width="10" height="10"><text>Meaningful graph</text></svg>'],
      ['MathML', '<math><mi>x</mi><mo>+</mo><mn>1</mn></math>'],
      ['video', '<video><source src=""><source src="/lecture.mp4"></video>'],
      ['audio', '<audio src="/sound.wav"></audio>'],
      ['embedded document', '<iframe src="/document.html"></iframe>'],
      ['file attachment', '<a href="/material.pdf">PDF attachment</a>'],
      ['download attachment', '<a href="/Download?id=fixture" download>Download attachment</a>'],
      ['background image', '<div style="background-image:url(/graph.png)">Graph description</div>'],
      ['legacy background image', '<table background="/graph.png"><tr><td>Graph</td></tr></table>'],
      ['ambiguous srcset', '<img srcset="/first.png 1x, /second.png 600w">']
    ];
    const results = [];
    for (const [name, content] of cases) {
      __test.state.isPaused = false; __test.state.stage = 2; delete __test.state.lastError;
      __test.setImages([]);
      __test.setData([{ GlobalUID: 0, TopicGuid: 'unsupported-resource', QuestionType: 'Program', Title: '<p>Synthetic question</p>' + content, PlainExample: 'class Unsupported {}', s2_done: false, imgUrls: [] }]);
      await __test.runStage2();
      results.push({ name, paused: __test.state.isPaused, done: __test.data[0].s2_done, error: __test.state.lastError, stage: __test.state.stage });
    }
    return results;
  });
  for (const result of results) {
    assert.equal(result.paused, true, result.name);
    assert.equal(result.done, false, result.name);
    assert.equal(result.stage, 2, result.name);
    assert.ok(result.error, result.name);
  }
}));

test('ordinary styles, empty media and hidden illustrations do not trigger unsupported-resource errors or execute scripts', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.setData([{ GlobalUID: 0, TopicGuid: 'ordinary-rich-text', QuestionType: 'Program', Title: '<p style="background-color: red">Ordinary text</p><div hidden><svg><text>Hidden illustration</text></svg></div><video></video><img><script>window.__questionScriptExecuted = true;</script><a href="https://example.test/documentation">Documentation</a>', PlainExample: 'class Safe {}', s2_done: false, imgUrls: [] }]);
    await __test.runStage2();
    return { done: __test.data[0].s2_done, paused: __test.state.isPaused, scriptExecuted: !!window.__questionScriptExecuted, imageCount: __test.images.size };
  });
  assert.equal(result.done, true);
  assert.equal(result.paused, false);
  assert.equal(result.scriptExecuted, false);
  assert.equal(result.imageCount, 0);
}));

test('when every official option is rejected, preserve the options and explicit warning without fabricating an answer', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.setData([{ GlobalUID: 0, TopicGuid: 'no-correct-option', QuestionType: 'Single', Title: 'Synthetic inconsistent platform question', s2_done: false, imgUrls: [] }]);
    __respond = ({ url }) => url.includes('JumpToPracticeTopic') ? '<form><h2>Synthetic inconsistent platform question</h2><label><input type="radio" value="A">Option A</label><label><input type="radio" value="B">Option B</label><label><input type="radio" value="C">Option C</label></form>' : { Result: false };
    await __test.runStage2();
    const html = __test.generateOfflineHtml(false);
    return { row: __test.data[0], posts: __ajaxCalls.filter(call => call.method === 'post').length, optionCount: new DOMParser().parseFromString(html, 'text/html').querySelectorAll('.detail-box input[type="radio"]').length, warning: new DOMParser().parseFromString(html, 'text/html').querySelector('.extraction-warning')?.textContent };
  });
  assert.equal(result.row.s2_done, true);
  assert.equal(result.posts, 3);
  assert.equal(result.optionCount, 3);
  assert.equal(result.row.SniffedAnswer, '');
  assert.equal(result.row.AnswerSource, null);
  assert.equal(result.row.IsAIAnswer, false);
  assert.equal(result.row.NeedsAI, true);
  assert.match(result.row.ExtractionWarning, /平台|选项/);
  assert.ok(result.warning.includes(result.row.ExtractionWarning));
}));


function studyFixture() {
  return [
    { QuestionType: 'Single', ChapterName: '基础', DegreeLevel: '简单', DetailHtml: '<p>Alpha Java contents</p>', SniffedAnswer: 'Synthetic first answer' },
    { QuestionType: 'Multiple', ChapterName: '数组', DegreeLevel: '中等', DetailHtml: '<p>Alpha beta array exercise</p>', SniffedAnswer: 'A、B' },
    { QuestionType: 'TrueOrFalse', ChapterName: '基础', DegreeLevel: '简单', DetailHtml: '<p>ＡＢＣ Ｊａｖａ Unicode fixture</p>', SniffedAnswer: '正确' },
    { QuestionType: 'Program', ChapterName: '数组', DegreeLevel: '中等', DetailHtml: '<p>Program fixture</p>', SniffedAnswer: '\r\nclass Fixture {\r\n    String answerOnlyToken = "&lt;tag&gt; &amp; <literal>";\r\n}\r\n', AnswerSource: 'platform-reference' },
    { QuestionType: 'Blank', ChapterName: '字符串', DegreeLevel: '困难', DetailHtml: '<p>Blank fixture</p>', SniffedAnswer: 'aiOnlyToken', IsAIAnswer: true },
    { QuestionType: 'Single', ChapterName: '缺项', DegreeLevel: '无', DetailHtml: '<p>Placeholder fixture</p>', ExtractionWarning: 'Synthetic missing options' }
  ].map((item, index) => ({ GlobalUID: index, TopicGuid: 'study-fixture-' + index, s2_done: true, IsAIAnswer: false, ...item }));
}

async function renderStudyFixture(page, fixture = studyFixture()) {
  const html = await page.evaluate(data => { __test.setData(data); return __test.generateOfflineHtml(true); }, fixture);
  await page.setContent(html);
}

async function studyQuery(page, query, count) {
  await page.locator('#keywordFilter').fill(query);
  await page.waitForTimeout(180); // Exercise the 150 ms debounce, including successive same-count queries.
  await page.waitForFunction(expected => document.querySelector('#visibleCount').textContent === String(expected), count);
}

test('study search normalizes Unicode, ANDs tokens, switches prompt scope and resets filters', () => withPage(async page => {
  await renderStudyFixture(page);
  await studyQuery(page, '  abc   JAVA  ', 1);
  assert.equal(await page.locator('.topic:not(.hidden)').getAttribute('data-type'), 'TrueOrFalse');
  await studyQuery(page, 'alpha beta', 1);
  assert.equal(await page.locator('.topic:not(.hidden)').getAttribute('data-type'), 'Multiple');
  await studyQuery(page, 'answerOnlyToken', 1);
  await page.locator('#searchScope').selectOption('prompt');
  assert.equal(await page.locator('#visibleCount').textContent(), '0');
  assert.equal(await page.locator('#emptyState').isVisible(), true);
  await page.locator('#searchScope').selectOption('full');
  assert.equal(await page.locator('#visibleCount').textContent(), '1');
  await page.locator('#sourceFilter').selectOption('数组');
  await page.locator('#clearSearch').click();
  assert.equal(await page.locator('#visibleCount').textContent(), '2');
  await page.locator('#typeFilter').selectOption('Program');
  assert.equal(await page.locator('#visibleCount').textContent(), '1');
  await page.locator('#diffFilter').selectOption('困难');
  assert.equal(await page.locator('#visibleCount').textContent(), '0');
  await page.locator('.empty-reset').click();
  assert.equal(await page.locator('#visibleCount').textContent(), '6');
  for (const selector of ['#sourceFilter', '#typeFilter', '#diffFilter']) assert.equal(await page.locator(selector).inputValue(), 'all');
  assert.equal(await page.locator('#searchScope').inputValue(), 'full');
  assert.equal(await page.locator('#emptyState').isVisible(), false);
}));

test('study keyboard shortcuts respect editable input and Chinese composition', () => withPage(async page => {
  await renderStudyFixture(page);
  await page.locator('h1').click(); await page.keyboard.press('/');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'keywordFilter');
  await page.keyboard.type('alpha/');
  assert.equal(await page.locator('#keywordFilter').inputValue(), 'alpha/');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#keywordFilter').inputValue(), '');
  assert.equal(await page.locator('#visibleCount').textContent(), '6');
  await page.locator('h1').click(); await page.keyboard.press('Control+k');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'keywordFilter');
  await page.locator('#keywordFilter').evaluate(input => {
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.value = '合成无匹配词';
    input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  });
  await page.waitForTimeout(220);
  assert.equal(await page.locator('#visibleCount').textContent(), '6');
  await page.locator('#keywordFilter').evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend')));
  assert.equal(await page.locator('#visibleCount').textContent(), '0');
  await page.locator('#resetFilters').click();
  assert.equal(await page.locator('#visibleCount').textContent(), '6');
}));

test('study per-question and global answer visibility stay synchronized without hiding warnings', () => withPage(async page => {
  await renderStudyFixture(page);
  await page.locator('#toggleAnsBtn').click();
  assert.equal(await page.locator('.answer-box:not([hidden])').count(), 0);
  assert.equal(await page.locator('.extraction-warning').isVisible(), true);
  const local = page.locator('.answer-toggle').first();
  assert.equal(await local.getAttribute('aria-expanded'), 'false');
  await local.click();
  assert.equal(await local.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('.answer-box:not([hidden])').count(), 1);
  assert.equal(await page.locator('#toggleAnsBtn').getAttribute('data-hidden'), 'false');
  await page.locator('#toggleAnsBtn').click();
  assert.equal(await page.locator('.answer-box:not([hidden])').count(), 0);
  await studyQuery(page, 'answerOnlyToken', 1);
  assert.equal(await page.locator('.reference-answer').isVisible(), false, 'search must not reveal hidden answers');
  await page.locator('#resetFilters').click(); await page.locator('#toggleAnsBtn').click();
  assert.equal(await page.locator('.answer-box:not([hidden])').count(), 5);
}));

test('program markup preserves leading and trailing LF, CRLF, CR and literal HTML entities', () => withPage(async page => {
  const variants = ['\nclass LF {}\n', '\r\nclass CRLF {\r\n    String s = "&lt;literal&gt; &amp; <tag>";\r\n}\r\n', '\n\nclass TwoLF {}\n\n', '\rclass CR {}\r'];
  const rendered = await page.evaluate(codes => {
    __test.setData(codes.map((code, GlobalUID) => ({ GlobalUID, QuestionType: 'Program', DetailHtml: '<p>Code whitespace fixture</p>', SniffedAnswer: code, AnswerSource: 'platform-reference' })));
    const doc = new DOMParser().parseFromString(__test.generateOfflineHtml(true), 'text/html');
    return Array.from(doc.querySelectorAll('.code-box')).map(node => node.textContent);
  }, variants);
  assert.deepEqual(rendered, variants);
}));

test('cached study filtering retains DOM and answer state across 779 questions', () => withPage(async page => {
  const fixture = studyFixture();
  const data = Array.from({ length: 779 }, (_, index) => ({ ...fixture[index % fixture.length], GlobalUID: index, TopicGuid: 'large-study-fixture-' + index }));
  await renderStudyFixture(page, data);
  await page.evaluate(() => { window.__firstStudyCard = document.querySelector('.topic'); });
  await page.locator('.answer-toggle').first().click();
  await studyQuery(page, 'alpha beta', 130);
  await page.locator('#clearSearch').click();
  assert.equal(await page.locator('#visibleCount').textContent(), '779');
  assert.equal(await page.evaluate(() => window.__firstStudyCard === document.querySelector('.topic')), true);
  assert.equal(await page.locator('.answer-toggle').first().getAttribute('aria-expanded'), 'false');
  assert.equal(await page.locator('.topic').count(), 779);
}));

test('study layout supports mobile and desktop filters, both themes and no horizontal overflow', () => withPage(async page => {
  await renderStudyFixture(page);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width !== 768) await page.waitForFunction(wide => document.querySelector('#filterDetails').open === wide, width > 900);
    const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, panelBottom: document.querySelector('#control-panel').getBoundingClientRect().bottom, firstQuestion: document.querySelector('.topic').getBoundingClientRect().top }));
    assert.ok(layout.scroll <= width, JSON.stringify(layout));
    assert.ok(layout.firstQuestion > layout.panelBottom, JSON.stringify(layout));
    if (width <= 900) {
      if (!(await page.locator('#filterDetails').evaluate(details => details.open))) await page.locator('#filterDetails summary').click();
      assert.equal(await page.locator('#sourceFilter').isVisible(), true);
      await page.locator('#sourceFilter').selectOption('数组');
      assert.equal(await page.locator('#visibleCount').textContent(), '2');
      await page.locator('#resetFilters').click();
    }
  }
  await page.locator('#themeToggle').selectOption('dark');
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('dark-mode')), true);
  await page.locator('#themeToggle').selectOption('light');
  assert.equal(await page.locator('body').evaluate(body => body.classList.contains('dark-mode')), false);
}));

test('source-unavailable image placeholders preserve explanations, metadata and manual links', () => withPage(async page => {
  const html = await page.evaluate(() => {
    const url = 'https://fixture.test/original-missing.png';
    __test.setData([{ GlobalUID: 0, QuestionType: 'Single', DetailHtml: '<p>Missing picture fixture</p><img src="images/img_7.png" alt="literal &lt;alt&gt;" title="Original title" data-original="https://fixture.test/original-missing.png">', imgUrls: [url], SniffedAnswer: 'A' }]);
    __test.setImages([[url, { filename: 'img_7.png', sourceUnavailable: true, status: 404, originalUrl: url, alt: 'backup alt', buffer: null, downloaded: false }]]);
    return __test.generateOfflineHtml(true);
  });
  await page.setContent(html);
  const placeholder = page.locator('.source-image-unavailable');
  assert.equal(await placeholder.getAttribute('data-source-status'), '404');
  assert.match(await placeholder.innerText(), /平台原图不可用（HTTP 404）/);
  assert.match(await placeholder.innerText(), /literal <alt>/);
  assert.match(await placeholder.innerText(), /Original title/);
  assert.equal(await placeholder.locator('a').getAttribute('href'), 'https://fixture.test/original-missing.png');
  assert.equal(await page.locator('img[src="images/img_7.png"]').count(), 0);
  assert.equal(await page.locator('#extraction-summary').getAttribute('data-source-unavailable-count'), '1');
  assert.equal(await page.locator('#extraction-summary').getAttribute('data-image-saved-count'), '0');
  assert.match(await page.locator('.image-integrity').innerText(), /图像内容不完整/);
  await page.locator('#toggleAnsBtn').click();
  assert.equal(await page.locator('.question-image-warning').isVisible(), true);
  assert.equal(await placeholder.isVisible(), true);
}));
