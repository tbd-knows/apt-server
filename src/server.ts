import { HermesAgentRuntime } from './agent-runtime.js';
import { buildApp } from './app.js';
import { SupabaseAuthService } from './auth.js';
import { loadConfig } from './config.js';
import { PostgresChatRepository } from './repository.js';
import { MemoryMaterializer } from './memory/materializer.js';
import { PostgresMemoryRepository } from './memory/repository.js';
import { MemoryAgentRuntime } from './memory/runtime.js';
import { MemoryService } from './memory/service.js';
import { CommerceRepository } from './commerce/repository.js';
import { CommerceService } from './commerce/service.js';
import { providerConfig, StripeProvider, EasyPostProvider } from './commerce/providers.js';
import { FedExLocations } from './commerce/locations.js';
import { CommerceWorker } from './commerce/worker.js';
import { CommerceAssets } from './commerce/assets.js';
import { commerceWebhooks } from './commerce/webhooks.js';

const config = loadConfig();
const repository = PostgresChatRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
const auth = SupabaseAuthService.create(config.supabase.url, config.supabase.publishableKey);
const memoryRepository = PostgresMemoryRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
const commerceRepository = CommerceRepository.create(config.supabase.databaseUrl, config.supabase.databaseSsl);
const commerceService = new CommerceService(commerceRepository, config.pilotUserIds, config.commerceMode);
const providersConfig = providerConfig(process.env, config.commerceMode);
const providers = { stripe: new StripeProvider(providersConfig), shipping: new EasyPostProvider(providersConfig), locations: new FedExLocations(providersConfig) };
const commerceAssets = new CommerceAssets(commerceService, config.supabase.url, config.supabase.serviceRoleKey, process.env.APT_PHOTO_BUCKET ?? 'pilot-photos', providers.shipping);
const memoryService = new MemoryService(memoryRepository, undefined, commerceService);
const runtime = new MemoryAgentRuntime(
  new HermesAgentRuntime(config.hermes),
  memoryService,
  new MemoryMaterializer(config.hermes.home),
);
const app = await buildApp({ config, repository, auth, runtime, memoryService, commerceService, commerceAssets, commerceStripe: providers.stripe });
await commerceWebhooks(app, commerceRepository, providersConfig);
const worker = new CommerceWorker(commerceRepository, commerceService, providers, event => app.log.warn(event, 'Commerce operation needs attention'));
app.addHook('onReady', async () => worker.start());
app.addHook('preClose', async () => worker.stop());
app.get('/commerce/return', async (_request, reply) => reply.type('text/html').header('Cache-Control', 'no-store').send(
  '<!doctype html><meta name="viewport" content="width=device-width"><title>Return to TBD</title><p>Your provider status is being checked.</p><p><a href="aptmobile://commerce-return">Return to the app</a></p>',
));
app.addHook('onClose', async () => commerceRepository.pool.end());
app.addHook('onClose', async () => memoryRepository.close());

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: config.host, port: config.port });
