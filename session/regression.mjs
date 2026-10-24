import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const out=`artifacts/session-regression-${Date.now()}`;await mkdir(out);
function run(name,args,input) {
 try {const result=execFileSync(args[0],args.slice(1),{encoding:'utf8',input,stdio:['pipe','pipe','pipe'],timeout:180000});return writeFile(`${out}/${name}.log`,result).then(()=>({name,result:'PASS'}));}
 catch(e){return writeFile(`${out}/${name}.log`,(e.stdout??'')+'\n'+(e.stderr??'')).then(()=>({name,result:'FAIL',exit:e.status}));}
}
const docker=['docker','--context','desktop-linux','compose'];const rows=[];
let acceptance=await readFile('scripts/acceptance.ps1','utf8');
acceptance=acceptance.replace('Set-Location (Split-Path $PSScriptRoot)',`Set-Location '${process.cwd()}'`).replace('http://127.0.0.1:47831/api',process.env.API_BASE??'http://127.0.0.1:48031/api').replaceAll('artifacts/frame.png',`${out}/frame.png`);
await writeFile(`${out}/api.ps1`,acceptance);
rows.push(await run('api',['pwsh','-NoProfile','-File',`${out}/api.ps1`]));
rows.push(await run('original-network',[...docker,'exec','-T','worker','node24','scripts/network-check.mjs']));
rows.push(await run('original-browser',[...docker,'exec','-T','worker','node24','scripts/browser-check.mjs']));
rows.push(await run('session-network',[...docker,'-f','compose.session.yaml','exec','-T','worker','node24','--input-type=module'],await readFile('session/network-check.mjs','utf8')));
await writeFile(`${out}/results.json`,JSON.stringify(rows,null,2));console.table(rows);console.log(out);
if(rows.some(r=>r.result==='FAIL'))process.exitCode=1;
