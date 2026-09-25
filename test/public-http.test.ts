import { createServer } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadShippingArtifact } from '../src/commerce/shipping-artifact.js';
import sharp from 'sharp';
import { publicEndpointFetch,publicLocationFetch } from '../src/commerce/public-http.js';

const state=vi.hoisted(()=>({ips:['93.184.216.34'],port:0,ca:'',requests:0,pinned:[] as string[],status:200,body:'{"ok":true}' as string|Buffer,path:'',type:'application/json',encoding:''}));
vi.mock('node:dns/promises',()=>({lookup:vi.fn(async()=>state.ips.map(address=>({address,family:4})))}));
vi.mock('node:https',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:https')>();
  return {...actual,request:((url:URL,options:import('node:https').RequestOptions,callback:Parameters<typeof actual.request>[2])=>{
    state.requests++;
    // Exercise the production pin callback, then route only the test socket to
    // loopback. TLS still verifies mcp.vendor.com using a temporary fixture CA.
    const pin=options.lookup!;
    pin('mcp.vendor.com',{all:false},(error,address)=>{expect(error).toBeNull();state.pinned.push(String(address));});
    expect(options.agent).toBe(false);
    const local=new URL(url);local.port=String(state.port);
    return actual.request(local,{...options,ca:state.ca,lookup:(_host,lookupOptions,done)=>{
      if(lookupOptions.all) done(null,[{address:'127.0.0.1',family:4}]);
      else done(null,'127.0.0.1',4);
    }},callback);
  }) as typeof actual.request};
});
const directory=mkdtempSync(join(tmpdir(),'tbd-mcp-tls-'));
let server:ReturnType<typeof createServer>;
beforeAll(async()=>{
  const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=mcp.vendor.com'],{stdio:'ignore'});
  state.ca=readFileSync(cert,'utf8');
  server=createServer({key:readFileSync(key),cert:state.ca},(req,res)=>{
    state.path=req.url ?? '';
    expect(req.headers.cookie).toBeUndefined();
    expect(req.headers.authorization).toBeUndefined();
    res.writeHead(state.status,{'content-type':state.type,'location':'https://127.0.0.1/private',...(state.encoding?{'content-encoding':state.encoding}:{})});
    res.end(state.body);
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  state.port=(server.address() as AddressInfo).port;
});
beforeEach(()=>{state.ips=['93.184.216.34'];state.requests=0;state.pinned=[];state.status=200;state.type='application/json';state.encoding='';state.body='{"ok":true}';});
afterAll(async()=>{if(server) await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(directory,{recursive:true,force:true});});
const fetch=()=>publicEndpointFetch('https://mcp.vendor.com/mcp');
const post={method:'POST',body:'{}',headers:{'content-type':'application/json'}};
describe('bounded public HTTPS transport',()=>{
  it('fetches bounded public location documents without permitting query secrets or credentials',async()=>{
    const url='https://mcp.vendor.com/en/search?entityId=FIXTURE';
    const location=publicLocationFetch(url,'json');
    state.body=JSON.stringify({padding:'x'.repeat(2_300_000)});
    expect((await (await location(url)).json()).padding.length).toBe(2_300_000);
    expect(state.path).toBe('/en/search?entityId=FIXTURE');
    state.body='x'.repeat(3*1_048_576+1);
    await expect((await location(url)).text()).rejects.toThrow();
    for(const invalid of [url+'&token=SECRET',url.replace('entityId','token'),url+'&entityId=SECOND',
      url.replace('FIXTURE','..%2Fprivate'),url.replace('https://','https://user:secret@')]) {
      expect(()=>publicLocationFetch(invalid,'json')).toThrow();
    }
    expect(()=>location(url,{method:'POST'})).toThrow();
    await expect(location(url,{headers:{authorization:'Bearer SECRET'}})).rejects.toThrow();
    state.type='text/html';state.body='<html>public location</html>';
    expect(await (await publicLocationFetch('https://mcp.vendor.com/location','html')('https://mcp.vendor.com/location')).text()).toBe(state.body);
    state.ips=['127.0.0.1'];await expect(location(url)).rejects.toThrow();
  });
  it('uses verified TLS and pins a validated DNS answer on each request',async()=>{
    expect(await (await fetch()('https://mcp.vendor.com/mcp',post)).json()).toEqual({ok:true});
    expect(state.pinned).toEqual(['93.184.216.34']);
    state.ips=['127.0.0.1'];
    await expect(fetch()('https://mcp.vendor.com/mcp',post)).rejects.toThrow();
    expect(state.requests).toBe(1);
  });
  it('rejects mixed DNS, ambient credentials and endpoint changes before connection',async()=>{
    state.ips=['93.184.216.34','10.0.0.1'];
    await expect(fetch()('https://mcp.vendor.com/mcp',post)).rejects.toThrow();
    state.ips=['93.184.216.34'];
    await expect(fetch()('https://mcp.vendor.com/other',post)).rejects.toThrow();
    for(const header of ['authorization','cookie','proxy-authorization']) await expect(fetch()('https://mcp.vendor.com/mcp',{...post,headers:{[header]:'SECRET'}})).rejects.toThrow();
    expect(state.requests).toBe(0);
  });
  it('does not follow redirects or retain remote error bodies',async()=>{
    state.status=302;state.body='SECRET_REMOTE_ERROR';
    const redirected=await fetch()('https://mcp.vendor.com/mcp',post);
    expect(redirected.status).toBe(302);expect(await redirected.text()).toBe('');expect(redirected.headers.has('location')).toBe(false);
    state.status=401;
    expect(await (await fetch()('https://mcp.vendor.com/mcp',post)).text()).toBe('');
    expect(state.requests).toBe(2);
  });
  it('rejects oversized streams, unexpected content and compression',async()=>{
    state.body='x'.repeat(1_048_577);
    await expect((await fetch()('https://mcp.vendor.com/mcp',post)).text()).rejects.toThrow();
    state.body='<html>not MCP</html>';state.type='text/html';
    await expect(fetch()('https://mcp.vendor.com/mcp',post)).rejects.toThrow();
    state.type='application/json';state.encoding='gzip';
    await expect(fetch()('https://mcp.vendor.com/mcp',post)).rejects.toThrow();
  });
});


describe('private postage downloads',()=>{
  const url='https://mcp.vendor.com/postage.pdf?signature=PRIVATE_SIGNED_CANARY';
  it('pins public DNS and preserves the exact signed URL without ambient authentication',async()=>{
    state.type='application/pdf';state.body='%PDF-1.7\nfixture\n%%EOF';
    const result=await downloadShippingArtifact(url,'pdf');
    expect(result.artifact).toBe('pdf');expect(state.path).toBe('/postage.pdf?signature=PRIVATE_SIGNED_CANARY');
    expect(state.pinned).toEqual(['93.184.216.34']);expect(JSON.stringify(result)).not.toContain('PRIVATE_SIGNED_CANARY');
  });
  it('rejects private/mixed DNS, unsafe URLs and redirects without disclosing signed URLs in errors',async()=>{
    state.ips=['93.184.216.34','127.0.0.1'];
    await expect(downloadShippingArtifact(url,'pdf')).rejects.toThrow('could not be retrieved');expect(state.requests).toBe(0);
    state.ips=['93.184.216.34'];
    for(const invalid of ['https://127.0.0.1/x','http://mcp.vendor.com/x','https://user:password@mcp.vendor.com/x',url+'#fragment']) {
      await expect(downloadShippingArtifact(invalid,'pdf')).rejects.toThrow('could not be retrieved');
    }
    expect(state.requests).toBe(0);state.status=302;
    await expect(downloadShippingArtifact(url,'pdf')).rejects.toThrow('could not be retrieved');expect(state.requests).toBe(1);
  });
  it('preserves the canonical QR document kind and rejects mislabeled, compressed or oversized downloads',async()=>{
    state.type='application/pdf';state.body='%PDF-1.7\nfixture\n%%EOF';
    expect(await downloadShippingArtifact(url,'label_qr')).toMatchObject({artifact:'label_qr',mime:'application/pdf'});
    state.encoding='gzip';await expect(downloadShippingArtifact(url,'pdf')).rejects.toThrow();state.encoding='';
    state.body='x'.repeat(5*1024*1024+1);await expect(downloadShippingArtifact(url,'pdf')).rejects.toThrow();
    state.type='image/png';state.body=await sharp({create:{width:48,height:48,channels:3,background:'white'}}).png().toBuffer();
    const image=await downloadShippingArtifact(url,'label_qr');expect(image).toMatchObject({artifact:'label_qr',mime:'image/png',width:48,height:48});
    // Fixture only verifies PNG transport. It is deliberately not proof of an issued QR.
  });
});
