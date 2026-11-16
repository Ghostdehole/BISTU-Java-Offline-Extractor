'use strict';
// The control panel runs only on the synthetic Practice fixture. Every platform
// request, balance response and credential below is fake; no personal browser.
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const JSZip = require('jszip');
const { launch, createHarness } = require('./harness.cjs');
let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

async function withPanel(fn, viewport = { width: 1440, height: 900 }) {
  const harness = await createHarness(browser, undefined, undefined, { viewport });
  harness.page.setDefaultTimeout(5000);
  try { return await fn(harness.page); } finally { await harness.close(); }
}
const panelSelector = '#bistu-extractor-panel';
async function stateIs(page, expected) {
  await page.waitForFunction(value => document.querySelector('#bistu-extractor-panel').dataset.state === value, expected);
}
async function twoFrames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function withinViewport(page, selector) {
  const box = await page.locator(selector).boundingBox();
  const viewport = page.viewportSize();
  assert.ok(box && box.width > 0 && box.height > 0, selector + ' is visible');
  assert.ok(box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1,
    selector + ' remains within the viewport: ' + JSON.stringify(box));
}
async function addLogs(page, rows) {
  await page.evaluate(rows => rows.forEach(([message, level]) => __test.addLog(message, level)), rows);
  await twoFrames(page);
}

test('panel: short and narrow viewports keep tabs, feedback and task actions reachable', () => withPanel(async page => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  for (const viewport of [{width:1440,height:900},{width:1024,height:600},{width:390,height:844},{width:320,height:568},{width:844,height:390}]) {
    await page.setViewportSize(viewport); await twoFrames(page);
    await withinViewport(page, panelSelector);
    for (const id of ['bistu-extractor-panel-header','bistu-tab-overview','bistu-start-btn','bistu-import-btn']) await withinViewport(page, '#' + id);
    await page.locator('#bistu-tab-settings').click();
    await page.locator('#bistu-settings-reset').focus();
    await withinViewport(page, '#bistu-settings-reset');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'bistu-settings-reset');
    assert.equal(await page.locator(panelSelector).evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.locator('#bistu-tab-overview').click();
  }
  assert.deepEqual(errors, []);
}));

test('panel: keyboard tabs expose exactly one labelled panel and preserve edits', () => withPanel(async page => {
  await page.locator('#bistu-tab-overview').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bistu-tab-settings');
  assert.equal(await page.locator('#bistu-panel-settings').isVisible(), true);
  await page.locator('#bistu-setting-aiConcurrency').fill('4');
  await page.locator('#bistu-tab-settings').focus();
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bistu-tab-logs');
  assert.equal(await page.locator('#bistu-panel-logs').isVisible(), true);
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bistu-tab-overview');
  await page.locator('#bistu-open-settings').click();
  assert.equal(await page.locator('#bistu-setting-aiConcurrency').inputValue(), '4');
  const roles = await page.evaluate(() => [...document.querySelectorAll('[id^="bistu-tab-"]')].map(tab => ({
    selected: tab.getAttribute('aria-selected'), tabIndex: tab.tabIndex,
    valid: document.getElementById(tab.getAttribute('aria-controls'))?.getAttribute('aria-labelledby') === tab.id
  })));
  assert.equal(roles.filter(row => row.selected === 'true' && row.tabIndex === 0).length, 1);
  assert.equal(roles.filter(row => row.tabIndex === -1).length, 2);
  assert.ok(roles.every(row => row.valid));
  assert.equal(await page.locator('#bistu-panel-overview').isVisible(), false);
  assert.equal(await page.locator('#bistu-panel-logs').isVisible(), false);
}, {width:1024,height:420}));

test('panel: pointer drag and resize clamp to the viewport and stop on release', () => withPanel(async page => {
  const initial = await page.locator(panelSelector).boundingBox();
  const header = await page.locator('#bistu-extractor-panel-header').boundingBox();
  await page.mouse.move(header.x + 24, header.y + header.height / 2);
  await page.mouse.down(); await page.mouse.move(40, 40, {steps:5}); await page.mouse.up();
  const moved = await page.locator(panelSelector).boundingBox();
  assert.ok(Math.abs(moved.x - initial.x) > 20, 'header dragging changes position');
  await withinViewport(page, panelSelector);
  const corner = await page.locator('.panel-resizer.se').boundingBox();
  await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
  await page.mouse.down(); await page.mouse.move(1439, 899, {steps:5}); await page.mouse.up();
  await withinViewport(page, panelSelector);
  const resized = await page.locator(panelSelector).boundingBox();
  assert.ok(resized.width > moved.width || resized.height > moved.height, 'corner resizing changes dimensions');
  await page.mouse.move(200, 200);
  assert.deepEqual(await page.locator(panelSelector).boundingBox(), resized, 'pointer release ends resizing');
  await page.setViewportSize({width:390,height:500}); await twoFrames(page);
  await withinViewport(page, panelSelector);
  await withinViewport(page, '#bistu-start-btn');
}));

test('panel: fullscreen restores a usable floating panel after viewport changes without clearing edits', () => withPanel(async page => {
  await page.locator('#bistu-tab-settings').click();
  await page.locator('#bistu-setting-aiConcurrency').fill('3');
  const normal = await page.locator(panelSelector).boundingBox();
  await page.locator('#bistu-fullscreen-btn').click();
  assert.equal(await page.locator(panelSelector).getAttribute('data-maximized'), 'true');
  const full = await page.locator(panelSelector).boundingBox();
  assert.ok(full.width > normal.width, 'fullscreen expands the usable workspace');
  await page.setViewportSize({width:844,height:390}); await twoFrames(page);
  await withinViewport(page, panelSelector);
  await page.locator('#bistu-fullscreen-btn').click();
  assert.notEqual(await page.locator(panelSelector).getAttribute('data-maximized'), 'true');
  await withinViewport(page, panelSelector);
  assert.equal(await page.locator('#bistu-setting-aiConcurrency').inputValue(), '3');
  await page.locator('#bistu-tab-overview').click(); await withinViewport(page, '#bistu-start-btn');
}));

test('panel: explicit and automatic themes change presentation without touching task data', () => withPanel(async page => {
  await page.evaluate(() => __test.setData([{GlobalUID:0,QuestionType:'Program',Title:'Synthetic theme sentinel'}]));
  await page.locator('#bistu-theme').selectOption('dark');
  const dark = await page.locator(panelSelector).evaluate(node => getComputedStyle(node).backgroundColor);
  await page.locator('#bistu-theme').selectOption('light');
  const light = await page.locator(panelSelector).evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(dark, light);
  await page.locator('#bistu-theme').selectOption('auto');
  await page.emulateMedia({colorScheme:'dark'}); await twoFrames(page);
  assert.equal(await page.locator(panelSelector).evaluate(node => getComputedStyle(node).backgroundColor), dark);
  await page.emulateMedia({colorScheme:'light'}); await twoFrames(page);
  assert.equal(await page.locator(panelSelector).evaluate(node => getComputedStyle(node).backgroundColor), light);
  assert.equal(await page.evaluate(() => __test.data[0].Title), 'Synthetic theme sentinel');
  assert.equal(await page.evaluate(() => __ajaxCalls.length), 0);
}));

test('panel: the hidden key editor deduplicates continuation lines and only checks mocked balances', () => withPanel(async page => {
  assert.equal(await page.locator('#bistu-keys-editor').isVisible(), false);
  assert.equal(await page.locator('#bistu-edit-keys').getAttribute('aria-expanded'), 'false');
  await page.locator('#bistu-tab-settings').click();
  await page.locator('#bistu-edit-keys').click();
  assert.equal(await page.locator('#bistu-apikey').isVisible(), true);
  await page.locator('#bistu-apikey').fill('synthetic-panel-key-alpha\\\nsynthetic-panel-key-beta; synthetic-panel-key-alpha');
  await page.evaluate(() => {
    window.__balanceCalls = [];
    __fetch = async (url, options) => {
      __balanceCalls.push({url:String(url),authorization:options.headers.Authorization || options.headers.authorization});
      await new Promise(resolve => { (window.__balanceReleases ||= []).push(resolve); });
      return Response.json({is_available:true,balance_infos:[{currency:'CNY',total_balance:'1.00',granted_balance:'0',topped_up_balance:'1.00'}]});
    };
  });
  await page.locator('#bistu-check-keys').click(); await stateIs(page, 'checking');
  assert.equal(await page.locator('#bistu-start-btn').isEnabled(), false);
  assert.equal(await page.locator('#bistu-import-btn').isEnabled(), false);
  await page.waitForFunction(() => window.__balanceReleases?.length === 2);
  await page.evaluate(() => { for (const release of __balanceReleases.splice(0)) release(); });
  await page.waitForFunction(() => !document.querySelector('#bistu-check-keys').disabled);
  const result = await page.evaluate(() => ({calls:__balanceCalls,count:__test.keyManager.getCount(),
    logs:document.querySelector('#bistu-extractor-panel-log').textContent,
    storage:JSON.stringify([Object.entries(localStorage),Object.entries(sessionStorage)])}));
  assert.equal(result.count, 2); assert.equal(result.calls.length, 2);
  assert.ok(result.calls.every(row => new URL(row.url).pathname === '/user/balance'));
  assert.deepEqual(new Set(result.calls.map(row => row.authorization)), new Set(['Bearer synthetic-panel-key-alpha','Bearer synthetic-panel-key-beta']));
  assert.doesNotMatch(result.logs + result.storage, /synthetic-panel-key-(alpha|beta)/);
  assert.match(await page.locator('#bistu-key-count').textContent(), /2/);
  const checkedStatus = await page.locator('#bistu-key-status').textContent();
  await page.evaluate(() => __test.refreshPanelControls());
  assert.equal(await page.locator('#bistu-key-status').textContent(), checkedStatus, 'ordinary state refresh retains the last detection result');
  await page.locator('#bistu-show-keys').click();
  // Whether the reveal control masks text or closes the editor is presentation;
  // the explicit editor toggle must always be able to remove it from view.
  if (await page.locator('#bistu-keys-editor').isVisible()) await page.locator('#bistu-edit-keys').click();
  assert.equal(await page.locator('#bistu-keys-editor').isVisible(), false);
  assert.equal(await page.locator('#bistu-apikey').inputValue(), 'synthetic-panel-key-alpha\\\nsynthetic-panel-key-beta; synthetic-panel-key-alpha');
  await page.locator('#bistu-edit-keys').click();
  await page.locator('#bistu-apikey').fill('synthetic-panel-key-gamma');
  assert.notEqual(await page.locator('#bistu-key-status').textContent(), checkedStatus);
  assert.match(await page.locator('#bistu-key-status').textContent(), /重新检测/);
  assert.match(await page.locator('#bistu-key-count').textContent(), /1/);
  assert.equal(await page.evaluate(() => __balanceCalls.length), 2, 'editing a key does not silently make another request');
}));

test('panel: invalid settings focus the offending field and reset retains optional credentials', () => withPanel(async page => {
  await page.locator('#bistu-tab-settings').click();
  await page.locator('#bistu-edit-keys').click();
  await page.locator('#bistu-apikey').fill('synthetic-reset-key');
  await page.locator('#bistu-tab-settings').click();
  const defaultConcurrency = await page.locator('#bistu-setting-aiConcurrency').inputValue();
  assert.equal(await page.locator('#bistu-setting-includeHomework').inputValue(), 'disabled');
  const disabledHomeworkHint = await page.locator('#bistu-homework-status').textContent();
  await page.locator('#bistu-setting-includeHomework').selectOption('enabled');
  await page.locator('#bistu-tab-overview').click();
  assert.equal(await page.locator('#bistu-homework-status').isVisible(), true);
  const enabledHomeworkHint = await page.locator('#bistu-homework-status').textContent();
  assert.notEqual(enabledHomeworkHint, disabledHomeworkHint, 'explicit setting changes refresh the overview');
  await page.locator('#bistu-tab-settings').click();
  await page.locator('#bistu-setting-includeHomework').selectOption('disabled');
  await page.locator('#bistu-tab-overview').click();
  assert.equal(await page.locator('#bistu-homework-status').textContent(), disabledHomeworkHint);
  await page.locator('#bistu-tab-settings').click();
  await page.locator('#bistu-setting-aiConcurrency').fill('0');
  await page.locator('#bistu-tab-overview').click();
  await page.locator('#bistu-start-btn').click();
  await page.waitForFunction(() => document.querySelector('#bistu-feedback').textContent.trim());
  assert.equal(await page.locator('#bistu-feedback').getAttribute('role'), 'alert');
  assert.equal(await page.locator('#bistu-feedback').isVisible(), true);
  assert.equal(await page.locator('#bistu-panel-settings').isVisible(), true);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'bistu-setting-aiConcurrency');
  assert.equal(await page.evaluate(() => __ajaxCalls.length), 0);
  assert.equal(await page.locator('#bistu-start-btn').isEnabled(), true);
  await page.locator('#bistu-settings-reset').click();
  assert.equal(await page.locator('#bistu-setting-aiConcurrency').inputValue(), defaultConcurrency);
  assert.equal(await page.locator('#bistu-apikey').inputValue(), 'synthetic-reset-key');
  assert.equal(await page.evaluate(() => Object.values(__test.getSettings()).includes(undefined)), false);
  assert.equal(await page.locator('#bistu-setting-includeHomework').inputValue(), 'enabled');
  await page.locator('#bistu-tab-overview').click();
  assert.equal(await page.locator('#bistu-homework-status').isVisible(), true);
  assert.equal(await page.locator('#bistu-homework-status').textContent(), enabledHomeworkHint, 'reset defaults cannot retain the disabled-task caption');
}));

test('panel: filtered logs are literal, sanitized when copied, and clearing does not reset the task', () => withPanel(async page => {
  await page.evaluate(() => {
    __test.keyManager.updateKeys('synthetic-log-private-value');
    __test.setData([{GlobalUID:0,QuestionType:'Program',Title:'Keep task'}]);
    Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__copiedLog=text;}}});
    document.execCommand = command => {
      if (command !== 'copy') return false;
      window.__copiedLog = document.activeElement.value;
      return true;
    };
  });
  await addLogs(page, [['INFO_SENTINEL <img src=x onerror="window.__logInjected=true">','info'],
    ['WARNING_SENTINEL synthetic-log-private-value','warning'],['ERROR_SENTINEL','error']]);
  await page.locator('#bistu-tab-logs').click();
  assert.equal(await page.locator('#bistu-extractor-panel-log img').count(), 0);
  assert.equal(await page.evaluate(() => window.__logInjected || false), false);
  await page.locator('#bistu-log-filter').selectOption('error');
  assert.match(await page.locator('#bistu-extractor-panel-log').innerText(), /ERROR_SENTINEL/);
  assert.doesNotMatch(await page.locator('#bistu-extractor-panel-log').innerText(), /INFO_SENTINEL|WARNING_SENTINEL/);
  await page.locator('#bistu-log-copy').click();
  await page.waitForFunction(() => typeof __copiedLog === 'string');
  assert.match(await page.evaluate(() => __copiedLog), /ERROR_SENTINEL/);
  assert.doesNotMatch(await page.evaluate(() => __copiedLog), /INFO_SENTINEL|WARNING_SENTINEL|synthetic-log-private-value/);
  await page.locator('#bistu-log-filter').selectOption('all');
  assert.doesNotMatch(await page.locator('#bistu-extractor-panel-log').textContent(), /synthetic-log-private-value/);
  await page.locator('#bistu-log-clear').click();
  assert.equal(await page.locator('#bistu-extractor-panel-log .bistu-log-entry').count(), 0);
  assert.equal(await page.evaluate(() => __test.data[0].Title), 'Keep task');
}));

test('panel: reading older logs does not jump until following is explicitly enabled', () => withPanel(async page => {
  await page.locator('#bistu-tab-logs').click();
  await addLogs(page, Array.from({length:80},(_,index)=>['Synthetic log row '+index+' with enough text to create a scrolling log history.','info']));
  await page.locator('#bistu-log-follow').uncheck();
  await page.locator('#bistu-extractor-panel-log').evaluate(node => { node.scrollTop = 0; });
  await addLogs(page, [['AFTER_READING_OLDER_LOGS','warning']]);
  assert.ok(await page.locator('#bistu-extractor-panel-log').evaluate(node => node.scrollTop < 5));
  await page.locator('#bistu-log-follow').check();
  await addLogs(page, [['FOLLOWING_LATEST_LOG','info']]);
  assert.ok(await page.locator('#bistu-extractor-panel-log').evaluate(node => node.scrollHeight - node.clientHeight - node.scrollTop < 5));
}, {width:800,height:500}));

test('panel: start, safe pause, snapshot download, resume, final download and new task form one usable flow', () => withPanel(async page => {
  await page.evaluate(() => {
    window.__stageEntries = 0;
    __test.setEngineStage(1, async () => {
      __stageEntries++;
      if (__stageEntries === 1) await new Promise(resolve => { window.__releasePanelStage = resolve; });
      else __test.state.stage = 5;
    });
  });
  await page.locator('#bistu-start-btn').click(); await stateIs(page, 'running');
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#bistu-settings input,#bistu-settings select')].every(node => node.disabled)), true);
  await page.locator('#bistu-pause-btn').click(); await stateIs(page, 'stopping');
  assert.equal(await page.locator('#bistu-pause-btn').isEnabled(), false);
  assert.equal(await page.locator('#bistu-download-btn').isEnabled(), false);
  await page.evaluate(() => __releasePanelStage()); await stateIs(page, 'paused');
  assert.equal(await page.locator('#bistu-pause-btn').isEnabled(), true);
  assert.equal(await page.locator('#bistu-download-btn').isEnabled(), true);
  const dialogHandlers = page.listeners('dialog');
  page.removeAllListeners('dialog');
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#bistu-new-task').click();
  await stateIs(page, 'paused');
  assert.equal(await page.evaluate(() => __stageEntries), 1, 'cancelling replacement retains the paused task');
  assert.equal(await page.locator('#bistu-download-btn').isEnabled(), true, 'its unsaved ZIP remains available');
  for (const handler of dialogHandlers) page.on('dialog', handler);
  const pausedDownload = page.waitForEvent('download'); await page.locator('#bistu-download-btn').click();
  assert.match((await pausedDownload).suggestedFilename(), /\.zip$/);
  await page.locator('#bistu-pause-btn').click(); await stateIs(page, 'complete');
  assert.equal(await page.evaluate(() => __stageEntries), 2);
  for (let repeat=0;repeat<2;repeat++) {
    const download=page.waitForEvent('download'); await page.locator('#bistu-download-btn').click(); await download;
    assert.equal(await page.locator('#bistu-download-btn').isEnabled(), true);
  }
  await page.locator('#bistu-new-task').click(); await stateIs(page, 'ready');
  assert.equal(await page.locator('#bistu-start-btn').isVisible(), true);
  assert.equal(await page.locator('#bistu-start-btn').isEnabled(), true);
  assert.equal(await page.locator('#bistu-import-btn').isEnabled(), true);
  assert.equal(await page.evaluate(() => __test.data.length), 0);
}));

test('panel: changing protection or either password invalidates old ZIP and repacks without extraction or AI requests', () => withPanel(async page => {
  const downloads = []; page.on('download',download => downloads.push(download));
  await page.evaluate(async () => {
    __test.state.stage = 5; __test.state.isPaused = false;
    __test.setData([{GlobalUID:0,TopicGuid:'protection-repack-synthetic',QuestionType:'Program',Title:'SYNTHETIC_REPACK_CONTENT',DetailHtml:'<p>SYNTHETIC_REPACK_CONTENT</p>',SniffedAnswer:'class SyntheticRepack {}',AnswerSource:'platform-reference',s2_done:true,s3_done:true}]);
    window.__repackStageEntries=0;
    for(let stage=1;stage<=4;stage++) __test.setEngineStage(stage,async()=>{__repackStageEntries++;throw Error('Repack must never enter extraction stages');});
    window.__repackFetches=0; window.__fetch=async()=>{__repackFetches++;throw Error('Repack must never call external APIs');};
    await __test.buildZipAndDownload(true);
  });
  assert.equal(await page.evaluate(()=>__zips.length),1);
  await page.locator('#bistu-tab-settings').click();
  await page.locator('#bistu-setting-exportProtection').selectOption('password');
  assert.equal(await page.locator('#bistu-download-btn').textContent(),'重新生成 ZIP');
  await page.locator('#bistu-export-password').fill('Synthetic first export password');
  await page.locator('#bistu-export-password-confirm').fill('Synthetic first export password');
  await page.locator('#bistu-download-btn').click();
  await page.waitForFunction(()=>__zips.length===2&&!document.getElementById('bistu-download-btn').disabled);
  assert.match(await page.locator('#bistu-global-status').textContent(),/已提取 1 题/);
  assert.equal(downloads.length,0,'repack action cannot download the stale public blob');
  const encrypted = await page.evaluate(async()=>({state:JSON.parse(await __zips.at(-1).file('state.json').async('string')),html:await __zips.at(-1).file('index.html').async('string')}));
  assert.equal(encrypted.state.format,'bistu-encrypted');
  assert.ok(!encrypted.html.includes('SYNTHETIC_REPACK_CONTENT'));
  await page.locator('#bistu-export-password').fill('Synthetic second export password');
  assert.equal(await page.locator('#bistu-download-btn').textContent(),'重新生成 ZIP');
  await page.locator('#bistu-download-btn').click();
  assert.match(await page.locator('#bistu-feedback').textContent(),/不一致/);
  assert.equal(await page.evaluate(()=>__zips.length),2);
  await page.locator('#bistu-export-password-confirm').fill('Synthetic second export password');
  await page.locator('#bistu-download-btn').click();
  await page.waitForFunction(()=>__zips.length===3&&!document.getElementById('bistu-download-btn').disabled);
  const result=await page.evaluate(async()=>{
    const envelope=JSON.parse(await __zips.at(-1).file('state.json').async('string'));
    let oldRejected=false;try{await __test.bistuCrypto.decryptText(envelope,'Synthetic first export password','state');}catch(_){oldRejected=true;}
    const state=JSON.parse((await __test.bistuCrypto.decryptText(envelope,'Synthetic second export password','state')).text);
    return {oldRejected,title:state.allData[0].Title,serialized:JSON.stringify(state)};
  });
  assert.equal(result.oldRejected,true);assert.equal(result.title,'SYNTHETIC_REPACK_CONTENT');
  assert.ok(!result.serialized.includes('Synthetic second export password')&&!result.serialized.includes('protectionRevision'));
  await page.locator('#bistu-export-password-confirm').fill('Different confirmation only');
  assert.equal(await page.locator('#bistu-download-btn').textContent(),'重新生成 ZIP');
  await page.locator('#bistu-setting-exportProtection').selectOption('none');
  await page.locator('#bistu-download-btn').click();
  await page.waitForFunction(()=>__zips.length===4&&!document.getElementById('bistu-download-btn').disabled);
  assert.equal(await page.evaluate(async()=>JSON.parse(await __zips.at(-1).file('state.json').async('string')).allData[0].Title),'SYNTHETIC_REPACK_CONTENT');
  const event=page.waitForEvent('download');await page.locator('#bistu-download-btn').click();await event;
  assert.equal(downloads.length,1);
  assert.deepEqual(await page.evaluate(()=>({stages:__repackStageEntries,fetches:__repackFetches,platform:__ajaxCalls.length})),{stages:0,fetches:0,platform:0});
  await page.locator('#bistu-settings-reset').click();
  assert.equal(await page.locator('#bistu-download-btn').textContent(),'重新生成 ZIP');
}));

test('panel: a broken import reports visibly and a later snapshot replaces stale completion progress', () => withPanel(async page => {
  const errors=[]; page.on('pageerror',error=>errors.push(error.message));
  const chooser=page.waitForEvent('filechooser'); await page.locator('#bistu-import-btn').click();
  await (await chooser).setFiles({name:'bad.zip',mimeType:'application/zip',buffer:Buffer.from('invalid synthetic ZIP')});
  await page.waitForFunction(() => document.querySelector('#bistu-feedback').textContent.trim() && !document.querySelector('#bistu-import-btn').disabled);
  assert.equal(await page.locator('#bistu-feedback').isVisible(), true);
  assert.equal(await page.locator('#bistu-start-btn').isEnabled(), true);
  const state = await page.evaluate(async () => {
    // Complete the preceding task's real image stage, then import a snapshot
    // that must still finish AI before its one pending image can be downloaded.
    __test.state.stage = 4; __test.state.isPaused = false;
    await __test.runStage4();
    window.__previousImageStatus = document.querySelector('#bistu-val-4').textContent;
    window.__previousImageState = document.querySelector('#bistu-step-4').dataset.state;
    __test.setEngineStage(3, async () => {
      window.__importStageEntered = true;
      await new Promise(resolve => { window.__releaseImportedStage = resolve; });
      __test.state.isPaused = true;
    });
    __test.setBuilder(async()=>{window.__validImportFinished=true;});
    return {schemaVersion:1,globalState:{...__test.state,stage:3,isPaused:true},allData:[],
      imageQueueList:[['http://fixture.test/snapshot-pending.png',{filename:'img_1.png',downloaded:false}]],imgCounter:2};
  });
  assert.equal(await page.evaluate(() => __previousImageState), 'done');
  const zip=new JSZip(); zip.file('state.json',JSON.stringify(state));
  const valid=await zip.generateAsync({type:'nodebuffer'});
  await page.locator('#bistu-file-input').setInputFiles({name:'valid.zip',mimeType:'application/zip',buffer:valid});
  await page.waitForFunction(() => window.__importStageEntered);
  assert.equal(await page.locator('#bistu-step-4').getAttribute('data-state'), 'waiting');
  assert.match(await page.locator('#bistu-val-4').textContent(), /0\s*\/\s*1/);
  assert.notEqual(await page.locator('#bistu-val-4').textContent(), await page.evaluate(() => __previousImageStatus));
  assert.equal(await page.evaluate(() => __test.state.stage), 3);
  await page.evaluate(() => __releaseImportedStage());
  await page.waitForFunction(() => window.__validImportFinished && !document.querySelector('#bistu-import-btn').disabled);
  assert.equal(await page.locator('#bistu-file-input').inputValue(), '');
  assert.deepEqual(errors, []);
}));
