import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { MEMORY_LIMITS, type MemoryToolName } from './domain.js';
import { draftRequestSchema, itemSchema, preparedCommandSchema } from '../commerce/domain.js';
import { researchInputSchema } from '../commerce/research.js';

const internalUrl = z.url().parse(process.env.APT_INTERNAL_URL).replace(/\/$/, '');
const bridgeToken = z.string().min(32).parse(process.env.APT_BRIDGE_TOKEN);

const server = new McpServer({ name: 'apt-memory-bridge', version: '2.0.0' });

function registerTool(name: MemoryToolName, description: string, inputSchema: Record<string, z.ZodType>, annotations?: { readOnlyHint?: boolean }) {
  server.registerTool(name, { description, inputSchema, ...(annotations ? { annotations } : {}) }, async (input) => {
    const response = await fetch(`${internalUrl}/internal/agent/tool`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${bridgeToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: name, arguments: input }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as unknown;
    if (!response.ok) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
    return { content: [{ type: 'text' as const, text: JSON.stringify(body) }] };
  });
}

registerTool('apt_search_knowledge', 'Search only the current user’s active private knowledge. User identity is server-bound.', {
  query: z.string().min(1).max(1_000), limit: z.number().int().min(1).max(20).default(10),
}, { readOnlyHint: true });
registerTool('apt_remember', 'Store a durable fact for only the current user.', {
  subject_kind: z.enum(['self', 'recipient', 'relationship', 'other']),
  subject_label: z.string().min(1).max(160).nullable(),
  category: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  fact: z.string().min(1).max(MEMORY_LIMITS.fact), confidence: z.number().min(0).max(1),
  sensitivity: z.enum(['low', 'sensitive']).default('low'),
});
registerTool('apt_update_private_artifact', 'Update the current user’s private Soul, USER hot cache, or MEMORY hot cache with optimistic revision control.', {
  kind: z.enum(['soul', 'user_profile', 'memory']), content: z.string().max(MEMORY_LIMITS.soulText),
  expected_revision: z.string().regex(/^\d+$/),
});

registerTool('apt_commerce', 'Read durable commerce state and missing prerequisites. Prepare a request, item, or exact next command for owner review, or ask your owner a question. prepare_action requires the current revision and a supported command. Drafts are private until an owner confirmation. Cannot approve, pay, buy labels or set provider facts. Stop after preparing one action; resume from state after human input.', {
  action: z.enum(['state', 'draft_request', 'draft_item', 'ask_owner', 'suggest_preference', 'prepare_action', 'research', 'prepare_service_action', 'prepare_shipping_validation', 'prepare_shipping_rates', 'service_history']),
  input: draftRequestSchema.optional(), exchangeId: z.uuid().optional(),
  item: itemSchema.optional(), question: z.string().min(1).max(500).optional(),
  key: z.string().optional(), value: z.string().optional(), provenance: z.string().optional(),
  revision: z.number().int().positive().optional(), command: preparedCommandSchema.optional(), explanation: z.string().min(1).max(500).optional(),
  research: researchInputSchema.optional(),
  connectionId:z.uuid().optional(),tool:z.string().min(1).max(128).optional(),arguments:z.record(z.string(),z.unknown()).optional(),
  beforeActionId:z.uuid().optional(),sourceActionId:z.uuid().optional(),consentId:z.uuid().optional(),descriptionActionId:z.uuid().optional(),addressRole:z.enum(['buyer','seller']).optional(),
});

await server.connect(new StdioServerTransport());
