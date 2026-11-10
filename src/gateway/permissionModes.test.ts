import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cli, repo, writeTestKey } from './fixtures/cli'

test('gateway permission modes enforce local decisions and route eligible Auto actions to the host', async () => {
  const dir=mkdtempSync(join(tmpdir(),'claudec-modes-'))
  const root=join(dir,'project')
  mkdirSync(root)
  writeTestKey(join(dir,'key'),'gw1_'+'b'.repeat(43))
  let file='', observed='', review='', reviewed=0, shellCommand=''
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
        emit({type:'tool.request',tool:shellCommand?'Bash':'Write',call_id:'edit',host_review:true,requires_approval:false,arguments:shellCommand ? {command:shellCommand} : {file_path:file,content:'hello'}})
      }else if(m.type==='tool.review'){
        reviewed++
        expect(JSON.parse(m.text).tool).toBe(shellCommand?'Bash':'Write')
        if (shellCommand) expect(JSON.parse(m.text).args.command).toBe(shellCommand)
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
    if (process.platform !== 'win32') {
      const loop = 'ls; for b in role/A_control role/B_perception role/C_learning role/D_prediction role/E_data_pipeline role/F_training_infrastructure profile/main profile/cosmos3 profile/dreamzero profile/fast_wam profile/vjepa2_ac; do echo "=== $b"; git log -1 --format=\'%ad %s\' --date=short origin/$b 2>/dev/null; git ls-tree --name-only origin/$b | head -15 | tr \'\\n\' \' \'; echo; done 2>&1 | grep -v xcrun'
      for (const [command, verdict, marker, created] of [
        ['touch approved','ALLOW','approved',true], ['touch declined','DENY','declined',false],
        ['pwd','DENY','',false], [loop,'ALLOW','',false],
      ] as const) {
        reviewed=0; shellCommand=command; review=verdict
        await using proc=Bun.spawn([...cli,'--key-file',join(dir,'key'),'--workspace',root,
          '--url',`ws://127.0.0.1:${server.port}/v1/ws`,'--permission-mode','auto','-p','Create the requested file'],
          {cwd:repo,stdin:'ignore',stdout:'pipe',stderr:'pipe'})
        const [code,out,err]=await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()])
        expect(code,out+err).toBe(0)
        expect(reviewed,command+' '+out).toBe(1)
        if (marker) expect(existsSync(join(root,marker)),command+' '+out).toBe(created)
        if (command === loop) expect(out).toContain('=== role/A_control')
        if (command === 'pwd') expect(out).toContain('Auto review declined or unavailable')
      }
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


test('Auto keeps explicit session rules local, including rules on a pipeline segment', async () => {
  const { getEmptyToolPermissionContext } = await import('../Tool')
  const { BashTool } = await import('../tools/BashTool/BashTool')
  const { getLocalToolPermissionDecision } = await import('../utils/permissions/permissions')
  const { hostReviewable } = await import('./autoReview')
  const toolPermissionContext = {
    ...getEmptyToolPermissionContext(), mode: 'acceptEdits' as const,
    alwaysAskRules: {session:['Bash(touch ask-first)']},
    alwaysDenyRules: {session:['Bash(touch deny-always)']},
  }
  const context = {
    getAppState: () => ({toolPermissionContext}), abortController: new AbortController(),
  } as import('../Tool').ToolUseContext
  for (const [command, behavior] of [
    ['touch ask-first','ask'], ['touch deny-always','deny'], ['touch ask-first | cat','ask'],
  ] as const) {
    const result = await getLocalToolPermissionDecision(BashTool, {command}, context, {forGatewayReview:true})
    expect(result.behavior, command).toBe(behavior)
    expect(hostReviewable(result, true), command).toBe(false)
  }
})

test('confirmed gateway mode survives a fresh read and stays in its key scope', async () => {
  const {saveGatewayPermissionMode, savedPermissionMode} = await import('./configure')
  const dir = mkdtempSync(join(tmpdir(), 'claudec-mode-setting-'))
  const state = join(dir, 'key-one')
  const previousState = process.env.CLAUDE_CONFIG_DIR
  const previousNative = process.env.CC_A_NATIVE
  try {
    process.env.CLAUDE_CONFIG_DIR = state
    process.env.CC_A_NATIVE = '1'
    expect(savedPermissionMode(state)).toBeUndefined()
    for (const mode of ['auto', 'acceptEdits', 'plan', 'bypassPermissions', 'default']) {
      saveGatewayPermissionMode(mode)
      expect(savedPermissionMode(state)).toBe(mode)
    }
    expect(savedPermissionMode(join(dir, 'key-two'))).toBeUndefined()
    expect(() => saveGatewayPermissionMode('unknown')).toThrow()
    expect(savedPermissionMode(state)).toBe('default')
  } finally {
    if (previousState === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousState
    if (previousNative === undefined) delete process.env.CC_A_NATIVE
    else process.env.CC_A_NATIVE = previousNative
    rmSync(dir, {recursive:true, force:true})
  }
})
