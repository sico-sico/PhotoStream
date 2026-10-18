// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Photo } from '@shared/types'
import { I18nProvider } from '../i18n/I18nProvider'
import { InfoPanel } from './InfoPanel'

const photo: Photo = {
  id: 'p1',
  path: '/photos/kyoto.jpg',
  name: 'kyoto.jpg',
  width: 6000,
  height: 4000,
  takenAt: '2019-07-14',
  dateSource: 'exif',
  mtimeMs: 0,
  sizeBytes: 0
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof InfoPanel>> = {},
  locale = 'en'
): ReturnType<typeof render> {
  return render(
    <I18nProvider preference={locale} systemLocales={[]} onLocaleChange={() => {}}>
      <InfoPanel photo={photo} exif={{}} onClose={() => {}} {...props} />
    </I18nProvider>
  )
}

describe('InfoPanel', () => {
  it('shows a loading state while the read is in flight', () => {
    // `null` means "not read yet"; the panel must not claim the photo has no
    // details before it has looked.
    renderPanel({ exif: null })
    expect(screen.getByText(/reading details/i)).toBeInTheDocument()
    expect(screen.queryByText('a.jpg')).toBeNull()
  })

  it('always shows the file section', () => {
    renderPanel()
    expect(screen.getByText('kyoto.jpg')).toBeInTheDocument()
    expect(screen.getByText('6000 × 4000')).toBeInTheDocument()
  })

  it('renders the camera and exposure groups when present', () => {
    renderPanel({ exif: { make: 'SONY', model: 'ILCE-7M5', fNumber: 1.8, iso: 400 } })
    expect(screen.getByRole('heading', { name: 'Camera' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Exposure' })).toBeInTheDocument()
    expect(screen.getByText('SONY ILCE-7M5')).toBeInTheDocument()
    expect(screen.getByText('f/1.8')).toBeInTheDocument()
  })

  it('omits the location group when there is no GPS', () => {
    renderPanel({ exif: { make: 'SONY' } })
    expect(screen.queryByRole('heading', { name: 'Location' })).toBeNull()
  })

  it('translates message-key values such as the flash state', () => {
    renderPanel({ exif: { flash: true } })
    expect(screen.getByText('Fired')).toBeInTheDocument()
  })

  it('leaves data values untranslated', () => {
    // A lens name is data: "FE 24-70mm F2.8 GM II" must never be localised.
    renderPanel({ exif: { lens: 'FE 24-70mm F2.8 GM II' } })
    expect(screen.getByText('FE 24-70mm F2.8 GM II')).toBeInTheDocument()
  })

  it('reports the close action', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    renderPanel({ onClose })

    await user.click(screen.getByRole('button', { name: /hide details/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('localises the headings and labels', () => {
    renderPanel({ exif: { make: 'SONY', fNumber: 2 } }, 'zh-CN')
    expect(screen.getByRole('heading', { name: '相机' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: '曝光' })).toBeInTheDocument()
    expect(screen.getByText('光圈')).toBeInTheDocument()
  })

  it('renders in French', () => {
    renderPanel({ exif: { make: 'SONY' } }, 'fr')
    expect(screen.getByRole('heading', { name: 'Appareil' })).toBeInTheDocument()
  })

  it('is exposed as a labelled region', () => {
    renderPanel()
    expect(screen.getByRole('complementary', { name: /details/i })).toBeInTheDocument()
  })
})
