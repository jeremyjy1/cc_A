import { expect, test } from 'bun:test'
import { Gateway } from './client'

test('thinking reaches the UI separately from the final answer', async () => {
  const seen:string[] = []
  let optedIn=false
  const server=Bun.serve({hostname:'127.0.0.1',port:0,
    fetch(req,s){if(s.upgrade(req))return;return new Response('',{status:400})},
    websocket:{message(ws,raw){
      const f=JSON.parse(String(raw));optedIn=f.thinking===true
      for(const frame of [
        {type:'agent.turn.started'},
        {type:'agent.thinking',text:'Reasoning block one.'},
        {type:'agent.thinking',text:'Reasoning block two.'},
        {type:'agent.text.delta',text:'Final answer.'},
        {type:'agent.turn.completed'},
      ])ws.send(JSON.stringify({id:f.id,...frame}))
    }},
  })
  const gateway=new Gateway(new URL('ws://127.0.0.1:'+server.port),'synthetic')
  try {
    const answer=await gateway.run(process.cwd(),'test',false,async()=>false,{
      names:[],signal:new AbortController().signal,thinking:text=>seen.push(text),
      call:async()=>{throw Error('unexpected tool')},
    })
    expect(optedIn).toBe(true)
    expect(seen).toEqual(['Reasoning block one.','Reasoning block two.'])
    expect(answer).toBe('Final answer.')
  }finally{gateway.close();await server.stop(true)}
})
