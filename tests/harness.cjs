const fs = require('node:fs');
const path = require('node:path');
const { chromium, firefox, webkit } = require('playwright');

const sourcePath = path.resolve(__dirname, '..', 'BISTU_Java_Extractor.user.js');
const jszipPath = require.resolve('jszip/dist/jszip.min.js');

// The userscript remains a self-contained installable file. Only this test copy
// exposes its closure so failure/resume states can be exercised deterministically.
function instrument(source) {
  const end = source.lastIndexOf('})();');
  if (end < 0) throw new Error('Userscript closure not found');
  return source.slice(0, end) + `
    window.__test = {
      runStage1, runStage2, runStage3, runStage4, runEngine,
      buildZipAndDownload, generateOfflineHtml, initializePlatformVariables,
      runWithConcurrency, keyManager,
      addLog: typeof addLog === 'function' ? addLog : undefined,
      flushLogs: typeof flushLogs === 'function' ? flushLogs : undefined,
      refreshPanelControls: typeof refreshPanelControls === 'function' ? refreshPanelControls : undefined,
      getSettings: typeof getSettings === 'function' ? getSettings : undefined,
      reconcilePlatformAnswer: typeof reconcilePlatformAnswer === 'function' ? reconcilePlatformAnswer : undefined,
      aiReviewFingerprint: typeof aiReviewFingerprint === 'function' ? aiReviewFingerprint : undefined,
      getValidAiReview: typeof getValidAiReview === 'function' ? getValidAiReview : undefined,
      aiOptionCatalog: typeof aiOptionCatalog === 'function' ? aiOptionCatalog : undefined,
      requestDeepSeek: typeof requestDeepSeek === 'function' ? requestDeepSeek : undefined,
      restorePlatformVariables: typeof restorePlatformVariables === 'function' ? restorePlatformVariables : undefined,
      validateImageBuffer: typeof validateImageBuffer === 'function' ? validateImageBuffer : undefined,
      getImageDimensions: buffer => typeof imageDimensions !== 'undefined' ? imageDimensions.get(buffer) : undefined,
      createImagePack: typeof createImagePack === 'function' ? createImagePack : undefined,
      bistuCrypto: typeof bistuCrypto !== 'undefined' ? bistuCrypto : undefined,
      parseHomeworkDetail: typeof parseHomeworkDetail === 'function' ? parseHomeworkDetail : undefined,
      homeworkFingerprint: typeof homeworkFingerprint === 'function' ? homeworkFingerprint : undefined,
      mergeHomeworkQuestions: typeof mergeHomeworkQuestions === 'function' ? mergeHomeworkQuestions : undefined,
      runHomeworkSupplement: typeof runHomeworkSupplement === 'function' ? runHomeworkSupplement : undefined,
      get state() { return globalState; },
      get data() { return allData; },
      get images() { return imageQueue; },
      setState(value) { globalState = value; },
      setData(value) { allData = value; },
      setImages(value) { imageQueue = new Map(value); },
      setEngineStage(stage, fn) {
        if (stage === 1) runStage1 = fn;
        if (stage === 2) runStage2 = fn;
        if (stage === 3) runStage3 = fn;
        if (stage === 4) runStage4 = fn;
      },
      setBuilder(fn) { buildZipAndDownload = fn; },
      get scope() { return { language:currentLang, degree:currentDegree, chapter:currentChapter, knowledge:currentKno, search:currentSearch, origin }; }
    };
` + source.slice(end);
}

async function launch(engine = 'chromium') {
  if (!['chromium', 'firefox', 'webkit'].includes(engine)) throw new Error('Unsupported test browser engine');
  return ({ chromium, firefox, webkit }[engine]).launch({
    headless: true,
    timeout: 30000,
    ...(engine === 'chromium' && process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
  });
}

async function createHarness(browser, sourceOverride, fixtureHtml, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  // Never use a real campus origin, cookies, course data, or an external AI API.
  await context.route('**/*', route => {
    if (route.request().url() === 'http://fixture.test/Manage/Practice/index') {
      return route.fulfill({ contentType: 'text/html', body: fixtureHtml || '<!doctype html><html><head><meta charset="utf-8"></head><body><input id="input_Search"><select id="select_DegreeLevel" multiple></select><select id="select_KnoGuid" multiple></select><ul id="ul_Tree"></ul><select id="select_QuestionType"><option value="1">单选题</option><option value="2">多选题</option><option value="3">判断题</option><option value="4">填空题</option><option value="5">程序题</option></select></body></html>' });
    }
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  // Existing state-machine fixtures deliberately replace synthetic in-memory
  // tasks. Accept that explicit replacement, including the panel's loss guard.
  // Tests of cancellation can remove this listener and supply their own choice.
  page.on('dialog', dialog => dialog.type() === 'confirm' ? dialog.accept() : dialog.dismiss());
  await page.goto('http://fixture.test/Manage/Practice/index');
  await page.addScriptTag({ path: jszipPath });
  await page.evaluate(() => {
    window.__ajaxCalls = [];
    window.__zips = [];
    window.__values = { '#select_LanguageType': 'Java', '#select_DegreeLevel': [], '#select_KnoGuid': [], '#input_Search': '' };
    window.__chapters = [];
    window.__setSettings = values => {
      for (const [name, value] of Object.entries(values)) {
        const input = document.getElementById('bistu-setting-' + name);
        if (!input) throw new Error('Missing setting control: ' + name);
        if (input.type === 'checkbox') input.checked = !!value;
        else input.value = String(value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
    window.__aiResponse = (content = 'Synthetic answer', usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) =>
      Response.json({ id: 'synthetic-completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage });
    window.$ = selector => ({ val: () => window.__values[selector] });
    $.fn = { zTree: { getZTreeObj: () => ({ getSelectedNodes: () => window.__chapters }) } };
    $.ajax = options => {
      let data = options.data;
      if (typeof data === 'string' && /application\/json/i.test(options.contentType || '')) data = JSON.parse(data);
      const entries = Array.isArray(data) ? data.map(({name,value}) => [name,value]) : typeof data === 'string' ? [...new URLSearchParams(data)] : null;
      if (entries) {
        data = {};
        for (const [key, value] of entries) {
          if (!(key in data)) data[key] = value;
          else data[key] = [].concat(data[key], value);
        }
      }
      window.__ajaxCalls.push({ url: options.url, method: options.type, data });
      Promise.resolve().then(() => {
        if (!window.__respond) throw new Error('Unexpected request: ' + options.url);
        return window.__respond({ ...options, data });
      }).then(options.success, error => options.error({}, 'error', error.message));
    };
    window.fetch = async (...args) => {
      if (!window.__fetch) throw new Error('Unexpected fetch: ' + args[0]);
      return window.__fetch(...args);
    };
    const generate = JSZip.prototype.generateAsync;
    JSZip.prototype.generateAsync = async function(...args) {
      // Record user-exported snapshots, not the private one-entry archives used
      // by the image-pack compressor to obtain DEFLATE bytes.
      if (this.file('state.json') && this.file('index.html')) window.__zips.push(this);
      return generate.apply(this, args);
    };
    window.Tesseract = { createWorker: async () => ({ recognize: async () => ({ data: { text: 'synthetic OCR text' } }) }) };
  });
  await page.addScriptTag({ content: instrument(sourceOverride || fs.readFileSync(sourcePath, 'utf8')) });
  await page.evaluate(() => {
    // Existing extraction fixtures intentionally exercise Practice only. Homework
    // cases opt in explicitly and supply their own fully synthetic responses.
    if (document.querySelector('#bistu-setting-includeHomework')) __setSettings({ includeHomework: 'disabled' });
    if (document.querySelector('#bistu-setting-answerReviewMode')) __setSettings({ answerReviewMode: 'missing-only' });
    // Password-protected export has its own cryptographic contract suite. Older
    // extraction fixtures explicitly retain public export without real secrets.
    if (document.querySelector('#bistu-setting-exportProtection')) __setSettings({ exportProtection: 'none' });
    __test.initializePlatformVariables();
    __test.state.isPaused = false;
  });
  // Reader fixtures replace the document with page.setContent, which preserves
  // this window's callbacks unlike opening the exported file in a new document.
  // Let extraction-panel initialization finish before that synthetic transition.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return { page, close: () => context.close() };
}

module.exports = { launch, createHarness, sourcePath };
