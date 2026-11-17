/* Maia-3 (CSSLab, github.com/CSSLab/maia-platform-frontend) inference worker.
   Loads the ONNX model from 4 published parts and runs ONNX Runtime Web on the CPU (single thread). */
const MAX_MEMORY_PAGES=4096;const NativeMemory=WebAssembly.Memory;
WebAssembly.Memory=function Memory(d){return new NativeMemory(d&&d.shared&&d.maximum>MAX_MEMORY_PAGES?{...d,maximum:MAX_MEMORY_PAGES}:d);};
WebAssembly.Memory.prototype=NativeMemory.prototype;
importScripts("ort/ort.wasm.min.js");
ort.env.wasm.wasmPaths=new URL("ort/",self.location.href).href;
ort.env.wasm.numThreads=1;
let session=null,loading=null;
async function load(parts){
  const bufs=[];let got=0;const total=45683801;
  for(let i=0;i<parts;i++){
    const r=await fetch(new URL("model.part"+i+".wasm",self.location.href).href);
    if(!r.ok)throw new Error("Model download failed ("+r.status+")");
    const reader=r.body.getReader();
    for(;;){const {done,value}=await reader.read();if(done)break;bufs.push(value);got+=value.length;postMessage({type:"progress",p:Math.min(99,Math.round(got/total*100))});}
  }
  const all=new Uint8Array(got);let o=0;for(const b of bufs){all.set(b,o);o+=b.length;}
  session=await ort.InferenceSession.create(all,{graphOptimizationLevel:"basic"});
  postMessage({type:"ready"});
}
self.onmessage=async e=>{
  const m=e.data;
  if(m.type==="init"){if(!loading)loading=load(m.parts||4).catch(err=>{loading=null;postMessage({type:"error",message:String(err&&err.message||err)});});return;}
  if(m.type==="run"){
    try{
      if(!session)await loading;
      if(!session)throw new Error("Model not loaded");
      const feeds={tokens:new ort.Tensor("float32",new Float32Array(m.tokens),[1,64,12]),
        elo_self:new ort.Tensor("float32",Float32Array.from([m.es]),[1]),elo_oppo:new ort.Tensor("float32",Float32Array.from([m.eo]),[1])};
      const r=await session.run(feeds);
      const lm=new Float32Array(r.logits_move.data),lv=new Float32Array(r.logits_value.data);
      postMessage({type:"result",id:m.id,logits:lm.buffer,value:lv.buffer},[lm.buffer,lv.buffer]);
    }catch(err){postMessage({type:"error",id:m.id,message:String(err&&err.message||err)});}
  }
};
