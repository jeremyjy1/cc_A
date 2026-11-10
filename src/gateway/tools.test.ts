import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execute } from './tools'

const base=realpathSync(mkdtempSync(resolve(tmpdir(),'cc-a-test-')))
const root=resolve(base,'project')
mkdirSync(root)
const call=(name:string,args:Record<string,unknown>)=>execute(root,name,args,new AbortController().signal)
afterAll(()=>rmSync(base,{recursive:true,force:true}))

test('edit, read line ranges and search the same workspace',async()=>{
  await call('Write',{file_path:'src/test.txt',content:'one\ntwo\n'})
  expect(await call('Read',{file_path:'src/test.txt',offset:2,limit:1})).toBe('2\ttwo')
  await call('Edit',{file_path:'src/test.txt',old_string:'two',new_string:'three'})
  expect(await call('Glob',{pattern:'**/*.txt'})).toContain('src/test.txt')
  expect(await call('Grep',{pattern:'three',output_mode:'content'})).toContain('three')
})

test('reject paths outside the workspace including symlinked parents',async()=>{
  const sentinel=resolve(base,'private.txt')
  writeFileSync(sentinel,'outside')
  symlinkSync(base,resolve(root,'outside'))
  await expect(call('Read',{file_path:'../private.txt'})).rejects.toThrow()
  await expect(call('Write',{file_path:'outside/private.txt',content:'changed'})).rejects.toThrow()
  expect(readFileSync(sentinel,'utf8')).toBe('outside')
})

test('sandboxed Bash can use its project but cannot read a sibling file',async()=>{
  writeFileSync(resolve(base,'sibling.txt'),'private')
  expect((await call('Bash',{command:'pwd'})).trim()).toBe(root)
  await expect(call('Bash',{command:'cat ../sibling.txt'})).rejects.toThrow()
  await expect(call('Bash',{command:'pwd',dangerouslyDisableSandbox:true})).rejects.toThrow()
})
