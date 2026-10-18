// Local UI inactivity only. This owns no session data and makes no API calls.
export function watchIdle({target, onIdle, onActivity, now=()=>Date.now(), schedule=setTimeout, cancel=clearTimeout, delay=30*60*1000}) {
  let timer, lastActivity=now(), reminded=false;
  const arm=()=>{cancel(timer);timer=schedule(check,Math.max(0,delay-(now()-lastActivity)));};
  function check(){if(now()-lastActivity>=delay){reminded=true;onIdle();}else arm();}
  const activity=()=>{lastActivity=now();if(reminded){reminded=false;onActivity();}arm();};
  const events=['pointerdown','pointermove','keydown','input','change','wheel','touchstart'];
  for(const event of events)target.addEventListener(event,activity,{passive:true});
  arm();
  return ()=>{cancel(timer);for(const event of events)target.removeEventListener(event,activity);};
}
