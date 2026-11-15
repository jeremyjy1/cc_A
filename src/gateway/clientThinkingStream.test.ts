import { expect, test } from 'bun:test'
import { Gateway } from './client'

test('thinking fragments reach the callback before the turn completes',async()=>{
  const seen:string[]=[]
  let finishWire:()=>void=()=>{}
  let receive:()=>void=()=>{}
  const received=new Promise<void>(resolve=>receive=resolve)
  let optedIn=false,completed=false
  const server=Bun.serve({hostname:'127.0.0.1',port:0,
    fetch(req,s){if(s.upgrade(req))return;return new Response('',{status:400})},
    websocket:{message(ws,raw){
      const f=JSON.parse(String(raw));optedIn=f.thinking_stream===true&&f.thinking===true
      const emit=(type:string,text?:string)=>ws.send(JSON.stringify({id:f.id,type,text}))
      finishWire=()=>{emit('agent.thinking.delta','second');emit('agent.thinking.completed');emit('agent.text.delta','answer');emit('agent.turn.completed')}
      emit('agent.turn.started');emit('agent.thinking.delta','first ')
    }},
  })
  const gateway=new Gateway(new URL('ws://127.0.0.1:'+server.port),'synthetic')
  try{
    const answer=gateway.run(process.cwd(),'test',false,async()=>false,{
      names:[],signal:new AbortController().signal,
      thinkingDelta:text=>{seen.push(text);receive()},thinkingDone:()=>{},
      call:async()=>{throw Error('unexpected tool')},
    }).then(text=>{completed=true;return text})
    await received
    expect(optedIn).toBe(true);expect(completed).toBe(false);expect(seen).toEqual(['first '])
    finishWire();expect(await answer).toBe('answer');expect(seen.join('')).toBe('first second')
  }finally{gateway.close();await server.stop(true)}
})
