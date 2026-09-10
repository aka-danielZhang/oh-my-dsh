import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { ToolbarHostPublisher, type ToolbarHostRegistry, type ToolbarHosts } from '../src/client/toolbar-hosts.ts'

function stubElement(tag: string): HTMLElement {
  return { tag } as unknown as HTMLElement
}

function stubRegistry() {
  let current: ToolbarHosts | null = null
  const calls: Array<['set' | 'release', ToolbarHosts]> = []
  const registry: ToolbarHostRegistry = {
    setToolbarHosts(hosts) {
      current = hosts
      calls.push(['set', hosts])
    },
    releaseToolbarHosts(hosts) {
      calls.push(['release', hosts])
      // Identity fence, mirroring ui-layout's LayoutController: only the
      // CURRENT pair is actually cleared.
      if (current !== hosts) return
      current = null
    },
  }
  return { registry, calls, get current(): ToolbarHosts | null { return current } }
}

describe('ToolbarHostPublisher', () => {
  it('publishes only once both host cells are attached', () => {
    const { registry, calls } = stubRegistry()
    const publisher = new ToolbarHostPublisher(registry)
    const center = stubElement('center')
    const end = stubElement('end')
    publisher.center(center)
    assert.equal(calls.length, 0, 'one cell alone publishes nothing')
    publisher.end(end)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.[0], 'set')
    assert.equal(calls[0]?.[1].centerHost, center)
    assert.equal(calls[0]?.[1].sessionEndHost, end)
  })

  it('re-releases when a cell detaches, and republishes on remount', () => {
    const { registry, calls } = stubRegistry()
    const publisher = new ToolbarHostPublisher(registry)
    const center = stubElement('center')
    const end = stubElement('end')
    publisher.center(center)
    publisher.end(end)
    publisher.end(null)
    assert.equal(calls[1]?.[0], 'release', 'a detached cell releases the published pair')
    publisher.end(end)
    assert.equal(calls[2]?.[0], 'set', 'the remount republishes')
  })

  it('release is identity-safe against a registry holding a NEWER pair', () => {
    const stub = stubRegistry()
    const { registry, calls } = stub
    // Old toolbar publishes its pair…
    const old = new ToolbarHostPublisher(registry)
    const oldCenter = stubElement('old-center')
    const oldEnd = stubElement('old-end')
    old.center(oldCenter)
    old.end(oldEnd)
    // …then the new toolbar mounts and replaces the registration…
    const fresh = new ToolbarHostPublisher(registry)
    const newCenter = stubElement('new-center')
    const newEnd = stubElement('new-end')
    fresh.center(newCenter)
    fresh.end(newEnd)
    // …and only AFTER that, the old HMR disposer runs.
    old.release()
    assert.equal(calls.at(-1)?.[0], 'release', 'the stale disposer does ask to release its own pair')
    assert.notEqual(stub.current, null, 'the registry is not left empty…')
    assert.equal(stub.current?.centerHost, newCenter, '…because the identity fence keeps the NEW toolbar published')
  })

  it('skips identical republishes but follows node replacement', () => {
    const { registry, calls } = stubRegistry()
    const publisher = new ToolbarHostPublisher(registry)
    const center = stubElement('center')
    const end = stubElement('end')
    publisher.center(center)
    publisher.end(end)
    publisher.center(center)
    publisher.end(end)
    assert.equal(calls.length, 1, 're-attaching the same nodes is a no-op')
    const next = stubElement('center-2')
    publisher.center(next)
    assert.equal(calls.length, 2, 'a replaced node republishes with the new node')
    assert.equal(calls[1]?.[1].centerHost, next)
  })

  it('is inert without a registry (old runtime: header stays in place)', () => {
    const publisher = new ToolbarHostPublisher(undefined)
    const center = stubElement('center')
    const end = stubElement('end')
    publisher.center(center)
    publisher.end(end)
    publisher.release()
    assert.ok(true, 'no throw, no publication')
  })
})
