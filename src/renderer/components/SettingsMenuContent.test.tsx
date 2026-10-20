// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_RING_SIZE, RING_SIZE_RANGE } from '@shared/types'
import { I18nProvider } from '../i18n/I18nProvider'
import { SettingsMenuContent } from './SettingsMenuContent'

function renderContent(
  props: Partial<React.ComponentProps<typeof SettingsMenuContent>> = {},
  locale = 'en'
): ReturnType<typeof render> {
  // Defaults first, overrides after: `Partial` makes every prop optional, so
  // spreading first would let `undefined` overwrite a required value.
  const merged = {
    onDone: () => {},
    onAbout: () => {},
    recursive: false,
    onRecursiveChange: () => {},
    ringSize: DEFAULT_RING_SIZE,
    onRingSizeChange: () => {},
    cacheBudgetMb: 0,
    onCacheBudgetChange: () => {},
    ...props
  }
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <SettingsMenuContent {...merged} />
    </I18nProvider>
  )
}

describe('SettingsMenuContent', () => {
  it('offers the language picker', () => {
    renderContent()
    expect(screen.getByLabelText('Language')).toBeInTheDocument()
    expect(screen.getAllByRole('option').length).toBeGreaterThan(1)
  })

  it('marks the language picker so it can be told apart from the other selects', () => {
    // The gear menu now holds two select boxes. A class is what lets the
    // end-to-end tests address the language one without depending on translated
    // accessible names.
    renderContent()
    expect(screen.getByLabelText('Language')).toHaveClass('settings-language')
  })

  it('reflects the active language', () => {
    renderContent({}, 'fr')
    expect((screen.getByLabelText(/langue/i) as HTMLSelectElement).value).toBe('fr')
  })

  it('reports that the change is done so the menu can close', async () => {
    const user = userEvent.setup()
    const onDone = vi.fn()
    renderContent({ onDone })

    await user.selectOptions(screen.getByLabelText('Language'), 'zh-CN')
    expect(onDone).toHaveBeenCalledTimes(1)
  })

  it('labels the field in the active language', () => {
    renderContent({}, 'zh-CN')
    // The row heading, not just the select's accessible name.
    expect(screen.getByText('语言')).toBeInTheDocument()
  })

  it('offers the subfolder toggle, off by default', () => {
    renderContent()
    expect(screen.getByRole('checkbox', { name: /subfolders/i })).not.toBeChecked()
  })

  it('reflects an enabled subfolder setting', () => {
    renderContent({ recursive: true })
    expect(screen.getByRole('checkbox', { name: /subfolders/i })).toBeChecked()
  })

  it('reports the new subfolder value', async () => {
    const user = userEvent.setup()
    const onRecursiveChange = vi.fn()
    renderContent({ onRecursiveChange })

    await user.click(screen.getByRole('checkbox', { name: /subfolders/i }))
    expect(onRecursiveChange).toHaveBeenCalledWith(true)
  })

  it('does not close the menu when the subfolder toggle changes', async () => {
    // The re-scan is visible behind the panel, so the user can turn it on, watch
    // the count change, and turn it back off. Closing after one click would make
    // that impossible.
    const user = userEvent.setup()
    const onDone = vi.fn()
    renderContent({ onDone })

    await user.click(screen.getByRole('checkbox', { name: /subfolders/i }))
    expect(onDone).not.toHaveBeenCalled()
  })

  it('translates the subfolder label', () => {
    renderContent({}, 'zh-CN')
    expect(screen.getByRole('checkbox', { name: '包含子文件夹中的照片' })).toBeInTheDocument()
  })

  describe('ring size', () => {
    it('offers a slider bounded to the supported range', () => {
      renderContent()
      const slider = screen.getByRole('slider', { name: /around the centre/i })
      expect(slider).toHaveAttribute('min', String(RING_SIZE_RANGE.min))
      expect(slider).toHaveAttribute('max', String(RING_SIZE_RANGE.max))
    })

    it('shows the current value as a number', () => {
      // A thumb's position alone cannot be read as a value.
      renderContent({ ringSize: 55 })
      expect(screen.getByText('55')).toBeInTheDocument()
      expect((screen.getByRole('slider', { name: /around the centre/i }) as HTMLInputElement).value).toBe('55')
    })

    it('reports changes with a number, not the string the input carries', () => {
      // `event.target.value` is a string; the reducer clamps a number.
      const onRingSizeChange = vi.fn()
      renderContent({ ringSize: 70, onRingSizeChange })
      const slider = screen.getByRole('slider', { name: /around the centre/i })
      fireEvent.change(slider, { target: { value: '45' } })
      expect(onRingSizeChange).toHaveBeenCalledWith(45)
    })

    it('does not close the menu when the value changes', async () => {
      // Same reasoning as the subfolder toggle: the show is behind the panel, so
      // the control has to stay open while the user judges the result.
      const onDone = vi.fn()
      renderContent({ onDone })
      fireEvent.change(screen.getByRole('slider', { name: /around the centre/i }), {
        target: { value: '40' }
      })
      expect(onDone).not.toHaveBeenCalled()
    })

    it('translates the label', () => {
      renderContent({}, 'zh-CN')
      expect(screen.getByText('随机播放中环绕居中的照片数')).toBeInTheDocument()
    })
  })

  describe('thumbnail cache', () => {
    it('offers a budget selector with an unlimited default', () => {
      renderContent()
      const select = screen.getByLabelText('Thumbnail cache limit') as HTMLSelectElement
      expect(select.value).toBe('0')
      expect(screen.getByRole('option', { name: 'No limit' })).toBeInTheDocument()
      expect(screen.getByRole('option', { name: '2 GB' })).toBeInTheDocument()
    })

    it('reports the chosen limit in megabytes', () => {
      const onCacheBudgetChange = vi.fn()
      renderContent({ cacheBudgetMb: 0, onCacheBudgetChange })
      fireEvent.change(screen.getByLabelText('Thumbnail cache limit'), { target: { value: '4096' } })
      expect(onCacheBudgetChange).toHaveBeenCalledWith(4096)
    })

    it('keeps a hand-edited value selectable instead of showing the first option', () => {
      // 3000 MB is not a preset. Without a synthetic option the control would
      // display "No limit" while the stored value says otherwise.
      renderContent({ cacheBudgetMb: 3000 })
      const select = screen.getByLabelText('Thumbnail cache limit') as HTMLSelectElement
      expect(select.value).toBe('3000')
      expect(screen.getByRole('option', { name: '2.9 GB' })).toBeInTheDocument()
    })

    it('shows the size the main process reports', async () => {
      const stats = vi.spyOn(window.photoStream, 'cacheStats').mockResolvedValue({
        bytes: 1.5 * 1024 * 1024 * 1024,
        files: 4000,
        ready: true
      })
      renderContent()
      expect(await screen.findByText('Using 1.5 GB')).toBeInTheDocument()
      stats.mockRestore()
    })

    it('says it is calculating rather than showing a misleading zero', async () => {
      // The startup sweep runs ten seconds in; before that the total is unknown,
      // not zero.
      const stats = vi.spyOn(window.photoStream, 'cacheStats').mockResolvedValue({
        bytes: 0,
        files: 0,
        ready: false
      })
      renderContent()
      expect(await screen.findByText('Calculating…')).toBeInTheDocument()
      stats.mockRestore()
    })

    it('warns that unlimited means unbounded growth', () => {
      renderContent({ cacheBudgetMb: 0 })
      expect(screen.getByText(/the cache keeps growing/i)).toBeInTheDocument()
    })

    it('drops the warning once a limit is set', () => {
      renderContent({ cacheBudgetMb: 2048 })
      expect(screen.queryByText(/the cache keeps growing/i)).toBeNull()
    })

    it('translates the labels', () => {
      renderContent({ cacheBudgetMb: 0 }, 'zh-CN')
      expect(screen.getByText('缩略图缓存上限')).toBeInTheDocument()
      expect(screen.getByRole('option', { name: '不限制' })).toBeInTheDocument()
    })
  })
})
