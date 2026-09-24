import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { conflict, digest, exchangeView, mutable } from './domain.js';
import type { CommerceService } from './service.js';
import { inspectMcp, type McpInspection } from './mcp-inspection.js';
import { publicEndpoint } from './public-http.js';

export const researchInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('nearby') }).strict(),
  z.object({ kind: z.enum(['capabilities','read_source','inspect_mcp']), researchId: z.uuid(), sourceId: z.uuid() }).strict(),
]);
export function publicSourceUrl(value: string) {
  if (!URL.canParse(value) || value.length > 2000) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
    && !['localhost','metadata.google.internal'].includes(url.hostname)
    && !/\.(local|internal)$/.test(url.hostname) && !/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(':')
    && ![...url.searchParams.keys()].some(key=>/token|secret|password|auth|signature|credential|api.?key/i.test(key));
}
const sourceSchema = z.object({ url: z.string().refine(publicSourceUrl), title: z.string().max(300), description: z.string().max(1500) }).strict();
const resultSchema = z.discriminatedUnion('success', [
  z.object({ success: z.literal(true), sources: z.array(sourceSchema).max(8), text: z.string().max(24000).optional() }).strict(),
  z.object({ success: z.literal(false) }).strict(),
]);
interface ResearchRow {
  id: string; exchange_id: string; owner_id: string; kind: 'nearby' | 'capabilities' | 'read_source' | 'inspect_mcp';
  input: { query?: string; url?: string; addressVersion: number }; input_hash: string;
  state: 'awaiting_approval' | 'declined' | 'pending' | 'running' | 'ready' | 'failed'; attempts: number; lease_id: string | null;
  approved_at: Date | null;
  result: { sources: Array<z.infer<typeof sourceSchema> & { id: string }>; text?: string; mcp?: McpInspection; checkedAt: string; verifiedForFulfillment: false } | null;
  created_at: Date; updated_at: Date;
}

/** Jobs contain server-generated public queries or a previously observed URL.
 * Models cannot smuggle a private prompt/budget/address into arbitrary queries. */
export class CommerceResearch {
  constructor(private readonly commerce: CommerceService) {}

  async request(actor: string, exchangeId: string, raw: unknown) {
    this.commerce.authorize(actor);
    const command = researchInputSchema.parse(raw);
    return this.commerce.repository.transaction(async sql => {
      const e = await this.commerce.repository.get(exchangeId,actor,sql,true);
      exchangeView(e,actor); mutable(e,new Date());
      if (e.mode !== this.commerce.mode) throw new AppError('NOT_FOUND','Exchange not found.');
      const mine = await this.commerce.repository.privateInput(e,actor,sql);
      let input: ResearchRow['input'];
      if (command.kind === 'nearby') {
        if (!mine.discoveryPostcode) conflict('Ask your owner to enter a postcode for service discovery. Full addresses are not used for search.');
        input = { query: `parcel shipping drop off${mine.packing?.canPrint === false ? ' label printing' : ''} near ${mine.discoveryPostcode} US`, addressVersion: mine.discoveryVersion ?? 0 };
      } else {
        const parent = await sql.query<ResearchRow>('select * from pilot_research where id=$1 and exchange_id=$2 and owner_id=$3 and mode=$4 and state=\'ready\'', [command.researchId,e.id,actor,e.mode]);
        const source = parent.rows[0]?.result?.sources.find(s=>s.id===command.sourceId);
        if (!source || !publicSourceUrl(source.url)) throw new AppError('NOT_FOUND','Research source not found.');
        if (parent.rows[0]!.input.addressVersion !== (mine.discoveryVersion ?? 0)) conflict('The discovery area changed. Start a new nearby search.');
        if (command.kind === 'inspect_mcp' && !publicEndpoint(source.url)) conflict('A public HTTPS MCP endpoint without query credentials is required.');
        input = command.kind === 'read_source' || command.kind === 'inspect_mcp' ? { url: source.url, addressVersion: mine.discoveryVersion ?? 0 }
          : { query: `${new URL(source.url).hostname} official shipping MCP API tools label purchase authentication`, addressVersion: mine.discoveryVersion ?? 0 };
      }
      const hash = digest(input);
      const existing = await sql.query<ResearchRow>('select * from pilot_research where owner_id=$1 and exchange_id=$2 and kind=$3 and input_hash=$4', [actor,e.id,command.kind,hash]);
      if (existing.rows[0]) return this.view(existing.rows[0],mine.discoveryVersion ?? 0);
      const count = await sql.query("select count(*)::int n from pilot_research where owner_id=$1 and exchange_id=$2 and input->>'addressVersion'=$3", [actor,e.id,String(mine.discoveryVersion ?? 0)]);
      if (count.rows[0].n>=12) conflict('Research limit reached for this area. Review the available sources with your owner.');
      const created = await sql.query<ResearchRow>(`insert into pilot_research(id,exchange_id,owner_id,mode,kind,input,input_hash,state)
        values($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [randomUUID(),e.id,actor,e.mode,command.kind,input,hash,
        command.kind === 'inspect_mcp' ? 'awaiting_approval' : 'pending']);
      if (command.kind === 'inspect_mcp') await this.commerce.repository.message(sql,e,actor,actor,'question',
        {action:'inspect_mcp',researchId:created.rows[0]!.id,text:'Review the service endpoint in Actions before allowing capability inspection.'});
      return this.view(created.rows[0]!,mine.discoveryVersion ?? 0);
    });
  }
  private view(row: ResearchRow, version: number) {
    return { id: row.id, kind: row.kind, state: row.state, input: row.input,
      currentArea: row.input.addressVersion===version, result: row.result, updatedAt: row.updated_at,
      inspectionDigest: row.kind==='inspect_mcp' ? digest({id:row.id,endpoint:row.input.url,owner:row.owner_id,area:row.input.addressVersion}) : null,
      limitation: 'Public research only. A source is not proof of provider identity, tool availability, a rate, paid postage or drop-off compatibility.' };
  }
  async list(actor: string, exchangeId: string) {
    this.commerce.authorize(actor);
    const e = await this.commerce.repository.get(exchangeId,actor);
    exchangeView(e,actor);
    if (e.mode !== this.commerce.mode) throw new AppError('NOT_FOUND','Exchange not found.');
    const mine = await this.commerce.repository.privateInput(e,actor);
    const result = await this.commerce.repository.pool.query<ResearchRow>('select * from pilot_research where owner_id=$1 and exchange_id=$2 and mode=$3 order by created_at desc limit 24', [actor,e.id,e.mode]);
    return result.rows.map(row=>this.view(row,mine.discoveryVersion ?? 0));
  }
  private async owner(profile: string) {
    const row = await this.commerce.repository.pool.query("select user_id from agent_instances where hermes_profile_name=$1 and status='ready'", [profile]);
    const actor = row.rows[0]?.user_id as string | undefined;
    if (!actor) throw new AppError('FORBIDDEN','Agent is not ready.');
    this.commerce.authorize(actor); return actor;
  }
  async outbox(profile: string) {
    const actor = await this.owner(profile);
    return this.commerce.repository.transaction(async sql => {
      const expired = await sql.query<ResearchRow>(`update pilot_research set state='failed',updated_at=now()
        where owner_id=$1 and mode=$2 and kind<>'inspect_mcp' and state='running' and attempts=3 and updated_at<now()-interval '90 seconds' returning *`, [actor,this.commerce.mode]);
      for (const row of expired.rows) {
        const e = await this.commerce.repository.get(row.exchange_id,actor,sql);
        await this.commerce.repository.message(sql,e,actor,actor,'status',{action:'research_update',researchId:row.id});
      }
      const result = await sql.query<ResearchRow>(`select * from pilot_research where owner_id=$1 and mode=$2 and kind<>'inspect_mcp' and attempts<3
        and (state='pending' or (state='running' and updated_at<now()-interval '90 seconds'))
        order by created_at limit 1 for update skip locked`, [actor,this.commerce.mode]);
      const row = result.rows[0];
      if (!row) return { jobs: [] };
      const leaseId = randomUUID();
      await sql.query("update pilot_research set state='running',attempts=attempts+1,lease_id=$2,updated_at=now() where id=$1", [row.id,leaseId]);
      return { jobs: [{ id: row.id, leaseId, kind: row.kind, input: row.input }] };
    });
  }
  async complete(profile: string, raw: unknown) {
    const actor = await this.owner(profile);
    const input = z.object({ id: z.uuid(), leaseId: z.uuid(), result: resultSchema }).strict().parse(raw);
    return this.commerce.repository.transaction(async sql => {
      const found = await sql.query<ResearchRow>('select * from pilot_research where id=$1 and owner_id=$2 and mode=$3 for update', [input.id,actor,this.commerce.mode]);
      const row = found.rows[0];
      if (!row || row.kind==='inspect_mcp' || row.lease_id!==input.leaseId) throw new AppError('NOT_FOUND','Research lease not found.');
      if (row.state==='ready' || row.state==='failed') return { status: row.state };
      if (row.state!=='running') conflict('Research is not running.');
      const done = input.result.success || row.attempts===3;
      const state = input.result.success ? 'ready' : done ? 'failed' : 'running';
      const result = input.result.success ? { sources: input.result.sources.map(s=>({...s,id:randomUUID()})),
        ...(input.result.text ? {text:input.result.text} : {}), checkedAt:new Date().toISOString(),verifiedForFulfillment:false } : null;
      await sql.query('update pilot_research set state=$2,result=$3,updated_at=now() where id=$1',[row.id,state,result]);
      if (done) {
        const e = await this.commerce.repository.get(row.exchange_id,actor,sql);
        await this.commerce.repository.message(sql,e,actor,actor,'status',{action:'research_update',researchId:row.id});
      }
      return { status: state };
    });
  }

  /** Server worker owns protocol inspection; the model/research bridge cannot
   * submit tool catalogues or upgrade public prose into a protocol result. */
  async inspectPending(inspect: typeof inspectMcp = inspectMcp) {
    const claimed = await this.commerce.repository.transaction(async sql => {
      const result = await sql.query<ResearchRow>(`select * from pilot_research where mode=$1 and kind='inspect_mcp'
        and owner_id=any($2::uuid[]) and approved_at is not null
        and (state='pending' or (state='running' and updated_at<now()-interval '90 seconds'))
        order by updated_at limit 1 for update skip locked`,[this.commerce.mode,this.commerce.founders]);
      const row = result.rows[0];
      if (!row) return null;
      const e = await this.commerce.repository.get(row.exchange_id,row.owner_id,sql);
      const mine = await this.commerce.repository.privateInput(e,row.owner_id,sql);
      if (row.attempts>=3 || row.input.addressVersion!==(mine.discoveryVersion ?? 0)
        || ['cancelled','declined','completed','expired'].includes(e.stage) || Date.parse(e.expiresAt)<=Date.now()) {
        await sql.query("update pilot_research set state='failed',updated_at=now() where id=$1",[row.id]);
        await this.commerce.repository.message(sql,e,row.owner_id,row.owner_id,'status',{action:'research_update',researchId:row.id});
        return null;
      }
      const leaseId=randomUUID();
      await sql.query("update pilot_research set state='running',attempts=attempts+1,lease_id=$2,updated_at=now() where id=$1",[row.id,leaseId]);
      return {...row,lease_id:leaseId};
    });
    if (!claimed) return;
    // No database transaction held over DNS/TLS/HTTP. Re-inspection after a
    // process crash is safe: this client never calls tools or sends owner data.
    const mcp = await inspect(claimed.input.url!);
    await this.commerce.repository.transaction(async sql => {
      const result = await sql.query(`update pilot_research set state=$3,result=$4,updated_at=now()
        where id=$1 and lease_id=$2 and state='running' returning id`,[claimed.id,claimed.lease_id,
        mcp.status==='unavailable' ? 'failed' : 'ready',
        {sources:[],mcp,checkedAt:new Date().toISOString(),verifiedForFulfillment:false}]);
      if (!result.rowCount) return;
      const e = await this.commerce.repository.get(claimed.exchange_id,claimed.owner_id,sql);
      await this.commerce.repository.message(sql,e,claimed.owner_id,claimed.owner_id,'status',{action:'research_update',researchId:claimed.id});
    });
  }
}
