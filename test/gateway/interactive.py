import os,pty,fcntl,termios,struct,select,subprocess,time,pathlib,re,tempfile,sys
import json
base=pathlib.Path(__file__).resolve().parents[2]
fixtures=pathlib.Path(__file__).resolve().parent
scenario=sys.argv[1] if len(sys.argv)>1 else 'operations'
if scenario not in ('operations','agent'):raise ValueError('Unknown scenario')
with tempfile.TemporaryDirectory() as tmp:
 d=pathlib.Path(tmp);project=d/'project';project.mkdir()
 subprocess.run(['git','init','-q','-b','main',str(project)],check=True)
 subprocess.run(['git','-C',str(project),'-c','user.name=Fixture','-c','user.email=fixture@localhost','commit','--allow-empty','-qm','initial'],check=True)
 skill=project/'.claude/skills/arithmetic-check';skill.mkdir(parents=True)
 (skill/'SKILL.md').write_text('---\nname: arithmetic-check\ndescription: Check the local square example\n---\nInspect the output of square(7).\n')
 key=d/'key';key.write_text('gw1_'+'k'*43);key.chmod(0o600)
 log=open(d/'results','w+')
 s=subprocess.Popen(['bun',str(fixtures/(scenario+'.ts')),tmp],stdout=log)
 fd,sl=pty.openpty();fcntl.ioctl(sl,termios.TIOCSWINSZ,struct.pack('HHHH',42,140,0,0))
 for _ in range(80):
  time.sleep(.05); port=(d/'results').read_text().strip()
  if port:break
 initial=['exercise-fixed-tools'] if scenario=='agent' else []
 p=subprocess.Popen([str(base/'claudec'),'--url',f'ws://127.0.0.1:{port}/v1/ws','--key-file',str(key),'--workspace',str(project),*initial],stdin=sl,stdout=sl,stderr=subprocess.DEVNULL if os.environ.get('CC_TEST_REDIRECT_STDERR')=='1' else sl,env=dict(os.environ,TERM='xterm-256color',HOME=tmp))
 os.close(sl);data=b'';screen=b'';sent=bool(initial);start=time.monotonic()
 try:
  while time.monotonic()-start<110:
   if select.select([fd],[],[],.15)[0]:
    try:c=os.read(fd,65536)
    except OSError:break
    screen+=c;data+=c
   plain=re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]',b'',screen).replace(b' ',b'').lower()
   if b'yes,itrust' in plain or (sent and (b'1.yes' in plain or b'1.allow' in plain or b'1.approve' in plain or b'1.squareexample' in plain or b'submitanswers' in plain or b'1.yes,clear' in plain)):
    time.sleep(.15);os.write(fd,b'\r');screen=b''
   elif not sent and time.monotonic()-start>3 and b'\xe2\x9d\xaf' in screen:
    os.write(fd,b'exercise-fixed-tools');time.sleep(.2);os.write(fd,b'\r');screen=b'';sent=True
   if '"EndConversation"' in (d/'results').read_text():break
 finally:
  p.kill();p.wait();s.terminate();s.wait();os.close(fd);log.close()
 header=re.sub(rb'\x1b\[[0-?]*[ -/]*[@-~]',b'',data).replace(b' ',b'').lower()
 assert b'gateway' in header and b'fixedpool' in header, 'gateway provider missing from terminal header'
 assert b'apiusagebilling' not in header and b'5xmoreroom' not in header, 'unexpected Anthropic pricing label'
 records=[json.loads(line) for line in (d/'results').read_text().splitlines()[1:]]
 replies=[r for r in records if 'status' in r]
 for r in replies:
  if r['name']=='Write' and r['status']=='error' and 'plan mode' in r['text']:continue
  assert r['status']=='ok',r
 assert replies and replies[-1]['name']=='EndConversation',replies[-2:]
 if scenario=='agent':
  assert set(r['name'] for r in replies)=={'Task','ListAgents','SendMessage','SubagentHandback','EndConversation'}
  assert any(r['name']=='SubagentHandback' and '49' in r['text'] for r in replies)
 else:
  assert (project/'square.py').read_text().endswith('return n * n\n')
  assert not (project/'slice.txt').exists()
  assert (project/'.claude/worktrees/acceptance/slice.txt').read_text()=='worktree-only'
  assert not (project/'forbidden-plan-edit.txt').exists()
  for name,match in [('Bash','49'),('Skill','Inspect the output'),('AskUserQuestion','Square example'),('ExitPlanMode','Check the square function')]:
   assert any(r['name']==name and match in r['text'] for r in replies),(name,replies)
 print(scenario,len(replies),'tool responses checked')
