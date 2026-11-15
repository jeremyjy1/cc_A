import { expect, test } from 'bun:test'
import { createThinkingStream } from './thinkingStream'
import { handleMessageFromStream } from '../utils/messages'

test('thinking renders before completion and persists only once',()=>{
  let preview:any=null
  const saved:any[]=[]
  const events:any[]=[]
  const emit=(message:any)=>{
    events.push(message)
    handleMessageFromStream(message,m=>saved.push(m),()=>{},()=>{},()=>{},undefined,fn=>{preview=fn(preview)})
  }
  const stream=createThinkingStream(emit,text=>({type:'assistant',message:{content:[{type:'thinking',thinking:text}]}}))
  stream.delta('First ')
  expect(preview).toEqual({thinking:'First ',isStreaming:true})
  expect(saved).toHaveLength(0)
  stream.delta('second')
  expect(preview.thinking).toBe('First second')
  stream.finish()
  stream.finish()
  expect(saved).toHaveLength(1)
  expect(saved[0].message.content[0].thinking).toBe('First second')
  expect(preview.isStreaming).toBe(false)
  stream.delta('Next block')
  expect(preview.thinking).toBe('Next block')
  stream.finish()
  expect(saved).toHaveLength(2)
})
