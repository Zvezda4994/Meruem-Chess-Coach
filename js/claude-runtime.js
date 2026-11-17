/* Claude features outside claude.ai.
   Inside a claude.ai artifact the host provides window.claude (sample, db, user). On a normal website this
   file stands in for it: `sample` calls the Anthropic Messages API directly from the browser with the
   visitor's own API key (kept in localStorage), streams text, and runs page-provided tools. `db` and `user`
   are not available here, so the app falls back to localStorage. */
(function(){
"use strict";
if(window.claude&&window.claude.use)return;
const KEY="mbm-anthropic-key";
// Edit these to use other models. "quick" is used for short per-move comments, "default" for deep dives.
const MODELS={quick:"claude-haiku-5-5",default:"claude-sonnet-5-5",complex:"claude-sonnet-5-5"};
const getKey=()=>{try{return localStorage.getItem(KEY)||"";}catch(e){return "";}};
const setKey=k=>{try{if(k)localStorage.setItem(KEY,k);else localStorage.removeItem(KEY);}catch(e){}};

async function* sse(res){
  const reader=res.body.getReader();const dec=new TextDecoder();let buf="";
  for(;;){
    const {done,value}=await reader.read();if(done)break;
    buf+=dec.decode(value,{stream:true});
    let i;while((i=buf.indexOf("\n\n"))>=0){
      const chunk=buf.slice(0,i);buf=buf.slice(i+2);
      const data=chunk.split("\n").filter(l=>l.startsWith("data:")).map(l=>l.slice(5).trim()).join("");
      if(data)try{yield JSON.parse(data);}catch(e){}
    }
  }
}
async function sample(input,opts={}){
  const key=getKey();if(!key)throw {code:"not_granted",message:"No Anthropic API key set"};
  const messages=typeof input==="string"?[{role:"user",content:input}]:input.map(m=>({role:m.role,content:m.content}));
  const tools=opts.tools&&opts.tools.length?opts.tools:null;
  const model=MODELS[opts.modelTier]||MODELS.default;
  let text="";
  for(let round=0;round<6;round++){
    const body={model,max_tokens:1500,messages,stream:true};
    if(tools)body.tools=tools.map(t=>({name:t.name,description:t.description,input_schema:t.inputSchema||{type:"object",properties:{}}}));
    let res;
    try{
      res=await fetch("https://api.anthropic.com/v1/messages",{method:"POST",signal:opts.signal,
        headers:{"content-type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","anthropic-dangerous-direct-browser-access":"true"},
        body:JSON.stringify(body)});
    }catch(e){if(opts.signal&&opts.signal.aborted)throw e;throw {code:"network",message:String(e.message||e),text};}
    if(!res.ok){
      const detail=await res.text().catch(()=>"");
      throw {code:res.status===429||res.status===529?"rate_limited":res.status===401||res.status===403?"not_granted":"error",message:`HTTP ${res.status} ${detail.slice(0,200)}`,text};
    }
    const blocks=[];let stop=null;
    for await (const ev of sse(res)){
      if(ev.type==="content_block_start")blocks[ev.index]={...ev.content_block,text:ev.content_block.text||"",_json:""};
      else if(ev.type==="content_block_delta"){
        const b=blocks[ev.index];
        if(ev.delta.type==="text_delta"){b.text+=ev.delta.text;text+=ev.delta.text;if(opts.onText)opts.onText({text,delta:ev.delta.text});}
        else if(ev.delta.type==="input_json_delta")b._json+=ev.delta.partial_json;
      }
      else if(ev.type==="message_delta"&&ev.delta)stop=ev.delta.stop_reason||stop;
      else if(ev.type==="error")throw {code:"error",message:ev.error&&ev.error.message,text};
    }
    const uses=blocks.filter(b=>b&&b.type==="tool_use");
    if(stop!=="tool_use"||!uses.length||!tools)return {text,truncated:stop==="max_tokens"};
    messages.push({role:"assistant",content:blocks.filter(Boolean).map(b=>b.type==="tool_use"?{type:"tool_use",id:b.id,name:b.name,input:b._json?JSON.parse(b._json):{}}:{type:"text",text:b.text}).filter(c=>c.type!=="text"||c.text)});
    const results=[];
    for(const b of uses){
      const t=tools.find(x=>x.name===b.name);let content,is_error=false;
      try{content=JSON.stringify(await t.execute(b._json?JSON.parse(b._json):{}));}catch(e){content=String(e&&e.message||e);is_error=true;}
      results.push({type:"tool_result",tool_use_id:b.id,content,is_error});
    }
    messages.push({role:"user",content:results});
    if(text&&!/\s$/.test(text))text+="\n\n";
  }
  return {text,truncated:true};
}
sample.limits=async()=>({tools:{maxCount:8}});
sample.json=async(input,opts)=>JSON.parse((await sample(input,opts)).text);
window.claude={use:async name=>name==="sample"&&getKey()?sample:null};
window.MBMKey={get:getKey,set:setKey};
})();
