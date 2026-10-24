import {chromium} from 'playwright';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const token=(await readFile('.env','utf8')).split(/\r?\n/).find(x=>x.startsWith('DEV_TOKEN=')).slice(10).trim();
const base='http://127.0.0.1:48031',out=`artifacts/slice3-release-${Date.now()}`;await mkdir(out);
async function api(path,method='GET',body,lease){const r=await fetch(base+'/api'+path,{method,headers:{authorization:`Bearer ${token}`,...(body===undefined?{}:{'content-type':'application/json'}),...(lease?{'x-control-epoch':lease.epoch,'x-control-generation':String(lease.generation)}:{})},body:body===undefined?undefined:JSON.stringify(body)});assert(r.ok,`HTTP ${r.status}`);return r.status===204?null:r.json();}
const browser=await chromium.launch({channel:'chrome',headless:true});let session;
try{
  session=await api('/sessions','POST',{});
  await api(`/sessions/${session.sessionId}/navigate`,'POST',{url:'https://example.com/capture-fixture'},session.collaboration);
  const ca=await browser.newContext(),cb=await browser.newContext(),a=await ca.newPage(),b=await cb.newPage();
  await a.goto(base);await a.evaluate(data=>sessionStorage.setItem('shared-browser',JSON.stringify(data)),{token,id:session.sessionId});await a.reload();
  const invite=await api(`/sessions/${session.sessionId}/invite`,'POST',{});
  await b.goto(base);await b.getByLabel('Приглашение',{exact:true}).fill(`${invite.sessionId}.${invite.epoch}.${invite.invite}`);await b.getByRole('button',{name:'Присоединиться',exact:true}).click();
  for(const p of [a,b])await p.waitForFunction(()=>window.sessionMediaMetrics?.framesDecoded>15,null,{timeout:45000});
  for(let i=0;i<2;i++){
    await b.getByRole('button',{name:'Запросить управление',exact:true}).click();await a.getByRole('button',{name:'Передать управление',exact:true}).click();
    await b.getByRole('button',{name:'Отдать управление',exact:true}).waitFor();
    if(i===0){await b.getByRole('button',{name:'Отдать управление',exact:true}).click();await a.getByRole('button',{name:'Перейти',exact:true}).waitFor({state:'visible'});await a.waitForFunction(()=>!document.querySelector('form button').disabled);}
  }
  await b.screenshot({path:out+'/guest-control.png',fullPage:true});
  const ended=a.waitForResponse(r=>r.url()===`${base}/api/sessions/${session.sessionId}` && r.request().method()==='DELETE');
  await a.getByRole('button',{name:'Завершить',exact:true}).click();assert.equal((await ended).status(),204);
  for(const p of [a,b])await p.waitForFunction(()=>document.querySelector('video')===null,null,{timeout:15000});
  assert.equal(await b.getByTestId('session-ended').textContent(),'Сессия завершена');
  assert.equal((await api(`/sessions/${session.sessionId}`)).status,'closed');
  await writeFile(out+'/results.json',JSON.stringify({result:'PASS',guestRelease:true,ownerEndWhileGuestControls:true,bothVideoDetached:true},null,2));console.log(out);
}catch(e){await writeFile(out+'/results.json',JSON.stringify({result:'FAIL',detail:e.message},null,2));throw e;}
finally{if(session)await api(`/sessions/${session.sessionId}`,'DELETE').catch(()=>{});await browser.close();}
