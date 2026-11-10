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
