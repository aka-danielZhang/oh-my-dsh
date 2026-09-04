/**
 * Child-process lock holder for the two-process writer-lock test:
 * acquires the lock on argv[2], prints "held", keeps it until stdin closes
 * or the process is killed (no release on kill — that is the point).
 *
 * An explicit timer keeps the event loop alive: a never-read stdin pipe does
 * not hold the loop, and a holder that exits after signaling would silently
 * give the lock back.
 */
import { WriterLock } from '../../src/lock.ts'

const lockDir = process.argv[2]
if (typeof lockDir !== 'string' || lockDir.length === 0) {
  console.error('lock-holder: missing lock dir argument')
  process.exit(1)
}

const lock = new WriterLock(lockDir, { timeoutMs: 5_000 })
lock.acquire().then(
  () => {
    process.stdout.write('held\n')
    const keepAlive = setInterval(() => {}, 60_000)
    process.stdin.on('close', () => {
      clearInterval(keepAlive)
      lock.release()
      process.stdout.write('released\n')
      process.exit(0)
    })
  },
  (error: unknown) => {
    console.error(`lock-holder: acquire failed: ${(error as Error).message}`)
    process.exit(2)
  },
)
