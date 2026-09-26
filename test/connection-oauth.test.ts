import { describe,it,expect } from 'vitest';
import { ConnectionOAuth,type ConnectionMetadata } from '../src/commerce/connection-oauth.js';
import { ConnectionSecrets } from '../src/commerce/connection-secrets.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

const endpoint='https://mcp.vendor.com/mcp',issuer='https://login.vendor.com/';
const publicUrl='https://app.tbd.com';
const info:ConnectionMetadata={resource:endpoint,issuer,authorizationEndpoint:`${issuer}authorize`,tokenEndpoint:`${issuer}token`,registrationEndpoint:`${issuer}register`,metadataClient:true,scopes:['shipping:read']};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
describe('service OAuth and credential boundaries',()=>{
  it('discovers the resource and issuer using SDK metadata validation',async()=>{
    const urls:string[]=[];
    const fetch:FetchLike=async(url,init)=>{
      urls.push(String(url));expect(init?.method ?? 'GET').toBe('GET');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      if(String(url).includes('oauth-protected-resource')) return json({resource:endpoint,authorization_servers:[issuer],scopes_supported:['shipping:read']});
      return json({issuer,authorization_endpoint:info.authorizationEndpoint,token_endpoint:info.tokenEndpoint,registration_endpoint:info.registrationEndpoint,
        response_types_supported:['code'],code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],client_id_metadata_document_supported:true});
    };
    expect(await new ConnectionOAuth(fetch).discover(endpoint)).toEqual(info);
    expect(urls).toContain('https://mcp.vendor.com/.well-known/oauth-protected-resource/mcp');
    expect(urls).toContain('https://login.vendor.com/.well-known/oauth-authorization-server');
  });
  it('binds PKCE, state, resource, scopes and redirect; does not register when metadata clients are supported',async()=>{
    const oauth=new ConnectionOAuth(async()=>{throw new Error('Network not needed');});
    const start=await oauth.begin(info,publicUrl,'OWNER_BOUND_STATE');
    expect(start.client.client_id).toBe(`${publicUrl}/commerce/connections/client.json`);
    expect(start.authorizationUrl.searchParams.get('state')).toBe('OWNER_BOUND_STATE');
    expect(start.authorizationUrl.searchParams.get('resource')).toBe(endpoint);
    expect(start.authorizationUrl.searchParams.get('scope')).toBe('shipping:read');
    expect(start.authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');
    expect(start.authorizationUrl.searchParams.get('redirect_uri')).toBe(`${publicUrl}/commerce/connections/callback`);
    expect(start.codeVerifier.length).toBeGreaterThanOrEqual(43);
  });
  it('registers a public client only at the approved registration endpoint',async()=>{
    let calls=0;
    const oauth=new ConnectionOAuth(async(url,init)=>{
      calls++;expect(String(url)).toBe(info.registrationEndpoint);expect(init?.method).toBe('POST');
      const input=JSON.parse(String(init?.body));expect(input.token_endpoint_auth_method).toBe('none');
      return json({...input,client_id:'registered-public-client'},201);
    });
    const result=await oauth.begin({...info,metadataClient:false},publicUrl,'state');
    expect(result.client.client_id).toBe('registered-public-client');expect(calls).toBe(1);
  });
  it('exchanges and refreshes only against the approved token endpoint with resource binding',async()=>{
    const calls:URLSearchParams[]=[];
    const oauth=new ConnectionOAuth(async(url,init)=>{
      expect(String(url)).toBe(info.tokenEndpoint);expect(init?.method).toBe('POST');
      const body=new URLSearchParams(String(init?.body));calls.push(body);
      expect(body.get('resource')).toBe(endpoint);
      return json({access_token:'ACCESS_CANARY',refresh_token:'REFRESH_CANARY',token_type:'Bearer',expires_in:3600,scope:'shipping:read'});
    });
    const start=await oauth.begin(info,publicUrl,'state');
    const tokens=await oauth.exchange(info,publicUrl,start.client,'CODE_CANARY',start.codeVerifier);
    expect(calls[0]!.get('code_verifier')).toBe(start.codeVerifier);
    expect(calls[0]!.get('code')).toBe('CODE_CANARY');
    await oauth.refresh(info,start.client,tokens.refresh_token!);
    expect(calls[1]!.get('refresh_token')).toBe('REFRESH_CANARY');
    expect(calls[1]!.get('grant_type')).toBe('refresh_token');
  });
  it('rejects resource or issuer substitution, unsafe endpoints and scope escalation',async()=>{
    const resource=new ConnectionOAuth(async()=>json({resource:'https://attacker.com/mcp',authorization_servers:[issuer]}));
    await expect(resource.discover(endpoint)).rejects.toThrow('audience');
    const issuerSwap=new ConnectionOAuth(async(url)=>String(url).includes('protected-resource')
      ?json({resource:endpoint,authorization_servers:[issuer]})
      :json({issuer:'https://attacker.com',authorization_endpoint:info.authorizationEndpoint,token_endpoint:info.tokenEndpoint,response_types_supported:['code'],code_challenge_methods_supported:['S256']}));
    await expect(issuerSwap.discover(endpoint)).rejects.toThrow();
    const unsafe=new ConnectionOAuth(async()=>json({resource:endpoint,authorization_servers:['https://127.0.0.1/']}));
    await expect(unsafe.discover(endpoint)).rejects.toThrow();
    const escalated=new ConnectionOAuth(async()=>json({access_token:'token',token_type:'Bearer',scope:'shipping:write'}));
    await expect(escalated.exchange(info,publicUrl,{client_id:'client'},'code','verifier')).rejects.toThrow('escalation');
  });
  it('encrypts credentials with owner/service binding and fails on tampering or key changes',()=>{
    const secrets=new ConnectionSecrets('a'.repeat(32));
    const encrypted=secrets.seal('owner-A|service-A|test',{token:'PRIVATE_TOKEN'});
    expect(encrypted).not.toContain('PRIVATE_TOKEN');
    expect(secrets.open('owner-A|service-A|test',encrypted)).toEqual({token:'PRIVATE_TOKEN'});
    expect(()=>secrets.open('owner-B|service-A|test',encrypted)).toThrow();
    expect(()=>secrets.open('owner-A|service-A|live',encrypted)).toThrow();
    expect(()=>new ConnectionSecrets('b'.repeat(32)).open('owner-A|service-A|test',encrypted)).toThrow();
    const parts=encrypted.split('.');parts[2]=Buffer.from('tampered').toString('base64url');
    expect(()=>secrets.open('owner-A|service-A|test',parts.join('.'))).toThrow();
  });
});
