'use strict';
// Fully synthetic transport and engine recovery; no live school or AI requests.
const assert = require('node:assert/strict');
const {before,after,test} = require('node:test');
const {launch,createHarness} = require('./harness.cjs');
let browser;
before(async()=>{browser=await launch();});
after(async()=>{await browser?.close();});
async function withPage(fn) {
  const h=await createHarness(browser);
  try {return await fn(h.page);} finally {await h.close();}
}
async function oneType(page) {
  await page.evaluate(()=>{
    document.querySelector('#select_QuestionType').innerHTML='<option value="1">单选题</option>';
    __setSettings({listConcurrency:1,platformDelayMs:0,platformRetryDelayMs:0});
    __test.initializePlatformVariables();__test.state.isPaused=false;
  });
}

test('recovery: transient platform reads retain one cursor and succeed on the sixth permitted attempt',()=>withPage(async page=>{
  await oneType(page);
  const result=await page.evaluate(async()=>{
    const statuses=[0,408,429,500,503],calls=[];
    $.ajax=options=>{
      calls.push({method:options.type,page:options.data.pageIndex});
      queueMicrotask(()=>calls.length<=statuses.length
        ? options.error({status:statuses[calls.length-1]},'error')
        : options.success({Total:1,DataList:[{TopicGuid:'synthetic-retry',QuestionType:'Single',Title:'Synthetic retry item'}]}));
    };
    await __test.runStage1();
    return{attempts:__test.getSettings().platformAttempts,calls,stage:__test.state.stage,cursor:__test.state.listProgress.pageIndex,ids:__test.data.map(item=>item.TopicGuid)};
  });
  assert.equal(result.attempts,6);
  assert.equal(result.calls.length,6);
  assert.ok(result.calls.every(call=>call.method==='post'&&call.page===1));
  assert.equal(result.stage,2);
  assert.deepEqual(result.ids,['synthetic-retry']);
}));

test('recovery: permanent platform authorization and missing-resource errors are not automatically repeated',()=>withPage(async page=>{
  await oneType(page);
  const results=await page.evaluate(async()=>{
    const results=[];
    for(const status of [400,401,403,404]) {
      let calls=0,error='';
      $.ajax=options=>{calls++;queueMicrotask(()=>options.error({status},'error'));};
      try{await __test.runStage1();}catch(failure){error=failure.message;}
      results.push({status,calls,error,count:__test.data.length,cursor:__test.state.listProgress.pageIndex,stage:__test.state.stage});
    }
    return results;
  });
  for(const row of results){assert.equal(row.calls,1,String(row.status));assert.match(row.error,new RegExp(String(row.status)));assert.equal(row.count,0);assert.equal(row.cursor,1);assert.equal(row.stage,1);}
}));

test('recovery: a manual pause interrupts platform backoff before another request can start',()=>withPage(async page=>{
  await oneType(page);
  const result=await page.evaluate(async()=>{
    __setSettings({platformRetryDelayMs:2000});
    let calls=0;
    $.ajax=options=>{calls++;queueMicrotask(()=>{options.error({status:503},'error');setTimeout(()=>{__test.state.isPaused=true;},20);});};
    const outcome=await Promise.race([
      __test.runStage1().then(()=>({settled:true}),error=>({settled:true,error:error.message})),
      new Promise(resolve=>setTimeout(()=>resolve({settled:false}),800))
    ]);
    return{outcome,calls,paused:__test.state.isPaused,count:__test.data.length,cursor:__test.state.listProgress.pageIndex};
  });
  assert.equal(result.outcome.settled,true,'pause must interrupt the two-second backoff, not wait for its expiry');
  assert.equal(result.paused,true);assert.equal(result.calls,1);assert.equal(result.count,0);assert.equal(result.cursor,1);
}));

test('recovery: answer verification writes stay single-attempt even when read retries are enabled',()=>withPage(async page=>{
  const result=await page.evaluate(async()=>{
    __setSettings({platformAttempts:6,platformRetryDelayMs:0,platformDelayMs:0,detailConcurrency:1});
    __test.state.stage=2;
    __test.setData([{GlobalUID:0,TopicGuid:'synthetic-write',QuestionType:'Single',Title:'Synthetic write boundary',s2_done:false,s3_done:false,imgUrls:[]}]);
    let detailReads=0,answerWrites=0;
    $.ajax=options=>queueMicrotask(()=>{
      if(options.url.includes('JumpToPracticeTopic')) {
        detailReads++;
        options.success('<input id="hidden_TopicGuid" value="synthetic-write"><div class="panel"><div class="panel-body">Synthetic write boundary</div><ul class="list-group"><li><label><input type="radio" name="UserSelect" value="A">Alpha</label></li><li><label><input type="radio" name="UserSelect" value="B">Beta</label></li></ul></div>');
      }else{answerWrites++;options.error({status:503},'error');}
    });
    await __test.runStage2();
    return{detailReads,answerWrites,paused:__test.state.isPaused,stage:__test.state.stage,done:__test.data[0].s2_done};
  });
  assert.equal(result.detailReads,1);assert.equal(result.answerWrites,1);
  assert.equal(result.paused,true);assert.equal(result.stage,2);assert.equal(result.done,false);
}));

test('recovery: one unresolved AI comparison still saves images and resumes without repeating its independent answer',()=>withPage(async page=>{
  const result=await page.evaluate(async()=>{
    __setSettings({answerReviewMode:'double-check',imageRetryDelayMs:0});
    __test.keyManager.updateKeys('synthetic-recovery-key');
    __test.state.stage=3;
    const item={GlobalUID:0,TopicGuid:'synthetic-ai-pending',QuestionType:'Single',Title:'Synthetic pending comparison',
      DetailHtml:'<p>Synthetic pending comparison</p><label><input type="radio" name="UserSelect" value="A">Alpha</label><label><input type="radio" name="UserSelect" value="B">Beta</label>',
      SniffedAnswer:'Beta',AnswerSource:'platform-verified',IsAIAnswer:false,s2_done:true,s3_done:false,imgUrls:[]};
    __test.setData([item]);
    const canvas=document.createElement('canvas');canvas.width=2;canvas.height=1;
    const imageBytes=await(await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer();
    __test.setImages([['http://fixture.test/synthetic-recovery.png',{filename:'img_1.png',downloaded:false,buffer:null}]]);
    let imageReads=0,generations=0,comparisons=0;const packages=[];
    window.__fetch=async()=>{imageReads++;return new Response(imageBytes,{status:200,headers:{'Content-Type':'image/png'}});};
    __test.setBuilder(async isFinal=>{packages.push({isFinal,imageSaved:!!__test.images.values().next().value.buffer,stage:__test.state.stage,hasError:!!item.AIError});});
    __test.setEngineStage(3,async()=>{
      if(!item.AIReview){
        generations++;
        item.AIReview={version:2,status:'generated',fingerprint:__test.aiReviewFingerprint(item),policy:{javaTarget:__test.getSettings().javaTarget,preview:false},options:__test.aiOptionCatalog(item),
          independentAnswer:'Synthetic independent Alpha',promptText:'Synthetic blind prompt',independentAssessment:{optionIds:['option_1'],issues:[],explanation:'Synthetic independent reason',javaVersions:[]}};
      }
      comparisons++;
      if(comparisons===1){item.AIError={version:1,phase:'comparison',category:'format',message:'Synthetic invalid comparison',attempts:3,maxAttempts:3,retryable:true,updatedAt:new Date().toISOString(),warning:'Synthetic pending comparison'};item.s3_done=false;}
      else{item.AIReview.status='different';item.AIReview.comparison={verdict:'different',reason:'Synthetic comparison',optionIds:['option_2'],issues:[],platformAssessment:'supported',aiAssessment:'unsupported',javaVersions:[]};item.s3_done=true;delete item.AIError;}
      __test.state.stage=4;
    });
    await __test.runEngine();
    const first={paused:__test.state.isPaused,done:item.s3_done,review:item.AIReview.status,imageReads,packages:packages.length,platform:item.SniffedAnswer};
    __test.state.isPaused=false;__test.state.lastError=null;
    await __test.runEngine();
    return{first,generations,comparisons,imageReads,packages,paused:__test.state.isPaused,stage:__test.state.stage,done:item.s3_done,platform:item.SniffedAnswer};
  });
  assert.equal(result.first.paused,true);assert.equal(result.first.done,false);assert.equal(result.first.review,'generated');
  assert.equal(result.first.imageReads,1);assert.equal(result.first.packages,1);
  assert.equal(result.packages[0].isFinal,false);assert.equal(result.packages[0].imageSaved,true);
  assert.equal(result.generations,1);assert.equal(result.comparisons,2);assert.equal(result.imageReads,1);
  assert.equal(result.done,true);assert.equal(result.paused,false);assert.equal(result.stage,5);
  assert.equal(result.packages.length,2);assert.equal(result.packages[1].isFinal,true);
  assert.equal(result.platform,result.first.platform);assert.equal(result.platform,'Beta');
}));

test('recovery: blank and malformed AI HTTP responses retry before returning a usable answer',()=>withPage(async page=>{
  const result=await page.evaluate(async()=>{
    __setSettings({aiRetryDelayMs:0,perKeyConcurrency:1});
    __test.keyManager.updateKeys('synthetic-http-recovery');
    let calls=0;
    __fetch=async()=>{
      calls++;
      if(calls===1)return __aiResponse(' \n\t ');
      if(calls===2)return new Response('{malformed synthetic response',{headers:{'Content-Type':'application/json'}});
      return __aiResponse('Recovered synthetic answer');
    };
    const answer=await __test.requestDeepSeek('Synthetic system','Synthetic question');
    return{calls,answer,usage:__test.state.aiUsage,leases:__test.keyManager.entries.map(entry=>entry.inFlight),paused:__test.state.isPaused};
  });
  assert.equal(result.calls,3);assert.equal(result.answer,'Recovered synthetic answer');
  assert.equal(result.usage.requests,3);assert.equal(result.usage.successfulResponses,1);
  assert.deepEqual(result.leases,[0]);assert.equal(result.paused,false);
}));

test('recovery: exhausted AI HTTP retries report the exact budget and release the key for a later request',()=>withPage(async page=>{
  const result=await page.evaluate(async()=>{
    __setSettings({aiRetryDelayMs:0,perKeyConcurrency:1});
    __test.keyManager.updateKeys('synthetic-http-exhaustion');
    let calls=0,failure;
    __fetch=async()=>{calls++;return new Response('synthetic malformed JSON',{headers:{'Content-Type':'application/json'}});};
    try{await __test.requestDeepSeek('Synthetic system','Synthetic question');}catch(error){failure={attempts:error.aiAttempts,maxAttempts:error.aiMaxAttempts,retryable:error.retryable,message:error.message};}
    const exhausted={calls,leases:__test.keyManager.entries.map(entry=>entry.inFlight)};
    __fetch=async()=>{calls++;return __aiResponse('Recovered with same key');};
    const answer=await Promise.race([__test.requestDeepSeek('Synthetic system','Synthetic retry'),new Promise((_,reject)=>setTimeout(()=>reject(Error('Leaked AI key lease')),1500))]);
    return{budget:__test.getSettings().aiAttempts,failure,exhausted,calls,answer,leases:__test.keyManager.entries.map(entry=>entry.inFlight)};
  });
  assert.equal(result.budget,5);assert.equal(result.exhausted.calls,5);
  assert.equal(result.failure.attempts,5);assert.equal(result.failure.maxAttempts,5);assert.equal(result.failure.retryable,true);
  assert.deepEqual(result.exhausted.leases,[0]);assert.deepEqual(result.leases,[0]);
  assert.equal(result.calls,6);assert.equal(result.answer,'Recovered with same key');
}));

test('recovery: Retry-After beyond the ordinary backoff cap waits without pausing or disabling the key',()=>withPage(async page=>{
  const result=await page.evaluate(async()=>{
    __setSettings({aiRetryDelayMs:0,aiMaxRetryDelayMs:1000,perKeyConcurrency:1});
    __test.keyManager.updateKeys('synthetic-longer-cooldown');
    const times=[];
    __fetch=async()=>{times.push(performance.now());return times.length===1?new Response('',{status:429,headers:{'Retry-After':'1.1'}}):__aiResponse('Cooldown recovered');};
    const answer=await __test.requestDeepSeek('Synthetic system','Synthetic rate-limit question');
    return{calls:times.length,delay:times[1]-times[0],answer,paused:__test.state.isPaused,outOfKeys:__test.state.outOfKeys,available:__test.keyManager.getCount(),leases:__test.keyManager.entries.map(entry=>entry.inFlight)};
  });
  assert.equal(result.calls,2);assert.ok(result.delay>=1050,String(result.delay));
  assert.equal(result.answer,'Cooldown recovered');assert.equal(result.paused,false);assert.equal(result.outOfKeys,false);
  assert.equal(result.available,1);assert.deepEqual(result.leases,[0]);
}));

test('recovery: clearing keys explicitly skips an old AI failure and permits export without fabricating completion',()=>withPage(async page=>{
  const result=await page.evaluate(async()=>{
    __setSettings({answerReviewMode:'double-check'});__test.state.stage=3;
    const item={GlobalUID:0,TopicGuid:'synthetic-skip-ai-error',QuestionType:'Blank',Title:'Synthetic pending blank',DetailHtml:'<p>Synthetic pending blank</p>',BlankCount:1,
      s2_done:true,s3_done:false,NeedsAI:true,PlatformDetailChecked:true,SniffedAnswer:'',AIError:{version:1,phase:'independent',category:'request',message:'Synthetic earlier failure',attempts:5,maxAttempts:5,retryable:true,updatedAt:new Date().toISOString(),warning:'Synthetic earlier failure'}};
    __test.setData([item]);
    __test.state.aiServiceError={code:'ALL_KEYS_EXHAUSTED',message:'Synthetic previous service stop',updatedAt:new Date().toISOString()};
    __test.keyManager.updateKeys('');
    let apiCalls=0;__fetch=async()=>{apiCalls++;throw Error('Explicit no-key export must not request AI');};
    const packages=[];__test.setBuilder(async isFinal=>packages.push(isFinal));
    await __test.runEngine();
    return{packages,apiCalls,paused:__test.state.isPaused,stage:__test.state.stage,done:item.s3_done,answer:item.SniffedAnswer,error:!!item.AIError,review:item.AIReview};
  });
  assert.deepEqual(result.packages,[true]);assert.equal(result.apiCalls,0);
  assert.equal(result.paused,false);assert.equal(result.stage,5);
  assert.equal(result.done,false);assert.equal(result.answer,'');assert.equal(result.error,true);assert.equal(result.review,undefined);
}));

test('recovery: AI service rejection stops new requests but saves images before a resumable checkpoint',async()=>{
  for(const status of [401,400])await withPage(async page=>{
    const result=await page.evaluate(async status=>{
      __setSettings({answerReviewMode:'missing-only',aiConcurrency:3,perKeyConcurrency:3,aiRetryDelayMs:0,imageRetryDelayMs:0});
      __test.keyManager.updateKeys('synthetic-unavailable-key');__test.state.stage=3;
      __test.setData(Array.from({length:9},(_,index)=>({GlobalUID:index,TopicGuid:'synthetic-service-'+index,QuestionType:'Blank',Title:'Synthetic service recovery '+index,
        DetailHtml:'<p>Synthetic service recovery '+index+'</p>',BlankCount:1,s2_done:true,s3_done:false,PlatformDetailChecked:true,NeedsAI:true,SniffedAnswer:'',imgUrls:[]})));
      const canvas=document.createElement('canvas');canvas.width=2;canvas.height=1;
      const bytes=await(await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer();
      __test.setImages([['http://fixture.test/service-recovery.png',{filename:'img_1.png',downloaded:false,buffer:null}]]);
      let unavailable=true,aiCalls=0,imageReads=0;const serviceAtStart=[];
      __fetch=async url=>{
        if(String(url).startsWith('http://fixture.test/')){imageReads++;return new Response(bytes,{headers:{'Content-Type':'image/png'}});}
        aiCalls++;serviceAtStart.push(!!__test.state.aiServiceError);
        await new Promise(resolve=>setTimeout(resolve,25));
        return unavailable?new Response('',{status}):__aiResponse('Synthetic recovered answer');
      };
      const packages=[];__test.setBuilder(async isFinal=>packages.push({isFinal,imageSaved:!!__test.images.values().next().value.buffer}));
      await __test.runEngine();
      const first={aiCalls,imageReads,paused:__test.state.isPaused,stage:__test.state.stage,serviceError:__test.state.aiServiceError,done:__test.data.filter(item=>item.s3_done).length,packages:packages.slice(),leases:__test.keyManager.entries.map(entry=>entry.inFlight)};
      unavailable=false;__test.keyManager.updateKeys('synthetic-recovered-key');__test.state.isPaused=false;__test.state.lastError=null;
      await __test.runEngine();
      return{first,aiCalls,imageReads,serviceAtStart,packages,paused:__test.state.isPaused,stage:__test.state.stage,serviceError:__test.state.aiServiceError,
        done:__test.data.filter(item=>item.s3_done).length,remainingErrors:__test.data.filter(item=>item.AIError).length,leases:__test.keyManager.entries.map(entry=>entry.inFlight)};
    },status);
    assert.ok(result.first.aiCalls>=1&&result.first.aiCalls<=3,`${status}: ${result.first.aiCalls} calls exceed the three already-started workers`);
    assert.equal(result.first.paused,true);assert.equal(result.first.stage,3);assert.ok(result.first.serviceError?.code,String(status));
    assert.equal(result.first.done,0);assert.equal(result.first.imageReads,1);assert.deepEqual(result.first.leases,[0]);
    assert.deepEqual(result.first.packages,[{isFinal:false,imageSaved:true}]);
    assert.ok(result.serviceAtStart.every(value=>!value),'no request may begin while the AI service is stopped');
    assert.equal(result.aiCalls-result.first.aiCalls,9);assert.equal(result.done,9);assert.equal(result.remainingErrors,0);
    assert.equal(result.imageReads,1);assert.equal(result.paused,false);assert.equal(result.stage,5);assert.ok(!result.serviceError);
    assert.deepEqual(result.packages,[{isFinal:false,imageSaved:true},{isFinal:true,imageSaved:true}]);assert.deepEqual(result.leases,[0]);
  });
});

test('recovery: manual pause before image confirmation preserves an earlier image-related AI failure',()=>withPage(async page=>{
  const expected=await page.evaluate(()=>{
    const imageUrl='http://fixture.test/previously-missing.png';
    const warning='Synthetic earlier image failure requires a fresh source check';
    const failure={version:1,phase:'material',category:'image',imageUrl,message:'Synthetic previous 404',attempts:1,maxAttempts:1,retryable:true,updatedAt:'2026-01-01T00:00:00.000Z',warning};
    __test.setData([{GlobalUID:0,TopicGuid:'synthetic-paused-image',QuestionType:'Blank',Title:'Synthetic interrupted image check',
      DetailHtml:'<p>Synthetic interrupted image check</p><img src="images/img_1.png">',BlankCount:1,PlatformDetailChecked:true,
      s2_done:true,s3_done:false,NeedsAI:true,SniffedAnswer:'',imgUrls:[imageUrl],AIError:{...failure},ExtractionWarning:warning}]);
    __test.setImages([[imageUrl,{filename:'img_1.png',downloaded:false,buffer:null,sourceUnavailable:true,status:404}]]);
    __test.keyManager.updateKeys('synthetic-paused-image-key');__test.state.stage=3;
    window.__imageStageCalls=0;window.__pausedPackages=[];window.__recoveryStageEntered=false;
    __test.setEngineStage(3,async()=>{__recoveryStageEntered=true;await new Promise(resolve=>{window.__releaseRecoveryStage=resolve;});});
    __test.setEngineStage(4,async()=>{__imageStageCalls++;__test.state.stage=5;});
    __test.setBuilder(async isFinal=>__pausedPackages.push({isFinal,error:__test.data[0].AIError,warning:__test.data[0].ExtractionWarning}));
    window.__pausedEngine=__test.runEngine();
    return{failure,warning};
  });
  await page.waitForFunction(()=>window.__recoveryStageEntered);
  await page.locator('#bistu-pause-btn').click();
  const result=await page.evaluate(async()=>{
    __releaseRecoveryStage();await __pausedEngine;
    return{paused:__test.state.isPaused,stage:__test.state.stage,imageStageCalls:__imageStageCalls,packages:__pausedPackages,
      error:__test.data[0].AIError,warning:__test.data[0].ExtractionWarning,done:__test.data[0].s3_done};
  });
  assert.equal(result.paused,true);assert.equal(result.stage,3);assert.equal(result.imageStageCalls,0);assert.equal(result.done,false);
  assert.deepEqual(result.error,expected.failure);assert.equal(result.warning,expected.warning);
  assert.deepEqual(result.packages,[{isFinal:false,error:expected.failure,warning:expected.warning}]);
}));
