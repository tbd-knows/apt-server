import { HermesAgentRuntime } from './agent-runtime.js';
import { buildApp } from './app.js';
import { SupabaseAuthService } from './auth.js';
import { loadConfig } from './config.js';
import { PostgresChatRepository } from './repository.js';
import { MemoryMaterializer } from './memory/materializer.js';
import { PostgresMemoryRepository } from './memory/repository.js';
import { MemoryAgentRuntime } from './memory/runtime.js';
import { MemoryService } from './memory/service.js';

const config = loadConfig();
const repository = PostgresChatRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
const auth = SupabaseAuthService.create(config.supabase.url, config.supabase.publishableKey);
const memoryRepository = PostgresMemoryRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
const memoryService = new MemoryService(memoryRepository);
const runtime = new MemoryAgentRuntime(
  new HermesAgentRuntime(config.hermes),
  memoryService,
  new MemoryMaterializer(config.hermes.home),
);
const app = await buildApp({ config, repository, auth, runtime, memoryService });
app.addHook('onClose', async () => memoryRepository.close());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
