'use strict';
// Small offline-reader compatibility contract. WebKit here is an isolated engine,
// not a claim that iOS Safari hardware, memory limits or native printing were tested.
const assert = require('node:assert/strict');
const { before, test } = require('node:test');
const { launch, createHarness } = require('./harness.cjs');

let coldImageExport;
before(async () => {
  // Extraction runs in Chrome. All reader engines consume the identical export,
  // so WebKit's blob handling in the extractor is not part of this reader test.
  const builder = await launch('chromium');
  const harness = await createHarness(builder);
  try {
    coldImageExport = await harness.page.evaluate(async () => {
      const canvas=document.createElement('canvas');canvas.width=40;canvas.height=20;canvas.getContext('2d').fillRect(0,0,40,20);
      const buffer=await(await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer();
      await __test.validateImageBuffer(buffer,'image/png');
      __test.setImages([1,2].map(index=>['http://fixture.test/engine-'+index+'.png',{filename:'img_'+index+'.png',downloaded:true,buffer}]));
      __test.setData([{GlobalUID:0,QuestionType:'Blank',DetailHtml:'<p>Cold print question</p><img src="images/img_1.png"><img src="images/img_2.png">'}]);
      return {html:__test.generateOfflineHtml(true),png:canvas.toDataURL('image/png').split(',')[1]};
    });
  } finally { await harness.close(); await builder.close(); }
});

const program = '\r\nclass Synthetic {\r\n    String s = "&lt;literal&gt; & <tag>";\r\n}\r\n';
function fixture() {
  return [
    {QuestionType:'Single',ChapterName:'Single-choice',DegreeLevel:'简单',DetailHtml:'<p>alpha beta</p>',SniffedAnswer:'Original synthetic answer'},
    {QuestionType:'Multiple',ChapterName:'基础',DegreeLevel:'中等',DetailHtml:'<p>alpha middle beta</p>',SniffedAnswer:'A + B'},
    {QuestionType:'TrueOrFalse',ChapterName:'基础',DegreeLevel:'简单',DetailHtml:'<p>Gamma comparison</p>',SniffedAnswer:'正确'},
    {QuestionType:'Blank',ChapterName:'字符串',DegreeLevel:'困难',DetailHtml:'<p>Delta blank</p>',SniffedAnswer:'OnlyAnswerNeedle',IsAIAnswer:true},
    {QuestionType:'Program',ChapterName:'Programming',DegreeLevel:'一般',DetailHtml:'<p>Program prompt</p>',SniffedAnswer:program,AnswerSource:'platform-reference'},
    {QuestionType:'Single',ChapterName:'缺项',DegreeLevel:'无',DetailHtml:'<p>Retained source placeholder</p>',ExtractionWarning:'Synthetic source warning'}
  ].map((row,GlobalUID)=>({GlobalUID,TopicGuid:'engine-fixture-'+GlobalUID,s2_done:true,IsAIAnswer:false,...row}));
}

async function withViewer(engine, fn, mobile = false) {
  let browser, harness;
  const watchdog=setTimeout(()=>{ if(browser) void browser.close().catch(()=>{}); },85000);
  try {
    browser = await launch(engine);
    harness = await createHarness(browser, undefined, undefined, mobile
      ? {viewport:{width:390,height:844},hasTouch:true,...(engine==='firefox'?{}:{isMobile:true}),deviceScaleFactor:2}
      : {viewport:{width:1440,height:900}});
    const errors=[]; harness.page.on('pageerror',error=>errors.push(error.message));
    await fn(harness.page);
    assert.deepEqual(errors,[]);
  } finally { clearTimeout(watchdog); await harness?.close(); await browser?.close(); }
}
async function render(page, rows = fixture()) {
  const html = await page.evaluate(data=>{__test.setData(data);return __test.generateOfflineHtml(true);},rows);
  await page.setContent(html,{waitUntil:'domcontentloaded'});
}
async function query(page, text, count) {
  await page.locator('#keywordFilter').fill(text);
  await page.waitForTimeout(180);
  await page.waitForFunction(expected=>document.querySelector('#visibleCount').textContent===String(expected),count);
}

for (const engine of ['chromium','firefox','webkit']) {
  test(engine+': offline source, type, chapter, difficulty and both search modes preserve answer state',{timeout:90000},()=>withViewer(engine,async page=>{
    await render(page);
    assert.equal(await page.locator('.topic').count(),6);
    await page.locator('#sourceFilter').selectOption('illinois');
    assert.equal(await page.locator('#visibleCount').textContent(),'2');
    await page.locator('#chapterFilter').selectOption('Programming');
    assert.equal(await page.locator('#visibleCount').textContent(),'1');
    await page.locator('#typeFilter').selectOption('Program');
    await page.locator('#diffFilter').selectOption('简单');
    assert.equal(await page.locator('#visibleCount').textContent(),'0');
    await page.locator('.empty-reset').click();
    const expectedCounts={Single:2,Multiple:1,TrueOrFalse:1,Blank:1,Program:1};
    for(const [type,count] of Object.entries(expectedCounts)) {
      await page.locator('#typeFilter').selectOption(type);
      assert.equal(await page.locator('#visibleCount').textContent(),String(count));
    }
    await page.locator('#resetFilters').click();
    await query(page,'alpha beta',2);
    await page.locator('#searchMatch').selectOption('phrase');
    assert.equal(await page.locator('#visibleCount').textContent(),'1');
    await page.locator('#searchMatch').selectOption('terms');
    assert.equal(await page.locator('#visibleCount').textContent(),'2');
    await page.locator('#toggleAnsBtn').click();
    assert.equal(await page.locator('.answer-box:not([hidden])').count(),0);
    await query(page,'OnlyAnswerNeedle',1);
    await page.locator('#searchScope').selectOption('prompt');
    assert.equal(await page.locator('#visibleCount').textContent(),'0');
    await page.locator('#searchScope').selectOption('full');
    assert.equal(await page.locator('#visibleCount').textContent(),'1');
    assert.equal(await page.locator('.answer-box:not([hidden])').count(),0);
    await page.locator('#resetFilters').click();
    await page.locator('.answer-toggle').first().click();
    assert.equal(await page.locator('.answer-box:not([hidden])').count(),1);
    await page.locator('#toggleAnsBtn').click();
    assert.equal(await page.locator('.answer-box:not([hidden])').count(),0);
    await page.locator('#toggleAnsBtn').click();
    assert.equal(await page.locator('.answer-box:not([hidden])').count(),5);
    assert.equal(await page.locator('.extraction-warning').isVisible(),true);
    await page.locator('#themeToggle').selectOption('dark');
    assert.equal(await page.locator('body').evaluate(body=>body.classList.contains('dark-mode')),true);
  }));

  test(engine+': mobile reader retains exact program copying and access to the last question',{timeout:90000},()=>withViewer(engine,async page=>{
    const marker='SyntheticEngineLastQuestionMarker';
    const rows=Array.from({length:60},(_,GlobalUID)=>({GlobalUID,QuestionType:'Program',ChapterName:'Programming',DegreeLevel:'一般',
      DetailHtml:'<p>'+(GlobalUID===59?marker:'Synthetic long reader question')+'</p>',SniffedAnswer:program+'// '+GlobalUID+'\r\n',AnswerSource:'platform-reference'}));
    await render(page,rows);
    assert.equal(await page.locator('#mobileControls').isVisible(),true);
    assert.equal(await page.locator('#keywordFilter').isVisible(),false);
    await page.locator('#mobileControls').click();
    assert.equal(await page.locator('#mobileControls').getAttribute('aria-expanded'),'true');
    assert.equal(await page.locator('#visibleCount').isVisible(),true);
    assert.equal(await page.locator('#toggleAnsBtn').isVisible(),true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#keywordFilter').isVisible(),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'mobileControls');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.evaluate(()=>{window.__engineCopies=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>__engineCopies.push(text)}});});
    await page.locator('.copy-btn').first().click();
    assert.deepEqual(await page.evaluate(()=>__engineCopies),[rows[0].SniffedAnswer]);
    const find=await page.evaluate(text=>{
      if(typeof window.find!=='function') return {supported:false};
      getSelection().removeAllRanges();return {supported:true,found:window.find(text,false,false,true),selected:getSelection().toString()};
    },marker);
    if(find.supported) {assert.equal(find.found,true);assert.equal(find.selected,marker);}
    const last=page.locator('.topic').last(); await last.scrollIntoViewIfNeeded();
    assert.match(await last.locator('.detail-box').textContent(),/SyntheticEngineLastQuestionMarker/);
    await last.locator('.copy-btn').click();
    assert.equal(await page.evaluate(()=>__engineCopies.at(-1)),rows.at(-1).SniffedAnswer);
    await page.keyboard.press('Control+k');
    await page.waitForFunction(()=>document.activeElement.id==='keywordFilter');
    await query(page,marker,1);
    assert.equal(await page.locator('.topic:not(.hidden) .code-box').textContent(),rows.at(-1).SniffedAnswer);
    // Viewport coverage only; these are not claims of physical iPad/iPhone tests.
    for(const viewport of [{width:844,height:390},{width:390,height:844},
      {width:768,height:1024},{width:1024,height:768},
      {width:820,height:1180},{width:1180,height:820},{width:390,height:844}]) {
      await page.setViewportSize(viewport);
      if(viewport.width>=768) {
        await page.waitForFunction(()=>!document.querySelector('#mobileDrawer').open&&document.querySelector('#readerSidebar').parentElement.classList.contains('app-layout'));
        assert.equal(await page.locator('#mobileControls').isVisible(),false);
        assert.equal(await page.locator('#keywordFilter').isVisible(),true);
        assert.equal(await page.locator('#readerSidebar').evaluate(sidebar=>getComputedStyle(sidebar).position),'sticky');
      } else {
        await page.waitForFunction(()=>document.querySelector('#mobileControls').getBoundingClientRect().width>0&&document.querySelector('#readerSidebar').parentElement.id==='drawerContent'&&!document.querySelector('#mobileDrawer').open);
        assert.equal(await page.locator('#keywordFilter').isVisible(),false);
        await page.locator('#mobileControls').click();
      }
      assert.equal(await page.locator('#keywordFilter').inputValue(),marker);
      assert.equal(await page.locator('#visibleCount').textContent(),'1');
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      assert.equal(await page.locator('.topic').count(),60);
      if(viewport.width<768) await page.locator('#drawerClose').click();
    }
    await page.locator('#mobileControls').click();
    await page.locator('#clearSearch').click();
    assert.equal(await page.locator('#visibleCount').textContent(),'60');
    await page.locator('#drawerClose').click();
  },true));

  test(engine+': cold local images finish before explicit printing and print layout retains content',{timeout:90000},()=>withViewer(engine,async page=>{
    const fixtureData=coldImageExport;
    let release;const gate=new Promise(resolve=>{release=resolve;});
    await page.route('**/images/*.png',async route=>{await gate;await route.fulfill({contentType:'image/png',body:Buffer.from(fixtureData.png,'base64')});});
    try {
      await page.setContent(fixtureData.html,{waitUntil:'domcontentloaded'});
      await page.evaluate(()=>{window.__enginePrints=[];window.print=()=>__enginePrints.push([...document.querySelectorAll('.detail-box img')].every(image=>image.complete&&image.naturalWidth===40));});
      assert.equal(await page.locator('.detail-box img').evaluateAll(images=>images.every(image=>!image.complete)),true);
      await page.locator('#printBtn').click();
      assert.equal(await page.evaluate(()=>__enginePrints.length),0);
      release();
      await page.waitForFunction(()=>__enginePrints.length===1&&!document.querySelector('#printBtn').disabled);
      assert.deepEqual(await page.evaluate(()=>__enginePrints),[true]);
      await page.emulateMedia({media:'print'});
      assert.equal(await page.locator('.sidebar').isVisible(),false);
      assert.match(await page.locator('.detail-box').textContent(),/Cold print question/);
      assert.equal(await page.locator('.detail-box img').count(),2);
    } finally {release();}
  }));
}
