import { drainPendingMessages } from '../tasks/LocalAgentTask/LocalAgentTask'
import { additionalRoots, workspacePath, workspaceForTarget } from './workspace'
import { fileHistoryTrackEdit } from '../utils/fileHistory'
import { existsSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { getPlanFilePath } from '../utils/plans'
import { executorOS, shellProfiles } from './platform'
import { findToolByName } from '../Tool'
import type { QueryParams } from '../query'
import { runTools } from '../services/tools/toolOrchestration'
import { createAssistantAPIErrorMessage, createAssistantMessage, createUserMessage } from '../utils/messages'
import { hasPermissionsToUseTool } from '../utils/permissions/permissions'
import { Stream } from '../utils/stream'
import { getCwd } from '../utils/cwd'
import { checkWorkspaceTarget, execute, fileTools, tools as guardedTools, mutations } from './tools'
import { sessionInference, type InferenceOptions } from './inference'
import type { Gateway } from './client'
import { conversationPrompt, conversationImages, remoteContinuation } from './transcript'
import { autoReviewPrompt } from './autoReview'
import { embeddedCatalog } from './registry'

type Connection = { client: Gateway; root: string; textOnly: boolean; inference?: () => InferenceOptions }
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
    const state = context.getAppState()
    const inference = sessionInference(state)
    if (!context.agentId) nativeGateway!.inference = () => sessionInference(context.getAppState())
    const mode = state.toolPermissionContext.mode
    const plan = mode==='plan' ? 'Session plan file: '+getPlanFilePath(context.agentId)+'\n' : ''
    const extraRoots = () => additionalRoots(context.getAppState().toolPermissionContext.additionalWorkingDirectories)
    const roots = extraRoots()
    const directories = roots.length ? 'Additional workspace directories: '+JSON.stringify(roots)+'\n' : ''
    const guidance = existsSync(resolve(root,'CLAUDE.md')) && !textOnly ? 'Read the project CLAUDE.md with Read for repository instructions.\n' : ''
    const workspace = role+plan+directories+guidance+"Permission mode: "+mode+"\nWorkspace OS: "+executorOS()+". Use workspace-relative file paths. Workspace cwd: "+JSON.stringify(root)+"\n\n"
    const continuation = context.agentId ? {messages:params.messages, parent:undefined} : remoteContinuation(params.messages)
    let checkpoint: string | undefined
    const input = workspace+conversationPrompt(continuation.messages,16000-Buffer.byteLength(workspace))
    const run = (prompt:string, images:ReturnType<typeof conversationImages>) => client.run(root, prompt, !textOnly, async()=>false, {
      session: context.agentId ? undefined : {parent:continuation.parent, saved:id=>{checkpoint=id}},
      inference, images, names: available.map(d=>d.name),
      signal: controller.signal,
      call: async (name,args,id,signal,review) => {
        const workspaceRoot = getCwd()
        const spec = available.find(d=>d.name===name)
        const tool = findToolByName(context.options.tools, name)
        if (!spec || !tool) throw Error('Unavailable in this session')
        if(fileTools.includes(name) && typeof args.file_path==='string'){
          const path=workspacePath(workspaceRoot,args.file_path)
          const isPlan=context.getAppState().toolPermissionContext.mode==='plan' && path===getPlanFilePath(context.agentId)
          if (isPlan) checkWorkspaceTarget(dirname(path),path)
          else workspaceForTarget(workspaceRoot,extraRoots(),path)
          args={...args,file_path:path}
        }
        if ((name==='Grep' || name==='Glob') && typeof args.path==='string') args={...args,path:workspacePath(workspaceRoot,args.path)}
        if (name==='LSP' && typeof args.filePath==='string') args={...args,filePath:workspacePath(workspaceRoot,args.filePath)}
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
          const activeRoots = extraRoots()
          const target = args.file_path ?? args.filePath ?? args.path ?? '.'
          const fileRoot = planFile ? dirname(planPath!) :
            (guardedTools.includes(name) || name==='LSP') ? workspaceForTarget(workspaceRoot,activeRoots,target) : workspaceRoot
          if(process.platform==='win32' && (guardedTools.includes(name)||name==='LSP')){
            checkWorkspaceTarget(fileRoot,args.file_path??args.filePath??args.path??'.')
          }
          // A child can always return its own final text to the parent that launched it.
          const returningToParent = name==='SubagentHandback' && Boolean(context.agentId)
          const requiresApproval = !returningToParent && (spec.requires_approval || mutations.has(name))
          if (context.getAppState().toolPermissionContext.mode==='dontAsk' && tool.requiresUserInteraction?.()) throw Error('Interaction disabled in dontAsk mode')
          const isShell=name==='Bash' || name==='PowerShell'
          const readOnlyShell=isShell && tool.isReadOnly(tool.inputSchema.parse(args))
          if (planning && !planFile && !readOnlyShell && (mutations.has(name) || ['Monitor','Workflow','EnterWorktree','ExitWorktree','Task'].includes(name)))
            throw Error('Workspace mutations are disabled in plan mode')
          const gate: typeof params.canUseTool = async (t,a,c,m,callId,force) => {
            const currentMode=c.getAppState().toolPermissionContext.mode
            if (!requiresApproval || t.name!==tool.name || callId!==id) return params.canUseTool(t,a,c,m,callId,force)
            // Evaluate an ordinary Auto edit against the same local rules as acceptEdits
            // before an independent, tool-free turn can review the proposed change.
            const reviewAction=currentMode==='auto' && (name==='Write' || name==='Edit' || readOnlyShell)
            const checked=reviewAction ? {...c,getAppState:()=>{
              const state=c.getAppState()
              return {...state,toolPermissionContext:{...state.toolPermissionContext,mode:'acceptEdits' as const}}
            }} : c
            const decision=await hasPermissionsToUseTool(t,a,checked,m,callId)
            if(decision.behavior==='deny')return decision
            if(force && force.behavior!=='allow'){
              if(force.behavior==='ask' && (currentMode==='dontAsk' || c.options.isNonInteractiveSession))return {behavior:'deny',message:'Local approval required'}
              return params.canUseTool(t,a,c,m,callId,force)
            }
            if(reviewAction && decision.behavior==='allow'){
              const prompt=autoReviewPrompt(params.messages,name,decision.updatedInput??a)
              if(!prompt)return {behavior:'deny',message:'Auto review needs a complete, bounded request'}
              const allowed=await review(prompt)
              if(!allowed || local.signal.aborted || c.getAppState().toolPermissionContext.mode!=='auto')
                return {behavior:'deny',message:'Auto review declined or unavailable'}
              return decision
            }
            if(currentMode==='auto' && isShell && !readOnlyShell && decision.behavior==='allow' && decision.decisionReason?.type!=='rule'){
              if(c.options.isNonInteractiveSession)return {behavior:'deny',message:'Shell command needs local approval'}
              return params.canUseTool(t,a,c,m,callId,{behavior:'ask',message:'Approve this shell command',updatedInput:a})
            }
            if(currentMode!=='default' && (guardedTools.includes(name) || name==='PowerShell' || currentMode==='bypassPermissions' || decision.decisionReason?.type==='rule')){
              return params.canUseTool(t,a,c,m,callId,decision)
            }
            if(currentMode==='dontAsk' || c.options.isNonInteractiveSession)return {behavior:'deny',message:'Local approval required'}
            return params.canUseTool(t,a,c,m,callId,{behavior:'ask',message:'Approve this operation in the local workspace',updatedInput:a})
          }
          // Preserve workspace confinement for the file and shell handlers. Native
          // tool definitions still supply input validation, rendering and approval.
          let toolContext={...context,abortController:local}
          if(process.platform!=='win32' && guardedTools.includes(name)) {
            tool.inputSchema.parse(args)
            const approved = await gate(tool,args,toolContext,assistant,id)
            if(approved.behavior!=='allow')throw Error(approved.message || 'User denied the request')
            if(context.getAppState().toolPermissionContext.mode==='plan' && mutations.has(name) && !readOnlyShell && !planFile)throw Error('Workspace mutations are disabled in plan mode')
            const finalArgs = approved.updatedInput??args
            if(planFile && resolve(workspaceRoot,finalArgs.file_path)!==planPath) throw Error('Unexpected plan file')
            if (!planFile && (name==='Edit' || name==='Write')) {
              workspaceForTarget(workspaceRoot,activeRoots,finalArgs.file_path)
              await fileHistoryTrackEdit(context.updateFileHistoryState,finalArgs.file_path,assistant.uuid)
            }
            reply=await execute(fileRoot,name,planFile ? {...finalArgs,file_path:basename(planPath!)} : finalArgs,signal,activeRoots)
            const resultMessage = createUserMessage({content:[{type:'tool_result',tool_use_id:id,content:reply}]})
            events.enqueue(!planFile && (name==='Edit' || name==='Write')
              ? {...resultMessage, gatewayEditedFile:finalArgs.file_path}
              : resultMessage)
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
        const answer=await run(prompt,conversationImages(context.agentId ? history : continuation.messages))
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
    void runConversation().then(answer=>{events.enqueue({...createAssistantMessage({content:answer}), ...(checkpoint ? {gatewayCheckpoint:checkpoint} : {})});events.done()},e=>events.error(e))
    for await(const msg of events)yield msg
  } catch (error) {
    if (!parent.aborted) {
      const reason = error instanceof Error ? error.message : 'Gateway request failed'
      yield createAssistantAPIErrorMessage({content:'本轮未完成：' + reason})
    }
  } finally {
    controller.abort()
    parent.removeEventListener('abort',abort)
  }
  return {reason:'completed' as const}
}
