<template>
  <div class="print-settings-dialog">
    <el-dialog
      v-model="showExportSettingsDialog"
      :show-close="false"
      :modal="true"
      custom-class="ag-dialog-table"
      width="500px"
    >
      <h3>{{ t('exportSettings.title') }}</h3>
      <el-tabs v-model="activeName">
        <el-tab-pane
          :label="t('exportSettings.info.label')"
          name="info"
        >
          <span class="text">{{ t('exportSettings.info.description') }}</span>
          <div v-if="exportType === 'docx'" class="docx-engine-select">
            <cur-select
              :description="t('exportSettings.docxEngine.description')"
              :value="docxEngine"
              :options="docxEngineOptions"
              :on-change="(value: unknown) => onSelectChange('docxEngine', value)"
            />
          </div>
        </el-tab-pane>
        <el-tab-pane
          :label="t('exportSettings.page.label')"
          name="page"
        >
          <!-- HTML -->
          <div v-if="!isPrintable">
            <text-box
              :description="t('exportSettings.page.pageTitle')"
              :input="htmlTitle"
              :emit-time="0"
              :on-change="(value: unknown) => onSelectChange('htmlTitle', value)"
            />
            <bool
              v-if="exportType === 'styledHtml'"
              :description="t('exportSettings.page.embedImages')"
              :detailed-description="t('exportSettings.page.embedImagesDetail')"
              :bool="embedImages"
              :on-change="(value: unknown) => onSelectChange('embedImages', value)"
            />
            <bool
              v-if="exportType === 'styledHtml'"
              :description="t('exportSettings.page.exportZip')"
              :detailed-description="t('exportSettings.page.exportZipDetail')"
              :bool="exportZip"
              :on-change="(value: unknown) => onSelectChange('exportZip', value)"
            />
          </div>

          <!-- PDF/Print -->
          <div v-if="isPrintable">
            <div v-if="exportType === 'pdf'">
              <cur-select
                class="page-size-select"
                :description="t('exportSettings.page.pageSize')"
                :value="pageSize"
                :options="pageSizeList"
                :on-change="(value: unknown) => onSelectChange('pageSize', value)"
              />
              <div
                v-if="pageSize === 'custom'"
                class="row"
              >
                <div>{{ t('exportSettings.page.widthHeight') }}</div>
                <el-input-number
                  v-model="pageSizeWidth"
                  size="mini"
                  controls-position="right"
                  :min="100"
                />
                <el-input-number
                  v-model="pageSizeHeight"
                  size="mini"
                  controls-position="right"
                  :min="100"
                />
              </div>

              <bool
                :description="t('exportSettings.page.landscapeOrientation')"
                :bool="isLandscape"
                :on-change="(value: unknown) => onSelectChange('isLandscape', value)"
              />
            </div>

            <div class="row">
              <div class="description">
                {{ t('exportSettings.page.pageMargin') }}
              </div>
              <div>
                <div class="label">
                  {{ t('exportSettings.page.topBottom') }}
                </div>
                <el-input-number
                  v-model="pageMarginTop"
                  size="mini"
                  controls-position="right"
                  :min="0"
                  :max="100"
                />
                <el-input-number
                  v-model="pageMarginBottom"
                  size="mini"
                  controls-position="right"
                  :min="0"
                  :max="100"
                />
              </div>
              <div>
                <div class="label">
                  {{ t('exportSettings.page.leftRight') }}
                </div>
                <el-input-number
                  v-model="pageMarginLeft"
                  size="mini"
                  controls-position="right"
                  :min="0"
                  :max="100"
                />
                <el-input-number
                  v-model="pageMarginRight"
                  size="mini"
                  controls-position="right"
                  :min="0"
                  :max="100"
                />
              </div>
            </div>
          </div>
        </el-tab-pane>
        <el-tab-pane
          :label="t('exportSettings.style.label')"
          name="style"
        >
          <!-- DOCX has no layout themes (they only exist for HTML/PDF); its
               "theme" is the default font configuration below. -->
          <template v-if="exportType === 'docx'">
            <cur-select
              :description="t('exportSettings.docxFonts.latin')"
              :value="docxLatinFont"
              :options="docxLatinFontList"
              :on-change="(value: unknown) => onSelectChange('docxLatinFont', value)"
            />
            <cur-select
              :description="t('exportSettings.docxFonts.eastAsia')"
              :value="docxEastAsiaFont"
              :options="docxEastAsiaFontList"
              :on-change="(value: unknown) => onSelectChange('docxEastAsiaFont', value)"
            />
            <cur-select
              :description="t('exportSettings.docxFonts.size')"
              :value="docxFontSize"
              :options="docxFontSizeList"
              :on-change="(value: unknown) => onSelectChange('docxFontSize', value)"
            />
          </template>
          <template v-else>
            <bool
              :description="t('exportSettings.style.overwriteThemeFont')"
              :bool="fontSettingsOverwrite"
              :on-change="(value: unknown) => onSelectChange('fontSettingsOverwrite', value)"
            />
            <div v-if="fontSettingsOverwrite">
              <font-text-box
                :description="t('exportSettings.style.fontFamily')"
                :value="fontFamily"
                :on-change="(value: unknown) => onSelectChange('fontFamily', value)"
              />
              <range
                :description="t('exportSettings.style.fontSize')"
                :value="fontSize"
                :min="8"
                :max="32"
                unit="px"
                :step="1"
                :on-change="(value: unknown) => onSelectChange('fontSize', value)"
              />
              <range
                :description="t('exportSettings.style.lineHeight')"
                :value="lineHeight"
                :min="1.0"
                :max="2.0"
                :step="0.1"
                :on-change="(value: unknown) => onSelectChange('lineHeight', value)"
              />
            </div>
          </template>
          <bool
            :description="t('exportSettings.autoNumberingHeadings')"
            :bool="autoNumberingHeadings"
            :on-change="(value: unknown) => onSelectChange('autoNumberingHeadings', value)"
          />
          <bool
            :description="t('exportSettings.showFrontMatter')"
            :bool="showFrontMatter"
            :on-change="(value: unknown) => onSelectChange('showFrontMatter', value)"
          />
        </el-tab-pane>
        <!-- Layout themes only exist for HTML/PDF exports. DOCX styling is
             configured via the font settings in the style tab. -->
        <el-tab-pane
          v-if="exportType !== 'docx'"
          :label="t('exportSettings.theme.label')"
          name="theme"
        >
          <div class="text">
            {{ t('exportSettings.theme.description') }}
          </div>
          <cur-select
            :description="t('exportSettings.theme.theme')"
            more="https://marktext.me/docs/export-themes"
            :value="theme"
            :options="themeList"
            :on-change="(value: unknown) => onSelectChange('theme', value)"
          />
        </el-tab-pane>
        <el-tab-pane
          v-if="isPrintable"
          :label="t('exportSettings.headerFooter.label')"
          name="header"
        >
          <div class="text">
            {{ t('exportSettings.headerFooter.description') }}
          </div>
          <cur-select
            :description="t('exportSettings.headerFooter.headerType')"
            :value="headerType"
            :options="headerFooterTypes"
            :on-change="(value: unknown) => onSelectChange('headerType', value)"
          />
          <text-box
            v-if="headerType === 2"
            :description="t('exportSettings.headerFooter.leftHeaderText')"
            :input="headerTextLeft"
            :emit-time="0"
            :on-change="(value: unknown) => onSelectChange('headerTextLeft', value)"
          />
          <text-box
            v-if="headerType !== 0"
            :description="t('exportSettings.headerFooter.mainHeaderText')"
            :input="headerTextCenter"
            :emit-time="0"
            :on-change="(value: unknown) => onSelectChange('headerTextCenter', value)"
          />
          <text-box
            v-if="headerType === 2"
            :description="t('exportSettings.headerFooter.rightHeaderText')"
            :input="headerTextRight"
            :emit-time="0"
            :on-change="(value: unknown) => onSelectChange('headerTextRight', value)"
          />

          <cur-select
            :description="t('exportSettings.headerFooter.footerType')"
            :value="footerType"
            :options="headerFooterTypes"
            :on-change="(value: unknown) => onSelectChange('footerType', value)"
          />
          <text-box
            v-if="footerType === 2"
            :description="t('exportSettings.headerFooter.leftFooterText')"
            :input="footerTextLeft"
            :emit-time="0"
            :on-change="(value: unknown) => onSelectChange('footerTextLeft', value)"
          />
          <text-box
            v-if="footerType !== 0"
            :description="t('exportSettings.headerFooter.mainFooterText')"
            :input="footerTextCenter"
            :emit-time="0"
            :on-change="(value: unknown) => onSelectChange('footerTextCenter', value)"
          />
          <text-box
            v-if="footerType === 2"
            :description="t('exportSettings.headerFooter.rightFooterText')"
            :input="footerTextRight"
            :emit-time="0"
            :on-change="(value: unknown) => onSelectChange('footerTextRight', value)"
          />

          <bool
            :description="t('exportSettings.headerFooter.customizeStyle')"
            :bool="headerFooterCustomize"
            :on-change="(value: unknown) => onSelectChange('headerFooterCustomize', value)"
          />

          <div v-if="headerFooterCustomize">
            <bool
              :description="t('exportSettings.headerFooter.allowStyled')"
              :bool="headerFooterStyled"
              :on-change="(value: unknown) => onSelectChange('headerFooterStyled', value)"
            />
            <range
              :description="t('exportSettings.headerFooter.fontSize')"
              :value="headerFooterFontSize"
              :min="8"
              :max="20"
              unit="px"
              :step="1"
              :on-change="(value: unknown) => onSelectChange('headerFooterFontSize', value)"
            />
          </div>
        </el-tab-pane>

        <el-tab-pane
          :label="t('exportSettings.toc.label')"
          name="toc"
        >
          <bool
            :description="t('exportSettings.toc.includeTopHeading')"
            :detailed-description="t('exportSettings.toc.includeTopHeadingDetail')"
            :bool="tocIncludeTopHeading"
            :on-change="(value: unknown) => onSelectChange('tocIncludeTopHeading', value)"
          />
          <text-box
            :description="t('exportSettings.toc.title')"
            :input="tocTitle"
            :emit-time="0"
            :on-change="(value: unknown) => onSelectChange('tocTitle', value)"
          />
        </el-tab-pane>
      </el-tabs>
      <div class="button-controlls">
        <button
          class="button-primary"
          @click="handleClicked"
        >
          {{ t('exportSettings.export') }}
        </button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch, type Ref } from 'vue'
import bus from '../../bus'
import { useEditorStore } from '@/store/editor'
import { loadExportSettings, saveExportSettings } from './persistence'
import { parseExportFrontmatter } from './frontmatterPreset'
import Bool from '@/prefComponents/common/bool/index.vue'
import CurSelect from '@/prefComponents/common/select/index.vue'
import FontTextBox from '@/prefComponents/common/fontTextBox/index.vue'
import Range from '@/prefComponents/common/range/index.vue'
import TextBox from '@/prefComponents/common/textBox/index.vue'
import { getPageSizeList, getHeaderFooterTypes, getExportThemeList, getDocxEngineList, getDocxLatinFontList, getDocxEastAsiaFontList, getDocxFontSizeList } from './exportOptions'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const exportType = ref('')
const themesLoaded = ref(false)
const isPrintable = ref(true)
const showExportSettingsDialog = ref(false)
const activeName = ref('info')
const htmlTitle = ref('')
const embedImages = ref(true)
// Inverse of embedImages: the two options are mutually exclusive (either the
// images live inside the HTML or beside it in the zip), so picking one turns
// the other off.
const exportZip = ref(false)
const pageSize = ref('A4')
const pageSizeWidth = ref(210)
const pageSizeHeight = ref(297)
const isLandscape = ref(false)
const pageMarginTop = ref(20)
const pageMarginRight = ref(15)
const pageMarginBottom = ref(20)
const pageMarginLeft = ref(15)
const fontSettingsOverwrite = ref(false)
const fontFamily = ref('Default')
const fontSize = ref(14)
const lineHeight = ref(1.5)
const autoNumberingHeadings = ref(false)
const showFrontMatter = ref(false)
const theme = ref('default')
const themeList = ref(getExportThemeList())
const pageSizeList = ref(getPageSizeList())
const headerFooterTypes = ref(getHeaderFooterTypes())
const headerType = ref(0)
const headerTextLeft = ref('')
const headerTextCenter = ref('')
const headerTextRight = ref('')
const footerType = ref(0)
const footerTextLeft = ref('')
const footerTextCenter = ref('')
const footerTextRight = ref('')
const headerFooterCustomize = ref(false)
const headerFooterStyled = ref(true)
const headerFooterFontSize = ref(12)
const tocTitle = ref('')
const tocIncludeTopHeading = ref(true)
const docxEngine = ref<'auto' | 'pandoc' | 'js'>('auto')
const docxEngineOptions = ref(getDocxEngineList())
// DOCX "default theme" — fonts and body size. Defaults mirror the
// web-exported reference document (Times New Roman, Word's default CJK font,
// 12pt body). An empty east-asian font keeps Word's own default.
const docxLatinFont = ref('Times New Roman')
const docxEastAsiaFont = ref('')
const docxFontSize = ref('12')
const docxLatinFontList = ref(getDocxLatinFontList())
const docxEastAsiaFontList = ref(getDocxEastAsiaFontList())
const docxFontSizeList = ref(getDocxFontSizeList())

// #2287 — persist the chosen export options across sessions. Every option ref
// is registered here; changes are saved to localStorage and restored on mount.
const persistableSettings: Record<string, Ref<unknown>> = {
  htmlTitle,
  embedImages,
  exportZip,
  pageSize,
  pageSizeWidth,
  pageSizeHeight,
  isLandscape,
  pageMarginTop,
  pageMarginRight,
  pageMarginBottom,
  pageMarginLeft,
  fontSettingsOverwrite,
  fontFamily,
  fontSize,
  lineHeight,
  autoNumberingHeadings,
  showFrontMatter,
  theme,
  headerType,
  headerTextLeft,
  headerTextCenter,
  headerTextRight,
  footerType,
  footerTextLeft,
  footerTextCenter,
  footerTextRight,
  headerFooterCustomize,
  headerFooterStyled,
  headerFooterFontSize,
  tocTitle,
  tocIncludeTopHeading,
  docxEngine,
  docxLatinFont,
  docxEastAsiaFont,
  docxFontSize
}

const restoreExportSettings = () => {
  const saved = loadExportSettings()
  // Data written before the ZIP option existed may carry `embedImages: false`
  // that is just the old hardcoded default rather than a deliberate choice —
  // let such entries fall back to the new default. Once a save includes the
  // `exportZip` key this migration never applies again.
  if (!('exportZip' in saved)) {
    delete saved.embedImages
  }
  for (const [key, settingRef] of Object.entries(persistableSettings)) {
    if (key in saved) settingRef.value = saved[key]
  }
  // The two options are mutually exclusive; localStorage edited by hand could
  // carry both as true.
  if (embedImages.value && exportZip.value) {
    exportZip.value = false
  }
}

watch(Object.values(persistableSettings), () => {
  saveExportSettings(
    Object.fromEntries(
      Object.entries(persistableSettings).map(([key, settingRef]) => [key, settingRef.value])
    )
  )
})

onMounted(() => {
  restoreExportSettings()
  bus.on('showExportDialog', showDialog)
  bus.on('language-changed', updateTranslations)
})

onBeforeUnmount(() => {
  bus.off('showExportDialog', showDialog)
  bus.off('language-changed', updateTranslations)
})

const updateTranslations = () => {
  themeList.value = getExportThemeList()
  pageSizeList.value = getPageSizeList()
  headerFooterTypes.value = getHeaderFooterTypes()
  docxEngineOptions.value = getDocxEngineList()
  docxLatinFontList.value = getDocxLatinFontList()
  docxEastAsiaFontList.value = getDocxEastAsiaFontList()
  docxFontSizeList.value = getDocxFontSizeList()
}

const showDialog = (type: unknown) => {
  const exportTypeValue = String(type ?? '')
  exportType.value = exportTypeValue
  isPrintable.value = exportTypeValue !== 'styledHtml' && exportTypeValue !== 'docx'
  if (!isPrintable.value && (activeName.value === 'header' || activeName.value === 'page')) {
    activeName.value = 'info'
  }

  // #7 — apply the document's own `export:` frontmatter preset on top of the
  // persisted defaults, so a project ships its export preset with its files.
  // Unknown keys and unparseable values are ignored; every other ref keeps
  // the persisted value.
  const editorStore = useEditorStore()
  const preset = parseExportFrontmatter(editorStore.currentFile?.markdown ?? '')
  for (const [key, value] of Object.entries(preset)) {
    const settingRef = persistableSettings[key]
    if (settingRef && typeof value === typeof settingRef.value) {
      settingRef.value = value
    }
  }

  showExportSettingsDialog.value = true
  bus.emit('editor-blur')

  if (!themesLoaded.value) {
    themesLoaded.value = true
    loadThemesFromDisk()
  }
}

const handleClicked = () => {
  const options: Record<string, unknown> = {
    type: exportType.value,
    pageSize: pageSize.value,
    pageSizeWidth: pageSizeWidth.value,
    pageSizeHeight: pageSizeHeight.value,
    isLandscape: isLandscape.value,
    pageMarginTop: pageMarginTop.value,
    pageMarginRight: pageMarginRight.value,
    pageMarginBottom: pageMarginBottom.value,
    pageMarginLeft: pageMarginLeft.value,
    autoNumberingHeadings: autoNumberingHeadings.value,
    showFrontMatter: showFrontMatter.value,
    // Layout themes do not apply to DOCX (the engines ignore HTML CSS); its
    // look is controlled by the docxFont settings instead.
    theme: exportType.value === 'docx' ? null : (theme.value === 'default' ? null : theme.value),
    tocTitle: tocTitle.value,
    tocIncludeTopHeading: tocIncludeTopHeading.value
  }

  if (!isPrintable.value) {
    options.htmlTitle = htmlTitle.value
  }

  if (exportType.value === 'styledHtml') {
    options.embedImages = embedImages.value
    options.exportZip = exportZip.value
  }

  if (exportType.value === 'docx') {
    options.docxEngine = docxEngine.value
    // Only deviating values travel with the payload; all-default means "use
    // the packaged reference document as-is".
    const docxFont: Record<string, unknown> = {}
    if (docxLatinFont.value !== 'Times New Roman') docxFont.latin = docxLatinFont.value
    if (docxEastAsiaFont.value) docxFont.eastAsia = docxEastAsiaFont.value
    if (docxFontSize.value !== '12') docxFont.sizePt = parseFloat(docxFontSize.value)
    if (Object.keys(docxFont).length > 0) {
      options.docxFont = docxFont
    }
  }

  if (fontSettingsOverwrite.value && exportType.value !== 'docx') {
    Object.assign(options, {
      fontSize: fontSize.value,
      lineHeight: lineHeight.value,
      fontFamily: fontFamily.value === 'Default' ? null : fontFamily.value
    })
  }

  if (headerType.value !== 0) {
    Object.assign(options, {
      header: {
        type: headerType.value,
        left: headerTextLeft.value,
        center: headerTextCenter.value,
        right: headerTextRight.value
      }
    })
  }

  if (footerType.value !== 0) {
    Object.assign(options, {
      footer: {
        type: footerType.value,
        left: footerTextLeft.value,
        center: footerTextCenter.value,
        right: footerTextRight.value
      }
    })
  }

  if (headerFooterCustomize.value) {
    Object.assign(options, {
      headerFooterStyled: headerFooterStyled.value,
      headerFooterFontSize: headerFooterFontSize.value
    })
  }

  showExportSettingsDialog.value = false
  bus.emit('export', options)
}

const onSelectChange = (key: string, value: unknown) => {
  // embedImages and exportZip are mutually exclusive: enabling one disables
  // the other (the images are either inlined or packed beside the HTML).
  if (key === 'embedImages' && value === true) exportZip.value = false
  if (key === 'exportZip' && value === true) embedImages.value = false

  const state: Record<string, Ref<unknown>> = {
    htmlTitle,
    embedImages,
    exportZip,
    pageSize,
    isLandscape,
    fontSettingsOverwrite,
    fontFamily,
    fontSize,
    lineHeight,
    autoNumberingHeadings,
    showFrontMatter,
    theme,
    headerType,
    headerTextLeft,
    headerTextCenter,
    headerTextRight,
    footerType,
    footerTextLeft,
    footerTextCenter,
    footerTextRight,
    headerFooterCustomize,
    headerFooterStyled,
    headerFooterFontSize,
    tocIncludeTopHeading,
    tocTitle,
    docxEngine,
    docxLatinFont,
    docxEastAsiaFont,
    docxFontSize
  }
  if (key in state) {
    state[key]!.value = value
  }
}

const loadThemesFromDisk = async () => {
  // marktext.paths is attached to `window` at runtime by bootstrap.ts but
  // isn't part of the typed contextBridge surface. Cast through `unknown`.
  const marktext = (window as unknown as { marktext?: { paths?: { userDataPath?: string } } })
    .marktext
  const userDataPath = marktext?.paths?.userDataPath
  if (!userDataPath) return
  const themeDir = window.path.join(userDataPath, 'themes/export')

  if (!(await window.fileUtils.isDirectory(themeDir))) return
  let filenames = []
  try {
    filenames = await window.fileUtils.readdir(themeDir)
  } catch {
    return
  }

  for (const filename of filenames) {
    const fullname = window.path.join(themeDir, filename)
    if (!/.+\.css$/i.test(filename)) continue
    if (!(await window.fileUtils.isFile(fullname))) continue
    try {
      const buf = await window.fileUtils.readFile(fullname)
      const content = buf instanceof Uint8Array ? new TextDecoder('utf-8').decode(buf) : String(buf)
      const match = content.match(/^(?:\/\*+[ \t]*([A-z0-9 -]+)[ \t]*(?:\*+\/|[\n\r])?)/)
      const label = match && match[1] ? match[1] : filename
      themeList.value.push({ value: filename, label })
    } catch (e) {
      console.error('loadThemesFromDisk failed:', e)
    }
  }
}
</script>

<style scoped>
.print-settings-dialog {
  user-select: none;
}
.row {
  margin-bottom: 8px;
}
.description {
  margin-bottom: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.label {
  margin-bottom: 5px;
}
.label ~ div {
  margin-right: 20px;
}
.text {
  white-space: pre-wrap;
  word-break: break-word;
}

.button-controlls {
  margin-top: 8px;
  text-align: right;
}

.button-controlls .button-primary {
  font-size: 14px;
}

.el-tab-pane section:first-child {
  margin-top: 0;
}
</style>
<style>
.print-settings-dialog #pane-header .pref-text-box-item .el-input {
  width: 90% !important;
}

.print-settings-dialog .el-dialog__body {
  padding: 0 20px 20px 20px;
}
.print-settings-dialog .pref-select-item .el-select {
  width: 240px;
}
.print-settings-dialog .el-tabs__content {
  max-height: 350px;
  overflow-x: hidden;
  overflow-y: auto;
}

.print-settings-dialog .el-tabs__content::-webkit-scrollbar:vertical {
  width: 5px;
}

.el-input-number {
  & div {
    background: var(--inputBgColor);
  }
  & input {
    border: none !important;
  }
}
</style>
