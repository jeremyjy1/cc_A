import {expect,test} from 'bun:test'
import {conversationPrompt} from './transcript'
import {mkdtempSync,rmSync,writeFileSync,linkSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {evaluateWorkflow,readWorkflow} from './workflow'

test('turn history preserves roles and Unicode within the frame budget',()=>{
  const rows=['first','answer','现在'].map((content,i)=>({type:i===1?'assistant':'user',message:{content}}))
  expect(conversationPrompt(rows)).toContain('"role":"assistant","text":"answer"')
  expect(conversationPrompt(rows,6)).toBe('现在')
  expect(()=>conversationPrompt(rows,5)).toThrow()
})

test('workflow awaits sequential and parallel fixed-pool replies',async()=>{
  const script='export const meta={}; const first=await agent("a"); return await parallel([()=>agent(first+"b"),()=>agent("c")])'
  const cache=new Map<string,string>()
  const result=await evaluateWorkflow(script,{},new AbortController().signal,async s=>s.toUpperCase(),cache)
  expect(result).toEqual(['AB','C'])
  expect(cache.size).toBe(3)
})

test('workspace workflow source keeps exact UTF-8 text and rejects linked or invalid content',async()=>{
  const root=mkdtempSync(join(tmpdir(),'cc-a-workflow-'))
  try{
    const source='export const meta={};\r\nreturn "计算结果";\r\n'
    const path=join(root,'calc.js')
    writeFileSync(path,source)
    expect(await readWorkflow(root,'calc.js')).toBe(source)
    linkSync(path,join(root,'alias.js'))
    await expect(readWorkflow(root,'alias.js')).rejects.toThrow()
    writeFileSync(join(root,'bytes.js'),Buffer.from([0xff]))
    await expect(readWorkflow(root,'bytes.js')).rejects.toThrow()
    await expect(readWorkflow(root,'../outside.js')).rejects.toThrow()
  }finally{rmSync(root,{recursive:true,force:true})}
})
