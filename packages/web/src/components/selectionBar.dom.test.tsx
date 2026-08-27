import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { render, startDom, stopDom } from '../test/dom.ts'
import { SelectionBar } from './SelectionBar.tsx'

beforeAll(startDom)
afterAll(stopDom)

const noop = () => {}
const TRASH = { label: 'Move to trash', onClick: noop, icon: 'M5 7h14' }

/**
 * A DOM test rather than an arithmetic one because the thing at risk is what the bar SAYS
 * and whether its buttons are live — neither of which a pure function can be asked about.
 *
 * Select-all is the one selection whose size the reader cannot see. The bar is where they
 * find out that "everything" means ninety thousand photographs rather than the twelve on
 * screen, so a bar that renders a count and a bar that renders one they can read are two
 * different things.
 */
describe('SelectionBar', () => {
  test('states the resolved count in figures a reader can take in', async () => {
    const container = await render(
      <SelectionBar count={12_431} onClear={noop} onSelectAll={noop} actions={[TRASH]} />,
    )
    expect(container.textContent).toContain('12,431 selected')
  })

  test('leaves a small count alone rather than grouping it', async () => {
    const container = await render(
      <SelectionBar count={1} onClear={noop} onSelectAll={noop} actions={[TRASH]} />,
    )
    expect(container.textContent).toContain('1 selected')
    expect(container.textContent).not.toContain('1.000')
  })

  /*
   * The vault is the reason this exists. It cannot say "everything" as a filter, so its
   * select-all can only name the months it happens to be holding — and a button that
   * selects three hundred of two thousand under a header reading two thousand is the same
   * defect as a grid that draws sixty of thirty thousand.
   */
  test('does not offer a select-all that could not select all of them', async () => {
    const container = await render(
      <SelectionBar
        count={3}
        onClear={noop}
        onSelectAll={noop}
        actions={[TRASH]}
        canSelectAll={false}
      />,
    )
    expect([...container.querySelectorAll('button')].map((b) => b.textContent)).not.toContain(
      'Select all',
    )
    // The rest of the bar is untouched: this is a missing button, not a disabled bar.
    expect(container.textContent).toContain('3 selected')
    expect(
      [...container.querySelectorAll('button')].some((b) =>
        b.textContent?.includes('Move to trash'),
      ),
    ).toBe(true)
  })

  /*
   * The server rejects an oversized selection rather than truncating it, so a live button
   * here buys a failed request and a selection the reader thinks they acted on. Saying why
   * and refusing the click is the honest shape.
   */
  test('a selection the server would refuse is explained and cannot be acted on', async () => {
    const container = await render(
      <SelectionBar
        count={1400}
        onClear={noop}
        onSelectAll={noop}
        actions={[TRASH]}
        refusal="Selections are limited to 1,000 photos at a time."
      />,
    )

    expect(container.textContent).toContain('limited to 1,000 photos')
    const action = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Move to trash'),
    )
    expect(action).toBeDefined()
    expect(action?.disabled).toBe(true)
  })

  test('clearing stays available when the selection is refused, since it is the way out', async () => {
    const container = await render(
      <SelectionBar
        count={1400}
        onClear={noop}
        onSelectAll={noop}
        actions={[TRASH]}
        refusal="Selections are limited to 1,000 photos at a time."
      />,
    )

    const clear = container.querySelector<HTMLButtonElement>('[aria-label="Clear selection"]')
    expect(clear).not.toBeNull()
    expect(clear?.disabled).toBe(false)
  })
})
