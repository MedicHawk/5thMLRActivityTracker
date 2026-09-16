export function dateParts(at:number,zone:string){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(at);
  const get=(name:string)=>parts.find(x=>x.type===name)?.value??'';
  return {date:`${get('year')}-${get('month')}-${get('day')}`,hour:Number(get('hour'))};
}
export function localMidnight(date:string,zone:string):number {
  if(!/^\d{4}-\d\d-\d\d$/.test(date))throw new Error('Date must be YYYY-MM-DD');
  const target=Date.parse(date+'T00:00:00Z');if(!Number.isFinite(target))throw new Error('Invalid date');
  let guess=target;
  for(let i=0;i<4;i++){
    const p=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(guess);
    const v=(k:string)=>Number(p.find(x=>x.type===k)?.value);
    const asUtc=Date.UTC(v('year'),v('month')-1,v('day'),v('hour'),v('minute'),v('second'));
    guess+=target-asUtc;
  }
  if(dateParts(guess,zone).date!==date)throw new Error('Invalid local date');
  return guess;
}
export function period(now:number,days:number,zone:string){
  const today=dateParts(now,zone).date;
  const tomorrow=new Date(today+'T00:00:00Z');tomorrow.setUTCDate(tomorrow.getUTCDate()+1);
  const end=localMidnight(tomorrow.toISOString().slice(0,10),zone);
  // Calendar subtraction uses UTC date arithmetic on the YYYY-MM-DD label.
  const d=new Date(today+'T00:00:00Z');d.setUTCDate(d.getUTCDate()-days+1);
  const start=localMidnight(d.toISOString().slice(0,10),zone);
  return {start,end:Math.max(end,now)};
}
export function overlap(a:number,b:number,c:number,d:number){return Math.max(0,Math.min(b,d)-Math.max(a,c));}
export function union(intervals:Array<[number,number]>):number {
  const sorted=intervals.filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0]);let total=0,end=-Infinity;
  for(const [a,b] of sorted){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}return total;
}
