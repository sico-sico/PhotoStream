import type { Catalog } from '../messages'

export const zhCN: Catalog = {
  'app.title': 'PhotoStream',
  'app.emptyTitle': 'PhotoStream',
  'app.emptyBody': '选择一个存放 JPEG 照片的文件夹，即可开始浏览。',
  'app.emptyAction': '打开文件夹…',
  'app.errorRetry': '换个文件夹试试',

  'toolbar.openFolder': '打开文件夹…',
  'toolbar.scanning': '正在扫描…',
  'toolbar.noFolder': '未选择文件夹',
  'toolbar.layoutAria': '布局',
  'toolbar.layoutGrid': '等高行',
  'toolbar.layoutGridHint': '等高行排列，保留原始比例',
  'toolbar.layoutMasonry': '瀑布流',
  'toolbar.layoutMasonryHint': '分列排列，保留原始比例',
  'toolbar.layoutSquare': '正方形',
  'toolbar.layoutSquareHint': '统一的正方形网格',
  'toolbar.filters': '筛选',
  'toolbar.photoCount': '{visible} / {total} 张',
  'toolbar.language': '语言',

  'filters.aria': '筛选',
  'filters.from': '开始日期',
  'filters.to': '结束日期',
  'filters.fileName': '文件名',
  'filters.fileNamePlaceholder': '例如：京都',
  'filters.reset': '重置',
  'filters.range': '{min} → {max}',
  'filters.active': '已筛选',

  'wall.aria': '照片墙',

  'tile.noDate': '无拍摄日期',
  'tile.unknownDate': '—',

  'viewer.prev': '上一张',
  'viewer.next': '下一张',
  'viewer.close': '关闭查看',
  'viewer.reveal': '在文件夹中显示',
  'viewer.noDate': '无拍摄日期',
  'viewer.size': '{width}×{height}',

  'dialog.chooseFolder': '选择照片文件夹',

  'window.minimize': '最小化',
  'window.maximize': '最大化',
  'window.restore': '还原',
  'window.close': '关闭'
}
