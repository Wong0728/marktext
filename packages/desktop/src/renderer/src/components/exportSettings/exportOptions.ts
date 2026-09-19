import { t } from '@/i18n'
import type { PrefSelectOption } from '@/prefComponents/common/types'

export const getPageSizeList = (): PrefSelectOption<string>[] => [
  {
    label: t('exportSettings.options.pageSizes.a3'),
    value: 'A3'
  },
  {
    label: t('exportSettings.options.pageSizes.a4'),
    value: 'A4'
  },
  {
    label: t('exportSettings.options.pageSizes.a5'),
    value: 'A5'
  },
  {
    label: t('exportSettings.options.pageSizes.legal'),
    value: 'Legal'
  },
  {
    label: t('exportSettings.options.pageSizes.letter'),
    value: 'Letter'
  },
  {
    label: t('exportSettings.options.pageSizes.tabloid'),
    value: 'Tabloid'
  },
  {
    label: t('exportSettings.options.pageSizes.custom'),
    value: 'custom'
  }
]

export const getHeaderFooterTypes = (): PrefSelectOption<number>[] => [
  {
    label: t('exportSettings.options.headerFooterTypes.none'),
    value: 0
  },
  {
    label: t('exportSettings.options.headerFooterTypes.singleCell'),
    value: 1
  },
  {
    label: t('exportSettings.options.headerFooterTypes.threeCells'),
    value: 2
  }
]

export const getHeaderFooterStyles = (): PrefSelectOption<number>[] => [
  {
    label: t('exportSettings.options.headerFooterStyles.default'),
    value: 0
  },
  {
    label: t('exportSettings.options.headerFooterStyles.simple'),
    value: 1
  },
  {
    label: t('exportSettings.options.headerFooterStyles.styled'),
    value: 2
  }
]

export const getExportThemeList = (): PrefSelectOption<string>[] => [
  {
    label: t('exportSettings.options.themes.academic'),
    value: 'academic'
  },
  {
    label: t('exportSettings.options.themes.default'),
    value: 'default'
  },
  {
    label: t('exportSettings.options.themes.liber'),
    value: 'liber'
  }
]

export const getDocxEngineList = (): PrefSelectOption<string>[] => [
  {
    label: t('exportSettings.options.docxEngines.auto'),
    value: 'auto'
  },
  {
    label: t('exportSettings.options.docxEngines.pandoc'),
    value: 'pandoc'
  },
  {
    label: t('exportSettings.options.docxEngines.js'),
    value: 'js'
  }
]

// DOCX "default theme" font options. The first entries are the defaults that
// mirror the web-exported reference document (Times New Roman body, Word's
// default CJK font, 12pt body).
export const getDocxLatinFontList = (): PrefSelectOption<string>[] => [
  { label: 'Times New Roman', value: 'Times New Roman' },
  { label: 'Cambria', value: 'Cambria' },
  { label: 'Calibri', value: 'Calibri' },
  { label: 'Georgia', value: 'Georgia' },
  { label: 'Arial', value: 'Arial' }
]

export const getDocxEastAsiaFontList = (): PrefSelectOption<string>[] => [
  { label: t('exportSettings.options.docxFonts.followWord'), value: '' },
  { label: '宋体', value: '宋体' },
  { label: '微软雅黑', value: '微软雅黑' },
  { label: '楷体', value: '楷体' },
  { label: '黑体', value: '黑体' }
]

export const getDocxFontSizeList = (): PrefSelectOption<string>[] => [
  { label: '10.5 pt', value: '10.5' },
  { label: '11 pt', value: '11' },
  { label: t('exportSettings.options.docxFonts.defaultSize'), value: '12' },
  { label: '14 pt', value: '14' }
]

// Retained for backward compatibility
export const pageSizeList = getPageSizeList()
export const headerFooterTypes = getHeaderFooterTypes()
export const headerFooterStyles = getHeaderFooterStyles()
export const exportThemeList = getExportThemeList()
