// One Docker exec per benchmark, then stdin/stdout only; no network listener.
import {createInterface} from 'node:readline';
import {request} from 'node:http';
import {readFile} from 'node:fs/promises';
const key=(await readFile('/tmp/capture-input-key','utf8')).trim();
const lines=createInterface({input:process.stdin});
console.log(JSON.stringify({ready:true}));
for await (const line of lines) {
  if(line.length>2048){console.log(JSON.stringify({error:'too large'}));continue}
  const response=await new Promise(resolve=>{
    const req=request({socketPath:'/tmp/capture-input.sock',path:'/input',method:'POST',headers:{authorization:`Bearer ${key}`,'content-length':Buffer.byteLength(line)}},res=>{
      let body='';res.on('data',p=>body+=p);res.on('end',()=>resolve({status:res.statusCode,body}));
    });
    req.setTimeout(3000,()=>req.destroy());req.on('error',e=>resolve({error:e.code}));req.end(line);
  });
  console.log(JSON.stringify(response));
}
