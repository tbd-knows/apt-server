import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { AppError } from '../errors.js';
import { conflict, digest, requireParticipant, type Exchange, type MessageKind, type OperationKind, type PrivateInput } from './domain.js';

export const emptyPrivateInput = (): PrivateInput => ({ budget: null, address: null, addressVersion: 0, packing: null, packingVersion: 0 });

export class CommerceRepository {
  constructor(readonly pool: Pool) {}
  static create(url: string, ssl: boolean) {
    return new CommerceRepository(new Pool({ connectionString: url, max: 4, ssl: ssl ? { rejectUnauthorized: false } : undefined }));
  }
  async transaction<T>(fn: (sql: PoolClient) => Promise<T>): Promise<T> {
    const sql = await this.pool.connect();
    try {
      await sql.query('begin');
      await sql.query("set local lock_timeout = '5s'; set local statement_timeout = '10s'");
      const result = await fn(sql);
      await sql.query('commit');
      return result;
    } catch (error) {
      await sql.query('rollback');
      throw error;
    } finally { sql.release(); }
  }
  async get(id: string, actor: string, sql: Pool | PoolClient = this.pool, lock = false): Promise<Exchange> {
    const result = await sql.query<{ data: Exchange }>(
      `select data from public.pilot_exchanges where id=$1 and (buyer_id=$2 or seller_id=$2)${lock ? ' for update' : ''}`, [id, actor]);
    if (!result.rows[0]) throw new AppError('NOT_FOUND', 'Exchange not found.');
    return result.rows[0].data;
  }
  async list(actor: string): Promise<Exchange[]> {
    const r = await this.pool.query<{ data: Exchange }>(`select data from public.pilot_exchanges
      where buyer_id=$1 or (seller_id=$1 and data->>'requestShared'='true') order by updated_at desc limit 100`, [actor]);
    return r.rows.map(row => row.data);
  }
  async insert(sql: PoolClient, exchange: Exchange) {
    await sql.query(`insert into public.pilot_exchanges(id,buyer_id,seller_id,mode,data) values($1,$2,$3,$4,$5)`,
      [exchange.id, exchange.buyerId, exchange.sellerId, exchange.mode, exchange]);
  }
  async save(sql: PoolClient, exchange: Exchange, now: Date) {
    exchange.revision += 1;
    exchange.updatedAt = now.toISOString();
    await sql.query('update public.pilot_exchanges set data=$2,revision=$3,updated_at=$4 where id=$1',
      [exchange.id, exchange, exchange.revision, now]);
  }
  async privateInput(exchange: Exchange, actor: string, sql: Pool | PoolClient = this.pool): Promise<PrivateInput> {
    requireParticipant(exchange, actor);
    const r = await sql.query<{ data: PrivateInput }>('select data from public.pilot_private_inputs where exchange_id=$1 and owner_id=$2', [exchange.id, actor]);
    return r.rows[0]?.data ?? emptyPrivateInput();
  }
  async savePrivate(sql: PoolClient, exchange: Exchange, actor: string, data: PrivateInput) {
    requireParticipant(exchange, actor);
    await sql.query(`insert into public.pilot_private_inputs(exchange_id,owner_id,data) values($1,$2,$3)
      on conflict(exchange_id,owner_id) do update set data=excluded.data`, [exchange.id, actor, data]);
  }
  /** Serialize duplicate commands before creating anything, including new exchanges. */
  async previousCommand(sql: PoolClient, actor: string, key: string, input: unknown): Promise<string | null> {
    await sql.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`${actor}:${key}`]);
    const r = await sql.query<{ exchange_id: string; digest: string }>('select exchange_id,digest from public.pilot_commands where actor_id=$1 and key=$2', [actor, key]);
    if (!r.rows[0]) return null;
    if (r.rows[0].digest !== digest(input)) conflict('This command identity was already used for different input.');
    return r.rows[0].exchange_id;
  }
  async recordCommand(sql: PoolClient, actor: string, key: string, input: unknown, id: string) {
    await sql.query('insert into public.pilot_commands(actor_id,key,digest,exchange_id) values($1,$2,$3,$4)', [actor, key, digest(input), id]);
  }
  async message(sql: PoolClient, exchange: Exchange, sender: string, recipient: string, kind: MessageKind, payload: unknown) {
    requireParticipant(exchange, sender); requireParticipant(exchange, recipient);
    await sql.query(`insert into public.pilot_messages(id,exchange_id,sender_id,recipient_id,kind,payload) values($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), exchange.id, sender, recipient, kind, payload]);
  }
  async event(sql: PoolClient, exchange: Exchange, actor: string | null, kind: string, evidence: unknown, providerKey: string | null = null) {
    const r = await sql.query(`insert into public.pilot_events(id,exchange_id,actor_id,kind,evidence,provider_key)
      values($1,$2,$3,$4,$5,$6) on conflict(provider_key) do nothing returning id`, [randomUUID(), exchange.id, actor, kind, evidence, providerKey]);
    return !!r.rowCount;
  }
  async notifyStatus(sql: PoolClient, e: Exchange) {
    for (const recipient of [e.buyerId, e.sellerId]) await this.message(sql, e, e.buyerId, recipient, 'status', {
      action: 'provider_update', text: `Payment: ${e.payment}. Shipping: ${e.shipping}. Seller transfer: ${e.transfer}. Bank payout: ${e.payout}.`,
    });
  }
  async enqueue(sql: PoolClient, exchange: Exchange, kind: OperationKind, version: number) {
    await sql.query(`insert into public.pilot_operations(id,exchange_id,kind,version,mode) values($1,$2,$3,$4,$5)
      on conflict(exchange_id,kind,version) do nothing`, [randomUUID(), exchange.id, kind, version, exchange.mode]);
  }
  async reserve(sql: PoolClient, exchange: Exchange, until: string) {
    if (!exchange.item) conflict('No confirmed item.');
    // An expired payment reservation is released only after provider reconciliation,
    // never by a clock alone: Checkout may have succeeded during cancellation.
    const r = await sql.query(`update public.pilot_items set reserved_by=$1,reserved_until=$2
      where id=$3 and seller_id=$4 and mode=$5 and details=$6::jsonb and sold=false and (reserved_by is null or reserved_by=$1)
      returning id`, [exchange.id, until, exchange.item.itemId, exchange.sellerId, exchange.mode, exchange.item]);
    if (!r.rowCount) conflict('This quantity-one item is already reserved or sold.');
  }
}
