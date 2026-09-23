import cors from '@fastify/cors';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AgentRuntime } from './agent-runtime.js';
import { bearerToken, type AuthService } from './auth.js';
import type { AppConfig } from './config.js';
import { AppError, asAppError } from './errors.js';
import type { ChatRepository } from './repository.js';
import { RunManager } from './run-manager.js';
import { verifyAptBridgeToken } from './memory/bridge-auth.js';
import { MEMORY_TOOL_NAMES } from './memory/domain.js';
import type { MemoryService } from './memory/service.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

const historyQuerySchema = z.object({
  before: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

// Unknown fields (for example a stale client's foreground location) are
// ignored rather than rejected; the server never reads or stores them.
const createMessageSchema = z.object({
  clientMessageId: z.uuid(),
  content: z.string(),
});

const internalToolSchema = z.object({
  tool: z.enum(MEMORY_TOOL_NAMES),
  arguments: z.unknown(),
}).strict();

const runParamsSchema = z.object({ runId: z.uuid() });

export interface AppDependencies {
  config: AppConfig;
  auth: AuthService;
  repository: ChatRepository;
  runtime: AgentRuntime;
  memoryService?: MemoryService;
}

export async function buildApp(dependencies: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: dependencies.config.logLevel, redact: ['req.headers.authorization'] },
    bodyLimit: 64_000,
  });
  const manager = new RunManager(dependencies.repository, dependencies.runtime, app.log, dependencies.memoryService);

  if (dependencies.config.allowedOrigins.length) {
    await app.register(cors, { origin: dependencies.config.allowedOrigins, methods: ['GET', 'POST'] });
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      return reply.status(400).send({ error: { code: 'INVALID_MESSAGE', message: 'The request is invalid.' } });
    }
    const appError = asAppError(error);
    if (appError.code === 'INTERNAL_ERROR') request.log.error({ error }, 'Unhandled request error');
    return reply.status(appError.statusCode).send({ error: { code: appError.code, message: appError.message } });
  });

  const authenticate = async (request: FastifyRequest) => {
    const token = bearerToken(request.headers.authorization);
    const user = await dependencies.auth.authenticate(token);
    request.userId = user.id;
  };

  app.get('/health', async (_request, reply) => {
    const checks = await Promise.allSettled([
      dependencies.repository.health(),
      dependencies.runtime.health(),
    ]);
    const database = checks[0]?.status === 'fulfilled' ? 'ok' : 'unavailable';
    const hermes = checks[1]?.status === 'fulfilled' ? 'ok' : 'unavailable';
    const status = database === 'ok' && hermes === 'ok' ? 'ok' : 'degraded';
    return reply.status(status === 'ok' ? 200 : 503).send({ status, dependencies: { database, hermes } });
  });

  app.get('/v1/chat', { preHandler: authenticate }, async (request) => {
    const query = historyQuerySchema.parse(request.query);
    return dependencies.repository.getChat(request.userId!, query.before ?? null, query.limit);
  });

  app.post('/v1/chat/messages', { preHandler: authenticate }, async (request, reply) => {
    const body = createMessageSchema.parse(request.body);
    const content = normalizeMessage(body.content);
    if (!content || content.length > 8_000) {
      throw new AppError('INVALID_MESSAGE', 'Messages must contain between 1 and 8,000 characters.');
    }
    const instance = await dependencies.repository.getAgentInstance(request.userId!);
    if (!instance) throw new AppError('AGENT_NOT_PROVISIONED', 'Apt chat has not been provisioned for this user.');
    if (instance.status === 'disabled') throw new AppError('AGENT_DISABLED', 'Apt chat is disabled for this user.');
    const turn = await dependencies.repository.createTurn(request.userId!, body.clientMessageId, content);
    manager.begin(request.userId!, instance, turn);
    return reply.status(turn.duplicate ? 200 : 202).send(turn);
  });

  app.post('/internal/agent/tool', async (request) => {
    const token = bearerToken(request.headers.authorization);
    const profileName = verifyAptBridgeToken(token, dependencies.config.hermes.keySecret);
    if (!profileName) throw new AppError('UNAUTHENTICATED', 'Invalid Apt bridge credential.');
    const body = internalToolSchema.parse(request.body);
    return manager.invokeAgentTool(profileName, body.tool, body.arguments);
  });

  app.get('/v1/chat/runs/:runId', { preHandler: authenticate }, async (request) => {
    const { runId } = runParamsSchema.parse(request.params);
    return dependencies.repository.getRun(request.userId!, runId);
  });

  app.get('/v1/chat/runs/:runId/events', { preHandler: authenticate }, async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    await dependencies.repository.getRun(request.userId!, runId);
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    try {
      for await (const event of manager.events(request.userId!, runId)) {
        if (reply.raw.destroyed) break;
        reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
    } finally {
      if (!reply.raw.destroyed) reply.raw.end();
    }
  });

  app.post('/v1/chat/runs/:runId/stop', { preHandler: authenticate }, async (request, reply) => {
    const { runId } = runParamsSchema.parse(request.params);
    const run = await manager.stop(request.userId!, runId);
    return reply.status(202).send(run);
  });

  app.addHook('onReady', async () => manager.recoverAfterRestart());
  app.addHook('onClose', async () => dependencies.repository.close());
  return app;
}

export function normalizeMessage(content: string) {
  return content.replace(/\r\n?/g, '\n').trim();
}
