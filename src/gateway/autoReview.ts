import type { PermissionResult } from '../types/permissions'

// A compound shell decision can wrap explicit ask/deny rules on individual segments.
export function hostReviewable(result: PermissionResult): boolean {
  if (result.behavior === 'deny') return false
  if ('blockedPath' in result && result.blockedPath) return false
  const reason = result.decisionReason
  if (reason?.type === 'subcommandResults') {
    return reason.reasons.size > 0 && [...reason.reasons.values()].every(hostReviewable)
  }
  if (result.behavior === 'allow') return true
  if (reason && reason.type !== 'other') return false
  return result.behavior === 'passthrough' || result.fromPassthrough === true
}

type TranscriptRow = {
  type: string
  isMeta?: boolean
  message?: { content: unknown }
}

// Tool results are untrusted and can also have the "user" role.
function userText(row: TranscriptRow): string {
  if (row.type !== 'user' || row.isMeta) return ''
  const content = row.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content) || content.some(block => block?.type === 'tool_result')) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text).join('\n')
}

export function autoReviewPrompt(messages: readonly TranscriptRow[], tool: string, args: unknown): string | undefined {
  const lastUser = messages.findLast(row => userText(row).trim().length > 0)
  if (!lastUser) return
  const data = JSON.stringify({request: userText(lastUser), tool, args})
  if (Buffer.byteLength(data) <= 16000) return data
}
