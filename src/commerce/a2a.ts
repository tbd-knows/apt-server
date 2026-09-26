import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { a2aPeerToken } from './a2a-auth.js';
import type { CommerceService } from './service.js';

const receiptSchema = z.object({
  messageId: z.uuid(), peer: z.string().regex(/^apt-[a-f0-9]{20}$/),
  contextId: z.uuid(), taskId: z.string().min(1).max(200),
}).strict();

/** Hermes handles the A2A protocol. This adapter authorizes delivery of an
 * existing, approved record; peers cannot insert text into private agent turns. */
export class CommerceA2A {
  constructor(private readonly commerce: CommerceService, private readonly config: AppConfig['hermes']) {}

  private async owner(profile: string) {
    const row = await this.commerce.repository.pool.query<{ user_id: string }>(
      "select user_id from agent_instances where hermes_profile_name=$1 and status='ready'", [profile]);
    const actor = row.rows[0]?.user_id;
    if (!actor) throw new AppError('FORBIDDEN', 'Agent is not ready.');
    this.commerce.authorize(actor);
    return actor;
  }

  async outbox(profile: string) {
    const actor = await this.owner(profile);
    return this.commerce.repository.transaction(async sql => {
      const rows = await sql.query<{ id: string; recipient_profile: string }>(`select m.id,i.hermes_profile_name as recipient_profile
        from pilot_messages m join pilot_exchanges e on e.id=m.exchange_id
        join agent_instances i on i.user_id=m.recipient_id and i.status='ready'
        where m.sender_id=$1 and m.recipient_id=$2 and e.mode=$3 and m.a2a_received_at is null
        and m.a2a_attempts<5 and (m.a2a_attempted_at is null or m.a2a_attempted_at<now()-interval '30 seconds')
        order by m.created_at limit 1 for update of m skip locked`, [actor, this.commerce.counterpart(actor), this.commerce.mode]);
      const messages = [];
      for (const row of rows.rows) {
        const url = this.config.a2aProfileUrls[row.recipient_profile]
          ?? this.config.a2aProfileUrlTemplate.replaceAll('{profile}', row.recipient_profile);
        await sql.query('update pilot_messages set a2a_attempts=a2a_attempts+1,a2a_attempted_at=now() where id=$1', [row.id]);
        messages.push({ messageId: row.id, peer: { name: row.recipient_profile, url,
          token: a2aPeerToken(profile, row.recipient_profile, this.config.keySecret) } });
      }
      return { messages };
    });
  }

  async receive(profile: string, raw: unknown) {
    const input = receiptSchema.parse(raw);
    const actor = await this.owner(profile);
    const sender = await this.owner(input.peer);
    if (sender !== this.commerce.counterpart(actor) || input.contextId !== input.messageId) {
      throw new AppError('NOT_FOUND', 'Shared message not found.');
    }
    await this.commerce.repository.transaction(async sql => {
      const message = await sql.query(`select m.id from pilot_messages m join pilot_exchanges e on e.id=m.exchange_id
        where m.id=$1 and m.sender_id=$2 and m.recipient_id=$3 and e.mode=$4
        and e.data->>'requestShared'='true' for update of m`, [input.messageId, sender, actor, this.commerce.mode]);
      if (!message.rowCount) throw new AppError('NOT_FOUND', 'Shared message not found.');
      // Duplicate network sends or a lost receipt never duplicate the message or
      // wake-up. The original message UUID is also the owner chat retry identity.
      await sql.query(`update pilot_messages set a2a_received_at=coalesce(a2a_received_at,now()),
        a2a_task_id=coalesce(a2a_task_id,$2) where id=$1`, [input.messageId, input.taskId]);
    });
    return { messageId: input.messageId, status: 'received' as const };
  }
}
