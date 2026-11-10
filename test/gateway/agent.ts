let root='',child='',agentId='',delivered=false,handed=false
const marker='parent-'+crypto.randomUUID()
const s=Bun.serve({hostname:'127.0.0.1',port:0,fetch(r,s){if(r.headers.get('authorization')!=='Bearer gw1_'+'k'.repeat(43))return new Response('',{status:403});if(s.upgrade(r))return;return new Response('')},websocket:{message(ws,raw){
 const m=JSON.parse(String(raw)),emit=(id:string,data:object)=>ws.send(JSON.stringify({id,...data}))
 const tool=(id:string,name:string,args:object)=>emit(id,{type:'tool.request',tool:name,arguments:args,call_id:name})
 const end=(id:string,text:string)=>{emit(id,{type:'agent.text.delta',text});emit(id,{type:'agent.turn.completed'})}
 if(m.type==='user.message'){
  emit(m.id,{type:'agent.turn.started'})
  if(m.tools && m.id!==root && m.text.includes(marker)){
    tool(m.id,'SubagentHandback',{message:'7 * 7 = 49; '+marker})
  }else if(m.tools&&m.text.includes('child-arithmetic-check')){
    child=m.id;console.log(JSON.stringify({childTools:m.tool_names}))
  }else if(m.tools && m.text.includes('exercise-fixed-tools') && !root){
    root=m.id;tool(root,'Task',{description:'Verify square',prompt:'child-arithmetic-check: verify seven squared',subagent_type:'general-purpose',run_in_background:true})
  }else end(m.id,'fixture')
 }
 if(m.type==='tool.result'){
  console.log(JSON.stringify({name:m.call_id,status:m.status,text:m.text}))
  if(m.call_id==='Task'){
   agentId=m.text.match(/agentId: ([a-zA-Z0-9_-]+)/)?.[1]??''
   if(agentId)tool(root,'ListAgents',{})
   else end(root,'no agent')
  }
  if(m.call_id==='ListAgents')tool(root,'SendMessage',{to:agentId,message:'Verify 7 * 7 and acknowledge '+marker,summary:'Check multiplication'})
  if(m.call_id==='SendMessage')delivered=m.status==='ok'
  if(m.call_id==='SubagentHandback')tool(root,'EndConversation',{})
 }
 if(delivered&&child&&!handed){handed=true;end(child,'Initial draft')}
 if(m.type==='user.cancel')emit(m.id,{type:'agent.turn.completed'})
}}})
console.log(s.port)
