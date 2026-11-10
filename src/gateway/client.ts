import {rootCertificates} from 'node:tls'
import {configureKey,defaultKeyPath} from './configure'
import { executorOS, shellProfiles } from './platform'
import { constants, closeSync, fstatSync, openSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { parseArgs, stripVTControlCharacters } from 'node:util'
import { EndTruncatingAccumulator } from '../utils/stringUtils'
import { execute, inside, mutations, tools } from './tools'

const defaultEndpoint = new URL('wss://8.153.176.226/v1/ws')

const usage = 'cc-a config set-key\ncc-a [--key-file FILE] [--workspace DIR] [--url URL] [message | -p "message"] [--text-only] [--continue | --resume SESSION] [--mcp-config FILE] [--simple]'
const safe = (s: string) => stripVTControlCharacters(s).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
const ui = (s: string) => process.stderr.write(safe(s))
type Ask = (s: string, signal: AbortSignal) => Promise<boolean>

function checkWindowsKey(path: string) {
  // NTFS permissions are represented by ACLs rather than POSIX mode bits.
  const script = [
    "$ErrorActionPreference='Stop'",
    "$file=Get-Item -LiteralPath $env:CC_A_CHECK_KEY",
    "if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) {exit 20}",
    "$acl=Get-Acl -LiteralPath $file.FullName",
    "$sid=[Security.Principal.SecurityIdentifier]",
    "$user=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value",
    "if ($acl.GetOwner($sid).Value -ne $user) {exit 21}",
    "$allowed=@($user,'S-1-5-18','S-1-5-32-544')",
    "foreach($ace in $acl.GetAccessRules($true,$true,$sid)){if($ace.AccessControlType -eq 'Allow' -and $allowed -notcontains $ace.IdentityReference.Value){exit 22}}",
  ].join(';')
  const shell=resolve(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')
  const res=spawnSync(shell,['-NoLogo','-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,CC_A_CHECK_KEY:path},stdio:'ignore',timeout:60000})
  if((res.error as NodeJS.ErrnoException | undefined)?.code==='ETIMEDOUT')throw Error('Timed out checking the Windows key permissions')
  if(res.error)throw Error('Unable to start Windows PowerShell to check key permissions')
  if(res.status===20)throw Error('Windows key must be a regular file without a reparse point')
  if(res.status===21)throw Error('Windows key must be owned by the current user')
  if(res.status===22)throw Error('Limit Windows key access to the current user, SYSTEM and Administrators')
  if(res.status!==0)throw Error('Unable to verify key permissions with Windows PowerShell')
}

function loadKey(path: string) {
  if(process.platform==='win32')checkWindowsKey(path)
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const s = fstatSync(fd)
    if (!s.isFile() || (process.platform!=='win32' && (s.uid !== process.getuid?.() || (s.mode & 0o077))) || s.size > 256) throw new Error('A key file must be a private, user-owned regular file (0600)')
    const key = readFileSync(fd,'utf8').trim()
    if (!/^gw1_[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Invalid gateway key')
    return key
  } finally {closeSync(fd)}
}

type Frame = Record<string, any>

type NativeDispatch = {
  names: string[]
  signal: AbortSignal
  call: (name:string,args:Record<string,any>,id:string,signal:AbortSignal)=>Promise<string>
}
export class Gateway {
  private turns = new Map<string, { event: (frame: Frame) => void; fail: (why: string) => void }>()
  private opened: Promise<void>
  private socket: WebSocket
  // Keep local approvals and mutations ordered across both VM slots.
  private local = Promise.resolve()

  constructor(url: URL, key: string, private readonly idleTimeoutMs=145000) {
    const tls = url.origin === defaultEndpoint.origin
      ? {ca:[...rootCertificates,readFileSync(resolve(import.meta.dir,'gateway-ca.crt'),'utf8')],rejectUnauthorized:true}
      : undefined
    this.socket = new WebSocket(url.href, { headers: { Authorization: 'Bearer ' + key }, tls })
    this.opened = new Promise((ok, fail) => {
      const timer = setTimeout(() => { fail(Error('Gateway connection timed out')); this.close() }, 12000)
      this.socket.onopen = () => { clearTimeout(timer); ok() }
      this.socket.onerror = () => {
        clearTimeout(timer)
        fail(Error('Gateway connection failed. Check the gateway address, TLS certificate, A key and pool connection.'))
        this.close()
      }
      this.socket.onclose = event => {
        clearTimeout(timer)
        const why = 'Gateway disconnected (' + event.code + ')'
        fail(Error(why))
        for (const turn of this.turns.values()) turn.fail(why)
      }
    })
    this.socket.onmessage = event => {
      try {
        if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 65536) throw Error()
        const frame = JSON.parse(event.data)
        const turn = this.turns.get(frame.id)
        if (!turn) throw Error()
        turn.event(frame)
      } catch {
        for (const turn of this.turns.values()) turn.fail('Invalid gateway event')
        this.close()
      }
    }
  }

  ready() { return this.opened }
  close() { this.socket.close() }

  async run(root: string, text: string, enabled: boolean, ask: Ask, native?: NativeDispatch): Promise<string> {
    if (!text.trim() || Buffer.byteLength(text) > 16000) throw Error('Prompt must be 1–16000 bytes')
    await this.opened
    if (this.socket.readyState !== WebSocket.OPEN) throw Error('Gateway connection closed')
    native?.signal.throwIfAborted()
    const id = crypto.randomUUID()
    return new Promise((ok, fail) => {
      const seen = new Set<string>()
      const pending = new Map<string, AbortController>()
      const result = new EndTruncatingAccumulator(2 << 20)
      let started = false
      const drain = (why?: string) => {
        // Drain the cancelled turn until C reports its end, keeping sibling turns live.
        finish(why)
        if(this.socket.readyState!==WebSocket.OPEN)return
        this.turns.set(id,{fail:()=>this.turns.delete(id),event:m=>{
          if(m.type==='agent.turn.completed'||m.type==='agent.error')this.turns.delete(id)
          if(m.type==='tool.request')this.socket.send(JSON.stringify({type:'tool.result',id,call_id:m.call_id,status:'denied',text:'Turn cancelled'}))
        }})
        this.socket.send(JSON.stringify({type:'user.cancel',id}))
      }
      const abort = () => drain('Cancelled')
      const finish = (why?: string) => {
        if (!this.turns.delete(id)) return
        native?.signal.removeEventListener('abort',abort)
        clearTimeout(timer)
        for (const ctrl of pending.values()) ctrl.abort()
        if (why) fail(Error(why)); else ok(result.toString())
      }
      // Tool approvals and streamed output are progress within the same turn.
      // Cancel only the idle turn so an active subagent can finish on this connection.
      const timer = setTimeout(() => drain('Gateway turn timed out'), this.idleTimeoutMs)
      native?.signal.addEventListener('abort',abort,{once:true})
      this.turns.set(id, {fail: finish, event: m => {
        timer.refresh()
        if (m.type === 'agent.error') return finish('Gateway: ' + safe(String(m.text)))
        if (m.type === 'agent.turn.started' && !started) { started = true; return }
        if (!started) throw Error()
        if (m.type === 'agent.text.delta' && typeof m.text === 'string') {
          result.append(m.text)
          if (result.truncated) throw Error()
          return
        }
        if (m.type === 'agent.turn.completed') return finish()
        if (m.type === 'tool.cancel') { pending.get(m.call_id)?.abort(); return }
        if (m.type !== 'tool.request' || !enabled || typeof m.call_id !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,64}$/.test(m.call_id) || seen.has(m.call_id) || pending.size >= 8) throw Error()
        seen.add(m.call_id)
        const ctrl = new AbortController()
        pending.set(m.call_id, ctrl)
        const timeout = setTimeout(() => ctrl.abort(), 65000)
        const dispatch = async () => {
          let status = 'ok', reply = ''
          try {
            ctrl.signal.throwIfAborted()
            if (!(native?.names ?? tools).includes(m.tool)) throw Error('Tool unavailable on this client. Available: ' + (native?.names??tools).join(', '))
            if (!m.arguments || typeof m.arguments !== 'object' || Array.isArray(m.arguments)) throw Error('Invalid tool arguments')
            if(native){
              reply=await native.call(m.tool,m.arguments,m.call_id,ctrl.signal)
            } else if ((mutations.has(m.tool) || m.requires_approval === true) && !await ask(m.tool + ' ' + JSON.stringify(m.arguments), ctrl.signal)) {
              status = 'denied'
              reply = 'User approval required'
            } else {
              ctrl.signal.throwIfAborted()
              reply = await execute(root, m.tool, m.arguments, ctrl.signal)
            }
            if (Buffer.byteLength(JSON.stringify(reply)) > 54000) throw Error('Tool response exceeds gateway limit. Request a smaller range.')
          } catch (err) {
            status = 'error'
            reply = String(err instanceof Error ? err.message : 'Local tool failed').slice(0,3000)
          } finally {
            clearTimeout(timeout)
            pending.delete(m.call_id)
          }
          if (this.turns.has(id) && this.socket.readyState === WebSocket.OPEN) {
            if(!ctrl.signal.aborted)timer.refresh()
            this.socket.send(JSON.stringify({type:'tool.result', id, call_id:m.call_id, status, text:reply}))
            if(native && status==='ok' && ['EndConversation','SubagentHandback'].includes(m.tool)){
              result.append(reply)
              drain()
            }
          }
        }
        if(native)void dispatch().catch(()=>finish('Could not return tool result'))
        else this.local=this.local.then(dispatch).catch(()=>finish('Could not return tool result'))
      }})
      this.socket.send(JSON.stringify({type:'user.message', id, text, tools:enabled, tool_names:native?.names??tools,
        shells:enabled ? shellProfiles(root,native?.names??tools) : {}}))
    })
  }
}

export async function gatewayMain(args: string[]) {
  if(args[0]==='config' && args[1]==='set-key'){
    if(args.length!==2)throw Error('用法：cc-a config set-key（通过提示或标准输入提供密钥）')
    return configureKey()
  }
  const {values:v,positionals,tokens}=parseArgs({args,allowPositionals:true,tokens:true,options:{
    'continue':{type:'boolean',short:'c'},resume:{type:'string',short:'r'},'mcp-config':{type:'string'},native:{type:'boolean'},simple:{type:'boolean'},'key-file':{type:'string'},workspace:{type:'string'},url:{type:'string'},
    print:{type:'boolean',short:'p'},prompt:{type:'string',multiple:true},'text-only':{type:'boolean'},help:{type:'boolean',short:'h'}
  }})
  if(v.help){console.log(usage);return}
  const printCount=tokens.filter(t=>t.kind==='option' && t.name==='print').length
  if(positionals.length>Math.max(1,printCount) || (v.prompt?.length && positionals.length))throw Error(usage)
  let initialPrompt:string|undefined
  if(v.print){
    if(positionals.length)v.prompt=positionals
    else if(!v.prompt?.length){
      if(process.stdin.isTTY)throw Error('Supply a prompt or pipe text to --print')
      const chunks:Buffer[]=[]
      let bytes=0
      for await(const chunk of process.stdin){
        const data=Buffer.from(chunk)
        bytes+=data.length
        if(bytes>16000)throw Error('Prompt exceeds the gateway limit (16000 bytes)')
        chunks.push(data)
      }
      const input=Buffer.concat(chunks).toString('utf8')
      if(!input.trim())throw Error('Empty prompt')
      v.prompt=[input]
    }
  }else initialPrompt=positionals[0]
  if(initialPrompt&&v.simple)throw Error('Positional prompts require the native CLI')
  executorOS()
  if(process.platform==='win32' && (v.simple || (v.prompt?.length??0)>1))throw Error('Use the native CLI on Windows, with one prompt per process')
  const base=process.env.CC_A_START_DIR||process.cwd()
  const keyPath=resolve(base,v['key-file']||process.env.CC_A_KEY_FILE||defaultKeyPath())
  const root=realpathSync(resolve(base,v.workspace||'.'))
  if(!statSync(root).isDirectory())throw Error('Invalid workspace directory')
  if(!v['text-only']&&(inside(root,realpathSync(keyPath))||inside(root,homedir())))throw Error('Choose a project workspace separate from the gateway credentials')
  const url=new URL(v.url||process.env.CC_GATEWAY_URL||defaultEndpoint.href)
  if(url.username||url.password||url.search||url.hash||!(url.protocol==='wss:'||url.protocol==='ws:'&&['127.0.0.1','[::1]'].includes(url.hostname)))throw Error('Use WSS for a remote gateway or WS on loopback')
  const key=loadKey(keyPath)
  const terminal=v.simple ? process.stderr : process.stdout
  const interactive=Boolean(process.stdin.isTTY && terminal.isTTY)
  if(!interactive&&!v.prompt)throw Error('Interactive mode needs a terminal for input and output. Use -p to run a prompt without a terminal.')
  if (v.continue && v.resume) throw Error('Choose --continue or --resume')
  if (v.native || (!v.simple && (v.prompt?.length ?? 0) <= 1)){
    if(v.prompt && v.prompt.length!==1) throw Error('Native print mode accepts one prompt')
    const gateway=new Gateway(url,key)
    await gateway.ready()
    let cleanup: (()=>void) | undefined
    try{
      const scope=createHash('sha256').update(key).digest('hex').slice(0,24)
      const state=process.platform==='win32' ? resolve(process.env.LOCALAPPDATA||resolve(homedir(),'AppData/Local'),'cc-a',scope) : resolve(dirname(keyPath),'.cc-a-state',scope)
      mkdirSync(state,{recursive:true,mode:0o700})
      process.env.CLAUDE_CONFIG_DIR=state
      process.env.DISABLE_AUTOUPDATER='1'
      process.env.DISABLE_INSTALLATION_CHECKS='1'
      process.env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL='1'
      process.env.DISABLE_TELEMETRY='1'
      process.env.ENABLE_LSP_TOOL='1'
      process.chdir(root)
      process.env.CC_A_NATIVE='1'
      if(process.platform==='win32'){
        process.env.CLAUDE_CODE_USE_POWERSHELL_TOOL='1'
        process.env.USE_BUILTIN_RIPGREP??='0'
      }
      process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC='1'
      process.env.CLAUDE_CODE_ENABLE_TASKS='1'
      process.env.ANTHROPIC_BASE_URL='http://127.0.0.1:1'
      process.env.ANTHROPIC_API_KEY='local-gateway'
      delete process.env.ANTHROPIC_AUTH_TOKEN
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      const {setNativeGateway}=await import('./native')
      const {closeSessionTools}=await import('./sessionTools')
      setNativeGateway({client:gateway,root,textOnly:!!v['text-only']})
      cleanup=()=>{closeSessionTools();setNativeGateway(undefined)}
      const {embeddedCatalog}=await import('./registry')
      const names=embeddedCatalog.map(d=>d.name==='Task'?'Agent':d.name).join(',')
      process.argv=[process.argv[0]!,process.argv[1]!,...(process.env.CC_A_DEBUG_FILE?['--debug-file',process.env.CC_A_DEBUG_FILE]:[]),'--setting-sources','','--strict-mcp-config',...(v['mcp-config']?['--mcp-config',realpathSync(resolve(base,v['mcp-config']))]:[]),'--tools',v['text-only']?'':names,...(v.continue?['--continue']:v.resume?['--resume',v.resume]:[]),...(v.prompt?['-p',v.prompt[0]!]:initialPrompt?['--',initialPrompt]:[])]
      await (await import('../main')).main()
    }finally{
      gateway.close()
      cleanup?.()
    }
    return
  }
  const rl=interactive?createInterface({input:process.stdin,output:process.stderr}):undefined
  const ask:Ask=async(s,signal)=>!!rl&&(await rl.question('允许在本机执行 '+safe(s)+'？[y/N] ',{signal})).trim().toLowerCase()==='y'
  const gateway = new Gateway(url,key)
  try{
    await gateway.ready()
    if(v.prompt){
      if(v.prompt.length>2) throw Error('Specify at most two concurrent prompts')
      const results=await Promise.allSettled(v.prompt.map(text=>gateway.run(root,text,!v['text-only'],ask)))
      for(const result of results) {
        if(result.status==='fulfilled') console.log(safe(result.value))
        else {ui(safe(String(result.reason))+'\n');process.exitCode=1}
      }
      return
    }
    ui(executorOS()+' 工作区 '+root+'，输入 /exit 结束。每条消息独立执行。\n')
    while(rl){
      const prompt=await rl.question('A> ')
      if(prompt.trim()==='/exit')break
      if(!prompt.trim())continue
      try{console.log(safe(await gateway.run(root,prompt,!v['text-only'],ask)))}catch(err){ui(String(err)+'\n')}
    }
  }finally{gateway.close();rl?.close()}
}
