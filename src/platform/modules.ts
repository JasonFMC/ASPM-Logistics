export interface PlatformModule {
  id: string
  name: string
  path: string
  summary: string
}

/** Parent platform sections. Add a module here when a new板块 is ready to link. */
export const platformModules: PlatformModule[] = [
  {
    id: 'tickets',
    name: 'Tickets',
    path: '/tickets',
    summary: '从任务邮箱抽出工单，分仓和客户，按待处理、处理中、已完成往后推。',
  },
  {
    id: 'yard',
    name: 'YARD',
    path: '/yard',
    summary: '场外货物位置：底图、区域、格位和查找。',
  },
]
