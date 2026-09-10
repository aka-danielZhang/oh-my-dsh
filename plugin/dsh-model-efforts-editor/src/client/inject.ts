/**
 * The settings-card injection engine for the effort editor: a
 * MutationObserver that decorates every stock pi-ai model row (the
 * ui-settings-models "自定义设置" fold's model list) with an effort button,
 * plus one fixed-position editor popup per open. Pure DOM, no framework;
 * all decisions come from {@link ./drafts.ts} and every write goes through
 * the caller-supplied {@link InjectionDeps.applyPlan} face — this module
 * owns placement and interaction only.
 *
 * Brittleness is known and accepted (the dsh-provider-balance posture): the
 * anchors mirror stock copy — the rows' `Model ID <n>` aria labels, the
 * pi-ai-only fetch-models button, and the four-children row shape. A harness
 * UI change that moves any of those silences the injection (fail-invisible,
 * never fail-hostile).
 *
 * @module dsh-model-efforts-editor/inject
 */

import {
  FETCH_MODELS_LABELS,
  LEVELS,
  MODEL_ID_ARIA,
  describeEfforts,
  entryOf,
  fingerprints,
  matchRoute,
  planOf,
} from './drafts.ts'
import type {
  EditorPlan,
  EffortsState,
  Level,
  ModelEntry,
} from './drafts.ts'
import type { ModelEffortsLocaleKey } from './locales.ts'
import { POP_WIDTH } from './styles.ts'

/** Section-local translate signature matching the framework `Translate`. */
export type TranslateSection = (
  key: ModelEffortsLocaleKey,
  params?: Record<string, unknown>,
) => string

/** What the injection engine needs from the apply world. */
export interface InjectionDeps {
  /** Translate this plugin's copy. */
  t: TranslateSection
  /** The namespace snapshot's raw user layer (fresh on every call). */
  readUser(): unknown
  /** Write one drafted plan onto a stored row; rejects with a message on failure. */
  applyPlan(provider: string, modelId: string, plan: EditorPlan): Promise<void>
  /** Observe stored-settings changes (external or our own writes) to repaint. */
  onStoredChange(listener: () => void): () => void
}

const CHECK_SVG = '<svg class="mee-check" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

/** OFF state: neutral dial glyph. */
const DIAL_OFF = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.9V8l2.2 1.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'
/** ON state: filled dial — unmistakable next to the outline. */
const DIAL_ON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M8 1.6A6.4 6.4 0 1 0 14.4 8A6.4 6.4 0 0 0 8 1.6ZM8.9 3v5l-3.5 2.6-.95-1.15L7.3 7.35V3h1.6Z"/></svg>'
/** PINNED state: slashed dial for `reasoningEfforts: false`. */
const DIAL_PINNED = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="5.6" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.9V8l2.2 1.7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M3.2 12.8l9.6-9.6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  return String(cause)
}

/** One draft level row inside the open editor. */
interface LevelDraft {
  readonly level: Level
  input: HTMLInputElement
}

/**
 * Start the injection and return its disposer: disconnects the observer,
 * removes the document listeners, closes any open editor, and strips every
 * injected button.
 * @param deps - translate, stored-state reads/writes, and change signals.
 * @returns the disposer.
 */
export function startInjection(deps: InjectionDeps): () => void {
  const { t } = deps
  const buttons = new Set<HTMLButtonElement>()
  let pop: HTMLDivElement | null = null
  let anchor: HTMLButtonElement | undefined

  function closeEditor(): void {
    if (pop !== null) {
      pop.remove()
      pop = null
    }
    anchor = undefined
  }

  // Position the open editor against its anchor button: right edges aligned
  // so it grows left inside the desktop settings panel, below when the
  // rendered height fits, otherwise flipped above. Called on open AND on
  // every scroll/resize/repaint while open — a fixed-position popup would
  // drift away from its row as soon as the panel content scrolls.
  function place(): void {
    if (pop === null || anchor === undefined) return
    if (anchor.isConnected !== true) {
      closeEditor()
      return
    }
    const rect = anchor.getBoundingClientRect()
    pop.style.left = String(Math.max(8, Math.min(rect.right - POP_WIDTH, window.innerWidth - POP_WIDTH - 8))) + 'px'
    const height = pop.getBoundingClientRect().height
    const below = rect.bottom + 5
    pop.style.top = String(
      below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 5),
    ) + 'px'
  }

  /** The current plan behind one injected button, or undefined when unreadable. */
  function contextOf(btn: HTMLButtonElement): {
    route: string | undefined
    modelId: string
    entry: ModelEntry | undefined
  } {
    const row = btn.parentElement
    const idInput = row !== null ? row.children[0] : undefined
    const section = row !== null ? sectionOf(row) : null
    const prints = fingerprints(deps.readUser())
    const route = section !== null ? matchRoute(idsOfSection(section), prints) : undefined
    const modelId = idInput instanceof HTMLInputElement ? idInput.value : ''
    return { route, modelId, entry: entryOf(route, modelId, prints) }
  }

  /** State-summary key + params for tooltips and headers. */
  function stateCopy(state: EffortsState): { key: ModelEffortsLocaleKey; count?: number } {
    const described = describeEfforts(state)
    if (described === false) return { key: 'stateFalse' }
    if (described === null) return { key: 'stateUndeclared' }
    return { key: 'stateLevels', count: described }
  }

  function paintIcons(): void {
    for (const btn of Array.from(buttons)) {
      if (btn.isConnected !== true) {
        buttons.delete(btn)
        continue
      }
      const { entry } = contextOf(btn)
      const state: EffortsState = entry === undefined ? { kind: 'undeclared' } : planOf(entry).efforts
      // Guarded writes ONLY: the observer watches the whole body subtree, so a
      // repaint that blindly rewrites attributes or innerHTML re-triggers
      // painting in an endless childList loop (a real freeze, seen live).
      const wantOn = state.kind === 'levels' ? '1' : undefined
      if (wantOn === '1') {
        if (btn.getAttribute('data-on') !== '1') btn.setAttribute('data-on', '1')
      } else if (btn.hasAttribute('data-on')) {
        btn.removeAttribute('data-on')
      }
      const icon = state.kind === 'levels' ? 'on' : state.kind === 'false' ? 'pinned' : 'off'
      if (btn.dataset.meeIcon !== icon) {
        btn.dataset.meeIcon = icon
        btn.innerHTML = icon === 'on' ? DIAL_ON : icon === 'pinned' ? DIAL_PINNED : DIAL_OFF
      }
      const copy = stateCopy(state)
      const text = t('tooltip', { state: t(copy.key, copy.count !== undefined ? { count: copy.count } : {}) })
      if (btn.getAttribute('aria-label') !== text) {
        btn.title = text
        btn.setAttribute('aria-label', text)
      }
    }
    place()
  }

  function openEditor(btn: HTMLButtonElement): void {
    closeEditor()
    anchor = btn
    const { route, modelId, entry } = contextOf(btn)
    const current: EditorPlan = entry === undefined
      ? { efforts: { kind: 'undeclared' }, compatZai: false }
      : planOf(entry)

    pop = document.createElement('div')
    pop.className = 'mee-pop'
    pop.setAttribute('role', 'dialog')
    pop.setAttribute('aria-label', modelId)

    const head = document.createElement('div')
    head.className = 'mee-pop-head'
    const title = document.createElement('span')
    title.className = 'mee-pop-title'
    title.textContent = modelId.length > 0 ? modelId : '?'
    const sub = document.createElement('span')
    sub.className = 'mee-pop-sub'
    sub.textContent = route ?? ''
    head.appendChild(title)
    head.appendChild(sub)
    pop.appendChild(head)

    if (entry === undefined || route === undefined) {
      const note = document.createElement('p')
      note.className = 'mee-pop-note'
      note.textContent = t('notEditable')
      pop.appendChild(note)
      document.body.appendChild(pop)
      place()
      return
    }

    // --- draft state -------------------------------------------------------
    let mode: 'inherit' | 'false' | 'levels' =
      current.efforts.kind === 'levels' ? 'levels' : current.efforts.kind === 'false' ? 'false' : 'inherit'
    let compatZai = current.compatZai
    const seeds = current.efforts.kind === 'levels' ? current.efforts.levels : {}
    const errors = document.createElement('div')
    errors.className = 'mee-err'

    // --- mode segmented control -------------------------------------------
    const modes = document.createElement('div')
    modes.className = 'mee-modes'
    const modeButtons: HTMLButtonElement[] = []
    const MODE_COPY: Record<typeof mode, ModelEffortsLocaleKey> = {
      inherit: 'modeInherit',
      false: 'modeFalse',
      levels: 'modeLevels',
    }
    const levelsBox = document.createElement('div')
    levelsBox.className = 'mee-levels'
    const drafts: LevelDraft[] = []

    const syncModes = (): void => {
      for (const button of modeButtons) {
        const on = button.dataset.meeMode === mode
        if (on) button.setAttribute('data-on', '1')
        else button.removeAttribute('data-on')
      }
      levelsBox.style.display = mode === 'levels' ? '' : 'none'
    }

    for (const candidate of ['inherit', 'false', 'levels'] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.dataset.meeMode = candidate
      button.textContent = t(MODE_COPY[candidate])
      button.addEventListener('click', () => {
        mode = candidate
        syncModes()
      })
      modes.appendChild(button)
      modeButtons.push(button)
    }
    pop.appendChild(modes)

    // --- levels checklist ---------------------------------------------------
    for (const level of LEVELS) {
      const line = document.createElement('div')
      line.className = 'mee-level'
      const label = document.createElement('label')
      const check = document.createElement('input')
      check.type = 'checkbox'
      check.checked = seeds[level] !== undefined
      label.appendChild(check)
      const name = document.createElement('span')
      name.textContent = level
      label.appendChild(name)
      const wire = document.createElement('input')
      wire.type = 'text'
      const seed = seeds[level]
      wire.placeholder = t('wirePlaceholder')
      wire.value = typeof seed === 'string' ? seed : ''
      wire.disabled = !check.checked
      if (level === 'off') {
        wire.title = t('levelOffNote')
      }
      check.addEventListener('change', () => {
        wire.disabled = !check.checked
        if (!check.checked) wire.value = ''
        else if (wire.value.length === 0 && level !== 'off') wire.value = level
      })
      line.appendChild(label)
      line.appendChild(wire)
      levelsBox.appendChild(line)
      drafts.push({ level, input: wire })
    }
    pop.appendChild(levelsBox)

    // --- zai compat toggle --------------------------------------------------
    const compatLabel = document.createElement('label')
    compatLabel.className = 'mee-compat'
    const compatCheck = document.createElement('input')
    compatCheck.type = 'checkbox'
    compatCheck.checked = compatZai
    compatCheck.addEventListener('change', () => {
      compatZai = compatCheck.checked
    })
    compatLabel.appendChild(compatCheck)
    const compatText = document.createElement('span')
    compatText.textContent = t('compatZai')
    compatLabel.appendChild(compatText)
    pop.appendChild(compatLabel)

    // --- footer -------------------------------------------------------------
    const foot = document.createElement('div')
    foot.className = 'mee-foot'
    const applyButton = document.createElement('button')
    applyButton.type = 'button'
    applyButton.textContent = t('apply')
    applyButton.addEventListener('click', () => {
      // Draft → plan. Validation happens here so the dialog can say which
      // field refused: every non-off level needs a non-empty wire value,
      // an empty off maps to null (supported, send nothing), and at least
      // one level must be offered.
      const drafted = buildPlan(mode, drafts, compatZai)
      if (drafted === 'invalid') {
        errors.textContent = t('writeFailed', { message: t('wireInvalid') })
        return
      }
      if (drafted === 'empty') {
        errors.textContent = t('writeFailed', { message: t('noChange') })
        return
      }
      for (const other of Array.from(pop?.querySelectorAll('button') ?? [])) other.disabled = true
      errors.textContent = t('writing')
      deps.applyPlan(route, modelId, drafted).then(() => {
        closeEditor()
      }, (cause: unknown) => {
        errors.textContent = t('writeFailed', { message: messageOf(cause) })
        for (const other of Array.from(pop?.querySelectorAll('button') ?? [])) other.disabled = false
      })
    })
    foot.appendChild(errors)
    foot.appendChild(applyButton)
    pop.appendChild(foot)

    syncModes()
    document.body.appendChild(pop)
    place()

    /**
     * Turn the dialog draft into a write plan; `'invalid'` marks a refused
     * wire value, `'empty'` a custom-levels mode with nothing offered.
     */
    function buildPlan(
      picked: typeof mode,
      levelDrafts: readonly LevelDraft[],
      zai: boolean,
    ): EditorPlan | 'invalid' | 'empty' {
      if (picked === 'inherit') return { efforts: { kind: 'undeclared' }, compatZai: zai }
      if (picked === 'false') return { efforts: { kind: 'false' }, compatZai: zai }
      const levels: Partial<Record<Level, string | null>> = {}
      let offered = false
      for (const draft of levelDrafts) {
        const box = draft.input.parentElement?.querySelector('input[type="checkbox"]')
        if (!(box instanceof HTMLInputElement) || box.checked !== true) continue
        const raw = draft.input.value.trim()
        if (raw.length === 0 && draft.level !== 'off') return 'invalid'
        offered = true
        levels[draft.level] = raw.length === 0 ? null : raw
      }
      if (!offered) return 'empty'
      return { efforts: { kind: 'levels', levels }, compatZai: zai }
    }
  }

  function decorate(): void {
    for (const input of document.querySelectorAll('input[aria-label]')) {
      if (!(input instanceof HTMLInputElement)) continue
      if (input.getAttribute('data-mee-mark') === '1') continue
      if (MODEL_ID_ARIA.test(input.getAttribute('aria-label') ?? '') !== true) continue
      const row = input.parentElement
      if (row === null || row.children.length < 2) continue
      if (sectionOf(input) === null) continue
      input.setAttribute('data-mee-mark', '1')
      // The stock row is a fixed 4-column grid; the class switches it to flex
      // so any number of injected buttons fits (see styles.ts).
      row.classList.add('mee-grid')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mee-btn'
      btn.dataset.meeIcon = 'off'
      btn.innerHTML = DIAL_OFF
      btn.setAttribute('aria-haspopup', 'dialog')
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        if (pop !== null && anchor === btn) closeEditor()
        else openEditor(btn)
      })
      // Stock row shape: [id input, name input, chevron, trash]. The chevron
      // is the insertion anchor; a mid-render shape falls back to appending.
      const chevron = row.children[2]
      if (chevron !== undefined && chevron.tagName === 'BUTTON') row.insertBefore(btn, chevron)
      else row.appendChild(btn)
      buttons.add(btn)
    }
    paintIcons()
  }

  const observer = new MutationObserver(() => {
    decorate()
  })
  observer.observe(document.body, { childList: true, subtree: true })
  const onDown = (event: MouseEvent): void => {
    if (pop !== null && event.target instanceof Node && pop.contains(event.target) === false) closeEditor()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closeEditor()
  }
  // Scroll does not bubble but does propagate in the capture phase, so the
  // document-level capture listener sees every inner container's scroll.
  const onMove = (): void => {
    place()
  }
  document.addEventListener('mousedown', onDown)
  document.addEventListener('keydown', onKey)
  document.addEventListener('scroll', onMove, true)
  window.addEventListener('resize', onMove)
  const stopStored = deps.onStoredChange(() => {
    paintIcons()
    place()
  })
  decorate()
  return () => {
    observer.disconnect()
    document.removeEventListener('mousedown', onDown)
    document.removeEventListener('keydown', onKey)
    document.removeEventListener('scroll', onMove, true)
    window.removeEventListener('resize', onMove)
    stopStored()
    closeEditor()
    for (const btn of Array.from(buttons)) {
      if (btn.isConnected) btn.remove()
      buttons.delete(btn)
    }
    // Marks and row classes outlive the buttons on persistent settings rows:
    // a stale mark makes a remount skip the row forever, so scrub them too.
    for (const input of Array.from(document.querySelectorAll('input[data-mee-mark="1"]'))) {
      input.removeAttribute('data-mee-mark')
      input.parentElement?.classList.remove('mee-grid')
    }
  }
}

/** The section ancestor that carries the pi-ai-only fetch-models action. */
function sectionOf(node: Element): Element | null {
  let cur: Element | null = node.parentElement
  while (cur !== null && cur !== document.body) {
    if (cur.tagName === 'SECTION') {
      for (const button of cur.querySelectorAll('button')) {
        if (FETCH_MODELS_LABELS.includes((button.textContent ?? '').trim())) return cur
      }
    }
    cur = cur.parentElement
  }
  return null
}

/** The card's row ids as shown, in row order. */
function idsOfSection(section: Element): string[] {
  const ids: string[] = []
  for (const input of section.querySelectorAll('input[aria-label]')) {
    if (!(input instanceof HTMLInputElement)) continue
    if (MODEL_ID_ARIA.test(input.getAttribute('aria-label') ?? '')) ids.push(input.value)
  }
  return ids
}
