import { describe, expect, test } from 'bun:test'
import {
  EXCEPTION_LIMIT,
  EXPLICIT_ID_LIMIT,
  extendIn,
  isSelectedIn,
  resolvedCount,
  type Selection,
  selectionRefusal,
  toggleIn,
  toRequest,
} from './useSelection.ts'

describe('toRequest', () => {
  test('an id selection sends its ids', () => {
    const selection: Selection = { kind: 'ids', ids: new Set(['a', 'b']) }
    expect(toRequest(selection, { favorite: true })).toEqual({ assetIds: ['a', 'b'] })
  })

  test('select-all sends the filter and what was unticked', () => {
    const selection: Selection = { kind: 'all', except: new Set(['a']) }
    expect(toRequest(selection, { favorite: true })).toEqual({
      query: { favorite: true },
      except: ['a'],
    })
  })

  test('select-all with nothing unticked sends an empty exclusion, not an absent one', () => {
    expect(toRequest({ kind: 'all', except: new Set() }, {})).toEqual({ query: {}, except: [] })
  })

  test('an id selection never carries the filter, which the server would refuse', () => {
    const request = toRequest({ kind: 'ids', ids: new Set(['a']) }, { albumId: 'x' })
    expect('query' in request).toBe(false)
    expect('except' in request).toBe(false)
  })
})

describe('toggleIn', () => {
  test('unticking inside select-all adds to the exclusion set', () => {
    expect(toggleIn({ kind: 'all', except: new Set() }, 'a')).toEqual({
      kind: 'all',
      except: new Set(['a']),
    })
  })

  test('re-ticking removes it again', () => {
    expect(toggleIn({ kind: 'all', except: new Set(['a']) }, 'a')).toEqual({
      kind: 'all',
      except: new Set(),
    })
  })

  test('an id selection ticks and unticks the id itself', () => {
    expect(toggleIn({ kind: 'ids', ids: new Set() }, 'a')).toEqual({
      kind: 'ids',
      ids: new Set(['a']),
    })
    expect(toggleIn({ kind: 'ids', ids: new Set(['a', 'b']) }, 'a')).toEqual({
      kind: 'ids',
      ids: new Set(['b']),
    })
  })

  test('leaves the selection it was given alone', () => {
    const before: Selection = { kind: 'ids', ids: new Set(['a']) }
    toggleIn(before, 'b')
    expect(before.kind === 'ids' && before.ids).toEqual(new Set(['a']))
  })
})

describe('extendIn', () => {
  test('a shift-run ticks the whole run', () => {
    expect(extendIn({ kind: 'ids', ids: new Set(['a']) }, ['a', 'b', 'c'])).toEqual({
      kind: 'ids',
      ids: new Set(['a', 'b', 'c']),
    })
  })

  /*
   * Under select-all a plain click UNTICKS, so shift-extending that same gesture has to
   * untick the run too. Extending a click that removed a photograph by adding photographs
   * would be the modifier reversing the action it is modifying.
   */
  test('a shift-run inside select-all unticks the whole run', () => {
    expect(extendIn({ kind: 'all', except: new Set(['a']) }, ['a', 'b', 'c'])).toEqual({
      kind: 'all',
      except: new Set(['a', 'b', 'c']),
    })
  })
})

describe('isSelectedIn', () => {
  test('an id selection holds what it lists', () => {
    expect(isSelectedIn({ kind: 'ids', ids: new Set(['a']) }, 'a')).toBe(true)
    expect(isSelectedIn({ kind: 'ids', ids: new Set(['a']) }, 'b')).toBe(false)
  })

  test('select-all holds everything it does not except', () => {
    expect(isSelectedIn({ kind: 'all', except: new Set(['a']) }, 'b')).toBe(true)
    expect(isSelectedIn({ kind: 'all', except: new Set(['a']) }, 'a')).toBe(false)
  })
})

describe('resolvedCount', () => {
  test('an id selection counts its ids and ignores the total', () => {
    expect(resolvedCount({ kind: 'ids', ids: new Set(['a', 'b']) }, 90_000)).toBe(2)
  })

  test('select-all is the whole filter less what was unticked', () => {
    expect(resolvedCount({ kind: 'all', except: new Set(['a', 'b']) }, 12_433)).toBe(12_431)
  })

  /*
   * The exclusion set is client state and the total comes from the spine, so a mutation
   * landing between the two can make the subtraction go negative. A confirmation saying
   * "-3 photos" is worse than one saying "0".
   */
  test('never goes below zero when the spine has moved under the exclusions', () => {
    expect(resolvedCount({ kind: 'all', except: new Set(['a', 'b', 'c']) }, 1)).toBe(0)
  })
})

describe('selectionRefusal', () => {
  test('says nothing about a selection the server will take', () => {
    expect(selectionRefusal({ kind: 'ids', ids: setOf(EXPLICIT_ID_LIMIT) })).toBeNull()
    expect(selectionRefusal({ kind: 'all', except: setOf(EXCEPTION_LIMIT) })).toBeNull()
  })

  /*
   * The server rejects rather than truncating, and truncating here instead would be the
   * worse of the two: a bulk trash that silently spared four hundred photographs is a bug
   * nobody notices until they go looking for them.
   */
  test('refuses an id list past the thousand the server accepts', () => {
    const refusal = selectionRefusal({ kind: 'ids', ids: setOf(EXPLICIT_ID_LIMIT + 1) })
    expect(refusal).toContain('1,000')
    expect(refusal).toContain('Select all')
  })

  test('refuses more unticked photographs than the server will carry', () => {
    expect(selectionRefusal({ kind: 'all', except: setOf(EXCEPTION_LIMIT + 1) })).toContain(
      '10,000',
    )
  })
})

function setOf(size: number): Set<string> {
  return new Set(Array.from({ length: size }, (_, index) => `id-${index}`))
}
