import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const directory=path.join(root,'monthly-data');
await fs.mkdir(directory,{recursive:true});
const sourceRoot=process.argv[2];
if(!sourceRoot)throw Error('Pass existing monthly-analysis directory');
const load=async file=>JSON.parse(await fs.readFile(path.join(sourceRoot,file),'utf8'));
const census=await load('cache-census.json');
const extraCli=await load('cli-cache-census.json');
const extraViper=await load('viper-cache-census.json');
const projects=['client_golang','viper','cli'];
const cleanJobs=[];
const cleanRuns=[];
for(const slug of projects){
 const runs=await load(slug+'-runs.json');
 const jobs=await load(slug+'-jobs.json');
 const byRun=new Map(runs.map(r=>[r.id,r]));
 cleanRuns.push(...runs.map(r=>({slug,id:r.id,event:r.event,branch:r.head_branch,headSha:r.head_sha,runAttempt:r.run_attempt,createdAt:r.created_at,status:r.status,conclusion:r.conclusion,url:r.html_url,pullRequests:r.pull_requests.map(p=>({number:p.number,baseRef:p.base.ref,headRef:p.head.ref}))})));
 for(const j of jobs){
  if(!j.labels?.some(x=>/windows|ubuntu/i.test(x)))continue;
  const run=byRun.get(j.workflowRunId);
  const setup=j.steps?.find(s=>/^(Set up Go|Install Go)/i.test(s.name));
  if(!setup)continue;
  const started=setup.started_at&&setup.conclusion!=='skipped';
  const os=j.labels.some(x=>/windows/i.test(x))?'Windows':'Linux';
  const arch=j.labels.includes('ubuntu-24.04-arm')?'arm64':'x64';
  cleanJobs.push({slug,os,arch,id:j.id,runId:j.workflowRunId,runAttempt:j.run_attempt,name:j.name,conclusion:j.conclusion,event:run.event,branch:run.head_branch,pullRequest:run.pull_requests[0]?.number,createdAt:run.created_at,setupStarted:Boolean(started),setupConclusion:setup.conclusion,setupSeconds:started?(Date.parse(setup.completed_at)-Date.parse(setup.started_at))/1000:null,post:j.steps.filter(s=>/^Post (Set up Go|Install Go)/i.test(s.name)).map(s=>({conclusion:s.conclusion,seconds:(Date.parse(s.completed_at)-Date.parse(s.started_at))/1000})),runnerSeconds:j.started_at&&j.completed_at?(Date.parse(j.completed_at)-Date.parse(j.started_at))/1000:null,url:j.html_url});
 }
}
const observations=[...census.observations.filter(x=>x.slug==='client_golang'),...extraViper.observations,...extraCli.observations];
const model=[];
for(const x of observations){
 const j=cleanJobs.find(j=>j.id===x.jobId);
 if(!j)throw Error('Observation not found');
 const key=x.restoredKeys?.[0]||x.savedKeys?.[0]||x.requestedKeys?.[0];
 const dependencyHash=key?.split('-').at(-1);
 const exactVersion=x.versions?.[0];
 const caseId=x.slug==='client_golang'?(x.os==='Windows'?'client-windows':j.arch==='arm64'?'client-arm64':'client-linux'):x.slug==='cli'?`${exactVersion==='1.26.8'?'cli126':'cli'}-${x.os==='Windows'?'windows':'linux'}`:(x.os==='Windows'?'viper-windows':'viper-linux');
 // Never assume modules were already present just because another job in the
 // same matrix eventually saved them. Job-start overlap and branch scope matter.
 const groupOthers=observations.filter(y=>y.slug===x.slug&&y.os===x.os&&y.jobId!==x.jobId&&(y.restoredKeys?.[0]||y.savedKeys?.[0]||y.requestedKeys?.[0])?.split('-').at(-1)===dependencyHash);
 const sameRunOtherVersion=groupOthers.some(y=>y.runId===x.runId&&y.versions?.[0]!==exactVersion);
 const earlierVersionEvidence=groupOthers.filter(y=>Date.parse(y.createdAt)<Date.parse(x.createdAt)&&y.versions?.[0]!==exactVersion);
 // A known default-branch cache can be read from PRs, whereas another PR's
 // cache is not accessible. Same PR evidence is retained separately.
 const defaultBranchEarlier=earlierVersionEvidence.filter(y=>cleanJobs.find(j=>j.id===y.jobId)?.event==='push');
 const sameBranchEarlier=earlierVersionEvidence.filter(y=>cleanJobs.find(j=>j.id===y.jobId)?.branch===j.branch);
 model.push({...x,arch:j.arch,caseId,dependencyHash,exactVersion,scope:{event:j.event,branch:j.branch,pullRequest:j.pullRequest},sameRunOtherVersion,earlierOtherVersionEvidence:earlierVersionEvidence.length,defaultBranchEarlierOtherVersionEvidence:defaultBranchEarlier.length,sameBranchEarlierOtherVersionEvidence:sameBranchEarlier.length,missCounterfactual:x.classification==='miss'?'unknown; bound between both-miss and module-hit/build-miss':'warm exact hit',upstreamPinnedActionDifference:x.slug==='viper'?'v5.2; benchmark isolates cache layout on modern common dependency baseline':'v7; benchmark isolates cache layout, not unrelated release changes'});
}
const counts=[];
for(const caseId of [...new Set(model.map(x=>x.caseId))]){
 const a=model.filter(x=>x.caseId===caseId);
 for(const version of [...new Set(a.map(x=>x.exactVersion||'unknown'))]){
  const b=a.filter(x=>(x.exactVersion||'unknown')===version);
  counts.push({caseId,version,successfulJobs:b.length,exactHits:b.filter(x=>x.classification==='exact-hit').length,misses:b.filter(x=>x.classification==='miss').length,unknown:b.filter(x=>!['exact-hit','miss'].includes(x.classification)).length,missesWithEarlierOtherVersionScopeEvidence:b.filter(x=>x.classification==='miss'&&(x.defaultBranchEarlierOtherVersionEvidence||x.sameBranchEarlierOtherVersionEvidence)).length,missesWithSameRunOtherVersion:b.filter(x=>x.classification==='miss'&&x.sameRunOtherVersion).length});
 }
}
await fs.writeFile(path.join(directory,'jobs.json'),JSON.stringify(cleanJobs,null,2)+'\n');
await fs.writeFile(path.join(directory,'runs.json'),JSON.stringify(cleanRuns,null,2)+'\n');
await fs.writeFile(path.join(directory,'cache-census.json'),JSON.stringify(model,null,2)+'\n');
await fs.writeFile(path.join(directory,'counts.json'),JSON.stringify({window:{start:'2026-09-06T00:00:00Z',end:'2026-10-06T00:00:00Z',days:30},counts,coverage:cleanJobs.reduce((o,j)=>{const k=j.slug+'/'+j.os+'/'+j.arch;const v=o[k]??={jobs:0,successfulJobs:0,setupReached:0,setupSucceeded:0,runnerSeconds:0};v.jobs++;v.successfulJobs+=j.conclusion==='success';v.setupReached+=j.setupStarted;v.setupSucceeded+=j.setupConclusion==='success';v.runnerSeconds+=j.runnerSeconds||0;return o;},{})},null,2)+'\n');
console.log(JSON.stringify(counts,null,2));
