// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nProvider } from '../i18n/I18nProvider'
import { SortPicker } from './SortPicker'

function renderPicker(props: Partial<React.ComponentProps<typeof SortPicker>> = {}, locale = 'en'): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <SortPicker sort="taken-desc" onChange={() => {}} {...props} />
    </I18nProvider>
  )
}

describe('SortPicker', () => {
  it('offers the four orderings', () => {
    renderPicker()
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(4)
    expect(options.map((option) => (option as HTMLOptionElement).value)).toEqual([
      'taken-desc',
      'taken-asc',
      'name-asc',
      'name-desc'
    ])
  })

  it('reflects the current mode', () => {
    renderPicker({ sort: 'name-desc' })
    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('name-desc')
  })

  it('emits the chosen mode', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPicker({ onChange })

    await user.selectOptions(screen.getByRole('combobox'), 'taken-asc')
    expect(onChange).toHaveBeenCalledWith('taken-asc')
  })

  it('is labelled for screen readers', () => {
    renderPicker()
    expect(screen.getByRole('combobox', { name: /sort order/i })).toBeInTheDocument()
  })

  it('translates the labels', () => {
    renderPicker({}, 'zh-CN')
    expect(screen.getByRole('option', { name: '最新优先' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '最早优先' })).toBeInTheDocument()
  })

  it('falls back to French labels', () => {
    renderPicker({}, 'fr')
    expect(screen.getByRole('option', { name: 'Plus récentes' })).toBeInTheDocument()
  })
})
