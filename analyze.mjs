import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const output=path.join(root,'analysis');await fs.mkdir(output,{recursive:true});
const observations=JSON.parse(await fs.readFile(path.join(root,'monthly-data/cache-census.json'),'utf8'));
const counts=JSON.parse(await fs.readFile(path.join(root,'monthly-data/counts.json'),'utf8'));
const samples=[];
for(const dir of await fs.readdir(path.join(root,'results'),{withFileTypes:true})){
 if(!dir.isDirectory()||!/^\d+$/.test(dir.name))continue;
 const runFile=path.join(root,'results',dir.name,'run.json');const run=JSON.parse(await fs.readFile(runFile,'utf8').catch(()=>'{"headSha":""}'));
 // Reject old incomplete pilots and pre-USS sampler data. Accept the complete
 // independent-series implementation and the CLI/Windows shell-only changes.
 if(!['c1c0babd702643fd92be4f4b870757ffc4f6e7a8','1d7ca4b','8a956b6','1fa9a58'].some(sha=>run.headSha.startsWith(sha)))continue;
 for(const entry of await fs.readdir(path.join(root,'results',dir.name),{withFileTypes:true})){
  if(!entry.isDirectory())continue;const file=path.join(root,'results',dir.name,entry.name,'sample.json');const text=await fs.readFile(file,'utf8').catch(()=>null);if(!text)continue;
  const s=JSON.parse(text);if(!s.complete||!s.ownedCachesCleaned||s.measurements.length!==6)continue;
  if(s.measurements.some(x=>x.setup.exitCode||x.post.exitCode||x.workload.some(y=>y.exitCode)||x.setup.peakProcessTreeUssBytes==null))continue;
  samples.push({...s,harnessSha:run.headSha});
 }
}
const unique=new Map();
for(const s of samples){const key=`${s.case.id}/${s.version}/${s.sample}`;if(unique.has(key))throw Error('Duplicate accepted pair '+key);unique.set(key,s);}
const accepted=[...unique.values()];
const groups=new Map();for(const s of accepted){const k=`${s.case.id}/${s.version}`;(groups.get(k)??groups.set(k,[]).get(k)).push(s);}
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const median=a=>{const s=[...a].sort((a,b)=>a-b);return (s[Math.floor((s.length-1)/2)]+s[Math.ceil((s.length-1)/2)])/2;};
let state=0x628ef012;const random=()=>{state^=state<<13;state^=state>>>17;state^=state<<5;return (state>>>0)/4294967296;};
const percentile=(a,p)=>[...a].sort((a,b)=>a-b)[Math.floor((a.length-1)*p)];
const scenarios=['cold','warm','module-hit'];
const rows=[];
for(const [key,ss] of groups){
 ss.sort((a,b)=>a.sample-b.sample);const [caseId,version]=key.split('/');
 for(const scenario of scenarios){
  const pair=ss.map(s=>{const baseline=s.measurements.find(m=>m.variant==='baseline'&&m.scenario===scenario),split=s.measurements.find(m=>m.variant==='split'&&m.scenario===scenario);if(!baseline||!split)throw Error('Missing pair');return {sample:s.sample,runId:s.runId,baseline,split,totalSavedSeconds:baseline.totalMeasuredSeconds-split.totalMeasuredSeconds,cacheSavedSeconds:baseline.cacheSeconds-split.cacheSeconds,setupSavedSeconds:baseline.setup.seconds-split.setup.seconds,postSavedSeconds:baseline.post.seconds-split.post.seconds,memoryDeltaUssMiB:(Math.max(split.setup.peakProcessTreeUssBytes,split.post.peakProcessTreeUssBytes)-Math.max(baseline.setup.peakProcessTreeUssBytes,baseline.post.peakProcessTreeUssBytes))/1024**2};});
  const bootstrap=[];for(let i=0;i<10000;i++)bootstrap.push(mean(Array.from({length:pair.length},()=>pair[Math.floor(random()*pair.length)].totalSavedSeconds)));
    const baselineMean=mean(pair.map(x=>x.baseline.totalMeasuredSeconds));
    const splitMean=mean(pair.map(x=>x.split.totalMeasuredSeconds));
    rows.push({caseId,version,scenario,n:pair.length,samples:pair.map(x=>x.sample),completeTenPairs:pair.length===10,baselineMeanSeconds:baselineMean,splitMeanSeconds:splitMean,meanSavedSeconds:mean(pair.map(x=>x.totalSavedSeconds)),medianSavedSeconds:median(pair.map(x=>x.totalSavedSeconds)),meanCacheSavedSeconds:mean(pair.map(x=>x.cacheSavedSeconds)),meanSetupSavedSeconds:mean(pair.map(x=>x.setupSavedSeconds)),meanPostSavedSeconds:mean(pair.map(x=>x.postSavedSeconds)),bootstrap95MeanSavedSeconds:[percentile(bootstrap,.025),percentile(bootstrap,.975)],splitFasterCount:pair.filter(x=>x.totalSavedSeconds>0).length,baselineFasterCount:pair.filter(x=>x.totalSavedSeconds<0).length,medianBaselinePeakUssMiB:median(pair.map(x=>Math.max(x.baseline.setup.peakProcessTreeUssBytes,x.baseline.post.peakProcessTreeUssBytes)/1024**2)),medianSplitPeakUssMiB:median(pair.map(x=>Math.max(x.split.setup.peakProcessTreeUssBytes,x.split.post.peakProcessTreeUssBytes)/1024**2)),medianUssDeltaMiB:median(pair.map(x=>x.memoryDeltaUssMiB)),pairs:pair.map(x=>({sample:x.sample,runId:x.runId,totalSavedSeconds:x.totalSavedSeconds,cacheSavedSeconds:x.cacheSavedSeconds,setupSavedSeconds:x.setupSavedSeconds,postSavedSeconds:x.postSavedSeconds,memoryDeltaUssMiB:x.memoryDeltaUssMiB,baselineTotalSeconds:x.baseline.totalMeasuredSeconds,splitTotalSeconds:x.split.totalMeasuredSeconds,baselineFirst:x.baseline.orderIndex===0,baseline:x.baseline,split:x.split}))});
 }
}
const model=[];
for(const count of counts.counts){
 const warm=rows.find(x=>x.caseId===count.caseId&&x.version===count.version&&x.scenario==='warm');
 const cold=rows.find(x=>x.caseId===count.caseId&&x.version===count.version&&x.scenario==='cold');
 const mod=rows.find(x=>x.caseId===count.caseId&&x.version===count.version&&x.scenario==='module-hit');
 if(!warm||!cold||!mod){model.push({...count,measured:false});continue;}
 const nWarm=count.exactHits,nMiss=count.misses;
 const lowMiss=Math.min(cold.meanSavedSeconds,mod.meanSavedSeconds),highMiss=Math.max(cold.meanSavedSeconds,mod.meanSavedSeconds);
 // Counterfactual envelope is separate from measurement uncertainty. Counts
 // of restore-service errors are excluded, not recast as normal misses.
 const envelope=[(nWarm*warm.meanSavedSeconds+nMiss*lowMiss)/3600,(nWarm*warm.meanSavedSeconds+nMiss*highMiss)/3600];
 const boot=[];
 const bySample=groups.get(`${count.caseId}/${count.version}`);
 for(let i=0;i<10000;i++){
  const picked=Array.from({length:bySample.length},()=>bySample[Math.floor(random()*bySample.length)]);
  const difference=scenario=>mean(picked.map(s=>s.measurements.find(x=>x.scenario===scenario&&x.variant==='baseline').totalMeasuredSeconds-s.measurements.find(x=>x.scenario===scenario&&x.variant==='split').totalMeasuredSeconds));
  boot.push({allCold:(nWarm*difference('warm')+nMiss*difference('cold'))/3600,allModuleHit:(nWarm*difference('warm')+nMiss*difference('module-hit'))/3600});
 }
 model.push({...count,measured:true,completeTenPairs:warm.completeTenPairs&&cold.completeTenPairs&&mod.completeTenPairs,warmOnlyHours:nWarm*warm.meanSavedSeconds/3600,missCounterfactualEnvelopeHours:envelope,allColdHours:(nWarm*warm.meanSavedSeconds+nMiss*cold.meanSavedSeconds)/3600,allModuleHitHours:(nWarm*warm.meanSavedSeconds+nMiss*mod.meanSavedSeconds)/3600,allCold95Hours:[percentile(boot.map(x=>x.allCold),.025),percentile(boot.map(x=>x.allCold),.975)],allModuleHit95Hours:[percentile(boot.map(x=>x.allModuleHit),.025),percentile(boot.map(x=>x.allModuleHit),.975)],excludedUnknownOrErrorJobs:count.unknown});
}
const sanitized=accepted.map(s=>({...s,measurements:s.measurements.map(m=>({...m,entries:m.entries.map(e=>({kind:e.kind,primaryKey:e.primaryKey,matchedKey:e.matchedKey}))}))}));
await fs.writeFile(path.join(output,'accepted-samples.json'),JSON.stringify(sanitized,null,2)+'\n');
await fs.writeFile(path.join(output,'paired-results.json'),JSON.stringify(rows,null,2)+'\n');
await fs.writeFile(path.join(output,'monthly-results.json'),JSON.stringify({window:counts.window,acceptedRunnerPairs:accepted.length,rows:model,coverage:counts.coverage,claim:'conditional successful-job cache-layout estimate; not billed time or guaranteed future month; negative means extra runner time'},null,2)+'\n');
console.log(JSON.stringify({acceptedRunnerPairs:accepted.length,results:rows.map(({pairs,...r})=>r),monthly:model},null,2));
