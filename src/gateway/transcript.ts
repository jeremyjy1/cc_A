type Row = {type:string; subtype?:string; isMeta?:boolean; message?:{content:unknown}}
type Text = {role:string; text:string}

export type GatewayImage = {media_type:string; data:string; size:number}
export function conversationImages(messages: readonly Row[]): GatewayImage[] {
  const boundary = messages.findLastIndex(m => m.type === 'system' && m.subtype === 'compact_boundary')
  const row = messages.slice(boundary + 1).findLast(m => {
    const blocks = m.message?.content
    return m.type === 'user' && !m.isMeta && Array.isArray(blocks) && blocks.some(b => b?.type === 'image')
  })
  const content = row?.message?.content
  const images: GatewayImage[] = []
  let total = 0
  if (!Array.isArray(content)) return images
  for (const block of content) {
    if (block?.type !== 'image') continue
    const source = block.source
    if (source?.type !== 'base64' || !['image/png','image/jpeg','image/gif','image/webp'].includes(source.media_type) ||
        typeof source.data !== 'string' || source.data.length > 4*Math.ceil(4*1024*1024/3)) {
      throw Error('请使用 4 MiB 以内的 PNG、JPEG、GIF 或 WebP 图片')
    }
    const bytes = Buffer.from(source.data,'base64')
    total += bytes.length
    if (!bytes.length || bytes.toString('base64') !== source.data || bytes.length > 4*1024*1024 ||
        total > 8*1024*1024 || images.length >= 4) throw Error('图片数据无效或超过限制（每次最多 4 张，合计 8 MiB）')
    images.push({media_type:source.media_type, data:source.data, size:bytes.length})
  }
  return images
}

export function conversationPrompt(messages: readonly Row[], maxBytes=16000): string {
  const turns: Text[]=[]
  const current = messages.findLast(m=>m.type==="user"&&!m.isMeta)
  for(const m of messages){
    if(m.isMeta || (m.type!=='user' && m.type!=='assistant'))continue
    const c=m.message?.content
    if (m===current && Array.isArray(c) && c.some(b=>b?.type==='document')) {
      throw Error('This gateway does not accept document attachments.')
    }
    const text=typeof c==='string'?c:Array.isArray(c)?c.map(b=>{
      if(b?.type==='image')return '[Image]'
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
