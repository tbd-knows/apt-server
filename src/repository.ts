import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import type {
  AgentInstance,
  ChatMessage,
  ChatPage,
  ChatRun,
  CreatedTurn,
  RunStatus,
} from './domain.js';
import { AppError } from './errors.js';

export interface RestartedRun {
  runId: string;
  hermesRunId: string | null;
  instance: AgentInstance;
}

export interface ChatRepository {
  health(): Promise<void>;
  close(): Promise<void>;
  getAgentInstance(userId: string): Promise<AgentInstance | null>;
  getChat(userId: string, before: string | null, limit: number): Promise<ChatPage>;
  createTurn(userId: string, clientMessageId: string, content: string): Promise<CreatedTurn>;
  getRun(userId: string, runId: string): Promise<ChatRun>;
  markRunRunning(userId: string, runId: string, hermesRunId: string): Promise<ChatRun>;
  persistAssistantSnapshot(userId: string, runId: string, content: string): Promise<ChatRun>;
  completeRun(userId: string, runId: string, content: string): Promise<ChatRun>;
  failRun(userId: string, runId: string, errorCode: string): Promise<ChatRun>;
  markRunStopping(userId: string, runId: string): Promise<ChatRun>;
  cancelRun(userId: string, runId: string, content: string): Promise<ChatRun>;
  failUnfinishedRuns(): Promise<RestartedRun[]>;
  upsertAgentInstance(instance: Pick<AgentInstance, 'userId' | 'hermesProfileName' | 'hermesSessionId'>): Promise<AgentInstance>;
  disableAgentInstance(userId: string): Promise<AgentInstance>;
  deleteUserRecords(userId: string): Promise<void>;
}

interface MessageRow extends QueryResultRow {
  id: string;
  sequence: string;
  role: 'user' | 'assistant';
  content: string;
  status: ChatMessage['status'];
  client_message_id: string | null;
  reply_to_message_id: string | null;
  channel: 'in_app';
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface RunRow extends QueryResultRow {
  id: string;
  request_message_id: string;
  response_message_id: string;
  hermes_run_id: string | null;
  status: RunStatus;
  error_code: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

interface InstanceRow extends QueryResultRow {
  user_id: string;
  hermes_profile_name: string;
  hermes_session_id: string;
  status: 'ready' | 'disabled';
  created_at: Date;
  updated_at: Date;
}

interface ActiveRunRow extends RunRow {
  message_id: string;
  sequence: string;
  role: 'assistant';
  content: string;
  message_status: ChatMessage['status'];
  client_message_id: null;
  reply_to_message_id: string;
  channel: 'in_app';
  message_error_code: string | null;
  message_created_at: Date;
  message_updated_at: Date;
  completed_at: Date | null;
}

interface RestartedRunRow extends RunRow {
  user_id: string;
  hermes_profile_name: string;
  hermes_session_id: string;
  instance_status: 'ready' | 'disabled';
  instance_created_at: Date;
  instance_updated_at: Date;
}

function messageFromRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    sequence: String(row.sequence),
    role: row.role,
    content: row.content,
    status: row.status,
    clientMessageId: row.client_message_id,
    replyToMessageId: row.reply_to_message_id,
    channel: row.channel,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}

function runFromRow(row: RunRow, response?: ChatMessage): ChatRun {
  return {
    id: row.id,
    requestMessageId: row.request_message_id,
    responseMessageId: row.response_message_id,
    hermesRunId: row.hermes_run_id,
    status: row.status,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
    ...(response ? { response } : {}),
  };
}

function instanceFromRow(row: InstanceRow): AgentInstance {
  return {
    userId: row.user_id,
    hermesProfileName: row.hermes_profile_name,
    hermesSessionId: row.hermes_session_id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export class PostgresChatRepository implements ChatRepository {
  constructor(private readonly pool: Pool) {}

  static create(databaseUrl: string, ssl: boolean) {
    return new PostgresChatRepository(
      new Pool({ connectionString: databaseUrl, max: 5, ssl: ssl ? { rejectUnauthorized: false } : undefined }),
    );
  }

  async health() {
    await this.pool.query('select 1');
  }

  async close() {
    await this.pool.end();
  }

  async getAgentInstance(userId: string) {
    const result = await this.pool.query<InstanceRow>(
      `select user_id, hermes_profile_name, hermes_session_id, status, created_at, updated_at
       from public.agent_instances where user_id = $1`,
      [userId],
    );
    return result.rows[0] ? instanceFromRow(result.rows[0]) : null;
  }

  private async requireReadyInstance(client: Pool | PoolClient, userId: string, lock = false) {
    const result = await client.query<InstanceRow>(
      `select user_id, hermes_profile_name, hermes_session_id, status, created_at, updated_at
       from public.agent_instances where user_id = $1${lock ? ' for update' : ''}`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('AGENT_NOT_PROVISIONED', 'Apt chat has not been provisioned for this user.');
    if (row.status === 'disabled') throw new AppError('AGENT_DISABLED', 'Apt chat is disabled for this user.');
    return instanceFromRow(row);
  }

  async getChat(userId: string, before: string | null, limit: number): Promise<ChatPage> {
    await this.requireReadyInstance(this.pool, userId);
    const messagesResult = await this.pool.query<MessageRow>(
      `select id, sequence, role, content, status, client_message_id, reply_to_message_id,
              channel, error_code, created_at, updated_at, completed_at
       from public.messages
       where user_id = $1 and ($2::bigint is null or sequence < $2::bigint)
       order by sequence desc
       limit $3`,
      [userId, before, limit + 1],
    );
    const hasOlder = messagesResult.rows.length > limit;
    const pageRows = messagesResult.rows.slice(0, limit);
    const messages = pageRows.reverse().map(messageFromRow);
    const activeRun = await this.findActiveRun(userId);
    return {
      messages,
      olderCursor: hasOlder ? messages[0]?.sequence ?? null : null,
      activeRun,
    };
  }

  private async findActiveRun(userId: string): Promise<ChatRun | null> {
    const result = await this.pool.query<ActiveRunRow>(
      `select r.id, r.request_message_id, r.response_message_id, r.hermes_run_id,
              r.status, r.error_code, r.created_at, r.started_at, r.finished_at,
              m.id as message_id, m.sequence, m.role, m.content, m.status as message_status,
              m.client_message_id, m.reply_to_message_id, m.channel,
              m.error_code as message_error_code, m.created_at as message_created_at,
              m.updated_at as message_updated_at, m.completed_at
       from public.agent_runs r
       join public.messages m on m.id = r.response_message_id
       where r.user_id = $1 and r.status in ('queued', 'running', 'stopping')
       order by r.created_at desc limit 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return runFromRow(row, messageFromAliasedRunRow(row));
  }

  async createTurn(userId: string, clientMessageId: string, content: string): Promise<CreatedTurn> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await this.requireReadyInstance(client, userId, true);

      const duplicate = await client.query<RunRow & QueryResultRow>(
        `select r.* from public.agent_runs r
         join public.messages m on m.id = r.request_message_id
         where m.user_id = $1 and m.client_message_id = $2`,
        [userId, clientMessageId],
      );
      if (duplicate.rows[0]) {
        const existing = await this.createdTurnFromRun(client, userId, duplicate.rows[0], true);
        await client.query('commit');
        return existing;
      }

      const active = await client.query(
        `select 1 from public.agent_runs
         where user_id = $1 and status in ('queued', 'running', 'stopping') limit 1`,
        [userId],
      );
      if (active.rowCount) throw new AppError('RUN_IN_PROGRESS', 'Wait for the active response or stop it first.');

      const request = await client.query<MessageRow>(
        `insert into public.messages
          (user_id, role, content, status, client_message_id, channel, completed_at)
         values ($1, 'user', $2, 'completed', $3, 'in_app', now()) returning *`,
        [userId, content, clientMessageId],
      );
      const requestRow = request.rows[0];
      if (!requestRow) throw new Error('Failed to insert request message');

      const response = await client.query<MessageRow>(
        `insert into public.messages
          (user_id, role, content, status, reply_to_message_id, channel)
         values ($1, 'assistant', '', 'pending', $2, 'in_app') returning *`,
        [userId, requestRow.id],
      );
      const responseRow = response.rows[0];
      if (!responseRow) throw new Error('Failed to reserve response message');

      const run = await client.query<RunRow>(
        `insert into public.agent_runs (user_id, request_message_id, response_message_id, status)
         values ($1, $2, $3, 'queued') returning *`,
        [userId, requestRow.id, responseRow.id],
      );
      const runRow = run.rows[0];
      if (!runRow) throw new Error('Failed to create run');
      await client.query('commit');
      return {
        requestMessage: messageFromRow(requestRow),
        responseMessage: messageFromRow(responseRow),
        run: runFromRow(runRow, messageFromRow(responseRow)),
        duplicate: false,
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async createdTurnFromRun(client: PoolClient, userId: string, run: RunRow, duplicate: boolean) {
    const messages = await client.query<MessageRow>(
      `select * from public.messages where user_id = $1 and id = any($2::uuid[])`,
      [userId, [run.request_message_id, run.response_message_id]],
    );
    const request = messages.rows.find((row) => row.id === run.request_message_id);
    const response = messages.rows.find((row) => row.id === run.response_message_id);
    if (!request || !response) throw new Error('Run references missing messages');
    return {
      requestMessage: messageFromRow(request),
      responseMessage: messageFromRow(response),
      run: runFromRow(run, messageFromRow(response)),
      duplicate,
    };
  }

  async getRun(userId: string, runId: string): Promise<ChatRun> {
    const result = await this.pool.query<RunRow & QueryResultRow>(
      'select * from public.agent_runs where id = $1 and user_id = $2',
      [runId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('RUN_NOT_FOUND', 'Run not found.');
    const response = await this.pool.query<MessageRow>(
      'select * from public.messages where id = $1 and user_id = $2',
      [row.response_message_id, userId],
    );
    return runFromRow(row, response.rows[0] ? messageFromRow(response.rows[0]) : undefined);
  }

  async markRunRunning(userId: string, runId: string, hermesRunId: string) {
    return this.updateRunAndResponse(
      userId,
      runId,
      `update public.agent_runs set status = 'running', hermes_run_id = $3, started_at = coalesce(started_at, now())
       where id = $1 and user_id = $2 and status = 'queued' returning *`,
      [runId, userId, hermesRunId],
      `update public.messages set status = 'streaming' where id =
         (select response_message_id from public.agent_runs where id = $1 and user_id = $2)
       and status = 'pending'`,
      [runId, userId],
    );
  }

  async persistAssistantSnapshot(userId: string, runId: string, content: string) {
    await this.pool.query(
      `update public.messages set content = $3, status = 'streaming'
       where id = (select response_message_id from public.agent_runs where id = $1 and user_id = $2)
       and status in ('pending', 'streaming')`,
      [runId, userId, content],
    );
    return this.getRun(userId, runId);
  }

  async completeRun(userId: string, runId: string, content: string) {
    return this.settleRun(userId, runId, 'completed', null, content);
  }

  async failRun(userId: string, runId: string, errorCode: string) {
    const current = await this.getRun(userId, runId);
    return this.settleRun(userId, runId, 'failed', errorCode, current.response?.content ?? '');
  }

  async markRunStopping(userId: string, runId: string) {
    const result = await this.pool.query<RunRow>(
      `update public.agent_runs set status = 'stopping'
       where id = $1 and user_id = $2 and status in ('queued', 'running') returning *`,
      [runId, userId],
    );
    if (!result.rows[0]) return this.getRun(userId, runId);
    return this.getRun(userId, runId);
  }

  async cancelRun(userId: string, runId: string, content: string) {
    return this.settleRun(userId, runId, 'cancelled', null, content);
  }

  private async settleRun(
    userId: string,
    runId: string,
    status: 'completed' | 'failed' | 'cancelled',
    errorCode: string | null,
    content: string,
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const runResult = await client.query<RunRow>(
        `update public.agent_runs set status = $3, error_code = $4, finished_at = now()
         where id = $1 and user_id = $2 and status in ('queued', 'running', 'stopping') returning *`,
        [runId, userId, status, errorCode],
      );
      const row = runResult.rows[0];
      if (!row) {
        await client.query('rollback');
        return this.getRun(userId, runId);
      }
      const messageResult = await client.query<MessageRow>(
        `update public.messages set content = $3, status = $4, error_code = $5, completed_at = now()
         where id = $1 and user_id = $2 returning *`,
        [row.response_message_id, userId, content, status, errorCode],
      );
      await client.query('commit');
      return runFromRow(row, messageResult.rows[0] ? messageFromRow(messageResult.rows[0]) : undefined);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateRunAndResponse(
    userId: string,
    runId: string,
    runSql: string,
    runValues: unknown[],
    messageSql: string,
    messageValues: unknown[],
  ) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const run = await client.query<RunRow>(runSql, runValues);
      if (!run.rows[0]) throw new AppError('RUN_NOT_FOUND', 'Run not found or no longer active.');
      await client.query(messageSql, messageValues);
      await client.query('commit');
      return this.getRun(userId, runId);
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async failUnfinishedRuns(): Promise<RestartedRun[]> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const result = await client.query<RestartedRunRow>(
        `select r.*, i.hermes_profile_name, i.hermes_session_id, i.status as instance_status,
                i.created_at as instance_created_at, i.updated_at as instance_updated_at
         from public.agent_runs r join public.agent_instances i on i.user_id = r.user_id
         where r.status in ('queued', 'running', 'stopping') for update of r`,
      );
      await client.query(
        `update public.messages set status = 'failed', error_code = 'SERVER_RESTARTED', completed_at = now()
         where id in (select response_message_id from public.agent_runs where status in ('queued', 'running', 'stopping'))`,
      );
      await client.query(
        `update public.agent_runs set status = 'failed', error_code = 'SERVER_RESTARTED', finished_at = now()
         where status in ('queued', 'running', 'stopping')`,
      );
      await client.query('commit');
      return result.rows.map((row) => ({
        runId: row.id,
        hermesRunId: row.hermes_run_id,
        instance: {
          userId: row.user_id,
          hermesProfileName: row.hermes_profile_name,
          hermesSessionId: row.hermes_session_id,
          status: row.instance_status,
          createdAt: row.instance_created_at.toISOString(),
          updatedAt: row.instance_updated_at.toISOString(),
        },
      }));
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async upsertAgentInstance(instance: Pick<AgentInstance, 'userId' | 'hermesProfileName' | 'hermesSessionId'>) {
    const result = await this.pool.query<InstanceRow>(
      `insert into public.agent_instances (user_id, hermes_profile_name, hermes_session_id, status)
       values ($1, $2, $3, 'ready')
       on conflict (user_id) do update set status = 'ready', updated_at = now()
       returning *`,
      [instance.userId, instance.hermesProfileName, instance.hermesSessionId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Failed to upsert agent instance');
    return instanceFromRow(row);
  }

  async disableAgentInstance(userId: string) {
    const result = await this.pool.query<InstanceRow>(
      `update public.agent_instances set status = 'disabled', updated_at = now()
       where user_id = $1 returning *`,
      [userId],
    );
    const row = result.rows[0];
    if (!row) throw new AppError('AGENT_NOT_PROVISIONED', 'Apt chat has not been provisioned for this user.');
    return instanceFromRow(row);
  }

  /**
   * Operator-only, confirmation-gated cleanup. The Shopping, Hunt, and Claw
   * tables are retired from the runtime but remain in the database schema
   * (see docs/pivot-purge.md), so ownership rows are removed in foreign-key
   * order. Nothing calls this during normal operation.
   */
  async deleteUserRecords(userId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('delete from public.shopping_board_items where user_id = $1', [userId]);
      await client.query('delete from public.shopping_list_entries where user_id = $1', [userId]);
      await client.query('delete from public.shopping_boards where user_id = $1', [userId]);
      await client.query('delete from public.shopping_items where user_id = $1', [userId]);
      await client.query('delete from public.commerce_hunts where user_id = $1', [userId]);
      await client.query('delete from public.claw_learning_events where user_id = $1', [userId]);
      await client.query('delete from public.claw_learning_proposals where user_id = $1', [userId]);
      await client.query('delete from public.claw_user_skills where user_id = $1', [userId]);
      await client.query('delete from public.claw_user_knowledge where user_id = $1', [userId]);
      await client.query('delete from public.claw_user_profiles where user_id = $1', [userId]);
      await client.query('delete from public.claw_admins where user_id = $1', [userId]);
      await client.query('delete from public.agent_runs where user_id = $1', [userId]);
      await client.query('delete from public.messages where user_id = $1', [userId]);
      await client.query('delete from public.agent_instances where user_id = $1', [userId]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

function messageFromAliasedRunRow(row: ActiveRunRow): ChatMessage {
  return messageFromRow({
    id: row.message_id,
    sequence: String(row.sequence),
    role: row.role,
    content: row.content,
    status: row.message_status,
    client_message_id: row.client_message_id,
    reply_to_message_id: row.reply_to_message_id,
    channel: row.channel,
    error_code: row.message_error_code,
    created_at: row.message_created_at,
    updated_at: row.message_updated_at,
    completed_at: row.completed_at,
  });
}
