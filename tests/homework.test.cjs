'use strict';
// Homework fixtures are synthetic. This suite never reads a student session,
// contacts a campus/API origin, or submits homework or answers.
const assert = require('node:assert/strict');
const {before,after,test}=require('node:test');
const JSZip=require('jszip');
const {launch,createHarness}=require('./harness.cjs');
let browser;
before(async()=>{browser=await launch();});
after(async()=>{await browser?.close();});
async function withHomework(fn) {
  const harness=await createHarness(browser);
  try {
    await harness.page.evaluate(()=>{
      for(const name of ['parseHomeworkDetail','homeworkFingerprint','mergeHomeworkQuestions']) {
        if(typeof __test[name]!=='function') throw new Error('Missing homework test interface: '+name);
      }
      __setSettings({includeHomework:'enabled'});
    });
    return await fn(harness.page);
  } finally {await harness.close();}
}
const job={id:'synthetic-job-1',name:'Synthetic homework 1'};
const baseUrl='http://fixture.test/Manage/StudentJob/SyntheticReview';
function questionBox(guid='synthetic-question-1',number=1,stem='<p>Synthetic program prompt</p>',requirement='<pre>input: x &lt; 5\noutput: exact value</pre>',extra='') {
  return '<div class="div_TopicBox" relationship="'+guid+'">'+
    '<div class="div_TopicTitle"><label>'+number+'、（20分）</label>'+stem+'</div>'+
    '<div class="div_CXT_TopicRequirement"><label>【试题输入输出】</label>'+requirement+'</div>'+
    '<div class="div_CXT_Answer"><label>【作答结果】</label><pre>PRIVATE_STUDENT_ANSWER_MUST_NOT_EXPORT</pre></div>'+
    '<div class="div_CXT_UserInput"><textarea>PRIVATE_STUDENT_INPUT_MUST_NOT_EXPORT</textarea></div>'+extra+'</div>';
}
function homeworkPage(boxes=[questionBox()],count=boxes.length,heading='程序题',tag='h5') {
  return '<!doctype html><title>作业成绩详细</title><h3 data-synthetic-job-name>'+job.name+'</h3><table id="table_PaperTitle"><tr><td>作业课程</td><td>Java</td></tr></table>'+
    '<section><'+tag+' class="h_TopicInstruction">'+heading+'（本题共 '+count+' 小题,本题共100分。）</'+tag+'>'+boxes.join('')+'</section>';
}
function program(overrides={}) {
  const row={GlobalUID:0,QuestionType:'Program',TopicGuid:'practice-guid',Title:'<p>CaseSensitive synthetic prompt</p>',Requirement:'<pre>input x\noutput X</pre>',
    CollectionSource:'practice',DetailHtml:'<p>CaseSensitive synthetic prompt</p><pre>input x\noutput X</pre>',s2_done:true,s3_done:true,
    SniffedAnswer:'class OriginalReference {}',PlainExample:'class OriginalReference {}',AnswerSource:'platform-reference',IsAIAnswer:false,NeedsAI:false,...overrides};
  if(typeof overrides.DetailHtml!=='string') row.DetailHtml=row.Title+row.Requirement;
  return row;
}

async function mockHomework(page, config) {
  await page.evaluate(config=>{
    __setSettings({platformAttempts:1,platformDelayMs:0,pageSize:2,detailConcurrency:3});
    window.__homeworkConfig=config;
    window.__homeworkEvents=[];
    window.__respond=async request=>{
      const url=new URL(request.url,location.origin),method=String(request.type).toLowerCase(),cfg=__homeworkConfig;
      if(url.pathname==='/Manage/StudentJob/Index'&&method==='get') {
        __homeworkEvents.push('index');
        return cfg.indexHtml||'<table id="table_UserTaskInfo"></table><select id="select_StudentGroups">'+Object.keys(cfg.groups).map(id=>'<option value="'+id+'">Synthetic group</option>').join('')+'</select>';
      }
      if(url.pathname==='/Manage/StudentJob/Index'&&method==='post') {
        const {groupId,offset,limit}=request.data;
        if(!cfg.groups[groupId]||!Number.isInteger(offset)||!Number.isInteger(limit)) throw Error('Invalid synthetic list request');
        const all=cfg.groups[groupId];
        return {Result:true,Element:{total:all.length,rows:all.slice(offset,offset+limit)}};
      }
      if(url.pathname==='/Manage/StudentJob/JobStudentsScore'&&method==='post') {
        __homeworkEvents.push('scores:'+request.data.JobGuid);
        return {Result:true,Element:cfg.scores?.[request.data.JobGuid]||[{RunState:0,UserGuid:'PRIVATE_SYNTHETIC_USER_GUID'}]};
      }
      if(url.pathname==='/Manage/TeacherJobScoreSearch/StudentJobDetail'&&method==='get') {
        const paper=url.searchParams.get('JPGuid');
        if(url.searchParams.get('UserGuid')!=='PRIVATE_SYNTHETIC_USER_GUID') throw Error('Unexpected synthetic student');
        if(cfg.delay?.[paper]) await new Promise(resolve=>setTimeout(resolve,cfg.delay[paper]));
        __homeworkEvents.push('detail:'+paper);
        if(cfg.failPaper===paper) throw Error('Synthetic detail failed');
        if(!cfg.html[paper]) throw Error('Unconfigured synthetic paper');
        const assignment=Object.values(cfg.groups).flat().find(row=>row.JPGuid===paper);
        return cfg.html[paper].replace(/<h3 data-synthetic-job-name>[\s\S]*?<\/h3>/,'<h3 data-synthetic-job-name>'+assignment.JobName+'</h3>');
      }
      throw Error('Unexpected endpoint or method: '+method+' '+url.pathname);
    };
  },config);
}
function assignment(id,paperId=id) {
  return {JobGuid:id,JPGuid:paperId,JobName:'Synthetic '+id,StartTime:'',EndTime:'',StudentName:'PRIVATE_SYNTHETIC_STUDENT_NAME'};
}

test('StudentJob pipeline: parses every declared program and excludes numbering, student answers and input drafts',()=>withHomework(async page=>{
  const html=homeworkPage([
    questionBox('synthetic-q-a',1,'<p>Preserved A &amp; B</p><label>Keep this real label</label><img src="/fixtures/a.png" alt="Diagram A">'),
    questionBox('synthetic-q-b',2,'<p>Second independent program</p>','<pre>Line 1\n  Line 2 &lt;tag&gt;</pre>')
  ]);
  const result=await page.evaluate(({html,job,baseUrl})=>{
    const parsed=__test.parseHomeworkDetail(html,job,baseUrl);
    return {parsed,views:parsed.questions.map(row=>{
      const title=new DOMParser().parseFromString(row.Title,'text/html');
      const requirement=new DOMParser().parseFromString(row.Requirement,'text/html');
      return {title:title.body.textContent,requirement:requirement.body.textContent,images:[...title.images].map(img=>img.getAttribute('src'))};
    }),calls:__ajaxCalls.length};
  },{html,job,baseUrl});
  assert.equal(result.parsed.language,'Java');assert.equal(result.parsed.questions.length,2);
  assert.deepEqual(result.parsed.questions.map(row=>row.QuestionType),['Program','Program']);
  assert.deepEqual(result.parsed.questions.map(row=>row.TopicGuid),['synthetic-q-a','synthetic-q-b']);
  assert.match(result.views[0].title,/Preserved A & B/);assert.match(result.views[0].title,/Keep this real label/);
  assert.doesNotMatch(result.views[0].title,/1、|20分/);
  assert.match(result.views[1].requirement,/Line 1\n  Line 2 <tag>/);
  assert.doesNotMatch(result.views[0].requirement,/试题输入输出/);
  assert.equal(result.views[0].images.length,1);
  assert.doesNotMatch(JSON.stringify(result.parsed),/PRIVATE_STUDENT_ANSWER|PRIVATE_STUDENT_INPUT/);
  assert.ok(result.parsed.questions.every(row=>!row.SniffedAnswer&&!row.PlainExample));
  assert.equal(result.calls,0);
}));

test('StudentJob pipeline: rejects login, absent course, unknown types, missing identities and inconsistent declared counts',()=>withHomework(async page=>{
  const valid=homeworkPage([questionBox()],1,'程序题','h3');
  const cases=[
    ['login','<title>登录</title><form><input type="password"></form>'],
    ['missing course',valid.replace(/<table[^>]*>[\s\S]*?<\/table>/,'')],
    ['unknown type',valid.replace('程序题（','Synthetic unknown type（')],
    ['wrong count',valid.replace('共 1 小题','共 2 小题')],
    ['missing identity',valid.replace('relationship="synthetic-question-1"','')],
    ['missing title',valid.replace('class="div_TopicTitle"','class="unrecognized-title"')],
    ['unrecognized page','<title>作业成绩详细</title><p>Unexpected response</p>']
  ];
  const result=await page.evaluate(({valid,cases,job,baseUrl})=>{
    const accepted=__test.parseHomeworkDetail(valid,job,baseUrl).questions.length;
    return {accepted,rejected:cases.map(([name,html])=>{try{__test.parseHomeworkDetail(html,job,baseUrl);return {name,rejected:false};}catch(error){return {name,rejected:true,message:String(error.message)};}})};
  },{valid,cases,job,baseUrl});
  assert.equal(result.accepted,1);
  for(const row of result.rejected) assert.ok(row.rejected&&row.message,row.name+' must fail closed');
}));

test('StudentJob pipeline: content identity preserves case, code whitespace, requirements, option text and image URLs',()=>withHomework(async page=>{
  const base=program({PlainExample:undefined,SniffedAnswer:undefined});
  const variants=[
    {...base,Title:'<p>casesensitive synthetic prompt</p>'},
    {...base,Requirement:'<pre>input x\noutput x</pre>'},
    {...base,Requirement:'<pre>input x\n output X</pre>'},
    {...base,QuestionType:'Blank',BlankCount:1},
    {...base,Title:base.Title+'<img src="/figure-a.png">'},
    {...base,Title:base.Title+'<img src="/figure-b.png">'}
  ].map(row=>({...row,DetailHtml:row.Title+row.Requirement}));
  const choice={QuestionType:'Single',TopicGuid:'choice-a',Title:'<p>Synthetic choice</p><label><input type="radio" value="A">Option A</label><label><input type="radio" value="B">Option B</label>',Requirement:''};
  choice.DetailHtml=choice.Title;
  const result=await page.evaluate(({base,variants,choice,baseUrl})=>({
    original:__test.homeworkFingerprint(base,baseUrl),variants:variants.map(item=>__test.homeworkFingerprint(item,baseUrl)),
    choices:[choice,{...choice,Title:choice.Title.replace('Option B','Different option B'),DetailHtml:choice.DetailHtml.replace('Option B','Different option B')}].map(item=>__test.homeworkFingerprint(item,baseUrl)),
    empty:__test.homeworkFingerprint({QuestionType:'Program',Title:'',Requirement:''},baseUrl)
  }),{base,variants,choice,baseUrl});
  assert.equal(typeof result.original,'string');assert.ok(result.original.length>0);
  assert.ok(result.variants.every(value=>typeof value==='string'&&value!==result.original));
  assert.notEqual(result.variants[4],result.variants[5]);assert.notEqual(result.choices[0],result.choices[1]);
  assert.equal(result.empty,null,'empty records must never acquire a shared deduplication identity');
}));

test('StudentJob pipeline: styled literal whitespace survives inherited spans and never merges distinct program strings',()=>withHomework(async page=>{
  const result=await page.evaluate(({job,baseUrl})=>{
    const cases=[];
    for(const style of ['white-space:pre','white-space:pre-wrap','white-space:break-spaces','white-space-collapse:preserve']) {
      for(const sameGuid of [false,true]) {
        const title='<div style="'+style+'"><span style="white-space:inherit"><em>print("a  b")\n  next();</em></span></div>';
        const original={GlobalUID:0,QuestionType:'Program',TopicGuid:'practice-literal',Title:title,Requirement:'',DetailHtml:title,s2_done:true};
        const candidate={...original,TopicGuid:sameGuid?original.TopicGuid:'homework-literal',Title:title.replace('a  b','a b'),CollectionSource:'homework'};
        const changed=__test.mergeHomeworkQuestions([original],[candidate],{...job,baseUrl});
        const equal=__test.mergeHomeworkQuestions([original],[{...candidate,Title:title}],{...job,baseUrl});
        cases.push({style,sameGuid,added:changed.added,duplicates:changed.duplicates,titles:changed.questions.map(row=>row.Title),equalAdded:equal.added,equalDuplicates:equal.duplicates});
      }
    }
    const collapsed={GlobalUID:0,QuestionType:'Program',TopicGuid:'normal-parent',Title:'<div style="white-space:pre-wrap"><span style="white-space:normal">print("a  b")</span></div>',Requirement:''};
    const normal=__test.mergeHomeworkQuestions([collapsed],[{...collapsed,TopicGuid:'normal-copy',Title:collapsed.Title.replace('a  b','a b')}],{...job,baseUrl});
    return {cases,normal:{added:normal.added,duplicates:normal.duplicates}};
  },{job,baseUrl});
  for(const row of result.cases) {
    assert.equal(row.added,1,row.style+' / same GUID '+row.sameGuid);
    assert.equal(row.duplicates,0);
    assert.match(row.titles[0],/a  b/);assert.match(row.titles[1],/a b/);
    assert.equal(row.equalAdded,0,'identical preserved text still deduplicates');
    assert.equal(row.equalDuplicates,1);
  }
  assert.deepEqual(result.normal,{added:0,duplicates:1},'an explicit normal child overrides inherited literal whitespace');
}));

test('StudentJob pipeline: responsive image alternatives sharing a fallback never merge different pictures',()=>withHomework(async page=>{
  const result=await page.evaluate(({job,baseUrl})=>{
    const image='<picture><source srcset="/picture-a.png 1x" data-srcset="/lazy-a.png 2x" media="(min-width:600px)" type="image/png"><img src="/shared-fallback.png" srcset="/img-a.png 1x" data-srcset="/img-lazy-a.png 2x"></picture>';
    const original={GlobalUID:0,QuestionType:'Program',TopicGuid:'practice-picture',Title:'<p>Use this diagram</p>'+image,Requirement:'',s2_done:true};
    return ['/picture-a.png','/lazy-a.png','min-width:600px','image/png','/img-a.png','/img-lazy-a.png'].map(value=>{
      const replacement=value==='image/png'?'image/webp':value==='min-width:600px'?'min-width:800px':value.replace('.png','-different.png');
      const candidate={...original,TopicGuid:'homework-picture',Title:original.Title.replace(value,replacement)};
      const changed=__test.mergeHomeworkQuestions([original],[candidate],{...job,baseUrl});
      const repeated=__test.mergeHomeworkQuestions(changed.questions,[candidate],{...job,baseUrl});
      return {value,added:changed.added,duplicates:changed.duplicates,repeatedAdded:repeated.added,repeatedDuplicates:repeated.duplicates};
    });
  },{job,baseUrl});
  for(const row of result) {
    assert.equal(row.added,1,row.value+' changes the responsive image identity');
    assert.equal(row.duplicates,0);
    assert.equal(row.repeatedAdded,0,'a repeated responsive-image question must not create another variant');
    assert.equal(row.repeatedDuplicates,1);
  }
}));

test('StudentJob pipeline: exponents, matrix geometry and generated list numbers cannot collapse into identical text',()=>withHomework(async page=>{
  const pairs=[
    ['exponent','<p>x<sup>2</sup></p>','<p>x2</p>'],
    ['exponent inside code','<code>x<sup>2</sup></code>','<code>x2</code>'],
    ['subscript','<p>x<sup>2</sup></p>','<p>x<sub>2</sub></p>'],
    ['matrix rows','<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>','<table><tr><td>a</td><td>b</td><td>c</td><td>d</td></tr></table>'],
    ['column span','<table><tr><td colspan="2">a</td><td>b</td></tr></table>','<table><tr><td>a</td><td>b</td></tr></table>'],
    ['row span','<table><tr><td rowspan="2">a</td><td>b</td></tr></table>','<table><tr><td>a</td><td>b</td></tr></table>'],
    ['list start','<ol start="1"><li>a</li><li>b</li></ol>','<ol start="2"><li>a</li><li>b</li></ol>'],
    ['list direction','<ol><li>a</li><li>b</li></ol>','<ol reversed><li>a</li><li>b</li></ol>'],
    ['list marker type','<ol type="1"><li>a</li></ol>','<ol type="A"><li>a</li></ol>'],
    ['list item value','<ol><li value="2">a</li></ol>','<ol><li value="3">a</li></ol>'],
    ['numbered versus bullets','<ol><li>a</li></ol>','<ul><li>a</li></ul>']
  ];
  const result=await page.evaluate(({pairs,job,baseUrl})=>pairs.flatMap(([name,left,right])=>[false,true].map(sameGuid=>{
    const original={GlobalUID:0,QuestionType:'Program',TopicGuid:'practice-structure',Title:left,Requirement:'',s2_done:true};
    const candidate={...original,TopicGuid:sameGuid?original.TopicGuid:'homework-structure',Title:right,CollectionSource:'homework'};
    const merged=__test.mergeHomeworkQuestions([original],[candidate],{...job,baseUrl});
    const repeated=__test.mergeHomeworkQuestions(merged.questions,[candidate],{...job,baseUrl});
    return {name,sameGuid,added:merged.added,duplicates:merged.duplicates,firstTitle:merged.questions[0].Title,lastTitle:merged.questions[1]?.Title,repeatedAdded:repeated.added};
  })),{pairs,job,baseUrl});
  for(const row of result) {
    assert.equal(row.added,1,row.name+' / same GUID '+row.sameGuid);
    assert.equal(row.duplicates,0);
    assert.notEqual(row.firstTitle,row.lastTitle);
    assert.equal(row.repeatedAdded,0,'retained semantic variants remain idempotent');
  }
}));

test('StudentJob pipeline: per-occurrence matching audit retains source topic IDs without private fields or shared mutable lists',()=>withHomework(async page=>{
  const original=program({Title:'<p>Audit x<sup>2</sup></p>',imgUrls:[]});
  const result=await page.evaluate(({original,job,baseUrl})=>{
    const candidates=[{...original,GlobalUID:undefined},{...original,GlobalUID:undefined,TopicGuid:'other-guid',Title:'<div> Audit x<sup>2</sup> </div>'}];
    const merged=__test.mergeHomeworkQuestions([original],candidates,{...job,baseUrl,UserGuid:'PRIVATE_USER',url:'http://fixture.test/private?UserGuid=PRIVATE_USER'});
    const before=JSON.stringify(merged.questions);
    const repeated=__test.mergeHomeworkQuestions(merged.questions,candidates,{...job,baseUrl});
    const audit=repeated.questions[0].HomeworkMatches.map(row=>({...row}));
    repeated.questions[0].HomeworkMatches[0].method='mutated';
    repeated.questions[0].HomeworkMatches.push({jobId:'changed',topicGuid:'changed',method:'new-question'});
    return {added:merged.added,duplicates:merged.duplicates,audit,inputUnchanged:JSON.stringify(merged.questions)===before};
  },{original,job,baseUrl});
  assert.equal(result.added,0);assert.equal(result.duplicates,2);
  assert.deepEqual(result.audit,[{jobId:job.id,topicGuid:original.TopicGuid,method:'same-guid-and-content'},{jobId:job.id,topicGuid:'other-guid',method:'same-content'}]);
  assert.equal(result.inputUnchanged,true,'returned audit entries and arrays must be independent of the saved snapshot');
  assert.doesNotMatch(JSON.stringify(result.audit),/PRIVATE_USER|UserGuid|http:/);
}));

test('StudentJob pipeline: equivalent prose and original image URLs match independently of offline filenames',()=>withHomework(async page=>{
  const first=program({Title:'<p>Same &amp; exact prose</p><img src="images/img_7.png" data-original="http://fixture.test/fixtures/diagram.png?size=2">',Requirement:'<pre>x\n  y</pre>'});
  const second={...first,TopicGuid:'homework-different-guid',Title:'<div> Same &amp; exact   prose </div><img src="/fixtures/diagram.png?size=2">'};
  second.DetailHtml=second.Title+second.Requirement;
  const result=await page.evaluate(({first,second,baseUrl})=>[first,second].map(item=>__test.homeworkFingerprint(item,baseUrl)),{first,second,baseUrl});
  assert.ok(result[0]);assert.equal(result[0],result[1]);
}));

test('StudentJob pipeline: pure merge preserves Practice records and appends unique questions once with provenance',()=>withHomework(async page=>{
  const practice=[program({imgUrls:['http://fixture.test/original.png'],HomeworkSources:[{jobId:'prior-job',name:'Prior synthetic source'}]}),program({GlobalUID:1,TopicGuid:'practice-second',Title:'<p>Second practice question</p>'})];
  const candidates=[{...practice[0],GlobalUID:undefined},{...practice[1],GlobalUID:undefined,TopicGuid:'homework-copy'},program({GlobalUID:undefined,TopicGuid:'homework-new',Title:'<p>Only in the homework</p>',CollectionSource:'homework',ChapterName:'作业补充'})];
  const result=await page.evaluate(({practice,candidates,job})=>{
    const before=JSON.stringify({practice,candidates}),merged=__test.mergeHomeworkQuestions(practice,candidates,job);
    const unchanged=before===JSON.stringify({practice,candidates});
    const detached=__test.mergeHomeworkQuestions(practice,[],job);
    detached.questions[0].Title='Mutated returned title';
    detached.questions[0].imgUrls.push('http://fixture.test/later.png');
    detached.questions[0].HomeworkSources[0].name='Mutated returned source';
    detached.questions[0].HomeworkSources.push({jobId:'later-job',name:'Later synthetic source'});
    return {merged,unchanged,isolated:before===JSON.stringify({practice,candidates})};
  },{practice,candidates,job});
  assert.equal(result.unchanged,true);
  assert.equal(result.isolated,true,'localizing or annotating returned records must not mutate saved input records');
  assert.deepEqual({discovered:result.merged.discovered,duplicates:result.merged.duplicates,added:result.merged.added},{discovered:3,duplicates:2,added:1});
  assert.equal(result.merged.questions.length,3);
  for(let index=0;index<2;index++) {
    const row=result.merged.questions[index];
    for(const field of ['TopicGuid','Title','Requirement','DetailHtml','SniffedAnswer','PlainExample','AnswerSource','s2_done','s3_done']) assert.deepEqual(row[field],practice[index][field],field);
    assert.equal(row.HomeworkSources.filter(source=>source.jobId===job.id).length,1);
  }
  assert.equal(result.merged.questions[2].CollectionSource,'homework');
  assert.equal(result.merged.questions[2].ChapterName,'作业补充');
  assert.deepEqual(result.merged.questions.map(row=>row.GlobalUID),[0,1,2]);
}));

test('StudentJob pipeline: repeated jobs are idempotent while identical questions retain every distinct job source',()=>withHomework(async page=>{
  const question=program({GlobalUID:undefined,TopicGuid:'homework-only',Title:'<p>Repeated synthetic homework question</p>'});
  const otherJob={id:'synthetic-job-2',name:'Synthetic homework 2'};
  const result=await page.evaluate(({question,job,otherJob})=>{
    const first=__test.mergeHomeworkQuestions([], [question,question], job);
    const again=__test.mergeHomeworkQuestions(first.questions,[question],job);
    const other=__test.mergeHomeworkQuestions(again.questions,[question],otherJob);
    return {first,again,other};
  },{question,job,otherJob});
  assert.equal(result.first.added,1);assert.equal(result.first.duplicates,1);
  assert.equal(result.again.added,0);assert.equal(result.other.added,0);
  assert.equal(result.other.questions.length,1);
  assert.deepEqual(result.other.questions[0].HomeworkSources.map(source=>source.jobId).sort(),[job.id,otherJob.id]);
}));

test('StudentJob pipeline: conflicting content under the same type and GUID remains a warned variant',()=>withHomework(async page=>{
  const original=program(),variant={...original,Title:'<p>A genuinely different question under the same identifier</p>',GlobalUID:undefined};
  variant.DetailHtml=variant.Title+variant.Requirement;
  const result=await page.evaluate(({original,variant,job})=>{
    const first=__test.mergeHomeworkQuestions([original],[variant],job);
    const repeat=__test.mergeHomeworkQuestions(first.questions,[variant],job);
    return {first,repeat};
  },{original,variant,job});
  assert.equal(result.first.added,1);assert.equal(result.first.questions.length,2);
  assert.equal(result.first.questions[0].Title,original.Title);
  assert.equal(result.first.questions[1].Title,variant.Title);
  assert.equal(result.first.questions[1].OriginalTopicGuid,original.TopicGuid);
  assert.ok(result.first.questions.some(row=>typeof row.ExtractionWarning==='string'&&row.ExtractionWarning.trim()));
  assert.equal(result.repeat.added,0);assert.equal(result.repeat.questions.length,2);
}));

test('StudentJob pipeline: accepts only explicitly labeled official answers outside student-result regions',()=>withHomework(async page=>{
  const official='class ProvidedReference { int value = 7; }';
  const html=homeworkPage([questionBox('official-question',1,'<p>Official reference fixture</p>','<pre>Exact required output</pre>',
    '<div class="official-answer"><label>【参考程序】</label><pre>'+official+'</pre></div>')],1,'程序题','h3')
    .replace('<td>作业课程</td>','<th>作业课程</th>').replace('1、（20分）','1 <strong>、（本题20分）</strong>')
    .replace('PRIVATE_STUDENT_ANSWER_MUST_NOT_EXPORT','<label>【正确答案】</label>PRIVATE_STUDENT_TRAP');
  const noOfficial=homeworkPage([questionBox('unanswered-question',1,'<p>The phrase 正确答案 is part of this question, not an answer disclosure.</p>')]);
  const result=await page.evaluate(({html,noOfficial,job,baseUrl})=>({
    official:__test.parseHomeworkDetail(html,job,baseUrl).questions[0],
    unanswered:__test.parseHomeworkDetail(noOfficial,job,baseUrl).questions[0]
  }),{html,noOfficial,job,baseUrl});
  assert.match(result.official.SniffedAnswer,/class ProvidedReference \{ int value = 7; \}/);
  assert.equal(result.official.AnswerSource,'platform-answer');assert.equal(result.official.IsAIAnswer,false);assert.equal(result.official.NeedsAI,false);
  assert.equal(result.official.s2_done,false,'parsing alone must not claim image localization and stage completion');
  assert.ok(!result.official.PlainExample);assert.doesNotMatch(JSON.stringify(result.official),/PRIVATE_STUDENT/);
  assert.doesNotMatch(result.official.Title,/本题20分/);
  assert.ok(!result.unanswered.SniffedAnswer);assert.equal(result.unanswered.NeedsAI,true);
}));

test('StudentJob pipeline: objective questions retain options but never import checked responses or answer feedback',()=>withHomework(async page=>{
  const options='<div class="div_TopicOptions"><p class="p_TopicOption"><input type="radio" checked value="A">A. Original option</p><p class="p_TopicOption"><input type="radio" value="B">B. Another option</p></div><div class="bg-info">您的答案是：PRIVATE_SELECTION_FEEDBACK</div>';
  const html=homeworkPage([questionBox('objective-question',1,'<p>Synthetic objective statement</p>','',options)],1,'单选题');
  const malformed=html.replace('<p class="p_TopicOption"><input type="radio" value="B">B. Another option</p>','');
  const result=await page.evaluate(({html,malformed,job,baseUrl})=>{
    const row=__test.parseHomeworkDetail(html,job,baseUrl).questions[0];
    const doc=new DOMParser().parseFromString((row.Title||'')+(row.Requirement||'')+(row.DetailHtml||''),'text/html');
    let rejected=false;try{__test.parseHomeworkDetail(malformed,job,baseUrl);}catch(_){rejected=true;}
    return {row,text:doc.body.textContent,checked:doc.querySelectorAll('[checked]').length,rejected};
  },{html,malformed,job,baseUrl});
  assert.equal(result.row.QuestionType,'Single');assert.match(result.text,/Original option/);assert.match(result.text,/Another option/);
  assert.equal(result.checked,0);assert.ok(!result.row.SniffedAnswer);
  assert.doesNotMatch(JSON.stringify(result.row),/PRIVATE_SELECTION_FEEDBACK|PRIVATE_STUDENT/);
  assert.equal(result.rejected,true);
}));

test('StudentJob pipeline: official duplicates fill missing or AI answers while existing platform answers win conflicts',()=>withHomework(async page=>{
  const provided=program({GlobalUID:undefined,TopicGuid:'homework-official',PlainExample:undefined,SniffedAnswer:'class NewlyProvided {}',AnswerSource:'platform-answer',s2_done:false,s3_done:false});
  const originals=[
    program({PlainExample:undefined,SniffedAnswer:'',AnswerSource:undefined,NeedsAI:true,s3_done:false}),
    program({PlainExample:undefined,SniffedAnswer:'Synthetic AI response',AnswerSource:'ai',IsAIAnswer:true,NeedsAI:false}),
    program()
  ];
  const privateJob={...job,UserGuid:'DO_NOT_STORE_USER_GUID',studentName:'DO_NOT_STORE_STUDENT_NAME',detailUrl:'http://fixture.test/review?UserGuid=DO_NOT_STORE_USER_GUID'};
  const result=await page.evaluate(({provided,originals,job})=>originals.map(original=>{
    const saved=JSON.stringify(original),merged=__test.mergeHomeworkQuestions([original],[provided],job);
    return {merged,unchanged:JSON.stringify(original)===saved};
  }),{provided,originals,job:privateJob});
  for(const item of result) {assert.equal(item.unchanged,true);assert.equal(item.merged.added,0);assert.equal(item.merged.duplicates,1);assert.equal(item.merged.questions.length,1);}
  for(const item of result.slice(0,2)) {
    const row=item.merged.questions[0];assert.equal(row.SniffedAnswer,provided.SniffedAnswer);assert.equal(row.AnswerSource,'platform-answer');assert.equal(row.IsAIAnswer,false);assert.equal(row.NeedsAI,false);
    assert.equal(row.TopicGuid,originals[0].TopicGuid);
  }
  const retained=result[2].merged.questions[0];assert.equal(retained.SniffedAnswer,originals[2].SniffedAnswer);assert.equal(retained.AnswerSource,originals[2].AnswerSource);assert.ok(retained.ExtractionWarning);
  assert.doesNotMatch(JSON.stringify(result),/DO_NOT_STORE_USER_GUID|DO_NOT_STORE_STUDENT_NAME/);
}));

test('StudentJob pipeline: Practice details complete before homework discovery and AI sees the merged bank',()=>withHomework(async page=>{
  await mockHomework(page,{groups:{groupA:[assignment('job1')]},html:{job1:homeworkPage([questionBox('homework-new',1,'<p>New homework prompt</p>')])}});
  const result=await page.evaluate(async practice=>{
    __test.setData([practice]);__test.state.stage=1;
    __test.setEngineStage(1,async()=>{__homeworkEvents.push('practice-list');__test.state.stage=2;});
    __test.setEngineStage(2,async()=>{__homeworkEvents.push('practice-detail');__test.data[0].s2_done=true;__test.state.stage=3;});
    __test.setEngineStage(3,async()=>{
      __homeworkEvents.push('ai');
      window.__bankAtAI={count:__test.data.length,complete:__test.state.homeworkProgress.done,details:__test.data.every(row=>row.s2_done)};
      __test.state.stage=4;
    });
    __test.setEngineStage(4,async()=>{__homeworkEvents.push('images');__test.state.stage=5;});
    __test.setBuilder(async final=>{__homeworkEvents.push('zip:'+final);});
    await __test.runEngine();
    return {events:__homeworkEvents,bank:__bankAtAI,paused:__test.state.isPaused,calls:__ajaxCalls};
  },program({s2_done:false}));
  assert.deepEqual(result.events.slice(0,3),['practice-list','practice-detail','index']);
  assert.deepEqual(result.bank,{count:2,complete:true,details:true});
  assert.deepEqual(result.events.slice(-3),['ai','images','zip:true']);assert.equal(result.paused,false);
  assert.ok(result.calls.every(call=>/\/(StudentJob\/(Index|JobStudentsScore)|TeacherJobScoreSearch\/StudentJobDetail)(\?|$)/.test(call.url)));
}));

test('StudentJob pipeline: incomplete Practice and failed details cannot trigger supplementary requests or AI',()=>withHomework(async page=>{
  await mockHomework(page,{groups:{groupA:[]},html:{}});
  const result=await page.evaluate(async practice=>{
    __test.setData([practice]);__test.state.stage=2;
    let directError='';try{await __test.runHomeworkSupplement();}catch(error){directError=error.message;}
    __test.setEngineStage(2,async()=>{throw Error('Synthetic Practice detail failed');});
    __test.setEngineStage(3,async()=>{__homeworkEvents.push('AI MUST NOT RUN');});
    __test.setBuilder(async final=>{__homeworkEvents.push('zip:'+final);});
    await __test.runEngine();
    return {directError,calls:__ajaxCalls.length,events:__homeworkEvents,state:__test.state};
  },program({s2_done:false}));
  assert.ok(result.directError);assert.equal(result.calls,0);assert.deepEqual(result.events,['zip:false']);
  assert.equal(result.state.stage,2);assert.equal(result.state.isPaused,true);assert.match(result.state.lastError,/Synthetic Practice detail failed/);
}));

test('StudentJob pipeline: concurrent failures commit only the consecutive prefix and resume without duplicates',()=>withHomework(async page=>{
  const duplicate=program({Title:'<p>Already in Practice</p>',Requirement:'<pre>same requirement</pre>'});
  await mockHomework(page,{groups:{groupA:[assignment('job1'),assignment('job2'),assignment('job3')]},
    html:{job1:homeworkPage([questionBox(duplicate.TopicGuid,1,duplicate.Title,duplicate.Requirement)]),
      job2:homeworkPage([questionBox('new-a',1,'<p>Homework A</p>')]),job3:homeworkPage([questionBox('new-b',1,'<p>Homework B</p>')])},
    failPaper:'job2',delay:{job1:30,job3:1}});
  const first=await page.evaluate(async practice=>{
    __test.setData([practice]);__test.state.stage=3;
    let error='';try{await __test.runHomeworkSupplement();}catch(failure){error=failure.message;}
    return {error,data:__test.data,progress:__test.state.homeworkProgress,events:__homeworkEvents};
  },duplicate);
  assert.ok(first.error);assert.equal(first.data.length,1);assert.equal(first.progress.cursor,1);assert.equal(first.progress.duplicates,1);assert.equal(first.progress.added,0);assert.equal(first.progress.done,false);
  assert.ok(first.events.indexOf('detail:job3')<first.events.indexOf('detail:job1'),'responses really arrive out of order');
  const resumed=await page.evaluate(async()=>{
    delete __homeworkConfig.failPaper;__homeworkEvents.length=0;
    await __test.runHomeworkSupplement();
    return {data:__test.data,progress:__test.state.homeworkProgress,events:__homeworkEvents};
  });
  assert.deepEqual(resumed.data.map(row=>row.TopicGuid),[duplicate.TopicGuid,'new-a','new-b']);
  assert.deepEqual(resumed.data.map(row=>row.GlobalUID),[0,1,2]);assert.equal(resumed.progress.cursor,3);assert.equal(resumed.progress.done,true);
  assert.equal(resumed.progress.duplicates,1);assert.equal(resumed.progress.added,2);
  assert.ok(!resumed.events.includes('scores:job1'));assert.equal(resumed.events[0],'index','resume revalidates the visible assignment manifest');
  assert.ok(resumed.data.slice(1).every(row=>row.s2_done&&row.PlatformDetailChecked&&row.NeedsAI));
  assert.doesNotMatch(JSON.stringify({data:resumed.data,progress:resumed.progress}),/PRIVATE_SYNTHETIC|UserGuid|detailUrl/);
}));

test('StudentJob pipeline: changed manifests rescan idempotently across groups and localize new images',()=>withHomework(async page=>{
  const imageHtml=homeworkPage([questionBox('new-image',1,'<p>Homework with diagram</p><img src="/fixtures/homework.png" alt="Synthetic diagram">')]);
  await mockHomework(page,{groups:{groupA:[assignment('job1')],groupB:[assignment('job1'),assignment('job2')]},
    html:{job1:imageHtml,job2:homeworkPage([questionBox('new-other',1,'<p>Another homework</p>')])}});
  const first=await page.evaluate(async()=>{
    __test.setData([]);__test.state.stage=3;
    __test.state.scope.typeDefinitions=__test.state.scope.typeDefinitions.filter(row=>row.type==='Single');
    await __test.runHomeworkSupplement();
    return {data:__test.data,progress:__test.state.homeworkProgress,images:[...__test.images],events:__homeworkEvents};
  });
  assert.equal(first.data.length,2);assert.equal(first.progress.jobs.length,2);assert.equal(first.events.filter(event=>event==='scores:job1').length,1);
  assert.equal(first.images.length,1);assert.equal(first.images[0][0],'http://fixture.test/fixtures/homework.png');
  assert.match(first.data[0].DetailHtml,/src="images\/img_\d+\.png"/);assert.match(first.data[0].DetailHtml,/data-original="http:\/\/fixture.test\/fixtures\/homework.png"/);
  const third=assignment('job3');
  const result=await page.evaluate(async({third,html})=>{
    __homeworkConfig.groups.groupB.push(third);__homeworkConfig.html.job3=html;__homeworkEvents.length=0;
    await __test.runHomeworkSupplement();await __test.buildZipAndDownload(false);
    const zip=__zips.at(-1);
    return {data:__test.data,progress:__test.state.homeworkProgress,events:__homeworkEvents,images:__test.images.size,
      state:await zip.file('state.json').async('string'),report:JSON.parse(await zip.file('extraction-report.json').async('string'))};
  },{third,html:homeworkPage([questionBox('new-third',1,'<p>Third homework</p>')])});
  assert.equal(result.data.length,3);assert.equal(result.progress.duplicates,2);assert.equal(result.progress.added,1);assert.equal(result.progress.cursor,3);
  assert.ok(result.events.includes('scores:job1'));assert.equal(result.images,1);
  assert.equal(result.report.totalQuestions,3);assert.equal(result.report.homework.addedTotal,3);assert.equal(result.report.homework.assignments,3);
  const programReport=result.report.byType.find(row=>row.type==='Program');
  assert.ok(programReport,'homework-only types are reported even outside the Practice menu subset');
  assert.equal(programReport.practiceCollected,0);assert.equal(programReport.homeworkAdded,3);
  assert.doesNotMatch(result.state,/PRIVATE_SYNTHETIC|UserGuid|detailUrl/);
}));

test('StudentJob pipeline: unavailable and other-language assignments are explicit skips while ambiguous students fail closed',()=>withHomework(async page=>{
  await mockHomework(page,{groups:{groupA:[assignment('not-ready'),assignment('other-language'),assignment('ambiguous')]},
    html:{'other-language':homeworkPage([questionBox()]).replace('<td>Java</td>','<td>Python</td>')},
    scores:{'not-ready':[{RunState:1,UserGuid:'PRIVATE_SYNTHETIC_USER_GUID'}],ambiguous:[{RunState:0,UserGuid:'userA'},{RunState:0,UserGuid:'userB'}]}});
  const result=await page.evaluate(async()=>{
    __test.setData([]);__test.state.stage=3;
    let error='';try{await __test.runHomeworkSupplement();}catch(failure){error=failure.message;}
    return {error,progress:__test.state.homeworkProgress,data:__test.data,calls:__ajaxCalls};
  });
  assert.match(result.error,/多个学生/);assert.equal(result.progress.cursor,2);assert.equal(result.progress.done,false);assert.equal(result.data.length,0);
  assert.equal(result.progress.skipped.length,2);assert.match(result.progress.skipped[0].reason,/未作答|评判/);assert.match(result.progress.skipped[1].reason,/Python/);
  const details=result.calls.filter(call=>call.url.includes('StudentJobDetail'));
  assert.equal(details.length,1);assert.equal(new URL(details[0].url).searchParams.get('JPGuid'),'other-language');
}));

test('StudentJob pipeline: strong requirement headings and neutral wrappers deduplicate against full Practice requirements',()=>withHomework(async page=>{
  const practice=program({Title:'<p>Requirement comparison fixture</p>',Requirement:'<p>Preserve this exact input and output.</p>'});
  const html=homeworkPage([questionBox('same-content-other-guid',1,practice.Title,'<div>'+practice.Requirement+'</div>')])
    .replace('<label>【试题输入输出】</label>','<strong class="text-primary">【试题输入输出】</strong>');
  const result=await page.evaluate(({practice,html,job,baseUrl})=>{
    const parsed=__test.parseHomeworkDetail(html,job,baseUrl);
    return {row:parsed.questions[0],merged:__test.mergeHomeworkQuestions([practice],parsed.questions,job)};
  },{practice,html,job,baseUrl});
  assert.doesNotMatch(result.row.Requirement,/试题输入输出/);
  assert.match(result.row.Requirement,/Preserve this exact input and output\./);
  assert.equal(result.merged.duplicates,1);assert.equal(result.merged.added,0);assert.equal(result.merged.questions[0].Requirement,practice.Requirement);
}));

test('StudentJob pipeline: enabling supplement at the image stage checks homework before AI and images resume',()=>withHomework(async page=>{
  await mockHomework(page,{groups:{groupA:[assignment('late-job')]},html:{'late-job':homeworkPage([questionBox('late-question')])}});
  const result=await page.evaluate(async practice=>{
    __test.setData([practice]);__test.state.stage=4;
    __test.setEngineStage(3,async()=>{__homeworkEvents.push('ai:'+__test.data.length);__test.state.stage=4;});
    __test.setEngineStage(4,async()=>{__homeworkEvents.push('images');__test.state.stage=5;});
    __test.setBuilder(async final=>{__homeworkEvents.push('zip:'+final);});
    await __test.runEngine();
    return {events:__homeworkEvents,stage:__test.state.stage,done:__test.state.homeworkProgress.done};
  },program());
  assert.equal(result.events[0],'index');assert.deepEqual(result.events.slice(-3),['ai:2','images','zip:true']);
  assert.equal(result.stage,5);assert.equal(result.done,true);
}));

test('StudentJob pipeline: an assignment localization failure rolls back every new image and record before retry',()=>withHomework(async page=>{
  const failing=homeworkPage([questionBox('image-first',1,'<p>First new question</p><img src="/fixtures/new.png">'),
    questionBox('unsupported-second',2,'<p>Second new question</p><svg><rect width="20" height="10"></rect></svg>')]);
  await mockHomework(page,{groups:{groupA:[assignment('rollback-job')]},html:{'rollback-job':failing}});
  const result=await page.evaluate(async practice=>{
    __test.setData([practice]);__test.state.stage=3;
    const bytes=new Uint8Array([1,2,3]).buffer;
    __test.setImages([['http://fixture.test/retained.png',{filename:'retained.png',buffer:bytes,downloaded:true,failed:false}]]);
    const saved=JSON.stringify(__test.data);let error='';
    try{await __test.runHomeworkSupplement();}catch(failure){error=failure.message;}
    const rolledBack={error,unchanged:JSON.stringify(__test.data)===saved,cursor:__test.state.homeworkProgress.cursor,
      images:__test.images.size,bytes:Array.from(new Uint8Array(__test.images.get('http://fixture.test/retained.png').buffer))};
    __homeworkConfig.html['rollback-job']=__homeworkConfig.html['rollback-job'].replace(/<svg>[\s\S]*?<\/svg>/,'<p>Supported replacement</p>');
    await __test.runHomeworkSupplement();
    return {rolledBack,data:__test.data,progress:__test.state.homeworkProgress,images:[...__test.images].map(([url,item])=>[url,item.filename])};
  },program());
  assert.match(result.rolledBack.error,/SVG/);assert.equal(result.rolledBack.unchanged,true);assert.equal(result.rolledBack.cursor,0);
  assert.equal(result.rolledBack.images,1);assert.deepEqual(result.rolledBack.bytes,[1,2,3]);
  assert.equal(result.data.length,3);assert.equal(result.progress.added,2);assert.equal(result.progress.done,true);
  assert.deepEqual(result.images,[['http://fixture.test/retained.png','retained.png'],['http://fixture.test/fixtures/new.png','img_1.png']]);
}));

test('StudentJob pipeline: official duplicate answer images are localized without replacing the original Practice question',()=>withHomework(async page=>{
  const options='<div class="div_TopicOptions"><p class="p_TopicOption">A. Alpha</p><p class="p_TopicOption">B. Beta</p></div>';
  const html=homeworkPage([questionBox('shared-objective',1,'<p>Official image answer fixture</p>','',options+
    '<div class="official-answer"><label>【正确答案】</label><p>Alpha</p><img src="/fixtures/official-answer.png" alt="Answer diagram"></div>')],1,'单选题');
  await mockHomework(page,{groups:{groupA:[assignment('answer-job')]},html:{'answer-job':html}});
  const result=await page.evaluate(async({html,job,baseUrl})=>{
    const row=__test.parseHomeworkDetail(html,job,baseUrl).questions[0];
    Object.assign(row,{GlobalUID:0,CollectionSource:'practice',ChapterName:'Original Practice chapter',HomeworkSources:[],s2_done:true,SniffedAnswer:'Old AI response',IsAIAnswer:true,AnswerSource:'ai',AIInfo:{model:'synthetic-old'},NeedsAI:false});
    const originalTitle=row.Title,originalDetail=row.DetailHtml;
    __test.setData([row]);__test.state.stage=3;await __test.runHomeworkSupplement();
    return {row:__test.data[0],length:__test.data.length,progress:__test.state.homeworkProgress,images:[...__test.images.keys()],originalTitle,originalDetail};
  },{html,job,baseUrl});
  assert.equal(result.length,1);assert.equal(result.progress.duplicates,1);assert.equal(result.progress.added,0);
  assert.equal(result.row.CollectionSource,'practice');assert.equal(result.row.ChapterName,'Original Practice chapter');
  assert.equal(result.row.Title,result.originalTitle);assert.equal(result.row.DetailHtml,result.originalDetail);
  assert.equal(result.row.IsAIAnswer,false);assert.equal(result.row.AnswerSource,'platform-answer');assert.equal(result.row.NeedsAI,false);
  assert.match(result.row.SniffedAnswer,/src="images\/img_1.png"/);assert.match(result.row.SniffedAnswer,/data-original="http:\/\/fixture.test\/fixtures\/official-answer.png"/);
  assert.deepEqual(result.images,['http://fixture.test/fixtures/official-answer.png']);
  assert.deepEqual(result.row.imgUrls,result.images);
}));

test('StudentJob pipeline: empty group menus, truncated lists and unknown review states cannot report completion',()=>withHomework(async page=>{
  await mockHomework(page,{groups:{groupA:[assignment('invalid-job')]},html:{'invalid-job':homeworkPage()}});
  const result=await page.evaluate(async()=>{
    const originalRespond=__respond;
    const cases=[
      async request=>new URL(request.url,location.origin).pathname.endsWith('/Index')&&String(request.type).toLowerCase()==='get'?'<table id="table_UserTaskInfo"></table><select id="select_StudentGroups"></select>':originalRespond(request),
      async request=>new URL(request.url,location.origin).pathname.endsWith('/Index')&&String(request.type).toLowerCase()==='post'?{Result:true,Element:{total:2,rows:[__homeworkConfig.groups.groupA[0]]}}:originalRespond(request),
      async request=>new URL(request.url,location.origin).pathname.endsWith('/JobStudentsScore')?{Result:true,Element:[{RunState:'UNKNOWN',UserGuid:'PRIVATE_SYNTHETIC_USER_GUID'}]}:originalRespond(request)
    ];
    const results=[];
    for(const respond of cases) {
      __respond=respond;delete __test.state.homeworkProgress;__test.setData([]);__test.state.stage=3;
      let error='';try{await __test.runHomeworkSupplement();}catch(failure){error=failure.message;}
      results.push({error,done:!!__test.state.homeworkProgress?.done,count:__test.data.length});
    }
    return results;
  });
  for(const [index,row] of result.entries()) {assert.ok(row.error,'malformed case '+index+' must fail');assert.equal(row.done,false);assert.equal(row.count,0);}
}));

test('StudentJob pipeline: importing completed or legacy snapshots rescans while an unfinished cursor resumes precisely',()=>withHomework(async page=>{
  const practice=program();
  const html=homeworkPage([questionBox(practice.TopicGuid,1,practice.Title,practice.Requirement)]);
  await mockHomework(page,{groups:{groupA:[assignment('job1'),assignment('job2')]},html:{job1:html,job2:html}});
  const template=await page.evaluate(practice=>{
    __setSettings({resumeSettings:'current'});
    __test.setEngineStage(3,async()=>{__test.state.isPaused=true;});
    __test.setBuilder(async()=>{window.__importFinished=(window.__importFinished||0)+1;});
    return {schemaVersion:1,globalState:{...__test.state,stage:5,isPaused:true},allData:[practice],imageQueueList:[],imgCounter:1};
  },practice);
  const jobs=['job1','job2'].map(id=>({id,paperId:id,name:'Synthetic '+id,start:'',end:''}));
  for(const [index,mode] of ['legacy','complete','paused'].entries()) {
    const state=structuredClone(template);
    if(mode!=='legacy') state.globalState.homeworkProgress={version:1,jobs,scope:{groups:['groupA'],language:'Java'},cursor:mode==='paused'?1:2,discovered:mode==='paused'?1:2,duplicates:mode==='paused'?1:2,added:0,skipped:[],done:mode==='complete'};
    if(mode==='paused') state.globalState.stage=3;
    const zip=new JSZip();zip.file('state.json',JSON.stringify(state));
    const buffer=await zip.generateAsync({type:'nodebuffer'});
    await page.evaluate(()=>{__homeworkEvents.length=0;});
    await page.locator('#bistu-file-input').setInputFiles({name:mode+'-synthetic.zip',mimeType:'application/zip',buffer});
    await page.waitForFunction(expected=>window.__importFinished===expected,index+1);
    const actual=await page.evaluate(()=>({events:__homeworkEvents,data:__test.data,progress:__test.state.homeworkProgress,stage:__test.state.stage}));
    assert.equal(actual.stage,3,mode);assert.equal(actual.progress.done,true,mode);assert.equal(actual.progress.cursor,2,mode);assert.equal(actual.data.length,1,mode);
    assert.equal(actual.events.includes('scores:job1'),mode!=='paused',mode+' preserves exactly the appropriate cursor');
    assert.ok(actual.events.includes('scores:job2'),mode);assert.equal(actual.data[0].SniffedAnswer,practice.SniffedAnswer,mode);
  }
}));

test('StudentJob reader: Illinois overlaps semester homework while new-only badges distinguish existing Practice questions',()=>withHomework(async page=>{
  const english=homeworkPage([questionBox('english-homework',1,'<p>Write a Java program that reads two integers and prints their sum.</p>','<p>Input contains two integers. Output their sum on one line.</p>')]);
  const chinese=homeworkPage([questionBox('chinese-homework',1,'<p>编写程序，读取两个整数并输出它们的和，必须严格遵守输入输出要求。</p>','<p>输入两个整数，输出它们的和，不要输出额外提示。</p>')]);
  const result=await page.evaluate(({english,chinese,job,baseUrl})=>{
    const added=[...__test.parseHomeworkDetail(english,job,baseUrl).questions,...__test.parseHomeworkDetail(chinese,job,baseUrl).questions];
    const referenced={GlobalUID:2,TopicGuid:'referenced-practice',QuestionType:'Program',ChapterName:'Programming',CollectionSource:'practice',
      Title:'<p>Original English Practice question.</p>',DetailHtml:'<p>Original English Practice question.</p>',HomeworkSources:[{jobId:job.id,name:job.name}],s2_done:true};
    const unrelated={GlobalUID:3,TopicGuid:'unrelated-practice',QuestionType:'Program',ChapterName:'基础',CollectionSource:'practice',
      Title:'<p>普通练习题，不属于作业。</p>',DetailHtml:'<p>普通练习题，不属于作业。</p>',s2_done:true};
    __test.setData([...added.map((row,GlobalUID)=>({...row,GlobalUID,s2_done:true})),referenced,unrelated]);
    return {chapters:added.map(row=>row.ChapterName),html:__test.generateOfflineHtml(true)};
  },{english,chinese,job,baseUrl});
  assert.deepEqual(result.chapters,['作业补充','作业补充'],'stored source chapters remain unchanged; the reader derives compatible labels');
  await page.setContent(result.html,{waitUntil:'domcontentloaded'});
  assert.equal(await page.locator('.topic').count(),4);
  await page.locator('#sourceFilter').selectOption('illinois');
  await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='2');
  assert.equal(await page.locator('.topic:not(.hidden)[data-chapter="Programming"]').count(),2);
  await page.locator('#sourceFilter').selectOption('homework');
  await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='3');
  assert.equal(await page.locator('.topic:not(.hidden)[data-homework="true"]').count(),3);
  assert.equal(await page.locator('.topic:not(.hidden)[data-homework-only="true"]').count(),2);
  assert.match(await page.locator('.topic:not(.hidden)').allTextContents().then(rows=>rows.join('\n')),/Original English Practice question/);
  assert.doesNotMatch(await page.locator('.topic:not(.hidden)').allTextContents().then(rows=>rows.join('\n')),/普通练习题，不属于作业/);
  await page.locator('#chapterFilter').selectOption('Programming');
  await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='2');
  assert.match(await page.locator('.topic:not(.hidden) .detail-box').allTextContents().then(rows=>rows.join('\n')),/reads two integers/);
  await page.locator('#resetFilters').click();
  await page.waitForFunction(()=>document.querySelector('#visibleCount').textContent==='4');
}));
