import { Pool, type QueryResultRow } from 'pg';
import { AppError } from '../errors.js';
import {
  MEMORY_LIMITS,
  type ConversationMessage,
  type KnowledgeFact,
  type KnowledgeInput,
  type MemoryTurnBundle,
  type PrivateProfile,
  type RuntimePrivateArtifacts,
} from './domain.js';

interface ProfileRow extends QueryResultRow {
  soul_text: string;
  hot_user_text: string;
  hot_memory_text: string;
  revision: string;
  knowledge_revision: string;
  runtime_hash: string | null;
}

interface KnowledgeRow extends QueryResultRow {
  id: string;
  subject_kind: KnowledgeFact['subjectKind'];
  subject_label: string | null;
  category: string;
  fact: string;
  confidence: string;
  learned_at: Date;
}

interface MessageRow extends QueryResultRow {
  role: ConversationMessage['role'];
  content: string;
}

export interface MemoryRepository {
  loadTurn(userId: string, query: string, historyBudget: number): Promise<MemoryTurnBundle>;
  setRuntimeHash(userId: string, runtimeHash: string): Promise<void>;
  searchKnowledge(userId: string, query: string, limit: number): Promise<KnowledgeFact[]>;
  remember(userId: string, runId: string, messageId: string, input: KnowledgeInput): Promise<KnowledgeFact>;
  updatePrivateArtifact(userId: string, runId: string, kind: 'soul' | 'user_profile' | 'memory', content: string, expectedRevision: string): Promise<PrivateProfile>;
  reconcileRuntimeArtifacts(userId: string, artifacts: RuntimePrivateArtifacts): Promise<void>;
  close(): Promise<void>;
}

/**
 * Owner-scoped private context. Every statement is keyed by the server-bound
 * user ID; tool arguments can never select another user's rows.
 */
export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly pool: Pool) {}

  static create(databaseUrl: string, ssl: boolean) {
    return new PostgresMemoryRepository(new Pool({
      connectionString: databaseUrl,
      max: 5,
      ssl: ssl ? { rejectUnauthorized: false } : undefined,
    }));
  }

  async close() {
    await this.pool.end();
  }

  async loadTurn(userId: string, query: string, historyBudget: number): Promise<MemoryTurnBundle> {
    await this.pool.query(
      `insert into public.claw_user_profiles(user_id) values ($1) on conflict (user_id) do nothing`,
      [userId],
    );
    const [profile, knowledge, messages] = await Promise.all([
      this.pool.query<ProfileRow>(
        `select soul_text, hot_user_text, hot_memory_text, revision, knowledge_revision, runtime_hash
         from public.claw_user_profiles where user_id = $1`, [userId]),
      this.searchKnowledge(userId, query, MEMORY_LIMITS.knowledgeSearch),
      this.pool.query<MessageRow>(
        `select role, content from public.messages
         where user_id = $1 and status = 'completed' order by sequence desc limit 500`, [userId]),
    ]);
    const profileRow = profile.rows[0];
    if (!profileRow) throw new Error('Failed to initialize the private profile.');
    return {
      profile: profileFromRow(profileRow),
      knowledge,
      conversationHistory: boundRecentMessages(messages.rows, historyBudget),
    };
  }

  async setRuntimeHash(userId: string, runtimeHash: string) {
    await this.pool.query(
      `update public.claw_user_profiles set runtime_hash = $2, last_reconciled_at = now(), reconciliation_error = null
       where user_id = $1`, [userId, runtimeHash],
    );
  }

  async searchKnowledge(userId: string, query: string, limit: number) {
    const result = await this.pool.query<KnowledgeRow>(
      `select id, subject_kind, subject_label, category, fact, confidence, learned_at
       from public.claw_user_knowledge
       where user_id = $1 and status = 'active' and (expires_at is null or expires_at > now())
         and confidence >= 0.250
         and ($2 = '' or search_document @@ websearch_to_tsquery('english', $2))
       order by case when $2 = '' then 0 else ts_rank_cd(search_document, websearch_to_tsquery('english', $2)) end desc,
                last_confirmed_at desc nulls last, learned_at desc
       limit $3`,
      [userId, query.trim().slice(0, 1_000), Math.min(Math.max(limit, 1), 50)],
    );
    return result.rows.map(knowledgeFromRow);
  }

  async remember(userId: string, runId: string, messageId: string, input: KnowledgeInput) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const inserted = await client.query<KnowledgeRow>(
        `insert into public.claw_user_knowledge
          (user_id, subject_kind, subject_label, category, fact, confidence, sensitivity, source_message_id, source_agent_run_id)
         select $1::uuid, $4::text, $5::text, $6::text, $7::text, $8::numeric, $9::text, $3::uuid, $2::uuid
         where not exists (
           select 1 from public.claw_user_knowledge
           where user_id = $1 and source_agent_run_id = $2 and category = $6 and fact = $7 and status = 'active'
         )
         returning id, subject_kind, subject_label, category, fact, confidence, learned_at`,
        [userId, runId, messageId, input.subjectKind, input.subjectLabel, input.category, input.fact, input.confidence, input.sensitivity],
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<KnowledgeRow>(
          `select id, subject_kind, subject_label, category, fact, confidence, learned_at
           from public.claw_user_knowledge
           where user_id = $1 and source_agent_run_id = $2 and category = $3 and fact = $4 and status = 'active' limit 1`,
          [userId, runId, input.category, input.fact],
        );
        row = existing.rows[0];
      } else {
        await client.query(
          `update public.claw_user_profiles set knowledge_revision = knowledge_revision + 1, last_learning_at = now()
           where user_id = $1`, [userId],
        );
        await client.query(
          `insert into public.claw_learning_events
            (user_id, agent_run_id, source_message_id, artifact_kind, action, artifact_id, after_value)
           values ($1, $2, $3, 'knowledge', 'add', $4, jsonb_build_object('category', $5::text, 'subject_kind', $6::text))`,
          [userId, runId, messageId, row.id, input.category, input.subjectKind],
        );
      }
      await client.query('commit');
      if (!row) throw new Error('Failed to persist private knowledge.');
      return knowledgeFromRow(row);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async updatePrivateArtifact(
    userId: string,
    runId: string,
    kind: 'soul' | 'user_profile' | 'memory',
    content: string,
    expectedRevision: string,
  ) {
    const column = kind === 'soul' ? 'soul_text' : kind === 'user_profile' ? 'hot_user_text' : 'hot_memory_text';
    const result = await this.pool.query<ProfileRow>(
      `update public.claw_user_profiles
       set ${column} = $3, revision = revision + 1, last_learning_at = now()
       where user_id = $1 and revision = $2
       returning soul_text, hot_user_text, hot_memory_text, revision, knowledge_revision, runtime_hash`,
      [userId, expectedRevision, content],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('RUN_IN_PROGRESS', 'Private artifact revision conflict; retry with the latest profile revision.');
    await this.pool.query(
      `insert into public.claw_learning_events(user_id, agent_run_id, artifact_kind, action, after_value)
       values ($1, $2, $3, 'replace', jsonb_build_object('revision', $4::bigint, 'character_count', $5::integer))`,
      [userId, runId, kind, row.revision, content.length],
    );
    return profileFromRow(row);
  }

  async reconcileRuntimeArtifacts(userId: string, artifacts: RuntimePrivateArtifacts) {
    if (
      artifacts.soulText.length > MEMORY_LIMITS.soulText
      || artifacts.hotUserText.length > MEMORY_LIMITS.hotUserText
      || artifacts.hotMemoryText.length > MEMORY_LIMITS.hotMemoryText
    ) {
      await this.pool.query(
        `update public.claw_user_profiles set reconciliation_error = 'Runtime private artifact exceeded a size limit.' where user_id = $1`,
        [userId],
      );
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const profile = await client.query<ProfileRow>(
        `select soul_text, hot_user_text, hot_memory_text, revision, knowledge_revision, runtime_hash
         from public.claw_user_profiles where user_id = $1 for update`, [userId],
      );
      const current = profile.rows[0];
      if (!current) {
        await client.query('rollback');
        return;
      }
      const profileChanged = current.soul_text !== artifacts.soulText ||
        current.hot_user_text !== artifacts.hotUserText || current.hot_memory_text !== artifacts.hotMemoryText;
      if (profileChanged) {
        await client.query(
          `update public.claw_user_profiles
           set soul_text = $2, hot_user_text = $3, hot_memory_text = $4, revision = revision + 1,
               last_learning_at = now(), last_reconciled_at = now(), reconciliation_error = null
           where user_id = $1`,
          [userId, artifacts.soulText, artifacts.hotUserText, artifacts.hotMemoryText],
        );
        await client.query(
          `insert into public.claw_learning_events(user_id, artifact_kind, action, after_value)
           values ($1, 'user_profile', 'reconcile', jsonb_build_object('source', 'isolated_runtime'))`, [userId],
        );
      } else {
        await client.query(
          `update public.claw_user_profiles set last_reconciled_at = now(), reconciliation_error = null where user_id = $1`,
          [userId],
        );
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

function profileFromRow(row: ProfileRow): PrivateProfile {
  return {
    soulText: row.soul_text,
    hotUserText: row.hot_user_text,
    hotMemoryText: row.hot_memory_text,
    revision: String(row.revision),
    knowledgeRevision: String(row.knowledge_revision),
    runtimeHash: row.runtime_hash,
  };
}

function knowledgeFromRow(row: KnowledgeRow): KnowledgeFact {
  return {
    id: row.id,
    subjectKind: row.subject_kind,
    subjectLabel: row.subject_label,
    category: row.category,
    fact: row.fact,
    confidence: Number(row.confidence),
    learnedAt: row.learned_at.toISOString(),
  };
}

export function boundRecentMessages(rowsNewestFirst: ConversationMessage[], budget: number) {
  const selected: ConversationMessage[] = [];
  let used = 0;
  for (const row of rowsNewestFirst) {
    const cost = row.content.length;
    if (selected.length && used + cost > budget) break;
    if (!selected.length && cost > budget) continue;
    selected.push({ role: row.role, content: row.content });
    used += cost;
  }
  return selected.reverse();
}
