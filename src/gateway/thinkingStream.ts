// One live preview per thinking block, followed by one persisted message.
export function createThinkingStream(emit:(event:any)=>void, complete:(text:string)=>any) {
  let text = ''
  const event = (value:any) => emit({type:'stream_event',event:value})
  return {
    delta(chunk:string) {
      if (!chunk) return
      if (!text) event({type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}})
      text += chunk
      event({type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:chunk}})
    },
    finish() {
      if (!text) return
      event({type:'content_block_stop',index:0})
      const value=text
      text=''
      emit(complete(value))
    },
  }
}
