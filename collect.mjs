import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
const repo='qmuntal/setup-go-runner-hours-20261006';
const api=p=>JSON.parse(execFileSync('gh',['api',p],{encoding:'utf8',maxBuffer:128*1024*1024}));
const runId=process.argv[2];
if(!/^\d+$/.test(runId??''))throw Error('Pass completed run ID');
const run=api(`repos/${repo}/actions/runs/${runId}`);
if(run.status!=='completed')throw Error('Workflow is not complete');
const dest=path.join(root,'results',runId);
await fs.mkdir(dest,{recursive:true});
execFileSync('gh',['run','download',runId,'--repo',repo,'--dir',dest],{stdio:'inherit'});
const rawJobs=[];
for(let page=1;;page++){const j=api(`repos/${repo}/actions/runs/${runId}/jobs?per_page=100&page=${page}`).jobs;rawJobs.push(...j);if(j.length<100)break;}
const jobs=rawJobs.map(j=>({id:j.id,name:j.name,conclusion:j.conclusion,startedAt:j.started_at,completedAt:j.completed_at,labels:j.labels,url:j.html_url}));
await fs.writeFile(path.join(dest,'jobs.json'),JSON.stringify(jobs,null,2)+'\n');
await fs.writeFile(path.join(dest,'run.json'),JSON.stringify({id:run.id,headSha:run.head_sha,createdAt:run.created_at,status:run.status,conclusion:run.conclusion,url:run.html_url},null,2)+'\n');
const measurements=[];
for(const item of await fs.readdir(dest,{withFileTypes:true})){if(!item.isDirectory())continue;const file=path.join(dest,item.name,'sample.json');const text=await fs.readFile(file,'utf8').catch(()=>null);if(text)measurements.push(JSON.parse(text));}
for(const s of measurements){console.log(JSON.stringify({case:s.case.id,version:s.version,sample:s.sample,complete:s.complete,cleaned:s.ownedCachesCleaned,measurements:s.measurements.length,phases:s.measurements.map(x=>({variant:x.variant,scenario:x.scenario,cacheSeconds:x.cacheSeconds,totalSeconds:x.totalMeasuredSeconds,setupPeakMiB:x.setup.peakProcessTreeRssBytes/1024**2,postPeakMiB:x.post.peakProcessTreeRssBytes/1024**2,uploadedMiB:x.cacheRecords.reduce((n,c)=>n+c.size_in_bytes,0)/1024**2}))}));}
console.log(`Collected ${measurements.length} sanitized runner samples from ${runId} (${run.conclusion}).`);
