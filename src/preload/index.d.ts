import type { PhotoStreamApi } from '../preload'

declare global {
  interface Window {
    photoStream: PhotoStreamApi
    __PHOTO_STREAM_TEST__?: {
      photos?: unknown
      transform?: unknown
    }
  }
}

export {}
