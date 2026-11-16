'use strict';
// Fully synthetic offline practice. The exporter is Chromium; mobile/WebKit
// checks are isolated viewport contracts, not physical iPhone memory tests.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { launch, createHarness } = require('./harness.cjs');

const profiles = {
  desktop: { viewport: { width: 1280, height: 900 } },
  iphone: {
    viewport: { width: 390, height: 844 }, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
    platform: 'iPhone', touchPoints: 5
  },
  ipad: {
    viewport: { width: 820, height: 1180 }, hasTouch: false,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',
    platform: 'MacIntel', touchPoints: 5
  }
};
let html, png;
const browsers = new Map();

function choices(type, labels, prefix) {
  return labels.map((label, index) => '<input type="' + (type === 'Multiple' ? 'checkbox' : 'radio') +
    '" id="' + prefix + index + '" name="UserSelect" value="raw&amp;value=' + index + '"' +
    (index === 0 ? ' checked' : '') + '><label for="' + prefix + index + '">' + label + '</label>').join('');
}
function fixture() {
  const options = ['<span>A. Alpha | literal</span>', '<span>B. Beta &amp; literal</span>', '<span>C. Gamma</span>'];
  const base = (type, index, overrides = {}) => ({
    GlobalUID: index, TopicGuid: 'practice-synthetic-' + index, QuestionType: type,
    ChapterName: index % 2 ? 'Synthetic odd' : 'Synthetic even', DegreeLevel: '简单',
    Title: '<p>Synthetic practice question ' + index + '</p>',
    DetailHtml: '<p>Synthetic practice question ' + index + '</p>' + choices(type, options, 'q' + index),
    SniffedAnswer: options[1], AnswerSource: 'platform-verified', IsAIAnswer: false,
    s2_done: true, s3_done: true, PlatformDetailChecked: true, ...overrides
  });
  return [
    base('Single', 0),
    base('Multiple', 1, { SniffedAnswer: options[0] + ' <b>|</b> ' + options[2] }),
    base('TrueOrFalse', 2, {
      DetailHtml: '<p>Synthetic boolean statement</p><label><input type="radio" name="UserSelect" value="TRUE" checked>正确</label><label><input type="radio" name="UserSelect" value="FALSE">错误</label>',
      SniffedAnswer: '错误'
    }),
    base('Blank', 3, { BlankCount: 2, DetailHtml: '<p>Synthetic ordered blanks: <input type="text" name="UserSelect" value="old student draft"> then <textarea name="UserSelect">old draft</textarea>.</p>', SniffedAnswer: 'Reference first; reference second' }),
    base('Program', 4, { DetailHtml: '<p>Synthetic code exercise; do not execute drafts.</p>', SniffedAnswer: 'class Reference {\r\n  String value = "&lt;literal&gt;";\r\n}\r\n', AnswerSource: 'platform-reference' }),
    base('Single', 5, { DetailHtml: '<p>Synthetic unavailable options</p>', SniffedAnswer: '', AnswerSource: null, ExtractionWarning: 'Source omitted its choices' }),
    base('Single', 6, { DetailHtml: '<p>Synthetic identical option text</p>' + choices('Single', ['<span>Same text</span>', '<span>Same text</span>'], 'duplicate'), SniffedAnswer: '<span>Same text</span>' }),
    base('Single', 7, { SniffedAnswer: 'AI says option B; A appears in the explanation.', AnswerSource: 'ai', IsAIAnswer: true }),
    base('Single', 8, { reviewStatus: 'different' }),
    base('Single', 9, { reviewStatus: 'uncertain' }),
    base('Single', 10, { reviewStatus: 'consistent' }),
    base('Single', 11, {
      DetailHtml: '<p>Synthetic image alternatives</p>' + choices('Single', ['<span>Diagram <img src="images/img_1.png" alt="diagram"></span>', '<span>Diagram <img src="images/img_2.png" alt="diagram"></span>'], 'image'),
      SniffedAnswer: '<span>Diagram <img src="images/img_2.png" alt="diagram"></span>'
    }),
    base('Single', 12, { CollectionSource: 'homework', HomeworkSources: [{ jobId: 'synthetic-job', name: 'Synthetic homework' }],
      DetailHtml: '<p>Synthetic homework alternatives</p><div class="div_TopicOptions"><p class="p_TopicOption">A、Homework alpha</p><p class="p_TopicOption">B、Homework beta</p></div>',
      SniffedAnswer: 'B、Homework beta', AnswerSource: 'platform-answer' }),
    base('Single', 13, { reviewStatus: 'uncertain', reviewIssue: { category: 'multiple_correct', explanation: 'Two original choices can hold under the stated condition.' } }),
    base('Program', 14, { DetailHtml: '<p>Synthetic second program editor for shared draft vocabulary.</p>', SniffedAnswer: 'class AnotherReference {}', AnswerSource: 'platform-reference' })
  ];
}

before(async () => {
  const browser = await launch();
  browsers.set('chromium', browser);
  const harness = await createHarness(browser);
  try {
    const result = await harness.page.evaluate(async rows => {
      const canvas = document.createElement('canvas'); canvas.width = 40; canvas.height = 20;
      canvas.getContext('2d').fillRect(0, 0, 40, 20);
      const buffer = await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer();
      await __test.validateImageBuffer(buffer, 'image/png');
      __test.setImages([1, 2].map(index => ['http://fixture.test/diagram-' + index + '.png', { filename: 'img_' + index + '.png', downloaded: true, buffer }]));
      for (const row of rows) {
        if (!row.reviewStatus) continue;
        const status = row.reviewStatus, issues = row.reviewIssue ? [row.reviewIssue] : [];
        const ids = status === 'consistent' ? ['option_2'] : row.reviewIssue ? ['option_1', 'option_2'] : ['option_1'];
        row.AIReview = {
          version: 2, status, fingerprint: __test.aiReviewFingerprint(row),
          policy: { javaTarget: __test.getSettings().javaTarget, preview: false }, options: __test.aiOptionCatalog(row),
          independentAnswer: 'Synthetic independent alternative <script>window.__practiceExecuted=true</script>', promptText: 'Synthetic blind prompt',
          independentAssessment: { optionIds: ids, issues, explanation: 'Synthetic reasoning', javaVersions: [] },
          comparison: { verdict: status, reason: 'Synthetic comparison', optionIds: ids, issues,
            platformAssessment: status === 'consistent' ? 'supported' : 'uncertain', aiAssessment: status === 'consistent' ? 'supported' : 'uncertain', javaVersions: [] }
        };
        if (!__test.getValidAiReview(row)) throw new Error('Invalid synthetic practice review: ' + row.GlobalUID);
      }
      __test.setData(rows);
      return { html: __test.generateOfflineHtml(true), png: canvas.toDataURL('image/png').split(',')[1] };
    }, fixture());
    ({ html, png } = result);
  } finally { await harness.close(); }
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function withReader(fn, { engine = 'chromium', profile = profiles.desktop, blockedStorage = false } = {}) {
  if (!browsers.has(engine)) browsers.set(engine, await launch(engine));
  const { platform, touchPoints, ...options } = profile;
  const context = await browsers.get(engine).newContext(options);
  const errors = [], unexpected = [];
  try {
    await context.addInitScript(({ platform, touchPoints, blockedStorage }) => {
      if (platform) Object.defineProperty(navigator, 'platform', { configurable: true, get: () => platform });
      if (touchPoints !== undefined) Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, get: () => touchPoints });
      if (blockedStorage) for (const name of ['getItem', 'setItem', 'removeItem', 'clear']) {
        Storage.prototype[name] = () => { throw new DOMException('Synthetic storage denied', 'SecurityError'); };
      }
      window.__practiceExecuted = false;
    }, { platform, touchPoints, blockedStorage });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === 'http://fixture.test' && url.pathname === '/practice-reader') return route.fulfill({ contentType: 'text/html', body: html });
      if (url.origin === 'http://fixture.test' && /^\/images\/img_[12]\.png$/.test(url.pathname)) return route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') });
      unexpected.push(url.origin + url.pathname); return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://fixture.test/practice-reader', { waitUntil: 'domcontentloaded' });
    await fn(page);
    assert.deepEqual(errors, [], 'reader script errors');
    assert.deepEqual(unexpected, [], 'practice must not make external or submission requests');
    assert.equal(await page.evaluate(() => __practiceExecuted), false);
  } finally { await context.close(); }
}
function card(page, index) { return page.locator('.topic').nth(index); }
async function focusEditor(editor) {
  // A reader clicks the editor before typing. Let that focus-induced scroll
  // settle, so a pending scroll event is not confused with completion input.
  await editor.click();
  await editor.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function openPractice(page, index) {
  const row = card(page, index);
  if (await row.locator('.practice-toggle').getAttribute('aria-expanded') !== 'true') await row.locator('.practice-toggle').click();
  assert.equal(await row.locator('.practice-area').isVisible(), true);
  return row;
}
async function feedback(row, state) {
  await row.locator('.practice-feedback').waitFor({ state: 'visible' });
  assert.equal(await row.locator('.practice-feedback').getAttribute('role'), 'status');
  assert.equal(await row.locator('.practice-feedback').getAttribute('data-state'), state);
  if (state === 'match' || state === 'different') assert.match(await row.locator('.practice-feedback').textContent(), /平台/);
  if (state === 'neutral') assert.doesNotMatch(await row.locator('.practice-feedback').textContent(), /回答正确|回答错误|绝对正确/);
}
async function assertPracticeActionsLayout(page) {
  const [answer, practice] = await Promise.all([page.locator('#toggleAnsBtn').boundingBox(), page.locator('#togglePracticeBtn').boundingBox()]);
  assert.ok(answer && practice, 'both global actions are visible');
  assert.ok(Math.abs(answer.y - practice.y) <= 1, 'global actions share one row');
  assert.ok(Math.abs(answer.width - practice.width) <= 2, 'global actions have equal widths');
  assert.ok(await page.locator('.results-toolbar').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'result controls do not overflow');
}
async function assertCodeEditorWidth(row) {
  const geometry = await row.locator('.practice-code').evaluate(input => ({ width: input.getBoundingClientRect().width, available: input.closest('.practice-area').clientWidth }));
  assert.ok(geometry.width >= geometry.available * 0.8 && geometry.width <= geometry.available + 1, JSON.stringify(geometry));
}

test('practice: single choices map original associated labels and ignore stale checked state', () => withReader(async page => {
  assert.equal(await page.locator('textarea.practice-code').count(), 0, 'draft editors are created only on demand');
  assert.equal(await page.locator('.practice-choice:not(:disabled)').count(), 0, 'captured choices stay inactive until practice opens');
  const row = await openPractice(page, 0);
  assert.equal(await row.locator('.practice-choice').count(), 3);
  assert.equal(await row.locator('.practice-choice:checked').count(), 0, 'captured student checks are not new attempts');
  assert.match((await row.locator('.practice-option').allTextContents()).join(' '), /Alpha \| literal/);
  await row.locator('.practice-choice[value="option_1"]').check(); await feedback(row, 'different');
  await row.locator('.practice-choice[value="option_2"]').check(); await feedback(row, 'match');
  assert.equal(await row.locator('.practice-choice:checked').count(), 1);
  await row.locator('.practice-reset').click();
  assert.equal(await row.locator('.practice-choice:checked').count(), 0);
  assert.equal(await row.locator('.answer-box').isVisible(), true);
}));

test('practice: multiple-choice submission requires the exact option set, not a delimiter guess', () => withReader(async page => {
  const row = await openPractice(page, 1);
  await row.locator('.practice-check').click(); await feedback(row, 'empty');
  await row.locator('.practice-choice[value="option_1"]').check();
  assert.equal(await row.locator('.practice-feedback').getAttribute('data-state'), 'empty', 'a partial multi-choice selection is not submitted automatically');
  await row.locator('.practice-check').click(); await feedback(row, 'different');
  await row.locator('.practice-choice[value="option_3"]').check();
  await row.locator('.practice-check').click(); await feedback(row, 'match');
  await row.locator('.practice-choice[value="option_2"]').check();
  await row.locator('.practice-check').click(); await feedback(row, 'different');
}));

test('practice: true/false and input-free homework choices are independently actionable', () => withReader(async page => {
  for (const index of [2, 12]) {
    const row = await openPractice(page, index);
    assert.equal(await row.locator('.practice-choice').count(), 2);
    await row.locator('.practice-choice[value="option_1"]').check(); await feedback(row, 'different');
    await row.locator('.practice-choice[value="option_2"]').check(); await feedback(row, 'match');
  }
}));

test('practice: identical text with different images maps by image identity; duplicate options stay ungraded', () => withReader(async page => {
  const imageRow = await openPractice(page, 11);
  assert.equal(await imageRow.locator('.practice-option img').count(), 2, await imageRow.locator('.detail-box').innerHTML());
  await imageRow.locator('.practice-option').nth(0).click(); await feedback(imageRow, 'different');
  await imageRow.locator('.practice-option').nth(1).click(); await feedback(imageRow, 'match');
  const ambiguous = await openPractice(page, 6);
  await ambiguous.locator('.practice-option').first().click(); await feedback(ambiguous, 'neutral');
}));

test('practice: AI-only, disagreement, uncertainty and question issues never become correctness verdicts', () => withReader(async page => {
  for (const index of [7, 8, 9, 13]) {
    const row = await openPractice(page, index);
    for (const choice of ['option_1', 'option_2']) {
      await row.locator('.practice-choice[value="' + choice + '"]').check();
      if (await row.locator('.practice-check').isVisible()) await row.locator('.practice-check').click();
      await feedback(row, 'neutral');
    }
  }
  const consistent = await openPractice(page, 10);
  await consistent.locator('.practice-choice[value="option_2"]').check(); await feedback(consistent, 'match');
  assert.equal(await page.locator('.practice-area script').count(), 0);
}));

test('practice: ordered blank drafts and literal code remain editable without execution or automatic grading', () => withReader(async page => {
  const blank = await openPractice(page, 3), code = await openPractice(page, 4);
  await assertPracticeActionsLayout(page); await assertCodeEditorWidth(code);
  const fields = blank.locator('.practice-input[data-blank-index]');
  assert.equal(await fields.count(), 2);
  assert.deepEqual(await fields.evaluateAll(inputs => inputs.map(input => input.value)), ['', '']);
  await fields.nth(0).fill('First <tag> & literal'); await fields.nth(1).fill('Second');
  const draft = 'class Draft {\n  String s = "</script><script>window.__practiceExecuted=true</script>";\n}\n';
  await code.locator('textarea.practice-code').fill(draft);
  assert.equal(await code.locator('textarea.practice-code').inputValue(), draft);
  assert.equal(await code.locator('button').filter({ hasText: /运行|执行/ }).count(), 0);
  assert.equal(await code.locator('.practice-choice').count(), 0);
  await blank.locator('.practice-reset').click();
  assert.deepEqual(await fields.evaluateAll(inputs => inputs.map(input => input.value)), ['', '']);
  assert.equal(await code.locator('textarea.practice-code').inputValue(), draft, 'reset affects only its own question');
}));

test('practice: answer visibility opens or closes practice while independent controls retain drafts', () => withReader(async page => {
  const row = await openPractice(page, 0);
  await row.locator('.practice-choice[value="option_2"]').check();
  await row.locator('.practice-toggle').click();
  assert.equal(await row.locator('.answer-box').isVisible(), true);
  assert.equal(await row.locator('.practice-choice:not(:disabled)').count(), 0);
  await row.locator('.answer-toggle').click();
  assert.equal(await row.locator('.answer-box').isVisible(), false);
  assert.equal(await row.locator('.practice-area').isVisible(), true);
  await row.locator('.answer-toggle').click();
  assert.equal(await row.locator('.practice-area').isVisible(), false);
  await page.locator('#toggleAnsBtn').click();
  assert.equal(await page.locator('.answer-box:not([hidden])').count(), 0);
  assert.equal(await row.locator('.practice-area').isVisible(), true);
  await page.locator('#toggleAnsBtn').click();
  assert.equal(await row.locator('.practice-area').isVisible(), false);
  await page.locator('#togglePracticeBtn').click();
  assert.equal(await page.locator('#togglePracticeBtn').getAttribute('aria-pressed'), 'true');
  assert.equal(await row.locator('.answer-box').isVisible(), true);
  assert.equal(await row.locator('.practice-choice[value="option_2"]').isChecked(), true);
  await page.locator('#togglePracticeBtn').click();
  assert.equal(await row.locator('.practice-area').isVisible(), false);
}));

test('practice: drafts survive search, combined filters and same-document navigation when storage is denied', () => withReader(async page => {
  const row = await openPractice(page, 4), draft = 'class Preserved { int n = 42; }';
  await row.locator('.practice-code').fill(draft);
  await page.locator('#typeFilter').selectOption('Single');
  assert.equal(await row.isVisible(), false);
  await page.locator('#keywordFilter').fill('unavailable options');
  await page.waitForFunction(() => document.querySelector('#visibleCount').textContent === '1');
  await page.evaluate(() => { location.hash = 'synthetic-offline-jump'; });
  await page.locator('#resetFilters').click();
  assert.equal(await row.locator('.practice-code').inputValue(), draft);
  await page.locator('#keywordFilter').fill('Synthetic code exercise');
  await page.waitForFunction(() => document.querySelector('#visibleCount').textContent === '1');
  assert.equal(await row.locator('.practice-code').inputValue(), draft);
  await page.locator('#resetFilters').click();
  await row.locator('.practice-toggle').click(); await row.locator('.practice-toggle').click();
  assert.equal(await row.locator('.practice-code').inputValue(), draft);
}, { blockedStorage: true }));

test('practice completion: local draft symbols and keywords replace only the caret prefix through keyboard acceptance', () => withReader(async page => {
  const first = await openPractice(page, 4), other = await openPractice(page, 14);
  await other.locator('.practice-code').fill('class DraftOnlySymbol { int totalScore; void computeTotal() {} }\n');
  const editor = first.locator('.practice-code'), popup = page.locator('#practiceCompletions');
  await focusEditor(editor);
  await editor.fill('tot'); await popup.waitFor({ state: 'visible' });
  assert.ok((await popup.locator('[role="option"]').allTextContents()).includes('totalScore'));
  await popup.locator('[role="option"]').filter({ hasText: /^totalScore$/ }).click();
  assert.equal(await editor.inputValue(), 'totalScore');
  assert.equal(await editor.evaluate(input => document.activeElement === input), true);
  await editor.fill('p'); await page.keyboard.press('Control+Space');
  await popup.waitFor({ state: 'visible' });
  const values = await popup.locator('[role="option"]').allTextContents();
  assert.ok(values.length > 1 && values.length <= 8);
  await page.keyboard.press('ArrowUp');
  assert.equal(await popup.locator('[aria-selected="true"]').textContent(), values.at(-1));
  await page.keyboard.press('ArrowDown');
  assert.equal(await popup.locator('[aria-selected="true"]').textContent(), values[0]);
  await page.keyboard.press('Escape');
  const original = '// unchanged prefix\npubl\n// unchanged suffix';
  await editor.fill(original);
  await editor.evaluate(input => { const caret = input.value.indexOf('publ') + 4; input.setSelectionRange(caret, caret); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await popup.waitFor({ state: 'visible' }); await page.keyboard.press('Tab');
  assert.equal(await editor.inputValue(), original.replace('publ', 'public'));
  assert.equal(await editor.evaluate(input => document.activeElement === input), true);
  await editor.fill('retu'); await popup.waitFor({ state: 'visible' }); await page.keyboard.press('Enter');
  assert.equal(await editor.inputValue(), 'return');
  assert.equal(await popup.isVisible(), false);
}, { blockedStorage: true }));

test('practice completion: cancellation, composition and readonly code never overwrite drafts or trigger execution', () => withReader(async page => {
  const row = await openPractice(page, 4), editor = row.locator('.practice-code'), popup = page.locator('#practiceCompletions');
  await editor.fill('publ'); await popup.waitFor({ state: 'visible' }); await page.keyboard.press('Escape');
  assert.equal(await editor.inputValue(), 'publ'); assert.equal(await popup.isVisible(), false);
  await editor.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
  await editor.fill('retu');
  const consumed = await editor.evaluate(input => {
    const keys = ['Enter', 'Tab', 'Escape'];
    return keys.map(key => !input.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, isComposing: true })));
  });
  assert.deepEqual(consumed, [false, false, false]); assert.equal(await editor.inputValue(), 'retu');
  assert.equal(await popup.isVisible(), false);
  await editor.evaluate(input => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'retu' })));
  await editor.evaluate(input => { input.readOnly = true; });
  await page.keyboard.press('Control+Space'); await page.keyboard.press('Tab');
  assert.equal(await popup.isVisible(), false); assert.equal(await editor.inputValue(), 'retu');
  await editor.evaluate(input => { input.readOnly = false; });
  await editor.fill('window.__practiceExecuted = true;\n');
  assert.equal(await page.evaluate(() => __practiceExecuted), false);
  await page.locator('#keywordFilter').fill('publ');
  assert.equal(await popup.isVisible(), false, 'search input must not invoke code completion');
}));

for (const engine of ['chromium', 'webkit']) {
  test(engine + ': practice completion stays inside a narrow viewport and dismisses on scrolling or editor closure', { timeout: 90000 }, () => withReader(async page => {
    const row = await openPractice(page, 4), editor = row.locator('.practice-code'), popup = page.locator('#practiceCompletions');
    await focusEditor(editor);
    await editor.fill('class VeryLongSyntheticIdentifier {}\n' + ' '.repeat(160));
    await editor.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.keyboard.type('VeryLongSyn', { delay: 20 });
    await popup.waitFor({ state: 'visible' });
    const geometry = await popup.evaluate(node => { const rect = node.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: innerWidth, height: innerHeight }; });
    assert.ok(geometry.left >= 0 && geometry.top >= 0 && geometry.right <= geometry.width + 1 && geometry.bottom <= geometry.height + 1, JSON.stringify(geometry));
    await popup.locator('[role="option"]').filter({ hasText: /^VeryLongSyntheticIdentifier$/ }).click();
    assert.match(await editor.inputValue(), /VeryLongSyntheticIdentifier$/);
    assert.equal(await editor.evaluate(input => document.activeElement === input), true);
    await editor.fill('publ'); await popup.waitFor({ state: 'visible' });
    await page.evaluate(() => window.scrollBy(0, 30));
    await popup.waitFor({ state: 'hidden' });
    await editor.fill('retu'); await popup.waitFor({ state: 'visible' });
    await row.locator('.practice-toggle').click();
    assert.equal(await popup.isVisible(), false);
    await row.locator('.practice-toggle').click(); assert.equal(await editor.inputValue(), 'retu');
  }, { engine, profile: profiles.iphone }));

  test(engine + ': practice remains keyboard/touch usable through phone drawer and tablet rotation', { timeout: 90000 }, () => withReader(async page => {
    assert.equal(await page.locator('body').getAttribute('data-reader-mode'), 'compat');
    const row = await openPractice(page, 4);
    await assertCodeEditorWidth(row);
    await row.locator('.practice-code').fill('class MobileDraft {}');
    await page.locator('#mobileControls').click();
    assert.equal(await page.locator('#togglePracticeBtn').isVisible(), true);
    await assertPracticeActionsLayout(page);
    await page.locator('#readerMode').selectOption('standard');
    await page.waitForFunction(() => document.querySelector('#mobileControls').getAttribute('aria-expanded') === 'false');
    for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await page.waitForFunction(width => width >= 768
        ? document.querySelector('#readerSidebar').parentElement.classList.contains('app-layout')
        : document.querySelector('#readerSidebar').parentElement.id === 'drawerContent', viewport.width);
      assert.equal(await row.locator('.practice-code').inputValue(), 'class MobileDraft {}');
      await assertCodeEditorWidth(row);
      if (viewport.width >= 768) await assertPracticeActionsLayout(page);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    await page.locator('#readerMode').selectOption('compat');
    await row.locator('.practice-code').focus(); await page.keyboard.type('// kept');
    assert.match(await row.locator('.practice-code').inputValue(), /MobileDraft/);
    assert.equal(await page.locator('#mobileControls').isVisible(), false);
  }, { engine, profile: profiles.iphone }));

  test(engine + ': touch iPad desktop controls and print preserve drafts without including editors', { timeout: 90000 }, () => withReader(async page => {
    assert.equal(await page.locator('#mobileControls').isVisible(), false);
    assert.equal(await page.locator('body').getAttribute('data-reader-mode'), 'compat');
    const row = await openPractice(page, 3);
    await assertPracticeActionsLayout(page);
    const code = await openPractice(page, 4); await assertCodeEditorWidth(code);
    await row.locator('.practice-input').first().fill('iPad draft');
    await page.setViewportSize({ width: 1180, height: 820 });
    assert.equal(await page.locator('#togglePracticeBtn').isVisible(), true);
    await assertPracticeActionsLayout(page); await assertCodeEditorWidth(code);
    await page.emulateMedia({ media: 'print' });
    assert.equal(await row.locator('.practice-area').isVisible(), false);
    assert.equal(await row.locator('.detail-box').isVisible(), true);
    await page.emulateMedia({ media: 'screen' });
    assert.equal(await row.locator('.practice-input').first().inputValue(), 'iPad draft');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  }, { engine, profile: profiles.ipad }));
}
