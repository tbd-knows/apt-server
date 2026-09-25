import { randomBytes, randomUUID, createHash } from 'node:crypto';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { AppError } from '../errors.js';
import { conflict, digest, exchangeView, mutable } from './domain.js';
import type { CommerceService } from './service.js';
import { ConnectionOAuth, type ConnectionMetadata } from './connection-oauth.js';
import { ConnectionSecrets } from './connection-secrets.js';
import { inspectMcp, type McpInspection } from './mcp-inspection.js';
import { publicEndpoint, publicEndpointFetch } from './public-http.js';
import { executeMcp,type ServiceResult } from './mcp-execution.js';
import { activeServiceExchange,serviceActionView,wakeServiceAction,type ServiceActionRow } from './service-actions.js';
import { requireCapabilityDiscovery } from './service-policy.js';
import { requireAddressValidationContract } from './shipping-validation.js';
import { requireShippingDataConsent } from './shipping-consent.js';
import { shippoAddressArguments,shippoAddressValidation } from './shippo-evidence.js';
import type { Address } from './domain.js';
import type { PoolClient } from 'pg';
import { checkShippingOption,shippingOptionReceipt } from './shipping-option.js';
import { checkShippingRates,shippingRatesReceipt } from './shipping-rates.js';

interface Credentials { client?:OAuthClientInformationMixed; verifier?:string; tokens?:OAuthTokens; authorizationUrl?:string }
interface ConnectionRow {
  id:string;exchange_id:string;owner_id:string;research_id:string;mode:string;endpoint:string;
  state:string;metadata:ConnectionMetadata|null;binding_digest:string|null;credentials:string|null;
  state_hash:string|null;generation:string;expires_at:Date|null;access_expires_at:Date|null;inspection:McpInspection|null;failure:string|null;updated_at:Date;
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const binding=(row:ConnectionRow)=>JSON.stringify([row.id,row.owner_id,row.exchange_id,row.mode,row.endpoint]);
function view(row:ConnectionRow) {
  return {id:row.id,researchId:row.research_id,endpoint:row.endpoint,state:row.state,metadata:row.metadata,
    bindingDigest:row.binding_digest,inspection:row.inspection,failure:row.failure,updatedAt:row.updated_at,
    accessExpiresAt:row.access_expires_at,expiresAt:row.expires_at};
}
export async function listConnections(commerce:CommerceService,actor:string,exchangeId:string) {
  commerce.authorize(actor);
  const e=await commerce.repository.get(exchangeId,actor);exchangeView(e,actor);
  if(e.mode!==commerce.mode) throw new AppError('NOT_FOUND','Exchange not found.');
  return (await commerce.repository.pool.query<ConnectionRow>('select * from pilot_connections where exchange_id=$1 and owner_id=$2 and mode=$3 order by created_at',[exchangeId,actor,commerce.mode])).rows.map(view);
}

export class CommerceConnections {
  private readonly secrets:ConnectionSecrets;
  constructor(readonly commerce:CommerceService,rootSecret:string,readonly publicUrl:string,
    private readonly oauth=new ConnectionOAuth(),
    private readonly inspect=(endpoint:string,token:string)=>inspectMcp(endpoint,publicEndpointFetch(endpoint,{bearer:token})),
    private readonly execute=executeMcp) {
    this.secrets=new ConnectionSecrets(rootSecret);
  }
  private ready() {
    if(!publicEndpoint(`${this.publicUrl}/commerce/connections/callback`) || new URL(this.publicUrl).origin!==this.publicUrl)
      throw new AppError('PROVIDER_NOT_READY','Configure the public HTTPS app URL before connecting a service.');
  }
  private credentials(row:ConnectionRow) {return row.credentials ? this.secrets.open<Credentials>(binding(row),row.credentials) : {};}
  private async owned(actor:string,id:string) {
    this.commerce.authorize(actor);
    const row=(await this.commerce.repository.pool.query<ConnectionRow>('select * from pilot_connections where id=$1 and owner_id=$2 and mode=$3',[id,actor,this.commerce.mode])).rows[0];
    if(!row) throw new AppError('NOT_FOUND','Service connection not found.');
    const e=await this.commerce.repository.get(row.exchange_id,actor);exchangeView(e,actor);
    return row;
  }
  async prepare(actor:string,exchangeId:string,researchId:string) {
    this.ready();this.commerce.authorize(actor);
    const row=await this.commerce.repository.transaction(async sql=>{
      const e=await this.commerce.repository.get(exchangeId,actor,sql,true);exchangeView(e,actor);mutable(e,new Date());
      if(e.mode!==this.commerce.mode) throw new AppError('NOT_FOUND','Exchange not found.');
      const mine=await this.commerce.repository.privateInput(e,actor,sql);
      const found=await sql.query(`select * from pilot_research where id=$1 and owner_id=$2 and exchange_id=$3 and mode=$4
        and kind='inspect_mcp' and state='ready' and approved_at is not null`,[researchId,actor,e.id,e.mode]);
      const research=found.rows[0];
      if(!research || research.input.addressVersion!==(mine.discoveryVersion ?? 0) || !['authorization_required','inspected'].includes(research.result?.mcp?.status)) conflict('Inspect the current service endpoint first.');
      const prior=(await sql.query<ConnectionRow>('select * from pilot_connections where owner_id=$1 and exchange_id=$2 and research_id=$3 and mode=$4',[actor,e.id,researchId,e.mode])).rows[0];
      if(prior) {
        if(prior.state==='revoked' || prior.state==='failed' && !prior.metadata || prior.state==='discovering' && prior.updated_at.getTime()<Date.now()-90_000) {
          const retry=await sql.query<ConnectionRow>("update pilot_connections set state='discovering',generation=$2,metadata=null,binding_digest=null,updated_at=now(),failure=null where id=$1 returning *",[prior.id,randomUUID()]);
          return {row:retry.rows[0]!,run:true,hint:research.result.mcp.authHint};
        }
        return {row:prior,run:false,hint:undefined};
      }
      const count=await sql.query('select count(*)::int n from pilot_connections where owner_id=$1 and exchange_id=$2',[actor,e.id]);
      if(count.rows[0].n>=6) conflict('Review your existing service connections before adding another.');
      const inserted=await sql.query<ConnectionRow>(`insert into pilot_connections(id,exchange_id,owner_id,research_id,mode,endpoint,state)
        values($1,$2,$3,$4,$5,$6,'discovering') returning *`,[randomUUID(),e.id,actor,researchId,e.mode,research.input.url]);
      return {row:inserted.rows[0]!,run:true,hint:research.result.mcp.authHint};
    });
    if(row.run) {
      try {
        const metadata=await this.oauth.discover(row.row.endpoint,row.hint);
        const digestValue=digest({id:row.row.id,owner:actor,endpoint:row.row.endpoint,mode:this.commerce.mode,metadata});
        await this.updateAndWake(`update pilot_connections set state='review',metadata=$2,binding_digest=$3,updated_at=now()
          where id=$1 and state='discovering' and generation=$4 returning *`,[row.row.id,metadata,digestValue,row.row.generation]);
      } catch {await this.fail(row.row,'discovering','OAuth discovery is unavailable or unsupported. Your agent must find another supported connection.');}
    }
    return view(await this.owned(actor,row.row.id));
  }
  async start(actor:string,id:string,bindingDigest:string) {
    this.ready();const owned=await this.owned(actor,id);
    const e=await this.commerce.repository.get(owned.exchange_id,actor);mutable(e,new Date());
    const mine=await this.commerce.repository.privateInput(e,actor);
    const research=(await this.commerce.repository.pool.query('select input from pilot_research where id=$1',[owned.research_id])).rows[0];
    if(research?.input.addressVersion!==(mine.discoveryVersion ?? 0)) conflict('The service was discovered for a previous area. Ask your agent to review the current area.');
    if(!owned.metadata || owned.binding_digest!==bindingDigest) conflict('Connection details changed. Review them again.');
    const state=randomBytes(32).toString('base64url');
    const row=(await this.commerce.repository.pool.query<ConnectionRow>(`update pilot_connections set state='starting',state_hash=$3,generation=$4,
      expires_at=now()+interval '10 minutes',updated_at=now(),failure=null where id=$1 and binding_digest=$2
      and (state in ('review','failed','reconnect_required') or (state in ('starting','authorizing','exchanging') and expires_at<now())) returning *`,[id,bindingDigest,hash(state),randomUUID()])).rows[0];
    if(!row) {
      if(owned.state==='authorizing' && owned.expires_at && owned.expires_at>new Date()) return {url:this.credentials(owned).authorizationUrl};
      conflict('Connection is already in progress or has been disconnected.');
    }
    try {
      const result=await this.oauth.begin(row.metadata!,this.publicUrl,state,this.credentials(row).client);
      const sealed=this.secrets.seal(binding(row),{client:result.client,verifier:result.codeVerifier,authorizationUrl:result.authorizationUrl.href});
      const saved=await this.commerce.repository.pool.query(`update pilot_connections set state='authorizing',credentials=$3,updated_at=now()
        where id=$1 and state='starting' and state_hash=$2 returning id`,[id,hash(state),sealed]);
      if(!saved.rowCount) conflict('Connection was cancelled.');
      return {url:result.authorizationUrl.href};
    } catch {
      await this.fail(row,'starting','Service authorization could not start. Retry after reviewing the connection.');
      throw new AppError('UPSTREAM_FAILED','Service authorization could not start.');
    }
  }
  async callback(state:string,code?:string,denied=false) {
    if(!/^[A-Za-z0-9_-]{43}$/.test(state) || (code?.length ?? 0)>8192) return false;
    const row=(await this.commerce.repository.pool.query<ConnectionRow>(`update pilot_connections set state='exchanging',state_hash=null,updated_at=now()
      where state_hash=$1 and mode=$2 and owner_id=any($3::uuid[]) and state='authorizing' and expires_at>now() returning *`,[hash(state),this.commerce.mode,this.commerce.founders])).rows[0];
    if(!row) return false;
    try {
      if(denied || !code) throw new Error('Denied');
      const saved=this.credentials(row);
      const tokens=await this.oauth.exchange(row.metadata!,this.publicUrl,saved.client!,code,saved.verifier!);
      const sealed=this.secrets.seal(binding(row),{client:saved.client,tokens});
      // Save immediately before inspection; a crash never replays the code.
      const persisted=await this.commerce.repository.pool.query(`update pilot_connections set credentials=$2,access_expires_at=$3,updated_at=now()
        where id=$1 and state='exchanging' and generation=$4 returning id`,[row.id,sealed,new Date(Date.now()+(tokens.expires_in ?? 3600)*1000),row.generation]);
      if(!persisted.rowCount) return false;
      const inspection=this.sanitize(await this.inspect(row.endpoint,tokens.access_token),tokens);
      const committed=await this.finishInspection(row,'exchanging',inspection);
      return committed && inspection.status==='inspected';
    } catch {
      await this.fail(row,'exchanging',denied ? 'You declined service authorization.' : 'Authorization did not complete. Reconnect to start a new secure authorization.');
      return false;
    }
  }
  async recheck(actor:string,id:string) {
    const owned=await this.owned(actor,id);
    const claimed=(await this.commerce.repository.pool.query<ConnectionRow>(`update pilot_connections set state='exchanging',generation=$2,expires_at=now()+interval '2 minutes',updated_at=now()
      where id=$1 and (state='connected' or (state='exchanging' and expires_at<now())) returning *`,[id,randomUUID()])).rows[0];
    if(!claimed) conflict('Finish or restart service authorization before rechecking.');
    try {
      const saved=this.credentials(claimed);let tokens=saved.tokens;
      if(!tokens) throw new Error('No tokens');
      if(!claimed.access_expires_at || claimed.access_expires_at.getTime()<=Date.now()+60_000) {
        if(!tokens.refresh_token) throw new Error('Reconnect required');
        tokens=await this.oauth.refresh(claimed.metadata!,saved.client!,tokens.refresh_token);
        const update=await this.commerce.repository.pool.query(`update pilot_connections set credentials=$2,access_expires_at=$3,updated_at=now()
          where id=$1 and state='exchanging' and generation=$4 returning id`,[id,this.secrets.seal(binding(claimed),{client:saved.client,tokens}),new Date(Date.now()+(tokens.expires_in ?? 3600)*1000),claimed.generation]);
        if(!update.rowCount) return view(await this.owned(actor,id));
      }
      await this.finishInspection(claimed,'exchanging',this.sanitize(await this.inspect(claimed.endpoint,tokens.access_token),tokens));
    } catch {await this.fail(claimed,'exchanging','Service access expired or could not be verified. Reconnect to authorize again.','reconnect_required');}
    return view(await this.owned(actor,owned.id));
  }
  async disconnect(actor:string,id:string) {
    await this.owned(actor,id);
    await this.updateAndWake(`update pilot_connections set state='revoked',credentials=null,state_hash=null,
      inspection=null,access_expires_at=null,failure=null,generation=$2,updated_at=now() where id=$1 returning *`,[id,randomUUID()]);
    return {ok:true};
  }
  private async checkActionPolicy(sql:PoolClient,row:ServiceActionRow) {
    if(row.invocation.shippingOption) return {option:await checkShippingOption(this.commerce,sql,row)};
    if(row.invocation.shippingRates) return {rates:await checkShippingRates(this.commerce,sql,row)};
    if(!row.invocation.shippingValidation) {requireCapabilityDiscovery(row.endpoint,row.invocation);return;}
    const context=row.invocation.shippingValidation;
    requireAddressValidationContract(row.endpoint,row.invocation);
    const e=await this.commerce.repository.get(row.exchange_id,row.owner_id,sql,true);
    if(row.owner_id!==e.sellerId || ![e.buyerId,e.sellerId].includes(context.addressOwnerId)) conflict('Shipping validation belongs to another participant.');
    const inputs=await requireShippingDataConsent(this.commerce,sql,e,row.connection_id,context.consentId,new Date());
    const buyer=context.addressOwnerId===e.buyerId;
    const address=buyer?inputs.destination:inputs.origin;
    if(context.addressVersion!==(buyer?e.shippingData!.destinationVersion:e.shippingData!.originVersion)
      || digest(row.invocation.arguments.arguments)!==digest(shippoAddressArguments(address))) conflict('The approved private shipping inputs changed.');
    return {address};
  }
  async decideAction(actor:string,id:string,bindingDigest:string,approve:boolean,purpose:'capability_discovery_only'|'free_address_validation'|'free_shipping_rates'|'free_shipping_option'='capability_discovery_only') {
    this.commerce.authorize(actor);
    const claimed=await this.commerce.repository.transaction(async sql=>{
      const initial=(await sql.query<ServiceActionRow>('select * from pilot_service_actions where id=$1 and owner_id=$2 and mode=$3',[id,actor,this.commerce.mode])).rows[0];
      if(!initial) throw new AppError('NOT_FOUND','Service action not found.');
      const e=await this.commerce.repository.get(initial.exchange_id,actor,sql,true);exchangeView(e,actor);
      const connection=(await sql.query<ConnectionRow>('select * from pilot_connections where id=$1 for update',[initial.connection_id])).rows[0]!;
      const row=(await sql.query<ServiceActionRow>('select * from pilot_service_actions where id=$1 for update',[id])).rows[0]!;
      if(row.digest!==bindingDigest) conflict('Service action details changed. Review them again.');
      if(row.state!=='review') return {row,connection,run:false};
      if(approve) {
        if(purpose!==(row.invocation.shippingOption?'free_shipping_option':row.invocation.shippingRates?'free_shipping_rates':row.invocation.shippingValidation?'free_address_validation':'capability_discovery_only')) conflict('Review the correct service action purpose.');
        await this.checkActionPolicy(sql,row);
        activeServiceExchange(e);
        if(row.revision!==e.revision || row.expires_at<=new Date()) conflict('Service action expired or the exchange changed. Ask your agent to prepare it again.');
        if(connection.owner_id!==actor || connection.exchange_id!==e.id || connection.mode!==e.mode || connection.state!=='connected'
          || connection.generation!==row.generation || connection.endpoint!==row.endpoint) conflict('Service access changed. Review the connection again.');
      }
      const updated=(await sql.query<ServiceActionRow>(`update pilot_service_actions set state=$2,approved_at=$3,updated_at=now() where id=$1 returning *`,
        [id,approve?'verifying':'declined',approve?new Date():null])).rows[0]!;
      if(!approve) await wakeServiceAction(this.commerce,sql,updated);
      return {row:updated,connection,run:approve};
    });
    if(!claimed.run) return serviceActionView(claimed.row);
    let outcome:ServiceResult={state:'failed'};
    let validatedAddress:Address|undefined;
    let optionBinding:Awaited<ReturnType<typeof checkShippingOption>>|undefined;
    let rateBinding:Awaited<ReturnType<typeof checkShippingRates>>|undefined;
    let validation:ReturnType<typeof shippoAddressValidation>|undefined;
    try {
      const tokens=this.credentials(claimed.connection).tokens;
      if(!tokens || !claimed.connection.access_expires_at || claimed.connection.access_expires_at.getTime()<Date.now()+60_000) throw new Error('Recheck service access');
      const redact=(value:string)=>{
        for(const secret of [tokens.access_token,tokens.refresh_token]) if(secret) value=value.replaceAll(JSON.stringify(secret).slice(1,-1),'[credential removed]');
        return value;
      };
      outcome=await this.execute(claimed.row.endpoint,claimed.row.invocation,async()=>{
        await this.commerce.repository.transaction(async sql=>{
          const e=await this.commerce.repository.get(claimed.row.exchange_id,actor,sql,true);activeServiceExchange(e);
          const policy=await this.checkActionPolicy(sql,claimed.row);
          validatedAddress=policy?.address;rateBinding=policy?.rates;optionBinding=policy?.option;
          const connection=(await sql.query<ConnectionRow>('select * from pilot_connections where id=$1 for update',[claimed.row.connection_id])).rows[0]!;
          if(e.revision!==claimed.row.revision || claimed.row.expires_at<=new Date() || connection.state!=='connected'
            || connection.generation!==claimed.row.generation || connection.credentials!==claimed.connection.credentials) conflict('Service approval changed before dispatch.');
          const sent=await sql.query("update pilot_service_actions set state='running',updated_at=now() where id=$1 and state='verifying' returning id",[id]);
          if(!sent.rowCount) conflict('This service action is no longer available for dispatch.');
        });
      },publicEndpointFetch(claimed.row.endpoint,{bearer:tokens.access_token}),redact);
      if(claimed.row.invocation.shippingOption) {
        if(outcome.state==='returned' && optionBinding) {
          try {outcome={state:'returned',result:shippingOptionReceipt(outcome,optionBinding,claimed.row.invocation.shippingOption)};}
          catch {outcome={state:'returned_error'};}
        } else outcome={state:outcome.state};
      }
      if(claimed.row.invocation.shippingRates) {
        if(outcome.state==='returned' && rateBinding) {
          try {outcome={state:'returned',result:shippingRatesReceipt(outcome,rateBinding.binding,rateBinding.expectedShipmentId)};}
          catch {outcome={state:'returned_error'};}
        } else outcome={state:outcome.state};
      }
      if(claimed.row.invocation.shippingValidation) {
        // Raw receipt may echo BOTH private addresses or account secrets. Never
        // retain it in a service-action response, model context or peer message.
        if(outcome.state==='returned' && validatedAddress) {
          try {
            validation=shippoAddressValidation(outcome,validatedAddress);
            outcome={state:'returned',result:{text:[],omittedContentTypes:[],structuredContent:{addressValidation:validation.status}}};
          } catch {outcome={state:'returned_error'};}
        } else outcome={state:outcome.state};
      }
    } catch { /* A durable running state below always remains uncertain. */ }
    return this.commerce.repository.transaction(async sql=>{
      if(validation?.suggestedAddress && claimed.row.invocation.shippingValidation) {
        const context=claimed.row.invocation.shippingValidation;
        const e=await this.commerce.repository.get(claimed.row.exchange_id,actor,sql,true);
        const ownerInput=await this.commerce.repository.privateInput(e,context.addressOwnerId,sql);
        if(ownerInput.addressVersion===context.addressVersion && e.payment==='unpaid'
          && e.shippingData?.id===context.consentId && !e.cancellationRequested) {
          ownerInput.suggestedAddress=validation.suggestedAddress;
          await this.commerce.repository.savePrivate(sql,e,context.addressOwnerId,ownerInput);
          await this.commerce.repository.message(sql,e,actor,context.addressOwnerId,'status',{action:'shipping_data_update',text:'Review the address correction in your private shipping form.'});
        }
      }
      const result=(await sql.query<ServiceActionRow>(`update pilot_service_actions set
        state=case when $2='failed' and state in ('running','uncertain') then 'uncertain' else $2 end,result=$3,updated_at=now()
        where id=$1 and state in ('verifying','running','uncertain') returning *`,[id,outcome.state,outcome.result ?? null])).rows[0];
      if(result) {await wakeServiceAction(this.commerce,sql,result);return serviceActionView(result);}
      return serviceActionView((await sql.query<ServiceActionRow>('select * from pilot_service_actions where id=$1',[id])).rows[0]!);
    });
  }
  private async finishInspection(row:ConnectionRow,state:string,inspection:McpInspection) {
    return this.updateAndWake(`update pilot_connections set state=$3,inspection=$4,updated_at=now(),failure=$5
      where id=$1 and state=$2 and generation=$6 returning *`,[row.id,state,inspection.status==='inspected'?'connected':'reconnect_required',inspection,
      inspection.status==='inspected'?null:'Service access could not be verified. Reconnect or choose another service.',row.generation]);
  }
  private sanitize(inspection:McpInspection,tokens:OAuthTokens) {
    let text=JSON.stringify(inspection);
    for(const secret of [tokens.access_token,tokens.refresh_token]) if(secret) text=text.replaceAll(JSON.stringify(secret).slice(1,-1),'[credential removed]');
    const result=JSON.parse(text) as McpInspection;
    if(result.schemaDigest) result.schemaDigest=digest(result.tools);
    return result;
  }
  private async fail(row:ConnectionRow,expected:string,message:string,state='failed') {
    await this.updateAndWake(`update pilot_connections set state=$3,failure=$4,state_hash=null,updated_at=now()
      where id=$1 and state=$2 and generation=$5 returning *`,[row.id,expected,state,message,row.generation]);
  }
  private async updateAndWake(statement:string,params:unknown[]) {
    return this.commerce.repository.transaction(async sql=>{
      const rows=(await sql.query<ConnectionRow>(statement,params)).rows;
      for(const row of rows) {
        const e=await this.commerce.repository.get(row.exchange_id,row.owner_id,sql);
        await this.commerce.repository.message(sql,e,row.owner_id,row.owner_id,'status',{action:'connection_update',connectionId:row.id});
      }
      return rows.length>0;
    });
  }
}

/** No automatic code or refresh replay after a crash. Restore a visible owner
 * action and fence stale in-flight responses before the next worker turn. */
export async function recoverConnections(commerce:CommerceService) {
  await commerce.repository.transaction(async sql=>{
    const rows=(await sql.query<ConnectionRow>(`update pilot_connections set
      state=case when metadata is null then 'failed' else 'reconnect_required' end,
      state_hash=null,generation=gen_random_uuid(),updated_at=now(),failure='The connection wait expired. Review the service and reconnect.'
      where mode=$1 and owner_id=any($2::uuid[]) and (
        (state='discovering' and updated_at<now()-interval '90 seconds')
        or (state in ('starting','authorizing','exchanging') and expires_at<now())) returning *`,[commerce.mode,commerce.founders])).rows;
    for(const row of rows) {
      const e=await commerce.repository.get(row.exchange_id,row.owner_id,sql);
      await commerce.repository.message(sql,e,row.owner_id,row.owner_id,'status',{action:'connection_update',connectionId:row.id});
    }
  });
}
