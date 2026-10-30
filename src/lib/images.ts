import imageCompression from 'browser-image-compression'

export async function compressImage(file: File): Promise<File> {
  return imageCompression(file, {
    maxWidthOrHeight: 1600,
    initialQuality: 0.8,
    useWebWorker: true,
    fileType: 'image/jpeg',
  })
}

const BASEMAP_MAX_EDGE = 8192
const BASEMAP_MAX_BYTES = 20 * 1024 * 1024

/** Keep a yard basemap as sharp as the file allows. Cargo photos stay on compressImage. */
export async function prepareBasemap(file: File): Promise<File> {
  const dims = await fileDimensions(file)
  const longEdge = Math.max(dims.w, dims.h)
  const keepOriginal =
    longEdge <= BASEMAP_MAX_EDGE &&
    file.size <= BASEMAP_MAX_BYTES &&
    (file.type === 'image/png' || file.type === 'image/webp' || file.type === 'image/jpeg')
  if (keepOriginal) return file
  return imageCompression(file, {
    maxWidthOrHeight: BASEMAP_MAX_EDGE,
    initialQuality: 0.92,
    useWebWorker: true,
    fileType: 'image/jpeg',
    alwaysKeepResolution: true,
  })
}

function fileDimensions(file: File): Promise<{ w: number; h: number }> {
  const url = URL.createObjectURL(file)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight })
      URL.revokeObjectURL(url)
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('无法读取图片尺寸'))
    }
    img.src = url
  })
}
