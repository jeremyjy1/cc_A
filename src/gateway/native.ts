import { drainPendingMessages } from '../tasks/LocalAgentTask/LocalAgentTask'
import { basename, dirname, resolve } from 'node:path'
import { getPlanFilePath } from '../utils/plans'
import { executorOS, shellProfiles } from './platform'
import { findToolByName } from '../Tool'
import type { QueryParams } from '../query'
import { runTools } from '../services/tools/toolOrchestration'
import { createAssistantMessage, createUserMessage } from '../utils/messages'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions'
import { Stream } from '../utils/stream'
import { getCwd } from '../utils/cwd'
import { checkWorkspaceTarget, execute, fileTools, tools as guardedTools, mutations } from './tools'
import type { Gateway } from './client'
import { conversationPrompt } from './transcript'
import { embeddedCatalog } from './registry'

type Connection = { client: Gateway; root: string; textOnly: boolean }
export let nativeGateway: Connection | undefined
export function setNativeGateway(connection?: Connection) { nativeGateway = connection }

export async function* nativeQuery(params: QueryParams) {
  const {client, textOnly} = nativeGateway!
  const root=getCwd()
  const controller = new AbortController()
  const parent = params.toolUseContext.abortController.signal
  const abort = () => controller.abort()
  parent.addEventListener('abort', abort, {once:true})
  if (parent.aborted) abort()
  const events = new Stream<any>()
  let context = params.toolUseContext
  const shells = shellProfiles(root,['Bash','PowerShell'])
  const available = embeddedCatalog.filter(d => {
    const tool = findToolByName(context.options.tools, d.name)
    if((d.name==='Bash'||d.name==='PowerShell') && !shells[d.name])return false
    return tool && tool.isEnabled()
  })
  try {
    const role = context.agentId ? "Subagent instructions: "+(params.systemPrompt[0]??"")+"\n" : ""
    const mode = context.getAppState().toolPermissionContext.mode
    const plan = mode==='plan' ? 'Session plan file: '+getPlanFilePath(context.agentId)+'\n' : ''
    const workspace = role+plan+"Permission mode: "+mode+"\nWorkspace OS: "+executorOS()+". Use workspace-relative file paths. Workspace cwd: "+JSON.stringify(root)+"\n\n"
    const input = workspace+conversationPrompt(params.messages,16000-Buffer.byteLength(workspace))
    const run = (prompt:string) => client.run(root, prompt, !textOnly, async()=>false, {
      names: available.map(d=>d.name),
      signal: controller.signal,
      call: async (name,args,id,signal) => {
        const workspaceRoot = getCwd()
        const spec = available.find(d=>d.name===name)
        const tool = findToolByName(context.options.tools, name)
        if (!spec || !tool) throw Error('Unavailable in this session')
        if(fileTools.includes(name) && typeof args.file_path==='string'){
          const path=resolve(workspaceRoot,args.file_path)
          const isPlan=context.getAppState().toolPermissionContext.mode==='plan' && path===getPlanFilePath(context.agentId)
          checkWorkspaceTarget(isPlan?dirname(path):workspaceRoot,path)
          args={...args,file_path:path}
        }
        const block = {type:'tool_use' as const, id, name:tool.name, input:args}
        const assistant = createAssistantMessage({content:[block]})
        events.enqueue(assistant)
        const local = new AbortController()
        const cancel = () => local.abort()
        signal.addEventListener('abort',cancel,{once:true})
        if(signal.aborted)cancel()
        let reply: string | undefined
        const skillInstructions: string[] = []
        let failed=false
        try {
          const planning = context.getAppState().toolPermissionContext.mode==='plan'
          const planPath = planning && fileTools.includes(name) ? getPlanFilePath(context.agentId) : undefined
          const planFile = planPath && typeof args.file_path==='string' && resolve(workspaceRoot,args.file_path)===planPath
          const fileRoot = planFile ? dirname(planPath!) : workspaceRoot
          if(process.platform==='win32' && (guardedTools.includes(name)||name==='LSP')){
            checkWorkspaceTarget(fileRoot,args.file_path??args.filePath??args.path??'.')
          }
          // A child can always return its own final text to the parent that launched it.
          const returningToParent = name==='SubagentHandback' && Boolean(context.agentId)
          const requiresApproval = !returningToParent && (spec.requires_approval || mutations.has(name))
          if (requiresApproval && context.options.isNonInteractiveSession) throw Error('Local approval required')
          if (mutations.has(name) && planning && !planFile) throw Error('Workspace mutations are disabled in plan mode')
          const gate: typeof params.canUseTool = async (t,a,c,m,callId,force) => {
            if (!requiresApproval || t.name!==tool.name || callId!==id) return params.canUseTool(t,a,c,m,callId,force)
            const decision = await hasPermissionsToUseTool(t,a,c,m,callId)
            if(decision.behavior==='deny') return decision
            if(c.options.isNonInteractiveSession) return Promise.resolve({behavior:'deny',message:'Local approval required'})
            return params.canUseTool(t,a,c,m,callId,{behavior:'ask',message:'Approve this operation in the local workspace',updatedInput:a})
          }
          // Preserve workspace confinement for the file and shell handlers. Native
          // tool definitions still supply input validation, rendering and approval.
          let toolContext={...context,abortController:local}
          if(process.platform!=='win32' && guardedTools.includes(name)) {
            tool.inputSchema.parse(args)
            const approved = await gate(tool,args,toolContext,assistant,id)
            if(approved.behavior!=='allow')throw Error('User denied the request')
            const finalArgs = approved.updatedInput??args
            if(planFile && resolve(workspaceRoot,finalArgs.file_path)!==planPath) throw Error('Unexpected plan file')
            reply=await execute(fileRoot,name,planFile ? {...finalArgs,file_path:basename(planPath!)} : finalArgs,signal)
            events.enqueue(createUserMessage({content:[{type:'tool_result',tool_use_id:id,content:reply}]}))
          } else {
            for await(const update of runTools([block],[assistant],gate,toolContext)){
              if(update.newContext)context={...update.newContext,abortController:context.abortController}
              const msg=update.message
              if(!msg)continue
              events.enqueue(msg)
              if(msg.type==='user' && name==='Skill' && msg.isMeta){
                const content=msg.message.content
                if(typeof content==='string')skillInstructions.push(content)
                else for(const part of content)if(part.type==='text')skillInstructions.push(part.text)
              }
              if(msg.type!=='user'||!Array.isArray(msg.message.content))continue
              for(const b of msg.message.content){if(b.type==='tool_result'&&b.tool_use_id===id){
                failed=!!b.is_error
                reply=typeof b.content==='string'?b.content:JSON.stringify(b.content??'')
              }}
            }
          }
          if(failed||reply===undefined)throw Error(reply||'Tool returned no result')
          if(skillInstructions.length)reply += '\n'+skillInstructions.join('\n')
          return name==='EnterPlanMode' ? reply+'\nSession plan file: '+getPlanFilePath(context.agentId) : reply
        } catch(error) {
          if(reply===undefined)events.enqueue(createUserMessage({content:[{type:'tool_result',tool_use_id:id,is_error:true,content:String(error)}]}))
          throw error
        } finally {signal.removeEventListener('abort',cancel)}
      }
    })
    async function runConversation() {
      let prompt=input
      const history=[...params.messages]
      for(;;){
        const answer=await run(prompt)
        if(!context.agentId)return answer
        const pending=drainPendingMessages(context.agentId,context.getAppState,context.setAppStateForTasks??context.setAppState)
        if(!pending.length)return answer
        const response=createAssistantMessage({content:answer})
        const followUp=createUserMessage({content:pending.join('\n')})
        history.push(response,followUp)
        events.enqueue(response)
        events.enqueue(followUp)
        prompt=workspace+conversationPrompt(history,16000-Buffer.byteLength(workspace))
      }
    }
    void runConversation().then(answer=>{events.enqueue(createAssistantMessage({content:answer}));events.done()},e=>events.error(e))
    for await(const msg of events)yield msg
    return {reason:'completed' as const}
  } finally {
    controller.abort()
    parent.removeEventListener('abort',abort)
  }
}
