import {execFileSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {resolve,join} from 'node:path'

export const repo=resolve(import.meta.dir,'../../..')
export const cli=process.platform==='win32' ? ['cmd.exe','/d','/c','cc-a.cmd'] : [join(repo,'cc-a')]

export function writeTestKey(keyPath:string,value:string) {
  writeFileSync(keyPath, value, {mode:0o600})
  if(process.platform==='win32'){
    // Set an explicit user-only ACL for this synthetic fixture even in an elevated terminal.
    const acl=[
      "$ErrorActionPreference='Stop'",
      "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$acl=New-Object Security.AccessControl.FileSecurity",
      "$acl.SetOwner($sid)",
      "$acl.SetAccessRuleProtection($true,$false)",
      "$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))",
      "Set-Acl -LiteralPath $env:CC_TEST_KEY -AclObject $acl",
    ].join(';')
    execFileSync(join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',acl],{env:{...process.env,CC_TEST_KEY:keyPath}})
  }
}
