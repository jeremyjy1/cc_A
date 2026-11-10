import {expect,test} from 'bun:test'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {cli,repo,writeTestKey} from './fixtures/cli'
import {tmpdir} from 'node:os'

test('read-only operations reach native CLI handlers and return local results',async()=>{
  const base=mkdtempSync(join(tmpdir(),'cc-tool-check-'))
  const project=join(base,'project')
  mkdirSync(project)
  writeFileSync(join(project,'sample.ts'),'export const marker = "violet-963";\n')
  writeTestKey(join(base,'key'),'gw1_'+'z'.repeat(43))
  const config=join(base,'mcp.json')
  writeFileSync(config,JSON.stringify({mcpServers:{fixture:{command:process.execPath,args:[join(import.meta.dir,'fixtures/resources.ts')]}}}))
  const cases:[string,object,RegExp][]=[
    ['Read',{file_path:'sample.ts'},/violet-963/],
    ['Glob',{pattern:'*.ts'},/sample\.ts/],
    ['Grep',{pattern:'violet-963',output_mode:'content'},/marker/],
    ['ListAgents',{},/\[\]/],
    ['ToolSearch',{query:'select:Read',max_results:3},/Read/],
    ['WaitForMcpServers',{servers:['fixture']},/connected/],
    ['TaskList',{},/task/i],
    ['CronList',{},/cron|job|task/i],
    ['ListMcpResourcesTool',{server:'fixture'},/fixture:\/\/project\/readme/],
    ['ReadMcpResourceTool',{server:'fixture',uri:'fixture://project/readme'},/resource-violet-963/],
    ['LSP',{operation:'documentSymbol',filePath:'sample.ts',line:1,character:1},/marker/],
  ]
  if(process.platform==='win32')cases.push(['ToolSearch',{query:'select:PowerShell'},/PowerShell/])
  const results:{name:string;status:string;text:string}[]=[]
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,s){if(s.upgrade(req))return;return new Response('',{status:400})},
    websocket:{idleTimeout:0,message(ws,raw){
      const m=JSON.parse(String(raw))
      const emit=(data:object)=>ws.send(JSON.stringify({id:m.id,...data}))
      if(m.type==='user.message')emit({type:'agent.turn.started'})
      if(m.type==='tool.result')results.push({name:cases[results.length]![0],status:m.status,text:m.text})
      const next=cases[results.length]
      if((m.type==='user.message'&&m.tools||m.type==='tool.result')&&next){
        emit({type:'tool.request',call_id:'call'+results.length,tool:next[0],arguments:next[1]})
      }else{emit({type:'agent.text.delta',text:'finished'});emit({type:'agent.turn.completed'})}
    }}})
  try{
    const p=Bun.spawn([...cli,'--url',`ws://127.0.0.1:${server.port}/v1/ws`,'--key-file',join(base,'key'),'--workspace',project,'--mcp-config',config,'-p','test tools'],{cwd:repo,stdin:'ignore',stdout:'pipe',stderr:'pipe'})
    const [exit,out,err]=await Promise.all([p.exited,new Response(p.stdout).text(),new Response(p.stderr).text()])
    expect(exit,err).toBe(0)
    expect(out.trim()).toBe('finished')
    expect(results.length).toBe(cases.length)
    for(const [i,r] of results.entries()){
      expect(r.status,r.name+' '+r.text).toBe('ok')
      expect(r.text,r.name).toMatch(cases[i]![2])
    }
  }finally{await server.stop(true);rmSync(base,{recursive:true,force:true})}
},process.platform==='win32'?900000:60000)
