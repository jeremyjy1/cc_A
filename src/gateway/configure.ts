import {mkdirSync,openSync,closeSync,readSync,writeFileSync,fsyncSync,renameSync,unlinkSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join,dirname} from 'node:path'
import {spawnSync} from 'node:child_process'

export function defaultKeyPath() {
  const home=homedir()
  return process.platform==='win32'
    ? join(process.env.LOCALAPPDATA||join(home,'AppData','Local'),'cc-a','access.key')
    : join(home,'.config','cc-a','access.key')
}

async function readSecret() {
  if(process.stdin.isTTY){
    const input=process.stdin
    const originalRaw=input.isRaw
    input.setRawMode(true)
    let value=''
    let onData:(data:Buffer)=>void=()=>{}
    let onEnd:()=>void=()=>{}
    try{
      return await new Promise<string>((resolve,reject)=>{
        onData=data=>{
          for(const byte of data){
            if(byte===13||byte===10){resolve(value);return}
            if(byte===3||byte===4){reject(Error('已取消配置'));return}
            if(byte===8||byte===127){value=value.slice(0,-1);continue}
            if(byte<32||byte>126||value.length>=256){reject(Error('密钥格式无效'));return}
            value+=String.fromCharCode(byte)
          }
        }
        onEnd=()=>reject(Error('输入已结束'))
        input.on('data',onData);input.once('end',onEnd)
        input.resume()
        process.stderr.write('请输入 B 签发的 A 端接入密钥（输入隐藏）：')
      })
    }finally{
      input.off('data',onData);input.off('end',onEnd)
      input.setRawMode(originalRaw??false);input.pause();input.unref()
      process.stderr.write('\n')
    }
  }
  const chunks:Buffer[]=[]
  let bytes=0
  for await(const chunk of process.stdin){
    const data=Buffer.from(chunk)
    if((bytes+=data.length)>256)throw Error('密钥格式无效')
    chunks.push(data)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function configureKey(){
  const key=(await readSecret()).trim()
  if(!/^gw1_[A-Za-z0-9_-]{43}$/.test(key)||Buffer.from(key.slice(4),'base64url').toString('base64url')!==key.slice(4))throw Error('密钥格式无效')
  saveSetting(defaultKeyPath(),key)
  console.log('A 端默认密钥已保存。')
}

function saveSetting(path:string,value:string){
  mkdirSync(dirname(path),{recursive:true,mode:0o700})
  const temp=join(dirname(path),'.access-'+randomUUID())
  const fd=openSync(temp,'wx',0o600)
  try{
    try{
      if(process.platform==='win32'){
        const script=[
          "$ErrorActionPreference='Stop'",
          "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
          "$acl=New-Object Security.AccessControl.FileSecurity",
          "$acl.SetOwner($sid)",
          "$acl.SetAccessRuleProtection($true,$false)",
          "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))",
          "Set-Acl -LiteralPath $env:CC_A_NEW_KEY -AclObject $acl"
        ].join(';')
        const ps=join(process.env.SystemRoot||'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe')
        const result=spawnSync(ps,['-NoProfile','-NonInteractive','-Command',script],{env:{...process.env,CC_A_NEW_KEY:temp},stdio:'ignore',timeout:60000})
        if(result.status!==0)throw Error('无法设置本地密钥的访问权限')
      }
      writeFileSync(fd,value+'\n')
      fsyncSync(fd)
    }finally{closeSync(fd)}
    renameSync(temp,path)
  }catch(error){unlinkSync(temp);throw error}
}

export function serverPath() {
  return join(dirname(defaultKeyPath()), 'server.url')
}

export function parseServer(value: string): URL {
  const raw = value.trim()
  const url = URL.canParse(raw) ? new URL(raw) : undefined
  const local = url?.protocol === 'ws:' && ['127.0.0.1', '[::1]'].includes(url.hostname)
  if (!url || (!local && url.protocol !== 'wss:') || url.username || url.password ||
      /[?#\\\s]/u.test(raw) || Buffer.byteLength(url.href) > 2048) {
    throw Error('请输入有效的 wss:// 服务器地址；本机测试可用 ws://127.0.0.1 或 ws://[::1]')
  }
  return url
}

export function configureServer() {
  if (process.stdin.isTTY) process.stderr.write('请输入 B 服务器地址（例如 wss://8.153.176.226/v1/ws）：')
  const bytes: number[] = []
  const byte = Buffer.alloc(1)
  while (readSync(0, byte, 0, 1, null) && byte[0] !== 10) {
    if (bytes.length >= 2049) throw Error('服务器地址过长')
    bytes.push(byte[0]!)
  }
  const url = parseServer(Buffer.from(bytes).toString('utf8'))
  saveSetting(serverPath(), url.href)
  console.log('A 端默认服务器地址已保存。')
}
