import {constants} from 'node:fs'
import {open,lstat} from 'node:fs/promises'
import {resolve} from 'node:path'
import {checkWorkspaceTarget} from './tools'
import { getQuickJS } from 'quickjs-emscripten'

// The guest has no Node, filesystem, process or network API. All model calls go
// through the caller's fixed pool. Cache entries are scoped to one workflow run.
export async function evaluateWorkflow(script:string, args:unknown, signal:AbortSignal, infer:(prompt:string)=>Promise<string>, cache:Map<string,string>) {
  const vm=(await getQuickJS()).newContext()
  const pending = new Set<Promise<void>>()
  try {
    vm.runtime.setMemoryLimit(16*1024*1024)
    vm.runtime.setMaxStackSize(256*1024)
    const deadline=Date.now()+120000
    vm.runtime.setInterruptHandler(()=>signal.aborted||Date.now()>deadline)
    let calls=0
    vm.newFunction('agent',handle=>{
      signal.throwIfAborted()
      const prompt=vm.getString(handle)
      if(!prompt.trim()||Buffer.byteLength(prompt)>16000||++calls>32)throw Error('Invalid workflow model request')
      const deferred=vm.newPromise()
      const request=Promise.resolve().then(async()=>{
        let text=cache.get(prompt)
        if(text===undefined){text=await infer(prompt);cache.set(prompt,text)}
        vm.newString(text).consume(value=>deferred.resolve(value))
      }).catch(error=>vm.newString(String(error)).consume(value=>deferred.reject(value)))
      pending.add(request)
      void request.finally(()=>pending.delete(request))
      return deferred.handle
    }).consume(fn=>vm.setProp(vm.global,'agent',fn))
    const body=script.replace(/^\s*export\s+const\s+meta\s*=/,'const meta =')
    const program='(async()=>{const args='+JSON.stringify(args??null)+';'+
      'const parallel=(jobs)=>Promise.all(jobs.map(j=>typeof j==="function"?j():j));'+
      'const pipeline=async(value,...steps)=>{for(const step of steps)value=await step(value);return value};'+
      'const phase=async(name,fn)=>typeof fn==="function"?fn():name;'+ body+'\n})()'
    const handle=vm.unwrapResult(vm.evalCode(program))
    try {
      do {
        vm.runtime.executePendingJobs().unwrap()
        if(!pending.size)break
        await Promise.race(pending)
        signal.throwIfAborted()
      } while(true)
      const state=vm.getPromiseState(handle)
      if(state.type==='pending')throw Error('Workflow has an unresolved promise')
      if(state.type==='rejected')throw Error(JSON.stringify(state.error.consume(v=>vm.dump(v))))
      return state.value.consume(v=>vm.dump(v))??null
    } finally {handle.dispose()}
  } finally {await Promise.allSettled(pending);vm.dispose()}
}

export async function readWorkflow(root:string,path:string) {
  const target=resolve(root,path)
  checkWorkspaceTarget(root,target)
  const before=await lstat(target)
  if(!before.isFile() || before.nlink!==1)throw Error('Expected a regular workspace script')
  const flags=process.platform==='win32'?constants.O_RDONLY:constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW
  const file=await open(target,flags)
  try {
    const stat=await file.stat()
    if(stat.dev!==before.dev || stat.ino!==before.ino || !stat.isFile() || stat.nlink!==1 || stat.size>2*1024*1024)throw Error('Expected a workspace script within 2 MiB')
    const data=Buffer.alloc(stat.size+1)
    let offset=0
    while(offset<data.length){
      const {bytesRead}=await file.read(data,offset,data.length-offset,offset)
      if(!bytesRead)break
      offset+=bytesRead
    }
    checkWorkspaceTarget(root,target)
    const now=await lstat(target)
    if(now.dev!==stat.dev || now.ino!==stat.ino || now.mtimeMs!==stat.mtimeMs || offset!==stat.size)throw Error('Workflow changed while reading')
    return new TextDecoder('utf-8',{fatal:true}).decode(data.subarray(0,offset))
  }finally{await file.close()}
}

