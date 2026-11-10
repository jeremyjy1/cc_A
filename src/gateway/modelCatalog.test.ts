import { expect, test } from 'bun:test'
import { Gateway } from './client'
import { parseModelCatalog } from './modelCatalog'

test('model catalog uses the bound connection and never sends an inference prompt', async () => {
  const server = Bun.serve({
    hostname:'127.0.0.1',port:0,
    fetch(req,s) { if (!s.upgrade(req)) return new Response('',{status:400}) },
    websocket:{ message(ws,data) {
      const m=JSON.parse(String(data))
      expect(m.model_catalog).toBe(true)
      expect(m.text).toBe('')
      expect(m.tools).toBe(false)
      expect(m.model).toBeUndefined()
      for (const frame of [{type:'agent.turn.started'},{type:'agent.text.delta',text:JSON.stringify([{value:'default',displayName:'Default (VM model)'},{value:'pool/MyModel',displayName:'Registered in this VM'}])},{type:'agent.turn.completed'}]) ws.send(JSON.stringify({id:m.id,...frame}))
    }},
  })
  const gw=new Gateway(new URL('ws://127.0.0.1:'+server.port),'test',3000,{model:'local-fallback'})
  try {
    expect((await gw.listModels(AbortSignal.timeout(3000))).map(m=>[m.value,m.label])).toEqual([[null,'Default (VM model)'],['pool/MyModel','Registered in this VM']])
    expect(()=>parseModelCatalog('[]')).toThrow()
    expect(()=>parseModelCatalog('[{"value":"--help"}]')).toThrow()
  } finally {gw.close();await server.stop(true)}
})
