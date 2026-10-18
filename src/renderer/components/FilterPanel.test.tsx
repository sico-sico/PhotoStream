// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Photo } from '@shared/types'
import { I18nProvider } from '../i18n/I18nProvider'
import { FilterPanel } from './FilterPanel'

const photos: Photo[] = [
  { id: 'a', path: '/a.jpg', name: '2019 Kyoto.jpg', width: 1, height: 1, takenAt: '2019-07-14', dateSource: 'exif', mtimeMs: 0, sizeBytes: 0 },
  { id: 'b', path: '/b.jpg', name: '2024 Paris.jpg', width: 1, height: 1, takenAt: '2024-03-11', dateSource: 'exif', mtimeMs: 0, sizeBytes: 0 }
]

const EMPTY = { from: '', to: '', text: '' }

function renderPanel(props: Partial<React.ComponentProps<typeof FilterPanel>> = {}, locale = 'en'): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <FilterPanel
        filters={EMPTY}
        photos={photos}
        visibleCount={2}
        onChange={() => {}}
        onReset={() => {}}
        {...props}
      />
    </I18nProvider>
  )
}

describe('FilterPanel', () => {
  it('shows the visible and total counts', () => {
    renderPanel({ visibleCount: 1 })
    expect(screen.getByText(/1 of 2 photos/)).toBeInTheDocument()
  })

  it('hints the date range present in the folder', () => {
    renderPanel()
    expect(screen.getByText(/2019-07-14 → 2024-03-11/)).toBeInTheDocument()
  })

  it('bounds the date inputs to the available range', () => {
    renderPanel()
    const from = screen.getByLabelText('Date from') as HTMLInputElement
    expect(from.min).toBe('2019-07-14')
    expect(from.max).toBe('2024-03-11')
  })

  it('emits a changed start date', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPanel({ onChange })

    const from = screen.getByLabelText('Date from') as HTMLInputElement
    await user.clear(from)
    await user.type(from, '2020-01-01')

    expect(onChange).toHaveBeenCalled()
    const last = onChange.mock.calls.at(-1)![0]
    expect(last).toHaveProperty('from')
  })

  it('emits a changed file-name search', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    renderPanel({ onChange })

    await user.type(screen.getByLabelText('File name'), 'k')
    expect(onChange).toHaveBeenCalled()
    expect(onChange.mock.calls.at(-1)![0].text).toBe('k')
  })

  it('marks the panel as filtered when any bound is set', () => {
    renderPanel({ filters: { ...EMPTY, text: 'kyoto' } })
    expect(screen.getByText(/filtered/)).toBeInTheDocument()
  })

  it('does not mark unfiltered state', () => {
    renderPanel()
    expect(screen.queryByText(/filtered/)).toBeNull()
  })

  it('disables reset when nothing is filtered', () => {
    renderPanel()
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled()
  })

  it('enables reset and calls it when filters are active', async () => {
    const user = userEvent.setup()
    const onReset = vi.fn()
    renderPanel({ filters: { ...EMPTY, text: 'x' }, onReset })

    const button = screen.getByRole('button', { name: 'Reset' })
    expect(button).toBeEnabled()
    await user.click(button)
    expect(onReset).toHaveBeenCalledTimes(1)
  })

  it('omits the range hint when nothing is dated', () => {
    renderPanel({ photos: [{ ...photos[0], takenAt: '', dateSource: 'none' }] })
    expect(screen.queryByText(/→/)).toBeNull()
  })

  it('localises the panel', () => {
    renderPanel({ filters: { ...EMPTY, text: 'x' } }, 'zh-CN')
    expect(screen.getByLabelText('开始日期')).toBeInTheDocument()
    expect(screen.getByLabelText('文件名')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '重置' })).toBeInTheDocument()
    expect(screen.getByText(/\/ 2 张照片/)).toBeInTheDocument()
    expect(screen.getByText(/已筛选/)).toBeInTheDocument()
  })

  it('is exposed as a labelled region', () => {
    renderPanel({}, 'fr')
    expect(screen.getByRole('region', { name: 'Filtres' })).toBeInTheDocument()
  })
})
