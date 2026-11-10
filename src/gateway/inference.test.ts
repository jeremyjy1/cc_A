import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cli, repo, writeTestKey } from './fixtures/cli'

test('claudec sends explicit inference options and requires C to acknowledge them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claudec-inference-'))
  const root = join(dir, 'project')
  mkdirSync(root)
  writeTestKey(join(dir, 'key'), 'gw1_' + 'b'.repeat(43))
  const seen: unknown[] = []
  let oldPool = false
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req, s) { if (!s.upgrade(req)) return new Response('', {status:400}) },
    websocket: {message(ws, data) {
      const m = JSON.parse(String(data))
      if (m.type !== 'user.message') return
      const options = {model:m.model, effort:m.effort}
      seen.push(options)
      for (const frame of [
        {type:'agent.turn.started', ...(oldPool ? {} : options)},
        {type:'agent.text.delta', text:'test answer'}, {type:'agent.turn.completed'},
      ]) ws.send(JSON.stringify({id:m.id, ...frame}))
    }},
  })
  try {
    for (const [model, effort, simple, legacy] of [
      ['sonnet','xhigh',false,false], ['my/Model:1','medium',true,false],
      ['default','auto',false,false], ['opus','high',true,true],
    ] as const) {
      seen.length = 0
      oldPool = legacy
      await using proc = Bun.spawn([...cli, '--workspace', root, '--key-file', join(dir,'key'),
        '--url', 'ws://127.0.0.1:'+server.port+'/v1/ws', '--model',model,'--effort',effort,
        ...(simple ? ['--simple'] : []), '-p', 'Say hello'], {cwd:repo, stdin:'ignore', stdout:'pipe', stderr:'pipe'})
      const [status,out,err] = await Promise.all([proc.exited,new Response(proc.stdout).text(),new Response(proc.stderr).text()])
      expect(seen.length).toBeGreaterThan(0)
      expect(seen).toContainEqual({model:model==='default'?undefined:model,effort:effort==='auto'?undefined:effort})
      if (legacy) expect(out+err).toContain('C 端未确认')
      else {
        expect(status, out+err).toBe(0)
        expect(out).toContain('test answer')
      }
    }
  } finally { await server.stop(true); rmSync(dir,{recursive:true,force:true}) }
}, 60000)
