/**
 * Composer-identical controls for the scheduled-task editor.
 *
 * Geometry and material are copied from the shipped conversation composer so
 * the page reads as the same surface:
 * - `Chip` = the permission/model trigger (`PermissionSelect.module.css`
 *   `.trigger` / `ModelSelect.module.css` `.trigger`): 28px tall, 24px radius,
 *   `0 4px 0 8px`, 13/20 medium secondary, 14px caption chevron.
 * - `MenuCard` = the shared dropdown card (`ui-primitives` Menu.module.css and
 *   ModelSelect's own card): r20, `--dsw-specific-menu`,
 *   `--dsw-elevation-prominent`, 4px inset, 40px rows with an r10 cell.
 * - `WorkspaceChip` = the hero workspace chip (`HeroShell.module.css`
 *   `.workspace`): r16, `0 8px`, label-primary, 16px folder + 12px chevron, and
 *   the hero picker's directory menu (folder rows, trailing check, 0.5px l2
 *   divider above the pinned add row).
 *
 * The permission shield glyphs are the composer's own three-variant set
 * (check / pencil / exclamation), inlined because they are not exported by
 * ui-primitives.
 * @module dsh-scheduled-tasks/client/chips
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconChevronDownOutline14,
  IconCheckOutline16,
  IconFolderOpenOutline16,
  IconPlusOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'

/** One selectable row of a dropdown. */
export interface ChipOption {
  value: string
  label: string
  icon?: ReactNode
}

/** Close on the next outside mousedown or Escape. */
export function useDismiss(open: boolean, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined
    const onDown = (): void => { close() }
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, close])
}

/** Keep a trigger subtree's mousedown from reaching the dismiss listener. */
const swallow = (event: { stopPropagation: () => void }): void => { event.stopPropagation() }

/** Dropdown card: r20 menu surface, 4px inset, optional pinned footer. */
export function MenuCard({ align, wide, footer, children }: {
  align?: 'left' | 'right'
  wide?: boolean
  footer?: ReactNode
  children: ReactNode
}): ReactNode {
  return (
    <div
      className={`dsh-stask-menu${align === 'right' ? ' dsh-stask-menu-right' : ''}${wide === true ? ' dsh-stask-menu-wide' : ''}`}
      role="menu"
      onMouseDown={swallow}
      onClick={swallow}
    >
      <div className="dsh-stask-menu-scroll">{children}</div>
      {footer === undefined ? null : <div className="dsh-stask-menu-footer">{footer}</div>}
    </div>
  )
}

/** One 40px menu row: optional 16px leading icon, label, optional trailing check.
 *  Exported for composition (the task card's ⋯ menu reuses this row). */
export function MenuItem({ label, icon, active, disabled, danger, onPick }: {
  label: string
  icon?: ReactNode
  active?: boolean
  disabled?: boolean
  danger?: boolean
  onPick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      title={label}
      disabled={disabled === true}
      className={`dsh-stask-menu-item${danger === true ? ' dsh-stask-menu-item-danger' : ''}`}
      onMouseDown={swallow}
      onClick={onPick}
    >
      {icon === undefined ? null : <span className="dsh-stask-menu-item-icon">{icon}</span>}
      <span className="dsh-stask-menu-item-label">{label}</span>
      {active === true ? <span className="dsh-stask-menu-item-check"><IconCheckOutline16 size={16} /></span> : null}
    </button>
  )
}



/** Composer chip with a single-level menu (permission, and any flat list). */
export function Chip({ value, options, icon, align, title, placeholder, onChange }: {
  value: string
  options: readonly ChipOption[]
  icon?: ReactNode
  align?: 'left' | 'right'
  title?: string
  placeholder?: string
  onChange: (value: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  useDismiss(open, () => { setOpen(false) })
  const current = options.find(option => option.value === value)
  const label = current?.label ?? placeholder ?? ''
  return (
    <div className="dsh-stask-chipwrap">
      <button
        type="button"
        className="dsh-stask-chip"
        title={title ?? label}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={swallow}
        onClick={() => { setOpen(!open) }}
      >
        {icon === undefined ? null : <span className="dsh-stask-chip-icon">{icon}</span>}
        <span className="dsh-stask-chip-label">{label}</span>
        <span
          className={`dsh-stask-chip-caret${open ? ' dsh-stask-chip-open' : ''}`}
          aria-hidden="true"
        >
          <IconChevronDownOutline14 size={14} />
        </span>
      </button>
      {open
        ? (
          <MenuCard {...align === undefined ? {} : { align }}>
            {options.map(option => (
              <MenuItem
                key={option.value}
                label={option.label}
                {...option.icon === undefined ? {} : { icon: option.icon }}
                active={option.value === value}
                onPick={() => { setOpen(false); onChange(option.value) }}
              />
            ))}
          </MenuCard>
        )
        : null}
    </div>
  )
}

/** Hero-style workspace chip plus the picker's directory menu. */
export function WorkspaceChip({ value, options, emptyLabel, chooseLabel, addLabel, disabled, disabledTitle, onAdd, onChange }: {
  value: string
  options: readonly ChipOption[]
  emptyLabel: string
  chooseLabel: string
  addLabel: string
  /** The workspace is bound to the task's session; locked on edit. */
  disabled?: boolean
  disabledTitle?: string
  onAdd: () => void
  onChange: (value: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  useDismiss(open, () => { setOpen(false) })
  const current = options.find(option => option.value === value)
  const label = current?.label ?? chooseLabel
  return (
    <div className="dsh-stask-chipwrap">
      <button
        type="button"
        className={`dsh-stask-ws${open ? ' dsh-stask-ws-open' : ''}`}
        title={disabled === true ? disabledTitle ?? label : label}
        aria-label={disabled === true ? disabledTitle ?? label : label}
        aria-haspopup={disabled === true ? undefined : 'menu'}
        aria-expanded={disabled === true ? undefined : open}
        disabled={disabled === true}
        onMouseDown={swallow}
        onClick={() => { if (disabled !== true) setOpen(!open) }}
      >
        <span className="dsh-stask-ws-folder"><IconFolderOpenOutline16 size={16} /></span>
        <span className="dsh-stask-ws-label">{label}</span>
        <span
          className={`dsh-stask-chip-caret${open ? ' dsh-stask-chip-open' : ''}`}
          aria-hidden="true"
        >
          <IconChevronDownOutline14 size={12} />
        </span>
      </button>
      {open
        ? (
          <MenuCard
            footer={(
              <MenuItem
                label={addLabel}
                icon={<IconPlusOutline16 size={16} />}
                onPick={() => { setOpen(false); onAdd() }}
              />
            )}
          >
            {options.length === 0
              ? <div className="dsh-stask-menu-empty">{emptyLabel}</div>
              : options.map(option => (
                <MenuItem
                  key={option.value}
                  label={option.label}
                  icon={<IconFolderOpenOutline16 size={16} />}
                  active={option.value === value}
                  onPick={() => { setOpen(false); onChange(option.value) }}
                />
              ))}
          </MenuCard>
        )
        : null}
    </div>
  )
}

/** Model option offered by the catalog (one provider route). */
export interface ModelChoice {
  provider: string
  providerName: string
  model: string
  efforts: readonly string[]
}

/**
 * Model chip with the composer's two-level menu: a root pane offering 模型 /
 * 推理等级, each drilling into its own list. The trigger shows
 * `model · effort`, exactly like the composer's model seat.
 */
export function ModelChip({ value, effort, models, defaultModel, labels, effortLabel, onChange }: {
  value: string
  effort: string
  models: readonly ModelChoice[]
  defaultModel: { provider: string, model: string } | null
  labels: { model: string, effort: string, follow: string, followWith: string, defaultEffort: string }
  effortLabel: (id: string) => string
  onChange: (value: string, effort: string) => void
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [pane, setPane] = useState<'root' | 'model' | 'effort'>('root')
  useDismiss(open, () => { setOpen(false) })
  const defaultChoice = defaultModel === null
    ? null
    : models.find(model => model.provider === defaultModel.provider && model.model === defaultModel.model) ?? null
  const isDefault = value === 'default'
  const current = isDefault ? defaultChoice : models.find(model => `${model.provider}/${model.model}` === value) ?? null
  const efforts = current?.efforts ?? []
  const explicit = effort !== 'default'
  const effortText = explicit ? effortLabel(effort) : efforts.length > 0 ? labels.defaultEffort : null
  const modelText = current?.model ?? (isDefault ? labels.follow : value)
  const modelOptions: ChipOption[] = [
    {
      value: 'default',
      label: defaultChoice === null ? labels.follow : labels.followWith.replace('{model}', defaultChoice.model),
    },
    ...models.map(model => ({ value: `${model.provider}/${model.model}`, label: `${model.providerName} / ${model.model}` })),
  ]
  const effortOptions: ChipOption[] = [
    { value: 'default', label: labels.defaultEffort },
    ...efforts.map(id => ({ value: id, label: effortLabel(id) })),
  ]
  const cell = (key: string, label: string, cellValue: string, onPick: () => void): ReactNode => (
    <button
      key={key}
      type="button"
      role="menuitem"
      className="dsh-stask-menu-cell"
      onMouseDown={swallow}
      onClick={onPick}
    >
      <span className="dsh-stask-menu-cell-label">{label}</span>
      <span className="dsh-stask-menu-cell-value">{cellValue}</span>
      <span className="dsh-stask-menu-cell-chevron" aria-hidden="true"><IconChevronDownOutline14 size={14} /></span>
    </button>
  )
  const option = (item: ChipOption, active: boolean, onPick: () => void): ReactNode => (
    <button
      key={item.value}
      type="button"
      role="menuitemradio"
      aria-checked={active}
      className={`dsh-stask-menu-option${active ? ' dsh-stask-menu-active' : ''}`}
      onMouseDown={swallow}
      onClick={onPick}
    >
      <span className="dsh-stask-menu-item-label">{item.label}</span>
      {active ? <span className="dsh-stask-menu-item-check"><IconCheckOutline16 size={16} /></span> : null}
    </button>
  )
  return (
    <div className="dsh-stask-chipwrap">
      <button
        type="button"
        className="dsh-stask-chip"
        title={effortText === null ? modelText : `${modelText} · ${effortText}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onMouseDown={swallow}
        onClick={() => {
          if (open) { setOpen(false); return }
          setPane('root')
          setOpen(true)
        }}
      >
        <span className="dsh-stask-chip-label">{modelText}</span>
        {effortText === null ? null : <span className="dsh-stask-chip-effort">{effortText}</span>}
        <span
          className={`dsh-stask-chip-caret${open ? ' dsh-stask-chip-open' : ''}`}
          aria-hidden="true"
        >
          <IconChevronDownOutline14 size={14} />
        </span>
      </button>
      {open
        ? (
          <MenuCard align="right" wide>
            {pane === 'root'
              ? [
                  cell('model', labels.model, modelText, () => { setPane('model') }),
                  ...efforts.length === 0
                    ? []
                    : [cell('effort', labels.effort, effortText ?? labels.defaultEffort, () => { setPane('effort') })],
                ]
              : pane === 'model'
                ? modelOptions.map(item => option(
                    item,
                    isDefault ? item.value === 'default' : item.value === value,
                    () => { setOpen(false); onChange(item.value, 'default') },
                  ))
                : effortOptions.map(item => option(
                    item,
                    (explicit ? effort : 'default') === item.value,
                    () => { setOpen(false); onChange(value, item.value) },
                  ))}
          </MenuCard>
        )
        : null}
    </div>
  )
}

/** Shield glyphs of the composer's permission set, keyed by preset name. */
const SHIELD_OUTLINE = 'M8.20554 0.899994L14.7901 3.36857V7.01026C14.7901 12 11.0466 14.2103 8.20554 15.3C5.36446 14.2103 1.62012 12 1.62012 7.01026V3.36857L8.20554 0.899994Z'

const SHIELD_INNER: Record<string, readonly string[]> = {
  'read-only': [
    'M12.1654 5.7552L8.9447 9.41475C8.73044 9.65816 8.53628 9.8804 8.35774 10.0423C8.1713 10.2114 7.94235 10.3717 7.64016 10.4254C7.48207 10.4535 7.32 10.4552 7.16151 10.4294C6.85843 10.3801 6.62728 10.2223 6.43836 10.0559C6.25752 9.89653 6.06037 9.67732 5.84264 9.43705L4.72925 8.20897L5.63557 7.38707L6.74897 8.61594C6.98603 8.87755 7.12974 9.03533 7.24673 9.13839C7.31033 9.19443 7.34485 9.21476 7.35823 9.22122C7.38068 9.22484 7.40352 9.22515 7.42593 9.22122C7.40522 9.22502 7.42893 9.23294 7.53583 9.136C7.65132 9.03126 7.79316 8.87139 8.02643 8.60638L11.2479 4.94763L12.1654 5.7552Z',
  ],
  'workspace-write': [
    'M8.08887 0.251709C8.20479 0.23085 8.32486 0.241168 8.43652 0.282959L15.0215 2.75171C15.2787 2.84819 15.4492 3.09414 15.4492 3.3689V7.0105C15.4492 7.10986 15.4441 7.2081 15.4414 7.30542C15.0285 7.07175 14.5905 6.87695 14.1309 6.73022V3.82495L8.20508 1.60327L2.2793 3.82495V7.0105C2.27936 9.7171 3.4745 11.5379 5.02734 12.7947C5.01025 12.9942 5 13.1962 5 13.4001C5.00001 13.7617 5.02722 14.1169 5.08008 14.4636C2.91555 13.0393 0.961014 10.752 0.960938 7.0105V3.3689C0.960938 3.09417 1.13146 2.84821 1.38867 2.75171L7.97461 0.282959L8.08887 0.251709Z',
    'M11.3525 5.64688V6.85688H5V5.64688H11.3525Z',
    'M9.5824 8.29376V9.50376H5V8.29376H9.5824Z',
    'M14.6647 15.6852H10.0338C10.3878 15.3751 10.7567 15.0517 11.0772 14.7706C11.2531 14.6164 11.4144 14.4746 11.5511 14.3547H14.6647V15.6852Z',
    'M8.14852 14.1308L7.33925 15.4976C7.22458 15.6912 7.42245 15.9194 7.63037 15.8333L9.09785 15.2254L15.0399 10.0719L14.0905 8.97733L8.14852 14.1308Z',
  ],
  'danger-full-access': [
    'M9.10094 4.5V8.75939H7.59888V4.5H9.10094Z',
    'M9.10094 9.8114V11.5H7.59888V9.8114H9.10094Z',
  ],
}

/** Shield glyph for one permission preset; host-configured names get the outline only. */
export function PermissionGlyph({ name }: { name: string }): ReactNode {
  const inner = SHIELD_INNER[name] ?? []
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={SHIELD_OUTLINE} stroke="currentColor" strokeWidth="1.31831" strokeLinejoin="round" fill="none" />
      {inner.map(path => <path key={path} d={path} fill="currentColor" />)}
    </svg>
  )
}

/** Auto-growing instruction box (36px floor, 340px cap, no resizer). */
export function InstructionText({ id, value, placeholder, onChange }: {
  id: string
  value: string
  placeholder: string
  onChange: (value: string) => void
}): ReactNode {
  const ref = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${String(Math.min(340, Math.max(36, element.scrollHeight)))}px`
  }, [value])
  return (
    <textarea
      id={id}
      ref={ref}
      className="dsh-stask-instr-text"
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      onChange={event => { onChange(event.target.value) }}
    />
  )
}
