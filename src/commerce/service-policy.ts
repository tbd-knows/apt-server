import { conflict } from './domain.js';
import { publicEndpoint } from './public-http.js';
import type { ServiceInvocation } from './mcp-execution.js';

/** A provider catalogue is not an execution policy. These two documented
 * operations only enumerate/describe capabilities. In particular Shippo's
 * read_execute wrapper can perform billable tracking: it is NOT admitted.
 * Official contract: https://github.com/goshippo/ai/blob/main/skills/shippo-best-practices/SKILL.md
 * This is an optional discovered service, never a required platform account.
 * Purchases need separate offer/payment/rate/evidence bindings before admission. */
export function requireCapabilityDiscovery(endpoint:string,invocation:ServiceInvocation) {
  if(!publicEndpoint(endpoint)) conflict('Unsupported service endpoint.');
  const url=new URL(endpoint);
  if(url.hostname!=='mcp.shippo.com' || !['/','/mcp'].includes(url.pathname)
    || !['shippo_list_tools','shippo_describe_tool'].includes(invocation.tool.name)) {
    conflict('This service operation has no verified execution contract yet. Do not substitute a purchase or billing operation.');
  }
}
