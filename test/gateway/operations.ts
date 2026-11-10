const steps=[
 ['Write',{file_path:'square.py',content:'def square(n):\n    return n + n\n'}],
 ['Read',{file_path:'square.py'}],
 ['Edit',{file_path:'square.py',old_string:'return n + n',new_string:'return n * n'}],
 ['Bash',{command:"/usr/bin/python3 -B -c 'from square import square; assert square(7) == 49; print(49)'",description:'Verify square of seven'}],
 ['TaskCreate',{subject:'Check square',description:'Verify seven squared'}],
 ['TaskGet',{taskId:'1'}],
 ['TaskUpdate',{taskId:'1',status:'completed'}],
 ['TaskList',{}],
 ['TodoWrite',{todos:[{content:'Verify arithmetic',activeForm:'Verifying arithmetic',status:'completed'}]}],
 ['ReportFindings',{findings:[{file:'square.py',summary:'square returns 49',failure_scenario:'regression in multiplication'}]}],
 ['ScheduleWakeup',{delaySeconds:86400,prompt:'Check the temporary example'}],
 ['ScheduleWakeup',{stop:true}],
 ['CronCreate',{cron:'0 0 1 1 *',prompt:'verify fixture',durable:false}],
 ['CronList',{}],
 ['CronDelete',{id:''}],
 ['Monitor',{command:'sleep 40',description:'Observe a test timer',timeout_ms:50000}],
 ['TaskStop',{task_id:''}],
 ['Workflow',{script:'export const meta={}; return 6*7',description:'Evaluate a test expression'}],
 ['EnterWorktree',{name:'acceptance'}],
 ['Write',{file_path:'slice.txt',content:'worktree-only'}],
 ['ExitWorktree',{action:'keep'}],
 ['EnterPlanMode',{}],
 ['Write',{file_path:'forbidden-plan-edit.txt',content:'must fail'}],
 ['Write',{file_path:'USE_PLAN_PATH',content:'# Square implementation\nCheck the square function.'}],
 ['ExitPlanMode',{}],
 ['Skill',{skill:'arithmetic-check'}],
 ['AskUserQuestion',{questions:[{question:'Which fixture should run?',header:'Fixture',multiSelect:false,options:[{label:'Square example',description:'Use seven squared'},{label:'Sum example',description:'Use addition'}]}]}],
 ['EndConversation',{}],
] as [string,Record<string,any>][]
if(process.platform==='win32'){
 const file_path='square.ts'
 steps[0]=['Write',{file_path,content:'export const square = (n: number) => n + n\n'}]
 steps[1]=['Read',{file_path}]
 steps[2]=['Edit',{file_path,old_string:'n + n',new_string:'n * n'}]
 steps[3]=['PowerShell',{command:"& '"+process.execPath.replaceAll("'","''")+"' run verify.ts",description:'Verify square of seven'}]
 const monitor=steps.find(([name])=>name==='Monitor')!
 monitor[1].command='Start-Sleep -Seconds 40'
}
let n=0, timerId='', monitorId='', planPath=''
const s=Bun.serve({hostname:'127.0.0.1',port:0,fetch(r,s){if(r.headers.get('authorization')!=='Bearer gw1_'+'k'.repeat(43))return new Response('',{status:403});if(s.upgrade(r))return;return new Response('')},websocket:{idleTimeout:0,message(ws,raw){
 const m=JSON.parse(String(raw)),emit=(event:any)=>ws.send(JSON.stringify({id:m.id,...event}))
 if(m.type==='user.message'){
   emit({type:'agent.turn.started'})
   if(!m.tools||!m.text.includes('exercise-fixed-tools')){emit({type:'agent.text.delta',text:'fixture'});emit({type:'agent.turn.completed'});return}
 }else if(m.type==='tool.result'){
   const name=steps[n][0]
   console.log(JSON.stringify({name,status:m.status,text:m.text}))
   if(name==='EnterPlanMode')planPath=m.text.split('Session plan file: ').at(-1)
   if(name==='Monitor'&&m.status==='ok')monitorId=JSON.parse(m.text).task_id
   if(name==='CronCreate')timerId=m.text.match(/\b[\da-f]{8}(-[\da-f-]+)?\b/i)?.[0]??''
   n++
 }else return
 if(n>=steps.length){emit({type:'agent.turn.completed'});return}
 const [name,args]=steps[n];if(args.file_path==='USE_PLAN_PATH')args.file_path=planPath; if(name==='CronDelete')args.id=timerId; if(name==='TaskStop')args.task_id=monitorId
 emit({type:'tool.request',tool:name,arguments:args,call_id:'step'+n})
}}})
console.log(s.port)
