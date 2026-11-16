'use strict';
// Isolated engine/viewport contracts, not a physical iPhone memory-pressure test.
// The exporter runs in Chromium; every reader receives identical synthetic HTML.
const assert=require('node:assert/strict');
const {before,test}=require('node:test');
const {launch,createHarness}=require('./harness.cjs');

const profiles={
  iphone:{userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',platform:'iPhone',touchPoints:5,hasTouch:true,viewport:{width:390,height:844}},
  ipad:{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',platform:'MacIntel',touchPoints:5,hasTouch:false,viewport:{width:820,height:1180}},
  mac:{userAgent:'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15',platform:'MacIntel',touchPoints:0,hasTouch:false,viewport:{width:1280,height:900}},
  desktop:{userAgent:'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',platform:'Win32',touchPoints:0,hasTouch:false,viewport:{width:1280,height:900}}
};
let readerHtml,imageHtml,png;
before(async()=>{
  const browser=await launch('chromium'),harness=await createHarness(browser);
  try {
    const fixture=await harness.page.evaluate(async()=>{
      const rows=Array.from({length:32},(_,GlobalUID)=>({GlobalUID,TopicGuid:'apple-synthetic-'+GlobalUID,QuestionType:'Program',
        ChapterName:GlobalUID%2?'Synthetic odd':'Synthetic even',DegreeLevel:'简单',
        DetailHtml:Array.from({length:12},()=>'<p>Synthetic retained question '+GlobalUID+' body text.</p>').join(''),
        SniffedAnswer:'class Synthetic'+GlobalUID+' {\r\n    int n = '+GlobalUID+';\r\n}\r\n',AnswerSource:'platform-reference',s2_done:true}));
      __test.setData(rows);const plain=__test.generateOfflineHtml(true);
      const canvas=document.createElement('canvas');canvas.width=160;canvas.height=80;
      canvas.getContext('2d').fillRect(0,0,160,80);
      const buffer=await(await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer();
      await __test.validateImageBuffer(buffer,'image/png');
      __test.setImages(rows.map((row,index)=>['http://fixture.test/original-'+index+'.png',{filename:'img_'+index+'.png',buffer,downloaded:true}]));
      __test.setData(rows.map((row,index)=>({...row,DetailHtml:row.DetailHtml+'<img src="images/img_'+index+'.png" style="width:240px;height:120px" alt="Synthetic diagram '+index+'">'})));
      return {readerHtml:plain,imageHtml:__test.generateOfflineHtml(true),png:canvas.toDataURL('image/png').split(',')[1]};
    });
    ({readerHtml,imageHtml,png}=fixture);
  } finally {await harness.close();await browser.close();}
});

async function openReader(browser,profile,html=readerHtml,{withoutObserver=false,brokenImage=false}={}) {
  const context=await browser.newContext({viewport:profile.viewport,userAgent:profile.userAgent,hasTouch:profile.hasTouch});
  await context.addInitScript(({profile,withoutObserver})=>{
    Object.defineProperty(navigator,'platform',{configurable:true,get:()=>profile.platform});
    Object.defineProperty(navigator,'maxTouchPoints',{configurable:true,get:()=>profile.touchPoints});
    if(withoutObserver) Object.defineProperty(window,'IntersectionObserver',{configurable:true,value:undefined});
    window.__nativeModals=0;
    if(window.HTMLDialogElement?.prototype.showModal) {
      const original=HTMLDialogElement.prototype.showModal;
      HTMLDialogElement.prototype.showModal=function(...args){__nativeModals++;return original.apply(this,args);};
    }
  },{profile,withoutObserver});
  const page=await context.newPage(),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.origin==='http://fixture.test'&&url.pathname==='/apple-reader') return route.fulfill({contentType:'text/html',body:html});
    if(url.origin==='http://fixture.test'&&/^\/images\/img_\d+\.png$/.test(url.pathname)) {
      requests.push(url.pathname);
      if(brokenImage&&url.pathname==='/images/img_1.png') return route.fulfill({status:404,body:'Synthetic missing local image'});
      return route.fulfill({contentType:'image/png',body:Buffer.from(png,'base64')});
    }
    errors.push('Reader attempted an unconfigured network request: '+url.origin+url.pathname);
    return route.abort('blockedbyclient');
  });
  await page.goto('http://fixture.test/apple-reader',{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('#readerMode')&&document.querySelectorAll('.topic').length===32);
  return {page,errors,requests,close:()=>context.close()};
}
async function withBrowser(engine,fn) {
  let browser;
  const watchdog=setTimeout(()=>{void browser?.close().catch(()=>{});},85000);
  try {browser=await launch(engine);await fn(browser);}
  finally {clearTimeout(watchdog);await browser?.close();}
}
async function settle(page) {await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));}
async function changeMode(page,value) {
  await page.evaluate(value=>{const select=document.querySelector('#readerMode');select.value=value;select.dispatchEvent(new Event('change',{bubbles:true}));},value);
  await settle(page);
}

for(const engine of ['chromium','webkit']) {
  test(engine+': Apple compatibility auto detection distinguishes touch iPads from ordinary desktop Macs',{timeout:90000},()=>withBrowser(engine,async browser=>{
    for(const [name,profile] of Object.entries(profiles)) {
      const viewer=await openReader(browser,profile);
      try {
        const page=viewer.page;
        assert.equal(await page.locator('#readerMode').inputValue(),'auto',name);
        assert.equal(await page.locator('body').evaluate(body=>body.classList.contains('reader-compat')),name==='iphone'||name==='ipad',name);
        assert.equal(await page.locator('.topic').count(),32,name);
        assert.equal(await page.locator('#mobileControls').isVisible(),profile.viewport.width<768,name);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name);
        assert.deepEqual(viewer.errors,[],name);
      } finally {await viewer.close();}
    }
  }));

  test(engine+': manual reader modes preserve filters, answers, scroll position and iPad desktop layouts',{timeout:90000},()=>withBrowser(engine,async browser=>{
    const viewer=await openReader(browser,profiles.ipad);
    try {
      const page=viewer.page;
      await page.locator('#chapterFilter').selectOption('Synthetic even');
      await page.locator('#toggleAnsBtn').click();
      await page.evaluate(()=>{window.__readerIdentity={};window.scrollTo(0,2500);});await settle(page);
      const initial=await page.evaluate(()=>({scroll:scrollY,count:document.querySelector('#visibleCount').textContent,answers:document.querySelectorAll('.answer-box:not([hidden])').length}));
      for(const mode of ['standard','compat','auto']) {
        await changeMode(page,mode);
        const state=await page.evaluate(()=>({identity:!!window.__readerIdentity,scroll:scrollY,chapter:document.querySelector('#chapterFilter').value,
          count:document.querySelector('#visibleCount').textContent,answers:document.querySelectorAll('.answer-box:not([hidden])').length}));
        assert.equal(state.identity,true);assert.equal(state.chapter,'Synthetic even');assert.equal(state.count,initial.count);assert.equal(state.answers,initial.answers);
        assert.ok(Math.abs(state.scroll-initial.scroll)<3,'mode changes do not move the reading position');
      }
      for(const viewport of [{width:768,height:1024},{width:1024,height:768},{width:820,height:1180},{width:1180,height:820}]) {
        await page.setViewportSize(viewport);
        await page.waitForFunction(()=>document.querySelector('#readerSidebar').parentElement.classList.contains('app-layout'));
        assert.equal(await page.locator('#mobileControls').isVisible(),false);assert.equal(await page.locator('#readerSidebar').isVisible(),true);
        assert.equal(await page.locator('#readerSidebar').evaluate(node=>getComputedStyle(node).position),'sticky');
        assert.equal(await page.locator('#chapterFilter').inputValue(),'Synthetic even');assert.equal(await page.locator('#visibleCount').textContent(),'16');
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      }
      assert.deepEqual(viewer.errors,[]);
    } finally {await viewer.close();}
  }));

  test(engine+': compatible phone drawer avoids native modal, root locks and inert while keeping keyboard isolation',{timeout:90000},()=>withBrowser(engine,async browser=>{
    const viewer=await openReader(browser,profiles.iphone);
    try {
      const page=viewer.page;
      await page.evaluate(()=>window.scrollTo(0,2400));await settle(page);
      const start=await page.evaluate(()=>scrollY);
      await page.locator('#mobileControls').click();await settle(page);
      assert.equal(await page.locator('#mobileControls').getAttribute('aria-expanded'),'true');
      const locks=await page.evaluate(()=>({modals:__nativeModals,bodyPosition:getComputedStyle(document.body).position,
        bodyOverflow:getComputedStyle(document.body).overflowY,rootOverflow:getComputedStyle(document.documentElement).overflowY,
        inert:document.querySelectorAll('[inert]').length,focus:document.activeElement.id,background:document.querySelector('.app-layout').getAttribute('aria-hidden')}));
      assert.equal(locks.modals,0);assert.notEqual(locks.bodyPosition,'fixed');assert.notEqual(locks.bodyOverflow,'hidden');assert.notEqual(locks.rootOverflow,'hidden');assert.equal(locks.inert,0);
      assert.equal(locks.focus,'drawerClose');assert.equal(locks.background,'true');
      assert.equal(await page.evaluate(()=>{
        const background=document.querySelector('.app-layout');
        const touch=(type,y)=>{const event=new Event(type,{bubbles:true,cancelable:true});Object.defineProperty(event,'touches',{value:[{clientY:y}]});return event;};
        background.dispatchEvent(touch('touchstart',200));const move=touch('touchmove',100);background.dispatchEvent(move);return move.defaultPrevented;
      }),true,'background touch scrolling is blocked while the compatible drawer is open');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await page.evaluate(()=>document.querySelector('#mobileDrawer').contains(document.activeElement)),true);
      await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'drawerClose');
      await page.locator('#keywordFilter').fill('Synthetic retained');
      await page.keyboard.press('Escape');assert.equal(await page.locator('#keywordFilter').inputValue(),'');assert.equal(await page.locator('#mobileControls').getAttribute('aria-expanded'),'true');
      await page.keyboard.press('Escape');await settle(page);
      assert.equal(await page.locator('#mobileControls').getAttribute('aria-expanded'),'false');assert.equal(await page.evaluate(()=>document.activeElement.id),'mobileControls');
      assert.ok(Math.abs(await page.evaluate(()=>scrollY)-start)<3);assert.equal(await page.locator('.app-layout').getAttribute('aria-hidden'),null);
      await page.locator('#mobileControls').click();await page.locator('#drawerBackdrop').click({position:{x:2,y:2}});
      assert.equal(await page.locator('#mobileControls').getAttribute('aria-expanded'),'false');
      assert.deepEqual(viewer.errors,[]);
    } finally {await viewer.close();}
  }));

  test(engine+': compatible images recycle offscreen without layout loss and restore fully for explicit printing',{timeout:90000},()=>withBrowser(engine,async browser=>{
    const viewer=await openReader(browser,profiles.iphone,imageHtml,{brokenImage:true});
    try {
      const page=viewer.page,first=page.locator('.detail-box img').first(),last=page.locator('.topic').last();
      await page.waitForFunction(()=>document.querySelector('.detail-box img')?.naturalWidth===160);
      await page.locator('.topic').nth(1).scrollIntoViewIfNeeded();
      await page.waitForFunction(()=>document.querySelectorAll('.img-failed').length===1);
      await page.evaluate(()=>window.scrollTo(0,0));await settle(page);
      await page.waitForFunction(()=>/^data:image\/svg\+xml/.test(document.querySelector('.topic:last-child .detail-box img')?.getAttribute('src')||''));
      const initial=await page.evaluate(()=>({height:document.documentElement.scrollHeight,last:document.querySelector('.topic:last-child').offsetTop,images:document.querySelectorAll('.detail-box img').length}));
      assert.ok(viewer.requests.length<32,'compatibility mode does not immediately load every distant image');
      assert.equal(await page.locator('.img-failed').count(),1,'only the actual missing local file produces a broken-image notice');
      assert.equal(await page.locator('.topic').nth(1).locator('.image-retry').count(),1);
      await last.scrollIntoViewIfNeeded();
      await page.waitForFunction(()=>document.querySelector('.topic:last-child .detail-box img')?.naturalWidth===160&&!/^data:image\/svg\+xml/.test(document.querySelector('.topic:last-child .detail-box img').getAttribute('src')));
      await page.waitForFunction(()=>/^data:image\/svg\+xml/.test(document.querySelector('.detail-box img')?.getAttribute('src')||''));
      const after=await page.evaluate(()=>({height:document.documentElement.scrollHeight,last:document.querySelector('.topic:last-child').offsetTop}));
      assert.ok(Math.abs(after.height-initial.height)<3);assert.ok(Math.abs(after.last-initial.last)<3);
      await page.evaluate(()=>window.scrollTo(0,0));
      await page.waitForFunction(()=>document.querySelector('.detail-box img')?.naturalWidth===160&&!/^data:image\/svg\+xml/.test(document.querySelector('.detail-box img').getAttribute('src')));
      assert.equal(await first.getAttribute('alt'),'Synthetic diagram 0');
      await page.evaluate(()=>{window.__prints=[];window.print=()=>__prints.push([...document.querySelectorAll('.detail-box img')].every(image=>image.complete&&image.naturalWidth===160&&!/^data:image\/svg\+xml/.test(image.getAttribute('src'))));});
      await page.locator('#mobileControls').click();await page.locator('#printBtn').click();
      await page.waitForFunction(()=>window.__prints.length===1&&!document.querySelector('#printBtn').disabled);
      assert.deepEqual(await page.evaluate(()=>__prints),[true]);
      assert.equal(await page.locator('.topic').count(),32);assert.equal(await page.locator('#mobileControls').getAttribute('aria-expanded'),'false');
      await page.evaluate(()=>window.dispatchEvent(new Event('afterprint')));await settle(page);
      assert.deepEqual(viewer.errors,[]);
    } finally {await viewer.close();}
    // Missing IntersectionObserver keeps the original image URLs usable.
    const fallback=await openReader(browser,profiles.iphone,imageHtml,{withoutObserver:true});
    try {
      assert.equal(await fallback.page.locator('.detail-box img').evaluateAll(images=>images.some(image=>/^data:image\/svg\+xml/.test(image.getAttribute('src')||''))),false);
      await fallback.page.locator('.topic').last().scrollIntoViewIfNeeded();
      await fallback.page.waitForFunction(()=>document.querySelector('.topic:last-child .detail-box img')?.naturalWidth===160);
      assert.deepEqual(fallback.errors,[]);
    } finally {await fallback.close();}
  }));
}
