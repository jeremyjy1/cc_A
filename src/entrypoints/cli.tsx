import { gatewayMain } from '../gateway/client'

process.env.COREPACK_ENABLE_AUTO_PIN = '0'
const args = process.argv.slice(2)
// Keep compatibility with installed launchers that supply the gateway subcommand.
if (args[0] === 'gateway') args.shift()
if (args.length === 1 && ['-v', '-V', '--version'].includes(args[0]!)) {
  console.log(`${MACRO.VERSION} (claudec)`)
} else {
  try {
    await gatewayMain(args)
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Gateway request failed')
    process.exitCode = 1
  }
}
