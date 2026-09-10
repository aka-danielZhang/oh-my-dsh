/**
 * The settings-card row injection engine: a MutationObserver that decorates
 * every stock pi-ai model row (the ui-settings-models "自定义设置" fold's
 * model list) with an image-input button, plus one fixed-position popup per
 * open. Pure DOM, no framework; all decisions come from {@link drafts} and
 * every write goes through the caller-supplied {@link InjectionDeps.apply}
 * face — this module owns placement and interaction only.
 *
 * Brittleness is known and accepted (the dsh-provider-balance posture): the
 * anchors mirror stock copy — the rows' `Model ID <n>` aria labels, the
 * pi-ai-only fetch-models button, and the four-children row shape. A harness
 * UI change that moves any of those silences the injection (fail-invisible,
 * never fail-hostile).
 *
 * @module dsh-model-image-input/inject
 */

import {
  FETCH_MODELS_LABELS, MODEL_ID_ARIA, choiceOf, entryOf, fingerprints, matchRoute,
} from './drafts.ts'
import type { InputChoice, ModelEntry } from './drafts.ts'
import type { ModelImageLocaleKey } from './locales.ts'
import { POP_WIDTH } from './styles.ts'

/** Section-local translate signature matching the framework `Translate`. */
export type TranslateSection = (
  key: ModelImageLocaleKey,
  params?: Record<string, unknown>,
) => string

/** What the injection engine needs from the apply world. */
export interface InjectionDeps {
  /** Translate this plugin's copy. */
  t: TranslateSection
  /** The namespace snapshot's raw user layer (fresh on every call). */
  readUser(): unknown
  /** Write one picker choice onto a stored row; rejects with a message on failure. */
  applyChoice(provider: string, modelId: string, choice: InputChoice): Promise<void>
  /** Observe stored-settings changes (external or our own writes) to repaint. */
  onStoredChange(listener: () => void): () => void
}

const CHOICES: readonly InputChoice[] = ['inherit', 'text', 'text,image']
const OPTION_LABEL: Record<InputChoice, ModelImageLocaleKey> = {
  'inherit': 'optionInherit',
  'text': 'optionText',
  'text,image': 'optionImage',
}
const STATE_LABEL: Record<InputChoice, ModelImageLocaleKey> = {
  'inherit': 'stateInherit',
  'text': 'stateText',
  'text,image': 'stateImage',
}

/** OFF state: neutral outline glyph. */
const IMG_OFF = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="2" y="2.5" width="12" height="11" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="5.8" cy="6.3" r="1.1" fill="currentColor"/><path d="M3.6 12.4l3.1-3.3 2 2 1.7-2.1 2 2.3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
/** ON state: brand-filled glyph with the mountain knocked out — unmistakable next to the outline. */
const IMG_ON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M4 2.5H12Q14.5 2.5 14.5 5V11Q14.5 13.5 12 13.5H4Q1.5 13.5 1.5 11V5Q1.5 2.5 4 2.5ZM4.7 6.3A1.1 1.1 0 1 0 6.9 6.3A1.1 1.1 0 1 0 4.7 6.3ZM3 12.7L7.1 8.3L9.1 10.4L10.8 8.2L13 10.7V12.7Z"/></svg>'
const CHECK_SVG = '<svg class="mii-pop-check" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M2.5 7.5l3 3 6-7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

function messageOf(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  return String(cause)
}

/**
 * Start the injection and return its disposer: disconnects the observer,
 * removes the document listeners, closes any open popup, and strips every
 * injected button (the marked inputs' markers go with their rows).
 * @param deps - translate, stored-state reads/writes, and change signals.
 * @returns the disposer.
 */
export function startInjection(deps: InjectionDeps): () => void {
  const { t } = deps
  const buttons = new Set<HTMLButtonElement>()
  let pop: HTMLDivElement | null = null
  let anchor: HTMLButtonElement | undefined

  function closePopup(): void {
    if (pop !== null) {
      pop.remove()
      pop = null
    }
    anchor = undefined
  }

  // Position the open popup against its anchor button: right edges aligned so
  // it grows left inside the desktop settings panel, below when the rendered
  // height fits, otherwise flipped above. Called on open AND on every
  // scroll/resize/repaint while open — a fixed-position popup would otherwise
  // drift away from its row as soon as the panel content scrolls.
  function place(): void {
    if (pop === null || anchor === undefined) return
    if (anchor.isConnected !== true) {
      closePopup()
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

  function paintIcons(): void {
    const prints = fingerprints(deps.readUser())
    for (const btn of Array.from(buttons)) {
      if (btn.isConnected !== true) {
        buttons.delete(btn)
        continue
      }
      const row = btn.parentElement
      const idInput = row !== null ? row.children[0] : undefined
      const section = row !== null ? sectionOf(row) : null
      const route = section !== null ? matchRoute(idsOfSection(section), prints) : undefined
      const modelId = idInput instanceof HTMLInputElement ? idInput.value : ''
      const entry = entryOf(route, modelId, prints)
      const choice: InputChoice = entry === undefined ? 'inherit' : choiceOf(entry)
      const on = choice === 'text,image'
      // Guarded writes ONLY: the observer watches the whole body subtree, so a
      // repaint that blindly rewrites attributes or innerHTML re-triggers
      // painting in an endless childList loop (a real freeze, seen live).
      if (on) {
        if (btn.getAttribute('data-on') !== '1') btn.setAttribute('data-on', '1')
      } else if (btn.hasAttribute('data-on')) {
        btn.removeAttribute('data-on')
      }
      const icon = on ? 'on' : 'off'
      if (btn.dataset.miiIcon !== icon) {
        btn.dataset.miiIcon = icon
        btn.innerHTML = icon === 'on' ? IMG_ON : IMG_OFF
      }
      const text = t('tooltip', { state: t(STATE_LABEL[choice]) })
      if (btn.getAttribute('aria-label') !== text) {
        btn.title = text
        btn.setAttribute('aria-label', text)
      }
    }
    place()
  }

  function openPopup(btn: HTMLButtonElement): void {
    closePopup()
    anchor = btn
    const row = btn.parentElement
    const idInput = row !== null ? row.children[0] : undefined
    const section = row !== null ? sectionOf(row) : null
    const prints = fingerprints(deps.readUser())
    const route = section !== null ? matchRoute(idsOfSection(section), prints) : undefined
    const modelId = idInput instanceof HTMLInputElement ? idInput.value : ''
    const entry = entryOf(route, modelId, prints)
    const choice = entry === undefined ? undefined : choiceOf(entry)

    pop = document.createElement('div')
    pop.className = 'mii-pop'
    pop.setAttribute('role', 'menu')

    const head = document.createElement('div')
    head.className = 'mii-pop-head'
    const title = document.createElement('span')
    title.className = 'mii-pop-title'
    title.textContent = modelId.length > 0 ? modelId : '?'
    const sub = document.createElement('span')
    sub.className = 'mii-pop-sub'
    sub.textContent = (route === undefined ? '' : route + ' \u00b7 ')
      + (choice === undefined ? t('notEditable') : t(STATE_LABEL[choice]))
    head.appendChild(title)
    head.appendChild(sub)
    pop.appendChild(head)

    if (entry === undefined) {
      pop.appendChild(noteOf(t('notEditable'), 'mii-pop-note'))
    } else {
      for (const option of CHOICES) {
        pop.appendChild(itemOf(t, option, choice, sub, () => {
          deps.applyChoice(route as string, modelId, option).then(() => {
            closePopup()
          }, (cause: unknown) => {
            sub.textContent = t('writeFailed', { message: messageOf(cause) })
            for (const other of Array.from(pop?.querySelectorAll('button') ?? [])) other.disabled = false
          })
        }))
      }
    }
    document.body.appendChild(pop)
    // Right edges aligned with the row button; below when it fits, otherwise
    // flipped above using the popup's actual rendered height.
    place()
  }

  function decorate(): void {
    for (const input of document.querySelectorAll('input[aria-label]')) {
      if (!(input instanceof HTMLInputElement)) continue
      if (input.getAttribute('data-mii-mark') === '1') continue
      if (MODEL_ID_ARIA.test(input.getAttribute('aria-label') ?? '') !== true) continue
      const row = input.parentElement
      if (row === null || row.children.length < 2) continue
      if (sectionOf(input) === null) continue
      input.setAttribute('data-mii-mark', '1')
      // The stock row is a fixed 4-column grid; the class switches it to flex
      // so any number of injected buttons fits (see styles.ts).
      row.classList.add('mii-grid')
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mii-btn'
      btn.dataset.miiIcon = 'off'
      btn.innerHTML = IMG_OFF
      btn.setAttribute('aria-haspopup', 'menu')
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        openPopup(btn)
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
    if (pop !== null && event.target instanceof Node && pop.contains(event.target) === false) closePopup()
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') closePopup()
  }
  // A fixed-position popup would drift from its row as soon as the settings
  // panel scrolls; follow the anchor on any container scroll or window resize.
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
    closePopup()
    for (const btn of Array.from(buttons)) {
      if (btn.isConnected) btn.remove()
      buttons.delete(btn)
    }
    // Marks and row classes outlive the buttons on persistent settings rows:
    // a stale mark makes a remount skip the row forever, so scrub them too.
    for (const input of Array.from(document.querySelectorAll('input[data-mii-mark="1"]'))) {
      input.removeAttribute('data-mii-mark')
      input.parentElement?.classList.remove('mii-grid')
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

/** One picker item with its check glyph; `onPick` runs after the click. */
function itemOf(
  t: TranslateSection,
  option: InputChoice,
  current: InputChoice | undefined,
  sub: HTMLSpanElement,
  onPick: () => void,
): HTMLButtonElement {
  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'mii-pop-item'
  item.innerHTML = CHECK_SVG + '<span></span>'
  const label = item.lastChild
  if (label !== null) label.textContent = t(OPTION_LABEL[option])
  const check = item.firstChild
  if (check instanceof Element && current !== option) check.setAttribute('data-off', '1')
  item.addEventListener('click', () => {
    for (const other of Array.from(item.parentElement?.querySelectorAll('button') ?? [])) other.disabled = true
    sub.textContent = t('writing')
    onPick()
  })
  return item
}

/** A popup note line. */
function noteOf(text: string, className: string): HTMLParagraphElement {
  const note = document.createElement('p')
  note.className = className
  note.textContent = text
  return note
}

/** Re-exported for the apply world's typing convenience. */
export type { ModelEntry }
