import { expect, test, spyOn } from 'bun:test'
import { Gateway } from './client'

// Accelerate only long deadlines; keep real WebSocket traffic and timer refresh.
for (const outcome of ['result', 'timeout'] as const) {
  test('quiet inference beyond ten minutes receives C ' + outcome, async () => {
    const realSetTimeout = globalThis.setTimeout
    let cancelled = false
    const replies: ReturnType<typeof setTimeout>[] = []
    const server = Bun.serve({
      hostname:'127.0.0.1', port:0,
      fetch(req, server) {
        if (server.upgrade(req)) return
        return new Response('', {status:400})
      },
      websocket: {message(ws, raw) {
        const frame = JSON.parse(String(raw))
        const emit = (type:string, text?:string) => ws.send(JSON.stringify({id:frame.id,type,text}))
        if (frame.type === 'user.cancel') { cancelled = true; emit('agent.turn.completed'); return }
        emit('agent.turn.started')
        // 200ms represents 20 minutes: after A's old deadline, before C's.
        replies.push(realSetTimeout(() => {
          if (outcome === 'timeout') emit('agent.error', 'turn_timed_out')
          else { emit('agent.text.delta', 'finished'); emit('agent.turn.completed') }
        }, 200))
      }},
    })
    const timerSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((callback:any, delay?:number, ...args:any[]) =>
      realSetTimeout(callback, delay && delay >= 60_000 ? delay / 6000 : delay, ...args)) as typeof setTimeout)
    const gateway = new Gateway(new URL('ws://127.0.0.1:' + server.port), 'synthetic')
    try {
      const pending = gateway.run(process.cwd(), 'read-only test', false, async () => false)
      if (outcome === 'result') expect(await pending).toBe('finished')
      else await expect(pending).rejects.toThrow('turn_timed_out')
      expect(cancelled).toBe(false)
    } finally {
      timerSpy.mockRestore()
      for (const timer of replies) clearTimeout(timer)
      gateway.close()
      await server.stop(true)
    }
  })
}
