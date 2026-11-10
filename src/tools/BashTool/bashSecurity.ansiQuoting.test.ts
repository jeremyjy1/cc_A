import { describe, expect, test } from 'bun:test'
import {
  bashCommandIsSafe_DEPRECATED,
  bashCommandIsSafeAsync_DEPRECATED,
} from './bashSecurity.js'

const warning = 'Command contains ANSI-C quoting which can hide characters'

for (const [name, check] of [
  ['sync', bashCommandIsSafe_DEPRECATED],
  ['async', bashCommandIsSafeAsync_DEPRECATED],
] as const) {
  describe(name, () => {
    test.each([
      "git grep 'end$' -- 'release notes.md'",
      "git diff | grep 'end$' | grep 'done$'",
    ])('accepts quoted regex anchors in %s', async command => {
      expect((await check(command)).behavior).toBe('passthrough')
    })

    test.each([
      "git grep $'end\\t' -- 'release notes.md'",
      "git grep 'end$' -- $'release notes.md'",
      "git grep $''",
      "git grep 'prefix'$'suffix'",
    ])('requests approval for ANSI-C quoting in %s', async command => {
      expect(await check(command)).toMatchObject({ behavior: 'ask', message: warning })
    })
  })
}
