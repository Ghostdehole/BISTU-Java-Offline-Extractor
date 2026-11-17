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
      __setSettings({answerReviewMode:'double-check',aiConcurrency:1,perKeyConcurrency:1,aiAttempts:1,aiFormatAttempts:1,aiRetryDelayMs:0});
      __test.keyManager.updateKeys('synthetic-review-key');__test.state.stage=3;
      window.__independent=(answer,type='Single',extra={})=>JSON.stringify({answer,optionIds:['Single','Multiple','TrueOrFalse'].includes(type)?['option_1']:[],issues:[],explanation:'Synthetic independent reasoning',javaVersions:[],...extra});
      window.__comparison=(verdict,reason,type='Single',extra={})=>JSON.stringify({verdict,reason,optionIds:['Single','Multiple','TrueOrFalse'].includes(type)?['option_1']:[],issues:[],platformAssessment:'supported',aiAssessment:'supported',javaVersions:[],...extra});
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
      return __aiResponse(bodies.length%2?__independent('INDEPENDENT_ANSWER_'+pair,rows[pair].QuestionType):__comparison('consistent','Synthetic equivalence evidence',rows[pair].QuestionType));
    };
    await __test.runStage3();return {rows:__test.data,bodies,stage:__test.state.stage,paused:__test.state.isPaused,usage:__test.state.aiUsage};
  },rows);
  assert.equal(result.bodies.length,8);assert.equal(result.stage,4);assert.equal(result.paused,false);
  for (const body of result.bodies) {assert.deepEqual(body.response_format,{type:'json_object'});assert.match(body.messages[0].content,/JSON format-only example/);}
  assert.equal(result.usage.requests,8);assert.equal(result.usage.successfulResponses,8);assert.equal(result.usage.totalTokens,120);
  for(let index=0;index<4;index++) {
    const row=result.rows[index],first=JSON.stringify(result.bodies[index*2].messages),comparison=JSON.stringify(result.bodies[index*2+1].messages);
    assert.doesNotMatch(first,/PLATFORM_ONLY_SENTINEL/,'independent generation cannot see the platform answer');
    assert.match(first,/Independent synthetic question/);assert.match(comparison,new RegExp('PLATFORM_ONLY_SENTINEL_'+index));assert.match(comparison,new RegExp('INDEPENDENT_ANSWER_'+index));
    assert.equal(row.SniffedAnswer,rows[index].SniffedAnswer);assert.equal(row.AnswerSource,'platform-answer');assert.equal(row.IsAIAnswer,false);assert.equal(row.s3_done,true);
    assert.equal(row.AIReview.version,2);assert.equal(row.AIReview.status,'consistent');assert.equal(row.AIReview.independentAnswer,'INDEPENDENT_ANSWER_'+index);
    assert.ok(row.AIReview.independentAssessment.explanation);assert.deepEqual(row.AIReview.independentAssessment.issues,[]);
    assert.equal(row.AIReview.comparison.verdict,'consistent');assert.ok(row.AIReview.comparison.reason);assert.ok(row.AIReview.fingerprint);
    assert.equal(row.AIReview.independentInfo.usage.totalTokens,15);assert.equal(row.AIReview.comparisonInfo.usage.totalTokens,15);
  }
  assert.doesNotMatch(JSON.stringify(result.rows),/synthetic-review-key/);
}));

test('answer review: disagreement and uncertainty preserve both answers without claiming either is verified',()=>withReview(async page=>{
  const result=await page.evaluate(async rows=>{
    __test.setData(rows);let calls=0;
    __fetch=async()=>{calls++;const type=rows[Math.floor((calls-1)/2)].QuestionType;return __aiResponse(calls%2?__independent('Independent alternative '+Math.ceil(calls/2),type):__comparison(calls===2?'different':'uncertain',calls===2?'Different result':'Insufficient information',type));};
    await __test.runStage3();return {rows:__test.data,calls,paused:__test.state.isPaused};
  },[question('Blank'),question('Single',{GlobalUID:1,TopicGuid:'uncertain-row'})]);
  assert.equal(result.calls,4);assert.equal(result.paused,false);
  for(const [index,row] of result.rows.entries()) {
    assert.equal(row.SniffedAnswer,'<p>PLATFORM_ONLY_SENTINEL</p>');assert.equal(row.AnswerSource,'platform-answer');assert.equal(row.IsAIAnswer,false);
    assert.equal(row.AIReview.status,index?'uncertain':'different');assert.equal(row.AIReview.independentAnswer,'Independent alternative '+(index+1));assert.equal(row.s3_done,true);
  }
}));

test('answer review: missing answers generate once, old AI needs a v2 assessment, and programs retain their original policy',()=>withReview(async page=>{
  const rows=[
    question('Blank',{SniffedAnswer:'',AnswerSource:null,NeedsAI:true}),
    question('Blank',{GlobalUID:1,TopicGuid:'old-valid-ai',SniffedAnswer:'Previously completed AI answer',AnswerSource:'ai',IsAIAnswer:true,s3_done:true}),
    question('Program',{GlobalUID:2,TopicGuid:'official-program',SniffedAnswer:'class Official {}',PlainExample:'class Official {}',AnswerSource:'platform-reference'}),
    question('Program',{GlobalUID:3,TopicGuid:'missing-program',SniffedAnswer:'',AnswerSource:null,NeedsAI:true})
  ];
  const result=await page.evaluate(async rows=>{
    __test.setData(rows);const bodies=[];
    __fetch=async(_,options)=>{bodies.push(JSON.parse(options.body));return __aiResponse(bodies.length===1?__independent('One generated blank answer','Blank'):bodies.length===2?__independent('Reassessed old AI answer','Blank'):'class GeneratedProgram {}');};
    await __test.runStage3();return {rows:__test.data,bodies,stage:__test.state.stage};
  },rows);
  assert.equal(result.bodies.length,3);assert.equal(result.stage,4);
  assert.deepEqual(result.bodies[0].response_format,{type:'json_object'});assert.deepEqual(result.bodies[1].response_format,{type:'json_object'});
  assert.equal(result.bodies[2].response_format,undefined,'program code remains plain text rather than forced JSON');
  assert.equal(result.rows[0].SniffedAnswer,'One generated blank answer');assert.equal(result.rows[0].AIReview.status,'generated');assert.equal(result.rows[0].s3_done,true);
  assert.equal(result.rows[1].SniffedAnswer,'Reassessed old AI answer');assert.equal(result.rows[1].AIReview.version,2);assert.equal(result.rows[1].AIReview.independentAnswer,'Reassessed old AI answer');
  assert.equal(result.rows[2].SniffedAnswer,'class Official {}');assert.ok(!result.rows[2].AIReview);
  assert.equal(result.rows[3].SniffedAnswer,'class GeneratedProgram {}');assert.ok(!result.rows[3].AIReview);
}));

test('answer review: invalid comparison JSON leaves one item pending and resume pays only for comparison',()=>withReview(async page=>{
  const invalid=['not JSON','```json\n{"verdict":"consistent","reason":"x"}\n```','{"verdict":"unknown","reason":"x"}','{"verdict":"consistent","reason":""}','{"verdict":"consistent","reason":"x","extra":true}'];
  const result=await page.evaluate(async({invalid,row})=>{
    const results=[];
    for(const response of invalid) {
      __test.setData([structuredClone(row)]);__test.state.stage=3;__test.state.isPaused=false;
      let calls=0;const bodies=[];
      __fetch=async(_,options)=>{calls++;bodies.push(JSON.parse(options.body));return __aiResponse(calls===1?__independent('Retain this independent answer'):response);};
      await __test.runStage3();
      const interrupted={paused:__test.state.isPaused,done:__test.data[0].s3_done,review:structuredClone(__test.data[0].AIReview),error:__test.data[0].AIError,platform:__test.data[0].SniffedAnswer};
      __test.state.isPaused=false;
      __fetch=async(_,options)=>{calls++;bodies.push(JSON.parse(options.body));return __aiResponse(__comparison('consistent','Successful retry'));};
      await __test.runStage3();
      results.push({interrupted,calls,bodies,row:structuredClone(__test.data[0]),stage:__test.state.stage});
    }
    return results;
  },{invalid,row:question()});
  for(const [index,resultRow] of result.entries()) {
    assert.equal(resultRow.interrupted.paused,false,'invalid case '+index);assert.equal(resultRow.interrupted.done,false);assert.equal(resultRow.interrupted.error.phase,'comparison');assert.equal(resultRow.interrupted.error.category,'format');
    assert.equal(resultRow.interrupted.review.status,'generated');assert.equal(resultRow.interrupted.review.independentAnswer,'Retain this independent answer');
    assert.equal(resultRow.interrupted.platform,'<p>PLATFORM_ONLY_SENTINEL</p>');assert.equal(resultRow.calls,3);assert.equal(resultRow.stage,4);
    assert.equal(resultRow.row.AIReview.status,'consistent');assert.equal(resultRow.row.AIError,undefined);assert.match(JSON.stringify(resultRow.bodies[2].messages),/Retain this independent answer/);
  }
}));

test('answer review: completed review resumes without calls and changed question content invalidates prior comparison',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    __test.setData([row]);let calls=0;
    __fetch=async()=>{calls++;return __aiResponse(calls%2?__independent('Independent answer '+calls):__comparison('consistent','Synthetic agreement'));};
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
  assert.equal(result.calls,1);assert.equal(result.paused,false);assert.equal(result.row.s3_done,false);assert.ok(!result.row.AIReview);assert.equal(result.row.AIError.phase,'independent');
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
    __fetch=async(_,options)=>{bodies.push(JSON.parse(options.body));return __aiResponse(bodies.length===1?__independent('Blind diagram answer','Blank'):__comparison('different','Synthetic diagram distinction','Blank'));};
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
    const answers=[__independent('CONSISTENT_ONLY_SENTINEL','Blank'),__comparison('consistent','Same answer','Blank'),
      __independent(malicious,'Blank'),__comparison('different','Different result','Blank'),
      __independent('UNCERTAIN_AI_SENTINEL','Blank'),__comparison('uncertain','Cannot determine equivalence','Blank'),
      __independent('GENERATED_UNCOMPARED_SENTINEL','Blank'),'invalid comparison JSON'];
    __fetch=async()=>__aiResponse(answers.shift());await __test.runStage3();
    const stale=structuredClone(__test.data[1]);
    Object.assign(stale,{GlobalUID:5,TopicGuid:'stale-review',Title:'<p>Changed source invalidates old comparison</p>',DetailHtml:'<p>Changed source invalidates old comparison</p>'});
    stale.AIReview.independentAnswer='OLD_REVIEW_STALE_SENTINEL';
    const pending={...rows[0],GlobalUID:4,TopicGuid:'pending-review',Title:'<p>Unreviewed platform question</p>',DetailHtml:'<p>Unreviewed platform question</p>',s3_done:false};
    delete pending.AIReview;
    __test.setData([...__test.data,pending,stale]);return __test.generateOfflineHtml(false);
  },{rows:Array.from({length:4},(_,index)=>question('Blank',{GlobalUID:index,TopicGuid:'reader-review-'+index})),malicious});
  await page.setContent(html,{waitUntil:'domcontentloaded'});
  const cards=page.locator('.topic');
  assert.equal(await cards.count(),6);
  assert.equal(await cards.nth(0).locator('[data-review-status="consistent"]').count(),1);
  assert.match(await cards.nth(0).textContent(),/CONSISTENT_ONLY_SENTINEL/,'agreement keeps the independent answer accessible for audit');
  for(const [index,status] of ['different','uncertain','generated'].entries()) {
    const card=cards.nth(index+1);assert.equal(await card.locator('[data-review-status="'+status+'"]').count(),1);
    assert.match(await card.textContent(),/PLATFORM_ONLY_SENTINEL/);
  }
  assert.match(await cards.nth(1).locator('.ai-review').textContent(),/AI_SEARCH_SENTINEL <img/);
  assert.equal(await page.locator('.ai-review img,.ai-review script').count(),0);assert.equal(await page.evaluate(()=>window.__unsafeAIExecuted),undefined);
  assert.equal(await cards.nth(4).locator('[data-review-status="pending"]').count(),1);
  assert.equal(await cards.nth(5).locator('[data-review-status="legacy"]').count(),1);
  assert.match(await cards.nth(5).textContent(),/OLD_REVIEW_STALE_SENTINEL/);
  for(const index of [4,5]) assert.doesNotMatch(await cards.nth(index).textContent(),/AI_SEARCH_SENTINEL|两份答案一致/);
  await page.locator('#toggleAnsBtn').click();
  assert.equal(await page.locator('.answer-box:not([hidden])').count(),0);assert.equal(await cards.nth(1).locator('.ai-review').isVisible(),false);
  await page.locator('#keywordFilter').fill('AI_SEARCH_SENTINEL');
  await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='1');
  assert.equal(await page.locator('.answer-box:not([hidden])').count(),0,'searching an independent answer does not reveal hidden answers');
  await page.locator('#searchScope').selectOption('prompt');await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='0');
  await page.locator('#searchScope').selectOption('full');await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='1');
  await page.locator('#toggleAnsBtn').click();assert.equal(await cards.nth(1).locator('.ai-review').isVisible(),true);
}));

test('answer review v2: multiple choices and version issues survive an attempted consistent comparison',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    __test.setData([row]);let calls=0;
    __fetch=async()=>__aiResponse(++calls===1
      ? __independent('Conditional two-option answer','Single',{optionIds:['option_1','option_2'],issues:[{category:'version_dependent',explanation:'A language feature changes the conditional result.'}],javaVersions:['Java 8 without preview','Java 25 without preview']})
      : __comparison('consistent','The proposed answers appear equivalent'));
    await __test.runStage3();return {row:__test.data[0],paused:__test.state.isPaused,calls};
  },question());
  assert.equal(result.calls,2);assert.equal(result.paused,false);assert.equal(result.row.AIReview.status,'uncertain');
  assert.deepEqual(result.row.AIReview.independentAssessment.optionIds,['option_1','option_2']);
  assert.deepEqual(result.row.AIReview.comparison.optionIds,['option_1']);
  assert.deepEqual(result.row.AIReview.comparison.issues.map(x=>x.category),['version_dependent','multiple_correct','ambiguous']);
  assert.deepEqual(result.row.AIReview.comparison.javaVersions,['Java 8 without preview','Java 25 without preview']);
  assert.equal(result.row.SniffedAnswer,'<p>PLATFORM_ONLY_SENTINEL</p>');
}));

test('answer review v2: conditional or unsupported judgments cannot become clean agreement',()=>withReview(async page=>{
  const results=await page.evaluate(async row=>{
    const out=[];
    for(const judgment of ['conditional','unsupported','uncertain']) {
      __test.setData([structuredClone(row)]);__test.state.stage=3;__test.state.isPaused=false;let calls=0;
      __fetch=async()=>__aiResponse(++calls===1?__independent('Independent answer'):__comparison('consistent','The strings match','Single',{platformAssessment:judgment}));
      await __test.runStage3();out.push({review:__test.data[0].AIReview,paused:__test.state.isPaused});
    }
    return out;
  },question());
  for(const result of results){assert.equal(result.paused,false);assert.equal(result.review.status,'uncertain');assert.notEqual(result.review.comparison.platformAssessment,'supported');}
}));

test('answer review v2: invalid generation schemas and unknown option references never overwrite saved answers',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    const invalid=[
      'Unstructured answer text',
      __independent('Unknown original option','Single',{optionIds:['option_999']}),
      __independent('Duplicate original option','Single',{optionIds:['option_1','option_1']}),
      __independent('Missing mapping','Single',{optionIds:[]}),
      __independent('Invalid category','Single',{issues:[{category:'platform_is_always_right',explanation:'Invalid'}]}),
      __independent('Incomplete version note','Single',{issues:[{category:'version_dependent',explanation:'Version changes behavior'}]}),
      __independent('Contradictory empty choice','Single',{issues:[{category:'no_valid_option',explanation:'No original option applies'}]})
    ];
    const out=[];
    for(const content of invalid) {
      __test.setData([structuredClone(row)]);__test.state.stage=3;__test.state.isPaused=false;
      __fetch=async()=>__aiResponse(content);await __test.runStage3();
      out.push({row:structuredClone(__test.data[0]),paused:__test.state.isPaused});
    }
    return out;
  },question());
  for(const [index,entry] of result.entries()){
    assert.equal(entry.paused,false,'invalid generation '+index);assert.equal(entry.row.s3_done,false);assert.ok(!entry.row.AIReview);assert.equal(entry.row.AIError.category,'format');
    assert.equal(entry.row.SniffedAnswer,'<p>PLATFORM_ONLY_SENTINEL</p>');
  }
}));

test('answer review v2: invalid comparison option IDs retain a valid generated assessment for comparison-only retry',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    __test.setData([row]);let calls=0;
    __fetch=async()=>__aiResponse(++calls===1?__independent('Keep independent assessment'):__comparison('consistent','Wrong option reference','Single',{optionIds:['option_77']}));
    await __test.runStage3();const paused={paused:__test.state.isPaused,review:structuredClone(__test.data[0].AIReview)};
    __test.state.isPaused=false;__fetch=async()=>{calls++;return __aiResponse(__comparison('different','Use original option identifiers','Single',{optionIds:['option_2'],platformAssessment:'unsupported'}));};
    await __test.runStage3();return {paused,calls,row:__test.data[0]};
  },question());
  assert.equal(result.paused.paused,false);assert.equal(result.paused.review.version,2);assert.equal(result.paused.review.status,'generated');
  assert.equal(result.calls,3);assert.equal(result.row.AIReview.status,'different');assert.equal(result.row.AIReview.independentAnswer,'Keep independent assessment');
}));

test('answer review v2: old protocols stay readable without keys and cannot be silently upgraded or reused as blind assessments',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    row.AIReview={version:1,status:'consistent',fingerprint:'legacy-protocol-fingerprint',independentAnswer:'OLD_PROTOCOL_ANSWER',promptText:'old question',comparison:{verdict:'consistent',reason:'Old comparison'}};
    row.s3_done=true;__test.setData([row]);__test.keyManager.updateKeys('');let calls=0;
    __fetch=async()=>{calls++;throw Error('Must not call without keys');};await __test.runStage3();
    const withoutKeys=structuredClone(__test.data[0]);
    __test.keyManager.updateKeys('synthetic-review-key');__test.state.stage=3;const requests=[];
    __fetch=async(_,options)=>{calls++;requests.push(JSON.parse(options.body));return __aiResponse(calls===1?__independent('New protocol independent answer'):__comparison('different','New assessment differs'));};
    await __test.runStage3();return {withoutKeys,calls,requests,row:__test.data[0]};
  },question());
  assert.equal(result.withoutKeys.AIReview.version,1);assert.equal(result.withoutKeys.AIReview.independentAnswer,'OLD_PROTOCOL_ANSWER');assert.equal(result.withoutKeys.s3_done,false);
  assert.equal(result.withoutKeys.SniffedAnswer,'<p>PLATFORM_ONLY_SENTINEL</p>');assert.equal(result.calls,2);assert.equal(result.row.AIReview.version,2);
  assert.doesNotMatch(JSON.stringify(result.requests[0]),/OLD_PROTOCOL_ANSWER|PLATFORM_ONLY_SENTINEL/);
}));

test('answer review v2: changing configured Java target invalidates an otherwise complete review',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    __test.setData([row]);let calls=0;
    __fetch=async()=>__aiResponse(++calls%2?__independent('Answer under selected version'):__comparison('consistent','Supported in the selected version'));
    await __test.runStage3();const first=structuredClone(__test.data[0].AIReview);
    __setSettings({javaTarget:'8'});__test.state.stage=3;await __test.runStage3();
    return {calls,first,second:__test.data[0].AIReview};
  },question());
  assert.equal(result.calls,4);assert.notEqual(result.first.fingerprint,result.second.fingerprint);
  assert.deepEqual(result.second.policy,{javaTarget:'8',preview:false});
}));

test('answer review v2: original code layout and OCR remain separate from correction across a resumed comparison',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    __setSettings({imageMode:'ocr',ocrClean:true});
    const original='if (x &lt; 2) {\n    String s = &quot;\\t&quot;;\n}\n～0010101';
    row.DetailHtml='<p>Paragraph one</p><pre>'+original+'</pre><p>Paragraph two</p><img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1sAAAAASUVORK5CYII=">';
    __test.setData([row]);let calls=0,ocrCalls=0;const requests=[];
    Tesseract.createWorker=async()=>({recognize:async()=>{ocrCalls++;return {data:{text:'RAW OCR 0010101\n    x = x;'}};}});
    __fetch=async(_,options)=>{calls++;requests.push(JSON.parse(options.body));return __aiResponse(calls===1?'SUGGESTED OCR 0b0010101\n    this.x = x;':calls===2?__independent('Independent textual analysis','Blank'):'invalid comparison JSON');};
    await __test.runStage3();const saved=structuredClone(__test.data[0].AIReview);
    __test.state.isPaused=false;__fetch=async(_,options)=>{calls++;requests.push(JSON.parse(options.body));return __aiResponse(__comparison('uncertain','OCR variants require verification','Blank',{issues:[{category:'ambiguous',explanation:'OCR source and proposed correction differ'}]}));};
    await __test.runStage3();return {requests,saved,final:__test.data[0].AIReview,calls,ocrCalls};
  },question('Blank'));
  assert.equal(result.calls,4);assert.equal(result.ocrCalls,1,'resume reuses the saved original OCR instead of paying for another correction');
  const independent=JSON.parse(result.requests[1].messages[1].content);
  assert.match(independent.question,/Paragraph one\nif \(x < 2\) \{\n    String s = "\\t";\n\}\n～0010101\nParagraph two/);
  assert.deepEqual(independent.ocrOriginal,['RAW OCR 0010101\n    x = x;']);assert.match(independent.ocrSuggestion,/SUGGESTED OCR/);
  assert.doesNotMatch(independent.question,/SUGGESTED OCR|this\.x/);assert.deepEqual(result.saved.ocrOriginal,independent.ocrOriginal);
  const resumed=JSON.parse(result.requests[3].messages[1].content);
  assert.deepEqual(resumed.questionOcrOriginal,independent.ocrOriginal);assert.equal(resumed.questionOcrSuggestion,independent.ocrSuggestion);
  assert.equal(result.final.status,'uncertain');
}));

test('answer review v2: exact platform option sets prevent false agreement without guessing letters or ordinary pipes',()=>withReview(async page=>{
  const result=await page.evaluate(async base=>{
    const options=['<span>Alpha | literal</span>','<span>Beta</span>','<span>Gamma</span>'];
    const details=type=>'<p>Exact original alternatives</p>'+options.map((html,index)=>'<label><input type="'+(type==='Multiple'?'checkbox':'radio')+'" value="raw-'+index+'">'+html+'</label>').join('');
    const cases=[
      {type:'Single',platform:options[1],ids:['option_1'],expected:'uncertain'},
      {type:'Single',platform:options[1],ids:['option_2'],expected:'consistent'},
      {type:'Multiple',platform:options[0]+' <b>|</b> '+options[2],ids:['option_1'],expected:'uncertain'},
      {type:'Multiple',platform:options[0]+' <b>|</b> '+options[2],ids:['option_1','option_3'],expected:'consistent'},
      {type:'Single',platform:'B',ids:['option_1'],expected:'consistent'},
      {type:'Multiple',platform:'Alpha | Gamma',ids:['option_1'],expected:'consistent'},
      {type:'Single',platform:'Same',ids:['option_1'],expected:'consistent',detail:'<p>Ambiguous duplicate text</p><label><input type="radio" value="x">Same</label><label><input type="radio" value="y">Same</label>'}
    ];
    const results=[];
    for(const entry of cases){
      const row={...structuredClone(base),QuestionType:entry.type,DetailHtml:entry.detail||details(entry.type),SniffedAnswer:entry.platform};
      __test.setData([row]);__test.state.stage=3;__test.state.isPaused=false;let calls=0;
      __fetch=async()=>__aiResponse(++calls===1
        ? __independent('Synthetic model recommendation',entry.type,{optionIds:entry.ids})
        : __comparison('consistent','Model claims agreement',entry.type,{optionIds:entry.ids}));
      await __test.runStage3();
      const saved=structuredClone(__test.data[0]),valid=!!__test.getValidAiReview(saved);
      const forged=structuredClone(saved);forged.AIReview.status='consistent';forged.AIReview.comparison.verdict='consistent';forged.AIReview.comparison.issues=[];
      results.push({expected:entry.expected,calls,paused:__test.state.isPaused,saved,valid,forgedValid:!!__test.getValidAiReview(forged)});
    }
    return results;
  },question());
  for(const [index,resultRow] of result.entries()){
    assert.equal(resultRow.calls,2,'synthetic case '+index);assert.equal(resultRow.paused,false);assert.equal(resultRow.valid,true);
    assert.equal(resultRow.saved.AIReview.status,resultRow.expected,'synthetic case '+index);
    assert.equal(resultRow.saved.AIReview.independentAnswer,'Synthetic model recommendation');
    assert.equal(resultRow.saved.IsAIAnswer,false);assert.equal(resultRow.saved.AnswerSource,'platform-answer');
    if(resultRow.expected==='uncertain'){
      assert.ok(resultRow.saved.AIReview.comparison.issues.some(issue=>issue.category==='ambiguous'));
      assert.equal(resultRow.forgedValid,false,'a restored inconsistent review cannot bypass the same guard');
    }else{
      assert.deepEqual(resultRow.saved.AIReview.comparison.issues,[],'unmappable references must not be guessed from letters or delimiters');
    }
  }
}));

test('answer review v2: blind option metadata uses the same cleaned source and unsafe option removal blocks requests',()=>withReview(async page=>{
  const result=await page.evaluate(async base=>{
    const raw='<p>Original question</p><label><input type="radio" value="A">A. Alpha<span class="reference-answer">INLINE_PLATFORM_SENTINEL</span></label><label><input type="radio" value="B">B. Beta</label>';
    const row={...base,DetailHtml:raw};__test.setData([row]);const requests=[];
    __fetch=async(_,options)=>{requests.push(JSON.parse(options.body));return __aiResponse(requests.length===1?__independent('Synthetic clean choice'):__comparison('uncertain','Synthetic comparison requires review'));};
    await __test.runStage3();const clean={row:structuredClone(row),requests};
    const unsafe={...base,DetailHtml:'<p>Keep all original content</p><label class="reference-answer"><input type="radio" value="A">A. Alpha</label><label><input type="radio" value="B">B. Beta</label>'};
    __test.setData([unsafe]);__test.state.stage=3;__test.state.isPaused=false;let unexpected=0;
    __fetch=async()=>{unexpected++;throw Error('Cannot send a silently removed option');};await __test.runStage3();
    return {raw,clean,unsafe,unexpected};
  },question());
  assert.equal(result.clean.requests.length,2);
  const first=JSON.parse(result.clean.requests[0].messages[1].content);
  assert.doesNotMatch(JSON.stringify(first),/INLINE_PLATFORM_SENTINEL|PLATFORM_ONLY_SENTINEL/);
  assert.deepEqual(first.options.map(option=>({id:option.id,text:option.text})),[{id:'option_1',text:'A. Alpha'},{id:'option_2',text:'B. Beta'}]);
  assert.equal(result.clean.row.DetailHtml,result.raw,'original option HTML is not edited for export');
  assert.equal(result.unexpected,0);assert.equal(result.unsafe.s3_done,false);assert.ok(!result.unsafe.AIReview);
  assert.match(result.unsafe.ExtractionWarning,/AI 未执行/);assert.match(result.unsafe.DetailHtml,/A\. Alpha/);
}));

test('answer review v2: repeated image positions and swapped image-only options stay distinguishable in vision and OCR',()=>withReview(async page=>{
  const result=await page.evaluate(async base=>{
    const images=['red','blue'].map(color=>{const canvas=document.createElement('canvas');canvas.width=4;canvas.height=4;const drawing=canvas.getContext('2d');drawing.fillStyle=color;drawing.fillRect(0,0,4,4);return canvas.toDataURL('image/png');});
    const output=[];
    for(const imageMode of ['vision','ocr']) {
      __setSettings({imageMode,ocrClean:false});__test.state.stage=3;__test.state.isPaused=false;
      const rows=[[1,0],[0,1]].map((order,index)=>({...base,GlobalUID:index,TopicGuid:'image-swap-'+index,SniffedAnswer:'',AnswerSource:null,NeedsAI:true,
        DetailHtml:'<p>Choose the diagram matching the stem <img src="'+images[0]+'"></p>'+order.map((color,option)=>'<label><input type="radio" value="'+option+'"><img src="'+images[color]+'"></label>').join('')}));
      let ocrCalls=0;Tesseract.createWorker=async()=>({recognize:async()=>({data:{text:'Original OCR image '+(++ocrCalls)}})});
      const requests=[];__test.setData(rows);
      __fetch=async(_,options)=>{requests.push(JSON.parse(options.body));return __aiResponse(__independent('Synthetic image assessment'));};
      await __test.runStage3();
      const legacy=structuredClone(rows[0]);const fingerprint=JSON.parse(legacy.AIReview.fingerprint);fingerprint.splice(1,1);legacy.AIReview.fingerprint=JSON.stringify(fingerprint);
      output.push({imageMode,requests,ocrCalls,legacyValid:!!__test.getValidAiReview(legacy),details:rows.map(row=>row.DetailHtml)});
    }
    return {images,output};
  },question());
  for(const entry of result.output) {
    assert.equal(entry.requests.length,2);assert.equal(entry.legacyValid,false,'old unmapped-material fingerprint cannot certify the new protocol');
    const material=entry.requests.map(request=>JSON.parse(Array.isArray(request.messages[1].content)?request.messages[1].content[0].text:request.messages[1].content));
    assert.notDeepEqual(material[0],material[1],'swapping option pictures changes the model input');
    assert.deepEqual(material[0].options.map(option=>option.imageIds),[['image_2'],['image_1']]);
    assert.deepEqual(material[1].options.map(option=>option.imageIds),[['image_1'],['image_2']]);
    assert.match(material[0].options[0].text,/\[image_2\]/);assert.match(material[1].options[0].text,/\[image_1\]/);
    assert.equal((material[0].question.match(/\[image_1\]/g)||[]).length,2,'the repeated stem image retains both positions');
    if(entry.imageMode==='vision') {
      for(const request of entry.requests) assert.deepEqual(request.messages[1].content.slice(1).map(part=>part.image_url.url),result.images,'each distinct image is attached once in declared order');
      for(const prompt of material) assert.deepEqual(prompt.imageIds,['image_1','image_2']);assert.equal(entry.ocrCalls,0);
    } else {
      assert.equal(entry.ocrCalls,4,'each repeated image is OCRed once per question');
      for(const prompt of material) {assert.deepEqual(prompt.ocrImageIds,['image_1','image_2']);assert.equal(prompt.ocrOriginal.length,2);assert.deepEqual(prompt.imageIds,[]);}
    }
  }
}));

test('answer review recovery: format retries provide feedback without relaxing independent-choice validation',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    __setSettings({aiFormatAttempts:3});__test.setData([row]);const bodies=[];
    const answers=['{"answer":"missing required fields"}',
      __independent('Contradictory original choice','Single',{issues:[{category:'no_valid_option',explanation:'No option applies'}]}),
      __independent('A corrected independent answer'),'invalid comparison JSON',__comparison('consistent','Valid comparison after retry')];
    __fetch=async(_,options)=>{bodies.push(JSON.parse(options.body));return __aiResponse(answers[bodies.length-1]);};
    await __test.runStage3();return {row:__test.data[0],bodies,stage:__test.state.stage,paused:__test.state.isPaused};
  },question());
  assert.equal(result.bodies.length,5);assert.equal(result.stage,4);assert.equal(result.paused,false);
  assert.equal(result.row.AIReview.independentAnswer,'A corrected independent answer');assert.equal(result.row.AIReview.status,'consistent');assert.equal(result.row.AIError,undefined);
  for(const index of [1,2,4]) assert.match(result.bodies[index].messages[0].content,/Previous output failed validation/);
  for(const index of [0,1,2]) assert.doesNotMatch(JSON.stringify(result.bodies[index]),/PLATFORM_ONLY_SENTINEL/);
  assert.match(result.bodies[2].messages[0].content,/无有效选项/);
}));

test('answer review recovery: exhausted comparison retries isolate one item, process later items, and resume comparison only',()=>withReview(async page=>{
  const result=await page.evaluate(async base=>{
    __setSettings({aiFormatAttempts:3});
    const rows=['Bad comparison','Good comparison'].map((title,index)=>({...structuredClone(base),GlobalUID:index,TopicGuid:'recovery-'+index,Title:title,
      DetailHtml:base.DetailHtml.replace('Independent synthetic question',title),ExtractionWarning:index?'':'Existing platform warning'}));
    __test.setData(rows);const calls=[];
    __fetch=async(_,options)=>{
      const body=JSON.parse(options.body),prompt=JSON.parse(body.messages[1].content),compare=Object.hasOwn(prompt,'platformAnswer');
      calls.push({question:prompt.question,compare});
      return __aiResponse(compare&&prompt.question.includes('Bad comparison')?'{}':compare?__comparison('consistent','Other item succeeds'):__independent('Saved independent '+(prompt.question.includes('Bad')?'bad':'good')));
    };
    await __test.runStage3();const pending={rows:structuredClone(rows),stage:__test.state.stage,paused:__test.state.isPaused,calls:calls.length};
    __test.state.stage=3;
    __fetch=async(_,options)=>{const prompt=JSON.parse(JSON.parse(options.body).messages[1].content);calls.push({question:prompt.question,compare:Object.hasOwn(prompt,'platformAnswer')});return __aiResponse(__comparison('consistent','Recovered comparison'));};
    await __test.runStage3();return {pending,rows:__test.data,calls,stage:__test.state.stage};
  },question());
  assert.equal(result.pending.calls,6);assert.equal(result.pending.paused,false);assert.equal(result.pending.stage,4);
  const bad=result.pending.rows[0],good=result.pending.rows[1];
  assert.equal(bad.s3_done,false);assert.equal(bad.AIReview.status,'generated');assert.equal(bad.AIError.phase,'comparison');assert.equal(bad.AIError.category,'format');assert.equal(bad.AIError.attempts,3);assert.equal(bad.AIError.maxAttempts,3);
  assert.equal(good.s3_done,true);assert.equal(good.AIError,undefined);assert.equal(good.AIReview.status,'consistent');
  assert.equal(result.calls.length,7);assert.equal(result.calls[6].compare,true);assert.equal(result.rows[0].AIReview.independentAnswer,bad.AIReview.independentAnswer);
  assert.equal(result.rows[0].AIError,undefined);assert.equal(result.rows[0].ExtractionWarning,'Existing platform warning');assert.equal(result.rows[0].s3_done,true);
}));

test('answer review recovery: historical no-option issues survive comparison and repeated resumes without regeneration',()=>withReview(async page=>{
  const result=await page.evaluate(async base=>{
    const results=[];
    for(const ownConflict of [false,true]) {
      const row=structuredClone(base);__test.setData([row]);__test.state.stage=3;__test.state.isPaused=false;let calls=0;
      const issue={category:'no_valid_option',explanation:ownConflict?'Comparison retains a no-option concern':'Independent assessment found no valid option'};
      __fetch=async()=>__aiResponse(++calls===1
        ? __independent('Independent reasoning','Single',ownConflict?{}:{optionIds:[],issues:[issue]})
        : __comparison('different','Comparison recommends a conditional alternative','Single',ownConflict?{issues:[issue]}:{}));
      await __test.runStage3();const first=JSON.stringify(row.AIReview),valid=!!__test.getValidAiReview(row);
      for(let repeat=0;repeat<3;repeat++){__test.state.stage=3;await __test.runStage3();}
      results.push({row,calls,valid,stable:first===JSON.stringify(row.AIReview)});
    }
    return results;
  },question());
  for(const resultRow of result) {
    assert.equal(resultRow.calls,2);assert.equal(resultRow.valid,true);assert.equal(resultRow.stable,true);
    assert.equal(resultRow.row.AIReview.status,'uncertain');assert.equal(resultRow.row.s3_done,true);assert.equal(resultRow.row.AIError,undefined);
    assert.ok(resultRow.row.AIReview.comparison.issues.some(issue=>issue.category==='no_valid_option'));
    assert.ok(resultRow.row.AIReview.comparison.issues.some(issue=>issue.category==='ambiguous'));
    assert.deepEqual(resultRow.row.AIReview.comparison.optionIds,['option_1']);
  }
}));

test('answer review recovery: an invalid stored comparison retains a valid current independent answer for comparison-only repair',()=>withReview(async page=>{
  const result=await page.evaluate(async row=>{
    __test.setData([row]);let calls=0;__fetch=async()=>__aiResponse(++calls===1?__independent('Do not generate this twice'):__comparison('consistent','Initial valid comparison'));
    await __test.runStage3();row.AIReview.comparison.optionIds=['option_999'];
    const before=structuredClone(row.AIReview);const bodies=[];__test.state.stage=3;
    __fetch=async(_,options)=>{calls++;bodies.push(JSON.parse(options.body));return __aiResponse(__comparison('consistent','Repaired comparison'));};
    await __test.runStage3();return {calls,bodies,row,before};
  },question());
  assert.equal(result.calls,3);assert.equal(result.bodies.length,1);assert.match(JSON.stringify(result.bodies[0].messages),/Do not generate this twice/);
  assert.equal(result.row.AIReview.independentAnswer,result.before.independentAnswer);assert.equal(result.row.AIReview.independentInfo.generatedAt,result.before.independentInfo.generatedAt);
  assert.deepEqual(result.row.AIReview.previousComparison.comparison.optionIds,['option_999']);assert.equal(result.row.AIReview.status,'consistent');
}));

test('answer review recovery: exhausted keys stop AI only and clearing keys permits the image stage without new requests',()=>withReview(async page=>{
  const result=await page.evaluate(async base=>{
    __test.setData([0,1,2].map(index=>({...structuredClone(base),GlobalUID:index,TopicGuid:'key-stop-'+index})));
    let requests=0;__fetch=async()=>{requests++;return new Response('{}',{status:401});};
    await __test.runStage3();const stopped={requests,paused:__test.state.isPaused,stage:__test.state.stage,service:__test.state.aiServiceError,outOfKeys:__test.state.outOfKeys,rows:structuredClone(__test.data)};
    __test.keyManager.updateKeys('');__test.state.stage=3;await __test.runStage3();
    return {stopped,requests,stage:__test.state.stage,paused:__test.state.isPaused,service:__test.state.aiServiceError,outOfKeys:__test.state.outOfKeys};
  },question());
  assert.equal(result.stopped.requests,1);assert.equal(result.stopped.paused,false);assert.equal(result.stopped.stage,4);assert.equal(result.stopped.service.code,'ALL_KEYS_EXHAUSTED');assert.equal(result.stopped.outOfKeys,true);
  assert.equal(result.stopped.rows[0].AIError.phase,'independent');assert.ok(result.stopped.rows.every(row=>!row.s3_done&&!row.AIReview));
  assert.equal(result.requests,1);assert.equal(result.stage,4);assert.equal(result.paused,false);assert.equal(result.service,undefined);assert.equal(result.outOfKeys,false);
}));

test('answer review recovery: a shared configuration failure preserves an in-flight independent answer and suppresses later comparisons',()=>withReview(async page=>{
  const result=await page.evaluate(async base=>{
    __setSettings({aiConcurrency:2,perKeyConcurrency:2});
    __test.setData([0,1,2].map(index=>({...structuredClone(base),GlobalUID:index,TopicGuid:'config-stop-'+index,DetailHtml:base.DetailHtml.replace('Independent synthetic question','Config task '+index)})));
    let requests=0,heldRelease;const held=new Promise(resolve=>{heldRelease=resolve;});
    __fetch=async(_,options)=>{
      requests++;const prompt=JSON.parse(JSON.parse(options.body).messages[1].content);
      if(prompt.question.includes('Config task 0')) {await held;return __aiResponse(__independent('Save completed in-flight generation'));}
      return new Response('{}',{status:400});
    };
    const running=__test.runStage3();
    for(let spin=0;spin<100&&!__test.state.aiServiceError;spin++) await new Promise(resolve=>setTimeout(resolve,5));
    const serviceSeen=!!__test.state.aiServiceError;heldRelease();await running;
    return {requests,serviceSeen,service:__test.state.aiServiceError,paused:__test.state.isPaused,stage:__test.state.stage,rows:__test.data};
  },question());
  assert.equal(result.serviceSeen,true);assert.equal(result.requests,2);assert.equal(result.paused,false);assert.equal(result.stage,4);
  assert.equal(result.service.code,'AI_REQUEST_CONFIG');assert.equal(result.rows[0].AIReview.status,'generated');assert.equal(result.rows[0].AIReview.independentAnswer,'Save completed in-flight generation');assert.equal(result.rows[0].s3_done,false);
  assert.equal(result.rows[1].AIError.category,'request');assert.equal(result.rows[1].AIError.retryable,false);assert.ok(!result.rows[2].AIReview);
}));
