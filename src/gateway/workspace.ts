import { realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { relative, resolve, sep } from 'node:path'
import { checkWorkspaceTarget, inside } from './tools'

let primary = ''
let protectedPaths: string[] = []
const added = new Set<string>()
const aliases = new Map<string,string>()
let currentDirectories: (() => ReadonlyMap<string,unknown>) | undefined

export function startWorkspaceSession(root: string, protectedFiles: string[]) {
  primary = root
  protectedPaths = [...protectedFiles, resolve(homedir(), '.ssh')].map(path => {
    try { return realpathSync(path) } catch { return resolve(path) }
  })
  added.clear()
  aliases.clear()
  currentDirectories = undefined
}

export function addWorkspaceDirectory(path: string, directories?: () => ReadonlyMap<string,unknown>) {
  if (!primary) throw Error('No gateway workspace')
  const root = realpathSync(path)
  if (!statSync(root).isDirectory() || root.split(sep).some(s => s.toLowerCase() === '.git') ||
      inside(root, homedir()) || protectedPaths.some(p => inside(root,p) || inside(p,root))) {
    throw Error('Choose a project directory separate from credentials and session data')
  }
  currentDirectories = directories ?? currentDirectories
  added.add(root)
  aliases.set(resolve(path),root)
  return root
}

export function additionalRoots(directories: ReadonlyMap<string, unknown>) {
  return [...added].filter(path => {
    if (!directories.has(path)) return false
    try { return realpathSync(path) === path } catch { return false }
  })
}

export function workspacePath(root: string, path: string) {
  const target = resolve(root,path)
  for (const [alias,canonical] of aliases) {
    if (alias !== canonical && inside(alias,target) && realpathSync(alias) === canonical) {
      return resolve(canonical,relative(alias,target))
    }
  }
  return target
}

export function workspaceForTarget(root: string, additional: readonly string[], path: string) {
  const target = resolve(root, path)
  const match = [root, ...additional].find(dir => inside(dir, target))
  if (!match || realpathSync(match) !== match) throw Error('Outside workspace')
  checkWorkspaceTarget(match,target)
  return match
}

export function checkRestoreTarget(path: string) {
  workspaceForTarget(primary, currentDirectories ? additionalRoots(currentDirectories()) : [...added], path)
}
