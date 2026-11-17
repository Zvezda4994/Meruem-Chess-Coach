/* Typed-move parser: SAN, lowercase SAN, coordinates ("e2e4", "e2 e4"), words ("knight to f3",
   "bishop takes c3", "castle long") and whole move lists ("1. e4 e5 2. Nf3"). Needs chess.js (global Chess). */
(function(root){
"use strict";
const NAME={p:"pawn",n:"knight",b:"bishop",r:"rook",q:"queen",k:"king"};
const cap=s=>s.charAt(0).toUpperCase()+s.slice(1);
const PIECE_WORD={king:"K",queen:"Q",rook:"R",castle:"R",bishop:"B",knight:"N",horse:"N",pawn:""};
function normInput(t){
  let s=" "+t.replace(/[!?#+]/g," ").replace(/[,;]/g," ")+" ";
  s=s.replace(/\b(castles?|castling)\s+(long|queen\s*side)\b/gi," o-o-o ").replace(/\b(castles?|castling)(\s+(short|king\s*side))?\b/gi," o-o ");
  s=s.replace(/\b([a-h][1-8])\s+to\s+([a-h][1-8])\b/gi,"$1$2");
  s=s.replace(/\b(king|queen|rook|bishop|knight|horse|pawn)s?\b/gi,(_,w)=>" "+PIECE_WORD[w.toLowerCase()]+"_");
  s=s.replace(/\b(takes|captures|capture|take)\b/gi," x ").replace(/\b(to|on|the|moves|move|goes|go|from|at)\b/gi," ");
  s=s.replace(/\b(promotes?|promoting)\s*(to\s*)?([qrbn])\b/gi,"=$3").replace(/\b(promotes?|promoting)\s*(to\s*)?(Q|R|B|N)_/g,"=$3");
  s=s.replace(/([KQRBN]?)_\s*([a-h]?[1-8]?)\s*(x?)\s*([a-h][1-8])/gi,"$1$2$3$4");
  s=s.replace(/_/g,"");
  s=s.replace(/\b([a-h][1-8])\s*-\s*([a-h][1-8])\b/gi,"$1$2");
  s=s.replace(/\s+x\s+/g,"x").replace(/\s*=\s*/g,"=");
  return s.replace(/\b\d+\.(\.\.)?/g," ").replace(/\.\.\./g," ").trim();
}
function matchToken(tok,g){
  const legal=g.moves({verbose:true});
  const explicit=/^[KQRBN]/.test(tok)&&/[a-hA-H][1-8]/.test(tok.slice(1));
  const t=tok.toLowerCase().replace(/^0-0-0$|^ooo$/,"o-o-o").replace(/^0-0$|^oo$/,"o-o");
  if(t==="o-o")return legal.filter(m=>m.flags.includes("k"));
  if(t==="o-o-o")return legal.filter(m=>m.flags.includes("q"));
  let m=t.match(/^([a-h][1-8])([a-h][1-8])=?([qrbn])?$/);
  if(m)return legal.filter(x=>x.from===m[1]&&x.to===m[2]&&(x.promotion?(x.promotion===(m[3]||"q")):true));
  m=t.match(/^([kqrbn])?([a-h])?([1-8])?(x)?([a-h][1-8])=?([qrbn])?$/);
  if(!m)return null;
  const [,pc,ff,fr,,to,pr]=m;
  const fits=(x,piece,file)=>x.to===to&&x.piece===piece&&(!file||x.from[0]===file)&&(!fr||x.from[1]===fr)&&(x.promotion?(x.promotion===(pr||"q")):!pr);
  const out=new Set();
  if(pc)legal.filter(x=>fits(x,pc,ff)).forEach(x=>out.add(x));
  // a lowercase leading "b" may be the b-file (pawn), not a bishop
  if(pc==="b"&&!ff&&!explicit)legal.filter(x=>fits(x,"p","b")).forEach(x=>out.add(x));
  if(!pc)legal.filter(x=>fits(x,"p",ff)).forEach(x=>out.add(x));
  return [...out];
}
function parseMoves(text,g0){
  const g=new Chess(g0.fen());const toks=normInput(text).split(/\s+/).filter(Boolean);
  const out=[];
  for(let i=0;i<toks.length;i++){
    let tok=toks[i];
    // "e2 e4": two bare squares where the first holds a piece that can go to the second
    const a=tok.toLowerCase(),b=(toks[i+1]||"").toLowerCase();
    if(/^[a-h][1-8]$/.test(a)&&/^[a-h][1-8]$/.test(b)&&g.moves({square:a,verbose:true}).some(x=>x.to===b)){tok=a+b;i++;}
    const c=matchToken(tok,g);
    if(c===null)return {moves:out,error:`Couldn't read "${tok}". Try Nf3, nf3, e2e4, "knight to f3" or O-O.`};
    if(!c.length)return {moves:out,error:`"${tok}" isn't a legal move here${out.length?` (after ${out.map(x=>x.san).join(" ")})`:""}.`+whyNot(tok,g)};
    if(c.length>1)return {moves:out,ambig:c,tok};
    out.push(g.move(c[0].san));
  }
  return {moves:out};
}
function whyNot(tok,g){
  const m=tok.toLowerCase().match(/^([kqrbn])?.*?([a-h][1-8])$/);if(!m)return "";
  const piece=m[1]||"p";const mine=g.moves({verbose:true}).filter(x=>x.piece===piece);
  if(!mine.length)return ` ${g.turn()==="w"?"White":"Black"} has no ${NAME[piece]} moves right now.`;
  const tos=[...new Set(mine.map(x=>x.to))].slice(0,10);
  return ` ${cap(NAME[piece])} moves available: ${[...new Set(mine.map(x=>x.san))].slice(0,10).join(", ")}.`;
}

root.Notation={parseMoves,normInput,matchToken};
})(typeof window!=="undefined"?window:globalThis);
