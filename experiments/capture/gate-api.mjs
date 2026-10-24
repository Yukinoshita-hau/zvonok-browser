import {readFile,writeFile} from 'node:fs/promises';
const token=(await readFile('.env','utf8')).split(/\r?\n/).find(x=>x.startsWith('DEV_TOKEN=')).slice(10).trim();
const rows=[],base='http://127.0.0.1:47831/api';
async function call(path,method='GET',body){
 const start=performance.now(),at=Date.now();
 const res=await fetch(base+path,{method,headers:{authorization:`Bearer ${token}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
 const text=await res.text();let data;try{data=JSON.parse(text)}catch{data=text}
 rows.push({path,method,at,durationMs:performance.now()-start,status:res.status,data});return {status:res.status,data};
}
try{
 for(let attempt=0;attempt<3;attempt++){
  await call('/ready');const created=await call('/sessions','POST',{});if(created.status!==201)continue;
  const path='/sessions/'+created.data.sessionId;
  try{
   for(const [action,body] of [['navigate',{url:'https://example.com/'}],['navigate',{url:'https://www.selenium.dev/selenium/web/web-form.html'}],['back',{}],['forward',{}],['reload',{}]]){
    await call(path+'/'+action,'POST',body);await call(path);await call('/ready');
   }
  }finally{await call(path,'DELETE')}
 }
}finally{await writeFile(`artifacts/gate-api-${process.env.GATE_API??'capture'}.json`,JSON.stringify(rows,null,2));console.table(rows.map(({path,status,durationMs})=>({path,status,durationMs})));if(rows.some(r=>r.status>=400))process.exitCode=1}
