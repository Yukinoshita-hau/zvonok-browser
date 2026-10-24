import {createServer} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {writeFile,chmod,unlink} from 'node:fs/promises';
export function validAction(a){
  return a && Object.keys(a).length===1 && ['click','type','scroll'].includes(a.action);
}
export async function inputControl(page,onActivity){
  const key=randomBytes(32).toString('hex');
  await writeFile('/tmp/capture-input-key',key,{mode:0o600});
  await unlink('/tmp/capture-input.sock').catch(e=>{if(e.code!=='ENOENT')throw e});
  let busy=false;
  const server=createServer(async(req,res)=>{
    const a=Buffer.from(req.headers.authorization??''),b=Buffer.from(`Bearer ${key}`);
    if(req.method!=='POST'||req.url!=='/input'||a.length!==b.length||!timingSafeEqual(a,b)){res.writeHead(403).end();return}
    const n=Number(req.headers['content-length']);
    if(req.headers['transfer-encoding']||!Number.isInteger(n)||n<1||n>128){res.writeHead(400).end();return}
    if(busy){res.writeHead(429).end();return}busy=true;
    try{
      let body='';for await(const p of req){body+=p;if(body.length>128)throw Error('size')}
      const command=JSON.parse(body);if(!validAction(command))throw Error('schema');
      if(command.action==='click')await page.getByRole('button',{name:'Change pixels'}).click();
      if(command.action==='type'){await page.getByRole('textbox',{name:'Text',exact:true}).focus();await page.keyboard.insertText('x')}
      if(command.action==='scroll'){await page.mouse.move(900,600);await page.mouse.wheel(0,await page.evaluate(()=>scrollY>100? -200:200))}
      onActivity();res.writeHead(204).end();
    }catch{res.writeHead(400).end()}finally{busy=false}
  });
  server.maxConnections=2;server.timeout=3000;server.requestTimeout=3000;server.headersTimeout=3000;
  await new Promise(resolve=>server.listen('/tmp/capture-input.sock',resolve));await chmod('/tmp/capture-input.sock',0o600);
  return server;
}
