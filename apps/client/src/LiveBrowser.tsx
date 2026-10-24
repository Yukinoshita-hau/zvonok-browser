import { useEffect, useRef, useState } from 'react';
import { Room, RoomEvent, Track, RemoteVideoTrack } from 'livekit-client';
import type { BrowserSession, InputAction } from '@browser/protocol';
import { pageCoordinates } from './coordinates';
import { mediaState } from './mediaState';

type Command = (action: InputAction) => void;
export function applySessionUpdate(previous:BrowserSession|undefined, next:BrowserSession) {
  if(!previous || previous.sessionId!==next.sessionId || previous.status!=='active' || (next.collaboration?.generation??0)<(previous.collaboration?.generation??0))return previous;
  return next;
}
function LiveVideo({id,token,input,canControl}:{id:string;token:string;input:Command;canControl:boolean}) {
  const video=useRef<HTMLVideoElement>(null);
  const [state,setState]=useState('Подключение…'),[fresh,setFresh]=useState(false),[attempt,setAttempt]=useState(0);
  const lastMove=useRef(0);
  useEffect(()=>{
    let stopped=false,room:Room|undefined,track:RemoteVideoTrack|undefined,retry:ReturnType<typeof setTimeout>|undefined;
    let retries=0,lastFrame=0,callback=0,connecting=false,health='streaming';
    const element=video.current!;
    const detach=()=>{track?.detach();track=undefined;element.srcObject=null;setFresh(false);lastFrame=0;(window as unknown as {sessionMediaMetrics:unknown}).sessionMediaMetrics=undefined;};
    const observed=()=>{lastFrame=performance.now();if(!stopped)callback=element.requestVideoFrameCallback(observed);};
    callback=element.requestVideoFrameCallback(observed);
    function schedule() {
      if(stopped || retry) return;
      detach();
      if(retries++>=4){setState('Видео недоступно. Повторите подключение.');return;}
      setState('media_reconnecting');retry=setTimeout(()=>{retry=undefined;void connect();},2000);
    }
    async function connect() {
      if(stopped || connecting) return;
      connecting=true;
      const previous=room;room=undefined;previous?.removeAllListeners();await previous?.disconnect();
      if(stopped){connecting=false;return;}
      const next=new Room();room=next;
      next.on(RoomEvent.TrackSubscribed,t=>{
        if(stopped || next!==room || !(t instanceof RemoteVideoTrack) || t.kind!==Track.Kind.Video)return;
        track=t;t.attach(element);void element.play().catch(()=>{});setState('Подключено · ожидание кадров');
      });
      next.on(RoomEvent.TrackUnsubscribed,()=>{if(!stopped && next===room){detach();setState('media_reconnecting · ожидание publisher');}});
      next.on(RoomEvent.Reconnecting,()=>{if(!stopped){detach();setState('media_reconnecting');}});
      next.on(RoomEvent.Reconnected,()=>{
        if(stopped)return;
        for(const p of next.remoteParticipants.values())for(const publication of p.videoTrackPublications.values()) {
          if(publication.track instanceof RemoteVideoTrack){track=publication.track;track.attach(element);void element.play().catch(()=>{});}
        }
      });
      next.on(RoomEvent.Disconnected,()=>{if(!stopped && next===room)schedule();});
      try {
        const r=await fetch(`/api/sessions/${id}/media`,{method:'POST',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5000)});
        if(!r.ok)throw Error(`Media HTTP ${r.status}`);
        const auth=await r.json();if(stopped)return;
        await next.connect(auth.url,auth.token,{rtcConfig:{iceServers:[]}});
        if(stopped)await next.disconnect();
      } catch {if(!stopped)schedule();} finally {connecting=false;}
    }
    (window as unknown as {sessionMediaMetrics:unknown}).sessionMediaMetrics=undefined;
    void connect();
    function nextPublications(){return [...(room?.remoteParticipants.values()??[])].flatMap(p=>[...p.videoTrackPublications.values()]);}
    let sampling=false;
    const timer=setInterval(()=>{
      const isFresh=!!lastFrame && performance.now()-lastFrame<2000;
      setFresh(isFresh);if(isFresh)setState(health);else if(lastFrame)setState('media_reconnecting · кадры не поступают');
      if(!track || sampling)return;
      sampling=true;const current=track;
      void current.getRTCStatsReport().then(report=>{
        if(stopped || current!==track)return;
        report?.forEach(s=>{if(s.type==='inbound-rtp' && s.kind==='video') {
          health=mediaState(s.frameWidth,s.framesPerSecond);if(isFresh)setState(health);
          (window as unknown as {sessionMediaMetrics:unknown}).sessionMediaMetrics={at:performance.now(),framesDecoded:s.framesDecoded,framesDropped:s.framesDropped,width:s.frameWidth,height:s.frameHeight,fps:s.framesPerSecond,bytesReceived:s.bytesReceived,publications:[...nextPublications()].length,fresh:isFresh};
        }});
      }).catch(()=>{}).finally(()=>{sampling=false;});
    },500);
    return ()=>{stopped=true;clearTimeout(retry);clearInterval(timer);element.cancelVideoFrameCallback(callback);track?.detach();element.srcObject=null;room?.removeAllListeners();void room?.disconnect();};
  },[id,token,attempt]);
  const coords=(e:{clientX:number;clientY:number})=>pageCoordinates(video.current!.getBoundingClientRect(),e.clientX,e.clientY);
  return <>
    <p role="status" data-testid="media-state">Видео: {state} <button onClick={()=>setAttempt(a=>a+1)}>Переподключить видео</button></p>
    <div className="live-surface" tabIndex={canControl?0:-1} role="application" aria-label="Серверная страница: мышь, клавиатура и прокрутка"
      onClick={e=>{const p=coords(e);if(!canControl || !p || !fresh)return;e.currentTarget.focus();input({type:'mouseClick',...p,button:'left'});}}
      onAuxClick={e=>{if(!canControl)return;if(e.button!==1)return;e.preventDefault();const p=coords(e);if(canControl && p && fresh){e.currentTarget.focus();input({type:'mouseClick',...p,button:'middle'});}}}
      onContextMenu={e=>{if(!canControl)return;e.preventDefault();const p=coords(e);if(canControl && p && fresh){e.currentTarget.focus();input({type:'mouseClick',...p,button:'right'});}}}
      onMouseMove={e=>{const p=coords(e);if(canControl && p && fresh && Date.now()-lastMove.current>100){lastMove.current=Date.now();input({type:'mouseMove',...p});}}}
      onWheel={e=>{const p=coords(e);if(!canControl || !p || !fresh)return;e.preventDefault();const unit=e.deltaMode===1?16:e.deltaMode===2?720:1;input({type:'wheel',...p,deltaX:Math.max(-2000,Math.min(2000,e.deltaX*unit)),deltaY:Math.max(-2000,Math.min(2000,e.deltaY*unit))});}}
      onPaste={e=>{if(!canControl)return;e.preventDefault();const text=e.clipboardData.getData('text').slice(0,1000);if(canControl && text && fresh)input({type:'text',text});}}
      onKeyDown={e=>{
        if(!canControl || !fresh)return;
        let key=e.key;
        if(e.ctrlKey && key.toLowerCase()==='a')key='Control+A';
        else if(key==='Tab' && e.shiftKey)key='Shift+Tab';
        if(['Enter','Tab','Shift+Tab','Backspace','Delete','Escape','ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End','PageUp','PageDown','Control+A'].includes(key)) {
          e.preventDefault();input({type:'keyPress',key:key as Extract<InputAction,{type:'keyPress'}>['key']});
        } else if(key.length===1 && !e.ctrlKey && !e.altKey && !e.metaKey){e.preventDefault();input({type:'text',text:key});}
      }}>
      <video ref={video} autoPlay muted playsInline className={`live-video ${fresh?'':'stale'}`} aria-label="Live Chromium 1280×720" />
      {!fresh && <div className="media-cover">{state}</div>}
    </div>
  </>;
}
export function LiveBrowser() {
  const saved=useRef< {token?:string;id?:string} >({});
  if(!saved.current.id) {try{saved.current=JSON.parse(sessionStorage.getItem('shared-browser')??'{}');}catch{}}
  const [token,setToken]=useState(saved.current.token??''),[url,setUrl]=useState('https://www.selenium.dev/selenium/web/web-form.html');
  const [session,setSession]=useState<BrowserSession>(),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [invite,setInvite]=useState(''),[join,setJoin]=useState(''),[connected,setConnected]=useState(true);
  const [diagnostics,setDiagnostics]=useState(false),[frame,setFrame]=useState('');
  const tail=useRef(Promise.resolve()),pending=useRef(0),current=useRef<BrowserSession|undefined>(undefined);
  current.current=session;
  const active=session?.status==='active', c=session?.collaboration, owner=c?.role==='owner';
  const canControl=!!active && connected && c?.identity===c?.controller && !!c && c.serverTime<c.expiresAt;
  const persist=(credential:string,id:string)=>sessionStorage.setItem('shared-browser',JSON.stringify({token:credential,id}));
  async function request(path:string,method='GET',body?:unknown,expected=current.current,credential=token) {
    const lease=expected?.collaboration;
    const r=await fetch(`/api${path}`,{method,headers:{Authorization:`Bearer ${credential}`,...(lease?{'x-control-epoch':lease.epoch,'x-control-generation':String(lease.generation)}:{}),...(body===undefined?{}:{'content-type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});
    if(!r.ok){const e=await r.json();if(r.status===401 || r.status===403){setConnected(false);if(['ACCESS_DENIED','SESSION_ENDED'].includes(e.error?.code)){setSession(s=>s?{...s,status:'closed'}:s);setError(e.error.code==='SESSION_ENDED'?'Сессия завершена':'Нет доступа');}}throw Error(e.error?.code??`HTTP ${r.status}`);}return r;
  }
  function run(fn:()=>Promise<void>,isInput=false) {
    if(isInput && pending.current>=4)return;
    if(pending.current>=16){setError('Очередь команд заполнена');return;}
    pending.current++;setBusy(true);
    tail.current=tail.current.then(fn).catch(e=>setError(String(e))).finally(()=>{pending.current--;setBusy(pending.current>0);});
  }
  useEffect(()=>{
    if(!token || session || !saved.current.id)return;
    let stopped=false;
    void request(`/sessions/${saved.current.id}`).then(r=>r.json()).then(s=>{if(!stopped){setSession(s);setConnected(true);}}).catch(e=>{if(!stopped)setError(String(e));});
    return ()=>{stopped=true;};
  },[token]);
  useEffect(()=>{
    if(!active || !session)return;
    let stopped=false,polling=false;const id=session.sessionId;
    const poll=()=>{
      if(polling)return;polling=true;
      void request(`/sessions/${id}/heartbeat`,'POST',{}).then(r=>r.json()).then(s=>{
        if(!stopped){setSession(previous=>applySessionUpdate(previous,s));setConnected(true);if(s.status!=='active')setFrame('');}
      }).catch(e=>{if(stopped)return;setConnected(false);setError(String(e));
        void request(`/sessions/${id}`).then(r=>r.json()).then(s=>{if(!stopped)setSession(previous=>applySessionUpdate(previous,s));}).catch(()=>{});
      }).finally(()=>{polling=false;});
    };
    poll();const timer=setInterval(poll,1000);
    return ()=>{stopped=true;clearInterval(timer);};
  },[session?.sessionId,active,token]);
  useEffect(()=>()=>{if(frame)URL.revokeObjectURL(frame);},[frame]);
  async function action(name:string,body:unknown,expected:BrowserSession|undefined) {
    const id=expected?.sessionId;if(!id || expected?.status!=='active')return;
    setError('');const s=await (await request(`/sessions/${id}/${name}`,'POST',body,expected)).json();
    // A late HTTP input response must not restore a revoked frontend lease.
    if(current.current?.sessionId===id && (s.collaboration?.generation??0)>=(current.current.collaboration?.generation??0)){
      setSession(previous=>applySessionUpdate(previous,s));if(name!=='input')setUrl(s.currentUrl);
    }
  }
  function command(name:string,body:unknown={},isInput=false) {
    const expected=current.current;if(!canControl)return;run(()=>action(name,body,expected),isInput);
  }
  async function roomAction(name:string,method='POST') {
    const expected=current.current;if(!expected)return;
    try{setError('');const r=await request(`/sessions/${expected.sessionId}/${name}`,method,method==='POST'?{}:undefined,expected);const s=await r.json();
      if(name==='leave'){sessionStorage.removeItem('shared-browser');setSession({...expected,status:'closed'});setToken('');}
      else if(name==='invite' && method==='POST')setInvite(`${s.sessionId}.${s.epoch}.${s.invite}`);
      else {setSession(previous=>applySessionUpdate(previous,s));if(name==='invite' || name==='guest')setInvite('');}
    }catch(e){setError(String(e));}
  }
  return <main className="shared-browser">
    <h1>Zvonok Browser</h1>
    {!active && <><label>Dev token <input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}/></label>
      <div className="toolbar"><button disabled={busy || !token} onClick={()=>run(async()=>{setError('');const s=await(await request('/sessions','POST',{})).json();setSession(s);setConnected(true);persist(token,s.sessionId);})}>Создать браузер</button>
      <label>Приглашение <input autoComplete="off" value={join} onChange={e=>setJoin(e.target.value)}/></label>
      <button disabled={!join || busy} onClick={()=>run(async()=>{
        const [id,epoch,capability,...extra]=join.trim().split('.');if(extra.length || !id || !epoch || !capability)throw Error('Неверное приглашение');
        const r=await request(`/sessions/${id}/accept`,'POST',{epoch,invite:capability},undefined,'');const auth=await r.json();
        setToken(auth.token);setSession(auth.session);persist(auth.token,id);setConnected(true);setJoin('');
      })}>Присоединиться</button></div></>}
    {active && <div className="toolbar collaboration" aria-label="Участники и управление">
      <span>{c?.participants.map(id=>id==='local-owner'?'A · хозяин':'B · гость').join(' / ')} · Управляет {c?.controller==='local-owner'?'A':'B'}</span>
      {!connected && <span role="status">Переподключение · ввод приостановлен</span>}
      {owner ? <>
        <button onClick={()=>void roomAction('invite')}>Пригласить B</button>
        <button onClick={()=>void roomAction('invite','DELETE')}>Отозвать приглашение</button>
        {c?.request && <><span role="status">B запрашивает управление</span><button onClick={()=>void roomAction('control/grant')}>Передать управление</button><button onClick={()=>void roomAction('control/decline')}>Отказать</button></>}
        {!canControl && <button onClick={()=>void roomAction('control/revoke')}>Вернуть управление</button>}
        {c && c.participants.length>1 && <button onClick={()=>void roomAction('guest','DELETE')}>Отозвать доступ B</button>}
        <button onClick={()=>{void request(`/sessions/${session!.sessionId}`,'DELETE').then(()=>{sessionStorage.removeItem('shared-browser');setSession(s=>s?{...s,status:'closed'}:s);setFrame('');}).catch(e=>setError(String(e)));}}>Завершить</button>
      </> : <>
        {!canControl && <button disabled={!!c?.request || !connected} onClick={()=>void roomAction('control/request')}>{c?.request?'Запрос ожидает решения':'Запросить управление'}</button>}
        {canControl && <button onClick={()=>void roomAction('control/release')}>Отдать управление</button>}
        <button onClick={()=>void roomAction('leave')}>Выйти из комнаты</button>
      </>}
    </div>}
    {invite && owner && <label>Приглашение для B (60 секунд, один вход)<input readOnly value={invite} onFocus={e=>e.target.select()}/></label>}
    {active && <p role="status" data-testid="control-state">{!connected?'Переподключение':!owner && !c?.ownerPresent?'Ожидание хозяина':canControl?'Управление получено':c?.request?'Запрос управления':c?.result==='revoked'?'Управление отозвано':c?.result==='declined'?'Запрос отклонён · просмотр':'Просмотр'}</p>}
    {active && <><div className="toolbar">{(['back','forward','reload'] as const).map((a,i)=><button key={a} disabled={busy || !canControl} onClick={()=>command(a)}>{['Назад','Вперёд','Обновить'][i]}</button>)}</div>
    <form onSubmit={e=>{e.preventDefault();command('navigate',{url});}}><label>HTTPS адрес <input disabled={!canControl} value={url} onChange={e=>setUrl(e.target.value)}/></label><button disabled={busy || !canControl}>Перейти</button></form></>}
    <p role="status">Сессия: {session?.status??'не создана'} · браузер {session?.browserReady?'готов':'не готов'}{session?.media?` · media ${session.media.state}`:''}</p>
    <p role="alert">{error}</p>
    <label><input type="checkbox" checked={diagnostics} onChange={e=>setDiagnostics(e.target.checked)}/>PNG diagnostics</label>
    {active && session && !diagnostics && <LiveVideo key={session.sessionId} id={session.sessionId} token={token} canControl={canControl} input={a=>command('input',a,a.type==='mouseMove')}/>}
    {active && diagnostics && <><button disabled={busy} onClick={()=>run(async()=>{const r=await request(`/sessions/${current.current!.sessionId}/frame`);setFrame(URL.createObjectURL(await r.blob()));})}>Получить кадр</button>{frame && <img className="viewport" src={frame} alt="Диагностический PNG серверной страницы"/>}</>}
    {!active && <p data-testid="session-ended">{session?(error.includes('ACCESS_DENIED') || error==='Нет доступа'?'Нет доступа':'Сессия завершена'):'Создайте сессию или примите приглашение'}</p>}
  </main>;
}
