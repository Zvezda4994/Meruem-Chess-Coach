// Builds data/openings.js (position -> [ECO, name]) from the Lichess chess-openings TSVs (CC0):
//   git clone https://github.com/lichess-org/chess-openings /tmp/chess-openings
//   node scripts/build-openings.js /tmp/chess-openings
const path=require("path");const dir=process.argv[2]||".";const out=path.join(__dirname,"..","data","openings.js");
const fs=require("fs");const src=fs.readFileSync(path.join(__dirname,"..","vendor","chess.js"),"utf8");
const m={exports:{}};new Function("module","exports","window",src+";if(typeof Chess!=='undefined')module.exports.Chess=Chess;")(m,m.exports,{});
const Chess=m.exports.Chess||m.exports;
const out={};let n=0,bad=0;
for(const f of "abcde"){const lines=fs.readFileSync(path.join(dir,f+".tsv"),"utf8").trim().split("\n").slice(1);
 for(const l of lines){const [eco,name,pgn]=l.split("\t");const g=new Chess();let ok=true;
  for(const t of pgn.split(/\s+/)){if(/^\d+\.$/.test(t))continue;if(!g.move(t,{sloppy:true})){ok=false;break;}}
  if(!ok){bad++;continue;}const k=g.fen().split(" ").slice(0,4).join(" ");
  if(!out[k]||out[k][1].length>name.length)out[k]=[eco,name];n++;}}
fs.writeFileSync(out,"window.OPENINGS="+JSON.stringify(out)+";\n");
console.log(n,bad,Object.keys(out).length,fs.statSync(out).size);
