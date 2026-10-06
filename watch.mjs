import {spawn} from 'node:child_process';
const run=process.argv[2];
if(!/^\d+$/.test(run??''))throw Error('Pass workflow run ID');
const child=spawn('gh',['run','watch',run,'--repo','qmuntal/setup-go-runner-hours-20261006','--exit-status','--interval','60'],{env:{...process.env,CI:'true',TERM:'dumb'},stdio:['ignore','pipe','pipe']});
const clean=b=>b.toString().replace(/\x1b\[[?0-9;]*[A-Za-z]/g,'').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'');
child.stdout.on('data',b=>process.stdout.write(clean(b)));
child.stderr.on('data',b=>process.stderr.write(clean(b)));
child.on('error',e=>{console.error(e.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
