// Run with: node --test
const test=require("node:test");const assert=require("node:assert/strict");
const fs=require("fs");const path=require("path");
const root=path.join(__dirname,"..");
const mod={exports:{}};
new Function("module","exports","window",fs.readFileSync(path.join(root,"vendor/chess.js"),"utf8")+";module.exports.Chess=Chess;")(mod,mod.exports,{});
globalThis.Chess=mod.exports.Chess;
new Function(fs.readFileSync(path.join(root,"js/notation.js"),"utf8"))();
const {parseMoves}=globalThis.Notation;
const START=new Chess();
const sans=(t,g=START)=>parseMoves(t,g).moves.map(m=>m.san).join(" ");

test("standard and lowercase SAN",()=>{
  assert.equal(sans("e4"),"e4");assert.equal(sans("Nf3"),"Nf3");assert.equal(sans("nf3"),"Nf3");assert.equal(sans("E4"),"e4");
});
test("coordinates",()=>{
  for(const t of ["e2e4","e2 e4","e2-e4","e2 to e4"])assert.equal(sans(t),"e4",t);
});
test("words",()=>{
  assert.equal(sans("knight to f3"),"Nf3");assert.equal(sans("pawn to e4"),"e4");
  const g=new Chess("4k3/8/8/8/8/2p5/1P1B4/4K3 w - - 0 1");
  assert.equal(sans("bishop takes c3",g),"Bxc3");
});
test("move lists with numbers",()=>{
  assert.equal(sans("1. e4 e5 2. Nf3 Nc6 3. Bc4"),"e4 e5 Nf3 Nc6 Bc4");
  assert.equal(sans("e4 e5 nf3 nc6 bishop c4 bishop c5 castle"),"e4 e5 Nf3 Nc6 Bc4 Bc5 O-O");
});
test("castling and promotion",()=>{
  const g=new Chess("r3k3/8/8/8/8/8/8/R3K2R w KQq - 0 1");
  assert.equal(sans("O-O-O",g),"O-O-O");assert.equal(sans("castle kingside",g),"O-O");
  const p=new Chess("4k3/P7/8/8/8/8/8/4K3 w - - 0 1");
  assert.equal(sans("a8",p),"a8=Q+");assert.equal(sans("a8=N",p),"a8=N");
});
test("ambiguity is reported, not guessed",()=>{
  const g=new Chess("4k3/8/8/8/8/2p5/1P1B4/4K3 w - - 0 1");
  const r=parseMoves("bc3",g);assert.deepEqual(r.ambig.map(m=>m.san).sort(),["Bxc3","bxc3"]);
  assert.equal(sans("Bc3",g),"Bxc3");
  const n=new Chess("4k3/8/8/8/8/8/8/1N2KN2 w - - 0 1");
  assert.deepEqual(parseMoves("nd2",n).ambig.map(m=>m.san).sort(),["Nbd2","Nfd2"]);
  assert.equal(sans("nbd2",n),"Nbd2");
});
test("illegal and unreadable input",()=>{
  assert.match(parseMoves("Qh5",START).error,/no queen moves/);
  assert.match(parseMoves("zz",START).error,/Couldn't read/);
});
