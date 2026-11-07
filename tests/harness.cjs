const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

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

async function launch() {
  return chromium.launch({
    headless: true,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
  });
}

async function createHarness(browser, sourceOverride, fixtureHtml) {
  const context = await browser.newContext();
  // Never use a real campus origin, cookies, course data, or an external AI API.
  await context.route('**/*', route => {
    if (route.request().url() === 'http://fixture.test/Manage/Practice/index') {
      return route.fulfill({ contentType: 'text/html', body: fixtureHtml || '<!doctype html><html><head><meta charset="utf-8"></head><body><input id="input_Search"></body></html>' });
    }
    return route.abort('blockedbyclient');
  });
  const page = await context.newPage();
  await page.goto('http://fixture.test/Manage/Practice/index');
  await page.addScriptTag({ path: jszipPath });
  await page.evaluate(() => {
    window.__ajaxCalls = [];
    window.__zips = [];
    window.__values = { '#select_LanguageType': 'Java', '#select_DegreeLevel': [], '#select_KnoGuid': [], '#input_Search': '' };
    window.__chapters = [];
    window.$ = selector => ({ val: () => window.__values[selector] });
    $.fn = { zTree: { getZTreeObj: () => ({ getSelectedNodes: () => window.__chapters }) } };
    $.ajax = options => {
      let data = options.data;
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
      window.__zips.push(this);
      return generate.apply(this, args);
    };
    window.Tesseract = { createWorker: async () => ({ recognize: async () => ({ data: { text: 'synthetic OCR text' } }) }) };
  });
  await page.addScriptTag({ content: instrument(sourceOverride || fs.readFileSync(sourcePath, 'utf8')) });
  await page.evaluate(() => {
    __test.initializePlatformVariables();
    __test.state.isPaused = false;
  });
  return { page, close: () => context.close() };
}

module.exports = { launch, createHarness, sourcePath };
