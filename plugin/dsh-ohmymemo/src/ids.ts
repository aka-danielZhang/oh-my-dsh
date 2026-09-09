/**
 * Opaque sortable identifiers (ULID, Crockford base32) with the store's
 * per-entity prefixes. Hand-rolled on purpose: ULID is 20 lines of encoding
 * and the built bundle must stay dependency-light apart from the YAML parser.
 *
 * Identifiers are stable across migrations; the prefix is part of the id and
 * the filesystem name (one memory = one `mem_<ulid>.md` file).
 * @module dsh-ohmymemo/ids
 */

/** Crockford base32 alphabet (excludes I, L, O, U). */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** ULID body: 26 chars (10 timestamp + 16 randomness). */
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/

/** Monotonic guard: last generated ULID (same-millisecond increments). */
let lastUlid = ''
let lastTime = -1

/**
 * Generate a ULID. Within one process, ids generated in the same millisecond
 * are monotonically incremented (random part + 1), which keeps bursty
 * creation collision-free and creation-ordered.
 */
export function ulid(now = Date.now()): string {
  let timePart = ''
  let time = now
  for (let i = 0; i < 10; i++) {
    timePart = ENCODING[time % 32] + timePart
    time = Math.floor(time / 32)
  }
  let randomPart: string
  if (now === lastTime && lastUlid !== '') {
    randomPart = incrementBase32(lastUlid.slice(10))
  } else {
    let chars = ''
    for (let i = 0; i < 16; i++) chars += ENCODING[Math.floor(Math.random() * 32)]
    randomPart = chars
  }
  const id = timePart + randomPart
  lastUlid = id
  lastTime = now
  return id
}

/** Add one to a Crockford base32 string (wrap-around saturates at all-Z). */
function incrementBase32(value: string): string {
  const chars = value.split('')
  let carry = 1
  for (let i = chars.length - 1; i >= 0 && carry > 0; i--) {
    const digit = ENCODING.indexOf(chars[i])
    if (digit === -1) break
    const next = digit + carry
    chars[i] = ENCODING[next % 32]
    carry = Math.floor(next / 32)
  }
  return chars.join('')
}

/** Memory record id: `mem_<ulid>`. */
export const MEM_ID_RE = /^mem_[0-9A-HJKMNP-TV-Z]{26}$/
/** Workspace scope id: `ws_<ulid>`. */
export const WS_ID_RE = /^ws_[0-9A-HJKMNP-TV-Z]{26}$/
/** Tombstone id: `tomb_<ulid>`. */
export const TOMB_ID_RE = /^tomb_[0-9A-HJKMNP-TV-Z]{26}$/
/** Transaction marker id: `txn_<ulid>`. */
export const TXN_ID_RE = /^txn_[0-9A-HJKMNP-TV-Z]{26}$/
/** Store identity id: `oms_<ulid>`. */
export const STORE_ID_RE = /^oms_[0-9A-HJKMNP-TV-Z]{26}$/

export function newMemoryId(now?: number): string {
  return `mem_${ulid(now)}`
}

export function newScopeId(now?: number): string {
  return `ws_${ulid(now)}`
}

export function newTombstoneId(now?: number): string {
  return `tomb_${ulid(now)}`
}

export function newTransactionId(now?: number): string {
  return `txn_${ulid(now)}`
}

export function newStoreId(now?: number): string {
  return `oms_${ulid(now)}`
}

/** Validate a ULID body (used by id validators below). */
export function isUlidBody(value: string): boolean {
  return ULID_RE.test(value)
}
