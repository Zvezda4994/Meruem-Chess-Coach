/* Meruem Chess Coach: board, engine, coach, explorer, learn mode. */
(function(){
"use strict";
const $=id=>document.getElementById(id);
const GLYPH={k:"♚",q:"♛",r:"♜",b:"♝",n:"♞",p:"♟"};
const NAME={p:"pawn",n:"knight",b:"bishop",r:"rook",q:"queen",k:"king"};
const VAL={p:1,n:3,b:3,r:5,q:9,k:0};
const ANALYSIS={depth:18,mt:1500};
const GRADE_COLOR={Best:"--g-best",Excellent:"--g-excellent",Good:"--g-good",Inaccuracy:"--g-inacc",Mistake:"--g-mistake",Blunder:"--g-blunder"};
const START="rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

/* ---------- Engine: Stockfish 17.1 lite (WASM, single thread) in a Web Worker ---------- */
const Engine=(()=>{
  let worker,listener=null,queue,okResolve,src="",name="Stockfish",fallbackTimer=null;
  const ready=new Promise(r=>okResolve=r);
  function fallback(){
    if(okResolve)setStatus("Engine failed to load (this browser needs WebAssembly)","");
  }
  function boot(file){
    src=file;
    try{
      worker=new Worker(file);
      worker.onmessage=e=>{
        const line=String(e.data);
        if(line.startsWith("id name "))name=line.slice(8);
        if(line==="uciok"){worker.postMessage("setoption name Hash value 32");worker.postMessage("isready");return;}
        if(line==="readyok"&&okResolve){clearTimeout(fallbackTimer);okResolve();okResolve=null;return;}
        if(listener)listener(line);
      };
      worker.onerror=()=>fallback();
      worker.postMessage("uci");
      clearTimeout(fallbackTimer);fallbackTimer=setTimeout(fallback,25000);
    }catch(err){fallback();}
  }
  boot("vendor/stockfish/sf17.js");
  queue=ready;
  function parse(line){
    const m={};const t=line.split(" ");
    for(let i=0;i<t.length;i++){
      if(t[i]==="multipv")m.k=+t[i+1];
      else if(t[i]==="depth")m.depth=+t[i+1];
      else if(t[i]==="score"){m.type=t[i+1];m.val=+t[i+2];if(t[i+3]==="upperbound"||t[i+3]==="lowerbound")m.bound=1;}
      else if(t[i]==="pv"){m.pv=t.slice(i+1);break;}
    }
    return m;
  }
  function search(fen,{multipv=1,skill=20,depth=ANALYSIS.depth,mt=ANALYSIS.mt,elo=null}={}){
    const job=()=>new Promise(res=>{
      const lines={};
      listener=line=>{
        if(line.startsWith("info")&&line.includes(" pv ")){
          const m=parse(line);if(m.bound||!m.pv)return;
          lines[m.k||1]={score:m.type==="mate"?{mate:m.val}:{cp:m.val},pv:m.pv,depth:m.depth};
        }else if(line.startsWith("bestmove")){
          listener=null;
          const best=line.split(" ")[1];
          const arr=Object.keys(lines).sort((a,b)=>a-b).map(k=>lines[k]);
          if(!arr.length)arr.push({score:{cp:0},pv:[best]});
          res({best,lines:arr});
        }
      };
      worker.postMessage("setoption name Skill Level value "+skill);
      worker.postMessage("setoption name UCI_LimitStrength value "+(elo?"true":"false"));
      if(elo)worker.postMessage("setoption name UCI_Elo value "+Math.round(elo));
      worker.postMessage("setoption name MultiPV value "+multipv);
      worker.postMessage("position fen "+fen);
      worker.postMessage("go depth "+depth+" movetime "+mt);
    });
    const p=queue.then(job);queue=p.catch(()=>{});return p;
  }
  return {ready,search,name:()=>name};
})();
Engine.ready.then(()=>{engineUp=true;if(!busy&&mode!=="learn"&&mode!=="explore")setStatus("Engine ready","on");});

/* ---------- Helpers ---------- */
function toCp(s){if(!s)return 0;if(s.mate!==undefined){if(s.mate===0)return -10000;return s.mate>0?10000-s.mate*10:-10000-s.mate*10;}return s.cp;}
function winPct(cp){const c=Math.max(-1000,Math.min(1000,cp));return 50+50*(2/(1+Math.exp(-0.00368208*c))-1);}
function fmtScore(s){if(s.mate!==undefined)return (s.mate>0?"#":"#-")+Math.abs(s.mate);const p=s.cp/100;return (p>0?"+":"")+p.toFixed(2);}
function flip(s){return s.mate!==undefined?{mate:-s.mate}:{cp:-s.cp};}
function uciObj(u){return {from:u.slice(0,2),to:u.slice(2,4),promotion:u[4]||"q"};}
function pvMoves(fen,pv,n){const g=new Chess(fen);const out=[];for(const u of pv.slice(0,n)){const m=g.move(uciObj(u));if(!m)break;out.push(m);}return out;}
function numbered(fen,sans){const parts=fen.split(" ");let no=+parts[5];let white=parts[1]==="w";const out=[];sans.forEach((s,i)=>{if(white)out.push(no+". "+s);else out.push(i===0?no+"… "+s:s);if(!white)no++;white=!white;});return out.join(" ");}
function material(g,color){let t=0;for(const f of "abcdefgh")for(let r=1;r<=8;r++){const p=g.get(f+r);if(p)t+=(p.color===color?1:-1)*VAL[p.type];}return t;}
function matAfter(fen,pv,n,color){const g=new Chess(fen);for(const u of pv.slice(0,n)){if(!g.move(uciObj(u)))break;}return material(g,color);}
// Material after a line, read at n-1, n and n+1 plies and taking the worst, so a line cut off in the
// middle of an exchange (piece taken, recapture not yet played) doesn't look like a win.
function matSettled(fen,pv,n,color){const v=[];for(const k of [n-1,n,n+1])if(k>=1&&k<=pv.length)v.push(matAfter(fen,pv,k,color));return v.length?Math.min(...v):material(new Chess(fen),color);}
function esc(s){return String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));}
function cap(s){return s.charAt(0).toUpperCase()+s.slice(1);}

/* Describing moves in words. In Play mode pieces are "your"/"their", elsewhere "White's"/"Black's". */
function poss(color){
  if(mode==="play")return color===playerColor?"your":"their";
  return color==="w"?"White's":"Black's";
}
function side(color){if(mode==="play")return color===playerColor?"you":"the bot";return color==="w"?"White":"Black";}
function describe(m){
  let s;
  if(m.flags.includes("k"))s=`${poss(m.color)} king castles kingside`;
  else if(m.flags.includes("q"))s=`${poss(m.color)} king castles queenside`;
  else{
    s=`${poss(m.color)} ${NAME[m.piece]}`+(m.captured?` takes the ${NAME[m.captured]} on ${m.to}`:` to ${m.to}`);
    if(m.promotion)s+=` and becomes a ${NAME[m.promotion]}`;
  }
  if(m.san.includes("#"))s+=", checkmate";else if(m.san.includes("+"))s+=", with check";
  return cap(s);
}
function evalWords(score,color){ // score from `color`'s point of view
  const me=mode==="play"?(color===playerColor?"You":"The bot"):(color==="w"?"White":"Black");
  const them=mode==="play"?(color===playerColor?"The bot":"You"):(color==="w"?"Black":"White");
  const verb=n=>(n==="You"?"You're":n+" is");
  if(score.mate!==undefined){if(score.mate>0)return `${me} can force checkmate in ${score.mate}`;if(score.mate<0)return `${them} can force checkmate in ${-score.mate}`;return `${me} ${me==="You"?"are":"is"} checkmated`;}
  const c=score.cp,a=Math.abs(c),who=c>=0?me:them;
  if(a<40)return "Roughly equal";
  if(a<120)return `${verb(who)} slightly better`;
  if(a<300)return `${verb(who)} clearly better`;
  return `${verb(who)} winning (about ${Math.round(a/100)} pawn${Math.round(a/100)===1?"":"s"} ahead)`;
}
function pieceList(fen){
  const g=new Chess(fen),out={w:[],b:[]};
  for(const r of [8,7,6,5,4,3,2,1])for(const f of "abcdefgh"){const p=g.get(f+r);if(p)out[p.color].push(cap(NAME[p.type])+" "+f+r);}
  return `White: ${out.w.join(", ")}\nBlack: ${out.b.join(", ")}`;
}

/* ---------- State ---------- */
const game=new Chess();
let engineUp=false,mode="play",playerColor="w",orient="w";
let selected=null,busy=false,paused=false,hintSq=null;
let pre=null,lastPre=null;      // analysis of the current position (side to move)
let records=[];                 // per ply
let current=null;               // graded move shown in the feedback card
let now=null;                   // "best move here" panel state (free mode)
let arrows=[];
let preview=null;               // {fen,moves:[verbose],step,title}
let setup={map:{},turn:"w",pick:{type:"q",color:"w"}};
let sampleFn=null,sampleOff=false;
const aborts={};
try{if(window.claude&&window.claude.use){window.claude.use("sample").then(s=>{sampleFn=s;renderFeedback();renderNow();renderCoach();}).catch(()=>{});}}catch(e){}
try{const s=JSON.parse(localStorage.getItem("mbm-settings")||"{}");if(s.color)$("selColor").value=s.color;if(s.bot)$("selLevel").value=s.bot;if(s.pause!=null)$("chkPause").checked=s.pause;if(s.talk)$("selTalk").value=s.talk;if(s.style)$("selStyle").value=s.style;}catch(e){}
if(!$("selLevel").value)$("selLevel").value="auto";if(!$("selTalk").value)$("selTalk").value="key";
function saveSettings(){try{localStorage.setItem("mbm-settings",JSON.stringify({color:$("selColor").value,bot:$("selLevel").value,pause:$("chkPause").checked,talk:$("selTalk").value,style:$("selStyle").value}));}catch(e){}}
function talkMode(){return $("selTalk").value||"key";}
let rating=800,ratingGames=0;
try{const r=JSON.parse(localStorage.getItem("mbm-rating")||"null");if(r&&r.rating){rating=r.rating;ratingGames=r.games||0;}}catch(e){}
function saveRating(){try{localStorage.setItem("mbm-rating",JSON.stringify({rating,games:ratingGames}));}catch(e){}cloudSave();}
let patterns={games:0,tags:{}};
try{const p=JSON.parse(localStorage.getItem("mbm-patterns")||"null");if(p&&p.tags)patterns=p;}catch(e){}
function savePatterns(){try{localStorage.setItem("mbm-patterns",JSON.stringify(patterns));}catch(e){}cloudSave();}
/* Rating/pattern sync. Only active when hosted as a claude.ai artifact (db + user capabilities).
   Anywhere else use("db") resolves null and localStorage is the only store. */
let cloudRef=null,cloudChain=Promise.resolve(),cloudReady=false,cloudDb=null,cloudUid=null;
function syncNote(t){const el=$("syncNote");if(el)el.textContent=t;}
function cloudSave(){
  if(!cloudRef||!cloudReady)return;
  const data={rating:Math.round(rating),games:ratingGames,patterns,updatedAt:Date.now()};
  cloudChain=cloudChain.then(()=>cloudRef.set(data)).then(()=>syncNote("Synced to your account, so it follows you across devices."),()=>syncNote("Couldn't sync just now. Saved in this browser."));
}
(async()=>{
  try{
    if(!window.claude||!window.claude.use)return;
    const [db,user]=await Promise.all([window.claude.use("db"),window.claude.use("user")]);
    if(!db||!user)return;
    const uid=await user.id();if(!uid)return;
    cloudDb=db;cloudUid=uid;
    cloudRef=db.doc("data/users/"+uid+"/profile");
    const snap=await cloudRef.get();
    cloudReady=true;
    if(snap.exists){
      const d=snap.data()||{};
      if(typeof d.rating==="number"){rating=d.rating;ratingGames=d.games||0;}
      if(d.patterns&&d.patterns.tags)patterns=d.patterns;
      try{localStorage.setItem("mbm-rating",JSON.stringify({rating,games:ratingGames}));localStorage.setItem("mbm-patterns",JSON.stringify(patterns));}catch(e){}
      syncNote("Synced to your account, so it follows you across devices.");
      refreshRatingUI();
    }else cloudSave();
  }catch(e){syncNote("Saved in this browser (account sync unavailable here).");}
})();
function botRating(){const v=$("selLevel").value;return v==="auto"||!v?Math.round(rating):+v;}
function refreshLevelLabel(){const o=$("selLevel").querySelector('option[value="auto"]');if(o)o.textContent=`Adaptive (≈ ${Math.round(rating)})`;}
function refreshRatingUI(){refreshLevelLabel();const i=$("ratingInput");if(i&&document.activeElement!==i)i.value=Math.round(rating);if(typeof renderCoach==="function"&&mode==="play")renderCoach();}
$("ratingSet").onclick=()=>{const v=Math.round(+$("ratingInput").value);if(!v||v<400||v>2900){$("ratingInput").value=Math.round(rating);return;}rating=v;saveRating();refreshRatingUI();setStatus(`Rating set to ${v}`,"on");};
$("ratingInput").addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();$("ratingSet").click();}});
refreshLevelLabel();$("ratingInput").value=Math.round(rating);
function setStatus(t,cls){$("statusText").textContent=t;$("dot").className="dot"+(cls?" "+cls:"");}

/* ---------- Board rendering ---------- */
function squares(){const files="abcdefgh",out=[];for(let i=0;i<8;i++)for(let j=0;j<8;j++){const rank=orient==="w"?8-i:i+1;const file=orient==="w"?files[j]:files[7-j];out.push(file+rank);}return out;}
function sqXY(sq){const f="abcdefgh".indexOf(sq[0]),r=+sq[1]-1;return orient==="w"?{x:f+.5,y:7-r+.5}:{x:7-f+.5,y:r+.5};}
function view(){
  if(mode==="learn")return learnView();
  if(mode==="explore")return exploreView();
  if(mode==="setup")return {get:sq=>setup.map[sq]||null,last:null,live:false,g:null};
  if(preview){const g=new Chess(preview.fen);let last=null;for(const m of preview.moves.slice(0,preview.step)){last=g.move(m.san);}return {get:sq=>g.get(sq),last,live:false,g};}
  const h=game.history({verbose:true});return {get:sq=>game.get(sq),last:h[h.length-1],live:true,g:game};
}
function renderBoard(){
  const el=$("board");el.innerHTML="";
  const v=view();renderEcho(v);
  const targets=(v.live&&selected)?v.g.moves({square:selected,verbose:true}):[];
  let checkSq=null;
  if(v.g&&v.g.in_check()){for(const sq of squares()){const p=v.g.get(sq);if(p&&p.type==="k"&&p.color===v.g.turn())checkSq=sq;}}
  squares().forEach((sq,idx)=>{
    const f="abcdefgh".indexOf(sq[0]),r=+sq[1];
    const b=document.createElement("button");
    b.className="sq "+((f+r)%2===1?"l":"d");
    if(v.last&&(sq===v.last.from||sq===v.last.to))b.classList.add("last");
    if(v.live&&sq===selected)b.classList.add("sel");
    if(sq===checkSq)b.classList.add("check");
    if(v.live&&sq===hintSq)b.classList.add("hint");
    b.dataset.sq=sq;
    const p=v.get(sq);
    b.setAttribute("aria-label",sq+(p?" "+(p.color==="w"?"white ":"black ")+NAME[p.type]:""));
    if(p){const s=document.createElement("span");s.className="pc "+p.color+" pt-"+p.type;b.appendChild(s);}
    const t=targets.find(m=>m.to===sq);
    if(t){const d=document.createElement("span");d.className="tgt"+(t.captured?" cap":"");b.appendChild(d);}
    if(idx%8===0){const c=document.createElement("span");c.className="co r";c.textContent=sq[1];b.appendChild(c);}
    if(idx>=56){const c=document.createElement("span");c.className="co f";c.textContent=sq[0];b.appendChild(c);}
    el.appendChild(b);
  });
  renderArrows();
}
function renderArrows(){
  const svg=$("arrows");let h="";
  let list=arrows;
  if(mode==="setup")list=[];
  if(mode==="learn")list=learnArrows();
  if(mode==="explore")list=exploreArrows();
  if(preview){const nx=preview.moves[preview.step];list=nx?[{from:nx.from,to:nx.to,color:"--accent",dash:true}]:[];}
  const css=getComputedStyle(document.documentElement);
  list.forEach((a,i)=>{
    const p1=sqXY(a.from),p2=sqXY(a.to);const dx=p2.x-p1.x,dy=p2.y-p1.y,len=Math.hypot(dx,dy)||1;const ux=dx/len,uy=dy/len;
    const ex=p2.x-ux*.32,ey=p2.y-uy*.32;
    const col=css.getPropertyValue(a.color).trim()||"#16946a";
    const id="ah"+i;
    h+=`<defs><marker id="${id}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3" markerHeight="3" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${col}"/></marker></defs>`;
    h+=`<line x1="${p1.x+ux*.2}" y1="${p1.y+uy*.2}" x2="${ex}" y2="${ey}" stroke="${col}" stroke-width=".16" stroke-linecap="round" opacity=".85" marker-end="url(#${id})" ${a.dash?'stroke-dasharray=".25 .18"':""}/>`;
  });
  svg.innerHTML=h;
}
$("board").addEventListener("click",e=>{const b=e.target.closest(".sq");if(b)onSquare(b.dataset.sq);});
function canMove(){
  if(busy||paused||preview||!engineUp||game.game_over())return false;
  if(mode==="play")return game.turn()===playerColor;
  return mode==="free";
}
function onSquare(sq){
  if(mode==="learn"){learnTap(sq);return;}
  if(mode==="explore"){exploreTap(sq);return;}
  if(mode==="setup"){setupTap(sq);return;}
  if(!canMove())return;
  const p=game.get(sq),turn=game.turn();
  if(selected){
    const mv=game.moves({square:selected,verbose:true}).find(m=>m.to===sq);
    if(mv){const from=selected;selected=null;hintSq=null;userMove({from,to:sq,promotion:"q"});return;}
  }
  selected=(p&&p.color===turn&&sq!==selected)?sq:null;
  renderBoard();
}

/* ---------- Eval bar ---------- */
function setEval(whiteScore){
  $("evalFill").style.width=winPct(toCp(whiteScore)).toFixed(1)+"%";
  let txt;
  if(mode==="play")txt=evalWords(playerColor==="w"?whiteScore:flip(whiteScore),playerColor);
  else txt=evalWords(whiteScore,"w");
  $("evalText").textContent=txt;
}
function whitePOV(score,turn){return turn==="w"?score:flip(score);}

/* ---------- Flow ---------- */
function analyzeCurrent(){
  const fen=game.fen(),turn=game.turn();
  const lastRec=records[records.length-1];
  coach.hint=0;coach.hintLines=[];$("btnHint").textContent="Hint";
  setStatus("Analyzing position…","busy");
  pre=Engine.search(fen,{multipv:3}).then(r=>{
    const a={fen,...r};
    if(lastRec&&lastRec.bot&&!lastRec.evalW)lastRec.evalW=whitePOV(r.lines[0].score,turn);
    if(game.fen()===fen&&mode!=="learn"&&mode!=="explore"){setEval(whitePOV(r.lines[0].score,turn));if(!busy)setStatus(mode==="play"?"Your move":(turn==="w"?"White to move":"Black to move"),"on");}
    return a;
  });
  lastPre=pre;
  if(mode==="free"){now={fen,state:"hidden"};renderNow();}
  if(mode==="play"&&turn===playerColor)coachTurn(lastRec&&lastRec.bot?lastRec:null);
}

async function userMove(m){
  const fenBefore=game.fen();
  const mv=game.move(m);if(!mv)return;
  busy=true;arrows=[];now=null;renderNow();renderBoard();
  setStatus("Grading the move…","busy");
  const a=await pre;
  const playedUci=mv.from+mv.to+(mv.promotion||"");
  const bestUci=a.lines[0].pv[0];
  const bestCp=toCp(a.lines[0].score);
  let afterCp,replyPv=[],afterScore;
  const same=a.lines.find(l=>l.pv[0]===playedUci||l.pv[0]===mv.from+mv.to);
  if(game.in_checkmate()){afterScore={mate:1};afterCp=10000;}
  else if(game.game_over()){afterScore={cp:0};afterCp=0;}
  else if(same){afterScore=same.score;afterCp=toCp(same.score);replyPv=same.pv.slice(1);}
  else{
    const r=await Engine.search(game.fen(),{multipv:1});
    afterScore=flip(r.lines[0].score);afterCp=toCp(afterScore);replyPv=r.lines[0].pv;
  }
  if(!game.game_over())setEval(whitePOV(afterScore,mv.color));
  let drop=Math.max(0,winPct(bestCp)-winPct(afterCp));
  let grade;
  if(playedUci===bestUci||mv.from+mv.to===bestUci.slice(0,4))grade="Best";
  else if(drop<2)grade="Excellent";else if(drop<5)grade="Good";else if(drop<10)grade="Inaccuracy";else if(drop<20)grade="Mistake";else grade="Blunder";
  // Win% flattens out in already-decided positions; mates still matter.
  const bs=a.lines[0].score;
  if(grade!=="Best"&&afterScore.mate!==undefined&&afterScore.mate<0&&!(bs.mate!==undefined&&bs.mate<0)){grade="Blunder";drop=Math.max(drop,20);}
  else if(grade!=="Best"&&bs.mate!==undefined&&bs.mate>0&&!(afterScore.mate!==undefined&&afterScore.mate>0)&&["Excellent","Good","Inaccuracy"].includes(grade)){grade="Mistake";drop=Math.max(drop,10);}

  const bestMoves=pvMoves(fenBefore,a.lines[0].pv,6);
  const rec={color:mv.color,san:mv.san,move:mv,uci:playedUci,grade,drop,fenBefore,fenAfter:game.fen(),
    best:bestMoves[0],bestMoves,bestUci,bestScore:a.lines[0].score,afterScore,
    alt:a.lines.slice(1).map(l=>({moves:pvMoves(fenBefore,l.pv,4),score:l.score})),
    topLines:a.lines.map(l=>({san:pvMoves(fenBefore,l.pv,6).map(x=>x.san),score:fmtScore(l.score)})),
    replyMoves:replyPv.length?pvMoves(game.fen(),replyPv,5):[],claude:null,claudeState:"idle"};
  rec.facts=buildFacts(rec,a);
  rec.evalW=whitePOV(afterScore,mv.color);
  rec.principles=mode==="play"?principleChecks(rec):[];
  rec.tags=tagMove(rec,a);
  records.push(rec);current=rec;
  if(mode==="play"){coach.notes=[];coach.claudeState="idle";coach.claude=null;coach.fen=null;if(aborts.turn)aborts.turn.abort();renderCoach();}
  arrows=grade==="Best"?[{from:bestUci.slice(0,2),to:bestUci.slice(2,4),color:"--g-best"}]
    :[{from:mv.from,to:mv.to,color:GRADE_COLOR[grade],dash:true},{from:bestUci.slice(0,2),to:bestUci.slice(2,4),color:"--g-best"}];
  renderBoard();renderFeedback();renderMoves();
  const bad=grade==="Inaccuracy"||grade==="Mistake"||grade==="Blunder";
  if((grade==="Mistake"||grade==="Blunder")&&talkMode()!=="ask")explainMove(rec);
  if(game.game_over()){busy=false;endGame();return;}
  if(mode==="free"){busy=false;analyzeCurrent();return;}
  if(bad&&$("chkPause").checked){paused=true;busy=false;setStatus("Paused: retry or continue","on");renderFeedback();renderCoach();return;}
  busy=false;botMove();
}

function buildFacts(rec,a){
  const f=[];const me=rec.color;
  const base=material(new Chess(rec.fenBefore),me);
  const best=a.lines[0];const bm=rec.best;
  if(rec.grade==="Best")f.push("This was the strongest move in the position.");
  else if(bm){
    if(bm.san.includes("#"))f.push(`Checkmate was available: ${describe(bm).replace(/, checkmate$/,"").toLowerCase()}.`);
    else if(best.score.mate!==undefined&&best.score.mate>0)f.push(`The best move starts a forced checkmate in ${best.score.mate}.`);
    else if(bm.captured)f.push(`The best move wins the ${NAME[bm.captured]} on ${bm.to}.`);
    const gain=matSettled(rec.fenBefore,best.pv,6,me)-base;
    if(gain>=2&&!bm.san.includes("#"))f.push(`Over the next few moves, the best line comes out ${gain} point${gain>1?"s":""} of material ahead.`);
  }
  if(rec.replyMoves.length&&rec.grade!=="Best"){
    const reply=rec.replyMoves[0];
    if(reply.san.includes("#"))f.push(`The move played allows checkmate: ${describe(reply).toLowerCase()}.`);
    else if(reply.captured&&rec.grade!=="Excellent")f.push(`It leaves something loose: ${describe(reply).toLowerCase()}.`);
    const loss=matAfter(rec.fenAfter,rec.replyMoves.map(x=>x.from+x.to+(x.promotion||"")),5,me)-base;
    if(loss<=-2&&rec.grade!=="Excellent"&&rec.grade!=="Good")f.push(`After the likely follow-up, that side is ${-loss} point${loss<-1?"s":""} of material down.`);
  }
  if(rec.grade!=="Best"&&!f.length)f.push("No material changes hands right away. The best move simply leaves the pieces in better shape.");
  return f;
}

async function botMove(){
  if(game.game_over()){endGame();return;}
  busy=true;setStatus("Bot is thinking…","busy");
  const fenBefore=game.fen();
  const uci=await pickBotMove(fenBefore,botRating());
  if(game.fen()!==fenBefore){busy=false;return;}
  const m=game.move(uciObj(uci));
  records.push({color:m.color,san:m.san,bot:true,move:m,fenBefore});
  arrows=[];busy=false;renderBoard();renderMoves();
  if(game.game_over()){endGame();return;}
  analyzeCurrent();
}

function endGame(){
  let msg;
  const loser=game.turn();
  if(game.in_checkmate())msg=mode==="play"?(loser===playerColor?"Checkmate. The bot wins.":"Checkmate. You win."):`Checkmate. ${loser==="w"?"Black":"White"} wins.`;
  else if(game.in_stalemate())msg="Stalemate. Draw.";
  else if(game.in_threefold_repetition())msg="Draw by repetition.";
  else if(game.insufficient_material())msg="Draw by insufficient material.";
  else msg="Draw.";
  setStatus("Game over","on");
  current=current||{};current.end=msg;now=null;renderNow();renderFeedback();renderMoves();
  const last=records[records.length-1];
  if(last&&!last.evalW)last.evalW=game.in_checkmate()?(loser==="w"?{mate:-1}:{mate:1}):{cp:0};
  if(mode==="play")finishReview(msg,loser);
}

/* ---------- Claude ---------- */
const RULES=`Write for a beginner who cannot read chess notation.
- 2 or 3 short sentences, under 60 words total, plain text, no markdown, no lists.
- Never write algebraic notation like Nf5, gxh6 or O-O. Say "your knight to f5" or "their pawn on h6". Square names like f5 are fine.
- No evaluation numbers.
- Explain the idea in everyday words: what the move attacks, threatens, defends, opens up or sets up.
- Use only what the engine data shows. Do not invent threats or tactics the lines don't show.
- Finish with one short rule of thumb the player can reuse, starting with "Tip:".`;
function wordsLine(moves){return moves.map((m,i)=>`${i+1}) ${describe(m)}`).join("; ");}
function promptMove(rec){
  const who=mode==="play"?"the player":(rec.color==="w"?"White":"Black");
  const sidetxt=rec.color==="w"?"White":"Black";
  return `You are a friendly chess coach. Explain why ${who}'s move got the grade it did and why the engine's best move is better.
${RULES}
Refer to ${mode==="play"?'the player\'s pieces as "your" and the opponent\'s as "their"':"pieces as White's or Black's"}.

Mover: ${sidetxt}
Pieces before the move:
${pieceList(rec.fenBefore)}
Move played: ${describe(rec.move)} (grade: ${rec.grade})
Best move: ${rec.best?describe(rec.best):"-"}
Best line: ${wordsLine(rec.bestMoves.slice(0,5))}
${rec.alt.map((l,i)=>`Other good option ${i+1}: ${wordsLine(l.moves)}`).join("\n")}
What happens after the move played: ${rec.replyMoves.length?wordsLine(rec.replyMoves):"(game over)"}
Standing with the best move: ${evalWords(rec.bestScore,rec.color)}
Standing after the move played: ${evalWords(rec.afterScore,rec.color)}
Facts checked by code: ${rec.facts.join(" ")}`;
}
function promptNow(n){
  const turn=n.fen.split(" ")[1];
  const sidetxt=turn==="w"?"White":"Black";
  const h=game.history({verbose:true});const last=h[h.length-1];
  return `You are a friendly chess coach. The player wants to know the best move for ${sidetxt} in this position and why.
${RULES}
Refer to pieces as White's or Black's.

${sidetxt} to move.
${last?`Last move was: ${describe(last)}\n`:""}Pieces:
${pieceList(n.fen)}
Best move: ${describe(n.moves[0])}
Best line: ${wordsLine(n.moves.slice(0,5))}
${n.alt.map((l,i)=>`Other option ${i+1}: ${wordsLine(l.moves)} (${evalWords(l.score,turn)})`).join("\n")}
Standing after the best move: ${evalWords(n.score,turn)}`;
}
async function askClaude(obj,promptText,key,rerender,tier="quick"){
  if(!sampleFn||sampleOff){obj.claudeState="na";rerender();return;}
  if(aborts[key])aborts[key].abort();
  const ac=new AbortController();aborts[key]=ac;
  obj.claudeState="thinking";obj.claude="";rerender();
  try{
    const res=await sampleFn(promptText,{modelTier:tier,signal:ac.signal,onText:({text})=>{obj.claude=text;obj.claudeState="streaming";const p=document.querySelector(`[data-coach="${key}"]`);if(p)p.textContent=text;}});
    obj.claude=res.text;obj.claudeState="done";
  }catch(err){
    if(err&&err.code==="not_granted"){sampleOff=true;obj.claudeState="na";}
    else if(ac.signal.aborted)obj.claudeState="idle";
    else{obj.claudeState="error";obj.claudeErr=err&&err.code==="rate_limited"?"Too many requests right now. Try again in a minute.":"Couldn't reach Claude for this one.";}
  }
  rerender();
}
function explainMove(rec){askClaude(rec,promptMove(rec),"move",()=>{if(current===rec)renderFeedback();});}
function coachBlock(obj,key,btnLabel){
  if(!sampleFn||sampleOff)return "";
  if(["thinking","streaming","done"].includes(obj.claudeState))
    return `<div class="coach"><span class="lbl">Coach</span><p data-coach="${key}">${esc(obj.claude||"Thinking…")}</p></div>`;
  if(obj.claudeState==="error")return `<div class="coach"><p class="muted">${esc(obj.claudeErr)}</p><div><button class="btn small" data-ask="${key}">Try again</button></div></div>`;
  return `<div class="coach"><div><button class="btn small" data-ask="${key}">${btnLabel}</button></div></div>`;
}

/* ---------- Coach: adaptive bot, live notes, hints, questions, review ---------- */
let coach={};
function resetCoach(){
  Object.keys(aborts).forEach(k=>{if(k==="turn"||k==="sum"||k.startsWith("km")||k.startsWith("ask"))aborts[k].abort();});
  coach={notes:[],fen:null,hint:0,hintLines:[],chat:[],threat:null,bookNext:null,openingNoted:false,bookEndNoted:false,castleNoted:false,devNoted:false,assisted:false,reviewed:false,review:null,claude:null,claudeState:"idle"};
  const h=$("btnHint");if(h)h.textContent="Hint";
}
resetCoach();

/* Bot move selection.
   Maia style: sample from Maia's move probabilities at the bot's rating (moves under 1.5% dropped).
   Engine style (or Maia failed to load): 1450+ uses Stockfish's UCI_Elo. Under 1450 there's no UCI_Elo,
   so do a shallow MultiPV search and sample the candidates with a softmax on centipawn loss. Lower
   rating = shallower search and a higher temperature. */
async function pickBotMove(fen,R){
  if($("selStyle").value==="maia"&&R<=2600&&!Maia.failed()){
    try{
      const pol=await Maia.policy(fen,Math.max(600,R),Math.max(600,Math.min(2600,rating)));
      const top=pol.filter(([,p])=>p>=0.015);const pool=top.length?top:pol.slice(0,1);
      let s=Math.random()*pool.reduce((a,[,p])=>a+p,0);
      for(const [u,p] of pool){s-=p;if(s<=0)return u;}
      return pool[0][0];
    }catch(e){maiaNote();}
  }
  if(R>=3000){const r=await Engine.search(fen,{multipv:1,depth:22,mt:1500});return r.best;}
  if(R>=1450){const r=await Engine.search(fen,{multipv:1,elo:Math.min(3190,R),depth:20,mt:700});return r.best;}
  const t=Math.min(1,Math.max(0,(1450-R)/850));      // 0 at 1450, 1 at 600
  const depth=Math.max(2,Math.round(9-6*t));         // 1400: 9 plies ... 600: 3
  const T=30+170*Math.pow(t,1.2);                    // centipawn temperature
  const legal=new Chess(fen).moves({verbose:true});
  const u=m=>m.from+m.to+(m.promotion||"");
  if(legal.length===1)return u(legal[0]);
  const r=await Engine.search(fen,{multipv:Math.min(10,legal.length),depth,mt:500});
  const c=r.lines.filter(l=>l.pv&&l.pv.length).map(l=>({u:l.pv[0],cp:toCp(l.score)}));
  if(!c.length)return r.best;
  const top=Math.max(...c.map(x=>x.cp));
  const w=c.map(x=>Math.exp(-Math.min(900,top-x.cp)/T));
  let s=Math.random()*w.reduce((a,b)=>a+b,0);
  for(let i=0;i<c.length;i++){s-=w[i];if(s<=0)return c[i].u;}
  return c[0].u;
}

/* Maia-3 runtime. The model and ONNX Runtime are served from /maia and only fetched once Maia is needed. */
const Maia=(()=>{
  let w=null,ready=null,state="off",progress=0,err="",seq=0;const pending=new Map();
  function start(){
    if(ready)return ready;
    state="loading";progress=0;maiaNote();
    ready=new Promise((res,rej)=>{
      try{w=new Worker("maia/maia-worker.js");}catch(e){state="error";err=String(e.message||e);maiaNote();rej(e);return;}
      w.onmessage=e=>{const m=e.data;
        if(m.type==="progress"){progress=m.p;maiaNote();}
        else if(m.type==="ready"){state="ready";maiaNote();res();if(mode==="explore")renderExplore();}
        else if(m.type==="result"){const p=pending.get(m.id);if(p){pending.delete(m.id);p.res(m);}}
        else if(m.type==="error"){if(m.id!=null){const p=pending.get(m.id);if(p){pending.delete(m.id);p.rej(new Error(m.message));}}else{state="error";err=m.message;maiaNote();rej(new Error(m.message));}}
      };
      w.onerror=e=>{state="error";err=e.message||"worker failed";maiaNote();rej(new Error(err));for(const p of pending.values())p.rej(new Error(err));pending.clear();};
      w.postMessage({type:"init",parts:4});
    });
    ready.catch(()=>{});
    return ready;
  }
  const mirrorSq=s=>s[0]+(9-+s[1]);
  function mirrorFen(fen){
    const [pos,turn,cas,ep,h,f]=fen.split(" ");
    const swap=r=>r.replace(/[a-zA-Z]/g,c=>c===c.toUpperCase()?c.toLowerCase():c.toUpperCase());
    let c="";if(cas!=="-"){if(cas.includes("k"))c+="K";if(cas.includes("q"))c+="Q";if(cas.includes("K"))c+="k";if(cas.includes("Q"))c+="q";}
    return `${pos.split("/").reverse().map(swap).join("/")} ${turn==="w"?"b":"w"} ${c||"-"} ${ep!=="-"?mirrorSq(ep):"-"} ${h} ${f}`;
  }
  let IDX=null;
  function prep(fen){
    if(!IDX){IDX={};window.MAIA_MOVES.forEach((m,i)=>IDX[m]=i);}
    const black=fen.split(" ")[1]==="b";const f=black?mirrorFen(fen):fen;
    const order="PNBRQKpnbrqk";const tokens=new Float32Array(64*12);
    f.split(" ")[0].split("/").forEach((row,rank)=>{let file=0;for(const ch of row){if(/\d/.test(ch))file+=+ch;else{tokens[((7-rank)*8+file)*12+order.indexOf(ch)]=1;file++;}}});
    const legal=[];for(const m of new Chess(f).moves({verbose:true})){const k=m.from+m.to+(m.promotion||"");if(IDX[k]!==undefined)legal.push([IDX[k],k]);}
    return {tokens,legal,black};
  }
  async function policy(fen,eloSelf,eloOppo){
    await start();
    const {tokens,legal,black}=prep(fen);
    const id=++seq;
    const r=await new Promise((res,rej)=>{pending.set(id,{res,rej});w.postMessage({type:"run",id,tokens:tokens.buffer,es:eloSelf,eo:eloOppo},[tokens.buffer]);});
    const lg=new Float32Array(r.logits);
    const mx=Math.max(...legal.map(([i])=>lg[i]));
    const ex=legal.map(([i,k])=>[k,Math.exp(lg[i]-mx)]);const sum=ex.reduce((a,[,v])=>a+v,0);
    return ex.map(([k,v])=>{let u=k;if(black)u=mirrorSq(k.slice(0,2))+mirrorSq(k.slice(2,4))+k.slice(4);return [u,v/sum];}).sort((a,b)=>b[1]-a[1]);
  }
  return {start,policy,state:()=>state,progress:()=>progress,error:()=>err,failed:()=>state==="error"};
})();
function maiaNote(){
  const el=$("maiaNote");if(!el)return;
  const st=Maia.state();
  if(st==="loading"&&busy&&mode==="play")setStatus(`Loading Maia… ${Maia.progress()}%`,"busy");
  if($("selStyle").value!=="maia"){el.textContent="Stockfish-based bot. Its mistakes come from shallow search, so they're less human.";return;}
  el.textContent=st==="ready"?"Maia is loaded: it plays the moves real players at the bot's rating play (range 600–2600; above that, Stockfish).":
    st==="loading"?`Downloading Maia (about 57 MB; your browser keeps it after the first time)… ${Maia.progress()}%`:
    st==="error"?`Maia couldn't load here (${Maia.error()}). Using the engine-based bot instead.`:
    "Maia (a model trained on millions of real Lichess games) loads when you play.";
}

/* Opening book = the lesson lines from the Learn tab */
let BOOK=null;
function buildBook(){
  BOOK=[];
  for(const l of LESSONS){
    if(!l.moves||!l.moves.length||!["italian","white","black-e4","black-d4","traps"].includes(l.ch))continue;
    const chain=[];let x=l;const seen=new Set();
    while(x&&!seen.has(x.id)){seen.add(x.id);chain.unshift(x);x=x.from?byId[x.from]:null;}
    const g=new Chess();const path=[];let ok=true;
    for(const c of chain){for(const [s] of (c.moves||[])){const m=g.move(cleanSan(s));if(!m){ok=false;break;}path.push(m);}if(!ok)break;}
    if(ok&&path.length)BOOK.push({l,path});
  }
}
function openingInfo(){
  if(startFen!==START)return null;
  if(!BOOK)buildBook();
  const hist=game.history();let best=null;
  for(const b of BOOK){
    let m=0;while(m<hist.length&&m<b.path.length&&b.path[m].san===hist[m])m++;
    if(!best||m>best.m||(m===best.m&&b.path.length<best.b.path.length))best={b,m};
  }
  if(!best||best.m<3)return null;
  return {...best,hist};
}
function openingNote(){
  coach.bookNext=null;
  const o=openingInfo();if(!o)return null;
  const {b,m,hist}=o;const title=b.l.title;
  if(m===hist.length){
    if(m<b.path.length){coach.bookNext=b.path[m];return `Opening: ${title}. You're still on the lesson line.`;}
    if(!coach.bookEndNoted){coach.bookEndNoted=true;return `That's the end of the lesson line "${title}". From here, follow the plan the lesson describes.`;}
    return null;
  }
  if(coach.openingNoted||m>=b.path.length||hist.length-m>2)return null;
  coach.openingNoted=true;
  const devColor=m%2===0?"w":"b",moveNo=Math.floor(m/2)+1;
  if(devColor===playerColor)return `You left the lesson "${title}" at move ${moveNo}. The lesson plays ${describe(b.path[m]).toLowerCase()} there.`;
  return `The bot left your lesson line "${title}" at move ${moveNo}. You're on your own now: develop, castle, and fight for the center.`;
}

function minorsHome(c){
  const sq=c==="w"?{b1:"n",g1:"n",c1:"b",f1:"b"}:{b8:"n",g8:"n",c8:"b",f8:"b"};
  return Object.entries(sq).filter(([s,t])=>{const p=game.get(s);return p&&p.color===c&&p.type===t;}).length;
}
/* Opening principles, checked by code on the player's own move */
function principleChecks(rec){
  const out=[];const mv=rec.move;
  if(rec.grade==="Best"||rec.grade==="Excellent")return out;
  const n=+rec.fenBefore.split(" ")[5];
  const prior=game.history({verbose:true}).slice(0,-1).filter(m=>m.color===mv.color);
  const g0=new Chess(rec.fenBefore);
  if(mv.piece==="q"&&!mv.captured&&n<=6)out.push({tag:"Brought the queen out early",text:"Early queen trips usually get chased by the opponent's knights and bishops, and every chase costs you a move."});
  else if(n<=8&&!mv.captured&&mv.piece!=="p"&&mv.piece!=="k"&&prior.some(m=>m.to===mv.from)){
    const home=(mv.color==="w"?["b1","g1","c1","f1"]:["b8","g8","c8","f8"]).filter(s=>{const p=g0.get(s);return p&&p.color===mv.color&&(p.type==="n"||p.type==="b");}).length;
    if(home>=2)out.push({tag:"Moved the same piece twice in the opening",text:"You moved a piece that had already moved while others are still at home. Get each piece out once first."});
  }
  if(mv.piece==="k"&&!mv.flags.includes("k")&&!mv.flags.includes("q")&&n<=15&&!g0.in_check())out.push({tag:"Moved the king instead of castling",text:"Walking the king early gives up castling. In the opening, castle instead."});
  return out;
}
/* Pattern tags for the review and the all-games tally */
function tagMove(rec,a){
  if(!["Inaccuracy","Mistake","Blunder"].includes(rec.grade))return [];
  const t=[];const me=rec.color;const best=a.lines[0];
  const base=material(new Chess(rec.fenBefore),me);
  if(best.score.mate!==undefined&&best.score.mate>0&&!(rec.afterScore.mate>0))t.push("Missed a checkmate");
  else if(rec.afterScore.mate!==undefined&&rec.afterScore.mate<0)t.push("Allowed a checkmate");
  else{
    const loss=rec.replyMoves.length?matAfter(rec.fenAfter,rec.replyMoves.map(x=>x.from+x.to+(x.promotion||"")),4,me)-base:0;
    const gain=matSettled(rec.fenBefore,best.pv,5,me)-base;
    if(loss<=-2)t.push("Left a piece hanging");
    else if(gain>=2)t.push("Missed a chance to win material");
    else t.push("Positional slip");
  }
  return t.concat((rec.principles||[]).map(p=>p.tag));
}

/* What would the opponent do if it were their move again? (null-move threat check) */
async function threatCheck(fen,them){
  const g=new Chess(fen);if(g.in_check())return null;
  const p=fen.split(" ");p[1]=them;p[3]="-";const nf=p.join(" ");
  if(!g.validate_fen(nf).valid)return null;
  let r;try{r=await Engine.search(nf,{multipv:1,depth:12,mt:450});}catch(e){return null;}
  const l=r.lines[0];if(!l||!l.pv||!l.pv.length)return null;
  const mv=pvMoves(nf,l.pv,1)[0];if(!mv)return null;
  if(l.score.mate!==undefined&&l.score.mate>0&&l.score.mate<=3)return {mv,text:`Watch out: they're threatening checkmate, starting with ${describe(mv).toLowerCase()}.`};
  const gain=matSettled(nf,l.pv,4,them)-material(new Chess(nf),them);
  if(gain>=2&&mv.captured)return {mv,text:`Watch out: their ${NAME[mv.piece]} can take your ${NAME[mv.captured]} on ${mv.to}, and it isn't safely defended.`};
  if(gain>=2)return {mv,text:`Watch out: they have a threat next move (${describe(mv).toLowerCase()}) that wins material.`};
  return null;
}

async function coachTurn(botRec){
  const fen=game.fen();
  coach.fen=null;coach.notes=[];coach.threat=null;coach.claude=null;coach.claudeState="idle";if(aborts.turn)aborts.turn.abort();
  renderCoach();
  const a=await pre;
  if(game.fen()!==fen||mode!=="play"||!a||a.fen!==fen)return;
  const me=playerColor,them=me==="w"?"b":"w";const notes=[];
  if(botRec&&botRec.move)notes.push({k:"move",t:`${describe(botRec.move)}.`});
  const op=openingNote();if(op)notes.push({k:"book",t:op});
  const best=a.lines[0];
  const baseBefore=material(new Chess(botRec&&botRec.fenBefore?botRec.fenBefore:fen),me);
  if(best.score.mate!==undefined&&best.score.mate>0){
    notes.push({k:"opp",t:best.score.mate===1?"You have checkmate in one. Find it.":best.score.mate<=5?`You have a forced checkmate in ${best.score.mate}. Look at every check.`:"You're winning by force. Keep it simple and look for checks."});
  }else{
    const gain=matSettled(fen,best.pv,5,me)-baseBefore;
    if(gain>=2)notes.push({k:"opp",t:"There's a way to come out ahead in material here. Check every capture, check and attack before you move."});
  }
  const th=await threatCheck(fen,them);
  if(game.fen()!==fen||mode!=="play")return;
  coach.threat=th;if(th)notes.push({k:"threat",t:th.text});
  const n=+fen.split(" ")[5];
  const kh=me==="w"?"e1":"e8",k=game.get(kh),rights=fen.split(" ")[2];
  const canCastle=me==="w"?/[KQ]/.test(rights):/[kq]/.test(rights);
  if(!coach.castleNoted&&n>=9&&k&&k.type==="k"&&k.color===me&&canCastle){coach.castleNoted=true;notes.push({k:"tip",t:"Your king is still in the middle. Castling soon keeps it safe and brings a rook into play."});}
  const home=minorsHome(me);
  if(!coach.devNoted&&n>=8&&home>=2){coach.devNoted=true;notes.push({k:"tip",t:`${home} of your knights and bishops are still on their starting squares. Get them into the game.`});}
  coach.notes=notes;coach.fen=fen;coach.a=a;coach.botRec=botRec;
  renderCoach();
  if(talkMode()==="every"&&sampleFn&&!sampleOff)coachSpeak();
}
function ideaHint(fen,a,bm){
  const best=a.lines[0];
  if(best.score.mate!==undefined&&best.score.mate>0)return "There's a forced checkmate. Look at every check you can give.";
  if(coach.threat&&coach.fen===fen)return "Something of yours is under attack. Deal with the threat first.";
  if(coach.bookNext&&coach.bookNext.color===playerColor&&coach.bookNext.san===bm.san)return "You're still in your lesson line. What does the lesson play here?";
  if(bm.san.includes("+"))return "A check is strong here.";
  if(bm.captured)return "There's a capture worth making. Look at what you can take safely.";
  if(bm.flags.includes("k")||bm.flags.includes("q"))return "Think about your king's safety.";
  const gain=matSettled(fen,best.pv,5,playerColor)-material(new Chess(fen),playerColor);
  if(gain>=2)return "There's a tactic that wins material. Look for a fork, a pin, or a piece that isn't defended.";
  return `No tactic here. Improve your position: the best move is a ${NAME[bm.piece]} move.`;
}

const TALK_RULES=`- 2 to 4 short sentences, under 70 words, plain text, no markdown.
- Never write algebraic notation like Nf5 or O-O. Say "your knight on f3" or "their bishop on b4". Square names are fine.
- No evaluation numbers.
- Do not reveal the best move and do not name which piece to move. Point the player at what to look at: threats, loose pieces, chances, plans.
- Use only the facts below. Do not invent threats or tactics.`;
function promptTurn(){
  const a=coach.a,me=playerColor,r=current&&current.san?current:null,b=coach.botRec;
  const sname=me==="w"?"White":"Black";
  return `You are a chess coach sitting beside a beginner during a game against a bot. It is now the player's move. Talk them through what matters in this position.
${TALK_RULES}
Refer to the player's pieces as "your" and the bot's as "their".

Player plays ${sname}. Player rating estimate about ${Math.round(rating)}.
${r?`Player's last move: ${describe(r.move)} (graded ${r.grade}${r.claudeState==="done"?", already explained to them":""})\n`:""}${b&&b.move?`Bot's reply: ${describe(b.move)}\n`:""}Pieces now:
${pieceList(coach.fen)}
Notes checked by code: ${coach.notes.map(n=>n.t).join(" ")||"none"}
Engine's view, for you only (do not reveal the move): best is ${describe(pvMoves(coach.fen,a.lines[0].pv,1)[0])}; ${evalWords(a.lines[0].score,me)}.`;
}
function coachSpeak(){
  if(!coach.fen||coach.fen!==game.fen())return;
  askClaude(coach,promptTurn(),"turn",()=>{renderCoach();});
}

/* Ask box. The prompt carries the position and engine lines; check_move lets the model run Stockfish on any move it brings up. */
const ASK_RULES=`You are a strong, friendly chess coach helping a beginner who learns fast, during their game against a bot. Answer their question about the current position.
- Under 130 words. Plain text, short paragraphs, no headings.
- Prefer words over notation. If you name a move, say it in words first, e.g. "knight to f3 (Nf3)".
- For any concrete claim about tactics or which move is better, rely on the engine data below or the check_move tool. If neither covers it, say what you would look for instead of inventing lines.
- If they ask for the best move, give it and say why.
- Refer to the player's pieces as "your" and the bot's as "their".`;
async function positionContext(fen,a){
  const turn=fen.split(" ")[1];const me=playerColor;
  if(!a||a.fen!==fen){try{const r=await Engine.search(fen,{multipv:3});a={fen,...r};}catch(e){a=null;}}
  const sname=me==="w"?"White":"Black";
  let s=`Player plays ${sname}; rating estimate about ${Math.round(rating)}. It is ${turn===me?"the player's":"the bot's"} turn.
Pieces:
${pieceList(fen)}
Moves so far: ${game.history().length?numbered(startFen,game.history()):"none"}`;
  const o=openingInfo();if(o)s+=`\nOpening: closest lesson line is "${o.b.l.title}" (followed for ${o.m} of ${o.hist.length} moves).`;
  if(a){
    s+=`\nEngine top moves for ${turn===me?"the player":"the bot"}:`;
    a.lines.forEach((l,i)=>{const mv=pvMoves(fen,l.pv,5);if(mv.length)s+=`\n${i+1}) ${describe(mv[0])} (${mv[0].san}). Line: ${wordsLine(mv)}. Then: ${evalWords(l.score,turn)}.`;});
  }
  if(coach.threat&&coach.fen===fen)s+=`\nThreat check (if the bot could move again): ${coach.threat.text}`;
  const r=current&&current.san?current:null;
  if(r)s+=`\nPlayer's last graded move: ${describe(r.move)} (${r.san}), graded ${r.grade}${r.best&&r.grade!=="Best"?`; best was ${describe(r.best)} (${r.best.san})`:""}.`;
  return s;
}
function checkMoveTool(fen,a){
  return {name:"check_move",
    description:"Analyze one candidate move in the current position with Stockfish. Input a move in SAN (Nf3, Bxf7+, O-O) or from-to squares (g1f3). Returns the move in words, how the game stands after it, the likely continuation, and how it compares with the engine's best move.",
    inputSchema:{type:"object",properties:{move:{type:"string",description:"The move, in SAN or from-to squares"}},required:["move"]},
    async execute(input){
      const s=String(input&&input.move||"").trim();
      const g=new Chess(fen);let m=g.move(s,{sloppy:true});
      if(!m&&/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(s))m=g.move(uciObj(s));
      if(!m)throw new Error("Not a legal move in this position. Legal moves: "+new Chess(fen).moves().join(", "));
      if(g.in_checkmate())return {move:describe(m),result:"checkmate"};
      if(g.game_over())return {move:describe(m),result:"the game ends in a draw"};
      const r=await Engine.search(g.fen(),{multipv:1,depth:15,mt:900});
      const after=flip(r.lines[0].score);
      const bestLine=a&&a.fen===fen?a.lines[0]:null;
      const bm=bestLine?pvMoves(fen,bestLine.pv,1)[0]:null;
      const drop=bestLine?Math.max(0,winPct(toCp(bestLine.score))-winPct(toCp(after))):null;
      const verdict=drop===null?"unknown":drop<2?"as good as the best move":drop<5?"good":drop<10?"an inaccuracy":drop<20?"a mistake":"a blunder";
      return {move:`${describe(m)} (${m.san})`,standing_after:evalWords(after,m.color),likely_continuation:wordsLine(pvMoves(g.fen(),r.lines[0].pv,5)),
        engine_best:bm?`${describe(bm)} (${bm.san})`:"unknown",standing_after_best:bestLine?evalWords(bestLine.score,fen.split(" ")[1]):"unknown",verdict};
    }};
}
let askSeq=0;
async function askCoach(q){
  if(!sampleFn||sampleOff)return;
  const item={q,a:"",state:"thinking",id:"ask"+(++askSeq)};
  coach.chat.push(item);if(coach.chat.length>6)coach.chat.shift();
  renderChat();
  const fen=game.fen();
  let a=null;try{a=pre?await pre:null;}catch(e){}
  const ctx=await positionContext(fen,a);
  if(a&&a.fen!==fen)a=null;
  const prior=coach.chat.slice(0,-1).filter(c=>c.state==="done").slice(-3);
  const msgs=[];prior.forEach(c=>{msgs.push({role:"user",content:c.q});msgs.push({role:"assistant",content:c.a});});
  msgs.push({role:"user",content:`${ASK_RULES}\n\n${ctx}\n\nQuestion: ${q}`});
  const ac=new AbortController();aborts[item.id]=ac;
  const onText=({text})=>{item.a=text;item.state="streaming";const p=document.querySelector(`[data-chat="${item.id}"]`);if(p)p.textContent=text;};
  let tools=null;try{const L=await sampleFn.limits();if(L&&L.tools)tools=[checkMoveTool(fen,a)];}catch(e){}
  const run=t=>sampleFn(msgs,Object.assign({modelTier:"default",cache:false,signal:ac.signal,onText},t?{tools:t}:{}));
  try{
    let res;
    try{res=await run(tools);}catch(err){if(err&&err.code==="tools_unavailable"&&tools)res=await run(null);else throw err;}
    item.a=res.text;item.state="done";
  }catch(err){
    if(err&&err.code==="not_granted"){sampleOff=true;item.state="error";item.a="Claude isn't available on this page right now.";}
    else if(ac.signal.aborted){item.state="error";item.a=item.a||"Stopped.";}
    else{item.state="error";item.a=(err&&err.text?err.text+"\n\n":"")+(err&&err.code==="rate_limited"?"Too many requests right now. Try again in a minute.":"Couldn't reach Claude for this one.");}
  }
  renderChat();
}
$("askForm").addEventListener("submit",e=>{e.preventDefault();const q=$("askInput").value.trim();if(!q)return;$("askInput").value="";askCoach(q);});
function renderChat(){
  const el=$("chat");
  el.innerHTML=coach.chat.slice().reverse().map(c=>`<div class="qa"><div class="q">${esc(c.q)}</div><p class="a${c.state==="error"?" muted":""}" data-chat="${c.id}">${esc(c.a||"Thinking…")}</p></div>`).join("");
}

function renderCoach(){
  const card=$("coachCard");
  card.hidden=mode!=="play";
  if(card.hidden)return;
  $("ratingTag").textContent=`Bot ≈ ${botRating()>=3000?"max":botRating()} · You ≈ ${Math.round(rating)}`;
  refreshLevelLabel();
  const notes=(coach.notes||[]).slice();
  (coach.hintLines||[]).forEach(t=>notes.push({k:"hint",t:"Hint: "+t}));
  let h;
  if(notes.length)h=`<ul class="cnotes">${notes.map(n=>`<li class="${n.k}">${esc(n.t)}</li>`).join("")}</ul>`;
  else if(game.game_over())h=`<p class="why muted">Game over. The review is above.</p>`;
  else if(!game.history().length&&game.turn()===playerColor)h=`<p class="why muted">Make your first move. I'll point out threats, chances, and where you leave your opening lessons. Ask me anything below.</p>`;
  else if(game.turn()!==playerColor)h=`<p class="why muted">${paused?"Paused on your mistake. Retry it or continue.":"Bot is thinking…"}</p>`;
  else h=`<p class="why muted">Looking at the position…</p>`;
  $("coachNotes").innerHTML=h;
  let t="";
  if(sampleFn&&!sampleOff){
    if(["thinking","streaming","done"].includes(coach.claudeState))t=`<div class="coach"><span class="lbl">Coach</span><p data-coach="turn">${esc(coach.claude||"Thinking…")}</p></div>`;
    else if(coach.claudeState==="error")t=`<div class="coach"><p class="muted">${esc(coach.claudeErr)}</p></div>`;
    else if(coach.fen&&coach.fen===game.fen()&&!game.game_over())t=`<div class="row"><button class="btn small" id="talkBtn">What should I be thinking about?</button></div>`;
  }
  $("coachTalk").innerHTML=t;
  const tb=$("talkBtn");if(tb)tb.onclick=coachSpeak;
  $("askForm").hidden=!sampleFn||sampleOff;
  renderChat();
}

/* Review */
function accuracyOf(list){
  if(!list.length)return null;
  const a=list.map(r=>Math.max(1,Math.min(100,103.1668*Math.exp(-0.04354*r.drop)-3.1669)));
  const mean=a.reduce((s,x)=>s+x,0)/a.length,harm=a.length/a.reduce((s,x)=>s+1/x,0);
  return Math.round((mean+harm)/2);
}
function finishReview(msg,loser){
  if(coach.reviewed)return;coach.reviewed=true;
  const mine=records.filter(r=>r.grade);
  let s=0.5;if(game.in_checkmate())s=loser===playerColor?0:1;
  const acc=accuracyOf(mine);
  let change=null;
  if(startFen===START&&mine.length>=5){
    const br=botRating(),E=1/(1+Math.pow(10,(br-rating)/400));
    const K=(ratingGames<5?140:70)*(coach.assisted?0.5:1);
    const d=Math.round(K*(s-E));
    const old=Math.round(rating);rating=Math.max(400,Math.min(2900,rating+d));ratingGames++;saveRating();
    change={old,now:Math.round(rating),d:Math.round(rating)-old};refreshRatingUI();
  }
  const tags={};mine.forEach(r=>(r.tags||[]).forEach(t=>tags[t]=(tags[t]||0)+1));
  if(mine.length>=3){patterns.games++;for(const t in tags)patterns.tags[t]=(patterns.tags[t]||0)+tags[t];savePatterns();}
  coach.review={msg,s,change,tags,acc,claude:null,claudeState:"idle"};
  renderReview();renderCoach();
  if(talkMode()!=="ask"&&mine.length>=3)askClaude(coach.review,promptSummary(),"sum",renderReview,"default");
  $("reviewCard").scrollIntoView({block:"nearest",behavior:"smooth"});
}
function keyMoments(){
  return records.filter(r=>r.grade&&r.drop>=10).sort((a,b)=>b.drop-a.drop).slice(0,3).sort((a,b)=>records.indexOf(a)-records.indexOf(b));
}
function moveNo(r){return +r.fenBefore.split(" ")[5];}
function promptSummary(){
  const mine=records.filter(r=>r.grade);const o=openingInfo();
  const count=g=>mine.filter(r=>r.grade===g).length;
  const R=coach.review;
  const top=Object.entries(patterns.tags).sort((a,b)=>b[1]-a[1]).slice(0,3);
  return `You are a chess coach reviewing a beginner's game with them right after it ended.
Write one sentence on what went well, then 3 numbered takeaways. Each takeaway is one concrete habit to practice, tied to a specific moment below. Under 120 words, plain text, no markdown. No algebraic notation (say "your knight on f3"); square names are fine. No evaluation numbers.
Use only the facts below.

Player: ${playerColor==="w"?"White":"Black"}. Result: ${R.msg}
Opening: ${o?`closest lesson line "${o.b.l.title}", followed for ${o.m} moves`:"not one of their lesson lines"}.
Accuracy ${R.acc}%. Best ${count("Best")}, Excellent ${count("Excellent")}, Good ${count("Good")}, Inaccuracies ${count("Inaccuracy")}, Mistakes ${count("Mistake")}, Blunders ${count("Blunder")}.
Biggest mistakes:
${keyMoments().map(r=>`- Move ${moveNo(r)}: ${describe(r.move)} (${r.grade}). Best was ${r.best?describe(r.best):"-"}. ${r.facts.join(" ")} Tags: ${(r.tags||[]).join(", ")}`).join("\n")||"- none"}
Patterns this game: ${Object.keys(R.tags).join(", ")||"none"}
Patterns across all games so far: ${top.map(([t,c])=>`${t} (${c})`).join(", ")||"none yet"}`;
}
function graphSVG(){
  const pts=records.map(r=>r.evalW?winPct(toCp(playerColor==="w"?r.evalW:flip(r.evalW))):null);
  for(let i=0;i<pts.length;i++)if(pts[i]==null)pts[i]=i?pts[i-1]:50;
  if(pts.length<2)return "";
  const W=320,H=90,n=pts.length,x=i=>(i/(n-1))*W,y=v=>H-(v/100)*H;
  let line=pts.map((v,i)=>`${i?"L":"M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  let area=`M0,${H/2} `+pts.map((v,i)=>`L${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")+` L${W},${H/2} Z`;
  let marks="",hits="";
  records.forEach((r,i)=>{
    if(r.grade==="Mistake"||r.grade==="Blunder")marks+=`<circle cx="${x(i).toFixed(1)}" cy="${y(pts[i]).toFixed(1)}" r="3.4" style="fill:var(${GRADE_COLOR[r.grade]});stroke:var(--surface);stroke-width:1.2"/>`;
    const w=W/n;hits+=`<rect data-ply="${i}" x="${Math.max(0,x(i)-w/2).toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${H}" style="fill:transparent;cursor:pointer"><title>Move ${Math.floor(i/2)+1}: ${esc(r.san)}${r.grade?" ("+r.grade+")":""}</title></rect>`;
  });
  return `<div class="gwrap"><svg class="graph" viewBox="0 0 ${W} ${H}" role="img" aria-label="How the game swung: above the middle line you were better">
<line x1="0" y1="${H/2}" x2="${W}" y2="${H/2}" style="stroke:var(--line);stroke-width:1"/>
<path d="${area}" style="fill:var(--accent-soft)"/>
<path d="${line}" style="fill:none;stroke:var(--accent);stroke-width:1.6;stroke-linejoin:round"/>${marks}${hits}</svg>
<div class="glabels"><span>You better ↑</span><span>Tap the graph to replay any move</span></div></div>`;
}
function replayAt(i){
  const mv=game.history({verbose:true});if(!mv.length)return;
  startPreview(startFen,mv,"Game replay");preview.step=Math.min(mv.length,i+1);renderPreview();
}
function renderReview(){
  const card=$("reviewCard");const R=coach.review;
  card.hidden=!(mode==="play"&&R);if(card.hidden)return;
  const mine=records.filter(r=>r.grade);const count=g=>mine.filter(r=>r.grade===g).length;
  let h=`<div class="banner">${esc(R.msg)}</div>`;
  if(R.change)h+=`<p class="why">Rating estimate: <b>${R.change.old} → ${R.change.now}</b> (${R.change.d>=0?"+":""}${R.change.d})${coach.assisted?". Hints or take-backs were used, so this game counted half":""}.${$("selLevel").value==="auto"?` Next game the bot plays at about ${Math.round(rating)}.`:""}</p>`;
  else if(startFen!==START)h+=`<p class="why muted">Games started from a custom position don't change your rating.</p>`;
  h+=`<div class="sum"><span>Accuracy <b>${R.acc??"-"}%</b></span><span>Best <b>${count("Best")}</b></span><span>Inaccuracies <b>${count("Inaccuracy")}</b></span><span>Mistakes <b>${count("Mistake")}</b></span><span>Blunders <b>${count("Blunder")}</b></span></div>`;
  h+=graphSVG();
  if(sampleFn&&!sampleOff){
    if(["thinking","streaming","done"].includes(R.claudeState))h+=`<div class="coach"><span class="lbl">Coach's summary</span><p data-coach="sum">${esc(R.claude||"Thinking…")}</p></div>`;
    else if(R.claudeState==="error")h+=`<div class="coach"><p class="muted">${esc(R.claudeErr)}</p><div><button class="btn small" id="sumBtn">Try again</button></div></div>`;
    else if(mine.length>=3)h+=`<div class="row"><button class="btn small" id="sumBtn">Get the coach's summary</button></div>`;
  }
  const km=keyMoments();
  if(km.length){
    h+=`<h3 class="kmt">Turning points</h3>`;
    km.forEach(r=>{const i=records.indexOf(r);
      h+=`<div class="km"><div class="verdict"><span class="chip ${r.grade}">${r.grade}</span><span class="muted">Move ${moveNo(r)}</span></div>
      <p>You played ${esc(describe(r.move).toLowerCase())}. Better was ${esc(r.best?describe(r.best).toLowerCase():"-")}.</p>
      <p class="muted">${esc(r.facts[0]||"")}</p>${coachBlock(r,"km"+i,"Explain this moment")}
      <div class="row"><button class="btn small" data-show="${i}">Show the position</button><button class="btn small" data-best="${i}">Watch the better line</button></div></div>`;});
  }else if(mine.length)h+=`<p class="why">No mistakes or blunders this game.</p>`;
  const tg=Object.keys(R.tags);
  const top=Object.entries(patterns.tags).sort((a,b)=>b[1]-a[1]).slice(0,3);
  if(tg.length||top.length){
    h+=`<h3 class="kmt">Patterns</h3><ul class="facts">`;
    if(tg.length)h+=`<li>This game: ${esc(tg.map(t=>R.tags[t]>1?`${t} (${R.tags[t]}×)`:t).join(", "))}</li>`;
    if(top.length&&patterns.games>1)h+=`<li>Across your last ${patterns.games} games, most common: ${esc(top.map(([t,c])=>`${t.toLowerCase()} (${c})`).join(", "))}</li>`;
    h+=`</ul>`;
  }
  h+=`<div class="row"><button class="btn primary small" id="revNew">Next game</button></div>`;
  $("reviewBody").innerHTML=h;
  const body=$("reviewBody");
  body.querySelectorAll("rect[data-ply]").forEach(el=>el.addEventListener("click",()=>replayAt(+el.dataset.ply)));
  body.querySelectorAll("[data-show]").forEach(b=>b.onclick=()=>{const r=records[+b.dataset.show];startPreview(r.fenBefore,[r.move,...r.replyMoves],`What happened after ${r.san}`);});
  body.querySelectorAll("[data-best]").forEach(b=>b.onclick=()=>{const r=records[+b.dataset.best];startPreview(r.fenBefore,r.bestMoves,`Better line instead of ${r.san}`);});
  body.querySelectorAll("[data-ask]").forEach(b=>{const k=b.dataset.ask;if(k.startsWith("km")){const r=records[+k.slice(2)];b.onclick=()=>askClaude(r,promptMove(r),k,renderReview);}});
  const sb=$("sumBtn");if(sb)sb.onclick=()=>askClaude(R,promptSummary(),"sum",renderReview,"default");
  $("revNew").onclick=newGame;
}

/* ---------- Panels ---------- */
function stepsHTML(moves,refColor){
  return `<ol class="steps">${moves.map(m=>`<li class="${m.color===refColor?"":"them"}">${esc(describe(m))}</li>`).join("")}</ol>`;
}
function renderFeedback(){
  const el=$("fbBody");const r=current;
  $("feedback").hidden=mode==="setup"||mode==="learn"||mode==="explore";
  if(!r||!r.san){
    let msg=mode==="free"?"Make a move for either side. Each move gets graded, and you can ask for the best reply.":"Make a move. Every move you play is graded against Stockfish, with the best move and the reason.";
    el.innerHTML=r&&r.end?`<div class="banner">${esc(r.end)}</div>`:`<p class="why muted">${msg}</p>`;return;
  }
  const label=mode==="play"?"You played":(r.color==="w"?"White played":"Black played");
  let h=`<div class="verdict"><span class="chip ${r.grade}">${r.grade}</span><span class="muted" style="font-size:.88rem">${esc(evalWords(r.afterScore,r.color))}</span></div>`;
  h+=`<div class="compare"><div><span>${label.split(" ")[0]}</span><strong>${esc(describe(r.move))}<span class="san">${esc(r.san)}</span></strong></div>`;
  if(r.grade!=="Best"&&r.best)h+=`<div><span>Best</span><strong>${esc(describe(r.best))}<span class="san">${esc(r.best.san)}</span></strong></div>`;
  h+=`</div>`;
  h+=`<ul class="facts">${r.facts.map(x=>`<li>${esc(x)}</li>`).join("")}${(r.principles||[]).map(p=>`<li><b>Principle:</b> ${esc(p.text)}</li>`).join("")}</ul>`;
  h+=coachBlock(r,"move","Explain why");
  h+=`<div class="row">`;
  if(r.grade!=="Best")h+=`<button class="btn small" id="watchBest">Watch the best line</button>`;
  if(r.grade!=="Best"&&r.replyMoves.length)h+=`<button class="btn small" id="watchMine">See what happens after ${esc(r.san)}</button>`;
  h+=`</div>`;
  h+=`<details><summary>Engine lines (notation)</summary><div class="lines">${r.topLines.map(l=>`<span>${esc(l.score.padStart(6," "))}  ${esc(numbered(r.fenBefore,l.san))}</span>`).join("")}</div></details>`;
  if(paused&&current===records[records.length-1])h+=`<div class="row"><button class="btn primary" id="btnRetry">Retry this move</button><button class="btn" id="btnCont">Continue</button></div>`;
  if(r.end)h+=`<div class="banner">${esc(r.end)}</div>`;
  el.innerHTML=h;
  const wb=$("watchBest");if(wb)wb.onclick=()=>startPreview(r.fenBefore,r.bestMoves,`Best line instead of ${r.san}`);
  const wm=$("watchMine");if(wm)wm.onclick=()=>startPreview(r.fenBefore,[r.move,...r.replyMoves],`What happens after ${r.san}`);
  const br=$("btnRetry");if(br)br.onclick=retry;
  const bc=$("btnCont");if(bc)bc.onclick=()=>{paused=false;arrows=[];renderFeedback();botMove();};
  el.querySelectorAll("[data-ask]").forEach(b=>b.onclick=()=>explainMove(r));
}
function renderNow(){
  const card=$("nowCard");
  if(mode!=="free"||!now||game.game_over()){card.hidden=true;return;}
  card.hidden=false;
  const turn=now.fen.split(" ")[1];const sname=turn==="w"?"White":"Black";
  $("nowTitle").textContent=`${sname} to move`;
  const el=$("nowBody");let h="";
  if(now.state==="hidden"){
    h=`<p class="why muted" style="margin:0">Try to find it yourself first, or reveal what the engine would play.</p>
    <div class="row"><button class="btn primary small" id="nowShow">Show the best move for ${sname}</button><button class="btn small" id="nowBot">Let the bot move for ${sname}</button><button class="btn small" id="nowPlay">Play the bot from here</button></div>`;
  }else if(now.state==="loading"){
    h=`<p class="why muted" style="margin:0">Analyzing…</p>`;
  }else{
    h=`<div class="compare"><div><span>Best</span><strong>${esc(describe(now.moves[0]))}<span class="san">${esc(now.moves[0].san)}</span></strong></div></div>
    <p class="why muted" style="margin:0;font-size:.88rem">${esc(evalWords(now.score,turn))} after this.</p>
    <div><span class="muted" style="font-size:.78rem;text-transform:uppercase;letter-spacing:.07em">The idea, move by move</span>${stepsHTML(now.moves.slice(0,5),turn)}</div>`;
    h+=coachBlock(now,"now","Explain why it's best");
    h+=`<div class="row"><button class="btn small" id="nowWatch">Watch it on the board</button><button class="btn small" id="nowBot">Let the bot move for ${sname}</button><button class="btn small" id="nowPlay">Play the bot from here</button></div>`;
    if(now.alt.length)h+=`<details><summary>Other good moves</summary><div class="lines">${now.alt.map(l=>`<span>${esc(describe(l.moves[0]))} · ${esc(evalWords(l.score,turn))}</span>`).join("")}</div></details>`;
  }
  el.innerHTML=h;
  const s=$("nowShow");if(s)s.onclick=revealNow;
  const w=$("nowWatch");if(w)w.onclick=()=>startPreview(now.fen,now.moves,`Best line for ${sname}`);
  const b=$("nowBot");if(b)b.onclick=()=>{if(busy)return;now=null;renderNow();botMove();};
  const p=$("nowPlay");if(p)p.onclick=()=>playFromHere();
  el.querySelectorAll("[data-ask]").forEach(x=>x.onclick=()=>{const n=now;askClaude(n,promptNow(n),"now",()=>{if(now===n)renderNow();});});
}
async function revealNow(){
  const n=now;n.state="loading";renderNow();
  const a=await pre;if(now!==n||a.fen!==n.fen)return;
  n.moves=pvMoves(a.fen,a.lines[0].pv,6);n.score=a.lines[0].score;
  n.alt=a.lines.slice(1).map(l=>({moves:pvMoves(a.fen,l.pv,4),score:l.score}));
  n.state="shown";n.claudeState="idle";
  arrows=[{from:n.moves[0].from,to:n.moves[0].to,color:"--accent"}];renderBoard();renderNow();
  if(talkMode()!=="ask")askClaude(n,promptNow(n),"now",()=>{if(now===n)renderNow();});
}
function renderMoves(){
  const el=$("moves");let h="";
  const startBlack=records.length&&records[0].color==="b";
  const list=startBlack?[null,...records]:records;
  const startNo=+(startFen.split(" ")[5]||1);
  for(let i=0;i<list.length;i+=2){
    h+=`<span class="n">${startNo+i/2}.</span>`;
    for(const r of [list[i],list[i+1]]){
      if(!r){h+=`<span></span>`;continue;}
      const dot=r.grade?`<i style="background:var(${GRADE_COLOR[r.grade]})" title="${r.grade}"></i>`:`<i></i>`;
      h+=`<span class="mv">${dot}${esc(r.san)}</span>`;
    }
  }
  el.innerHTML=h;el.scrollTop=el.scrollHeight;
  const mine=records.filter(r=>r.grade);
  const count=g=>mine.filter(r=>r.grade===g).length;
  const acc=accuracyOf(mine);
  $("summary").innerHTML=mine.length?`<span>Accuracy <b>${acc}%</b></span><span>Best <b>${count("Best")}</b></span><span>Inaccuracies <b>${count("Inaccuracy")}</b></span><span>Mistakes <b>${count("Mistake")}</b></span><span>Blunders <b>${count("Blunder")}</b></span>`:`<span>No moves yet.</span>`;
}

/* ---------- Preview (step through a line on the board) ---------- */
function startPreview(fen,moves,title){
  if(!moves||!moves.length)return;
  preview={fen,moves,step:1,title};selected=null;
  $("previewBar").hidden=false;renderPreview();
  $("previewBar").scrollIntoView({block:"nearest",behavior:"smooth"});
}
function renderPreview(){
  if(!preview){$("previewBar").hidden=true;renderBoard();return;}
  const m=preview.moves[preview.step-1];
  $("pvTitle").textContent=preview.title;
  $("pvStep").textContent=`Move ${preview.step} of ${preview.moves.length}: ${m?describe(m):"start"}`;
  $("pvPrev").disabled=preview.step<=0;$("pvNext").disabled=preview.step>=preview.moves.length;
  renderBoard();
}
$("pvPrev").onclick=()=>{if(preview&&preview.step>0){preview.step--;renderPreview();}};
$("pvNext").onclick=()=>{if(preview&&preview.step<preview.moves.length){preview.step++;renderPreview();}};
$("pvExit").onclick=()=>{preview=null;renderPreview();};

/* ---------- Controls ---------- */
let startFen=START;
function retry(){
  if(busy)return;
  game.undo();records.pop();paused=false;arrows=[];coach.assisted=true;
  current=records.slice().reverse().find(r=>r.grade)||null;
  pre=lastPre;renderBoard();renderFeedback();renderMoves();setStatus("Your move","on");
  if(mode==="play"){const lr=records[records.length-1];coachTurn(lr&&lr.bot?lr:null);}
  if(aborts.move)aborts.move.abort();
}
function takeBack(){
  if(busy||preview)return;
  if(paused){retry();return;}
  if(!records.length)return;
  if(mode==="play")coach.assisted=true;
  if(mode==="free"){records.pop();game.undo();}
  else{
    while(records.length){const r=records.pop();game.undo();if(!r.bot)break;}
    while(records.length&&game.turn()!==playerColor){records.pop();game.undo();}
    if(game.turn()!==playerColor){botMove();return;}
  }
  arrows=[];hintSq=null;selected=null;
  current=records.slice().reverse().find(r=>r.grade)||null;
  renderBoard();renderFeedback();renderMoves();analyzeCurrent();
}
async function hint(){
  if(!canMove())return;
  const a=await pre;if(a.fen!==game.fen())return;
  if(mode!=="play"){hintSq=a.lines[0].pv[0].slice(0,2);renderBoard();return;}
  const fen=a.fen;const bm=pvMoves(fen,a.lines[0].pv,1)[0];if(!bm)return;
  coach.hint=Math.min(3,(coach.hint||0)+1);coach.assisted=true;
  if(coach.hint===1)coach.hintLines=[ideaHint(fen,a,bm)];
  if(coach.hint===2){hintSq=bm.from;coach.hintLines.push(`Move your ${NAME[bm.piece]} on ${bm.from}.`);}
  if(coach.hint===3){
    let t=describe(bm)+".";
    const b=coach.bookNext;if(b&&b.color===playerColor&&b.san!==bm.san)t+=` (Your lesson plays ${describe(b).toLowerCase()} here, which is also fine.)`;
    coach.hintLines.push(t);arrows=[{from:bm.from,to:bm.to,color:"--g-best"}];
  }
  $("btnHint").textContent=coach.hint===1?"Bigger hint":coach.hint===2?"Show the move":"Hint";
  renderBoard();renderCoach();
}
function resetUI(){
  records=[];current=null;paused=false;selected=null;hintSq=null;arrows=[];preview=null;now=null;resetCoach();
  Object.values(aborts).forEach(a=>a.abort());
  $("previewBar").hidden=true;
}
function loadPosition(fen){
  startFen=fen;game.load(fen);resetUI();
  renderBoard();renderFeedback();renderNow();renderMoves();renderReview();renderCoach();
  if(game.game_over()){endGame();return;}
  if(mode==="play"&&game.turn()!==playerColor)Engine.ready.then(botMove);else analyzeCurrent();
}
function newGame(){
  if(busy){setStatus("Wait for the engine to finish","busy");return;}

  if(mode==="play"){playerColor=$("selColor").value;orient=playerColor;}
  loadPosition(START);
}
function playFromHere(){
  if(busy)return;
  playerColor=game.turn();orient=playerColor;$("selColor").value=playerColor;
  setMode("play",true);
  now=null;arrows=[];renderNow();renderBoard();renderFeedback();
  setStatus("Your move","on");
  if(pre)coachTurn(null);
}
$("btnNew").onclick=newGame;
$("btnBack").onclick=takeBack;
$("btnHint").onclick=hint;
$("btnFlip").onclick=()=>{orient=orient==="w"?"b":"w";renderBoard();};
$("selLevel").onchange=()=>{saveSettings();renderCoach();};
$("selColor").onchange=saveSettings;$("chkPause").onchange=saveSettings;$("selTalk").onchange=()=>{saveSettings();renderCoach();};
$("selStyle").onchange=()=>{saveSettings();if($("selStyle").value==="maia")Maia.start().catch(()=>{});maiaNote();renderCoach();};

/* ---------- Modes ---------- */
function setMode(m,keepPosition){
  if(busy&&m!==mode){setStatus("Wait for the engine to finish","busy");return;}
  const prev=mode;mode=m;
  $("tabLearn").setAttribute("aria-selected",m==="learn");$("tabExplore").setAttribute("aria-selected",m==="explore");
  $("tabPlay").setAttribute("aria-selected",m==="play");$("tabFree").setAttribute("aria-selected",m==="free");$("tabSetup").setAttribute("aria-selected",m==="setup");
  $("palette").hidden=m!=="setup";$("setupCard").hidden=m!=="setup";
  $("gameControls").hidden=m==="setup";$("gameCard").hidden=m==="setup";
  $("btnHint").hidden=m!=="play";
  const L=m==="learn",X=m==="explore";
  $("learnCard").hidden=!L;$("learnControls").hidden=!L;$("settingsCard").hidden=L||X;$("evalBar").hidden=L;$("evalRow").hidden=L;
  $("exploreCard").hidden=!X;$("exploreControls").hidden=!X;
  if(L||X){$("feedback").hidden=true;$("gameControls").hidden=true;$("gameCard").hidden=true;$("nowCard").hidden=true;}
  renderCoach();renderReview();
  if(m==="play"&&$("selStyle").value==="maia")Maia.start().catch(()=>{});
  try{localStorage.setItem("mbm-tab",m);}catch(e){}
  $("btnNew").textContent=m==="free"?"Reset board":"New game";
  preview=null;$("previewBar").hidden=true;paused=false;selected=null;hintSq=null;
  if(m==="setup"){enterSetup();return;}
  if(m==="learn"){enterLearn();return;}
  if(m==="explore"){enterExplore();return;}
  if(prev==="explore"&&!keepPosition){renderBoard();renderFeedback();renderNow();renderMoves();if(!game.game_over())analyzeCurrent();return;}
  if(prev==="learn"&&!keepPosition){orient=mode==="play"?playerColor:orient;renderBoard();renderFeedback();renderNow();renderMoves();if(!game.game_over())analyzeCurrent();return;}
  if(keepPosition){renderBoard();renderFeedback();renderMoves();return;}
  if(m==="free"&&prev!=="setup"){
    // keep the current game, just stop the bot
    renderBoard();renderFeedback();renderMoves();
    if(!game.game_over())analyzeCurrent();
    return;
  }
  if(m==="play"&&prev==="free"){
    playerColor=game.turn();orient=playerColor;$("selColor").value=playerColor;
    now=null;renderNow();renderBoard();renderFeedback();renderMoves();
    if(!game.game_over())analyzeCurrent();
    return;
  }
  renderBoard();renderFeedback();renderNow();renderMoves();
}
$("tabLearn").onclick=()=>{if(mode!=="learn")setMode("learn");};
$("tabExplore").onclick=()=>{if(mode!=="explore")setMode("explore");};
$("tabPlay").onclick=()=>{if(mode!=="play")setMode("play");};
$("tabFree").onclick=()=>{if(mode!=="free")setMode("free");};
$("tabSetup").onclick=()=>{if(mode!=="setup")setMode("setup");};

/* ---------- Setup editor ---------- */
function mapFromFen(fen){const g=new Chess(fen);const m={};for(const f of "abcdefgh")for(let r=1;r<=8;r++){const p=g.get(f+r);if(p)m[f+r]=p;}return m;}
function enterSetup(){
  setup.map=mapFromFen(game.fen());setup.turn=game.turn();$("setupTurn").value=setup.turn;$("fenInput").value="";$("setupErr").hidden=true;
  renderPalette();renderBoard();renderFeedback();renderNow();
}
function renderPalette(){
  const el=$("palette");let h="";
  for(const c of ["w","b"])for(const t of ["k","q","r","b","n","p"]){
    const on=setup.pick&&setup.pick.type===t&&setup.pick.color===c;
    h+=`<button data-t="${t}" data-c="${c}" aria-pressed="${on}" aria-label="${c==="w"?"White":"Black"} ${NAME[t]}"><span class="pc ${c} pt-${t}"></span></button>`;
    if(c==="w"&&t==="p")h+=`<span></span>`;
  }
  h+=`<button class="erase" data-t="x" aria-pressed="${!setup.pick}">Erase</button>`;
  el.innerHTML=h;
  el.querySelectorAll("button").forEach(b=>b.onclick=()=>{setup.pick=b.dataset.t==="x"?null:{type:b.dataset.t,color:b.dataset.c};renderPalette();});
}
function setupTap(sq){
  const cur=setup.map[sq],pk=setup.pick;
  if(!pk||(cur&&cur.type===pk.type&&cur.color===pk.color))delete setup.map[sq];
  else{
    if(pk.type==="k")for(const s in setup.map){const p=setup.map[s];if(p.type==="k"&&p.color===pk.color)delete setup.map[s];}
    setup.map[sq]={type:pk.type,color:pk.color};
  }
  $("setupErr").hidden=true;renderBoard();
}
function fenFromSetup(){
  let rows=[];
  for(let r=8;r>=1;r--){let row="",e=0;for(const f of "abcdefgh"){const p=setup.map[f+r];if(!p){e++;continue;}if(e){row+=e;e=0;}row+=p.color==="w"?p.type.toUpperCase():p.type;}if(e)row+=e;rows.push(row);}
  const at=(s,t,c)=>{const p=setup.map[s];return p&&p.type===t&&p.color===c;};
  let cs="";
  if(at("e1","k","w")){if(at("h1","r","w"))cs+="K";if(at("a1","r","w"))cs+="Q";}
  if(at("e8","k","b")){if(at("h8","r","b"))cs+="k";if(at("a8","r","b"))cs+="q";}
  return `${rows.join("/")} ${setup.turn} ${cs||"-"} - 0 1`;
}
function validateSetup(fen){
  const pcs=Object.entries(setup.map);
  const kings=c=>pcs.filter(([,p])=>p.type==="k"&&p.color===c).length;
  if(kings("w")!==1||kings("b")!==1)return "Each side needs exactly one king.";
  if(pcs.some(([s,p])=>p.type==="p"&&(s[1]==="1"||s[1]==="8")))return "Pawns can't stand on the first or last rank.";
  const v=new Chess().validate_fen(fen);if(!v.valid)return "That position isn't valid: "+v.error;
  const parts=fen.split(" ");parts[1]=parts[1]==="w"?"b":"w";
  const g=new Chess();if(g.load(parts.join(" "))&&g.in_check())return `The side not to move is in check, so it can't be ${setup.turn==="w"?"White":"Black"}'s turn.`;
  return null;
}
function finishSetup(target){
  const fen=fenFromSetup();const err=validateSetup(fen);
  if(err){$("setupErr").textContent=err;$("setupErr").hidden=false;return;}
  if(target==="play"){playerColor=setup.turn;orient=playerColor;$("selColor").value=playerColor;}
  setMode(target,true);
  loadPosition(fen);
}
$("setupTurn").onchange=()=>{setup.turn=$("setupTurn").value;};
$("setupStart").onclick=()=>{setup.map=mapFromFen(START);setup.turn="w";$("setupTurn").value="w";renderBoard();};
$("setupClear").onclick=()=>{setup.map={};renderBoard();};
$("setupFlip").onclick=()=>{orient=orient==="w"?"b":"w";renderBoard();};
$("fenLoad").onclick=()=>{
  const f=$("fenInput").value.trim();const g=new Chess();
  if(!f||!g.load(f)){$("setupErr").textContent="That FEN couldn't be read. It should look like: rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1";$("setupErr").hidden=false;return;}
  setup.map=mapFromFen(f);setup.turn=g.turn();$("setupTurn").value=setup.turn;$("setupErr").hidden=true;renderBoard();
};
$("setupDone").onclick=()=>finishSetup("free");
$("setupPlay").onclick=()=>finishSetup("play");

/* ---------- Learn openings ---------- */
const LESSONS=window.LESSONS||[],CHAPTERS=window.CHAPTERS||[];
const byId={};LESSONS.forEach(l=>byId[l.id]=l);
const cleanSan=s=>s.replace(/[?!]+$/,"");
const endCache={};
function lessonStart(l){return l.from&&byId[l.from]?lessonEnd(byId[l.from]):START;}
function lessonEnd(l){if(endCache[l.id])return endCache[l.id];const g=new Chess(lessonStart(l));(l.moves||[]).forEach(([s])=>g.move(cleanSan(s)));return endCache[l.id]=g.fen();}
function buildMoves(l){
  const g=new Chess(lessonStart(l));const out=[];
  for(const [s,note] of (l.moves||[])){const m=g.move(cleanSan(s));if(!m)break;out.push(Object.assign({},m,{note:note||"",mark:(s.match(/[?!]+$/)||[""])[0]}));}
  return out;
}
let learn=null,learnProg={};
try{learnProg=JSON.parse(localStorage.getItem("mbm-learn")||"{}")||{};}catch(e){}
function saveProg(){try{localStorage.setItem("mbm-learn",JSON.stringify(learnProg));}catch(e){}}
function isDone(id){const p=learnProg[id];const l=byId[id];if(!p||!l)return false;return l.kind==="text"&&!(l.moves&&l.moves.length)?!!p.read:(p.clean||0)>=1;}

function learnGame(){const g=new Chess(learn.base);for(const m of learn.moves.slice(0,learn.step))g.move(m.san);return g;}
function learnMyTurn(){return !!(learn&&learn.drill&&!learn.timer&&learn.step<learn.moves.length&&learnGame().turn()===learn.l.side);}
function learnView(){
  if(!learn)return {get:()=>null,last:null,live:false,g:null};
  const g=learnGame();const last=learn.step?learn.moves[learn.step-1]:null;
  return {get:sq=>g.get(sq),last,live:learnMyTurn(),g};
}
function learnArrows(){
  if(!learn)return [];
  const nx=learn.moves[learn.step];if(!nx)return [];
  if(learn.drill)return learn.hint?[{from:nx.from,to:nx.to,color:"--g-best"}]:[];
  return learn.showNext?[{from:nx.from,to:nx.to,color:"--accent",dash:true}]:[];
}
function clearLearnTimer(){if(learn&&learn.timer){clearTimeout(learn.timer);learn.timer=null;}}
function openLesson(id,opts={}){
  clearLearnTimer();
  const l=byId[id]||LESSONS[0];if(!l)return;
  const drill=opts.drill!=null?opts.drill:(learn?learn.drill:false);
  const hasMoves=!!(l.moves&&l.moves.length);
  learn={l,base:lessonStart(l),moves:buildMoves(l),step:0,drill:drill&&hasMoves,msg:null,wrongs:0,errors:0,hint:false,timer:null,showNext:learn?learn.showNext:true,finished:false};
  selected=null;orient=l.side;
  try{localStorage.setItem("mbm-lesson",l.id);}catch(e){}
  if(l.kind==="text"&&!hasMoves){learnProg[l.id]=Object.assign({},learnProg[l.id],{read:true});saveProg();}
  if(learn.drill)startDrill();
  renderLearn();
}
function startDrill(){
  clearLearnTimer();
  Object.assign(learn,{step:0,msg:null,wrongs:0,errors:0,hint:false,finished:false});selected=null;
  queueReply();
}
function queueReply(){
  if(!learn||!learn.drill)return;
  if(learn.step>=learn.moves.length){finishDrill();return;}
  if(learnGame().turn()===learn.l.side)return;
  const L=learn;
  L.timer=setTimeout(()=>{if(learn!==L)return;L.timer=null;L.step++;renderLearn();queueReply();},learn.step===0?500:650);
}
function finishDrill(){
  if(learn.finished)return;learn.finished=true;
  const p=Object.assign({runs:0,clean:0},learnProg[learn.l.id]);p.runs++;if(!learn.errors)p.clean++;
  learnProg[learn.l.id]=p;saveProg();
  learn.msg={ok:!learn.errors,text:learn.errors?`Line finished with ${learn.errors} wrong ${learn.errors===1?"try":"tries"}. Run it again until it's clean.`:`Clean run. You've played this line perfectly ${p.clean} time${p.clean===1?"":"s"}.`};
  renderLearn();
}
function learnTap(sq){
  if(!learnMyTurn())return;
  const g=learnGame();const p=g.get(sq);
  if(selected){const mv=g.moves({square:selected,verbose:true}).find(m=>m.to===sq);if(mv){const from=selected;selected=null;learnTry(from,sq);return;}}
  selected=(p&&p.color===g.turn()&&sq!==selected)?sq:null;
  renderBoard();
}
function learnTry(from,to){
  const exp=learn.moves[learn.step];
  if(exp.from===from&&exp.to===to){
    learn.step++;learn.msg={ok:true,text:learn.wrongs?"That's it.":"Correct."};learn.wrongs=0;learn.hint=false;
    renderLearn();queueReply();return;
  }
  const g=learnGame();const tried=g.move({from,to,promotion:"q"});
  learn.wrongs++;learn.errors++;
  if(learn.wrongs>=3){
    learn.msg={ok:false,text:`${tried?describe(tried):"That move"} isn't the line move. The answer was: ${describe(exp)}.`};
    learn.step++;learn.wrongs=0;learn.hint=false;renderLearn();queueReply();return;
  }
  learn.hint=learn.wrongs>=2;
  learn.msg={ok:false,text:`${tried?describe(tried):"That move"} isn't the line move. `+(learn.hint?"The green arrow shows the right one.":"Try again.")};
  renderLearn();
}
function learnStep(n){
  if(!learn||learn.drill)return;
  learn.step=Math.max(0,Math.min(learn.moves.length,n));selected=null;renderLearn();
  const list=document.querySelector(".mlist"),cur=document.querySelector('.mlist button[aria-current="true"]');
  if(list&&cur)list.scrollTop=Math.max(0,cur.parentElement.offsetTop-list.clientHeight/2);
}
function markTag(mark){
  if(!mark)return "";
  if(mark.includes("??"))return `<span class="mark blunder">Blunder</span>`;
  if(mark==="?")return `<span class="mark blunder">Mistake</span>`;
  if(mark==="?!")return `<span class="mark dubious">Dubious</span>`;
  if(mark==="!?")return `<span class="mark dubious">Tricky</span>`;
  return `<span class="mark strong">Strong move</span>`;
}
function plyLabel(i){
  const parts=learn.base.split(" ");const startNo=+parts[5];const whiteFirst=parts[1]==="w";
  const ply=i+(whiteFirst?0:1);const no=startNo+Math.floor(ply/2);
  return ply%2===0?no+".":no+"…";
}
function bodyHTML(lines){
  let h="",inList=false;
  for(const t of lines){
    if(t.startsWith("- ")){if(!inList){h+="<ul>";inList=true;}h+=`<li>${esc(t.slice(2))}</li>`;continue;}
    if(inList){h+="</ul>";inList=false;}
    h+=t.startsWith("## ")?`<h3>${esc(t.slice(3))}</h3>`:`<p>${esc(t)}</p>`;
  }
  if(inList)h+="</ul>";
  return `<div class="lbody">${h}</div>`;
}
function renderLessonSelect(){
  const sel=$("lessonSel");let h="";
  for(const c of CHAPTERS){
    const ls=LESSONS.filter(l=>l.ch===c.id);if(!ls.length)continue;
    const done=ls.filter(l=>isDone(l.id)).length;
    h+=`<optgroup label="${esc(c.title)} (${done}/${ls.length})">`;
    for(const l of ls)h+=`<option value="${l.id}"${learn&&learn.l.id===l.id?" selected":""}>${isDone(l.id)?"✓ ":""}${esc(l.title)}</option>`;
    h+=`</optgroup>`;
  }
  sel.innerHTML=h;
}
function renderLearn(){
  if(mode!=="learn"||!learn)return;
  renderLessonSelect();
  const l=learn.l,ms=learn.moves,n=ms.length,step=learn.step;
  const ch=CHAPTERS.find(c=>c.id===l.ch);
  const prog=learnProg[l.id]||{};
  const sideName=l.side==="w"?"White":"Black";
  let h=`<div class="lhead"><span class="eyebrow">${esc(ch?ch.title:"")}</span><h2 class="ltitle">${esc(l.title)}</h2>
    <div class="lmeta"><span class="pill side-${l.side}">You play ${sideName}</span>${n?`<span>${n} moves</span>`:""}${prog.clean?`<span class="pill done">Clean runs: ${prog.clean}</span>`:(isDone(l.id)?`<span class="pill done">Read</span>`:"")}</div></div>`;
  if(n)h+=`<div class="seg" role="group" aria-label="Lesson mode"><button id="lnStudy" aria-pressed="${!learn.drill}">Study</button><button id="lnDrill" aria-pressed="${learn.drill}">Drill from memory</button></div>`;
  h+=`<p class="lintro">${esc(l.intro||"")}</p>`;
  if(l.body&&!n)h+=bodyHTML(l.body);
  if(n){
    h+=`<div class="progress" aria-hidden="true"><i style="width:${(step/n*100).toFixed(1)}%"></i></div>`;
    if(learn.drill){
      let nh;
      if(step>=n)nh="Line complete";
      else if(learnMyTurn())nh=`Your move: play ${sideName}'s move ${plyLabel(step)}`;
      else nh="Opponent is moving…";
      h+=`<div class="note${learn.msg?(learn.msg.ok?" ok":" bad"):""}"><div class="nh">${esc(nh)}</div>`;
      if(learn.msg)h+=`<p>${esc(learn.msg.text)}</p>`;
      const last=ms[step-1];
      if(last&&last.color!==l.side&&step<n)h+=`<p class="muted">They played: ${esc(describe(last))}.</p>`;
      if(step<n&&learnMyTurn())h+=`<p class="muted">Tap a piece, then its square. Two wrong tries shows an arrow; three gives the answer.</p>`;
      if(step>=n)h+=`<div class="row"><button class="btn primary small" id="lnAgain">Drill again</button><button class="btn small" id="lnToStudy">Review in Study</button></div>`;
      h+=`</div>`;
    }else if(step===0){
      h+=`<div class="note"><div class="nh">Starting position${l.from?" (end of an earlier lesson)":""}</div><p>Press <b>Next</b> or the right arrow key to play through the line. The dashed arrow shows the next move.</p></div>`;
    }else{
      const m=ms[step-1];
      h+=`<div class="note"><div class="nh">Move ${plyLabel(step-1)} ${m.color==="w"?"White":"Black"}${m.color===l.side?" (you)":""} ${markTag(m.mark)}</div>
        <div class="nd">${esc(describe(m))}<span class="san">${esc(m.san)}${esc(m.mark)}</span></div>${m.note?`<p>${esc(m.note)}</p>`:""}</div>`;
    }
    if((step>=n||learn.drill&&learn.finished)&&l.after)h+=`<div class="plan"><b>After the line</b><p>${esc(l.after)}</p></div>`;
    if(!learn.drill)h+=`<label class="row muted" for="lnShowNext" style="font-size:.85rem"><input type="checkbox" id="lnShowNext"${learn.showNext?" checked":""}> Show the next move as an arrow</label>`;
    h+=`<ol class="mlist" aria-label="Moves">${ms.map((m,i)=>{
      if(learn.drill&&i>step)return "";
      const hide=learn.drill&&i>=step;
      return `<li class="${m.color===l.side?"":"them"}${hide?" hidden":""}"><button data-ply="${i+1}" ${i+1===step?'aria-current="true"':""}${learn.drill?" tabindex=\"-1\"":""}><span class="no">${plyLabel(i)}</span><span>${hide?"·····":esc(describe(m))}</span><span class="s">${hide?"":esc(m.san)}</span></button></li>`;}).join("")}</ol>`;
    if(l.body)h+=`<div class="eyebrow" style="margin-top:6px">The lesson</div>`+bodyHTML(l.body);
  }else if(l.after){h+=`<div class="plan"><b>Next step</b><p>${esc(l.after)}</p></div>`;}
  $("learnBody").innerHTML=h;
  const b=x=>$(x);
  if(b("lnStudy"))b("lnStudy").onclick=()=>{if(learn.drill){clearLearnTimer();learn.drill=false;learn.step=0;learn.msg=null;learn.hint=false;renderLearn();}};
  if(b("lnDrill"))b("lnDrill").onclick=()=>{if(!learn.drill){learn.drill=true;startDrill();renderLearn();}};
  if(b("lnAgain"))b("lnAgain").onclick=()=>{startDrill();renderLearn();};
  if(b("lnToStudy"))b("lnToStudy").onclick=()=>{learn.drill=false;learn.step=0;learn.msg=null;renderLearn();};
  if(b("lnShowNext"))b("lnShowNext").onchange=e=>{learn.showNext=e.target.checked;renderBoard();};
  $("learnBody").querySelectorAll("[data-ply]").forEach(x=>x.onclick=()=>learnStep(+x.dataset.ply));
  // board controls
  $("lnPrev").disabled=learn.drill||step<=0;$("lnNext").disabled=learn.drill||step>=n;
  $("lnPrev").hidden=$("lnNext").hidden=!n;
  const i=LESSONS.indexOf(l);$("lessonPrev").disabled=i<=0;$("lessonNext").disabled=i>=LESSONS.length-1;
  setStatus(learn.drill?"Drill mode":"Study mode","on");
  renderBoard();
}
function enterLearn(){
  if(!learn){let id=null;try{id=localStorage.getItem("mbm-lesson");}catch(e){}openLesson(byId[id]?id:LESSONS[0].id,{drill:false});}
  else{orient=learn.l.side;renderLearn();}
}
function learnFen(){return learnGame().fen();}
$("lessonSel").onchange=e=>openLesson(e.target.value);
$("lessonPrev").onclick=()=>{const i=LESSONS.indexOf(learn.l);if(i>0)openLesson(LESSONS[i-1].id);};
$("lessonNext").onclick=()=>{const i=LESSONS.indexOf(learn.l);if(i<LESSONS.length-1)openLesson(LESSONS[i+1].id);};
$("lnPrev").onclick=()=>learnStep(learn.step-1);
$("lnNext").onclick=()=>learnStep(learn.step+1);
$("lnRestart").onclick=()=>{if(learn.drill)startDrill();else learn.step=0;renderLearn();};
$("lnFlip").onclick=()=>{orient=orient==="w"?"b":"w";renderBoard();};
$("lnPlay").onclick=()=>{
  if(busy)return;const g=learnGame();if(g.game_over())return;
  clearLearnTimer();const fen=g.fen();
  playerColor=learn.l.side;orient=playerColor;$("selColor").value=playerColor;
  setMode("play",true);loadPosition(fen);
};
$("lnFree").onclick=()=>{
  if(busy)return;const g=learnGame();if(g.game_over())return;
  clearLearnTimer();const fen=g.fen();orient=learn.l.side;
  setMode("free",true);loadPosition(fen);
};
document.addEventListener("keydown",e=>{
  if(mode!=="learn"||!learn||learn.drill)return;
  const t=e.target;if(t&&(t.tagName==="SELECT"||t.tagName==="INPUT"||t.tagName==="TEXTAREA"))return;
  if(e.key==="ArrowRight"){e.preventDefault();learnStep(learn.step+1);}
  else if(e.key==="ArrowLeft"){e.preventDefault();learnStep(learn.step-1);}
});

/* ---------- Explore ---------- */
const ex={start:START,moves:[],ply:0,tok:0,timer:null,cur:null,prev:null,exp:new Map(),chat:[]};
const exCache=new Map();
function epd(fen){return fen.split(" ").slice(0,4).join(" ");}
function exGameAt(ply){const g=new Chess(ex.start);for(const m of ex.moves.slice(0,ply))g.move(m.san);return g;}
function exGame(){return exGameAt(ex.ply);}
function exploreView(){const g=exGame();const last=ex.ply?ex.moves[ex.ply-1]:null;return {get:sq=>g.get(sq),last,live:!g.game_over(),g};}
function exploreArrows(){
  if(!$("exArrow").checked||!ex.cur||ex.cur.fen!==exGame().fen())return [];
  const out=[];const cols=["--accent","--g-good","--muted"];
  ex.cur.lines.slice(0,3).forEach((l,i)=>{if(l.pv&&l.pv[0])out.push({from:l.pv[0].slice(0,2),to:l.pv[0].slice(2,4),color:cols[i],dash:i>0});});
  if(ex.hover)return [{from:ex.hover.slice(0,2),to:ex.hover.slice(2,4),color:"--accent"}];
  return out.reverse();
}
function exploreTap(sq){
  const g=exGame();if(g.game_over())return;
  const p=g.get(sq);
  if(selected){const mv=g.moves({square:selected,verbose:true}).find(m=>m.to===sq);if(mv){selected=null;exPlay(mv.san);return;}}
  selected=(p&&p.color===g.turn()&&sq!==selected)?sq:null;renderBoard();
}
function exPlay(san){
  const g=exGame();const m=g.move(san);if(!m)return;
  const nx=ex.moves[ex.ply];
  if(nx&&nx.san===m.san){ex.ply++;}else{ex.moves=ex.moves.slice(0,ex.ply).concat(m);ex.ply++;}
  exUpdate();
}
function exGo(ply){ex.ply=Math.max(0,Math.min(ex.moves.length,ply));exUpdate();}
function exAnalyze(fen){
  if(exCache.has(fen))return exCache.get(fen);
  const p=Engine.search(fen,{multipv:5,depth:16,mt:1200}).then(r=>({fen,...r}));
  exCache.set(fen,p);if(exCache.size>400)exCache.delete(exCache.keys().next().value);
  return p;
}
function exUpdate(){
  selected=null;ex.hover=null;ex.cur=null;ex.prev=null;ex.chat=[];
  renderBoard();renderExplore();
  clearTimeout(ex.timer);const tok=++ex.tok;
  ex.timer=setTimeout(async()=>{
    const g=exGame();
    if(g.game_over()){setStatus(g.in_checkmate()?"Checkmate":"Draw","on");setEval(g.in_checkmate()?(g.turn()==="w"?{mate:-1}:{mate:1}):{cp:0});
      if(ex.ply>0){ex.prev=await exAnalyze(exGameAt(ex.ply-1).fen());if(tok!==ex.tok)return;}renderExplore();exMaybeExplain();return;}
    const fen=g.fen();await Engine.ready;
    setStatus("Analyzing…","busy");
    const cur=await exAnalyze(fen);if(tok!==ex.tok||mode!=="explore")return;
    ex.cur=cur;setEval(whitePOV(cur.lines[0].score,g.turn()));
    if(ex.ply>0){ex.prev=await exAnalyze(exGameAt(ex.ply-1).fen());if(tok!==ex.tok||mode!=="explore")return;}
    setStatus("Explore","on");renderBoard();renderExplore();exMaybeExplain();
  },180);
  try{localStorage.setItem("mbm-explore",JSON.stringify({start:ex.start,sans:ex.moves.map(m=>m.san),ply:ex.ply}));}catch(e){}
}
function enterExplore(){
  if(!ex.loaded){ex.loaded=true;try{const s=JSON.parse(localStorage.getItem("mbm-explore")||"null");if(s&&s.sans){const g=new Chess(s.start||START);const ms=[];for(const san of s.sans){const m=g.move(san);if(!m)break;ms.push(m);}ex.start=s.start||START;ex.moves=ms;ex.ply=Math.min(s.ply||0,ms.length);}}catch(e){}
    try{const a=localStorage.getItem("mbm-exauto");if(a)$("exAuto").value=a;}catch(e){}}
  setStatus("Explore","on");exUpdate();
}

/* --- Opening names --- */
function openingAt(fen){const o=window.OPENINGS&&window.OPENINGS[epd(fen)];return o?{eco:o[0],name:o[1]}:null;}
function exOpening(){
  for(let p=ex.ply;p>=0;p--){const o=openingAt(exGameAt(p).fen());if(o)return {...o,ply:p};}
  return null;
}
function bookChildren(g){
  const out=[];
  for(const m of g.moves({verbose:true})){g.move(m.san);const o=openingAt(g.fen());g.undo();if(o)out.push({m,o});}
  return out;
}

/* --- Board geometry and attack maps (code-checked facts) --- */
const FILES="abcdefgh";
function sqName(f,r){return FILES[f]+(r+1);}
function attacksFrom(g,sq,p){
  const f=FILES.indexOf(sq[0]),r=+sq[1]-1,out=[];
  const add=(df,dr)=>{const x=f+df,y=r+dr;if(x>=0&&x<8&&y>=0&&y<8)out.push(sqName(x,y));};
  const ray=(df,dr)=>{let x=f+df,y=r+dr;while(x>=0&&x<8&&y>=0&&y<8){const s=sqName(x,y);out.push(s);if(g.get(s))break;x+=df;y+=dr;}};
  if(p.type==="p"){const d=p.color==="w"?1:-1;add(-1,d);add(1,d);}
  else if(p.type==="n")[[1,2],[2,1],[-1,2],[-2,1],[1,-2],[2,-1],[-1,-2],[-2,-1]].forEach(([a,b])=>add(a,b));
  else if(p.type==="k")[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([a,b])=>add(a,b));
  else{
    if(p.type!=="b")[[1,0],[-1,0],[0,1],[0,-1]].forEach(([a,b])=>ray(a,b));
    if(p.type!=="r")[[1,1],[1,-1],[-1,1],[-1,-1]].forEach(([a,b])=>ray(a,b));
  }
  return out;
}
function pieces(g){const out=[];for(let r=0;r<8;r++)for(let f=0;f<8;f++){const s=sqName(f,r),p=g.get(s);if(p)out.push({sq:s,...p});}return out;}
function attackMap(g){
  const A={w:{},b:{}};
  for(const p of pieces(g))for(const t of attacksFrom(g,p.sq,p))(A[p.color][t]=A[p.color][t]||[]).push(p);
  return A;
}
const SIDE={w:"White",b:"Black"};
const opp=c=>c==="w"?"b":"w";
function pname(p){return `${SIDE[p.color]}'s ${NAME[p.type]} on ${p.sq}`;}
function loosePieces(g,A){
  const out=[];
  for(const p of pieces(g)){
    if(p.type==="k")continue;
    const att=A[opp(p.color)][p.sq]||[],def=A[p.color][p.sq]||[];
    if(!att.length)continue;
    const minAtt=Math.min(...att.map(a=>a.type==="k"?100:VAL[a.type]));
    if(!def.length)out.push({p,why:`attacked and undefended`});
    else if(minAtt<VAL[p.type])out.push({p,why:`attacked by a cheaper ${NAME[att.find(a=>(a.type==="k"?100:VAL[a.type])===minAtt).type]}`});
    else if(att.length>def.length&&VAL[p.type]>=1)out.push({p,why:`attacked ${att.length}× but defended only ${def.length}×`});
  }
  return out;
}
function pinsIn(g){
  const out=[];
  for(const tgt of pieces(g).filter(p=>p.type==="k"||p.type==="q")){
    const f0=FILES.indexOf(tgt.sq[0]),r0=+tgt.sq[1]-1;
    for(const [df,dr] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]]){
      const diag=df&&dr;let x=f0+df,y=r0+dr,own=null;
      while(x>=0&&x<8&&y>=0&&y<8){
        const s=sqName(x,y),p=g.get(s);
        if(p){
          if(!own){if(p.color===tgt.color){own={sq:s,...p};}else break;}
          else{
            if(p.color!==tgt.color&&(p.type==="q"||(diag&&p.type==="b")||(!diag&&p.type==="r"))&&!(tgt.type==="q"&&p.type==="q")&&VAL[own.type]<VAL[tgt.type]+ (tgt.type==="k"?100:0))
              out.push({pinned:own,by:{sq:s,...p},to:tgt,abs:tgt.type==="k"});
            break;
          }
        }
        x+=df;y+=dr;
      }
    }
  }
  return out;
}
function doubleAttacks(g,A){
  const out=[];
  for(const p of pieces(g)){
    if(p.type==="k")continue;
    const targets=attacksFrom(g,p.sq,p).map(s=>{const t=g.get(s);return t&&t.color!==p.color?{sq:s,...t}:null;}).filter(Boolean)
      .filter(t=>t.type==="k"||VAL[t.type]>VAL[p.type]||!(A[t.color][t.sq]||[]).length);
    if(targets.length>=2)out.push({p,targets});
  }
  return out;
}
function pawnInfo(g,c){
  const files=Array(8).fill(0),oppFiles=[];const mine=[],theirs=[];
  for(const p of pieces(g))if(p.type==="p"){(p.color===c?mine:theirs).push(p);if(p.color===c)files[FILES.indexOf(p.sq[0])]++;}
  const isolated=[],doubled=[],passed=[];
  for(const p of mine){
    const f=FILES.indexOf(p.sq[0]),r=+p.sq[1];
    if(!(files[f-1]||0)&&!(files[f+1]||0))isolated.push(p.sq);
    if(files[f]>1)doubled.push(p.sq);
    const ahead=theirs.filter(t=>Math.abs(FILES.indexOf(t.sq[0])-f)<=1&&(c==="w"?+t.sq[1]>r:+t.sq[1]<r));
    if(!ahead.length)passed.push(p.sq);
  }
  return {files,isolated,doubled:[...new Set(doubled)],passed,count:mine.length};
}
function kingInfo(g,c){
  const k=pieces(g).find(p=>p.type==="k"&&p.color===c);if(!k)return "";
  const f=FILES.indexOf(k.sq[0]),r=+k.sq[1]-1,d=c==="w"?1:-1;let shield=0;
  for(const df of [-1,0,1])for(const dr of [1,2]){const x=f+df,y=r+d*dr;if(x>=0&&x<8&&y>=0&&y<8){const p=g.get(sqName(x,y));if(p&&p.type==="p"&&p.color===c)shield++;}}
  const home=c==="w"?"1":"8";
  const castled=k.sq[1]===home&&(k.sq[0]==="g"||k.sq[0]==="c"||k.sq[0]==="b"||k.sq[0]==="h");
  const rights=g.fen().split(" ")[2];const can=c==="w"?/[KQ]/.test(rights):/[kq]/.test(rights);
  return `${castled?"castled":k.sq==="e"+home?(can?"in the center, can still castle":"in the center, can't castle"):"on "+k.sq}, ${shield} pawn${shield===1?"":"s"} in front`;
}
function devCount(g,c){
  const home=c==="w"?{b1:"n",g1:"n",c1:"b",f1:"b"}:{b8:"n",g8:"n",c8:"b",f8:"b"};
  return 4-Object.entries(home).filter(([s,t])=>{const p=g.get(s);return p&&p.color===c&&p.type===t;}).length;
}
function mobility(g,c){const p=g.fen().split(" ");p[1]=c;p[3]="-";const f=p.join(" ");const t=new Chess();if(!t.validate_fen(f).valid)return null;t.load(f);return t.moves().length;}
function positionFacts(g){
  const A=attackMap(g);const F={};
  const center=["d4","e4","d5","e5"];
  for(const c of ["w","b"]){
    const pi=pawnInfo(g,c);
    const space=Object.keys(A[c]).filter(s=>c==="w"?+s[1]>=5:+s[1]<=4).length;
    F[c]={material:pieces(g).filter(p=>p.color===c).reduce((s,p)=>s+VAL[p.type],0),dev:devCount(g,c),king:kingInfo(g,c),
      center:center.reduce((s,sq)=>s+(A[c][sq]||[]).length+((g.get(sq)||{}).color===c?1:0),0),space,mob:mobility(g,c),pawns:pi};
  }
  const open=[],half={w:[],b:[]};
  for(let f=0;f<8;f++){const w=F.w.pawns.files[f],b=F.b.pawns.files[f];if(!w&&!b)open.push(FILES[f]);else if(!w)half.w.push(FILES[f]);else if(!b)half.b.push(FILES[f]);}
  const turn=g.turn();const legal=g.moves({verbose:true});
  return {F,A,open,half,loose:loosePieces(g,A),pins:pinsIn(g),forks:doubleAttacks(g,A),
    checks:legal.filter(m=>m.san.includes("+")||m.san.includes("#")).map(m=>m.san),captures:legal.filter(m=>m.captured).map(m=>m.san),turn};
}
function moveFacts(g0,m,g1){
  const out=[];const c=m.color,o=opp(c);
  const A0=attackMap(g0),A1=attackMap(g1);
  if(m.flags.includes("k")||m.flags.includes("q"))out.push("Castles: the king steps to safety and a rook comes toward the center.");
  if(m.captured)out.push(`Captures the ${NAME[m.captured]} (${VAL[m.captured]} point${VAL[m.captured]===1?"":"s"}).`);
  if(m.promotion)out.push(`Promotes to a ${NAME[m.promotion]}.`);
  const hits=attacksFrom(g1,m.to,{type:m.promotion||m.piece,color:c}).map(s=>{const t=g1.get(s);return t&&t.color===o?{sq:s,...t}:null;}).filter(Boolean);
  if(hits.length)out.push(`The ${NAME[m.promotion||m.piece]} on ${m.to} now attacks ${hits.map(t=>t.type==="k"?"the king (check)":`the ${NAME[t.type]} on ${t.sq}`).join(", ")}.`);
  const disc=pieces(g1).filter(p=>p.color===o).filter(t=>{const now=(A1[c][t.sq]||[]).filter(a=>a.sq!==m.to),before=(A0[c][t.sq]||[]);return now.length>before.filter(a=>a.sq!==m.from).length&&now.some(a=>!before.some(b=>b.sq===a.sq));});
  if(disc.length)out.push(`Opens a line: ${disc.map(t=>`the ${NAME[t.type]} on ${t.sq}`).join(", ")} ${disc.length>1?"are":"is"} now hit by another piece behind it.`);
  const newDef=pieces(g1).filter(p=>p.color===c&&p.type!=="k"&&p.sq!==m.to).filter(p=>!(A0[c][p.sq]||[]).length&&(A1[c][p.sq]||[]).length);
  if(newDef.length)out.push(`Now defends ${newDef.map(p=>`the ${NAME[p.type]} on ${p.sq}`).join(", ")}.`);
  const center=["d4","e4","d5","e5"].filter(s=>(A1[c][s]||[]).some(a=>a.sq===m.to));
  if(center.length&&m.piece!=="k")out.push(`Controls center square${center.length>1?"s":""} ${center.join(", ")}.`);
  if((m.piece==="n"||m.piece==="b")&&m.from[1]===(c==="w"?"1":"8"))out.push("Develops a minor piece off the back rank.");
  if(m.piece==="q"&&+g0.fen().split(" ")[5]<=6&&!m.captured)out.push("Early queen move: it can become a target for the opponent's minor pieces.");
  if(m.piece==="p"){
    const bishops=pieces(g1).filter(p=>p.color===c&&p.type==="b");
    const gained=bishops.filter(b=>attacksFrom(g1,b.sq,b).length>attacksFrom(g0,b.sq,b).length);
    if(gained.length)out.push(`Opens a diagonal for the bishop on ${gained.map(b=>b.sq).join(" and ")}.`);
    const p0=pawnInfo(g0,c),p1=pawnInfo(g1,c);
    const newIso=p1.isolated.filter(s=>!p0.isolated.includes(s)),newPassed=p1.passed.filter(s=>!p0.passed.includes(s)&&s!==m.from);
    if(newIso.length)out.push(`Leaves an isolated pawn on ${newIso.join(", ")}.`);
    if(newPassed.length)out.push(`Creates a passed pawn on ${newPassed.join(", ")}.`);
    const q0=pawnInfo(g0,o),q1=pawnInfo(g1,o);
    if(q1.doubled.length>q0.doubled.length)out.push("Gives the opponent doubled pawns.");
  }
  const leftLoose=loosePieces(g1,A1).filter(x=>x.p.color===c);
  if(leftLoose.length)out.push(`Leaves loose: ${leftLoose.map(x=>`${NAME[x.p.type]} on ${x.p.sq} (${x.why})`).join("; ")}.`);
  return out;
}
function gradeMove(prev,cur,m,g1){
  if(!prev)return null;
  const uci=m.from+m.to+(m.promotion||"");
  const best=prev.lines[0];let after;
  const same=prev.lines.find(l=>l.pv[0]===uci||l.pv[0]===m.from+m.to);
  if(g1.in_checkmate())after={mate:1};else if(g1.game_over())after={cp:0};
  else if(same)after=same.score;else if(cur)after=flip(cur.lines[0].score);else return null;
  let drop=Math.max(0,winPct(toCp(best.score))-winPct(toCp(after)));
  let grade;const bu=best.pv[0];
  if(bu===uci||bu.slice(0,4)===m.from+m.to)grade="Best";
  else if(drop<2)grade="Excellent";else if(drop<5)grade="Good";else if(drop<10)grade="Inaccuracy";else if(drop<20)grade="Mistake";else grade="Blunder";
  if(grade!=="Best"&&after.mate!==undefined&&after.mate<0&&!(best.score.mate<0))grade="Blunder";
  return {grade,after,best,drop};
}

/* --- Claude deep dive --- */
function hashKey(s){let h1=0x811c9dc5,h2=0x01000193^s.length;for(let i=0;i<s.length;i++){const c=s.charCodeAt(i);h1=Math.imul(h1^c,16777619);h2=Math.imul(h2^c,2246822519)^(h2>>>13);}return ((h1>>>0).toString(16).padStart(8,"0")+(h2>>>0).toString(16).padStart(8,"0"));}
function exKey(){const g0=ex.ply?exGameAt(ex.ply-1):null;const m=ex.ply?ex.moves[ex.ply-1]:null;return "x"+hashKey((g0?epd(g0.fen()):"")+"|"+(m?m.san:"")+"|"+epd(exGame().fen()));}
function exLocalGet(k){try{const c=JSON.parse(localStorage.getItem("mbm-exp")||"{}");return c[k]||null;}catch(e){return null;}}
function exLocalSet(k,t){try{const c=JSON.parse(localStorage.getItem("mbm-exp")||"{}");c[k]=t;const ks=Object.keys(c);if(ks.length>300)delete c[ks[0]];localStorage.setItem("mbm-exp",JSON.stringify(c));}catch(e){}}
async function exCloudGet(k){try{if(!cloudDb||!cloudUid)return null;const s=await cloudDb.doc("data/users/"+cloudUid+"/"+k).get();return s.exists?(s.data()||{}).text||null:null;}catch(e){return null;}}
function exCloudSet(k,t){try{if(cloudDb&&cloudUid)cloudDb.doc("data/users/"+cloudUid+"/"+k).set({text:t,at:Date.now()}).catch(()=>{});}catch(e){}}
function exAutoOn(){
  const a=$("exAuto").value;if(a==="click"||ex.ply===0)return false;
  if(a==="every")return true;
  const g=exGame();const n=+g.fen().split(" ")[5];
  return n<=15||!!openingAt(g.fen());
}
async function exMaybeExplain(){
  const k=exKey();let o=ex.exp.get(k);
  if(!o){
    const t=exLocalGet(k)||await exCloudGet(k);
    if(k!==exKey())return;
    if(t){o={text:t,state:"done",cached:true};ex.exp.set(k,o);exLocalSet(k,t);renderExDeep();return;}
  }
  if(o)return;
  if(exAutoOn()&&sampleFn&&!sampleOff)exExplain();
}
function linesText(a,fen,n){
  const turn=fen.split(" ")[1];
  return a.lines.slice(0,n).map((l,i)=>{const mv=pvMoves(fen,l.pv,5);return mv.length?`${i+1}) ${mv[0].san} = ${describe(mv[0])}. Line: ${numbered(fen,mv.map(x=>x.san))}. ${evalWords(l.score,turn)} (${fmtScore(whitePOV(l.score,turn))} for White)`:"";}).filter(Boolean).join("\n");
}
function factsText(P){
  const s=[];
  for(const c of ["w","b"]){const f=P.F[c];s.push(`${SIDE[c]}: material ${f.material}, developed minors ${f.dev}/4, king ${f.king}, center control ${f.center}, space ${f.space}, mobility ${f.mob??"-"}, isolated pawns ${f.pawns.isolated.join(" ")||"none"}, doubled ${f.pawns.doubled.join(" ")||"none"}, passed ${f.pawns.passed.join(" ")||"none"}.`);}
  s.push(`Open files: ${P.open.join(" ")||"none"}. Half-open for White: ${P.half.w.join(" ")||"none"}; for Black: ${P.half.b.join(" ")||"none"}.`);
  if(P.loose.length)s.push("Loose pieces: "+P.loose.map(x=>`${pname(x.p)} (${x.why})`).join("; ")+".");
  if(P.pins.length)s.push("Pins: "+P.pins.map(x=>`${pname(x.pinned)} pinned by ${pname(x.by)} to the ${NAME[x.to.type]}`).join("; ")+".");
  if(P.forks.length)s.push("Double attacks: "+P.forks.map(x=>`${pname(x.p)} hits ${x.targets.map(t=>NAME[t.type]+" "+t.sq).join(" and ")}`).join("; ")+".");
  return s.join("\n");
}
const EX_RULES=`You are a chess coach writing a dense, opening-explorer-style breakdown for an ambitious beginner who learns fast and wants maximum understanding per minute.
Format exactly with these section labels on their own lines, in this order:
IDEA: 1-2 sentences on why this move exists and what it prepares.
PROS:
- 2-4 bullets
CONS:
- 1-3 bullets (what it gives up, commits to, or weakens)
ALTERNATIVES:
- 2-3 bullets, each "<move in words> (<SAN>): how it changes the game"
PLANS:
- White: ...
- Black: ...
TRAPS: 1-2 sentences on traps, tactics or typical mistakes in this line at club level. If none, say what to watch for.
PATTERN: one reusable principle or pattern, named if it has a name.
Rules: under 260 words. Plain text, no markdown besides "- " bullets. Say moves in words first with SAN in brackets, e.g. "knight to f3 (Nf3)". No raw evaluation numbers; say "slightly better for White" etc.
Use the engine lines and code-checked facts for every concrete claim about tactics or move quality. You may use general opening knowledge (names, history, typical plans), but don't invent concrete lines that contradict the engine.`;
function exPrompt(){
  const g=exGame(),fen=g.fen();const m=ex.ply?ex.moves[ex.ply-1]:null;const g0=ex.ply?exGameAt(ex.ply-1):null;
  const o0=g0?openingAt(g0.fen()):null,o1=openingAt(fen),oc=exOpening();
  const gr=m?gradeMove(ex.prev,ex.cur,m,g):null;
  const kids=bookChildren(new Chess(fen)).slice(0,8);
  let s=`${EX_RULES}\n\nMoves so far: ${ex.ply?numbered(ex.start,ex.moves.slice(0,ex.ply).map(x=>x.san)):"none (starting position)"}`;
  s+=`\nOpening: ${o1?`${o1.eco} ${o1.name}`:oc?`${oc.eco} ${oc.name} (left the named lines ${ex.ply-oc.ply} ply ago)`:"unnamed"}${o0&&o1&&o0.name!==o1.name?` (before this move: ${o0.name})`:""}`;
  if(m){
    s+=`\n\nMove to explain: ${m.san} = ${describe(m)} by ${SIDE[m.color]}.`;
    if(gr)s+=` Engine verdict: ${gr.grade}. Before the move: ${evalWords(gr.best.score,m.color)}. After it: ${evalWords(gr.after,m.color)}.`;
    s+=`\nCode-checked facts about the move:\n- ${moveFacts(g0,m,g).join("\n- ")||"none"}`;
    if(ex.prev)s+=`\n\nEngine's top moves BEFORE this move (the alternatives), for ${SIDE[m.color]}:\n${linesText(ex.prev,g0.fen(),4)}`;
  }else s+=`\n\nExplain the current position and the main ideas for the side to move.`;
  if(ex.cur)s+=`\n\nEngine's top moves NOW for ${SIDE[g.turn()]}:\n${linesText(ex.cur,fen,3)}`;
  if(kids.length)s+=`\nNamed continuations from here: ${kids.map(k=>`${k.m.san} (${k.o.name})`).join("; ")}`;
  s+=`\n\nCode-checked position facts now:\n${factsText(positionFacts(g))}`;
  return s;
}
function exExplain(force){
  if(!sampleFn||sampleOff)return;
  const k=exKey();const o={text:"",state:"thinking"};ex.exp.set(k,o);renderExDeep();
  if(aborts.exp)aborts.exp.abort();
  const ac=new AbortController();aborts.exp=ac;
  sampleFn(exPrompt(),{modelTier:"default",cache:!force,signal:ac.signal,onText:({text})=>{o.text=text;o.state="streaming";if(exKey()===k)renderExDeep(true);}})
    .then(res=>{o.text=res.text;o.state="done";exLocalSet(k,res.text);exCloudSet(k,res.text);})
    .catch(err=>{if(err&&err.code==="not_granted")sampleOff=true;o.state="error";o.err=ac.signal.aborted?"Stopped.":err&&err.code==="rate_limited"?"Too many requests right now. Try again in a minute.":"Couldn't reach Claude for this one.";if(ac.signal.aborted)ex.exp.delete(k);})
    .finally(()=>{if(exKey()===k)renderExDeep();});
}
const EX_SECTIONS=["IDEA","PROS","CONS","ALTERNATIVES","PLANS","TRAPS","PATTERN"];
const EX_LABEL={IDEA:"Idea",PROS:"Pros",CONS:"Cons",ALTERNATIVES:"Alternatives",PLANS:"Plans",TRAPS:"Traps & mistakes",PATTERN:"Pattern to remember"};
function parseDeep(t){
  const re=new RegExp("^\\s*(?:\\*\\*)?("+EX_SECTIONS.join("|")+")(?:\\*\\*)?\\s*:\\s*","gm");
  const parts=[];let m,last=null,idx=0;
  while((m=re.exec(t))){if(last)parts.push({k:last,body:t.slice(idx,m.index).trim()});last=m[1];idx=re.lastIndex;}
  if(last)parts.push({k:last,body:t.slice(idx).trim()});
  return parts.length?parts:[{k:null,body:t.trim()}];
}
function deepBodyHTML(b){
  const lines=b.split("\n").map(x=>x.trim()).filter(Boolean);
  const bul=lines.filter(l=>/^[-•*]\s/.test(l));
  if(bul.length&&bul.length===lines.length)return `<ul>${lines.map(l=>`<li>${esc(l.replace(/^[-•*]\s+/,""))}</li>`).join("")}</ul>`;
  return lines.map(l=>/^[-•*]\s/.test(l)?`<p>• ${esc(l.replace(/^[-•*]\s+/,""))}</p>`:`<p>${esc(l)}</p>`).join("");
}
function renderExDeep(streaming){
  const el=$("exDeep");if(!el)return;
  if(!sampleFn||sampleOff){el.innerHTML="";return;}
  const k=exKey();const o=ex.exp.get(k);let h=`<div class="exsec-h"><span class="lbl">Deep dive</span>`;
  if(o&&o.state==="done")h+=`<button class="linkbtn" id="exRegen">${o.cached?"Saved · regenerate":"Regenerate"}</button>`;
  h+=`</div>`;
  if(!o){
    const ready=ex.ply===0||ex.prev;
    h+=`<div class="row"><button class="btn small primary" id="exExplainBtn" ${ready?"":"disabled"}>${ex.ply?"Explain this move in depth":"Explain this position"}</button>${exAutoOn()&&!ready?`<span class="muted" style="font-size:.84rem">Analyzing first…</span>`:""}</div>`;
  }else if(o.state==="error")h+=`<p class="muted">${esc(o.err)}</p><div class="row"><button class="btn small" id="exExplainBtn">Try again</button></div>`;
  else{
    const parts=parseDeep(o.text||"");
    if(!o.text)h+=`<p class="muted">Thinking…</p>`;
    else h+=`<div class="deep">${parts.map(p=>`<div class="dsec ${p.k?p.k.toLowerCase():""}">${p.k?`<b>${EX_LABEL[p.k]}</b>`:""}${deepBodyHTML(p.body)}</div>`).join("")}</div>`;
  }
  if(o&&o.state==="done"){
    h+=`<form class="ask" id="exAskForm"><input type="text" id="exAskInput" placeholder="Follow-up: e.g. what if Black plays Nf6 instead?" aria-label="Ask a follow-up" autocomplete="off"><button class="btn small" type="submit">Ask</button></form>`;
    h+=`<div class="chat">${ex.chat.slice().reverse().map(c=>`<div class="qa"><div class="q">${esc(c.q)}</div><p class="a${c.state==="error"?" muted":""}" data-exchat="${c.id}">${esc(c.a||"Thinking…")}</p></div>`).join("")}</div>`;
  }
  const keepInput=document.activeElement&&document.activeElement.id==="exAskInput"?$("exAskInput").value:null;
  el.innerHTML=h;
  if(keepInput!==null&&$("exAskInput")){$("exAskInput").value=keepInput;$("exAskInput").focus();}
  const b=$("exExplainBtn");if(b)b.onclick=()=>exExplain(true);
  const r=$("exRegen");if(r)r.onclick=()=>exExplain(true);
  const f=$("exAskForm");if(f)f.onsubmit=e=>{e.preventDefault();const q=$("exAskInput").value.trim();if(q){$("exAskInput").value="";exAsk(q);}};
}
let exAskSeq=0;
async function exAsk(q){
  const g=exGame(),fen=g.fen();const k=exKey();
  const item={q,a:"",state:"thinking",id:"exq"+(++exAskSeq)};ex.chat.push(item);if(ex.chat.length>5)ex.chat.shift();renderExDeep();
  const o=ex.exp.get(k);
  const prior=ex.chat.slice(0,-1).filter(c=>c.state==="done").slice(-2);
  const msgs=[{role:"user",content:exPrompt()},{role:"assistant",content:(o&&o.text)||"(no breakdown yet)"}];
  prior.forEach(c=>{msgs.push({role:"user",content:c.q});msgs.push({role:"assistant",content:c.a});});
  msgs.push({role:"user",content:`Follow-up question about the same position (answer in under 150 words, plain text, moves in words with SAN in brackets; use check_move for any concrete move you discuss): ${q}`});
  let tools=null;try{const L=await sampleFn.limits();if(L&&L.tools)tools=[checkMoveTool(fen,ex.cur)];}catch(e){}
  const ac=new AbortController();aborts[item.id]=ac;
  const onText=({text})=>{item.a=text;item.state="streaming";const p=document.querySelector(`[data-exchat="${item.id}"]`);if(p)p.textContent=text;};
  const run=t=>sampleFn(msgs,Object.assign({modelTier:"default",cache:false,signal:ac.signal,onText},t?{tools:t}:{}));
  try{let res;try{res=await run(tools);}catch(err){if(err&&err.code==="tools_unavailable"&&tools)res=await run(null);else throw err;}item.a=res.text;item.state="done";}
  catch(err){item.state="error";item.a=(err&&err.text?err.text+"\n\n":"")+(err&&err.code==="rate_limited"?"Too many requests right now. Try again in a minute.":"Couldn't reach Claude for this one.");}
  if(exKey()===k)renderExDeep();
}

/* --- Maia "what humans play" for Explore (only once Maia is loaded) --- */
const exMaia=new Map();
function exMaiaPolicy(fen){
  if(Maia.state()!=="ready")return null;
  const k=fen+"|"+Math.round(rating);
  if(exMaia.has(k))return exMaia.get(k)||null;
  exMaia.set(k,null);
  const r=Math.max(600,Math.min(2600,rating));
  Maia.policy(fen,r,r).then(p=>{exMaia.set(k,p);if(mode==="explore"&&exGame().fen()===fen)renderExplore();}).catch(()=>{});
  return null;
}

/* --- Panel --- */
function renderExplore(){
  if(mode!=="explore")return;
  const g=exGame(),fen=g.fen(),turn=g.turn();
  // header: opening + path
  const o=openingAt(fen),oc=o?{...o,ply:ex.ply}:exOpening();
  $("exEco").innerHTML=oc?`<span class="ecopill">${esc(oc.eco)}</span><span class="econame">${esc(oc.name)}</span>${o?"":`<span class="muted exoob">out of named lines since move ${Math.floor(oc.ply/2)+1}</span>`}`
    :`<span class="econame">${ex.ply?"Unnamed position":"Starting position"}</span>`;
  const startNo=+ex.start.split(" ")[5],bStart=ex.start.split(" ")[1]==="b";
  let ph=`<button class="pmv${ex.ply===0?" cur":""}" data-ply="0">Start</button>`;
  ex.moves.forEach((m,i)=>{const idx=i+(bStart?1:0);const no=startNo+Math.floor(idx/2);
    if(idx%2===0)ph+=`<span class="pno">${no}.</span>`;else if(i===0)ph+=`<span class="pno">${no}…</span>`;
    ph+=`<button class="pmv${ex.ply===i+1?" cur":""}${i+1>ex.ply?" fut":""}" data-ply="${i+1}">${esc(m.san)}</button>`;});
  $("exPath").innerHTML=ph;
  $("exPath").querySelectorAll("[data-ply]").forEach(b=>b.onclick=()=>exGo(+b.dataset.ply));
  const cur=$("exPath").querySelector(".cur");if(cur)cur.scrollIntoView({block:"nearest",inline:"nearest"});
  // last move
  let mh="";
  if(ex.ply){
    const m=ex.moves[ex.ply-1],g0=exGameAt(ex.ply-1);
    const gr=gradeMove(ex.prev,ex.cur,m,g);
    const o0=openingAt(g0.fen());
    mh=`<div class="exsec-h"><span class="lbl">Last move</span></div><div class="verdict">${gr?`<span class="chip ${gr.grade}">${gr.grade}</span>`:`<span class="chip">…</span>`}<strong class="mvtitle">${esc(describe(m))}<span class="san">${esc(m.san)}</span></strong></div>`;
    if(o&&(!o0||o0.name!==o.name))mh+=`<p class="enters">Enters <b>${esc(o.name)}</b> (${esc(o.eco)})</p>`;
    if(gr&&gr.grade!=="Best"&&ex.prev){const bm=pvMoves(g0.fen(),ex.prev.lines[0].pv,1)[0];if(bm)mh+=`<p class="muted exbest">Engine preferred: ${esc(describe(bm))} (${esc(bm.san)}). ${esc(evalWords(gr.after,m.color))} after the move played.</p>`;}
    mh+=`<ul class="facts">${moveFacts(g0,m,g).map(x=>`<li>${esc(x)}</li>`).join("")||"<li>A quiet move: no immediate tactical change.</li>"}</ul>`;
  }
  $("exMove").innerHTML=mh;
  renderExDeep();
  // candidate moves table
  let ch=`<div class="exsec-h"><span class="lbl">Moves here · ${SIDE[turn]} to play</span>${Maia.state()==="ready"?`<span class="muted dep">% = players near ${Math.round(rating)} (Maia)</span>`:""}${ex.cur?`<span class="muted dep">depth ${ex.cur.lines[0].depth||"?"}</span>`:""}</div>`;
  if(g.game_over())ch+=`<p class="muted">${g.in_checkmate()?"Checkmate.":"The game is drawn."}</p>`;
  else{
    const rows=new Map();
    if(ex.cur)ex.cur.lines.forEach((l,i)=>{const mv=pvMoves(fen,l.pv,1)[0];if(mv)rows.set(mv.san,{m:mv,rank:i+1,score:l.score,line:pvMoves(fen,l.pv,4).map(x=>x.san)});});
    for(const k of bookChildren(new Chess(fen))){const r=rows.get(k.m.san)||{m:k.m};r.book=k.o;rows.set(k.m.san,r);}
    const mp=exMaiaPolicy(fen);
    if(mp){const gg=new Chess(fen);mp.slice(0,4).forEach(([u,pr])=>{const mv=gg.move(uciObj(u));if(!mv)return;gg.undo();if(pr>=0.05&&!rows.has(mv.san))rows.set(mv.san,{m:mv});});
      for(const r of rows.values()){const hit=mp.find(([u])=>u===r.m.from+r.m.to+(r.m.promotion||""));r.human=hit?hit[1]:0;}}
    const list=[...rows.values()].sort((a,b)=>(a.rank||99)-(b.rank||99)).slice(0,10);
    if(!list.length)ch+=`<p class="muted">Analyzing…</p>`;
    else ch+=`<div class="cands" role="table">${list.map(r=>{
      const sc=r.score?fmtScore(whitePOV(r.score,turn)):"";
      return `<button class="cand" data-san="${esc(r.m.san)}" data-uci="${r.m.from+r.m.to}"><span class="csan">${esc(r.m.san)}</span><span class="cev">${sc||'<span class="muted">book</span>'}${r.human!=null?`<span class="chum" title="How often players around your rating pick this (Maia)">${Math.round(r.human*100)}%</span>`:""}</span><span class="cinfo">${r.book?`<span class="cbook">${esc(r.book.name)}</span>`:""}<span class="cw">${esc(describe(r.m))}${r.line&&r.line.length>1?` · ${esc(r.line.slice(1).join(" "))}`:""}</span></span>${r.rank===1?`<span class="ctag">engine #1</span>`:""}</button>`;}).join("")}</div>`;
  }
  $("exCands").innerHTML=ch;
  $("exCands").querySelectorAll(".cand").forEach(b=>{b.onclick=()=>exPlay(b.dataset.san);b.onmouseenter=b.onfocus=()=>{ex.hover=b.dataset.uci;renderArrows();};b.onmouseleave=b.onblur=()=>{ex.hover=null;renderArrows();};});
  // position facts
  const P=positionFacts(g);
  const row=(label,fn)=>`<span class="pl">${label}</span><span>${fn("w")}</span><span>${fn("b")}</span>`;
  let pf=`<details class="exposd" open><summary class="lbl">Position facts</summary><div class="pgrid"><span></span><span class="ph">White</span><span class="ph">Black</span>`;
  pf+=row("Material",c=>P.F[c].material);
  pf+=row("Developed",c=>P.F[c].dev+"/4 minors");
  pf+=row("King",c=>esc(P.F[c].king));
  pf+=row("Center",c=>P.F[c].center);
  pf+=row("Space",c=>P.F[c].space+" sq");
  pf+=row("Mobility",c=>P.F[c].mob??"-");
  pf+=row("Pawn issues",c=>{const p=P.F[c].pawns;const a=[];if(p.isolated.length)a.push("isolated "+p.isolated.join(" "));if(p.doubled.length)a.push("doubled "+p.doubled.join(" "));return a.join(", ")||"none";});
  pf+=row("Passed pawns",c=>P.F[c].pawns.passed.join(" ")||"none");
  pf+=`</div><ul class="facts">`;
  pf+=`<li><b>Files:</b> open ${P.open.join(" ")||"none"} · half-open for White ${P.half.w.join(" ")||"none"} · for Black ${P.half.b.join(" ")||"none"}</li>`;
  pf+=`<li><b>Loose pieces:</b> ${P.loose.length?esc(P.loose.map(x=>`${pname(x.p)}, ${x.why}`).join("; ")):"none"}</li>`;
  pf+=`<li><b>Pins:</b> ${P.pins.length?esc(P.pins.map(x=>`${pname(x.pinned)} pinned to the ${NAME[x.to.type]} by the ${NAME[x.by.type]} on ${x.by.sq}${x.abs?" (can't legally move off the line)":""}`).join("; ")):"none"}</li>`;
  pf+=`<li><b>Double attacks:</b> ${P.forks.length?esc(P.forks.map(x=>`${pname(x.p)} hits ${x.targets.map(t=>NAME[t.type]+" "+t.sq).join(" and ")}`).join("; ")):"none"}</li>`;
  pf+=`<li><b>${SIDE[turn]} can:</b> ${P.checks.length?`check with ${esc(P.checks.join(", "))}`:"no checks"}; ${P.captures.length?`capture with ${esc(P.captures.join(", "))}`:"no captures"}</li>`;
  pf+=`</ul><p class="muted legend">Center = attacks on and pieces in d4, e4, d5, e5. Space = squares attacked in the opponent's half. Mobility = legal moves if it were that side's turn.</p></details>`;
  $("exPos").innerHTML=pf;
  $("exPrev").disabled=ex.ply<=0;$("exNext").disabled=ex.ply>=ex.moves.length;
}
$("exPrev").onclick=()=>exGo(ex.ply-1);
$("exNext").onclick=()=>exGo(ex.ply+1);
$("exStart").onclick=()=>{ex.start=START;ex.moves=[];ex.ply=0;exUpdate();};
$("exFlip").onclick=()=>{orient=orient==="w"?"b":"w";renderBoard();};
$("exArrow").onchange=()=>renderArrows();
$("exAuto").onchange=()=>{try{localStorage.setItem("mbm-exauto",$("exAuto").value);}catch(e){}renderExDeep();if(exAutoOn())exMaybeExplain();};
$("exLoadGame").onclick=()=>{const h=game.history({verbose:true});if(!h.length){setStatus("No game to load yet","on");return;}ex.start=startFen;ex.moves=h;ex.ply=0;exUpdate();};
$("exPlay").onclick=()=>{const g=exGame();if(g.game_over()||busy)return;const fen=g.fen();playerColor=g.turn();orient=playerColor;$("selColor").value=playerColor;setMode("play",true);loadPosition(fen);};
document.addEventListener("keydown",e=>{
  if(mode!=="explore")return;const t=e.target;if(t&&(t.tagName==="SELECT"||t.tagName==="INPUT"||t.tagName==="TEXTAREA"))return;
  if(e.key==="ArrowRight"){e.preventDefault();exGo(ex.ply+1);}else if(e.key==="ArrowLeft"){e.preventDefault();exGo(ex.ply-1);}
});


/* ---------- Type moves: SAN, lowercase SAN, coordinates, words, or several moves at once ---------- */
const {parseMoves}=window.Notation;
function typeTargetGame(){
  if(mode==="explore")return exGame();
  if(mode==="learn")return learn?learnGame():null;
  if(mode==="play"||mode==="free")return game;
  return null;
}
function mvMsg(t,bad){const el=$("mvMsg");el.textContent=t;el.className="mvmsg"+(bad?" bad":"");el.hidden=!t;}
async function applyTyped(text){
  const g=typeTargetGame();if(!g){mvMsg("Typing moves works in Learn, Explore, Play and Move both sides.",true);return;}
  if(preview){mvMsg("Exit the preview first (Back to game).",true);return;}
  const r=parseMoves(text,g);
  const multi=mode==="explore"||mode==="free";
  if(r.ambig&&!r.moves.length){
    mvMsg("");const el=$("mvAmbig");
    el.innerHTML=`<span class="muted">"${esc(r.tok)}" could mean:</span>`+r.ambig.map(m=>`<button class="btn small" type="button" data-san="${esc(m.san)}">${esc(m.san)} · ${esc(describe(m))}</button>`).join("");
    el.hidden=false;el.querySelectorAll("[data-san]").forEach(b=>b.onclick=()=>{el.hidden=true;applyTyped(b.dataset.san);});
    return;
  }
  $("mvAmbig").hidden=true;
  if(!r.moves.length){mvMsg(r.error||"No move found.",true);return;}
  const list=multi?r.moves:r.moves.slice(0,1);
  if(!multi&&r.moves.length>1)mvMsg("Only one move at a time here; played the first.",false);
  else if(r.error)mvMsg(`Played ${list.map(m=>m.san).join(" ")}. Then: ${r.error}`,true);
  else if(r.ambig)mvMsg(`Played ${list.map(m=>m.san).join(" ")}. "${r.tok}" was ambiguous; type it with the file or rank, e.g. Nbd2.`,true);
  else mvMsg("");
  $("mvInput").value="";$("mvPreview").textContent="";
  if(mode==="explore"){
    for(const m of list){const gg=exGame();const mv=gg.move(m.san);if(!mv)break;const nx=ex.moves[ex.ply];if(nx&&nx.san===mv.san)ex.ply++;else{ex.moves=ex.moves.slice(0,ex.ply).concat(mv);ex.ply++;}}
    exUpdate();return;
  }
  if(mode==="learn"){
    if(!learnMyTurn()){mvMsg(learn&&!learn.drill?"In Study mode use Next. Switch to Drill to type the moves yourself.":"Wait for the reply.",true);return;}
    selected=null;learnTry(list[0].from,list[0].to);return;
  }
  for(const m of list){
    if(!canMove()){if(mode==="play"&&game.turn()!==playerColor)mvMsg("It's the bot's turn.",true);else if(paused)mvMsg("Retry or continue first.",true);break;}
    selected=null;await userMove({from:m.from,to:m.to,promotion:m.promotion||"q"});
  }
}
$("mvForm").addEventListener("submit",e=>{e.preventDefault();const t=$("mvInput").value.trim();if(t)applyTyped(t);});
$("mvInput").addEventListener("input",()=>{const t=$("mvInput").value.trim();const g=typeTargetGame();const el=$("mvPreview");
  if(!t||!g){el.textContent="";return;}
  const r=parseMoves(t,g);
  el.textContent=r.moves.length&&!r.error&&!r.ambig?(r.moves.length===1?`↵ ${r.moves[0].san} · ${describe(r.moves[0])}`:`↵ ${r.moves.length} moves: ${r.moves.map(m=>m.san).join(" ")}`):r.ambig&&!r.moves.length?`↵ ambiguous: ${r.ambig.map(m=>m.san).join(" / ")}`:"";
});
// Start typing anywhere (desktop): letters jump into the move box
document.addEventListener("keydown",e=>{
  if(e.ctrlKey||e.metaKey||e.altKey||e.key.length!==1)return;
  const t=e.target;if(t&&(t.tagName==="INPUT"||t.tagName==="SELECT"||t.tagName==="TEXTAREA"||t.isContentEditable))return;
  if($("mvForm").hidden||!/[a-hkqrnoA-HKQRNO0-9]/.test(e.key))return;
  e.preventDefault();const inp=$("mvInput");inp.focus();inp.value+=e.key;inp.dispatchEvent(new Event("input"));
});
function renderEcho(v){
  const el=$("mvEcho");if(!el)return;
  $("mvForm").hidden=!(mode==="play"||mode==="free"||mode==="explore"||mode==="learn");
  const m=v&&v.last;
  el.innerHTML=m&&m.san?`Last move <b class="mono">${esc(m.san)}</b> <span class="muted">= ${esc(describe(m))}</span>`:`<span class="muted">Type a move: <b class="mono">Nf3</b>, <b class="mono">nf3</b>, <b class="mono">e2e4</b>, "knight to f3", <b class="mono">O-O</b>. Several at once works in Explore and Move both sides.</span>`;
}

maiaNote();
newGame();
if(mode==="play"&&$("selStyle").value==="maia")Maia.start().catch(()=>{});
let savedTab=null;try{savedTab=localStorage.getItem("mbm-tab");}catch(e){}
if(savedTab===null||savedTab==="learn")setMode("learn");
else if(savedTab==="explore")setMode("explore");
})();
