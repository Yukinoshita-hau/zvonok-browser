import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';

export const OWNER = 'local-owner';
const capability = () => randomBytes(32).toString('base64url');
const digest = (s: string) => createHash('sha256').update(s).digest();
const denied = (code = 'ACCESS_DENIED') => Object.assign(new Error(code), {statusCode:403,code});
export class SharedRoom {
  guest?: {id:string; hash:Buffer; expiresAt:number; seen:number};
  invite?: {hash:Buffer; expiresAt:number};
  controller = OWNER;
  generation = 1;
  leaseUntil: number;
  ownerSeen: number;
  request?: string;
  result = 'owner_control';
  closed = false;
  private endedGuest?: Buffer;
  constructor(readonly sessionId:string, readonly epoch:string, readonly expiresAt:number, readonly leaseMs=15000, readonly graceMs=30000) {
    this.ownerSeen=Date.now();this.leaseUntil=Math.min(Date.now()+leaseMs,expiresAt);
  }
  viewer(id:string) {return `viewer-${this.epoch}-${id}`;}
  identities() {return [this.viewer(OWNER),...(this.guest?[this.viewer(this.guest.id)]:[])];}
  rebind(epoch:string) {
    const room=new SharedRoom(this.sessionId,epoch,this.expiresAt,this.leaseMs,this.graceMs);
    room.guest=this.guest;room.controller=this.controller;room.generation=this.generation+1;
    room.ownerSeen=this.ownerSeen;room.leaseUntil=Math.min(this.leaseUntil,this.expiresAt);
    room.request=this.request;room.result='media_reconnecting';
    return room;
  }
  member(owner:boolean, token:string) {
    this.tick();
    if(owner)return OWNER;
    if(this.closed && this.endedGuest && timingSafeEqual(digest(token),this.endedGuest))throw denied('SESSION_ENDED');
    if(this.closed || !this.guest || Date.now()>=this.guest.expiresAt || !timingSafeEqual(digest(token),this.guest.hash))throw denied();
    return this.guest.id;
  }
  owner(id:string) {if(id!==OWNER)throw denied();}
  issue(id:string) {
    this.owner(id);if(this.closed || this.guest)throw denied('ROOM_FULL');
    const token=capability();this.invite={hash:digest(token),expiresAt:Math.min(Date.now()+60000,this.expiresAt)};
    return {invite:token,sessionId:this.sessionId,epoch:this.epoch,expiresAt:this.invite.expiresAt,role:'guest',uses:1};
  }
  accept(token:string, epoch:string) {
    this.tick();
    if(this.closed || epoch!==this.epoch || this.guest || !this.invite || Date.now()>=this.invite.expiresAt || !timingSafeEqual(digest(token),this.invite.hash))throw denied('INVITE_REJECTED');
    const credential=capability();this.invite=undefined;
    this.guest={id:`guest-${randomUUID()}`,hash:digest(credential),expiresAt:Math.min(Date.now()+600000,this.expiresAt),seen:Date.now()};
    return {token:credential,identity:this.guest.id,expiresAt:this.guest.expiresAt};
  }
  transition(controller:string, result:string) {
    this.controller=controller;this.generation++;this.leaseUntil=Math.min(Date.now()+this.leaseMs,this.expiresAt);this.request=undefined;this.result=result;
  }
  tick() {
    if(this.closed)return;
    if(Date.now()>=this.leaseUntil)this.transition(OWNER,'lease_expired');
    if(this.controller!==OWNER && (!this.guest || Date.now()-this.guest.seen>=this.leaseMs))this.transition(OWNER,'guest_disconnected');
  }
  heartbeat(id:string, epoch?:string, generation?:string, renewMember=false) {
    this.tick();
    if(id===OWNER)this.ownerSeen=Date.now();else if(this.guest?.id===id)this.guest.seen=Date.now();else throw denied();
    // Only fresh Core authorization may renew a still-valid membership; control generation remains fenced.
    if(renewMember && !this.closed && this.guest?.id===id && Date.now()<this.guest.expiresAt && epoch===this.epoch && generation===String(this.generation))
      this.guest.expiresAt=Math.min(Date.now()+600000,this.expiresAt);
    // A stale reconnect heartbeat cannot restore or renew a former lease.
    if(!this.closed && this.controller===id && epoch===this.epoch && generation===String(this.generation))this.leaseUntil=Math.min(Date.now()+this.leaseMs,this.expiresAt);
  }
  control(id:string, op:string) {
    this.tick();if(this.closed)throw denied();
    if(op==='request') {
      if(id===OWNER || id!==this.guest?.id || this.controller===id)throw denied();
      if(this.request)throw denied('REQUEST_PENDING');
      this.request=id;this.generation++;this.result='requested';
    } else if(op==='grant') {
      this.owner(id);if(!this.guest || this.request!==this.guest.id)throw denied('NO_REQUEST');
      this.transition(this.guest.id,'granted');
    } else if(op==='decline') {
      this.owner(id);if(!this.request)throw denied('NO_REQUEST');this.request=undefined;this.generation++;this.result='declined';
    } else if(op==='revoke' || op==='return') {this.owner(id);this.transition(OWNER,'revoked');}
    else if(op==='release') {if(this.controller!==id)throw denied();this.transition(OWNER,'released');}
    else throw denied('INVALID_ACTION');
  }
  fence(id:string, epoch:unknown, generation:unknown) {
    this.tick();
    if(id!==OWNER && (this.guest?.id!==id || Date.now()>=this.guest.expiresAt))throw denied('STALE_CONTROL_LEASE');
    if(this.closed || Date.now()>=this.expiresAt || id!==this.controller || epoch!==this.epoch || generation!==String(this.generation) || Date.now()>=this.leaseUntil)throw denied('STALE_CONTROL_LEASE');
  }
  remove(id:string, ownerOnly=false) {
    if(ownerOnly)this.owner(id);else if(id===OWNER)throw denied();
    this.invite=undefined;this.guest=undefined;this.transition(OWNER,'guest_left');
  }
  close() {if(this.closed)return;this.closed=true;this.endedGuest ??=this.guest?.hash;this.invite=undefined;this.guest=undefined;this.transition(OWNER,'session_ended');}
  snapshot(id:string) {
    this.tick();return {identity:id,role:id===OWNER?'owner':'guest',ownerPresent:Date.now()-this.ownerSeen<3000,participants:[OWNER,...(this.guest?[this.guest.id]:[])],
      sessionId:this.sessionId,epoch:this.epoch,controller:this.controller,generation:this.generation,expiresAt:this.leaseUntil,
      serverTime:Date.now(),request:this.request,result:this.result,membershipExpiresAt:id===this.guest?.id?this.guest.expiresAt:undefined};
  }
}
