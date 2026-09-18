import imageCompression from 'browser-image-compression'

export async function compressImage(file: File): Promise<File> {
  return imageCompression(file, {
    maxWidthOrHeight: 1600,
    initialQuality: 0.8,
    useWebWorker: true,
    fileType: 'image/jpeg',
  })
}
