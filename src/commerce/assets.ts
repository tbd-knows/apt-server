import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { conflict, requireRole } from './domain.js';
import type { CommerceService } from './service.js';
import type { EasyPostProvider } from './providers.js';
import { downloadShippingArtifact } from './shipping-artifact.js';
import type { ConnectedShippingRead } from './connected-shipping-read.js';

const MAX_BYTES = 5 * 1024 * 1024;
export async function sanitizePhoto(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new AppError('INVALID_MESSAGE', 'Photos must be at most 5 MB.');
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    && !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new AppError('INVALID_MESSAGE', 'Choose a JPEG or PNG photo.');
  const input = sharp(bytes, { limitInputPixels: 25_000_000, animated: false });
  const metadata = await input.metadata();
  if (!['jpeg','png'].includes(metadata.format ?? '')) throw new AppError('INVALID_MESSAGE', 'Choose a JPEG or PNG photo.');
  // Decoding/re-encoding drops EXIF (including GPS), filenames and extra metadata.
  return input.rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}
export class CommerceAssets {
  private readonly storage;
  constructor(private readonly commerce: CommerceService, supabaseUrl: string, secret: string, private readonly bucket: string,
    private readonly shipping: EasyPostProvider, private readonly connectedShipping?: ConnectedShippingRead,
    private readonly download=downloadShippingArtifact) {
    this.storage = createClient(supabaseUrl, secret, { auth: { persistSession: false, autoRefreshToken: false } }).storage;
  }
  async upload(actor: string, exchangeId: string, raw: unknown) {
    this.commerce.authorize(actor);
    const body = z.object({ base64: z.string().min(4).max(7_000_000).regex(/^[A-Za-z0-9+/]+={0,2}$/), mime: z.enum(['image/jpeg','image/png']) }).strict().parse(raw);
    const exchange = await this.commerce.repository.get(exchangeId, actor);
    requireRole(exchange, actor, 'seller');
    if (!exchange.requestShared || exchange.mode !== this.commerce.mode) throw new AppError('NOT_FOUND', 'Exchange not found.');
    const bytes = await sanitizePhoto(Buffer.from(body.base64, 'base64'));
    const { data: bucket, error: bucketError } = await this.storage.getBucket(this.bucket);
    if (bucketError || !bucket || bucket.public) throw new AppError('PROVIDER_NOT_READY', 'Configure a private pilot photo bucket.');
    const id = randomUUID(); const path = `${exchange.mode}/${exchangeId}/${id}.jpg`;
    await this.commerce.repository.transaction(async sql => {
      await this.commerce.repository.get(exchangeId, actor, sql, true);
      const count = await sql.query('select count(*)::int as n from pilot_assets where exchange_id=$1 and owner_id=$2', [exchangeId, actor]);
      if (count.rows[0].n >= 24) conflict('Photo limit reached for this exchange.');
      // Record the object identity before the storage side effect. Interrupted
      // uploads remain private and can be inspected/removed by the operator.
      await sql.query(`insert into pilot_assets(id,owner_id,exchange_id,kind,storage_path,mime,bytes,state) values($1,$2,$3,'photo',$4,'image/jpeg',$5,'pending')`, [id, actor, exchangeId, path, bytes.length]);
    });
    const { error } = await this.storage.from(this.bucket).upload(path, bytes, { contentType: 'image/jpeg', upsert: false });
    if (error) throw new AppError('UPSTREAM_FAILED', 'Photo could not be stored.');
    await this.commerce.repository.pool.query("update pilot_assets set state='ready' where id=$1", [id]);
    return { id, mime: 'image/jpeg' };
  }
  async photo(actor: string, id: string) {
    this.commerce.authorize(actor);
    const result = await this.commerce.repository.pool.query<{ owner_id: string; exchange_id: string; storage_path: string }>("select owner_id,exchange_id,storage_path from pilot_assets where id=$1 and kind='photo' and state='ready'", [id]);
    const asset = result.rows[0];
    if (!asset) throw new AppError('NOT_FOUND', 'Photo not found.');
    const exchange = await this.commerce.repository.get(asset.exchange_id, actor);
    if (exchange.mode !== this.commerce.mode || (asset.owner_id !== actor && !exchange.item?.photoIds.includes(id) && !exchange.offers.some(o => o.item.photoIds.includes(id)))) throw new AppError('NOT_FOUND', 'Photo not found.');
    const { data, error } = await this.storage.from(this.bucket).download(asset.storage_path);
    if (error || !data) throw new AppError('UPSTREAM_FAILED', 'Photo is unavailable.');
    return { mime: 'image/jpeg', base64: Buffer.from(await data.arrayBuffer()).toString('base64') };
  }
  async label(actor: string, exchangeId: string, returning = false) {
    this.commerce.authorize(actor);
    const exchange = await this.commerce.repository.get(exchangeId, actor);
    requireRole(exchange, actor, returning ? 'buyer' : 'seller');
    if (exchange.mode !== this.commerce.mode || (returning ? !exchange.returnPlan || !!exchange.returnPlan.cancelApprovedBy?.length || !['label_ready','in_transit','delivered'].includes(exchange.returnPlan.shipping)
      : exchange.payment !== 'paid' || exchange.cancellationRequested || !exchange.offers.length)) conflict('No usable paid label is available.');
    const quote = returning ? exchange.returnPlan?.quote : exchange.offers.at(-1)?.quote;
    if (!quote) conflict('No return quote is available.');
    const offer = exchange.offers.at(-1)!;
    if (offer.connectedShipping) {
      if (!this.connectedShipping) conflict('The connected shipping artifact is unavailable.');
      const operation = (await this.commerce.repository.pool.query<{id:string;provider_id:string}>(
        `select id,provider_id from pilot_operations where exchange_id=$1 and mode=$2 and kind=$4
         and version=$3 and provider_id is not null`, [exchange.id,exchange.mode,returning?exchange.returnPlan!.version:offer.version,returning?'return_label':'label'])).rows[0];
      if (!operation) conflict('The purchased shipping transaction has not been recorded.');
      const transaction = await (returning?this.connectedShipping.forReturn():this.connectedShipping).transaction(exchange,offer,operation.id,operation.provider_id);
      if (transaction.state !== 'purchased') conflict('The service has not returned usable purchased postage.');
      return this.download(transaction.privateArtifactUrl,transaction.artifact);
    }
    const shipment = await this.shipping.retrieve(quote.shipmentId);
    this.shipping.validateApproved(shipment, quote);
    const url = shipment.postage_label?.label_pdf_url;
    if (!url || !URL.canParse(url)) conflict('The provider has not returned a printable PDF.');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password
      || !/^(easypost-files\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com|[a-z0-9-]+\.easypost\.com)$/.test(parsed.hostname)) conflict('Label download host is not approved.');
    return this.download(url,'pdf');
  }
}
