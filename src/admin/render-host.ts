/** Render single-disk host. Profiles and materialized private memory share one
 * instance; any lost child stops the instance so Render can restart it cleanly. */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { loadConfig } from '../config.js';
import { HOST_APP, HOST_CLI, HOST_HOME, HOST_NODE, pilotHostFiles, pilotHostPlan } from '../pilot-host.js';
import { isolatedProcessEnvironment } from '../process-environment.js';
import { publicPilotProxy, renderPort } from '../render-runtime.js';

const children:ChildProcess[]=[];
let stopping=false;
const proxy=publicPilotProxy();
async function shutdown(code:number) {
  if(stopping)return;stopping=true;proxy.close();
  for(const child of children)if(child.pid)try{process.kill(-child.pid,'SIGTERM');}catch{}
  const deadline=Date.now()+45_000;
  while(children.length&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,100));
  for(const child of children)if(child.pid)try{process.kill(-child.pid,'SIGKILL');}catch{}
  process.exit(code);
}
for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{void shutdown(0);});
function start(label:string,command:string,args:string[],environment:NodeJS.ProcessEnv,once=false) {
  if(stopping)throw new Error('Host is stopping.');
  const child=spawn(command,args,{cwd:HOST_APP,env:environment,stdio:['ignore','inherit','inherit'],detached:true});children.push(child);
  const done=new Promise<void>((resolve,reject)=>{
    child.once('error',()=>reject(new Error(`${label} could not start.`)));
    child.once('exit',code=>{const index=children.indexOf(child);if(index>=0)children.splice(index,1);code===0&&once?resolve():reject(new Error(`${label} exited.`));});
  });
  if(!once)void done.catch(()=>{if(!stopping){process.stderr.write(`${label} stopped; restarting the complete instance.\n`);void shutdown(1);}});
  return done;
}
async function ready(url:string) {
  for(let n=0;n<120;n++) {
    if(stopping)throw new Error('Host stopped during startup.');
    try {const r=await fetch(url,{signal:AbortSignal.timeout(2000)});if(r.status===200||r.status===503)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error('Private API did not start.');
}
try {
  const port=renderPort(process.env.PORT);
  const env:NodeJS.ProcessEnv={...process.env,HOST:'127.0.0.1',PORT:'8787',NODE_ENV:'production',HERMES_HOME:HOST_HOME,
    HERMES_CLI:HOST_CLI,APT_INTERNAL_URL:'http://127.0.0.1:8787',APT_INTERNAL_PEER_IPS:'',HERMES_TOPOLOGY:'per_profile'};
  const config=loadConfig(env),plan=pilotHostPlan(config,env.APT_PUBLIC_URL??'');
  const files=pilotHostFiles(plan);
  Object.assign(env,parseEnv(files['routing.env']!));
  process.umask(0o077);
  await mkdir(HOST_HOME,{recursive:true,mode:0o700});
  await mkdir('/etc/tbd',{recursive:true,mode:0o700});
  for(const [name,body] of Object.entries(files))await writeFile(`/etc/tbd/${name}`,body,{mode:0o600});
  void start('API',HOST_NODE,[`${HOST_APP}/dist/server.js`],env);
  await ready('http://127.0.0.1:8787/health');
  if(process.env.APT_RENDER_PROVISION==='true') {
    // Explicit first-deploy/repair setting, never a migration or founder grant.
    // Runs real model validation; turn it off after the successful bootstrap.
    for(const id of config.pilotUserIds)await start('Provisioning',HOST_NODE,[`${HOST_APP}/dist/admin/provision-user.js`,'--user-id',id],env,true);
  }
  await start('Profile preflight',HOST_NODE,[`${HOST_APP}/dist/admin/pilot-host.js`,'check'],env,true);
  for(const route of plan.routes)void start(route.instance,HOST_CLI,['--profile',route.profileName,'gateway','run','--force','--external-supervisor','--accept-hooks'],{
    ...isolatedProcessEnvironment(),...parseEnv(files[`${route.instance}.env`]!),HOME:'/var/lib/tbd',
  });
  await ready(plan.routes[0]!.url+'/health');await ready(plan.routes[1]!.url+'/health');
  let checked=false;
  for(let n=0;n<12&&!checked;n++) {
    try {await start('Authenticated runtime preflight',HOST_NODE,[`${HOST_APP}/dist/admin/pilot-host.js`,'check-running'],env,true);checked=true;}
    catch {if(stopping||n===11)throw new Error('Runtime readiness failed.');await new Promise(resolve=>setTimeout(resolve,1000));}
  }
  await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(port,'0.0.0.0',resolve);});
  process.stdout.write('Render pilot ready; only app routes are public.\n');
} catch {
  // Config/provider output must not be copied into startup failure messages.
  process.stderr.write('Render pilot startup failed. Check protected configuration, migrations and profile readiness.\n');
  await shutdown(1);
}
