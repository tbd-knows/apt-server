/** Destructive only inside a disposable CI container: replace runtime children
 * with observable stubs to test the real supervisor's routing/exit behavior. */
import assert from 'node:assert/strict';
import {writeFile,mkdir,readFile,chmod} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {setTimeout as pause} from 'node:timers/promises';
assert.equal(process.env.APT_RENDER_CONTAINER_SMOKE,'1');
assert.equal(process.getuid(),0);assert.equal(process.cwd(),'/opt/tbd/app');
const root='/opt/tbd/app';
const env={...process.env,PORT:'10000',APT_PUBLIC_URL:'https://fixture.onrender.com',APT_RENDER_PROVISION:'false',
  APT_PILOT_USER_IDS:'11111111-1111-4111-8111-111111111111,22222222-2222-4222-8222-222222222222',
  SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'fixture-publishable-key',SUPABASE_SERVICE_ROLE_KEY:'PRIVATE_PLATFORM_CANARY',
  SUPABASE_DATABASE_URL:'postgresql://fixture',HERMES_KEY_SECRET:'r'.repeat(32),HERMES_MODEL:'fixture',HERMES_PROVIDER_API_KEY:'PRIVATE_MODEL_CANARY',
  STRIPE_SECRET_KEY:'PRIVATE_STRIPE_CANARY',OPENAI_API_KEY:'PRIVATE_OTHER_PROVIDER_CANARY'};
await writeFile(root+'/dist/server.js',`import{createServer}from'node:http';createServer((q,s)=>{s.setHeader('content-type','application/json');s.end(JSON.stringify({status:'ok'}));}).listen(8787,'127.0.0.1');`);
await writeFile(root+'/dist/admin/pilot-host.js',`import{readFileSync}from'node:fs';for(const n of ['routing.env','founder1.env','founder2.env']){if(!readFileSync('/etc/tbd/'+n,'utf8'))process.exit(2);}`);
const stub='/opt/tbd/hermes/bin/hermes';
await writeFile(stub,`#!/opt/tbd/node/bin/node
import('node:http').then(async({createServer})=>{
const{writeFile}=await import('node:fs/promises');
if(['STRIPE_SECRET_KEY','SUPABASE_SERVICE_ROLE_KEY','HERMES_KEY_SECRET','OPENAI_API_KEY','HERMES_PROVIDER_API_KEY'].some(k=>process.env[k]))process.exit(3);
if(process.env.API_SERVER_HOST!=='127.0.0.1'||process.env.A2A_HOST!=='127.0.0.1')process.exit(4);
await writeFile('/var/lib/tbd/gateway-'+process.env.API_SERVER_PORT,JSON.stringify({pid:process.pid}));
createServer((q,s)=>{s.end('{}');}).listen(Number(process.env.API_SERVER_PORT),'127.0.0.1');
});
`);await chmod(stub,0o755);
await mkdir('/var/lib/tbd',{recursive:true});
async function run(killGateway){
 const child=spawn('/usr/local/bin/tbd-render-entrypoint',['/opt/tbd/node/bin/node','dist/admin/render-host.js'],{env,stdio:['ignore','pipe','pipe']});
 let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try {
  let ready=false;
  for(let n=0;n<100;n++){
   assert.equal(child.exitCode,null,'Supervisor exited before readiness: '+output);
   try{ready=(await fetch('http://127.0.0.1:10000/health')).ok;}catch{}
   if(ready)break;await pause(100);
  }
  assert(ready,'Public health did not become ready');
  assert.equal((await fetch('http://127.0.0.1:10000/internal/agent/tool')).status,404);
  assert.equal((await fetch('http://127.0.0.1:10000/.well-known/agent-card.json')).status,404);
  const gateways=await Promise.all([8642,8643].map(async port=>JSON.parse(await readFile('/var/lib/tbd/gateway-'+port,'utf8'))));
  if(killGateway)process.kill(gateways[0].pid,'SIGKILL');else child.kill('SIGTERM');
  const result=await Promise.race([exited,pause(12000).then(()=>{throw new Error('Supervisor did not stop children');})]);
  assert.equal(result.code,killGateway?1:0);
  for(const gateway of gateways)assert.throws(()=>process.kill(gateway.pid,0));
  for(const secret of ['PRIVATE_PLATFORM_CANARY','PRIVATE_MODEL_CANARY','PRIVATE_STRIPE_CANARY','PRIVATE_OTHER_PROVIDER_CANARY'])assert(!output.includes(secret));
 }finally{if(child.exitCode===null)child.kill('SIGKILL');}
}
await run(false);await run(true);
console.log('PASS: actual Render supervisor startup, public/private proxy, secret-free owner children, graceful shutdown and fail-together restart; synthetic child runtimes.');
