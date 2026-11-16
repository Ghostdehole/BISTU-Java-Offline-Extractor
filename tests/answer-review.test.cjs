'use strict';
// Synthetic completions only: no external network, personal keys or paid calls.
const assert=require('node:assert/strict');
const {before,after,test}=require('node:test');
const {launch,createHarness}=require('./harness.cjs');
let browser;
before(async()=>{browser=await launch();});
after(async()=>{await browser?.close();});
async function withReview(fn) {
  const harness=await createHarness(browser);
  try {
    await harness.page.evaluate(()=>{
      __setSettings({answerReviewMode:'double-check',aiConcurrency:1,perKeyConcurrency:1,aiAttempts:1,aiRetryDelayMs:0});
      __test.keyManager.updateKeys('synthetic-review-key');__test.state.stage=3;
    });
    return await fn(harness.page);
  } finally {await harness.close();}
}
function question(QuestionType='Single',overrides={}) {
  return {GlobalUID:0,TopicGuid:'review-synthetic-0',QuestionType,Title:'<p>Independent synthetic question</p>',
    DetailHtml:'<p>Independent synthetic question</p><label><input type="radio" value="A">Option Alpha</label><label><input type="radio" value="B">Option Beta</label>',
    SniffedAnswer:'<p>PLATFORM_ONLY_SENTINEL</p>',AnswerSource:'platform-answer',IsAIAnswer:false,NeedsAI:false,
    s2_done:true,s3_done:false,PlatformDetailChecked:true,imgUrls:[],...overrides};
}

test('answer review: non-program platform answers receive an independent blind answer and a separate comparison',()=>withReview(async page=>{
  const types=['Single','Multiple','TrueOrFalse','Blank'];
  const rows=types.map((type,index)=>question(type,{GlobalUID:index,TopicGuid:'review-'+type,SniffedAnswer:'<p>PLATFORM_ONLY_SENTINEL_'+index+'</p>'}));
  const result=await page.evaluate(async rows=>{
    __test.setData(rows);const bodies=[];
    __fetch=async(_,options)=>{
      bodies.push(JSON.parse(options.body));const pair=Math.floor((bodies.length-1)/2);
      return __aiResponse(bodies.length%2?'INDEPENDENT_ANSWER_'+pair:JSON.stringify({verdict:'consistent',reason:'Synthetic equivalence evidence'}));
    };
    await __test.runStage3();return {rows:__test.data,bodies,stage:__test.state.stage,paused:__test.state.isPaused,usage:__test.state.aiUsage};
  },rows);
  assert.equal(result.bodies.length,8);assert.equal(result.stage,4);assert.equal(result.paused,false);
  assert.equal(result.usage.requests,8);assert.equal(result.usage.successfulResponses,8);assert.equal(result.usage.totalTokens,120);
  for(let index=0;index<4;index++) {
    const row=result.rows[index],first=JSON.stringify(result.bodies[index*2].messages),comparison=JSON.stringify(result.bodies[index*2+1].messages);
    assert.doesNotMatch(first,/PLATFORM_ONLY_SENTINEL/,'independent generation cannot see the platform answer');
    assert.match(first,/Independent synthetic question/);assert.match(comparison,new RegExp('PLATFORM_ONLY_SENTINEL_'+index));assert.match(comparison,new RegExp('INDEPENDENT_ANSWER_'+index));
    assert.equal(row.SniffedAnswer,rows[index].SniffedAnswer);assert.equal(row.AnswerSource,'platform-answer');assert.equal(row.IsAIAnswer,false);assert.equal(row.s3_done,true);
    assert.equal(row.AIReview.version,1);assert.equal(row.AIReview.status,'consistent');assert.equal(row.AIReview.independentAnswer,'INDEPENDENT_ANSWER_'+index);
    assert.equal(row.AIReview.comparison.verdict,'consistent');assert.ok(row.AIReview.comparison.reason);assert.ok(row.AIReview.fingerprint);
    assert.equal(row.AIReview.independentInfo.usage.totalTokens,15);assert.equal(row.AIReview.comparisonInfo.usage.totalTokens,15);
  }
  assert.doesNotMatch(JSON.stringify(result.rows),/synthetic-review-key/);
}));

test('answer review: disagreement and uncertainty preserve both answers without claiming either is verified',()=>withReview(async page=>{
  const result=await page.evaluate(async rows=>{
    __test.setData(rows);let calls=0;
    __fetch=async()=>{calls++;return __aiResponse(calls%2?'Independent alternative '+Math.ceil(calls/2):JSON.stringify({verdict:calls===2?'different':'uncertain',reason:calls===2?'Different result':'Insufficient information'}));};
    await __test.runStage3();return {rows:__test.data,calls,paused:__test.state.isPaused};
  },[question('Blank'),question('Single',{GlobalUID:1,TopicGuid:'uncertain-row'})]);
  assert.equal(result.calls,4);assert.equal(result.paused,false);
  for(const [index,row] of result.rows.entries()) {
    assert.equal(row.SniffedAnswer,'<p>PLATFORM_ONLY_SENTINEL</p>');assert.equal(row.AnswerSource,'platform-answer');assert.equal(row.IsAIAnswer,false);
    assert.equal(row.AIReview.status,index?'uncertain':'different');assert.equal(row.AIReview.independentAnswer,'Independent alternative '+(index+1));assert.equal(row.s3_done,true);
  }
}));

test('answer review: missing answers generate once, completed old AI is reused, and programs retain their original policy',()=>withReview(async page=>{
  const rows=[
    question('Blank',{SniffedAnswer:'',AnswerSource:null,NeedsAI:true}),
    question('Blank',{GlobalUID:1,TopicGuid:'old-valid-ai',SniffedAnswer:'Previously completed AI answer',AnswerSource:'ai',IsAIAnswer:true,s3_done:true}),
    question('Program',{GlobalUID:2,TopicGuid:'official-program',SniffedAnswer:'class Official {}',PlainExample:'class Official {}',AnswerSource:'platform-reference'}),
    question('Program',{GlobalUID:3,TopicGuid:'missing-program',SniffedAnswer:'',AnswerSource:null,NeedsAI:true})
  ];
  const result=await page.evaluate(async rows=>{
    __test.setData(rows);const bodies=[];
    __fetch=async(_,options)=>{bodies.push(JSON.parse(options.body));return __aiResponse(bodies.length===1?'One generated blank answer':'class GeneratedProgram {}');};
    await __test.runStage3();return {rows:__test.data,bodies,stage:__test.state.stage};
  },rows);
  assert.equal(result.bodies.length,2);assert.equal(result.stage,4);
  assert.equal(result.rows[0].SniffedAnswer,'One generated blank answer');assert.equal(result.rows[0].AIReview.status,'generated');assert.equal(result.rows[0].s3_done,true);
  assert.equal(result.rows[1].SniffedAnswer,'Previously completed AI answer');assert.equal(result.rows[1].AIReview.independentAnswer,'Previously completed AI answer');
  assert.equal(result.rows[2].SniffedAnswer,'class Official {}');assert.ok(!result.rows[2].AIReview);
  assert.equal(result.rows[3].SniffedAnswer,'class GeneratedProgram {}');assert.ok(!result.rows[3].AIReview);
}));

test('answer review: invalid comparison JSON pauses without discarding generation and resume pays only for comparison',()=>withReview(async page=>{
  const invalid=['not JSON','```json\n{"verdict":"consistent","reason":"x"}\n```','{"verdict":"unknown","reason":"x"}','{"verdict":"consistent","reason":""}','{"verdict":"consistent","reason":"x","extra":true}'];
  const result=await page.evaluate(async({invalid,row})=>{
    const results=[];
    for(const response of invalid) {
      __test.setData([structuredClone(row)]);__test.state.stage=3;__test.state.isPaused=false;
      let calls=0;const bodies=[];
      __fetch=async(_,options)=>{calls++;bodies.push(JSON.parse(options.body));return __aiResponse(calls===1?'Retain this independent answer':response);};
      await __test.runStage3();
      const interrupted={paused:__test.state.isPaused,done:__test.data[0].s3_done,review:structuredClone(__test.data[0].AIReview),platform:__test.data[0].SniffedAnswer};
      __test.state.isPaused=false;
      __fetch=async(_,options)=>{calls++;bodies.push(JSON.parse(options.body));return __aiResponse(JSON.stringify({verdict:'consistent',reason:'Successful retry'}));};
      await __test.runStage3();
      results.push({interrupted,calls,bodies,row:structuredClone(__test.data[0]),stage:__test.state.stage});
    }
    return results;
  },{invalid,row:question()});
  for(const [index,resultRow] of result.entries()) {
    assert.equal(resultRow.interrupted.paused,true,'invalid case '+index);assert.equal(resultRow.interrupted.done,false);
    assert.equal(resultRow.interrupted.review.status,'generated');assert.equal(resultRow.interrupted.review.independentAnswer,'Retain this independent answer');
    assert.equal(resultRow.interrupted.platform,'<p>PLATFORM_ONLY_SENTINEL</p>');assert.equal(resultRow.calls,3);assert.equal(resultRow.stage,4);
    assert.equal(resultRow.row.AIReview.status,'consistent');assert.match(JSON.stringify(resultRow.bodies[2].messages),/Retain this independent answer/);
  }
}));

test('answer review: completed review resumes without calls and changed question content invalidates prior comparison',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    __test.setData([row]);let calls=0;
    __fetch=async()=>{calls++;return __aiResponse(calls%2?'Independent answer '+calls:JSON.stringify({verdict:'consistent',reason:'Synthetic agreement'}));};
    await __test.runStage3();const originalFingerprint=__test.data[0].AIReview.fingerprint;
    __test.state.stage=3;await __test.runStage3();const afterResume=calls;
    __test.data[0].Title='<p>Changed independent problem</p>';__test.data[0].DetailHtml=__test.data[0].DetailHtml.replace('Independent synthetic question','Changed independent problem');
    __test.state.stage=3;await __test.runStage3();
    return {calls,afterResume,row:__test.data[0],originalFingerprint};
  },question());
  assert.equal(result.afterResume,2);assert.equal(result.calls,4);assert.notEqual(result.row.AIReview.fingerprint,result.originalFingerprint);
  assert.equal(result.row.SniffedAnswer,'<p>PLATFORM_ONLY_SENTINEL</p>');assert.equal(result.row.AIReview.status,'consistent');
}));

test('answer review: absent keys and truncated generation never mark a platform answer as reviewed',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    __test.setData([row]);__test.keyManager.updateKeys('');let calls=0;
    __fetch=async()=>{calls++;throw Error('No request expected without a key');};
    await __test.runStage3();const withoutKeys={calls,row:structuredClone(__test.data[0])};
    __test.keyManager.updateKeys('synthetic-review-key');__test.state.stage=3;__test.state.isPaused=false;
    __fetch=async()=>{calls++;return Response.json({choices:[{finish_reason:'length',message:{role:'assistant',content:'Truncated answer'}}]});};
    await __test.runStage3();return {withoutKeys,calls,row:__test.data[0],paused:__test.state.isPaused};
  },question());
  assert.equal(result.withoutKeys.calls,0);assert.equal(result.withoutKeys.row.s3_done,false);assert.ok(!result.withoutKeys.row.AIReview);
  assert.equal(result.calls,1);assert.equal(result.paused,true);assert.equal(result.row.s3_done,false);assert.ok(!result.row.AIReview);
  assert.equal(result.row.SniffedAnswer,'<p>PLATFORM_ONLY_SENTINEL</p>');
}));

test('answer review: platform answer images stay out of independent generation and enter only the comparison',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    const images=[];
    for(const [index,color] of ['red','blue'].entries()) {
      const canvas=document.createElement('canvas');canvas.width=4;canvas.height=2;const drawing=canvas.getContext('2d');drawing.fillStyle=color;drawing.fillRect(0,0,4,2);
      const buffer=await(await new Promise(resolve=>canvas.toBlob(resolve,'image/png'))).arrayBuffer();
      await __test.validateImageBuffer(buffer,'image/png');
      images.push({url:'http://fixture.test/review-image-'+index+'.png',buffer,dataUrl:canvas.toDataURL('image/png')});
    }
    __test.setImages(images.map((image,index)=>[image.url,{filename:'img_'+(index+1)+'.png',buffer:image.buffer,downloaded:true}]));
    row.DetailHtml='<p>Question diagram only</p><img src="images/img_1.png" data-original="'+images[0].url+'">';
    row.SniffedAnswer='<p>Platform answer diagram</p><img src="images/img_2.png" data-original="'+images[1].url+'">';
    row.imgUrls=images.map(image=>image.url);__test.setData([row]);
    const bodies=[];
    __fetch=async(_,options)=>{bodies.push(JSON.parse(options.body));return __aiResponse(bodies.length===1?'Blind diagram answer':JSON.stringify({verdict:'different',reason:'Synthetic diagram distinction'}));};
    await __test.runStage3();return {bodies,questionImage:images[0].dataUrl,answerImage:images[1].dataUrl,row:__test.data[0],paused:__test.state.isPaused};
  },question('Blank'));
  assert.equal(result.paused,false);assert.equal(result.bodies.length,2);
  const generation=JSON.stringify(result.bodies[0].messages),comparison=JSON.stringify(result.bodies[1].messages);
  assert.ok(generation.includes(result.questionImage));assert.ok(!generation.includes(result.answerImage));assert.doesNotMatch(generation,/Platform answer diagram/);
  assert.ok(comparison.includes(result.answerImage));assert.match(comparison,/Blind diagram answer/);assert.equal(result.row.AIReview.status,'different');
}));

test('answer review reader: statuses, safe text, joint answer visibility and search distinguish current from stale reviews',()=>withReview(async page=>{
  const malicious='AI_SEARCH_SENTINEL <img src=x onerror="window.__unsafeAIExecuted=true"> & <script>window.__unsafeAIExecuted=true</script>';
  const html=await page.evaluate(async({rows,malicious})=>{
    __test.setData(rows);
    const answers=['CONSISTENT_ONLY_SENTINEL',JSON.stringify({verdict:'consistent',reason:'Same answer'}),
      malicious,JSON.stringify({verdict:'different',reason:'Different result'}),
      'UNCERTAIN_AI_SENTINEL',JSON.stringify({verdict:'uncertain',reason:'Cannot determine equivalence'}),
      'GENERATED_UNCOMPARED_SENTINEL','invalid comparison JSON'];
    __fetch=async()=>__aiResponse(answers.shift());await __test.runStage3();
    const stale=structuredClone(__test.data[1]);
    Object.assign(stale,{GlobalUID:5,TopicGuid:'stale-review',Title:'<p>Changed source invalidates old comparison</p>',DetailHtml:'<p>Changed source invalidates old comparison</p>'});
    const pending={...rows[0],GlobalUID:4,TopicGuid:'pending-review',Title:'<p>Unreviewed platform question</p>',DetailHtml:'<p>Unreviewed platform question</p>',s3_done:false};
    __test.setData([...__test.data,pending,stale]);return __test.generateOfflineHtml(false);
  },{rows:Array.from({length:4},(_,index)=>question('Blank',{GlobalUID:index,TopicGuid:'reader-review-'+index})),malicious});
  await page.setContent(html,{waitUntil:'domcontentloaded'});
  const cards=page.locator('.topic');
  assert.equal(await cards.count(),6);
  assert.equal(await cards.nth(0).locator('[data-review-status="consistent"]').count(),1);
  assert.doesNotMatch(await cards.nth(0).textContent(),/CONSISTENT_ONLY_SENTINEL/,'agreement displays only the retained platform answer');
  for(const [index,status] of ['different','uncertain','generated'].entries()) {
    const card=cards.nth(index+1);assert.equal(await card.locator('[data-review-status="'+status+'"]').count(),1);
    assert.match(await card.textContent(),/PLATFORM_ONLY_SENTINEL/);
  }
  assert.match(await cards.nth(1).locator('.ai-review').textContent(),/AI_SEARCH_SENTINEL <img/);
  assert.equal(await page.locator('.ai-review img,.ai-review script').count(),0);assert.equal(await page.evaluate(()=>window.__unsafeAIExecuted),undefined);
  for(const index of [4,5]) {
    assert.equal(await cards.nth(index).locator('[data-review-status="pending"]').count(),1);
    assert.doesNotMatch(await cards.nth(index).textContent(),/AI_SEARCH_SENTINEL|两份答案一致/);
  }
  await page.locator('#toggleAnsBtn').click();
  assert.equal(await page.locator('.answer-box:not([hidden])').count(),0);assert.equal(await cards.nth(1).locator('.ai-review').isVisible(),false);
  await page.locator('#keywordFilter').fill('AI_SEARCH_SENTINEL');
  await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='1');
  assert.equal(await page.locator('.answer-box:not([hidden])').count(),0,'searching an independent answer does not reveal hidden answers');
  await page.locator('#searchScope').selectOption('prompt');await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='0');
  await page.locator('#searchScope').selectOption('full');await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='1');
  await page.locator('#toggleAnsBtn').click();assert.equal(await cards.nth(1).locator('.ai-review').isVisible(),true);
}));
