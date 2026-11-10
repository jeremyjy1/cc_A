import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWorkspaceSession, addWorkspaceDirectory, additionalRoots, workspaceForTarget, checkRestoreTarget } from './workspace'
import { execute } from './tools'
import { sandboxedBashAvailable } from './platform'

test('added directories remain scoped to a session and cannot expose keys or linked paths', async () => {
  const temp = realpathSync(mkdtempSync(join(tmpdir(),'cc-directories-')))
  const [root, extra, privateDir] = ['project','extra','private'].map(name => join(temp,name))
  try {
    for (const dir of [root,extra,privateDir]) mkdirSync(dir)
    startWorkspaceSession(root,[privateDir])
    expect(() => addWorkspaceDirectory(temp)).toThrow()
    expect(() => addWorkspaceDirectory(privateDir)).toThrow()
    expect(addWorkspaceDirectory(extra)).toBe(extra)
    const roots = additionalRoots(new Map([[extra,true]]))
    expect(workspaceForTarget(root,roots,join(extra,'file'))).toBe(extra)
    checkRestoreTarget(join(extra,'file'))
    writeFileSync(join(extra,'file'),'second project')
    if (process.platform !== 'win32') {
      symlinkSync(privateDir,join(extra,'link'))
      expect(() => workspaceForTarget(root,roots,join(extra,'link','key'))).toThrow()
      if (sandboxedBashAvailable()) {
        const reply = await execute(root,'Bash',{command:'cat "'+join(extra,'file')+'"'},new AbortController().signal,roots)
        expect(reply).toBe('second project')
      }
    }
    startWorkspaceSession(root,[privateDir])
    expect(additionalRoots(new Map([[extra,true]]))).toEqual([])
    expect(() => checkRestoreTarget(join(extra,'file'))).toThrow()
  } finally { rmSync(temp,{recursive:true,force:true}) }
})
