import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cli, repo, writeTestKey } from './fixtures/cli'

test('native permission modes decide a gateway Write at execution time', async () => {
  const dir=mkdtempSync(join(tmpdir(),'claudec-modes-'))
  const root=join(dir,'project')
  mkdirSync(root)
  writeTestKey(join(dir,'key'),'gw1_'+'b'.repeat(43))
  let file='', observed='', review='', reviewed=0
  const server=Bun.serve({
    hostname:'127.0.0.1',port:0,
    fetch(req,s){if(s.upgrade(req))return;return new Response('',{status:400})},
    websocket:{message(ws,data){
      const m=JSON.parse(String(data))
      const emit=(frame:object)=>ws.send(JSON.stringify({id:m.id,...frame}))
      const end=(text:string)=>{emit({type:'agent.text.delta',text});emit({type:'agent.turn.completed'})}
      if(m.type==='user.message'){
        emit({type:'agent.turn.started'})
        if(!m.tools){end('title');return}
        observed=m.text.match(/Permission mode: (\w+)/)?.[1]??''
        emit({type:'tool.request',tool:'Write',call_id:'edit',host_review:true,requires_approval:false,arguments:{file_path:file,content:'hello'}})
      }else if(m.type==='tool.review'){
        reviewed++
        expect(JSON.parse(m.text).tool).toBe('Write')
        emit({type:'tool.review.result',call_id:m.call_id,status:review.toLowerCase()})
      }else if(m.type==='tool.result'){end(m.status+' '+m.text)}
    }}
  })
  try{
    for(const [mode,verdict,allowed] of [
      ['default','',false],['dontAsk','',false],['plan','',false],
      ['acceptEdits','',true],['bypassPermissions','',true],['auto','ALLOW',true],['auto','DENY',false],['auto','unknown',false]
    ] as const){
      file=mode+verdict+'.txt';review=verdict;observed='';reviewed=0
      await using p=Bun.spawn([...cli,'--key-file',join(dir,'key'),'--workspace',root,'--url',`ws://127.0.0.1:${server.port}/v1/ws`,'--permission-mode',mode,'-p','Create '+file],{cwd:repo,stdin:'ignore',stdout:'pipe',stderr:'pipe'})
      const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()])
      expect(code,mode+' '+out+err).toBe(0)
      expect(observed,mode).toBe(mode)
      expect(existsSync(join(root,file)),mode+' '+out).toBe(allowed)
      expect(reviewed,mode).toBe(mode==='auto'?1:0)
    }
  }finally{await server.stop(true);rmSync(dir,{recursive:true,force:true})}
},120000)

test('TUI cycles through the selectable gateway modes; bypass requires opt-in', async()=>{
  const previous=process.env.CC_A_NATIVE
  process.env.CC_A_NATIVE='1'
  try{
    const {getNextPermissionMode}=await import('../utils/permissions/getNextPermissionMode')
    for (const bypass of [false,true]){
      const expected=['acceptEdits','plan',...(bypass?['bypassPermissions']:[]),'auto','default']
      let mode='default'
      for(const next of expected){
        mode=getNextPermissionMode({mode,isBypassPermissionsModeAvailable:bypass} as Parameters<typeof getNextPermissionMode>[0])
        expect(mode).toBe(next)
      }
    }
  }finally{if(previous===undefined)delete process.env.CC_A_NATIVE;else process.env.CC_A_NATIVE=previous}
})
