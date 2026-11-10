import { linuxProcMount, sandboxedBashAvailable } from './platform'
import { spawn } from 'node:child_process'
import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs'
import { resolve, relative, sep, isAbsolute } from 'node:path'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants'

type Args = Record<string, any>
export const fileTools = ['Read', 'Write', FILE_EDIT_TOOL_NAME]
export const tools = [...fileTools, 'Glob', 'Grep', 'Bash']
export const mutations = new Set(['Write', FILE_EDIT_TOOL_NAME, 'Bash','PowerShell'])

export function inside(root: string, path: string) {
  const rel = relative(root, path)
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
}

// Check the existing portion of a Windows path before handing it to native
// tools. New files and directories still have to descend from the workspace.
export function checkWorkspaceTarget(root:string, path:string) {
  if(typeof path!=='string' || !path || path.includes('\0'))throw Error('Invalid workspace path')
  const target=resolve(root,path)
  if(!inside(root,target))throw Error('Outside workspace')
  const parts=relative(root,target).split(sep).filter(Boolean)
  const canonicalRoot=realpathSync(root)
  let parent=root
  for(const part of parts){
    if(part.toLowerCase()==='.git' || (process.platform==='win32' &&
      (part.includes(':') || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))throw Error('Invalid workspace path')
    parent=resolve(parent,part)
    try{
      const entry=lstatSync(parent)
      if(entry.isSymbolicLink() || (entry.isFile() && entry.nlink!==1) || !inside(canonicalRoot,realpathSync(parent))) {
        throw Error('Workspace link traversal denied')
      }
    }catch(err){
      if((err as NodeJS.ErrnoException).code==='ENOENT')continue
      throw err
    }
  }
}

function command(bin: string, args: string[], cwd: string, signal: AbortSignal, input = '', timeout = 55000, grep = false): Promise<string> {
  signal.throwIfAborted()
  return new Promise((ok, fail) => {
    const child = spawn(bin, args, {
      cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8', HOME: cwd },
    })
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    let received = 0, failure = ''
    const stopGroup = () => {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL') } catch { /* Already exited. */ }
      }
    }
    const stop = (why: string) => { failure = why; stopGroup() }
    const abort = () => stop('Local tool cancelled')
    const timer = setTimeout(() => stop('Local tool timed out'), timeout)
    signal.addEventListener('abort', abort, {once:true})
    const collect = (list: Buffer[], chunk: Buffer) => {
      received += chunk.length
      if (received > 512 * 1024) stop('Local tool exceeded output limit')
      else list.push(chunk)
    }
    child.stdout.on('data', chunk => collect(stdout, chunk))
    child.stderr.on('data', chunk => collect(stderr, chunk))
    child.on('error', () => { failure = 'Unable to start local tool' })
    child.once('exit', stopGroup)
    child.once('close', code => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      const errText = Buffer.concat(stderr).toString()
      if (failure || (code !== 0 && !(grep && code === 1))) fail(Error(failure || errText.trim() || 'Local tool failed'))
      else ok(Buffer.concat(stdout).toString() + (grep ? '' : errText))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  })
}

export async function execute(root: string, name: string, a: Args, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (fileTools.includes(name)) {
    return command('/usr/bin/python3', ['-I', import.meta.dir + '/files.py', name], root, signal, JSON.stringify(a))
  }
  if (name === 'Bash') {
    if (a.dangerouslyDisableSandbox || a.run_in_background || typeof a.command !== 'string') throw new Error('Only foreground sandboxed Bash is available')
    if (!sandboxedBashAvailable()) throw Error('Bash requires a working workspace sandbox')
    if (process.platform==='linux') {
      const binds = ['/usr','/bin','/lib','/lib64','/sbin'].filter(existsSync)
        .flatMap(path=>['--ro-bind',path,path])
      const gitDir=resolve(root,'.git')
      const gitProtection=existsSync(gitDir)?['--ro-bind',gitDir,gitDir]:[]
      const args=['--unshare-all','--die-with-parent','--new-session',...binds,'--dev','/dev',...linuxProcMount(),'--tmpfs','/tmp',
        '--bind',root,root,...gitProtection,'--chdir',root,'--','/bin/bash','--noprofile','--norc','-c',a.command]
      return command(Bun.which('bwrap')!,args,root,signal,'',Math.min(55000,Math.max(1,a.timeout??55000)))
    }
    const rules = '(version 1)(deny default)(import "system.sb")(allow file-map-executable (subpath "/Library/Developer/CommandLineTools") (subpath "/usr") (subpath "/bin") (subpath "/sbin"))(allow process-exec process-fork sysctl-read file-read-metadata)' +
      '(allow file-read* (subpath "/Library/Developer/CommandLineTools") (subpath "/System") (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/Library/Apple") (literal "/dev/null") (literal "/dev/urandom") (subpath (param "ROOT")))' +
      '(allow file-write* (subpath (param "ROOT")) (literal "/dev/null"))(deny file-write* (subpath (param "GIT")))'
    return command('/usr/bin/sandbox-exec', ['-D', 'ROOT=' + root, '-D', 'GIT=' + root + '/.git', '-p', rules, '/bin/bash', '--noprofile', '--norc', '-c', a.command], root, signal, '', Math.min(55000, Math.max(1, a.timeout ?? 55000)))
  }
  if (name !== 'Glob' && name !== 'Grep') throw new Error('Tool unavailable on this client')
  const target = realpathSync(resolve(root, a.path || '.'))
  if (!inside(root, target) || relative(root,target).split('/').some(p => p.toLowerCase() === '.git')) throw new Error('Outside workspace')
  if (typeof a.pattern !== 'string' || !a.pattern) throw new Error('Missing pattern')
  const rg = Bun.which('rg')
  if (!rg) throw new Error('ripgrep is required')
  const args = ['--no-config', '--color', 'never', '--no-follow', '-g', '!.git']
  if (name === 'Glob') {
    if (!statSync(target).isDirectory()) throw new Error('Glob path must be a directory')
    args.push('--files', '-g', a.pattern)
  } else {
    const mode = a.output_mode ?? 'files_with_matches'
    if (mode === 'count') args.push('--count')
    else if (mode === 'files_with_matches') args.push('--files-with-matches')
    else if (mode !== 'content') throw new Error('Invalid output mode')
    for (const f of ['-i', '-o']) if (a[f]) args.push(f)
    if (mode === 'content' && a['-n'] !== false) args.push('-n')
    for (const [k, f] of [['context','-C'],['-C','-C'],['-A','-A'],['-B','-B']]) if (Number.isSafeInteger(a[k]) && a[k]>=0) args.push(f, String(a[k]))
    if (a.multiline) args.push('--multiline','--multiline-dotall')
    if (a.glob) args.push('-g', a.glob)
    if (a.type) args.push('-t', a.type)
    args.push('-e', a.pattern)
  }
  args.push('--', relative(root, target) || '.')
  const lines = (await command(rg, args, root, signal, '', 15000, true)).trimEnd().split('\n')
  const offset = Math.max(0, a.offset ?? 0)
  return lines.slice(offset, offset + (a.head_limit || 250)).join('\n')
}
