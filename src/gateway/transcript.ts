type Row = {type:string; isMeta?:boolean; message?:{content:unknown}}
type Text = {role:string; text:string}

export function conversationPrompt(messages: readonly Row[], maxBytes=16000): string {
  const turns: Text[]=[]
  const current = messages.findLast(m=>m.type==="user"&&!m.isMeta)
  for(const m of messages){
    if(m.isMeta || (m.type!=='user' && m.type!=='assistant'))continue
    const c=m.message?.content
    if (m===current && Array.isArray(c) && c.some(b=>b?.type==='image'||b?.type==='document')) {
      throw Error('This gateway accepts text only. Remove image or document attachments.')
    }
    const text=typeof c==='string'?c:Array.isArray(c)?c.map(b=>{
      if(b?.type==='text')return b.text
      if(b?.type==='tool_use')return JSON.stringify({tool:b.name,id:b.id,input:b.input})
      if(b?.type==='tool_result')return JSON.stringify({result:b.tool_use_id,content:b.content})
      return ''
    }).filter(Boolean).join('\n'):''
    if(text.trim())turns.push({role:m.type,text})
  }
  const latest=turns.pop()
  if(!latest || latest.role!=='user')throw Error('Expected a user text message')
  if(Buffer.byteLength(latest.text)>maxBytes)throw Error('Current message exceeds the gateway limit (16000 bytes)')
  let output=latest.text
  const history:Text[]=[]
  for(let i=turns.length-1;i>=0;i--){
    history.unshift(turns[i]!)
    const next='Earlier conversation (oldest first):\n'+JSON.stringify(history)+'\n\nCurrent user request:\n'+latest.text
    if(Buffer.byteLength(next)>maxBytes)break
    output=next
  }
  return output
}
