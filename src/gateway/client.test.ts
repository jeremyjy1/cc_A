import {cli,repo,writeTestKey} from './fixtures/cli'
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'

test.skipIf(process.platform==='win32')('POSIX repeated print prompts share one connection and cannot grant local writes', async () => {
  const base = mkdtempSync(join(tmpdir(), 'cc-a-protocol-'))
  const workspace = join(base, 'project')
  mkdirSync(workspace)
  const key = 'gw1_' + 'a'.repeat(43)
  writeFileSync(join(base, 'key'), key, {mode: 0o600})
  let connections = 0
  const messages = new Map<string,string>()
  const votes: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req, server) {
      if (req.headers.get('authorization') !== 'Bearer '+key) return new Response('',{status:401})
      if (server.upgrade(req)) return
      return new Response('',{status:400})
    },
    websocket: {
      open() { connections++ },
      message(ws, data) {
        const m = JSON.parse(String(data))
        const emit = (frame: object) => ws.send(JSON.stringify({id:m.id,...frame}))
        if (m.type === 'user.message') {
          messages.set(m.id,m.text)
          emit({type:'agent.turn.started'})
          emit({type:'tool.request', call_id:'write', tool:'Write', requires_approval:false,
            arguments:{file_path:'forbidden.txt',content:'changed'}})
        } else if (m.type === 'tool.result') {
          votes.push(m.status)
          emit({type:'agent.text.delta',text:messages.get(m.id)})
          emit({type:'agent.turn.completed'})
        }
      }
    }
  })
  try {
    const env = {...process.env, HOME:base, CC_GATEWAY_URL:''}
    const url = `ws://127.0.0.1:${server.port}/v1/ws`
    for (const [input, status] of [[url,0], ['ws://example.com/v1/ws',1], ['wss://user:password@example.com/',1]] as const) {
      const setting = Bun.spawn([...cli,'config','set-server'], {
        env, stdin:new Blob([input+'\n']), stdout:'pipe', stderr:'pipe',
      })
      expect(await setting.exited).toBe(status)
    }
    const p=Bun.spawn([...cli,'--workspace',workspace,'--key-file',join(base,'key'),
      '-p','first','-p','second'], {env,stdin:'ignore',stdout:'pipe',stderr:'pipe'})
    const stdout=await new Response(p.stdout).text()
    expect(await p.exited).toBe(0)
    expect(connections).toBe(1)
    expect(stdout.trim().split('\n')).toEqual(['first','second'])
    expect(votes).toEqual(['denied','denied'])
    expect(existsSync(join(workspace,'forbidden.txt'))).toBe(false)
  } finally {
    await server.stop(true)
    rmSync(base,{recursive:true,force:true})
  }
})

test('native CLI resumes a turn and rejects a forged headless write', async () => {
  const base=mkdtempSync(join(tmpdir(),'cc-a-native-'))
  const workspace=join(base,'project')
  mkdirSync(workspace)
  writeTestKey(join(base,'key'),'gw1_'+'b'.repeat(43))
  const inputs:string[]=[]
  let writeResult='', registered:string[]=[]
  const server=Bun.serve({
    hostname:'127.0.0.1',port:0,
    fetch(req,s){if(s.upgrade(req))return;return new Response('',{status:400})},
    websocket:{message(ws,raw){
      const m=JSON.parse(String(raw))
      const emit=(frame:object)=>ws.send(JSON.stringify({id:m.id,...frame}))
      const end=(text:string)=>{emit({type:'agent.text.delta',text});emit({type:'agent.turn.completed'})}
      if(m.type==='user.message'){
        emit({type:'agent.turn.started'})
        if(!m.tools){end('session title');return}
        inputs.push(m.text);registered=m.tool_names
        if(inputs.length===1)end('remember-7649')
        else emit({type:'tool.request',tool:'Write',call_id:'write1',arguments:{file_path:'denied.txt',content:'x'},requires_approval:false})
      }else if(m.type==='tool.result'){writeResult=m.status;end('second-complete')}
    }}
  })
  const run=async(args:string[],piped?:string)=>{
    await using p=Bun.spawn([...cli,'--workspace',workspace,'--key-file',join(base,'key'),'--url',`ws://127.0.0.1:${server.port}/v1/ws`,...args],
      {env:{...process.env,TEST_ENABLE_SESSION_PERSISTENCE:'1'},cwd:repo,stdin:piped===undefined?'ignore':new Blob([piped]),stdout:'pipe',stderr:'pipe'})
    const [out,err,code]=await Promise.all([new Response(p.stdout).text(),new Response(p.stderr).text(),p.exited])
    if(code!==0)throw Error(err+' '+out)
    return out.trim()
  }
  try{
    expect(await run(['-p','first-message'])).toBe('remember-7649')
    expect(await run(['-c','second-message','--print'])).toBe('second-complete')
    expect(await run(['--print'],'管道输入')).toBe('second-complete')
    const history=await run(['history'])
    expect(history).toContain('first-message')
    expect(history).toContain('管道输入')
    expect(history.match(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/g)?.length).toBe(2)
    const matches=await run(['history','--search','FIRST-message','--url','ws://127.0.0.1:1'])
    expect(matches).toContain('first-message')
    expect(matches).not.toContain('管道输入')
    expect(inputs[2]).toContain('管道输入')
    expect(inputs[1]).toContain('remember-7649')
    expect(inputs[1]).toContain('first-message')
    expect(registered).toContain('Workflow')
    expect(registered).not.toContain('WebFetch')
    expect(writeResult).toBe('error')
    expect(existsSync(join(workspace,'denied.txt'))).toBe(false)
  }finally{
    await server.stop(true)
    // Windows can briefly retain the last child's working directory after it exits.
    // Remove the workspace first so a busy child cannot mask the underlying error
    // with an EBUSY on its parent.
    for(const dir of [workspace,base]){
      for(let retry=0;;retry++){
        try{await rm(dir,{recursive:true,force:true});break}
        catch(error){
          if(process.platform!=='win32' || (error as NodeJS.ErrnoException).code!=='EBUSY' || retry>=60)throw error
          await Bun.sleep(1000)
        }
      }
    }
  }
},process.platform==='win32'?900000:60000)

test('an idle turn cancels independently while a streaming sibling continues',async()=>{
  const {Gateway}=await import('./client')
  let cancelled='',idleId=''
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,s){
    if(s.upgrade(req))return
    return new Response('',{status:400})
  },websocket:{message(ws,raw){
    const frame=JSON.parse(String(raw))
    const send=(type:string,text?:string)=>ws.send(JSON.stringify({id:frame.id,type,text}))
    if(frame.type==='user.cancel'){cancelled=frame.id;send('agent.turn.completed');return}
    send('agent.turn.started')
    if(frame.text==='idle'){idleId=frame.id;return}
    let steps=0
    const interval=setInterval(()=>{
      send('agent.text.delta','x')
      if(++steps===8){clearInterval(interval);send('agent.turn.completed')}
    },60)
  }}})
  const gateway=new Gateway(new URL('ws://127.0.0.1:'+server.port),'synthetic',300)
  try{
    const ask=async()=>false
    const [idle,streaming]=await Promise.allSettled([
      gateway.run(process.cwd(),'idle',false,ask),
      gateway.run(process.cwd(),'active',false,ask),
    ])
    expect(idle.status).toBe('rejected')
    if(idle.status==='rejected')expect(idle.reason.message).toBe('Gateway turn timed out')
    expect(streaming).toEqual({status:'fulfilled',value:'xxxxxxxx'})
    expect(cancelled).toBe(idleId)
    expect(idleId).not.toBe('')
  }finally{gateway.close();await server.stop(true)}
})

test('a resumed failed turn shows partial output and an empty completion reports failure', async () => {
  const dir = mkdtempSync(join(tmpdir(),'cc-a-interrupted-'))
  const root = join(dir,'project')
  mkdirSync(root)
  writeTestKey(join(dir,'key'),'gw1_'+'v'.repeat(43))
  const server = Bun.serve({hostname:'127.0.0.1',port:0,
    fetch(req,s){if(!s.upgrade(req))return new Response('',{status:400})},
    websocket:{message(ws,raw){
      const m=JSON.parse(String(raw))
      if(m.type!=='user.message')return
      const send=(type:string,text?:string)=>ws.send(JSON.stringify({id:m.id,type,text}))
      send('agent.turn.started')
      if(m.text.endsWith('second-turn')) {
        send('agent.text.delta','partial-432');send('agent.error','turn_timed_out')
      } else {
        if(!m.text.endsWith('empty-turn'))send('agent.text.delta','first-response')
        send('agent.turn.completed')
      }
    }},
  })
  try {
    for(const [prompt,expected] of [['first-turn','first-response'],['second-turn','turn_timed_out'],['empty-turn','没有返回文本']]){
      await using p=Bun.spawn([...cli,'--workspace',root,'--key-file',join(dir,'key'),
        '--url','ws://127.0.0.1:'+server.port+'/v1/ws',...(prompt==='first-turn'?[]:['--continue']),'-p',prompt],
        {env:{...process.env,TEST_ENABLE_SESSION_PERSISTENCE:'1'},cwd:repo,stdin:'ignore',stdout:'pipe',stderr:'pipe'})
      const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()])
      expect(out+err).toContain(expected)
      if(prompt==='second-turn')expect(out+err).toContain('partial-432')
      expect(code===0).toBe(prompt==='first-turn')
    }
  } finally {await server.stop(true);rmSync(dir,{recursive:true,force:true})}
},60000)

test('resuming a saved A transcript sends only the follow-up with the C checkpoint', async()=>{
  const base=mkdtempSync(join(tmpdir(),'cc-native-resume-'))
  const root=join(base,'project')
  mkdirSync(root)
  writeTestKey(join(base,'key'),'gw1_'+'x'.repeat(43))
  const turns: {text:string;resume_from?:string}[]=[]
  const server=Bun.serve({hostname:'127.0.0.1',port:0,
    fetch(req,s){if(!s.upgrade(req))return new Response('',{status:400})},
    websocket:{message(ws,raw){
      const m=JSON.parse(String(raw))
      if(m.type!=='user.message')return
      const send=(frame:object)=>ws.send(JSON.stringify({id:m.id,...frame}))
      send({type:'agent.turn.started',persistence:'true'})
      if(m.save_session)turns.push(m)
      send({type:'agent.text.delta',text:'remember-my-first-reply'})
      send({type:'agent.turn.completed',checkpoint:'C'.repeat(26)})
    }},
  })
  try {
    const args=[...cli,'--workspace',root,'--key-file',join(base,'key'),'--url','ws://127.0.0.1:'+server.port+'/v1/ws']
    for(const rest of [['-p','first-seed'],['--continue','-p','second-question'],['-p','separate-chat']]){
      await using p=Bun.spawn([...args,...rest],{cwd:repo,env:{...process.env,TEST_ENABLE_SESSION_PERSISTENCE:'1'},stdout:'pipe',stderr:'pipe',stdin:'ignore'})
      const [code,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()])
      expect(code,out+err).toBe(0)
    }
    expect(turns).toHaveLength(3)
    expect(turns[0]!.resume_from).toBeUndefined()
    expect(turns[1]!.resume_from).toBe('C'.repeat(26))
    expect(turns[1]!.text).toContain('second-question')
    expect(turns[1]!.text).not.toContain('first-seed')
    expect(turns[1]!.text).not.toContain('remember-my-first-reply')
    expect(turns[2]!.resume_from).toBeUndefined()
  } finally {await server.stop(true);rmSync(base,{recursive:true,force:true})}
},60000)
