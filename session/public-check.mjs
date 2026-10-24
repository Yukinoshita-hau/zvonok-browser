import {chromium}from'playwright';import{readFile,mkdir,writeFile}from'node:fs/promises';import assert from'node:assert/strict';
const token=(await readFile('.env','utf8')).split(/\r?\n/).find(s=>s.startsWith('DEV_TOKEN=')).slice(10).trim();
const out='artifacts/session-public-'+Date.now();await mkdir(out);const browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:1400,height:1100}});let session,png=0;
page.on('request',r=>{if(r.url().endsWith('/frame'))png++;});
try{
 for(let i=0;i<50;i++){try{if((await fetch('http://127.0.0.1:48031/api/ready')).ok)break;}catch{}await page.waitForTimeout(200);}
 await page.goto('http://127.0.0.1:48031');await page.getByLabel('Dev token').fill(token);
 const created=page.waitForResponse(r=>r.url()==='http://127.0.0.1:48031/api/sessions' && r.request().method()==='POST');await page.getByRole('button',{name:'Создать браузер',exact:true}).click();session=await(await created).json();assert.equal(session.status,'active');
 await page.waitForFunction(()=>window.sessionMediaMetrics?.framesDecoded>10,null,{timeout:30000});
 await page.getByLabel('HTTPS адрес').fill('https://example.com/');const navigated=page.waitForResponse(r=>r.url().endsWith('/navigate'));await page.getByRole('button',{name:'Перейти',exact:true}).click();assert.equal((await navigated).status(),200);
 const before=await page.evaluate(()=>window.sessionMediaMetrics.framesDecoded);await page.waitForFunction(n=>window.sessionMediaMetrics.framesDecoded>n+40,before,{timeout:15000});await page.screenshot({path:out+'/public-live.png',fullPage:true});assert.equal(png,0);
 const metrics=await page.evaluate(()=>window.sessionMediaMetrics);await page.getByRole('button',{name:'Завершить',exact:true}).click();await page.waitForSelector('[data-testid=session-ended]');assert.equal(await page.locator('video').count(),0);await writeFile(out+'/results.json',JSON.stringify({result:'PASS',url:'https://example.com/',metrics,pngRequests:png},null,2));console.log(out);
}finally{if(session?.sessionId)await fetch('http://127.0.0.1:48031/api/sessions/'+session.sessionId,{method:'DELETE',headers:{authorization:`Bearer ${token}`}}).catch(()=>{});await browser.close();}
