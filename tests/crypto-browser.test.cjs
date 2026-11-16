'use strict';
const {before,after,test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const JSZip = require('jszip');
const {launch,createHarness,sourcePath} = require('./harness.cjs');
let browser;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });
function instrument() {
  const source = fs.readFileSync(sourcePath,'utf8'), end = source.lastIndexOf('})();');
  return source.slice(0,end) + 'window.__cryptoTest={bistuCrypto,generateProtectedHtml};\n' + source.slice(end);
}

test('HTTP locked reader rejects wrong passwords, unlocks locally, survives tab visibility and relocks after reload/BFCache',async () => {
  const h = await createHarness(browser,instrument());
  let context;
  try {
    const html = await h.page.evaluate(async () => {
      __test.setData([{GlobalUID:0,TopicGuid:'synthetic-locked-program',QuestionType:'Program',Title:'PRIVATE_SYNTHETIC_PROMPT',DetailHtml:'<p>PRIVATE_SYNTHETIC_PROMPT</p>',SniffedAnswer:'class PrivateSyntheticAnswer {}',AnswerSource:'platform-reference',s2_done:true,s3_done:true}]);
      const session = await __cryptoTest.bistuCrypto.createSession('Synthetic protected reader password');
      return await __cryptoTest.generateProtectedHtml(__test.generateOfflineHtml(true),session);
    });
    assert.ok(!html.includes('PRIVATE_SYNTHETIC_PROMPT') && !html.includes('class PrivateSyntheticAnswer'));
    context = await browser.newContext();
    await context.addInitScript(() => {
      window.__storageWrites = [];
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key,value) { window.__storageWrites.push([key,value]); return original.call(this,key,value); };
    });
    const requests = [], errors = [];
    await context.route('**/*',route => route.request().url() === 'http://reader.test/bank/index.html'
      ? route.fulfill({contentType:'text/html',body:html}) : (requests.push(route.request().url()),route.abort()));
    const page = await context.newPage(); page.on('pageerror',error => errors.push(error.message));
    await page.goto('http://reader.test/bank/index.html');
    assert.equal((await page.locator('body').innerText()).trim(),'解锁并阅读','idle lock screen keeps only the input and action visible');
    assert.equal(await page.getByRole('textbox',{name:'导出密码'}).count(),1,'minimal input retains its accessible name');
    assert.equal(await page.evaluate(() => !!crypto.subtle),false,'real non-secure HTTP uses the bundled fallback');
    assert.equal(await page.locator('#unlockPassword').getAttribute('autocomplete'),'off');
    await page.locator('#unlockPassword').fill('Wrong synthetic reader password'); await page.locator('#unlockSubmit').click();
    await page.waitForFunction(() => document.getElementById('unlockStatus').textContent.includes('密码错误'));
    assert.equal(await page.locator('.topic').count(),0);
    assert.equal(await page.locator('#unlockPassword').inputValue(),'');
    await page.locator('#unlockPassword').fill('Synthetic protected reader password'); await page.locator('#unlockSubmit').click();
    await page.waitForSelector('.topic');
    assert.match(await page.locator('.topic-body').textContent(),/PRIVATE_SYNTHETIC_PROMPT/);
    assert.equal(await page.evaluate(() => window.__BISTU_UNLOCK_KEY__ === undefined),true);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    assert.equal(await page.locator('.topic').count(),1);
    assert.deepEqual(await page.evaluate(() => __storageWrites),[]);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));
    assert.equal(await page.locator('.topic').count(),0);
    assert.match(await page.locator('body').textContent(),/已锁定/);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await page.waitForSelector('#unlockPassword');
    assert.equal(await page.locator('#unlockPassword').inputValue(),'');
    assert.equal(await page.locator('.topic').count(),0);
    await page.reload(); assert.equal(await page.locator('#unlockPassword').inputValue(),'');
    assert.deepEqual(requests,[]); assert.deepEqual(errors,[]);
  } finally { await context?.close(); await h.close(); }
});

test('wrong encrypted snapshot password leaves the current task unchanged and a correct retry restores it',async () => {
  const h = await createHarness(browser,instrument());
  try {
    const envelope = await h.page.evaluate(async () => {
      const snapshot = {schemaVersion:1,globalState:{stage:5,isPaused:true,outOfKeys:false,elapsedSeconds:12,listProgress:{typeIndex:0,pageIndex:1,totalPages:0},scope:{language:'Java',degree:'',chapter:'',knowledge:'',search:'',origin:'http://fixture.test'}},allData:[{GlobalUID:0,TopicGuid:'synthetic-imported',QuestionType:'Program',Title:'Imported synthetic task',DetailHtml:'<p>Imported synthetic task</p>',s2_done:true,s3_done:false}],imageQueueList:[],imgCounter:1};
      __test.setData([{GlobalUID:0,TopicGuid:'synthetic-existing',QuestionType:'Program',Title:'Existing synthetic task',s2_done:false}]);
      __test.state.stage = 2;
      window.__importBuilds = 0; __test.setBuilder(async () => { __importBuilds++; });
      const session = await __cryptoTest.bistuCrypto.createSession('Synthetic snapshot password');
      return __cryptoTest.bistuCrypto.encryptText(JSON.stringify(snapshot),session,'state');
    });
    const zip = new JSZip(); zip.file('state.json',JSON.stringify(envelope));
    const buffer = await zip.generateAsync({type:'nodebuffer'});
    const upload = async password => {
      await h.page.evaluate(value => { document.getElementById('bistu-export-password').value = value; },password);
      await h.page.locator('#bistu-file-input').setInputFiles({name:'synthetic-encrypted.zip',mimeType:'application/zip',buffer});
    };
    await upload('Wrong synthetic snapshot password');
    await h.page.waitForFunction(() => !document.getElementById('bistu-import-btn').disabled && document.getElementById('bistu-feedback').textContent.includes('密码错误'));
    assert.deepEqual(await h.page.evaluate(() => ({title:__test.data[0].Title,stage:__test.state.stage,builds:__importBuilds})),{title:'Existing synthetic task',stage:2,builds:0});
    await upload('Synthetic snapshot password');
    await h.page.waitForFunction(() => __importBuilds === 1 && !document.getElementById('bistu-import-btn').disabled);
    assert.equal(await h.page.evaluate(() => __test.data[0].Title),'Imported synthetic task');
    const logs = await h.page.locator('#bistu-extractor-panel-log').textContent();
    assert.ok(!logs.includes('Synthetic snapshot password') && !logs.includes('Wrong synthetic snapshot password'));
  } finally { await h.close(); }
});

test('snapshot export-password preflight rolls back before any request, while public snapshots still restore',async () => {
  const h=await createHarness(browser,instrument());
  try {
    const snapshot=await h.page.evaluate(()=>{
      __test.setData([{GlobalUID:0,TopicGuid:'synthetic-kept',QuestionType:'Program',Title:'Keep existing task',s2_done:false}]);
      __test.state.stage=2;__test.state.isPaused=true;
      window.__resumeStages=0;window.__resumeBuilds=0;window.__fetchCount=0;
      __test.setEngineStage(2,async()=>{__resumeStages++;__test.state.stage=5;});
      __test.setBuilder(async()=>{__resumeBuilds++;});
      window.__fetch=async()=>{__fetchCount++;throw new Error('No request expected');};
      return {schemaVersion:1,globalState:{...__test.state,settings:{...__test.getSettings(),exportProtection:'password'}},
        allData:[{GlobalUID:0,TopicGuid:'synthetic-new-import',QuestionType:'Program',Title:'New imported task',s2_done:false}],imageQueueList:[],imgCounter:1};
    });
    const upload=async protection=>{
      snapshot.globalState.settings.exportProtection=protection;
      const zip=new JSZip();zip.file('state.json',JSON.stringify(snapshot));
      await h.page.locator('#bistu-file-input').setInputFiles({name:'synthetic-preflight.zip',mimeType:'application/zip',buffer:await zip.generateAsync({type:'nodebuffer'})});
    };
    for (const [password,confirmation,notice] of [['short','short','12–256'],['Synthetic valid export password','','不一致']]) {
      await h.page.evaluate(([password,confirmation])=>{
        document.getElementById('bistu-export-password').value=password;
        document.getElementById('bistu-export-password-confirm').value=confirmation;
      },[password,confirmation]);
      await upload('password');
      await h.page.waitForFunction(text=>!document.getElementById('bistu-import-btn').disabled&&document.getElementById('bistu-feedback').textContent.includes(text),notice);
      assert.deepEqual(await h.page.evaluate(()=>({title:__test.data[0].Title,stage:__test.state.stage,mode:__test.getSettings().exportProtection,
        stages:__resumeStages,builds:__resumeBuilds,ajax:__ajaxCalls.length,fetch:__fetchCount})),
        {title:'Keep existing task',stage:2,mode:'none',stages:0,builds:0,ajax:0,fetch:0});
    }
    await upload('none');
    await h.page.waitForFunction(()=>__resumeBuilds===1&&!document.getElementById('bistu-import-btn').disabled);
    assert.deepEqual(await h.page.evaluate(()=>({title:__test.data[0].Title,stages:__resumeStages,ajax:__ajaxCalls.length,fetch:__fetchCount})),
      {title:'New imported task',stages:1,ajax:0,fetch:0});
  } finally {await h.close();}
});
