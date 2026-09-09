"""Exercise an installed native adapter through a real Claude host and local API.
No user credentials or remote model are used. Requires Python 3 and Claude Code.
"""
import argparse, hashlib, sys
from pathlib import Path
import http.server,threading,subprocess,os,signal,json,re,time,tempfile
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--binary',required=True,type=Path)
args=parser.parse_args()
binary=args.binary.resolve(strict=True)
root=Path(tempfile.mkdtemp(prefix='specgit-native-host-')).resolve()
project=root/'project';project.mkdir()
config=root/'claude';config.mkdir()
for command in [['git','init','-b','fixture'],['git','config','user.name','Fixture'],['git','config','user.email','fixture@example.invalid'],['git','remote','add','origin','https://github.com/fixture/context.git']]:
 subprocess.run(command,cwd=project,check=True,capture_output=True)
(project/'README.md').write_text('Synthetic host fixture.\n')
subprocess.run(['git','add','.'],cwd=project,check=True,capture_output=True)
subprocess.run(['git','commit','-m','fixture'],cwd=project,check=True,capture_output=True)
(project/'.specgit.yaml').write_text('version: 2\nprovider: github\nremote: origin\nlanguage: en\n')
(root/'mcp.json').write_text('{"mcpServers":{}}')
setup=subprocess.run([str(binary),'setup','--provider','github','--root',str(root/'assets'),'--register-claude','--claude-settings',str(config/'settings.json'),'--json'],cwd=project,env={'PATH':'','HOME':str(root)},capture_output=True,timeout=30)
report=json.loads(setup.stdout)
if setup.returncode not in (0,3) or report.get('status')!='installed':
 raise RuntimeError('Isolated native installation failed')
version=subprocess.run(['claude','--version'],capture_output=True,text=True,check=True).stdout.strip()
observed=[]
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_CONNECT(self):self.send_error(403)
 def do_GET(self):self.send_response(200);self.end_headers();self.wfile.write(b'{}')
 def do_POST(self):
  length=int(self.headers.get('Content-Length','0'))
  if length>4_194_304:self.send_error(413);return
  body=json.loads(self.rfile.read(length) or b'{}')
  serialized=json.dumps(body,ensure_ascii=False)
  ids=re.findall(r'SpecGit 2 \[([0-9a-f]{16})\]',serialized)
  observed.append({'path':self.path,'context_ids':ids,'stream':bool(body.get('stream'))})
  if 'count_tokens' in self.path:
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"input_tokens":100}');return
  response=ids[-1] if ids else 'MISSING'
  message={'id':'msg_local_fixture','type':'message','role':'assistant','model':'claude-sonnet-4-6','content':[],'stop_reason':None,'stop_sequence':None,'usage':{'input_tokens':100,'output_tokens':0}}
  self.send_response(200)
  if body.get('stream'):
   self.send_header('Content-Type','text/event-stream');self.end_headers()
   events=[('message_start',{'type':'message_start','message':message}),('content_block_start',{'type':'content_block_start','index':0,'content_block':{'type':'text','text':''}}),('content_block_delta',{'type':'content_block_delta','index':0,'delta':{'type':'text_delta','text':response}}),('content_block_stop',{'type':'content_block_stop','index':0}),('message_delta',{'type':'message_delta','delta':{'stop_reason':'end_turn','stop_sequence':None},'usage':{'output_tokens':8}}),('message_stop',{'type':'message_stop'})]
   for name,data in events:self.wfile.write(('event: '+name+'\ndata: '+json.dumps(data)+'\n\n').encode());self.wfile.flush()
  else:
   self.send_header('Content-Type','application/json');self.end_headers();message['content']=[{'type':'text','text':response}];message['stop_reason']='end_turn';self.wfile.write(json.dumps(message).encode())
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
endpoint='http://127.0.0.1:'+str(server.server_port)

env={k:os.environ[k]for k in ['PATH','HOME','USER','TMPDIR','SHELL','LANG','LC_ALL']if k in os.environ}
env.update({'CLAUDE_CONFIG_DIR':str(config),'ANTHROPIC_API_KEY':'sk-ant-fixture-not-a-real-key','ANTHROPIC_BASE_URL':endpoint,'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC':'1','CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL':'1','HTTP_PROXY':endpoint,'HTTPS_PROXY':endpoint,'ALL_PROXY':endpoint,'NO_PROXY':'127.0.0.1,localhost'})
args=['claude','-p','--settings',str(config/'settings.json'),'--setting-sources','user','--model','sonnet','--tools','','--strict-mcp-config','--mcp-config',str(root/'mcp.json'),'--no-session-persistence','--output-format','stream-json','--include-hook-events','--verbose','Local synthetic transport test. Return the SpecGit hook context identifier.']
p=subprocess.Popen(args,cwd=root/'project',env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
try:out,err=p.communicate(timeout=45)
except subprocess.TimeoutExpired:
 os.killpg(p.pid,signal.SIGTERM)
 try:out,err=p.communicate(timeout=3)
 except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);out,err=p.communicate()
server.shutdown()
summary={'host':version,'artifact_sha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'destination':'loopback-only synthetic API','external_model':False,'exit':p.returncode,'requests':observed,'events':[]}
for line in out.splitlines():
 try:
  d=json.loads(line)
  if 'hook' in str(d.get('subtype','')):summary['events'].append({k:d.get(k)for k in ['type','subtype','hook_name','hook_event','outcome','exit_code']})
  if d.get('subtype')=='init':summary['skill_registered']='specgit-native' in d.get('skills',[])
  if d.get('type')=='result':summary['result']={k:d.get(k)for k in ['subtype','is_error','result']}
 except ValueError:pass
for name,data in [('claude-local-stream.jsonl',out),('claude-local-stderr.log',err),('claude-local-evidence.json',json.dumps(summary,indent=2).encode())]:
 fd=os.open(root/name,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'wb')as f:f.write(data)
requests=[r for r in observed if r['path'].split('?')[0]=='/v1/messages']
result=summary.get('result',{})
summary['passed']=summary.get('skill_registered',False) and p.returncode==0 and len(requests)==1 and bool(requests[0]['context_ids']) and result.get('result') in requests[0]['context_ids'] and not result.get('is_error',True)
summary['evidence_directory']=str(root)
(root/'claude-local-evidence.json').write_text(json.dumps(summary,indent=2))
print(json.dumps(summary,indent=2))
sys.exit(0 if summary['passed'] else 1)
