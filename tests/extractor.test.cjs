const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launch, createHarness, sourcePath } = require('./harness.cjs');
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
        if (type === 'Blank' || type === 'Program') return `<input id="hidden_TopicGuid" value="fixture-${type}"><div class="panel"><div class="panel-heading">多选题练习</div><div class="panel-body"><p>synthetic ${type}</p><pre>Required output: 42</pre></div><ul class="list-group">${type === 'Blank' ? '<li><input type="text" name="UserSelect"></li>' : ''}</ul></div>`;
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
      { GlobalUID: 0, TopicGuid: 'report-single', QuestionType: 'Single', s2_done: true, DetailHtml: '<p>Report fixture</p>', SniffedAnswer: 'A', AnswerSource: 'platform-verified' },
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
  await page.locator('.topic:not(.hidden)').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.querySelector('.topic:not(.hidden)').innerText.includes('Alpha'));
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
    await page.locator('#chapterFilter').selectOption({ label: 'Second chapter' });
    await page.waitForFunction(() => document.getElementById('visibleCount').textContent === '1');
    await page.locator('.topic:not(.hidden)').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.querySelector('.topic:not(.hidden)').innerText.includes('Beta local fixture'));
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

test('OCR login HTML skips AI without storing an image, then stage 4 pauses for image recovery', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 3;
    __test.keyManager.updateKeys('synthetic-test-key');
    const url = 'http://fixture.test/picture.png';
    __test.setData([{ GlobalUID: 0, QuestionType: 'Blank', TopicGuid: 'fixture', Title: 'Synthetic image question', DetailHtml: '<p>Read the picture</p>', imgUrls: [url], NeedsAI: true, s2_done: true, s3_done: false }]);
    __test.setImages([[url, { filename: 'img_1.png', downloaded: false, failed: false, buffer: null }]]);
    const calls = [];
    window.__fetch = async target => { calls.push(target); return new Response('<html><input type="password"></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }); };
    await __test.runStage3();
    const afterAI = { paused: __test.state.isPaused, stage: __test.state.stage, warning: __test.data[0].ExtractionWarning };
    await __test.runStage4();
    return { calls, afterAI, paused: __test.state.isPaused, stage: __test.state.stage, buffer: __test.images.get(url).buffer, answered: __test.data[0].s3_done, needsAI: __test.data[0].NeedsAI };
  });
  assert.deepEqual(result.calls, Array(4).fill('http://fixture.test/picture.png'));
  assert.equal(result.afterAI.paused, false);
  assert.equal(result.afterAI.stage, 4);
  assert.match(result.afterAI.warning, /AI 解答尚未生成/);
  assert.equal(result.paused, true);
  assert.equal(result.stage, 4);
  assert.equal(result.buffer, null);
  assert.equal(result.answered, false);
  assert.equal(result.needsAI, true);
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
      { GlobalUID: 2, QuestionType: 'Single', DetailHtml: '<p>Validated choice fixture</p>', SniffedAnswer: 'A', AnswerSource: 'platform-verified' },
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
  assert.equal(result.maxActive, 6);
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
  await page.locator('#chapterFilter').selectOption('数组');
  await page.locator('#clearSearch').click();
  assert.equal(await page.locator('#visibleCount').textContent(), '2');
  await page.locator('#typeFilter').selectOption('Program');
  assert.equal(await page.locator('#visibleCount').textContent(), '1');
  await page.locator('#diffFilter').selectOption('困难');
  assert.equal(await page.locator('#visibleCount').textContent(), '0');
  await page.locator('.empty-reset').click();
  assert.equal(await page.locator('#visibleCount').textContent(), '6');
  for (const selector of ['#sourceFilter', '#chapterFilter', '#typeFilter', '#diffFilter']) assert.equal(await page.locator(selector).inputValue(), 'all');
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
  await page.locator('.skip-link').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'keywordFilter');
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

test('study search, result count and global answers stay in the sidebar outside mobile disclosure without overlap', () => withPage(async page => {
  await renderStudyFixture(page);
  for (const width of [390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width !== 768) await page.waitForFunction(wide => document.querySelector('#filterDetails').open === wide, width > 900);
    if (width <= 900 && await page.locator('#filterDetails').evaluate(details => details.open)) await page.locator('#filterDetails summary').click();
    await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.sidebar').scrollTop = 0; });
    const layout = await page.evaluate(() => {
      const sidebar = document.querySelector('.sidebar'), search = document.querySelector('#control-panel');
      const details = document.querySelector('#filterDetails'), workspace = document.querySelector('.workspace');
      const results = document.querySelector('.results-toolbar'), toggle = document.querySelector('#toggleAnsBtn');
      const searchRect = search.getBoundingClientRect(), workspaceRect = workspace.getBoundingClientRect();
      return { width: innerWidth, scroll: document.documentElement.scrollWidth,
        searchFirst: sidebar.firstElementChild === search, outsideDisclosure: !search.closest('details'),
        searchBottom: searchRect.bottom, searchRight: searchRect.right, filterTop: details.getBoundingClientRect().top,
        workspaceLeft: workspaceRect.left, firstQuestion: document.querySelector('.topic').getBoundingClientRect().top,
        resultInside: sidebar.contains(results) && sidebar.contains(toggle) && sidebar.contains(document.querySelector('#visibleCount')),
        resultsOutsideDisclosure: !results.closest('details'), resultTop: results.getBoundingClientRect().top, resultBottom: results.getBoundingClientRect().bottom,
        uniqueControls: ['#resultStatus', '#visibleCount', '#toggleAnsBtn'].every(selector => document.querySelectorAll(selector).length === 1),
        sidebarBottom: sidebar.getBoundingClientRect().bottom, sidebarHeight: sidebar.clientHeight, sidebarContentHeight: sidebar.scrollHeight,
        positions: [sidebar, search, details].map(element => getComputedStyle(element).position) };
    });
    assert.ok(layout.scroll <= width, JSON.stringify(layout));
    assert.equal(layout.searchFirst, true);
    assert.equal(layout.outsideDisclosure, true);
    assert.equal(layout.resultInside, true);
    assert.equal(layout.resultsOutsideDisclosure, true);
    assert.equal(layout.uniqueControls, true);
    assert.ok(layout.searchBottom <= layout.resultTop && layout.resultBottom <= layout.filterTop, JSON.stringify(layout));
    if (width > 900) assert.ok(layout.searchRight <= layout.workspaceLeft, JSON.stringify(layout));
    else {
      assert.ok(layout.positions.every(position => !['sticky', 'fixed'].includes(position)), JSON.stringify(layout));
      assert.ok(layout.firstQuestion >= layout.sidebarBottom, JSON.stringify(layout));
      assert.ok(layout.sidebarContentHeight <= layout.sidebarHeight + 1, JSON.stringify(layout));
    }
    if (width <= 900) {
      assert.equal(await page.locator('#keywordFilter').isVisible(), true);
      assert.equal(await page.locator('#searchScope').isVisible(), true);
      assert.equal(await page.locator('#searchMatch').isVisible(), true);
      assert.equal(await page.locator('#visibleCount').isVisible(), true);
      assert.equal(await page.locator('#toggleAnsBtn').isVisible(), true);
      assert.equal(await page.locator('#sourceFilter').isVisible(), false);
      await studyQuery(page, 'alpha beta', 1);
      await page.locator('#clearSearch').click();
      assert.equal(await page.locator('#visibleCount').textContent(), '6');
      await page.locator('#filterDetails summary').click();
      assert.equal(await page.locator('#chapterFilter').isVisible(), true);
      await page.locator('#chapterFilter').selectOption('数组');
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

test('a failed local image retries only its same-origin file and restores geometry, description and surrounding text', () => withPage(async page => {
  const fixture = await decodedImageFixture(page);
  const html = await page.evaluate(() => {
    __test.data[0].DetailHtml = '<p>Before the synthetic image.</p><img src="images/img_1.png" width="120" alt="Exact &amp; description" title="Original image title" data-original="https://campus.invalid/original.png"><p>After the synthetic image.</p>';
    return __test.generateOfflineHtml(true);
  });
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  let attempts = 0;
  await page.route('**/images/img_1.png*', route => ++attempts === 1
    ? route.fulfill({status:503,body:'Synthetic temporary failure'})
    : route.fulfill({contentType:'image/png',body:Buffer.from(fixture.png,'base64')}));
  await page.setContent(html, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => document.querySelector('.image-retry'));
  assert.equal(await page.locator('.img-failed').count(),1);
  assert.equal(await page.locator('.img-failed a').getAttribute('href'),'https://campus.invalid/original.png');
  await page.locator('.image-retry').click();
  await page.waitForFunction(() => document.querySelector('.detail-box img')?.naturalWidth===400);
  const restored = await page.locator('.detail-box img').evaluate(image => {
    const rect=image.getBoundingClientRect();
    return {alt:image.alt,title:image.title,width:rect.width,height:rect.height,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,original:image.getAttribute('data-original')};
  });
  assert.deepEqual(restored,{alt:'Exact & description',title:'Original image title',width:120,height:60,naturalWidth:400,naturalHeight:200,original:'https://campus.invalid/original.png'});
  assert.equal(await page.locator('.img-failed').count(),0);
  assert.deepEqual(await page.locator('.detail-box p').allTextContents(),['Before the synthetic image.','After the synthetic image.']);
  assert.equal(requests.length,2);
  const first=new URL(requests[0]),retry=new URL(requests[1]);
  assert.equal(first.origin,'http://fixture.test'); assert.equal(retry.origin,first.origin);
  assert.equal(retry.pathname,first.pathname); assert.equal(retry.searchParams.has('bistu-retry'),true);
  assert.ok(requests.every(url=>new URL(url).hostname==='fixture.test'));
}));

test('repeated local image failures keep one retry placeholder while source-missing images remain manual links', () => withPage(async page => {
  await decodedImageFixture(page);
  const html = await page.evaluate(() => {
    const original='https://campus.invalid/';
    const kept=__test.images.get('http://fixture.test/first.png');
    __test.setImages([[original+'local-original.png',kept],...[404,404,410].map((status,index)=>[original+'missing-'+index+'.png',{
      filename:'img_'+(20+index)+'.png',sourceUnavailable:true,status,buffer:null,downloaded:false,alt:'Original missing diagram '+index
    }])]);
    __test.data[0].DetailHtml='<p>Persistent failure fixture</p><img src="images/img_1.png" data-original="'+original+'local-original.png">'+
      [0,1,2].map(index=>'<img src="images/img_'+(20+index)+'.png" alt="Original missing diagram '+index+'">').join('');
    return __test.generateOfflineHtml(true);
  });
  const requests=[]; page.on('request',request=>requests.push(request.url()));
  await page.route('**/images/img_1.png*',route=>route.fulfill({status:404,body:'Synthetic persistent failure'}));
  await page.setContent(html,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('.image-retry'));
  for(let retry=0;retry<3;retry++) {
    assert.equal(await page.locator('.img-failed:not(.source-image-unavailable)').count(),1);
    assert.equal(await page.locator('.source-image-unavailable').count(),3);
    assert.equal(await page.locator('.source-image-unavailable .image-retry').count(),0);
    assert.equal(await page.locator('.image-retry').count(),1);
    assert.equal(requests.length,retry+1);
    await page.locator('.image-retry').click();
    await page.waitForFunction(()=>document.querySelectorAll('.image-retry').length===1 && !document.querySelector('.detail-box img'));
  }
  assert.equal(requests.length,4);
  assert.equal(await page.locator('.img-failed').count(),4);
  assert.match(await page.locator('.detail-box').textContent(),/Persistent failure fixture/);
  assert.equal(await page.locator('.source-image-unavailable a').count(),3);
  assert.ok(requests.every(url=>new URL(url).origin==='http://fixture.test'&&new URL(url).pathname.endsWith('/images/img_1.png')));
  // Exercise the reader's own guard independently of the export sanitizer/CSP.
  // These synthetic inputs must never acquire a one-click automatic retry path.
  for(const unsafe of ['https://foreign.invalid/image.png','javascript:void(0)','file:///synthetic-fixture.invalid/image.png','data:text/html;base64,AAAA','http://[']) {
    const altered=html.replace('src="images/img_1.png"','src="'+unsafe+'"');
    assert.notEqual(altered,html);
    await page.setContent(altered,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelectorAll('.img-failed:not(.source-image-unavailable)').length===1);
    assert.equal(await page.locator('.image-retry').count(),0,unsafe);
  }
  await page.setContent(html.replace('src="images/img_1.png"','src="data:image/png;base64,AAAA"'),{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('.image-retry'));
  assert.equal(await page.locator('.image-retry').count(),1,'a passive image data URL remains a local retry source');
}));

test('AI skips unavailable question images while other answers and stage 4 complete honestly', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 3;
    __test.keyManager.updateKeys('synthetic-test-key');
    const url = 'http://fixture.test/missing.png';
    __test.setData([
      { GlobalUID: 0, QuestionType: 'Blank', TopicGuid: 'picture-fixture', Title: 'Picture fixture', DetailHtml: '<p>Image required</p><img src="images/img_1.png">', imgUrls: [url], NeedsAI: true, s2_done: true, s3_done: false },
      { GlobalUID: 1, QuestionType: 'Blank', TopicGuid: 'text-fixture', Title: 'Text fixture', DetailHtml: '<p>Text only fixture</p>', imgUrls: [], NeedsAI: true, s2_done: true, s3_done: false }
    ]);
    __test.setImages([[url, { filename: 'img_1.png', downloaded: false, buffer: null, failed: false }]]);
    const calls = [];
    __fetch = async (target, options) => {
      calls.push({ target, body: options?.body });
      if (target === url) return new Response('', { status: 404 });
      return __aiResponse('Synthetic text answer');
    };
    await __test.runEngine();
    return { rows: __test.data, calls, state: __test.state,
      report: JSON.parse(await __zips[0].file('extraction-report.json').async('string')),
      html: await __zips[0].file('index.html').async('string') };
  });
  assert.equal(result.state.stage, 5);
  assert.equal(result.state.isPaused, false);
  assert.equal(result.rows[0].s3_done, false);
  assert.equal(result.rows[0].NeedsAI, true);
  assert.equal(result.rows[0].SniffedAnswer, undefined);
  assert.match(result.rows[0].ExtractionWarning, /AI 解答尚未生成/);
  assert.equal(result.rows[1].s3_done, true);
  assert.equal(result.rows[1].SniffedAnswer, 'Synthetic text answer');
  const aiCalls = result.calls.filter(call => call.target.includes('deepseek.com'));
  assert.equal(aiCalls.length, 1);
  assert.match(aiCalls[0].body, /Text only fixture/);
  assert.doesNotMatch(aiCalls[0].body, /Image required/);
  assert.equal(result.report.complete, true);
  assert.equal(result.report.imagesComplete, false);
  assert.equal(result.report.images.sourceUnavailable, 1);
  assert.match(result.html, /AI 解答尚未生成/);
}));

test('reimporting an unanswered missing-image snapshot deduplicates AI warnings and clears only that warning after recovery', () => withPage(async page => {
  const state = snapshot();
  state.globalState.stage = 5;
  state.imgCounter = 2;
  state.allData = [{ GlobalUID: 0, QuestionType: 'Blank', TopicGuid: 'resume-fixture', Title: 'Resume fixture', DetailHtml: '<p>Image required</p><img src="images/img_1.png">', imgUrls: ['http://fixture.test/missing.png'], NeedsAI: true, s2_done: true, s3_done: false, PlatformDetailChecked: true, ExtractionWarning: 'Existing platform warning' }];
  state.imageQueueList = [['http://fixture.test/missing.png', { filename: 'img_1.png', downloaded: false, failed: false, sourceUnavailable: true, status: 404 }]];
  await page.evaluate(() => {
    document.getElementById('bistu-apikey').value = 'synthetic-test-key';
    window.__aiCalls = 0;
    __fetch = async target => {
      if (target.includes('deepseek.com')) { __aiCalls++; return __aiResponse('Synthetic recovered answer'); }
      if (!window.__imageRecovered) return new Response('', { status: 404 });
      const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='), char => char.charCodeAt(0));
      return new Response(png, { headers: { 'Content-Type': 'image/png' } });
    };
  });
  let restored = state;
  for (let attempt = 1; attempt <= 2; attempt++) {
    await uploadSnapshot(page, restored);
    await page.waitForFunction(count => __zips.length === count && !document.getElementById('bistu-import-btn').disabled, attempt);
    restored = await page.evaluate(async () => JSON.parse(await __zips.at(-1).file('state.json').async('string')));
    assert.equal(restored.globalState.stage, 5);
    assert.equal(restored.allData[0].s3_done, false);
    assert.equal(restored.allData[0].NeedsAI, true);
    assert.equal(restored.allData[0].SniffedAnswer, undefined);
    assert.equal(restored.allData[0].ExtractionWarning.split('AI 解答尚未生成').length - 1, 1);
    assert.match(restored.allData[0].ExtractionWarning, /^Existing platform warning\n/);
    assert.equal(await page.evaluate(() => __aiCalls), 0);
  }
  await page.evaluate(() => { window.__imageRecovered = true; });
  await uploadSnapshot(page, restored);
  await page.waitForFunction(() => __zips.length === 3 && !document.getElementById('bistu-import-btn').disabled);
  const recovered = await page.evaluate(async () => ({ row: __test.data[0], calls: __aiCalls, image: __test.images.values().next().value,
    report: JSON.parse(await __zips.at(-1).file('extraction-report.json').async('string')) }));
  assert.equal(recovered.row.s3_done, true);
  assert.equal(recovered.row.SniffedAnswer, 'Synthetic recovered answer');
  assert.equal(recovered.row.ExtractionWarning, 'Existing platform warning');
  assert.equal(recovered.calls, 1); // Default vision submits one complete image/question request.
  assert.equal(recovered.image.sourceUnavailable, false);
  assert.equal(recovered.report.complete, true);
  assert.equal(recovered.report.imagesComplete, true);
}));

test('OCR errors and empty recognition leave AI unanswered until image text can be read', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __setSettings({ imageMode: 'ocr', ocrClean: false });
    __test.keyManager.updateKeys('synthetic-test-key');
    const url = 'http://fixture.test/picture.png';
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='), char => char.charCodeAt(0)).buffer;
    __test.setData([{ GlobalUID: 0, QuestionType: 'Blank', TopicGuid: 'ocr-fixture', DetailHtml: '<p>OCR fixture</p>', imgUrls: [url], NeedsAI: true, s2_done: true, s3_done: false, ExtractionWarning: 'Keep this platform warning' }]);
    __test.setImages([[url, { filename: 'img_1.png', buffer: png, downloaded: true }]]);
    let mode = 'throw', calls = 0;
    Tesseract.createWorker = async () => ({ recognize: async () => {
      if (mode === 'throw') throw new Error('Synthetic OCR failure');
      return { data: { text: mode === 'empty' ? '' : 'Synthetic OCR text' } };
    } });
    __fetch = async () => { calls++; return __aiResponse('Synthetic answer'); };
    const attempts = [];
    for (mode of ['throw', 'empty', 'valid']) {
      __test.state.stage = 3; __test.state.isPaused = false;
      await __test.runStage3();
      attempts.push({ row: { ...__test.data[0] }, stage: __test.state.stage, paused: __test.state.isPaused, calls });
    }
    return attempts;
  });
  for (const attempt of result.slice(0, 2)) {
    assert.equal(attempt.stage, 4);
    assert.equal(attempt.paused, false);
    assert.equal(attempt.calls, 0);
    assert.equal(attempt.row.s3_done, false);
    assert.equal(attempt.row.SniffedAnswer, undefined);
    assert.equal(attempt.row.ExtractionWarning.split('AI 解答尚未生成').length - 1, 1);
  }
  assert.equal(result[2].row.s3_done, true);
  assert.equal(result[2].row.ExtractionWarning, 'Keep this platform warning');
  assert.equal(result[2].calls, 1);
}));

test('original Illinois and regular sources retain exact classification, badges and independent chapter filters', () => withPage(async page => {
  const rows = [
    ['Single-choice', 'Single', '简单', 'alpha'],
    ['Programming', 'Program', '挑战', 'alpha'],
    ['基础', 'Single', '简单', 'beta'],
    ['Programming', 'Multiple', '中等', 'beta'],
    ['programming', 'Program', '一般', 'case-sensitive'],
    [' Single-choice ', 'Blank', '困难', 'spaces'],
    ['Single-choice-extra', 'Single', '挑战', 'suffix'],
    ['伊利诺伊', 'Program', '新增难度', 'translated'],
    [undefined, 'Blank', undefined, 'unclassified']
  ].map(([ChapterName, QuestionType, DegreeLevel, text], GlobalUID) => ({ GlobalUID, ChapterName, QuestionType, DegreeLevel, DetailHtml: `<p>${text} synthetic source fixture</p>`, SniffedAnswer: 'Synthetic answer' }));
  await renderStudyFixture(page, rows);
  assert.deepEqual(new Set(await page.locator('#sourceFilter option').evaluateAll(options => options.map(option => option.value))), new Set(['all', 'normal', 'illinois']));
  assert.equal(await page.locator('.topic[data-source="illinois"]').count(), 3);
  assert.equal(await page.locator('.topic[data-source="normal"]').count(), 6);
  for (const card of await page.locator('.topic[data-source="illinois"]').all()) assert.match(await card.locator('.question-head').innerText(), /伊利诺伊/);
  for (const card of await page.locator('.topic[data-source="normal"]').all()) assert.doesNotMatch(await card.locator('.question-head').innerText(), /伊利诺伊/);
  assert.equal(await page.locator('.offline-status').count(), 0);
  assert.doesNotMatch(await page.locator('body').innerText(), /已保存到本地/);
  const select = async (selector, value, count) => {
    await page.locator(selector).selectOption(value);
    await page.waitForFunction(expected => document.querySelector('#visibleCount').textContent === String(expected), count);
  };
  await select('#sourceFilter', 'illinois', 3);
  await select('#chapterFilter', 'Programming', 2);
  await select('#typeFilter', 'Program', 1);
  await select('#diffFilter', '简单', 0);
  assert.equal(await page.locator('#emptyState').isVisible(), true);
  await page.locator('.empty-reset').click();
  assert.equal(await page.locator('#visibleCount').textContent(), '9');
  for (const selector of ['#sourceFilter', '#chapterFilter', '#typeFilter', '#diffFilter']) assert.equal(await page.locator(selector).inputValue(), 'all');
  await select('#sourceFilter', 'normal', 6);
  await select('#chapterFilter', '基础', 1);
  await select('#typeFilter', 'Single', 1);
  await select('#diffFilter', '简单', 1);
  await studyQuery(page, 'beta', 1);
  await select('#sourceFilter', 'illinois', 0);
  await page.locator('.empty-reset').click();
  assert.equal(await page.locator('#visibleCount').textContent(), '9');
  assert.equal(await page.locator('#keywordFilter').inputValue(), '');
  assert.equal(await page.locator('#searchScope').inputValue(), 'full');
  assert.equal(await page.locator('#emptyState').isVisible(), false);
}));

test('difficulty options retain the original learning order and append unfamiliar levels', () => withPage(async page => {
  const levels = ['挑战', '中等', '简单', '新增难度', '困难', '一般', undefined];
  await renderStudyFixture(page, levels.map((DegreeLevel, GlobalUID) => ({ GlobalUID, QuestionType: 'Blank', ChapterName: 'Synthetic chapter', DegreeLevel, DetailHtml: '<p>Synthetic difficulty fixture</p>' })));
  const options = await page.locator('#diffFilter option').evaluateAll(nodes => nodes.map(node => node.value));
  assert.deepEqual(options.slice(0, 6), ['all', '简单', '一般', '中等', '困难', '挑战']);
  assert.deepEqual(new Set(options.slice(6)), new Set(['新增难度', '无']));
  for (const value of levels.filter(Boolean).concat('无')) {
    await page.locator('#diffFilter').selectOption(value);
    await page.waitForFunction(() => document.querySelector('#visibleCount').textContent === '1');
    assert.equal(await page.locator('.topic:not(.hidden)').getAttribute('data-diff'), value);
  }
}));

test('full search includes original source badges and question numbers while phrase mode retains contiguous matching', () => withPage(async page => {
  await renderStudyFixture(page, [
    { GlobalUID: 0, QuestionType: 'Single', ChapterName: 'Single-choice', DegreeLevel: '简单', DetailHtml: '<p>alpha beta</p>', SniffedAnswer: 'Fixture answer' },
    { GlobalUID: 1, QuestionType: 'Single', ChapterName: 'Synthetic chapter', DegreeLevel: '一般', DetailHtml: '<p>alpha middle beta</p>', SniffedAnswer: 'Fixture answer' },
    { GlobalUID: 2, QuestionType: 'Program', ChapterName: 'Programming', DegreeLevel: '中等', DetailHtml: '<p>different prompt</p>', SniffedAnswer: 'answerOnlyFixtureToken', AnswerSource: 'platform-reference' }
  ]);
  await studyQuery(page, '伊利诺伊', 2);
  assert.deepEqual(await page.locator('.topic:not(.hidden)').evaluateAll(cards => cards.map(card => card.dataset.source)), ['illinois', 'illinois']);
  await studyQuery(page, '002', 1);
  assert.equal(await page.locator('.topic:not(.hidden) .question-number').textContent(), '002');
  await studyQuery(page, '2.', 1);
  assert.equal(await page.locator('.topic:not(.hidden) .question-number').textContent(), '002');
  await studyQuery(page, 'alpha beta', 2);
  assert.equal(await page.locator('#searchMatch').inputValue(), 'terms');
  await page.locator('#searchMatch').selectOption('phrase');
  assert.equal(await page.locator('#visibleCount').textContent(), '1');
  assert.equal(await page.locator('.topic:not(.hidden) .question-number').textContent(), '001');
  await page.locator('#searchMatch').selectOption('terms');
  assert.equal(await page.locator('#visibleCount').textContent(), '2');
  await studyQuery(page, 'answerOnlyFixtureToken', 1);
  await page.locator('#searchScope').selectOption('prompt');
  assert.equal(await page.locator('#visibleCount').textContent(), '0');
  await page.locator('#searchMatch').selectOption('phrase');
  await page.locator('.empty-reset').click();
  assert.equal(await page.locator('#searchMatch').inputValue(), 'terms');
  assert.equal(await page.locator('#searchScope').inputValue(), 'full');
  assert.equal(await page.locator('#keywordFilter').inputValue(), '');
  assert.equal(await page.locator('#visibleCount').textContent(), '3');
}));

test('desktop sidebar stays reachable while mobile sidebar scrolls normally and deep search shortcuts work', () => withPage(async page => {
  const data = Array.from({ length: 60 }, (_, GlobalUID) => ({ GlobalUID, QuestionType: 'Single', ChapterName: 'Synthetic scroll chapter', DegreeLevel: '简单', DetailHtml: '<p>Synthetic long question.</p>'.repeat(5), SniffedAnswer: 'Synthetic answer' }));
  await renderStudyFixture(page, data);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const shortcut of ['Control+k', '/']) {
      await page.evaluate(() => { document.activeElement.blur(); document.querySelector('.sidebar').scrollTop = 0; window.scrollTo({ top: 2400, behavior: 'instant' }); });
      await page.waitForFunction(() => scrollY > 1000);
      const before = await page.evaluate(() => ({ y: scrollY, top: document.querySelector('.sidebar').getBoundingClientRect().top, bottom: document.querySelector('.sidebar').getBoundingClientRect().bottom }));
      await page.evaluate(() => window.scrollBy({ top: 350, behavior: 'instant' }));
      const after = await page.evaluate(() => ({ y: scrollY, top: document.querySelector('.sidebar').getBoundingClientRect().top, bottom: document.querySelector('.sidebar').getBoundingClientRect().bottom }));
      assert.ok(after.y > before.y, JSON.stringify({ width, before, after }));
      if (width > 900) {
        assert.ok(before.top >= 0 && after.top >= 0 && after.bottom <= 900, JSON.stringify({ width, before, after }));
        assert.ok(Math.abs(before.top - after.top) < 2, JSON.stringify({ width, before, after }));
      } else {
        assert.ok(before.top < 0 && after.top < before.top, JSON.stringify({ width, before, after }));
        assert.ok(Math.abs((before.top - after.top) - (after.y - before.y)) < 2, JSON.stringify({ width, before, after }));
      }
      await page.keyboard.press(shortcut);
      await page.waitForFunction(() => {
        const search = document.querySelector('#keywordFilter'), rect = search.getBoundingClientRect();
        return document.activeElement === search && rect.top >= 0 && rect.bottom <= innerHeight;
      });
      assert.equal(await page.locator('#keywordFilter').isVisible(), true);
      assert.equal(await page.locator('.topic').count(), 60);
    }
    if (width > 900) {
      await page.evaluate(() => { document.querySelector('.sidebar').scrollTop = 0; window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }); });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const bottom = await page.evaluate(() => {
        const panel = document.querySelector('.sidebar').getBoundingClientRect(), input = document.querySelector('#keywordFilter').getBoundingClientRect();
        return { y: scrollY, maximum: document.documentElement.scrollHeight - innerHeight, sidebarTop: panel.top, sidebarBottom: panel.bottom,
          inputTop: input.top, inputBottom: input.bottom, viewportHeight: innerHeight };
      });
      assert.ok(Math.abs(bottom.y - bottom.maximum) < 2, JSON.stringify(bottom));
      assert.ok(bottom.sidebarTop >= 0 && bottom.sidebarBottom <= bottom.viewportHeight, JSON.stringify(bottom));
      assert.ok(bottom.inputTop >= 0 && bottom.inputBottom <= bottom.viewportHeight, JSON.stringify(bottom));
    }
  }
}));

test('a short desktop viewport keeps sidebar controls keyboard-accessible without trapping the reader', () => withPage(async page => {
  const data = Array.from({ length: 60 }, (_, GlobalUID) => ({ GlobalUID, QuestionType: 'Single', ChapterName: 'Synthetic long chapter name '.repeat(8),
    DegreeLevel: '简单', DetailHtml: '<p>Short viewport reading fixture.</p>'.repeat(6), SniffedAnswer: 'Synthetic answer' }));
  await page.setViewportSize({ width: 1024, height: 480 });
  await renderStudyFixture(page, data);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => window.scrollTo({ top: 1800, behavior: 'instant' }));
  const initial = await page.locator('.sidebar').evaluate(sidebar => ({
    tabindex: sidebar.getAttribute('tabindex'), label: sidebar.getAttribute('aria-label'), height: sidebar.clientHeight,
    contentHeight: sidebar.scrollHeight, top: sidebar.getBoundingClientRect().top, bottom: sidebar.getBoundingClientRect().bottom,
    docWidth: document.documentElement.scrollWidth, viewport: innerWidth
  }));
  assert.equal(initial.tabindex, '0');
  assert.ok(initial.label?.trim());
  assert.ok(initial.contentHeight > initial.height && initial.top >= 0 && initial.bottom <= 480, JSON.stringify(initial));
  assert.ok(initial.docWidth <= initial.viewport, JSON.stringify(initial));
  await page.locator('.sidebar').focus();
  let reachedReset = false;
  for (let step = 0; step < 20; step++) {
    await page.keyboard.press('Tab');
    const focus = await page.evaluate(() => {
      const active = document.activeElement, sidebar = document.querySelector('.sidebar'), rect = active.getBoundingClientRect(), panel = sidebar.getBoundingClientRect();
      return { id: active.id, inside: sidebar.contains(active), top: rect.top, bottom: rect.bottom, panelTop: panel.top, panelBottom: panel.bottom };
    });
    assert.equal(focus.inside, true, JSON.stringify(focus));
    assert.ok(focus.top >= focus.panelTop - 1 && focus.bottom <= focus.panelBottom + 1, JSON.stringify(focus));
    if (focus.id === 'resetFilters') { reachedReset = true; break; }
  }
  assert.equal(reachedReset, true);
  assert.ok(await page.locator('.sidebar').evaluate(sidebar => sidebar.scrollTop > 0));
  await page.keyboard.press('Control+k');
  await page.waitForFunction(() => {
    const input = document.querySelector('#keywordFilter'), rect = input.getBoundingClientRect(), panel = document.querySelector('.sidebar').getBoundingClientRect();
    return document.activeElement === input && rect.top >= panel.top && rect.bottom <= panel.bottom;
  });
  await page.locator('#keywordFilter').fill('Short viewport');
  await page.waitForFunction(() => document.querySelector('#visibleCount').textContent === '60');
  const priorY = await page.evaluate(() => scrollY);
  const question = await page.locator('.workspace').boundingBox();
  await page.mouse.move(question.x + question.width / 2, 360);
  await page.mouse.wheel(0, 400);
  await page.waitForFunction(previous => scrollY > previous + 100, priorY);
  assert.equal(await page.locator('#keywordFilter').inputValue(), 'Short viewport');
  await page.setViewportSize({ width: 390, height: 480 });
  await page.waitForFunction(() => !document.querySelector('#filterDetails').open);
  await page.locator('#filterDetails summary').click();
  await page.locator('#resetFilters').scrollIntoViewIfNeeded();
  assert.equal(await page.locator('#resetFilters').isVisible(), true);
  const mobile = await page.locator('.sidebar').evaluate(sidebar => ({ height: sidebar.clientHeight, content: sidebar.scrollHeight, top: sidebar.getBoundingClientRect().top,
    questionTop: document.querySelector('.topic').getBoundingClientRect().top, bottom: sidebar.getBoundingClientRect().bottom }));
  assert.ok(mobile.content <= mobile.height + 1, JSON.stringify(mobile));
  assert.ok(mobile.questionTop >= mobile.bottom, JSON.stringify(mobile));
}));

test('repeated program copying preserves exact text and restores the normal feedback label', () => withPage(async page => {
  await renderStudyFixture(page);
  await page.evaluate(() => {
    window.__repeatedCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__repeatedCopies.push(text); } } });
  });
  const button = page.locator('.reference-answer .copy-btn');
  const expected = await page.locator('.reference-answer .code-box').textContent();
  await button.click();
  await page.waitForFunction(() => document.querySelector('.reference-answer .copy-btn').textContent === '复制成功');
  await page.waitForTimeout(100);
  await button.click();
  await page.waitForTimeout(100);
  await button.click();
  await page.waitForFunction(() => window.__repeatedCopies.length === 3);
  assert.deepEqual(await page.evaluate(() => __repeatedCopies), [expected, expected, expected]);
  await page.waitForFunction(() => document.querySelector('.reference-answer .copy-btn').textContent === '一键复制', undefined, { timeout: 3000 });
  await page.waitForTimeout(250);
  assert.equal(await button.textContent(), '一键复制');
}));

async function decodedImageFixture(page, offscreen = false) {
  return page.evaluate(async farAway => {
    const canvas = document.createElement('canvas'); canvas.width = 400; canvas.height = 200;
    canvas.getContext('2d').fillRect(0, 0, 400, 200);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const buffer = await blob.arrayBuffer(), unvalidated = buffer.slice(0);
    const before = __test.getImageDimensions(buffer);
    await __test.validateImageBuffer(buffer, 'image/png');
    __test.setImages([
      ['http://fixture.test/first.png', { filename: 'img_1.png', buffer, downloaded: true }],
      ['http://fixture.test/second.png', { filename: 'img_2.png', buffer, downloaded: true }],
      ['http://fixture.test/third.png', { filename: 'img_3.png', buffer, downloaded: true }],
      ['http://fixture.test/unvalidated.png', { filename: 'img_4.png', buffer: unvalidated, downloaded: true }]
    ]);
    const detail = farAway
      ? '<div style="height:18000px">Synthetic offscreen image fixture</div><img src="images/img_1.png" alt="Delayed good image"><img src="images/img_2.png" alt="Delayed error image">'
      : '<p>Synthetic geometry fixture</p><img src="images/img_1.png" style="width:120px;height:7px" width="150" height="5" alt="Explicit style"><img src="images/img_2.png" alt="Natural dimensions"><img src="images/img_3.png" width="90" alt="Attribute display width"><img src="images/img_4.png" alt="Not validated">';
    __test.setData([{ GlobalUID: 0, TopicGuid: 'lazy-fixture', QuestionType: 'Blank', DetailHtml: detail, s2_done: true }]);
    const html = __test.generateOfflineHtml(true), doc = new DOMParser().parseFromString(html, 'text/html');
    return { html, png: canvas.toDataURL('image/png').split(',')[1], before: before || null, geometry: __test.getImageDimensions(buffer),
      unvalidatedGeometry: __test.getImageDimensions(unvalidated) || null,
      images: [...doc.querySelectorAll('.detail-box img')].map(image => ({ loading: image.getAttribute('loading'), decoding: image.getAttribute('decoding'),
        width: image.getAttribute('width'), height: image.getAttribute('height'), styleWidth: image.style.width, aspectRatio: image.style.aspectRatio })) };
  }, offscreen);
}

async function printImageQueueFixture(page, count) {
  const fixture = await decodedImageFixture(page);
  const html = await page.evaluate(size => {
    const buffer = [...__test.images.values()][0].buffer;
    __test.setImages(Array.from({length:size}, (_,index) => ['http://fixture.test/print-' + index + '.png', { filename:'img_' + (index+1) + '.png', buffer, downloaded:true }]));
    __test.setData([{GlobalUID:0,QuestionType:'Blank',DetailHtml:'<p>Synthetic print queue fixture</p>' +
      Array.from({length:size},(_,index)=>'<img src="images/img_' + (index+1) + '.png" alt="Synthetic queue image">').join('')}]);
    return __test.generateOfflineHtml(true);
  }, count);
  return {...fixture,html};
}

test('only validated image geometry permits deferred loading without replacing explicit display width', () => withPage(async page => {
  const result = await decodedImageFixture(page);
  assert.equal(result.before, null);
  assert.deepEqual(result.geometry, { width: 400, height: 200 });
  assert.equal(result.unvalidatedGeometry, null);
  assert.equal(result.images.length, 4);
  for (const image of result.images) {
    assert.equal(image.decoding, 'async');
  }
  for (const image of result.images.slice(0, 3)) {
    assert.equal(image.loading, 'lazy');
    assert.equal(image.aspectRatio, '400 / 200');
  }
  assert.equal(result.images[0].width, '150'); assert.equal(result.images[0].styleWidth, '120px');
  assert.equal(result.images[1].width, '400'); assert.equal(result.images[1].height, '200');
  assert.equal(result.images[2].width, '90');
  assert.equal(result.images[3].aspectRatio, '');
  assert.equal(result.images[3].loading, 'eager');
  assert.equal(result.images[3].width, null); assert.equal(result.images[3].height, null);
}));

test('delayed local images reserve the same layout before decoding and are not mistaken for broken images', () => withPage(async page => {
  const fixture = await decodedImageFixture(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route('**/images/*.png', async route => { await gate; await route.fulfill({ contentType: 'image/png', body: Buffer.from(fixture.png, 'base64') }); });
  try {
    await page.setContent(fixture.html, { waitUntil: 'domcontentloaded' });
    const geometry = () => page.locator('.detail-box img').evaluateAll(images => images.slice(0,3).map(image => {
      const rect = image.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, complete: image.complete };
    }));
    const before = await geometry();
    assert.ok(before.every(image => !image.complete));
    assert.equal(await page.locator('.img-failed').count(), 0);
    assert.deepEqual(before.map(image => image.width), [120, 400, 90]);
    assert.deepEqual(before.map(image => image.height), [60, 200, 45]);
    release();
    await page.waitForFunction(() => [...document.querySelectorAll('.detail-box img')].every(image => image.complete && image.naturalWidth === 400));
    const after = await geometry();
    for (let index=0;index<before.length;index++) for (const field of ['x','y','width','height']) assert.ok(Math.abs(before[index][field]-after[index][field]) < 0.1, JSON.stringify({before,after}));
    assert.equal(await page.locator('.img-failed').count(), 0);
  } finally { release(); }
}));

test('print button and Ctrl or Meta P wait for cold offscreen images to load or fail before printing', async () => {
  for (const trigger of ['button', 'Control+p', 'Meta+p']) await withPage(async page => {
    const fixture = await decodedImageFixture(page, true);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const requested = [];
    await page.route('**/images/*.png', async route => {
      requested.push(route.request().url()); await gate;
      if (route.request().url().endsWith('img_2.png')) await route.fulfill({ status: 404, body: 'Synthetic missing image' });
      else await route.fulfill({ contentType: 'image/png', body: Buffer.from(fixture.png, 'base64') });
    });
    try {
      await page.setContent(fixture.html, { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => { window.__printSnapshots = []; window.print = () => { __printSnapshots.push({
        loaded: [...document.querySelectorAll('.detail-box img')].every(image => image.complete && image.naturalWidth > 0),
        images: document.querySelectorAll('.detail-box img').length, missing: document.querySelectorAll('.img-failed').length
      }); }; });
      assert.equal(await page.locator('.detail-box img').count(), 2);
      assert.equal(await page.locator('.img-failed').count(), 0);
      assert.equal(await page.locator('.detail-box img').evaluateAll(images => images.every(image => !image.complete)), true);
      if (trigger === 'button') await page.locator('#printBtn').click(); else await page.keyboard.press(trigger);
      await page.waitForFunction(() => [...document.querySelectorAll('.detail-box img')].every(image => image.loading === 'eager'));
      assert.equal(await page.locator('#printBtn').isDisabled(), true);
      assert.equal(await page.evaluate(() => __printSnapshots.length), 0);
      // Repeated shortcuts while pending must not open a second print operation.
      await page.keyboard.press('Control+p');
      release();
      await page.waitForFunction(() => __printSnapshots.length === 1 && !document.querySelector('#printBtn').disabled);
      assert.deepEqual(await page.evaluate(() => __printSnapshots), [{ loaded: true, images: 1, missing: 1 }]);
      assert.equal(requested.length, 2);
      assert.equal(await page.locator('#printBtn').textContent(), '打印 / 保存 PDF');
    } finally { release(); }
  });
});

test('native print transitions retain delayed offscreen images until their local responses arrive', async () => {
  for (const trigger of ['beforeprint', 'media']) await withPage(async page => {
    const fixture = await decodedImageFixture(page, true);
    let release; const gate = new Promise(resolve => { release = resolve; });
    const requested = [];
    await page.route('**/images/*.png', async route => { requested.push(route.request().url()); await gate; await route.fulfill({ contentType: 'image/png', body: Buffer.from(fixture.png, 'base64') }); });
    try {
      await page.setContent(fixture.html, { waitUntil: 'domcontentloaded' });
      assert.equal(await page.evaluate(() => scrollY), 0);
      assert.equal(await page.locator('.detail-box img').evaluateAll(images => images.every(image => !image.complete)), true);
      if (trigger === 'beforeprint') await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
      else await page.emulateMedia({ media: 'print' });
      await page.waitForFunction(() => [...document.querySelectorAll('.detail-box img')].every(image => image.loading === 'eager'));
      release();
      await page.waitForFunction(() => [...document.querySelectorAll('.detail-box img')].every(image => image.complete && image.naturalWidth === 400));
      assert.equal(requested.length, 2);
      assert.equal(await page.locator('.img-failed').count(), 0);
    } finally { release(); }
  });
});

test('printing prepares a full image queue with at most two simultaneous decodes and retains failed-image notices', () => withPage(async page => {
  const fixture = await printImageQueueFixture(page, 16);
  await page.route('**/images/*.png', route => route.request().url().endsWith('img_16.png')
    ? route.fulfill({status:404,body:'Synthetic missing image'})
    : route.fulfill({contentType:'image/png',body:Buffer.from(fixture.png,'base64')}));
  await page.setContent(fixture.html, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => document.querySelectorAll('.img-failed').length===1 && [...document.querySelectorAll('.detail-box img')].every(image=>image.complete&&image.naturalWidth===400));
  await page.evaluate(() => {
    window.__decodeStats = {active:0,peak:0,started:0,completed:0};
    window.__decodeReleases = []; window.__queuedPrints = [];
    for (const image of document.querySelectorAll('.detail-box img')) image.decode = () => {
      __decodeStats.started++; __decodeStats.active++; __decodeStats.peak=Math.max(__decodeStats.peak,__decodeStats.active);
      return new Promise(resolve => __decodeReleases.push(() => { __decodeStats.active--; __decodeStats.completed++; resolve(); }));
    };
    window.print = () => __queuedPrints.push({completed:__decodeStats.completed,active:__decodeStats.active,
      images:document.querySelectorAll('.detail-box img').length,missing:document.querySelectorAll('.img-failed').length});
  });
  await page.locator('#printBtn').click();
  await page.waitForFunction(() => __decodeStats.started>=2);
  assert.deepEqual(await page.evaluate(() => __decodeStats),{active:2,peak:2,started:2,completed:0});
  assert.equal(await page.evaluate(() => __queuedPrints.length),0);
  await page.keyboard.press('Control+p');
  assert.equal(await page.evaluate(() => __decodeStats.started),2);
  for (let completed=0;completed<15;) {
    const released = await page.evaluate(() => { const ready=__decodeReleases.splice(0); ready.forEach(resolve=>resolve()); return ready.length; });
    assert.ok(released>0 && released<=2);
    completed+=released;
    if(completed<15) {
      await page.waitForFunction(() => __decodeReleases.length>0);
      assert.equal(await page.evaluate(() => __queuedPrints.length),0);
    }
  }
  await page.waitForFunction(() => __queuedPrints.length===1 && !document.querySelector('#printBtn').disabled);
  assert.deepEqual(await page.evaluate(() => __decodeStats),{active:0,peak:2,started:15,completed:15});
  assert.deepEqual(await page.evaluate(() => __queuedPrints),[{completed:15,active:0,images:15,missing:1}]);
  assert.match(await page.locator('.img-failed').textContent(),/缺失|无法解码/);
}));

test('print preparation times out stalled loads or decodes, cleans listeners and can retry successfully', async () => {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const timeoutDeclaration = 'const PRINT_PREPARE_TIMEOUT_MS = 30000;';
  assert.equal(source.split(timeoutDeclaration).length, 2, 'production timeout must remain a bounded thirty seconds');
  // Only the private test copy shortens the timeout; production and image bytes stay intact.
  const instrumented = source.replace(timeoutDeclaration, 'const PRINT_PREPARE_TIMEOUT_MS = 150;');
  for (const mode of ['load', 'decode']) {
    const harness = await createHarness(browser, instrumented), page = harness.page;
    let release; const gate = new Promise(resolve => { release = resolve; });
    try {
      const fixture = await printImageQueueFixture(page, 12);
      await page.route('**/images/*.png', async route => {
        if (mode === 'load') await gate;
        await route.fulfill({ contentType: 'image/png', body: Buffer.from(fixture.png, 'base64') });
      });
      await page.setContent(fixture.html, { waitUntil: 'domcontentloaded' });
      await page.evaluate(stallDecode => {
        window.__printCalls = 0; window.__unhandledPrintErrors = 0; window.__releaseDecodes = [];
        window.print = () => { __printCalls++; };
        window.addEventListener('unhandledrejection', () => { __unhandledPrintErrors++; });
        const images = [...document.querySelectorAll('.detail-box img')];
        window.__printListenerSets = images.map(image => {
          const registrations = new Map(), add = image.addEventListener.bind(image), remove = image.removeEventListener.bind(image);
          image.addEventListener = (type, callback, options) => {
            if (['load','error'].includes(type)) registrations.set(callback,type);
            add(type,callback,options);
          };
          image.removeEventListener = (type, callback, options) => { registrations.delete(callback); remove(type,callback,options); };
          return registrations;
        });
        const decoders = images.map(image => image.decode.bind(image));
        if (stallDecode) images.forEach(image => { image.decode = () => new Promise(resolve => __releaseDecodes.push(resolve)); });
        window.__restoreImageDecodes = () => { images.forEach((image,index) => { image.decode = decoders[index]; }); __releaseDecodes.forEach(resolve => resolve()); };
        window.__printTimers = new Set();
        const set = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window);
        window.setTimeout = (callback, delay, ...args) => {
          if (delay !== 150) return set(callback,delay,...args);
          const handle = set(() => { __printTimers.delete(handle); callback(...args); },delay);
          __printTimers.add(handle); return handle;
        };
        window.clearTimeout = handle => { __printTimers.delete(handle); clear(handle); };
      }, mode === 'decode');
      for (let attempt=0;attempt<2;attempt++) {
        await page.locator('#printBtn').click();
        await page.waitForFunction(() => {
          const status = document.querySelector('#printStatus');
          return status && !status.hidden && status.textContent.includes('超时') && !document.querySelector('#printBtn').disabled;
        });
        assert.match(await page.locator('#printStatus').textContent(), /未打开打印.*重试/);
        assert.equal(await page.locator('#printStatus').getAttribute('role'), 'alert');
        assert.equal(await page.locator('#printBtn').textContent(), '打印 / 保存 PDF');
        assert.deepEqual(await page.evaluate(() => ({ prints:__printCalls, listeners:__printListenerSets.reduce((sum,set)=>sum+set.size,0), timers:__printTimers.size, unhandled:__unhandledPrintErrors })),
          { prints:0, listeners:0, timers:0, unhandled:0 }, mode);
        if(mode==='decode') assert.equal(await page.evaluate(() => __releaseDecodes.length),2,'a retry must reuse unfinished native decodes instead of starting more');
      }
      release();
      await page.evaluate(() => __restoreImageDecodes());
      await page.waitForFunction(() => [...document.querySelectorAll('.detail-box img')].every(image => image.complete && image.naturalWidth === 400));
      await page.keyboard.press('Control+p');
      await page.waitForFunction(() => __printCalls === 1 && !document.querySelector('#printBtn').disabled);
      assert.equal(await page.locator('#printStatus').isVisible(), false);
      assert.equal(await page.locator('#printStatus').count(), 1);
      assert.deepEqual(await page.evaluate(() => ({ listeners:__printListenerSets.reduce((sum,set)=>sum+set.size,0), timers:__printTimers.size, unhandled:__unhandledPrintErrors })),
        { listeners:0, timers:0, unhandled:0 }, mode);
    } finally { release(); await harness.close(); }
  }
});

test('browser find reaches offscreen topic text and the reader does not intercept Ctrl F', () => withPage(async page => {
  const token = 'SyntheticBrowserFindLastTopicToken';
  const data = Array.from({ length: 60 }, (_, GlobalUID) => ({ GlobalUID, QuestionType: 'Blank', ChapterName: 'Synthetic find chapter', DetailHtml: `<p>${GlobalUID === 59 ? token : 'Ordinary synthetic question'}</p>` }));
  await renderStudyFixture(page, data);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { window.scrollTo({ top: 0, behavior: 'instant' }); getSelection().removeAllRanges(); });
  const result = await page.evaluate(value => {
    const event = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    document.dispatchEvent(event);
    const found = window.find(value, false, false, true);
    const selection = getSelection();
    return { intercepted: event.defaultPrevented, found, text: selection.toString(), count: document.querySelectorAll('.topic').length };
  }, token);
  assert.equal(result.intercepted, false);
  assert.equal(result.found, true);
  assert.equal(result.text, token);
  assert.equal(result.count, 60);
  await page.waitForFunction(() => {
    const selection = getSelection();
    if (!selection.rangeCount) return false;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return rect.bottom > 0 && rect.top < innerHeight;
  });
}));

test('print keeps every question and complete code while removing sidebar controls and offscreen rendering containment', () => withPage(async page => {
  const data = Array.from({ length: 40 }, (_, GlobalUID) => ({ GlobalUID, QuestionType: 'Program', ChapterName: 'Synthetic print chapter', DetailHtml: `<p>Print question ${GlobalUID + 1}</p>`, SniffedAnswer: `class Fixture${GlobalUID} {\n    String value = "print";\n}\n`, AnswerSource: 'platform-reference' }));
  await renderStudyFixture(page, data);
  await page.emulateMedia({ media: 'print' });
  const printed = await page.evaluate(() => ({
    sidebar: getComputedStyle(document.querySelector('.sidebar')).display,
    topics: Array.from(document.querySelectorAll('.topic')).map(topic => {
      const style = getComputedStyle(topic), code = topic.querySelector('.code-box');
      return { display: style.display, contentVisibility: style.contentVisibility, code: code.textContent,
        maxHeight: getComputedStyle(code).maxHeight, overflow: getComputedStyle(code).overflowY };
    })
  }));
  assert.equal(printed.sidebar, 'none');
  assert.equal(printed.topics.length, data.length);
  for (const [index, topic] of printed.topics.entries()) {
    assert.notEqual(topic.display, 'none');
    assert.equal(topic.contentVisibility, 'visible');
    assert.equal(topic.code, data[index].SniffedAnswer);
    assert.equal(topic.maxHeight, 'none');
    assert.equal(topic.overflow, 'visible');
  }
}));

test('filtered questions occupy no height, cannot receive focus or browser find, and fully return after clearing search', () => withPage(async page => {
  const hiddenToken = 'SyntheticHiddenTopicFindToken';
  await renderStudyFixture(page, [
    { GlobalUID: 0, QuestionType: 'Program', ChapterName: 'Programming', DetailHtml: `<p>${hiddenToken}</p>`, SniffedAnswer: 'class SyntheticFocusFixture {}', AnswerSource: 'platform-reference' },
    { GlobalUID: 1, QuestionType: 'Single', ChapterName: 'Synthetic chapter', DetailHtml: '<p>KeepOnlyFixtureToken</p>', SniffedAnswer: 'Synthetic visible answer' }
  ]);
  await page.evaluate(() => { window.__retainedCard = document.querySelector('.topic'); });
  await studyQuery(page, 'KeepOnlyFixtureToken', 1);
  const hidden = await page.evaluate(token => {
    const card = window.__retainedCard, code = card.querySelector('.code-box');
    const style = getComputedStyle(card);
    code.focus();
    getSelection().removeAllRanges();
    return { height: card.getBoundingClientRect().height, margins: style.display === 'none' ? 0 : parseFloat(style.marginTop) + parseFloat(style.marginBottom),
      ariaHidden: card.getAttribute('aria-hidden'), focusInside: card.contains(document.activeElement),
      browserFound: window.find(token, false, false, true), count: document.querySelectorAll('.topic').length };
  }, hiddenToken);
  assert.equal(hidden.height, 0);
  assert.equal(hidden.margins, 0);
  assert.equal(hidden.ariaHidden, 'true');
  assert.equal(hidden.focusInside, false);
  assert.equal(hidden.browserFound, false);
  assert.equal(hidden.count, 2);
  assert.equal(await page.locator('.topic.hidden .detail-box').isVisible(), false);
  await page.locator('#clearSearch').click();
  const restored = await page.evaluate(token => {
    const card = document.querySelector('.topic'), code = card.querySelector('.code-box');
    code.focus();
    getSelection().removeAllRanges();
    return { same: card === window.__retainedCard, height: card.getBoundingClientRect().height,
      ariaHidden: card.getAttribute('aria-hidden'), focused: document.activeElement === code,
      text: card.innerText, browserFound: window.find(token, false, false, true), count: document.querySelectorAll('.topic').length };
  }, hiddenToken);
  assert.equal(restored.same, true);
  assert.ok(restored.height > 0);
  assert.equal(restored.ariaHidden, 'false');
  assert.equal(restored.focused, true);
  assert.match(restored.text, /SyntheticHiddenTopicFindToken/);
  assert.equal(restored.browserFound, true);
  assert.equal(restored.count, 2);
  assert.equal(await page.locator('.topic.hidden').count(), 0);
  assert.equal(await page.locator('#visibleCount').textContent(), '2');
}));

test('narrow-screen prompt and answer images retain natural proportions despite platform inline heights', () => withPage(async page => {
  const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=';
  const markup = `<img src="${src}" style="width:900px;height:100px" width="900" height="100" alt="Synthetic square fixture">`;
  await renderStudyFixture(page, [{ GlobalUID: 0, QuestionType: 'Single', ChapterName: 'Synthetic image chapter', DetailHtml: `<p>Question image</p>${markup}`, SniffedAnswer: markup }]);
  await page.waitForFunction(() => Array.from(document.querySelectorAll('.detail-box img,.answer-content img')).every(img => img.complete && img.naturalWidth === 1));
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 900 });
    const images = await page.locator('.detail-box img,.answer-content img').evaluateAll(nodes => nodes.map(img => {
      const rect = img.getBoundingClientRect();
      return { width: rect.width, height: rect.height, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight,
        parentWidth: img.parentElement.getBoundingClientRect().width, src: img.getAttribute('src') };
    }));
    assert.equal(images.length, 2);
    for (const image of images) {
      assert.equal(image.src, src);
      assert.ok(image.width > 0 && image.height > 0);
      assert.ok(image.width <= image.parentWidth + 1 && image.width <= width, JSON.stringify(image));
      assert.ok(Math.abs(image.width / image.height - image.naturalWidth / image.naturalHeight) < 0.01, JSON.stringify(image));
    }
  }
}));

test('AI settings expose every default in the UI and read valid user changes', () => withPage(async page => {
  const defaults = {
    listConcurrency: 6, detailConcurrency: 6, aiConcurrency: 6, imageConcurrency: 6,
    pageSize: 10, platformTimeoutMs: 30000, platformAttempts: 3, platformDelayMs: 100,
    imageAttempts: 3, imageRetryDelayMs: 500, perKeyConcurrency: 2, aiAttempts: 3,
    aiTimeoutMs: 180000, aiRetryDelayMs: 1000, model: 'deepseek-flash', programModel: 'deepseek-v4-pro',
    visionModel: 'deepseek-flash', thinking: 'enabled', reasoningEffort: 'high', maxTokens: 32768,
    temperature: 0.2, imageMode: 'vision', ocrClean: false
  };
  const initial = await page.evaluate(names => ({
    settings: __test.getSettings(),
    controls: names.map(name => {
      const input = document.getElementById('bistu-setting-' + name);
      return { name, present: !!input, value: input?.type === 'checkbox' ? input.checked : input?.value };
    })
  }), Object.keys(defaults));
  for (const [name, value] of Object.entries(defaults)) {
    assert.equal(initial.settings[name], value, name);
    const control = initial.controls.find(control => control.name === name);
    assert.equal(control.present, true, name);
    assert.equal(String(control.value), String(value), name);
  }
  const changes = { aiConcurrency: 4, perKeyConcurrency: 1, pageSize: 7, aiAttempts: 1,
    thinking: 'disabled', imageMode: 'ocr', ocrClean: true, maxTokens: 1024, temperature: 0.6 };
  const updated = await page.evaluate(values => { __setSettings(values); return __test.getSettings(); }, changes);
  for (const [name, value] of Object.entries(changes)) assert.equal(updated[name], value, name);
}));

test('AI settings reject invalid concurrency, page size and generation values before requests', () => withPage(async page => {
  const result = await page.evaluate(() => {
    const badValues = [['aiConcurrency', 0], ['aiConcurrency', 33], ['perKeyConcurrency', 0],
      ['pageSize', 101], ['pageSize', 1.5], ['multipleMaxOptions', 21], ['maxTokens', -1], ['temperature', '']];
    return badValues.map(([field, value]) => {
      const input = document.getElementById('bistu-setting-' + field);
      if (!input) throw new Error('Missing setting control: ' + field);
      const old = input.value; input.value = String(value);
      let error; try { __test.getSettings(); } catch (caught) { error = caught.message; }
      input.value = old;
      return { field, rejected: !!error };
    });
  });
  assert.ok(result.every(result => result.rejected), JSON.stringify(result));
}));

test('AI reconciles platform references and never overwrites any already valid answer', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.state.stage = 3;
    __test.keyManager.updateKeys('synthetic-priority-key');
    const common = { s2_done: true, s3_done: false, NeedsAI: true, PlatformDetailChecked: true, imgUrls: [] };
    __test.setData([
      { ...common, GlobalUID: 0, TopicGuid: 'verified', QuestionType: 'Single', DetailHtml: '<p>Verified fixture</p>', SniffedAnswer: 'Original verified answer', AnswerSource: 'platform-verified', IsAIAnswer: false },
      { ...common, GlobalUID: 1, TopicGuid: 'program-reference', QuestionType: 'Program', DetailHtml: '<p>Reference fixture</p>', PlainExample: '\r\nclass Official {}\r\n', SniffedAnswer: 'class OldAI {}', AnswerSource: 'ai', IsAIAnswer: true },
      { ...common, GlobalUID: 2, TopicGuid: 'existing-ai', QuestionType: 'Blank', DetailHtml: '<p>Existing AI fixture</p>', SniffedAnswer: 'Existing valid AI answer', AnswerSource: 'ai', IsAIAnswer: true, s3_done: true },
      { ...common, GlobalUID: 3, TopicGuid: 'missing', QuestionType: 'Blank', DetailHtml: '<p>Missing answer fixture</p>', SniffedAnswer: '   ', IsAIAnswer: false, s3_done: true }
    ]);
    const bodies = [];
    __fetch = async (url, options) => { bodies.push(JSON.parse(options.body)); return __aiResponse('New missing answer'); };
    await __test.runStage3();
    return { rows: __test.data, bodies, stage: __test.state.stage, paused: __test.state.isPaused };
  });
  assert.equal(result.rows[0].SniffedAnswer, 'Original verified answer');
  assert.equal(result.rows[0].AnswerSource, 'platform-verified');
  assert.equal(result.rows[1].SniffedAnswer, '\r\nclass Official {}\r\n');
  assert.equal(result.rows[1].AnswerSource, 'platform-reference');
  assert.equal(result.rows[1].IsAIAnswer, false);
  assert.equal(result.rows[2].SniffedAnswer, 'Existing valid AI answer');
  assert.equal(result.rows[3].SniffedAnswer, 'New missing answer');
  assert.equal(result.rows[3].s3_done, true);
  assert.equal(result.bodies.length, 1);
  assert.match(JSON.stringify(result.bodies[0].messages), /Missing answer fixture/);
  assert.equal(result.paused, false);
  assert.equal(result.stage, 4);
}));

test('AI deduplicates arbitrary key counts and fairly rotates every healthy key', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __setSettings({ aiConcurrency: 1, perKeyConcurrency: 1 });
    const keys = Array.from({ length: 17 }, (_, index) => 'synthetic-fair-key-' + index);
    __test.keyManager.updateKeys(keys.join('\n') + '\n' + keys.slice(0, 4).join('，') + ';' + keys[0]);
    __test.state.stage = 3;
    __test.setData(Array.from({ length: 51 }, (_, GlobalUID) => ({ GlobalUID, TopicGuid: 'fair-' + GlobalUID,
      QuestionType: 'Blank', DetailHtml: '<p>Synthetic fair fixture ' + GlobalUID + '</p>', s2_done: true,
      PlatformDetailChecked: true, NeedsAI: true, s3_done: false, imgUrls: [] })));
    const assignments = [];
    __fetch = async (_, options) => { assignments.push(options.headers.Authorization.replace(/^Bearer /, '')); return __aiResponse(); };
    await __test.runStage3();
    return { assignments, uniqueKeys: __test.keyManager.getCount(), completed: __test.data.filter(row => row.s3_done).length };
  });
  assert.equal(result.uniqueKeys, 17);
  assert.equal(result.completed, 51);
  assert.equal(result.assignments.length, 51);
  assert.equal(new Set(result.assignments.slice(0, 17)).size, 17);
  const counts = new Map();
  for (const key of result.assignments) counts.set(key, (counts.get(key) || 0) + 1);
  assert.equal(counts.size, 17);
  assert.ok([...counts.values()].every(count => count === 3));
}));

test('AI scans beyond ten rejected keys and disables authentication/quota failures', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __setSettings({ aiConcurrency: 1, perKeyConcurrency: 1, aiRetryDelayMs: 0 });
    const keys = Array.from({ length: 17 }, (_, index) => 'synthetic-health-key-' + index);
    __test.keyManager.updateKeys(keys.join('\n'));
    __test.state.stage = 3;
    __test.setData(Array.from({ length: 2 }, (_, GlobalUID) => ({ GlobalUID, TopicGuid: 'health-' + GlobalUID,
      QuestionType: 'Blank', DetailHtml: '<p>Synthetic key health fixture</p>', s2_done: true,
      PlatformDetailChecked: true, NeedsAI: true, s3_done: false, imgUrls: [] })));
    const assignments = [];
    __fetch = async (_, options) => {
      const key = options.headers.Authorization.replace(/^Bearer /, ''); assignments.push(key);
      const index = keys.indexOf(key);
      return index === 16 ? __aiResponse() : new Response('', { status: index % 2 ? 401 : 402 });
    };
    await __test.runStage3();
    return { assignments, completed: __test.data.filter(row => row.s3_done).length, paused: __test.state.isPaused, outOfKeys: __test.state.outOfKeys };
  });
  assert.equal(result.completed, 2);
  assert.equal(result.paused, false);
  assert.equal(result.outOfKeys, false);
  for (let index = 0; index < 16; index++) assert.equal(result.assignments.filter(key => key === 'synthetic-health-key-' + index).length, 1);
  assert.equal(result.assignments.filter(key => key === 'synthetic-health-key-16').length, 2);
}));

test('AI starts six workers by default and respects the per-key lease limit', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.keyManager.updateKeys('synthetic-concurrency-1\nsynthetic-concurrency-2\nsynthetic-concurrency-3\nsynthetic-concurrency-4');
    __test.state.stage = 3;
    __test.setData(Array.from({ length: 24 }, (_, GlobalUID) => ({ GlobalUID, TopicGuid: 'concurrent-' + GlobalUID,
      QuestionType: 'Blank', DetailHtml: '<p>Synthetic concurrency fixture</p>', s2_done: true,
      PlatformDetailChecked: true, NeedsAI: true, s3_done: false, imgUrls: [] })));
    let active = 0, maxActive = 0;
    const byKey = new Map(), maxima = new Map();
    __fetch = async (_, options) => {
      const key = options.headers.Authorization;
      active++; maxActive = Math.max(maxActive, active); byKey.set(key, (byKey.get(key) || 0) + 1);
      maxima.set(key, Math.max(maxima.get(key) || 0, byKey.get(key)));
      await new Promise(resolve => setTimeout(resolve, 20));
      active--; byKey.set(key, byKey.get(key) - 1); return __aiResponse();
    };
    await __test.runStage3();
    return { maxActive, maxPerKey: Math.max(...maxima.values()), active, remainingPerKey: Array.from(byKey.values()), completed: __test.data.filter(row => row.s3_done).length };
  });
  assert.equal(result.maxActive, 6);
  assert.ok(result.maxPerKey <= 2);
  assert.equal(result.active, 0);
  assert.ok(result.remainingPerKey.every(count => count === 0));
  assert.equal(result.completed, 24);
}));

test('default vision sends one complete question request and never invokes OCR cleaning', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.keyManager.updateKeys('synthetic-vision-key'); __test.state.stage = 3;
    const url = 'http://fixture.test/vision-picture.png';
    const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII='), char => char.charCodeAt(0)).buffer;
    __test.setImages([[url, { filename: 'img_1.png', buffer: png, downloaded: true }]]);
    __test.setData([{ GlobalUID: 0, TopicGuid: 'vision-fixture', QuestionType: 'Blank', DetailHtml: '<p>Read this synthetic figure</p><img src="images/img_1.png">',
      imgUrls: [url], s2_done: true, PlatformDetailChecked: true, s3_done: false, NeedsAI: true }]);
    let ocrCalls = 0; Tesseract.createWorker = async () => { ocrCalls++; throw new Error('Default vision must not initialize OCR'); };
    const bodies = [];
    __fetch = async (_, options) => { bodies.push(JSON.parse(options.body)); return __aiResponse('Synthetic visual answer'); };
    await __test.runStage3();
    return { bodies, ocrCalls, row: __test.data[0], paused: __test.state.isPaused };
  });
  assert.equal(result.bodies.length, 1);
  assert.equal(result.ocrCalls, 0);
  assert.equal(result.bodies[0].model, 'deepseek-flash');
  const content = result.bodies[0].messages.find(message => message.role === 'user').content;
  assert.ok(Array.isArray(content));
  assert.ok(content.some(part => part.type === 'text' && /Read this synthetic figure/.test(part.text)));
  assert.equal(content.filter(part => part.type === 'image_url').length, 1);
  assert.match(content.find(part => part.type === 'image_url').image_url.url, /^data:image\/[a-z0-9.+-]+;base64,/i);
  assert.equal(result.row.SniffedAnswer, 'Synthetic visual answer');
  assert.equal(result.row.s3_done, true);
  assert.equal(result.paused, false);
}));

test('direct platform answer reconciliation is explicit, preserves code and never guesses unknown schemas', () => withPage(async page => {
  const result = await page.evaluate(() => {
    const detail = '<label><input type="checkbox" value="A&amp;B=1">First exact option</label><label><input type="checkbox" value="C">Second exact option</label>';
    const rows = [
      { QuestionType: 'Single', Answer: 'A&B=1', DetailHtml: detail },
      { QuestionType: 'Multiple', Answer: ['A&B=1', 'C'], DetailHtml: detail },
      { QuestionType: 'Multiple', Answer: 'A&B=1,C', DetailHtml: detail },
      { QuestionType: 'TrueOrFalse', Answer: false, DetailHtml: '<label><input type="radio" value="TRUE">True label</label><label><input type="radio" value="FALSE">False label</label>' },
      { QuestionType: 'Blank', Answer: false },
      { QuestionType: 'Blank', Answer: 0 },
      { QuestionType: 'Program', PlainExample: '\r\nclass PlatformReference {}\r\n', Answer: 'lower priority' },
      { QuestionType: 'Single', Answer: { value: 'A&B=1' }, DetailHtml: detail },
      { QuestionType: 'Single', Answer: 1, DetailHtml: detail },
      { QuestionType: 'Single', Answer: 'A', DetailHtml: '<label><input type="radio" value="A">One</label><label><input type="radio" value="A">Two</label>' }
    ];
    return rows.map(row => ({ resolved: __test.reconcilePlatformAnswer(row), row }));
  });
  for (const index of [0, 1, 3, 4, 5, 6]) {
    assert.equal(result[index].resolved, true, String(index));
    assert.equal(result[index].row.NeedsAI, false);
    assert.equal(result[index].row.IsAIAnswer, false);
  }
  assert.match(result[0].row.SniffedAnswer, /First exact option/);
  assert.match(result[1].row.SniffedAnswer, /First exact option[\s\S]*Second exact option/);
  assert.match(result[3].row.SniffedAnswer, /False label/);
  assert.match(result[4].row.SniffedAnswer, /false/);
  assert.match(result[5].row.SniffedAnswer, /0/);
  assert.equal(result[6].row.SniffedAnswer, '\r\nclass PlatformReference {}\r\n');
  assert.equal(result[6].row.AnswerSource, 'platform-reference');
  for (const index of [2, 7, 8, 9]) {
    assert.equal(result[index].resolved, false, String(index));
    assert.equal(result[index].row.PlatformAnswerUnresolved, true);
    assert.equal(result[index].row.NeedsAI, false);
    assert.equal(result[index].row.SniffedAnswer, undefined);
  }
}));

test('platform direct choices and subjective answers bypass answer submissions and AI', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.keyManager.updateKeys('synthetic-platform-priority-key');
    __test.state.stage = 2;
    __test.setData([
      { GlobalUID: 0, TopicGuid: 'direct-choice', QuestionType: 'Single', Title: 'Direct choice', Answer: 'A', s2_done: false },
      { GlobalUID: 1, TopicGuid: 'direct-blank', QuestionType: 'Blank', Title: 'Direct blank', Answer: '<literal> & 0', s2_done: false },
      { GlobalUID: 2, TopicGuid: 'direct-program', QuestionType: 'Program', Title: 'Direct program', PlainExample: 'class Platform {}', s2_done: false }
    ]);
    __respond = ({ url, type }) => {
      if (type === 'post') throw new Error('A direct platform answer must not be submitted again');
      if (!url.includes('direct-choice')) throw new Error('Known subjective platform answers need no detail fallback');
      return '<form><input name="Guid" type="hidden" value="direct-choice"><label><input type="radio" value="A">Platform option A</label><label><input type="radio" value="B">Option B</label></form>';
    };
    let aiCalls = 0; __fetch = async () => { aiCalls++; return __aiResponse(); };
    await __test.runStage2(); await __test.runStage3();
    return { rows: __test.data, aiCalls, submissions: __ajaxCalls.filter(call => call.method === 'post').length, paused: __test.state.isPaused };
  });
  assert.equal(result.aiCalls, 0);
  assert.equal(result.submissions, 0);
  assert.equal(result.paused, false);
  assert.ok(result.rows.every(row => row.s2_done && row.NeedsAI === false));
  assert.match(result.rows[1].SniffedAnswer, /&lt;literal&gt; &amp; 0/);
  assert.equal(result.rows[2].AnswerSource, 'platform-reference');
}));

test('AI refuses truncated, filtered, tool, refusal, blank and malformed responses and releases its lease', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __setSettings({ aiConcurrency: 1, perKeyConcurrency: 1, aiAttempts: 1, aiRetryDelayMs: 0 });
    __test.keyManager.updateKeys('synthetic-invalid-response-key');
    const cases = [
      ['length', { choices: [{ finish_reason: 'length', message: { content: 'Truncated code' } }] }],
      ['content_filter', { choices: [{ finish_reason: 'content_filter', message: { content: 'Filtered response' } }] }],
      ['tool_calls', { choices: [{ finish_reason: 'tool_calls', message: { content: 'Tool request', tool_calls: [{ id: 'synthetic-tool' }] } }] }],
      ['refusal', { choices: [{ finish_reason: 'stop', message: { content: 'Refused', refusal: 'Synthetic refusal marker' } }] }],
      ['blank', { choices: [{ finish_reason: 'stop', message: { content: ' \n\t ' } }] }],
      ['missing_choices', { result: 'not a completion' }],
      ['missing_finish_reason', { choices: [{ message: { content: 'Missing completion boundary' } }] }],
      ['invalid_json', null]
    ];
    const results = [];
    for (const [name, response] of cases) {
      __test.state.stage = 3; __test.state.isPaused = false;
      __test.setData([{ GlobalUID: 0, TopicGuid: 'response-' + name, QuestionType: 'Blank', DetailHtml: '<p>Synthetic bad response fixture</p>',
        PlatformDetailChecked: true, s2_done: true, s3_done: false, NeedsAI: true, imgUrls: [] }]);
      __fetch = async () => response ? Response.json(response) : new Response('synthetic invalid JSON', { headers: { 'Content-Type': 'application/json' } });
      await __test.runStage3();
      results.push({ name, completed: __test.data[0].s3_done, answer: __test.data[0].SniffedAnswer, paused: __test.state.isPaused, stage: __test.state.stage });
    }
    __test.state.isPaused = false;
    __fetch = async () => __aiResponse('Recovered on the same key');
    await Promise.race([__test.runStage3(), new Promise((_, reject) => setTimeout(() => reject(new Error('A failed response leaked a key lease')), 2000))]);
    return { results, recovered: __test.data[0] };
  });
  for (const attempt of result.results) {
    assert.notEqual(attempt.completed, true, attempt.name);
    assert.ok(!attempt.answer, attempt.name);
    assert.equal(attempt.paused, true, attempt.name);
    assert.equal(attempt.stage, 3, attempt.name);
  }
  assert.equal(result.recovered.SniffedAnswer, 'Recovered on the same key');
  assert.equal(result.recovered.s3_done, true);
}));

test('AI rate limiting cools down the pool without declaring keys exhausted', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __setSettings({ aiConcurrency: 1, perKeyConcurrency: 1, aiAttempts: 3, aiRetryDelayMs: 0 });
    __test.keyManager.updateKeys('synthetic-rate-key-1\nsynthetic-rate-key-2');
    __test.state.stage = 3;
    __test.setData([{ GlobalUID: 0, TopicGuid: 'rate-fixture', QuestionType: 'Blank', DetailHtml: '<p>Rate-limit fixture</p>',
      PlatformDetailChecked: true, s2_done: true, s3_done: false, NeedsAI: true, imgUrls: [] }]);
    const times = [];
    __fetch = async () => { times.push(performance.now()); return times.length === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '1' } }) : __aiResponse('Rate recovered'); };
    await __test.runStage3();
    return { attempts: times.length, waitMs: times[1] - times[0], paused: __test.state.isPaused, outOfKeys: __test.state.outOfKeys, row: __test.data[0] };
  });
  assert.equal(result.attempts, 2);
  assert.ok(result.waitMs >= 900, String(result.waitMs));
  assert.equal(result.paused, false);
  assert.equal(result.outOfKeys, false);
  assert.equal(result.row.SniffedAnswer, 'Rate recovered');
}));

test('AI network failure releases the per-key lease so a paused task can resume', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __setSettings({ aiConcurrency: 1, perKeyConcurrency: 1, aiAttempts: 1, aiRetryDelayMs: 0 });
    __test.keyManager.updateKeys('synthetic-network-key'); __test.state.stage = 3;
    __test.setData([{ GlobalUID: 0, TopicGuid: 'network-fixture', QuestionType: 'Blank', DetailHtml: '<p>Network failure fixture</p>',
      PlatformDetailChecked: true, s2_done: true, s3_done: false, NeedsAI: true, imgUrls: [] }]);
    __fetch = async () => { throw new TypeError('Synthetic transport failure'); };
    await __test.runStage3();
    const failed = { paused: __test.state.isPaused, done: __test.data[0].s3_done };
    __test.state.isPaused = false; __fetch = async () => __aiResponse('Network recovered');
    await Promise.race([__test.runStage3(), new Promise((_, reject) => setTimeout(() => reject(new Error('Network failure leaked a lease')), 2000))]);
    return { failed, row: __test.data[0], paused: __test.state.isPaused };
  });
  assert.equal(result.failed.paused, true);
  assert.notEqual(result.failed.done, true);
  assert.equal(result.row.SniffedAnswer, 'Network recovered');
  assert.equal(result.paused, false);
}));

test('successful AI usage and settings survive ZIP export without credentials or repeated billing', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    const secret = 'synthetic-export-secret-never-persist';
    __test.keyManager.updateKeys(secret); __test.state.stage = 3;
    __test.setData([{ GlobalUID: 0, TopicGuid: 'usage', QuestionType: 'Blank', DetailHtml: '<p>Usage fixture</p>', s2_done: true,
      PlatformDetailChecked: true, s3_done: false, NeedsAI: true, imgUrls: [] }]);
    let calls = 0;
    __fetch = async () => { calls++; return __aiResponse('Complete synthetic answer', { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, prompt_cache_hit_tokens: 3, prompt_cache_miss_tokens: 8 }); };
    await __test.runStage3(); __test.state.stage = 3; await __test.runStage3();
    await __test.buildZipAndDownload(false);
    const zip = __zips.at(-1), members = await Promise.all(Object.values(zip.files).filter(file => !file.dir).map(file => file.async('string')));
    return { calls, row: __test.data[0], report: JSON.parse(await zip.file('extraction-report.json').async('string')),
      state: JSON.parse(await zip.file('state.json').async('string')), leaked: members.join('').includes(secret) || document.querySelector('#bistu-extractor-panel-log').textContent.includes(secret) };
  });
  assert.equal(result.calls, 1);
  assert.equal(result.leaked, false);
  assert.equal(result.row.AnswerSource, 'ai');
  assert.equal(result.row.AIInfo.model, 'deepseek-flash');
  assert.deepEqual(result.report.aiUsage, { requests: 1, successfulResponses: 1, promptTokens: 11, completionTokens: 7, totalTokens: 18, cacheHitTokens: 3, cacheMissTokens: 8 });
  assert.deepEqual(result.state.globalState.aiUsage, result.report.aiUsage);
  assert.equal(result.report.settings.aiConcurrency, 6);
  assert.deepEqual(result.state.globalState.settings, result.report.settings);
}));

test('vision uses the stricter 4096-pixel limit at exactly fifteen images and preserves source bytes', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __test.keyManager.updateKeys('synthetic-boundary-key'); __test.state.stage = 3;
    const canvas = document.createElement('canvas'); canvas.width = 4600; canvas.height = 2;
    canvas.getContext('2d').fillRect(0, 0, 4600, 2);
    const buffer = await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer();
    const entries = [], rows = [14, 15].map((count, GlobalUID) => {
      const urls = Array.from({ length: count }, (_, index) => 'http://fixture.test/boundary-' + GlobalUID + '-' + index + '.png');
      urls.forEach(url => entries.push([url, { filename: 'img_' + (entries.length + 1) + '.png', buffer, downloaded: true }]));
      return { GlobalUID, TopicGuid: 'boundary-' + count, QuestionType: 'Blank', DetailHtml: '<p>Boundary ' + count + '</p>', s2_done: true,
        PlatformDetailChecked: true, s3_done: false, NeedsAI: true, imgUrls: urls };
    });
    __test.setImages(entries); __test.setData(rows);
    const dimensions = [];
    __fetch = async (_, options) => {
      const parts = JSON.parse(options.body).messages.find(message => message.role === 'user').content.filter(part => part.type === 'image_url');
      const image = new Image(); image.src = parts[0].image_url.url; await image.decode();
      dimensions.push({ count: parts.length, width: image.naturalWidth }); return __aiResponse();
    };
    await __test.runStage3();
    return { dimensions: dimensions.sort((a,b) => a.count-b.count), complete: __test.data.every(row => row.s3_done),
      preserved: Array.from(__test.images.values()).every(image => image.buffer === buffer) };
  });
  assert.deepEqual(result.dimensions, [{ count: 14, width: 4600 }, { count: 15, width: 4096 }]);
  assert.equal(result.complete, true); assert.equal(result.preserved, true);
}));

test('snapshot settings can be restored or retained and failed import rolls back without unhandled errors', () => withPage(async page => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(() => { window.__importBuilds = 0; __test.setBuilder(async () => { window.__importBuilds++; }); });
  const state = snapshot(); state.globalState.stage = 5;
  state.globalState.settings = { ...(await page.evaluate(() => __test.getSettings())), aiConcurrency: 2 };
  await page.evaluate(() => __setSettings({ aiConcurrency: 4, resumeSettings: 'snapshot' }));
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => __importBuilds === 1 && !document.querySelector('#bistu-import-btn').disabled);
  assert.equal(await page.evaluate(() => __test.getSettings().aiConcurrency), 2);
  await page.evaluate(() => __setSettings({ aiConcurrency: 4, resumeSettings: 'current' }));
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => __importBuilds === 2 && !document.querySelector('#bistu-import-btn').disabled);
  assert.equal(await page.evaluate(() => __test.getSettings().aiConcurrency), 4);
  await page.evaluate(() => __setSettings({ resumeSettings: 'snapshot' }));
  state.globalState.settings.aiConcurrency = 0;
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => document.querySelector('#bistu-extractor-panel-log').textContent.includes('解析 ZIP 异常') && !document.querySelector('#bistu-import-btn').disabled);
  assert.equal(await page.evaluate(() => __test.getSettings().aiConcurrency), 4);
  assert.equal(await page.evaluate(() => __importBuilds), 2);
  await page.evaluate(() => { document.querySelector('#bistu-extractor-panel-log').textContent = ''; __setSettings({ aiConcurrency: '' }); });
  await uploadSnapshot(page, state);
  await page.waitForFunction(() => document.querySelector('#bistu-extractor-panel-log').textContent.includes('解析 ZIP 异常') && !document.querySelector('#bistu-import-btn').disabled);
  assert.deepEqual(errors, []);
  assert.equal(await page.locator('#bistu-start-btn').isEnabled(), true);
}));

test('an AI timeout aborts the request and frees its only lease for resume', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __setSettings({ aiConcurrency: 1, perKeyConcurrency: 1, aiAttempts: 1, aiTimeoutMs: 1000, aiRetryDelayMs: 0 });
    __test.keyManager.updateKeys('synthetic-timeout-key'); __test.state.stage = 3;
    __test.setData([{ GlobalUID: 0, TopicGuid: 'timeout', QuestionType: 'Blank', DetailHtml: '<p>Timeout fixture</p>', s2_done: true,
      PlatformDetailChecked: true, s3_done: false, NeedsAI: true, imgUrls: [] }]);
    let aborted = false;
    __fetch = (_, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Synthetic timeout', 'AbortError')); }));
    await __test.runStage3();
    const failed = { paused: __test.state.isPaused, done: __test.data[0].s3_done };
    __test.state.isPaused = false; __fetch = async () => __aiResponse('After timeout');
    await Promise.race([__test.runStage3(), new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout leaked its lease')), 2000))]);
    return { aborted, failed, row: __test.data[0] };
  });
  assert.equal(result.aborted, true); assert.equal(result.failed.paused, true);
  assert.notEqual(result.failed.done, true); assert.equal(result.row.SniffedAnswer, 'After timeout');
}));

test('all settings lock while the engine runs and unlock after its pause completes', () => withPage(async page => {
  await page.evaluate(() => {
    __test.state.stage = 3;
    __test.setEngineStage(3, async () => { window.__settingsEntered = true; await new Promise(resolve => { window.__releaseSettings = resolve; }); __test.state.isPaused = true; });
    __test.setBuilder(async () => {});
    window.__settingsRun = __test.runEngine();
  });
  await page.waitForFunction(() => window.__settingsEntered);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#bistu-settings input, #bistu-settings select, #bistu-settings button')].every(input => input.disabled)), true);
  await page.evaluate(async () => { __releaseSettings(); await __settingsRun; });
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#bistu-settings input, #bistu-settings select, #bistu-settings button')].every(input => !input.disabled)), true);
}));

test('resume replaces the stale paused status immediately before a pending stage responds', () => withPage(async page => {
  const waiting = await page.evaluate(() => {
    __test.state.stage = 3; __test.state.isPaused = true;
    document.querySelector('#bistu-global-status').innerText = '⏸️ 任务已暂停 (支持续传)';
    __test.setBuilder(async () => { window.__resumeStatusPackaged = true; });
    __test.setEngineStage(3, async () => {
      window.__resumeStatusEntered = true;
      await new Promise(resolve => { window.__releaseResumeStatus = resolve; });
      __test.state.isPaused = true;
    });
    document.querySelector('#bistu-pause-btn').click();
    return { entered: window.__resumeStatusEntered, paused: __test.state.isPaused, status: document.querySelector('#bistu-global-status').innerText };
  });
  assert.equal(waiting.entered, true);
  assert.equal(waiting.paused, false);
  assert.match(waiting.status, /AI 大模型作答中/);
  assert.doesNotMatch(waiting.status, /暂停|挂起/);
  await page.evaluate(() => __releaseResumeStatus());
  await page.waitForFunction(() => window.__resumeStatusPackaged && !document.querySelector('#bistu-pause-btn').disabled);
}));
// Append to tests/extractor.test.cjs. Uses its existing assert, withPage,
// uploadSnapshot, and browser harness helpers. All data and responses are synthetic.

test('default six-way list reads preserve page order and stable IDs with seven-row pages', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    document.querySelector('#select_QuestionType').innerHTML = '<option value="1">单选题</option>';
    __test.initializePlatformVariables();
    __test.state.isPaused = false;
    __setSettings({ pageSize: 7, platformDelayMs: 0, platformAttempts: 1 });
    const configuredConcurrency = Number(document.querySelector('#bistu-setting-listConcurrency').value);
    let active = 0, maximum = 0;
    const completed = [], requestedSizes = [];
    __respond = async ({ url, data }) => {
      if (!url.includes('GetTopicData')) throw new Error('Unexpected non-list request');
      const pageIndex = Number(data.pageIndex), pageSize = Number(data.pageSize);
      requestedSizes.push(pageSize);
      active++; maximum = Math.max(maximum, active);
      try {
        // Page 7 finishes before page 2, but GlobalUID must follow page order.
        await new Promise(resolve => setTimeout(resolve, pageIndex === 1 ? 0 : Math.max(1, 8 - pageIndex) * 5));
        const start = (pageIndex - 1) * pageSize;
        completed.push(pageIndex);
        return { Total: 51, DataList: Array.from({ length: Math.max(0, Math.min(pageSize, 51 - start)) }, (_, offset) => ({
          QuestionType: 'Single', TopicGuid: 'parallel-fixture-' + (start + offset), Title: 'Synthetic parallel fixture'
        })) };
      } finally { active--; }
    };
    await __test.runStage1();
    return { configuredConcurrency, maximum, completed, requestedSizes,
      rows: __test.data.map(row => ({ id: row.GlobalUID, guid: row.TopicGuid })),
      stage: __test.state.stage, pageSize: __test.state.listProgress.pageSize, expected: __test.state.sourceTotals.Single };
  });
  assert.equal(result.configuredConcurrency, 6);
  assert.equal(result.maximum, 6);
  assert.ok(result.completed.indexOf(7) < result.completed.indexOf(2));
  assert.deepEqual(new Set(result.requestedSizes), new Set([7]));
  assert.equal(result.rows.length, 51);
  assert.deepEqual(result.rows, Array.from({ length: 51 }, (_, id) => ({ id, guid: 'parallel-fixture-' + id })));
  assert.equal(result.stage, 2);
  assert.equal(result.pageSize, 7);
  assert.equal(result.expected, 51);
}));

test('a failed parallel page saves a contiguous seven-row cursor and ZIP import ignores a changed page-size control', () => withPage(async page => {
  const interrupted = await page.evaluate(async () => {
    document.querySelector('#select_QuestionType').innerHTML = '<option value="1">单选题</option>';
    __test.initializePlatformVariables();
    __test.state.isPaused = false;
    __setSettings({ pageSize: 7, platformDelayMs: 0, platformAttempts: 1 });
    window.__failThirdPage = true;
    __respond = async ({ url, data }) => {
      if (!url.includes('GetTopicData')) throw new Error('Unexpected non-list request');
      const pageIndex = Number(data.pageIndex), pageSize = Number(data.pageSize);
      await new Promise(resolve => setTimeout(resolve, pageIndex === 3 ? 15 : 1));
      if (window.__failThirdPage && pageIndex === 3) throw new Error('Synthetic page gap');
      const start = (pageIndex - 1) * pageSize;
      return { Total: 35, DataList: Array.from({ length: Math.max(0, Math.min(pageSize, 35 - start)) }, (_, offset) => ({
        QuestionType: 'Single', TopicGuid: 'resume-seven-' + (start + offset), Title: 'Synthetic resume fixture'
      })) };
    };
    await __test.runEngine();
    return { snapshot: JSON.parse(await __zips.at(-1).file('state.json').async('string')),
      report: JSON.parse(await __zips.at(-1).file('extraction-report.json').async('string')) };
  });
  assert.equal(interrupted.report.complete, false);
  assert.equal(interrupted.snapshot.globalState.isPaused, true);
  assert.equal(interrupted.snapshot.globalState.stage, 1);
  assert.equal(interrupted.snapshot.globalState.listProgress.pageSize, 7);
  assert.equal(interrupted.snapshot.globalState.listProgress.pageIndex, 3);
  assert.equal(interrupted.snapshot.allData.length, 14);
  await page.evaluate(() => {
    window.__failThirdPage = false;
    window.__resumeCallOffset = __ajaxCalls.length;
    const originalStage1 = __test.runStage1;
    // Import restores its saved settings before starting the engine. Change the
    // control after that restoration to exercise the immutable paging cursor.
    __test.setEngineStage(1, async () => {
      __setSettings({ pageSize: 10 });
      await originalStage1();
    });
    __test.setEngineStage(2, async () => { window.__resumedListComplete = true; __test.state.isPaused = true; });
  });
  await uploadSnapshot(page, interrupted.snapshot);
  await page.waitForFunction(() => window.__resumedListComplete && __zips.length >= 2 && !document.querySelector('#bistu-import-btn').disabled);
  const resumed = await page.evaluate(() => ({
    pageSize: __test.state.listProgress.pageSize,
    controlPageSize: Number(document.querySelector('#bistu-setting-pageSize').value),
    calls: __ajaxCalls.slice(__resumeCallOffset).map(call => ({ page: Number(call.data.pageIndex), size: Number(call.data.pageSize) })),
    rows: __test.data.map(row => ({ id: row.GlobalUID, guid: row.TopicGuid }))
  }));
  assert.equal(resumed.controlPageSize, 10);
  assert.equal(resumed.pageSize, 7);
  assert.deepEqual(resumed.calls.map(call => call.page), [3, 4, 5]);
  assert.ok(resumed.calls.every(call => call.size === 7));
  assert.deepEqual(resumed.rows, Array.from({ length: 35 }, (_, id) => ({ id, guid: 'resume-seven-' + id })));
}));

test('subjective questions inspect official details before AI and unresolved official answers never reach the API', () => withPage(async page => {
  const result = await page.evaluate(async () => {
    __setSettings({ platformDelayMs: 0, aiRequestIntervalMs: 0, aiAttempts: 1, perKeyConcurrency: 6 });
    __test.keyManager.updateKeys('synthetic-key-never-sent-to-network');
    __test.state.stage = 2;
    __test.setData([
      { QuestionType: 'Blank', Answer: [], Title: 'Synthetic blank prompt', Requirement: '<p>Preserve blank requirement</p>' },
      { QuestionType: 'Program', Answer: [], Title: 'Synthetic program prompt', Requirement: '<pre>Preserve program requirement: x &lt; 2</pre>' },
      { QuestionType: 'Blank', Answer: { opaque: 'Do not guess this field' }, Title: 'Synthetic unresolved prompt' },
      { QuestionType: 'Program', PlainExample: 'class OfficialFixture {}', Title: 'Synthetic official program', SniffedAnswer: 'old synthetic AI', IsAIAnswer: true, AnswerSource: 'ai', s3_done: true },
      { QuestionType: 'Single', Answer: ['A'], Title: 'Synthetic direct choice' }
    ].map((row, GlobalUID) => ({ ...row, GlobalUID, TopicGuid: 'subjective-fixture-' + GlobalUID, imgUrls: [], s2_done: false })));
    const aiCalls = [];
    __fetch = async (url, options) => {
      if (!String(url).includes('api.deepseek.com/chat/completions')) throw new Error('Unexpected external resource request');
      aiCalls.push(JSON.parse(options.body));
      return Response.json({ id: 'synthetic-response', choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic completed answer' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    };
    __respond = ({ url }) => {
      if (!url.includes('JumpToPracticeTopic')) throw new Error('Known platform answers must not submit guesses');
      const guid = new URL(url).searchParams.get('Guid');
      const index = Number(guid.slice('subjective-fixture-'.length));
      const row = __test.data[index];
      if (index === 3) throw new Error('PlainExample must not require an extra detail request');
      const controls = row.QuestionType === 'Blank'
        ? '<input type="text" name="UserSelect" value="synthetic-input-draft"><textarea name="UserSelect">synthetic-textarea-draft</textarea><select><option>synthetic-select-draft</option></select>'
        : row.QuestionType === 'Single' ? '<label><input type="radio" value="A">Official choice A</label><label><input type="radio" value="B">Choice B</label>' : '';
      const image = index === 2 ? '<img src="/synthetic/unresolved-picture.png" alt="Synthetic diagram">' : '';
      // The live platform can label Blank pages as multiple-choice practice.
      return `<html><head><title>多选题练习</title></head><body><div class="panel"><div class="panel-heading">多选题练习</div><div class="panel-body">${row.Title}${image}</div><ul class="list-group">${controls}</ul><input id="hidden_TopicGuid" value="${guid}"></div></body></html>`;
    };
    await __test.runStage2();
    const beforeAI = __test.data.map(row => ({ ...row }));
    const detailCalls = __ajaxCalls.map(call => ({ method: call.method, guid: new URL(call.url).searchParams.get('Guid') }));
    await __test.runStage3();
    const offline = new DOMParser().parseFromString(__test.generateOfflineHtml(true), 'text/html');
    const blankDetail = offline.querySelector('.detail-box');
    return { beforeAI, afterAI: __test.data, detailCalls, aiCalls, images: Array.from(__test.images.keys()), stage: __test.state.stage, paused: __test.state.isPaused,
      offlineBlankText: blankDetail.textContent, offlineBlankControls: blankDetail.querySelectorAll('input,textarea,select').length };
  });
  assert.equal(result.paused, false);
  assert.equal(result.stage, 4);
  assert.deepEqual(result.detailCalls.map(call => call.guid).sort(), ['subjective-fixture-0', 'subjective-fixture-1', 'subjective-fixture-2', 'subjective-fixture-4']);
  assert.ok(result.detailCalls.every(call => call.method === 'get'));
  assert.equal(result.beforeAI[0].PlatformDetailChecked, true);
  assert.equal(result.beforeAI[0].BlankCount, 2);
  assert.equal((result.offlineBlankText.match(/________/g) || []).length, 2);
  assert.equal(result.offlineBlankControls, 0);
  assert.doesNotMatch(result.offlineBlankText, /synthetic-(input|textarea)-draft/);
  assert.match(result.beforeAI[0].DetailHtml, /Synthetic blank prompt/);
  assert.match(result.beforeAI[0].DetailHtml, /Preserve blank requirement/);
  assert.equal(result.beforeAI[1].PlatformDetailChecked, true);
  assert.match(result.beforeAI[1].DetailHtml, /Preserve program requirement/);
  assert.equal(result.beforeAI[2].PlatformAnswerUnresolved, true);
  assert.equal(result.beforeAI[2].NeedsAI, false);
  assert.match(result.beforeAI[2].ExtractionWarning, /无法明确解析/);
  assert.match(result.beforeAI[2].DetailHtml, /data-original="http:\/\/fixture\.test\/synthetic\/unresolved-picture\.png"/);
  assert.deepEqual(result.images, ['http://fixture.test/synthetic/unresolved-picture.png']);
  assert.equal(result.beforeAI[3].SniffedAnswer, 'class OfficialFixture {}');
  assert.equal(result.beforeAI[3].AnswerSource, 'platform-reference');
  assert.equal(result.beforeAI[3].IsAIAnswer, false);
  assert.equal(result.beforeAI[4].AnswerSource, 'platform-answer');
  assert.match(result.beforeAI[4].SniffedAnswer, /Official choice A/);
  assert.equal(result.aiCalls.length, 2);
  const prompts = result.aiCalls.map(call => JSON.stringify(call.messages));
  assert.ok(prompts.every(text => !/synthetic-(input|textarea|select)-draft/.test(text)));
  assert.ok(prompts.some(text => text.includes('Synthetic blank prompt')));
  assert.ok(prompts.some(text => text.includes('Synthetic program prompt')));
  assert.ok(prompts.every(text => !text.includes('Synthetic unresolved prompt') && !text.includes('Synthetic official program') && !text.includes('Synthetic direct choice')));
  assert.equal(result.afterAI[0].IsAIAnswer, true);
  assert.equal(result.afterAI[1].IsAIAnswer, true);
  assert.equal(result.afterAI[2].PlatformAnswerUnresolved, true);
  assert.notEqual(result.afterAI[2].IsAIAnswer, true);
  assert.equal(result.afterAI[3].AnswerSource, 'platform-reference');
  assert.equal(result.afterAI[4].AnswerSource, 'platform-answer');
}));

async function settleReader(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (let index=0;index<6;index++) await new Promise(requestAnimationFrame);
  });
}

async function assertReaderGeometry(page, label) {
  await settleReader(page);
  const result=await page.evaluate(() => {
    const last=[...document.querySelectorAll('.topic')].filter(card=>!card.classList.contains('hidden')).at(-1);
    const measure=()=>({height:document.documentElement.scrollHeight,lastTop:last ? last.getBoundingClientRect().top+scrollY : 0,lastHeight:last ? last.getBoundingClientRect().height : 0});
    const cached=measure(), override=document.createElement('style');
    override.textContent='.topic:not(.hidden){content-visibility:visible!important;contain-intrinsic-block-size:none!important}';
    document.head.append(override);
    const actual=measure(); override.remove();
    return {cached,actual};
  });
  for (const key of ['height','lastTop','lastHeight']) assert.ok(Math.abs(result.cached[key]-result.actual[key])<=2,label+': '+JSON.stringify(result));
  return result.cached;
}

function geometryRows(count=60) {
  return Array.from({length:count},(_,GlobalUID)=>({GlobalUID,QuestionType:'Program',ChapterName:GlobalUID%2?'Group B':'Group A',DegreeLevel:'一般',
    DetailHtml:'<p>'+(GlobalUID===count-1?'SyntheticGeometryLastToken':'Synthetic geometry prompt '+GlobalUID)+'</p>',
    SniffedAnswer:Array.from({length:35},(_,line)=>'// Synthetic line '+line+' '+('readable content '.repeat(8))).join('\n'),AnswerSource:'platform-reference'}));
}

test('reader geometry stays exact through answers, filters, viewport changes and print transitions',()=>withPage(async page=>{
  await page.setViewportSize({width:1400,height:900});
  await renderStudyFixture(page,geometryRows());
  const full=await assertReaderGeometry(page,'initial');
  await page.locator('#toggleAnsBtn').click();
  const hidden=await assertReaderGeometry(page,'all answers hidden');
  assert.ok(full.height-hidden.height>1000);
  await page.locator('#toggleAnsBtn').click();
  const restored=await assertReaderGeometry(page,'all answers restored');
  assert.ok(Math.abs(restored.height-full.height)<=2);
  await page.locator('.answer-toggle').first().click();
  await assertReaderGeometry(page,'one answer hidden');
  await page.locator('#chapterFilter').selectOption('Group B');
  await assertReaderGeometry(page,'filtered half');
  assert.equal(await page.locator('.topic:not(.hidden)').count(),30);
  assert.equal(await page.locator('.topic.hidden').evaluateAll(cards=>cards.every(card=>card.getBoundingClientRect().height===0&&card.getAttribute('aria-hidden')==='true')),true);
  await page.locator('#resetFilters').click();
  await assertReaderGeometry(page,'filter restored');
  for(const viewport of [{width:1400,height:520},{width:980,height:700},{width:390,height:844}]) {
    await page.setViewportSize(viewport); await assertReaderGeometry(page,'viewport '+JSON.stringify(viewport));
  }
  await page.evaluate(()=>window.dispatchEvent(new Event('beforeprint')));
  await page.emulateMedia({media:'print'});
  await assertReaderGeometry(page,'print');
  assert.equal(await page.locator('.topic').evaluateAll(cards=>cards.every(card=>getComputedStyle(card).contentVisibility==='visible')),true);
  await page.emulateMedia({media:'screen'});
  await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));
  await assertReaderGeometry(page,'after print');
  const found=await page.evaluate(()=>{scrollTo(0,0);getSelection().removeAllRanges();return window.find('SyntheticGeometryLastToken',false,false,true);});
  assert.equal(found,true);
  await page.locator('.topic').last().scrollIntoViewIfNeeded();
  assert.match(await page.locator('.topic').last().textContent(),/SyntheticGeometryLastToken/);
}));

test('late unknown image loads and failed-image retries update distant question positions',()=>withPage(async page=>{
  const fixture=await decodedImageFixture(page),rows=geometryRows();
  rows[20].DetailHtml+='<img src="images/img_101.png" alt="Late synthetic diagram">';
  rows[30].DetailHtml+='<img src="images/img_102.png" alt="Retry synthetic diagram">';
  const html=await page.evaluate(data=>{__test.setData(data);return __test.generateOfflineHtml(true);},rows);
  let releaseLate;const gate=new Promise(resolve=>{releaseLate=resolve;});let attempts=0;
  await page.route('**/images/img_101.png',async route=>{await gate;await route.fulfill({contentType:'image/png',body:Buffer.from(fixture.png,'base64')});});
  await page.route('**/images/img_102.png*',route=>++attempts===1?route.fulfill({status:404,body:'Synthetic temporary failure'}):route.fulfill({contentType:'image/png',body:Buffer.from(fixture.png,'base64')}));
  try {
    await page.setContent(html,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>document.querySelectorAll('.image-retry').length===1);
    const before=await assertReaderGeometry(page,'image pending and failed');
    releaseLate();
    await page.waitForFunction(()=>document.querySelector('img[alt="Late synthetic diagram"]').naturalWidth===400);
    const loaded=await assertReaderGeometry(page,'late image loaded');
    assert.ok(loaded.height>before.height+100);
    await page.locator('.image-retry').click();
    await page.waitForFunction(()=>document.querySelector('img[alt="Retry synthetic diagram"]')?.naturalWidth===400);
    await assertReaderGeometry(page,'image retry restored');
    assert.equal(attempts,2);assert.equal(await page.locator('.img-failed').count(),0);
  } finally {releaseLate();}
}));

test('Safari and iOS Chrome readers retain ordinary visible layout and last-question access',async()=>{
  const agents=[
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1'
  ];
  for(const userAgent of agents) {
    const h=await createHarness(browser,undefined,undefined,{userAgent});
    try {
      await renderStudyFixture(h.page,geometryRows(20));await settleReader(h.page);
      assert.equal(await h.page.locator('.topic').evaluateAll(cards=>cards.every(card=>getComputedStyle(card).contentVisibility==='visible')),true);
      await assertReaderGeometry(h.page,'ordinary reader layout');
      await h.page.locator('.topic').last().scrollIntoViewIfNeeded();
      assert.match(await h.page.locator('.topic').last().textContent(),/SyntheticGeometryLastToken/);
    } finally {await h.close();}
  }
});

test('HTTP background prefetch and touch printing bound cold offscreen image requests',async()=>{
  for(const touch of [false,true]) {
    const h=await createHarness(browser,undefined,undefined,touch?{viewport:{width:390,height:844},hasTouch:true,isMobile:true}:{viewport:{width:1400,height:900}});
    let unblockAll=false;const held=[];let active=0,peak=0,requested=0;
    try {
      const fixture=await printImageQueueFixture(h.page,12);
      const html=await h.page.evaluate(()=>{
        __test.data[0].DetailHtml='<div style="height:30000px">Synthetic far-offscreen images</div>'+__test.data[0].DetailHtml;
        return __test.generateOfflineHtml(true);
      });
      await h.page.route('**/images/*.png',async route=>{
        requested++;active++;peak=Math.max(peak,active);
        if(!unblockAll) await new Promise(resolve=>held.push(resolve));
        active--;await route.fulfill({contentType:'image/png',body:Buffer.from(fixture.png,'base64')});
      });
      await h.page.setContent(html,{waitUntil:'domcontentloaded'});await settleReader(h.page);await h.page.waitForTimeout(100);
      assert.equal(await h.page.evaluate(()=>matchMedia('(pointer:coarse)').matches),touch);
      if(touch) assert.equal(requested,0,'far touch images must remain deferred');
      else assert.equal(requested,2,'desktop warming may fetch only two extra far images');
      await h.page.evaluate(()=>{window.__policyPrints=[];window.print=()=>__policyPrints.push([...document.querySelectorAll('.detail-box img')].every(img=>img.complete&&img.naturalWidth===400));});
      if(touch) await h.page.locator('#printBtn').click();
      for(let completed=0;completed<12;) {
        for(let retry=0;held.length===0&&retry<100;retry++) await h.page.waitForTimeout(10);
        assert.ok(held.length>0&&held.length<=2,'bounded pending image batch');
        const ready=held.splice(0);completed+=ready.length;ready.forEach(resolve=>resolve());
        if(completed<12) assert.equal(await h.page.evaluate(()=>__policyPrints.length),0);
      }
      await h.page.waitForFunction(()=>[...document.querySelectorAll('.detail-box img')].every(img=>img.complete&&img.naturalWidth===400));
      assert.equal(requested,12);assert.ok(peak<=2,'peak image requests: '+peak);
      if(touch) {await h.page.waitForFunction(()=>__policyPrints.length===1);assert.deepEqual(await h.page.evaluate(()=>__policyPrints),[true]);}
    } finally {unblockAll=true;held.splice(0).forEach(resolve=>resolve());await h.close();}
  }
});

async function assertHorizontalContentReachable(page, marker) {
  const target=page.getByText(marker,{exact:true});
  const detail=target.locator('xpath=ancestor::div[contains(concat(" ",normalize-space(@class)," ")," detail-box ")]');
  const result=await detail.evaluate(element=>{
    element.scrollLeft=0;
    const width=element.clientWidth,content=element.scrollWidth;
    element.scrollLeft=content;
    return {width,content,left:element.scrollLeft};
  });
  assert.ok(result.content>result.width+10,marker+' must actually overflow');
  assert.ok(result.left>10,marker+' must remain horizontally scrollable');
  const bounds=await detail.boundingBox(),end=await target.boundingBox();
  assert.ok(end.x+end.width<=bounds.x+bounds.width+2 && end.x+end.width>bounds.x,marker+' rightmost text is reachable');
}

test('wide tables, preformatted text, nowrap and minimum-width content retain horizontal access without page overflow',()=>withPage(async page=>{
  await page.setViewportSize({width:1440,height:900});
  const longText='Synthetic wide content '.repeat(35);
  const details=[
    '<table style="min-width:1900px"><tr><td>Left synthetic table cell</td><td style="text-align:right"><span>WIDE_TABLE_END</span></td></tr></table>',
    '<pre style="white-space:pre">'+longText+'<span>WIDE_PRE_END</span></pre>',
    '<div style="white-space:nowrap">'+longText+'<span>WIDE_NOWRAP_END</span></div>',
    '<div style="min-width:1900px;text-align:right"><span>WIDE_MINIMUM_END</span></div>'
  ];
  await renderStudyFixture(page,details.map((DetailHtml,GlobalUID)=>({GlobalUID,QuestionType:'Blank',ChapterName:'Wide fixture',DetailHtml})));
  await settleReader(page);
  const original=await page.locator('.detail-box').allTextContents();
  for(const marker of ['WIDE_TABLE_END','WIDE_PRE_END','WIDE_NOWRAP_END','WIDE_MINIMUM_END']) await assertHorizontalContentReachable(page,marker);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  assert.deepEqual(await page.locator('.detail-box').allTextContents(),original);
  await assertReaderGeometry(page,'wide rich content');
}));

test('orientation changes preserve newly overflowing content and restore ordinary full-width reading',()=>withPage(async page=>{
  await page.setViewportSize({width:1440,height:900});
  await renderStudyFixture(page,[
    {GlobalUID:0,QuestionType:'Blank',ChapterName:'Orientation fixture',DetailHtml:'<p>Before orientation-sensitive content</p><div style="width:650px;padding:0 16px;text-align:right;white-space:nowrap"><span>ORIENTATION_RIGHT_END</span></div><p>After orientation-sensitive content</p>'},
    {GlobalUID:1,QuestionType:'Blank',ChapterName:'Orientation fixture',DetailHtml:'<p>Next intact question</p>'}
  ]);
  const original=await page.locator('.detail-box').allTextContents();
  const fits=()=>page.locator('.detail-box').first().evaluate(element=>element.scrollWidth<=element.clientWidth+1);
  await settleReader(page);assert.equal(await fits(),true);
  for(const viewport of [{width:390,height:844},{width:844,height:390}]) {
    await page.setViewportSize(viewport);await settleReader(page);
    if(viewport.width===390) await assertHorizontalContentReachable(page,'ORIENTATION_RIGHT_END');
    await assertReaderGeometry(page,'orientation '+viewport.width);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  await page.setViewportSize({width:1440,height:900});await settleReader(page);
  assert.equal(await fits(),true);
  assert.equal(await page.locator('.detail-box').first().evaluate(element=>element.scrollLeft),0);
  assert.deepEqual(await page.locator('.detail-box').allTextContents(),original);
  await assertReaderGeometry(page,'wide orientation restored');
}));

test('percentage widths and padding survive late images and filtered restoration without overlapping later questions',()=>withPage(async page=>{
  const fixture=await decodedImageFixture(page);
  const rows=[
    {GlobalUID:0,QuestionType:'Blank',ChapterName:'Keep',DetailHtml:'<div style="width:100%;padding:18px 24px"><p>Percentage and padding fixture</p><div style="width:100%"><img src="images/img_201.png" alt="Late percentage diagram"></div><p>After the late diagram</p></div>'},
    {GlobalUID:1,QuestionType:'Blank',ChapterName:'Other',DetailHtml:'<p>Following unaffected question</p>'}
  ];
  const html=await page.evaluate(data=>{__test.setData(data);return __test.generateOfflineHtml(true);},rows);
  let release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/images/img_201.png',async route=>{await gate;await route.fulfill({contentType:'image/png',body:Buffer.from(fixture.png,'base64')});});
  try {
    await page.setContent(html,{waitUntil:'domcontentloaded'});await settleReader(page);
    const before=await page.locator('.topic').nth(1).evaluate(card=>card.getBoundingClientRect().top+scrollY);
    release();await page.waitForFunction(()=>document.querySelector('img[alt="Late percentage diagram"]').naturalWidth===400);
    await settleReader(page);
    const loaded=await page.locator('.topic').nth(1).evaluate(card=>card.getBoundingClientRect().top+scrollY);
    assert.ok(loaded>before+100);
    const check=async label=>{
      await assertReaderGeometry(page,label);
      const geometry=await page.evaluate(()=>{
        const cards=[...document.querySelectorAll('.topic:not(.hidden)')];
        const first=cards[0].getBoundingClientRect(),next=cards[1]?.getBoundingClientRect();
        const image=document.querySelector('img[alt="Late percentage diagram"]'),rect=image.getBoundingClientRect(),parent=image.parentElement.getBoundingClientRect();
        return {overlap:next?next.top<first.bottom:false,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,
          imageFits:rect.left>=parent.left-1&&rect.right<=parent.right+1,ratio:rect.width/rect.height};
      });
      assert.equal(geometry.overlap,false);assert.equal(geometry.pageOverflow,false);assert.equal(geometry.imageFits,true);assert.ok(Math.abs(geometry.ratio-2)<0.02);
    };
    await check('loaded percentage image');
    await page.locator('#chapterFilter').selectOption('Other');await settleReader(page);
    assert.equal(await page.locator('.topic').first().evaluate(card=>card.getBoundingClientRect().height),0);
    await page.locator('#resetFilters').click();await settleReader(page);
    assert.ok(Math.abs(await page.locator('.topic').nth(1).evaluate(card=>card.getBoundingClientRect().top+scrollY)-loaded)<=2);
    await check('percentage fixture restored');
    await page.setViewportSize({width:390,height:844});await settleReader(page);await check('narrow percentage image');
    assert.equal(await page.locator('.detail-box img').getAttribute('alt'),'Late percentage diagram');
    assert.match(await page.locator('.detail-box').first().textContent(),/After the late diagram/);
  } finally {release();}
}));
