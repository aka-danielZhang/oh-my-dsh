/**
 * Toolbar portal-host publishing, browser half. The DesktopToolbar's two
 * host cells (center + session end) are published into `ctx.layout`'s
 * toolbar-host registry so the session header can portal into them; this
 * class owns the CALLBACK-REF bookkeeping with node-identity protection.
 *
 * The failure being guarded against: a bridge HMR reload unmounts the OLD
 * toolbar AFTER the new one mounted (React order is not guaranteed across
 * the boundary). The old disposer must never clear the new toolbar's
 * registration. The publisher therefore tracks the exact pair IT published,
 * and the registry side (ui-layout LayoutController.releaseToolbarHosts)
 * additionally refuses releases whose pair is not the current one — two
 * independent identity fences.
 */

/** The two portal hosts a mounted toolbar offers the session header. */
export interface ToolbarHosts {
  readonly centerHost: HTMLElement
  readonly sessionEndHost: HTMLElement
}

/** The registry face this publisher needs (structural: the fork's ILayout). */
export interface ToolbarHostRegistry {
  setToolbarHosts(hosts: ToolbarHosts): void
  releaseToolbarHosts(hosts: ToolbarHosts): void
}

/**
 * Callback-ref driven publisher. Feed `center`/`end` as React callback refs
 * and `release` as the disposer; the pair is published once both nodes are
 * attached, republished when either node is remounted by React, and
 * released when either detaches.
 */
export class ToolbarHostPublisher {
  #center: HTMLElement | null = null
  #end: HTMLElement | null = null
  #published: ToolbarHosts | null = null
  readonly #registry: ToolbarHostRegistry | undefined

  /** @param registry - the fork's toolbar-host registry face (optional: an old runtime simply never publishes). */
  constructor(registry: ToolbarHostRegistry | undefined) {
    this.#registry = registry
  }

  /** React callback ref for the center host cell. */
  readonly center = (el: HTMLElement | null): void => {
    this.#center = el
    this.#publish()
  }

  /** React callback ref for the session-end host cell. */
  readonly end = (el: HTMLElement | null): void => {
    this.#end = el
    this.#publish()
  }

  /** Detach both cells and release the published pair (if still ours). */
  readonly release = (): void => {
    this.#center = null
    this.#end = null
    this.#publish()
  }

  #publish(): void {
    if (this.#registry === undefined) return
    const center = this.#center
    const end = this.#end
    if (center === null || end === null) {
      const mine = this.#published
      if (mine !== null) {
        this.#registry.releaseToolbarHosts(mine)
        this.#published = null
      }
      return
    }
    const prev = this.#published
    if (prev !== null && prev.centerHost === center && prev.sessionEndHost === end) return
    const hosts = { centerHost: center, sessionEndHost: end }
    this.#published = hosts
    this.#registry.setToolbarHosts(hosts)
  }
}
