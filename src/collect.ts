import { Store } from './db.js';

export type VoiceObservation={guild:string;user:string;channel:string|null;parent:string|null;selfDeaf:boolean;bot:boolean;afk:string|null;at:number;roleIds?:string[]};
type VoiceState=VoiceObservation;
export class Collector {
  private voice=new Map<string,VoiceState>();
  constructor(readonly store:Store){}
  private key(g:string,u:string){return `${g}:${u}`;}
  message(input:{guild:string;id:string;user:string;channel:string;parent:string|null;category:string|null;at:number;bot:boolean;webhook:boolean;roleIds?:string[]}) {
    if(input.bot||input.webhook)return false;
    const c=this.store.config(input.guild);
    if(c.excludedChannels.includes(input.channel)||!!input.parent&&c.excludedChannels.includes(input.parent)||!!input.category&&c.excludedCategories.includes(input.category)||input.roleIds?.some(r=>c.excludedRoles.includes(r)))return false;
    this.store.ensureGuild(input.guild,input.at);
    return this.store.message(input.guild,input.id,input.user,input.channel,input.parent,input.at);
  }
  voiceUpdate(next:VoiceObservation) {
    const key=this.key(next.guild,next.user);const prev=this.voice.get(key);
    const affected=new Set([prev?.channel,next.channel].filter((v):v is string=>!!v));
    const at=next.at;
    this.store.db.transaction(()=>{
      for(const state of this.voice.values())if(state.guild===next.guild&&state.channel&&affected.has(state.channel))this.store.flushLive(state.guild,state.user,'voice',at,true);
      if(next.bot||!next.channel)this.voice.delete(key);else this.voice.set(key,next);
      if(next.channel&&(!prev||prev.channel!==next.channel)&&!next.bot)this.store.db.prepare('INSERT OR IGNORE INTO voice_sessions VALUES(?,?,?,?)').run(next.guild,next.user,at,next.channel);
      for(const state of this.voice.values())if(state.guild===next.guild&&state.channel&&affected.has(state.channel))this.store.startLive(state.guild,state.user,'voice',at,this.qualifies(state),state.channel);
    })();
  }
  private qualifies(s:VoiceState){const c=this.store.config(s.guild);return !!s.channel&&s.channel!==s.afk&&!c.excludedChannels.includes(s.channel)&&!c.excludedCategories.includes(s.parent??'')&&!s.roleIds?.some(r=>c.excludedRoles.includes(r))&&(!c.excludeSelfDeaf||!s.selfDeaf)&&(!c.requireTwoHumans||[...this.voice.values()].filter(v=>v.guild===s.guild&&v.channel===s.channel&&!v.bot).length>=2);}
  presence(input:{guild:string;user:string;games:string[];bot:boolean;at:number;roleIds?:string[]}) {
    if(input.bot)return;
    const c=this.store.config(input.guild);
    const games=input.roleIds?.some(r=>c.excludedRoles.includes(r))?[]:[...new Set(input.games.map(g=>c.aliases[g.toLowerCase()]??g.trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
    const selected=games[0]??null;
    const old=this.store.live(input.guild,input.user,'game');
    if(old?.game===selected)return;
    this.store.db.transaction(()=>{if(old)this.store.flushLive(input.guild,input.user,'game',input.at,true);if(selected)this.store.startLive(input.guild,input.user,'game',input.at,true,null,selected);})();
  }
  clearMemory(){this.voice.clear();}
  reconcileVoice(states:VoiceObservation[]){for(const s of states)this.voiceUpdate(s);}
}
