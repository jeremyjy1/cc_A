import {spawnSync} from 'node:child_process'
import {existsSync} from 'node:fs'

export function executorOS(platform = process.platform, wsl = Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)) {
  switch (platform) {
    case 'darwin': return 'macOS'
    case 'linux': return wsl ? 'WSL' : 'Linux'
    case 'win32': return 'Windows'
    default: throw Error('Unsupported gateway client platform: ' + platform)
  }
}

let linuxSandbox: boolean | undefined
let procArgs: string[] = ['--proc','/proc']
export function linuxProcMount(): readonly string[] {
  sandboxedBashAvailable()
  return procArgs
}
export function sandboxedBashAvailable() {
  if(process.platform==='darwin')return existsSync('/usr/bin/sandbox-exec')
  if(process.platform!=='linux')return false
  if(linuxSandbox===undefined){
    const bwrap=Bun.which('bwrap')
    const probe=(args:string[])=>Boolean(bwrap && spawnSync(bwrap,[
      '--unshare-all','--die-with-parent','--ro-bind','/','/','--dev','/dev',...args,'--','/bin/true',
    ],{timeout:3000,stdio:'ignore'}).status===0)
    if(!probe(procArgs))procArgs=['--tmpfs','/proc']
    linuxSandbox=existsSync('/bin/bash') && probe(procArgs)
  }
  return linuxSandbox
}

export function shellProfiles(root:string,names:readonly string[]) {
  const profiles: Record<string,{os:string,path_style:string,cwd:string}> = {}
  if(names.includes('Bash') && process.platform==='win32' && process.env.SHELL && existsSync(process.env.SHELL)){
    const {windowsPathToPosixPath}=require('../utils/windowsPaths')
    profiles.Bash={os:'Windows',path_style:'posix',cwd:windowsPathToPosixPath(root)}
  }else if(names.includes('Bash') && sandboxedBashAvailable()){
    profiles.Bash={os:executorOS(),path_style:'posix',cwd:root}
  }
  if(process.platform==='win32' && names.includes('PowerShell') && (Bun.which('pwsh') || Bun.which('powershell'))){
    profiles.PowerShell={os:'Windows',path_style:'windows',cwd:root}
  }
  return profiles
}
