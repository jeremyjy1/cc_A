import { sessionInference } from './inference'
import React from 'react'
import type {CanUseToolFn} from '../hooks/useCanUseTool'
import {runTools} from '../services/tools/toolOrchestration'
import {createAssistantMessage} from '../utils/messages'
import {z} from 'zod/v4'
import Ajv from 'ajv'
import {buildTool, type ToolUseContext} from '../Tool'
import {Text} from '../ink'
import {getCwd} from '../utils/cwd'
import {enqueue} from '../utils/messageQueueManager'
import {isLocalAgentTask, queuePendingMessage} from '../tasks/LocalAgentTask/LocalAgentTask'
import {execute} from './tools'
import {embeddedCatalog} from './registry'
import {evaluateWorkflow,readWorkflow} from './workflow'

const jobs = new Map<string,{controller:AbortController,owner:string,kind:string,result?:unknown,error?:string}>()
const workflows = new Map<string,{script:string,cache:Map<string,string>,owner:string}>()
const wakeups = new Map<string,ReturnType<typeof setTimeout>>()
const owner=(ctx:ToolUseContext)=>String(ctx.agentId??'main')
export function closeSessionTools(){
  for(const job of jobs.values())job.controller.abort()
  for(const timer of wakeups.values())clearTimeout(timer)
  jobs.clear();wakeups.clear();workflows.clear()
}
export function hasSessionJob(id:string,ctx:ToolUseContext){return jobs.get(id)?.owner===owner(ctx)}
export function stopSessionJob(id:string,ctx:ToolUseContext){
  const job=jobs.get(id)
  if(!job||job.owner!==owner(ctx))return false
  job.controller.abort();return true
}
function job(ctx:ToolUseContext,kind:string,run:(s:AbortSignal)=>Promise<unknown>){
  if(ctx.options.isNonInteractiveSession)throw Error('Background jobs require an interactive session')
  if(jobs.size>=100)throw Error('Session job limit reached')
  const id=kind+'_'+crypto.randomUUID()
  const entry:{controller:AbortController,owner:string,kind:string,result?:unknown,error?:string}={controller:new AbortController(),owner:owner(ctx),kind}
  jobs.set(id,entry)
  void run(entry.controller.signal).then(value=>entry.result=value,e=>entry.error=String(e)).finally(()=>{
    if(!entry.controller.signal.aborted)enqueue({mode:'prompt',value:`Local ${kind} ${id} finished: ${JSON.stringify(entry.error??entry.result).slice(0,8000)}`})
  })
  return id
}
async function monitorSocket(a:any,signal:AbortSignal){
  const url=new URL(a.ws.url)
  if(url.username||url.password||!['ws:','wss:'].includes(url.protocol)||!['127.0.0.1','[::1]','localhost'].includes(url.hostname))throw Error('Monitor requires a local WebSocket')
  return new Promise<string>((ok,fail)=>{
    signal.throwIfAborted()
    const ws=new WebSocket(url.href,a.ws.protocols), chunks:string[]=[]
    let bytes=0
    const stop=()=>{ws.close();fail(Error('Monitor stopped'))}
    const deadline=setTimeout(()=>ws.close(),a.timeout_ms)
    signal.addEventListener('abort',stop,{once:true})
    ws.onmessage=e=>{if(typeof e.data==='string'){bytes+=Buffer.byteLength(e.data);if(bytes<=40000)chunks.push(e.data);else ws.close()}}
    ws.onerror=()=>{ws.close();fail(Error('WebSocket monitor failed'))}
    ws.onclose=()=>{clearTimeout(deadline);signal.removeEventListener('abort',stop);ok(chunks.join('\n'))}
  })
}
async function monitorPowerShell(input:Record<string,unknown>,ctx:ToolUseContext,canUseTool:CanUseToolFn,signal:AbortSignal) {
  const controller=new AbortController()
  const stop=()=>controller.abort()
  signal.addEventListener('abort',stop,{once:true})
  try {
    signal.throwIfAborted()
    const id=crypto.randomUUID()
    const block={type:'tool_use' as const,id,name:'PowerShell',input}
    const message=createAssistantMessage({content:[block]})
    for await(const {message:update} of runTools([block],[message],canUseTool,{...ctx,abortController:controller})){
      if(update?.type!=='user'||!Array.isArray(update.message.content))continue
      for(const part of update.message.content){
        if(part.type!=='tool_result'||part.tool_use_id!==id)continue
        const text=typeof part.content==='string'?part.content:JSON.stringify(part.content)
        if(part.is_error)throw Error(text)
        return text
      }
    }
    throw Error('PowerShell monitor returned no result')
  }finally{signal.removeEventListener('abort',stop)}
}

async function local(name:string,a:any,ctx:ToolUseContext,canUseTool:CanUseToolFn) {
  const root=getCwd(), signal=ctx.abortController.signal, who=owner(ctx)
  switch(name){
    case 'ListAgents': return Object.values(ctx.getAppState().tasks).filter(isLocalAgentTask)
      .map(t=>({id:t.agentId,status:t.status,description:t.description})).filter(t=>!a.q||JSON.stringify(t).includes(a.q))
    case 'SendMessage': {
      const agent=Object.values(ctx.getAppState().tasks).filter(isLocalAgentTask).find(t=>t.agentId===a.to&&t.status==='running')
      if(!agent)throw Error('No running local agent with that id')
      queuePendingMessage(agent.id,a.message,ctx.setAppStateForTasks??ctx.setAppState)
      return {delivered:agent.agentId}
    }
    case 'ReportFindings': return a.findings
    case 'SubagentHandback':
      if(!ctx.agentId)throw Error('Only a subagent may hand back a result')
      return a.message
    case 'EndConversation': return 'Conversation ended.'
    case 'ToolSearch': {
      const names=new Set(ctx.options.tools.map(t=>t.name==='Agent'?'Task':t.name))
      const terms=a.query.toLowerCase().replace(/^select:/,'').split(/[ ,]+/).filter(Boolean)
      return embeddedCatalog.filter(t=>names.has(t.name)&&terms.some((q:string)=>(t.name+' '+t.description).toLowerCase().includes(q))).slice(0,a.max_results??5)
    }
    case 'WaitForMcpServers': {
      const until=Date.now()+50000
      for(;;){
        signal.throwIfAborted()
        const clients=ctx.getAppState().mcp?.clients??ctx.options.mcpClients
        const states=Object.fromEntries((a.servers??clients.map(c=>c.name)).map((n:string)=>[n,clients.find(c=>c.name===n)?.type??'unknown']))
        if(!Object.values(states).includes('pending')||Date.now()>=until)return states
        await Bun.sleep(150)
      }
    }
    case 'ScheduleWakeup': {
      if(a.noop)return {scheduled:wakeups.has(who)}
      if(!a.stop&&(!Number.isFinite(a.delaySeconds)||a.delaySeconds<=0||a.delaySeconds>2147483||!a.prompt?.trim()))throw Error('Expected a positive delay and a prompt')
      if(ctx.options.isNonInteractiveSession)throw Error('Wakeups require an interactive session')
      clearTimeout(wakeups.get(who));wakeups.delete(who)
      if(a.stop)return {scheduled:false}
      wakeups.set(who,setTimeout(()=>{wakeups.delete(who);enqueue({mode:'prompt',value:a.prompt})},a.delaySeconds*1000))
      return {scheduled:true,delaySeconds:a.delaySeconds}
    }
    case 'Monitor': {
      if(Boolean(a.command)===Boolean(a.ws))throw Error('Specify one command or WebSocket')
      const id=job(ctx,'monitor',signal=>{
        if(a.ws)return monitorSocket(a,signal)
        const input={command:a.command,timeout:Math.min(55000,a.timeout_ms)}
        if(process.platform==='win32')return monitorPowerShell(input,ctx,canUseTool,signal)
        return execute(root,'Bash',input,signal)
      })
      return {task_id:id}
    }
    case 'Workflow': {
      const previous=a.resumeFromRunId?workflows.get(a.resumeFromRunId):undefined
      if(a.resumeFromRunId&&previous?.owner!==who)throw Error('Unknown workflow run')
      let script=a.script??previous?.script
      if(a.name&&!/^[\w-]+$/.test(a.name))throw Error('Invalid workflow name')
      if(a.scriptPath||(!script&&a.name)){
        script=await readWorkflow(root,a.scriptPath??'.claude/workflows/'+a.name+'.js')
      }
      if(typeof script!=='string'||!/^\s*export\s+const\s+meta\s*=/.test(script))throw Error('Expected a workflow script beginning with export const meta')
      const cache=new Map(previous?.cache)
      const inference = sessionInference(ctx.getAppState())
      const id=job(ctx,'wf',async s=>{
        const {nativeGateway}=await import('./native')
        if(!nativeGateway)throw Error('No fixed pool')
        return evaluateWorkflow(script,a.args,s,p=>nativeGateway.client.run(root,p,false,async()=>false,{inference,names:[],signal:s,call:async()=>{throw Error('Unexpected tool')}}),cache)
      })
      workflows.set(id,{script,cache,owner:who})
      return {status:'async_launched',taskId:id,runId:id,taskType:'local_workflow'}
    }
    default:throw Error('Unknown local session tool')
  }
}
const names=new Set(['ListAgents','SendMessage','ReportFindings','EndConversation','SubagentHandback','ToolSearch','WaitForMcpServers','ScheduleWakeup','Monitor','Workflow'])
const validator=new Ajv({strict:false})
export const sessionTools=embeddedCatalog.filter(d=>names.has(d.name)).map(d=>{
  const valid=validator.compile(d.inputSchema)
  return buildTool({
    name:d.name,searchHint:d.description,maxResultSizeChars:50000,
    inputSchema:z.object({}).passthrough(),inputJSONSchema:d.inputSchema,
    async prompt(){return d.description},async description(){return d.description},
    isReadOnly(){return !d.requires_approval},
    async validateInput(args){return valid(args)?{result:true}:{result:false,message:validator.errorsText(valid.errors),errorCode:1}},
    renderToolUseMessage(input){return <Text>{JSON.stringify(input)}</Text>},
    renderToolResultMessage(data){return <Text>{JSON.stringify(data)}</Text>},
    async call(args,ctx,canUseTool){return {data:await local(d.name,args,ctx,canUseTool)}},
    mapToolResultToToolResultBlockParam(data,id){return {type:'tool_result',tool_use_id:id,content:typeof data==='string'?data:JSON.stringify(data)}},
  })
})
