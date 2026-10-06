import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
// A JavaScript action receives the runner's cache-service environment. Do not
// print that environment or persist tokens; inherit it only into the measured
// action subprocesses and psutil sampler.
const child=spawn('python',[path.join(root,'measure.py'),'--case',process.env.INPUT_CASE,'--version',process.env.INPUT_VERSION,'--sample',process.env.INPUT_SAMPLE],{stdio:'inherit',env:process.env});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
