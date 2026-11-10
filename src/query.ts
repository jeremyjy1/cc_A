import type { ToolUseContext } from './Tool.js'
import type { QuerySource } from './constants/querySource.js'
import type { CanUseToolFn } from './hooks/useCanUseTool.js'
import type { Message, RequestStartEvent, StreamEvent, TombstoneMessage, ToolUseSummaryMessage } from './types/message.js'
import type { SystemPrompt } from './utils/systemPromptType.js'

export type QueryParams = {
  messages: Message[]
  systemPrompt: SystemPrompt
  userContext: { [k: string]: string }
  systemContext: { [k: string]: string }
  canUseTool: CanUseToolFn
  toolUseContext: ToolUseContext
  fallbackModel?: string
  querySource: QuerySource
  maxOutputTokensOverride?: number
  maxTurns?: number
  skipCacheWrite?: boolean
  // API task_budget (output_config.task_budget, beta task-budgets-2026-03-13).
  // Distinct from the tokenBudget +500k auto-continue feature. `total` is the
  // budget for the whole agentic turn; `remaining` is computed per iteration
  // from cumulative API usage. See configureTaskBudgetParams in claude.ts.
  taskBudget?: { total: number }
}

export async function* query(params: QueryParams): AsyncGenerator<
  Message | RequestStartEvent | StreamEvent | TombstoneMessage | ToolUseSummaryMessage,
  { reason: 'completed' }
> {
  const { nativeQuery, nativeGateway } = await import('./gateway/native')
  if (!nativeGateway) throw new Error('Gateway is not connected')
  return yield* nativeQuery(params)
}
