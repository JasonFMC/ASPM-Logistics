export interface FaceLook {
  face: number
  eyes: number
  ears: number
  mouth: number
  backdrop: number
  color: number
}

export const PRESET_NAMES = ['小猫', '兔子', '小芽', '小熊', '太阳', '狐狸', '青蛙', '夜空']

export const PRESETS: FaceLook[] = [
  { face: 0, eyes: 0, ears: 0, mouth: 0, backdrop: 0, color: 0 },
  { face: 0, eyes: 0, ears: 1, mouth: 3, backdrop: 0, color: 1 },
  { face: 3, eyes: 0, ears: 3, mouth: 1, backdrop: 2, color: 2 },
  { face: 2, eyes: 0, ears: 0, mouth: 0, backdrop: 0, color: 3 },
  { face: 0, eyes: 1, ears: 3, mouth: 0, backdrop: 3, color: 4 },
  { face: 2, eyes: 0, ears: 2, mouth: 0, backdrop: 0, color: 5 },
  { face: 1, eyes: 2, ears: 3, mouth: 2, backdrop: 0, color: 6 },
  { face: 3, eyes: 3, ears: 3, mouth: 0, backdrop: 3, color: 7 },
]

const PART_MAX = { face: 3, eyes: 3, ears: 3, mouth: 3, backdrop: 3, color: 7 } as const

export const FACE_PARTS: Array<{
  key: keyof FaceLook
  label: string
  choices: Array<{ value: number; label: string }>
}> = [
  {
    key: 'face',
    label: '脸',
    choices: [
      { value: 0, label: '圆' },
      { value: 1, label: '宽' },
      { value: 2, label: '嘴套' },
      { value: 3, label: '嫩' },
    ],
  },
  {
    key: 'eyes',
    label: '眼睛',
    choices: [
      { value: 0, label: '圆' },
      { value: 1, label: '弯' },
      { value: 2, label: '大' },
      { value: 3, label: '眨' },
    ],
  },
  {
    key: 'ears',
    label: '耳朵',
    choices: [
      { value: 0, label: '圆' },
      { value: 1, label: '长' },
      { value: 2, label: '尖' },
      { value: 3, label: '无' },
    ],
  },
  {
    key: 'mouth',
    label: '嘴巴',
    choices: [
      { value: 0, label: '笑' },
      { value: 1, label: '圆' },
      { value: 2, label: '宽' },
      { value: 3, label: '牙' },
    ],
  },
  {
    key: 'backdrop',
    label: '背景',
    choices: [
      { value: 0, label: '素' },
      { value: 1, label: '垫' },
      { value: 2, label: '叶' },
      { value: 3, label: '星' },
    ],
  },
  {
    key: 'color',
    label: '颜色',
    choices: [
      { value: 0, label: '青瓷' },
      { value: 1, label: '粉' },
      { value: 2, label: '芽' },
      { value: 3, label: '奶' },
      { value: 4, label: '杏' },
      { value: 5, label: '茶' },
      { value: 6, label: '薄荷' },
      { value: 7, label: '藤' },
    ],
  },
]

export function resolveLook(look: unknown, hue = 0): FaceLook {
  if (look && typeof look === 'object') {
    const row = look as Record<string, unknown>
    const next = {} as FaceLook
    const keys = Object.keys(PART_MAX) as Array<keyof typeof PART_MAX>
    const ok = keys.every((key) => {
      const value = Number(row[key])
      if (!Number.isInteger(value) || value < 0 || value > PART_MAX[key]) return false
      next[key] = value
      return true
    })
    if (ok) return next
  }
  const index = Number.isInteger(hue) && hue >= 0 && hue <= 7 ? hue : 0
  return PRESETS[index]
}

export function sameLook(a: FaceLook, b: FaceLook) {
  return (Object.keys(PART_MAX) as Array<keyof FaceLook>).every((key) => a[key] === b[key])
}

export function presetIndex(look: FaceLook) {
  return PRESETS.findIndex((item) => sameLook(item, look))
}
