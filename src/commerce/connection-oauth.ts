import { discoverOAuthProtectedResourceMetadata, discoverAuthorizationServerMetadata, registerClient,
  startAuthorization, exchangeAuthorization, refreshAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { publicEndpoint, publicEndpointFetch } from './public-http.js';

export interface ConnectionMetadata {
  resource:string; issuer:string; authorizationEndpoint:string; tokenEndpoint:string;
  registrationEndpoint?:string; metadataClient:boolean; scopes:string[];
}
const safe=(url:string)=>{if(!publicEndpoint(url)) throw new Error('Public OAuth endpoint required.');return new URL(url).href;};
const metadata=(value:ConnectionMetadata):AuthorizationServerMetadata=>({
  issuer:value.issuer,authorization_endpoint:value.authorizationEndpoint,token_endpoint:value.tokenEndpoint,
  ...(value.registrationEndpoint ? {registration_endpoint:value.registrationEndpoint}:{}),
  response_types_supported:['code'],grant_types_supported:['authorization_code','refresh_token'],
  code_challenge_methods_supported:['S256'],token_endpoint_auth_methods_supported:['none'],
});

/** SDK OAuth helpers with a bounded transport. Discovery sends no credentials;
 * registration/token calls are restricted to immutable owner-approved endpoints. */
export class ConnectionOAuth {
  constructor(private readonly fetchOverride?:FetchLike) {}
  private fetchFor(allowed?:string[]):FetchLike {
    const deadline=AbortSignal.timeout(25_000);let requests=0;
    return async(url,init={})=>{
      const href=safe(String(url));
      if(++requests>8 || (allowed && !allowed.includes(href)) || (!allowed && (init.method ?? 'GET')!=='GET')) throw new Error('OAuth request denied.');
      const body=init.body instanceof URLSearchParams ? init.body.toString() : init.body;
      return (this.fetchOverride ?? publicEndpointFetch(href,{metadata:true}))(href,{...init,...(body===undefined ? {} : {body}),
        signal:AbortSignal.any([deadline,...(init.signal?[init.signal]:[])])});
    };
  }
  async discover(endpoint:string,hint?:{resourceMetadataUrl?:string;scope?:string}):Promise<ConnectionMetadata> {
    safe(endpoint);
    const fetch=this.fetchFor();
    const resource=await discoverOAuthProtectedResourceMetadata(endpoint,
      hint?.resourceMetadataUrl ? {resourceMetadataUrl:safe(hint.resourceMetadataUrl)} : {},fetch);
    // The resource may cover a path prefix, but must be on the same origin and
    // a path-segment ancestor; a lookalike or sibling resource is not accepted.
    const r=new URL(safe(resource.resource)),e=new URL(endpoint);
    const prefix=r.pathname.replace(/\/$/,'');
    if(r.origin!==e.origin || !(e.pathname===prefix || e.pathname.startsWith(`${prefix}/`))) throw new Error('Resource audience mismatch.');
    const issuer=safe(resource.authorization_servers?.[0] ?? '');
    const info=await discoverAuthorizationServerMetadata(issuer,{fetchFn:fetch});
    if(!info || safe(info.issuer)!==issuer || !info.code_challenge_methods_supported?.includes('S256')
      || !info.response_types_supported.includes('code') || !info.token_endpoint
      || (info.token_endpoint_auth_methods_supported && !info.token_endpoint_auth_methods_supported.includes('none'))) throw new Error('Service does not support the required public PKCE client.');
    const scopes=(hint?.scope ? hint.scope.split(' ') : resource.scopes_supported ?? []).filter(Boolean);
    if(scopes.length>32 || scopes.some(s=>!/^[\x21\x23-\x5b\x5d-\x7e]{1,128}$/.test(s))) throw new Error('Scope limit exceeded.');
    return {resource:r.href,issuer,authorizationEndpoint:safe(info.authorization_endpoint),tokenEndpoint:safe(info.token_endpoint),
      ...(info.registration_endpoint ? {registrationEndpoint:safe(info.registration_endpoint)} : {}),
      metadataClient:info.client_id_metadata_document_supported===true,scopes:[...new Set(scopes)].sort()};
  }
  clientMetadata(publicUrl:string) {
    const root=new URL(publicUrl).origin;
    return {client_id:`${root}/commerce/connections/client.json`,client_name:'TBD personal commerce agent',
      redirect_uris:[`${root}/commerce/connections/callback`],grant_types:['authorization_code','refresh_token'],
      response_types:['code'],token_endpoint_auth_method:'none' as const};
  }
  async begin(info:ConnectionMetadata,publicUrl:string,state:string,prior?:OAuthClientInformationMixed) {
    const clientMetadata=this.clientMetadata(publicUrl);
    let client=prior;
    if(!client) {
      if(info.metadataClient) client={client_id:clientMetadata.client_id};
      else {
        if(!info.registrationEndpoint) throw new Error('Service requires pre-registered client information.');
        const {client_id:_metadataId,...registrationMetadata}=clientMetadata;
        const registered=await registerClient(info.issuer,{metadata:metadata(info),clientMetadata:registrationMetadata,scope:info.scopes.join(' '),fetchFn:this.fetchFor([info.registrationEndpoint])});
        if(registered.token_endpoint_auth_method && registered.token_endpoint_auth_method!=='none') throw new Error('Public client registration was not honored.');
        client=registered;
        if(client.client_secret) throw new Error('Unexpected confidential client registration.');
      }
    }
    const result=await startAuthorization(info.issuer,{metadata:metadata(info),clientInformation:client,
      redirectUrl:clientMetadata.redirect_uris[0]!,scope:info.scopes.join(' '),state,resource:new URL(info.resource)});
    return {...result,client};
  }
  async exchange(info:ConnectionMetadata,publicUrl:string,client:OAuthClientInformationMixed,code:string,verifier:string) {
    return this.checkTokens(await exchangeAuthorization(info.issuer,{metadata:metadata(info),clientInformation:client,
      authorizationCode:code,codeVerifier:verifier,redirectUri:this.clientMetadata(publicUrl).redirect_uris[0]!,
      resource:new URL(info.resource),fetchFn:this.fetchFor([info.tokenEndpoint])}),info);
  }
  async refresh(info:ConnectionMetadata,client:OAuthClientInformationMixed,refreshToken:string) {
    return this.checkTokens(await refreshAuthorization(info.issuer,{metadata:metadata(info),clientInformation:client,
      refreshToken,resource:new URL(info.resource),fetchFn:this.fetchFor([info.tokenEndpoint])}),info);
  }
  private checkTokens(tokens:OAuthTokens,info:ConnectionMetadata) {
    if(tokens.token_type.toLowerCase()!=='bearer' || !/^[A-Za-z0-9._~+\/-]+=*$/.test(tokens.access_token)
      || tokens.access_token.length>8192 || (tokens.refresh_token?.length ?? 0)>8192
      || (tokens.expires_in!==undefined && (!Number.isSafeInteger(tokens.expires_in) || tokens.expires_in<=0 || tokens.expires_in>31_536_000))
      || tokens.scope?.split(' ').some(scope=>!info.scopes.includes(scope))) throw new Error('Invalid token response or scope escalation.');
    return tokens;
  }
}
