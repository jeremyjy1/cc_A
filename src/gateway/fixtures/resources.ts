import {createInterface} from 'node:readline'

const sample={uri:'fixture://project/readme',name:'Acceptance sample',mimeType:'text/plain'}
for await(const line of createInterface({input:process.stdin})){
  const {method,id,params}=JSON.parse(line)
  if(id===undefined)continue
  let result
  switch(method){
    case 'initialize': result={protocolVersion:params.protocolVersion,capabilities:{resources:{}},serverInfo:{name:'local-fixture',version:'1'}};break
    case 'resources/list': result={resources:[sample]};break
    case 'resources/read': result={contents:[{...sample,text:'resource-violet-963'}]};break
    default: result={}
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\n')
}
