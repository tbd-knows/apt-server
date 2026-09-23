/**
 * Owner-scoped private context retained from the Claw pilot. Rows still live
 * in the `claw_user_profiles`, `claw_user_knowledge`, and
 * `claw_learning_events` tables so existing founder data is preserved.
 */
export const MEMORY_HISTORY_BUDGET_DEFAULT = 48_000;

export const MEMORY_LIMITS = {
  soulText: 20_000,
  hotUserText: 1_375,
  hotMemoryText: 2_200,
  fact: 4_000,
  knowledgeSearch: 24,
} as const;

export interface PrivateProfile {
  soulText: string;
  hotUserText: string;
  hotMemoryText: string;
  revision: string;
  knowledgeRevision: string;
  runtimeHash: string | null;
}

export interface KnowledgeFact {
  id: string;
  subjectKind: 'self' | 'recipient' | 'relationship' | 'other';
  subjectLabel: string | null;
  category: string;
  fact: string;
  confidence: number;
  learnedAt: string;
}

export interface KnowledgeInput {
  subjectKind: KnowledgeFact['subjectKind'];
  subjectLabel: string | null;
  category: string;
  fact: string;
  confidence: number;
  sensitivity: 'low' | 'sensitive';
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Private artifacts read back from an isolated Hermes profile after a run. */
export interface RuntimePrivateArtifacts {
  soulText: string;
  hotUserText: string;
  hotMemoryText: string;
}

export interface MemoryTurnBundle {
  profile: PrivateProfile;
  knowledge: KnowledgeFact[];
  conversationHistory: ConversationMessage[];
}

export interface RunContext {
  userId: string;
  runId: string;
  requestMessageId: string;
}

export const MEMORY_TOOL_NAMES = ['apt_search_knowledge', 'apt_remember', 'apt_update_private_artifact'] as const;
export type MemoryToolName = (typeof MEMORY_TOOL_NAMES)[number];
