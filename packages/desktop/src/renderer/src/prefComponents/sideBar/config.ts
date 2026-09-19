import {
  Setting as GeneralIcon,
  Edit as EditorIcon,
  Document as MarkdownIcon,
  Brush as ThemeIcon,
  Picture as ImageIcon,
  Reading as SpellIcon,
  Operation as KeyBindingIcon
} from '@element-plus/icons-vue'

import preferences from '../../../../main/preferences/schema.json'
import { t } from '../../i18n'

interface PrefCategory {
  name: string
  label: string
  icon: unknown
  path: string
}

interface PreferenceSchemaEntry {
  description: string
  enum?: unknown[]
  [key: string]: unknown
}

interface TranslatedSearchEntry {
  key: string
  category: string
  categoryEn: string
  preference: string
  preferenceEn: string
  routeCategory: string
  description: string
  enum: unknown[] | undefined
}

interface VueI18nLocale {
  value?: string
}

interface VueI18nGlobal {
  locale?: VueI18nLocale | string
  t?: (key: string) => string
}

interface VueI18nGlobalContainer {
  global?: VueI18nGlobal | (() => VueI18nGlobal)
  t?: (key: string) => string
  $i18n?: VueI18nGlobal
}

declare global {
  interface Window {
    __VUE_I18N__?: VueI18nGlobalContainer
  }
}

// Function-attached cache shared between getTranslatedSearchContent and
// setupLanguageChangeListener.
interface CachedTranslator {
  (): TranslatedSearchEntry[]
  lastLanguage?: string
}

const preferencesSchema = preferences as unknown as Record<string, PreferenceSchemaEntry>

export const getCategory = (): PrefCategory[] => [
  {
    name: t('preferences.categories.general'),
    label: 'general',
    icon: GeneralIcon,
    path: '/preference/general'
  },
  {
    name: t('preferences.categories.editor'),
    label: 'editor',
    icon: EditorIcon,
    path: '/preference/editor'
  },
  {
    name: t('preferences.categories.markdown'),
    label: 'markdown',
    icon: MarkdownIcon,
    path: '/preference/markdown'
  },
  {
    name: t('preferences.categories.spelling'),
    label: 'spelling',
    icon: SpellIcon,
    path: '/preference/spelling'
  },
  {
    name: t('preferences.categories.theme'),
    label: 'theme',
    icon: ThemeIcon,
    path: '/preference/theme'
  },
  {
    name: t('preferences.categories.image'),
    label: 'image',
    icon: ImageIcon,
    path: '/preference/image'
  },
  {
    name: t('preferences.categories.keybindings'),
    label: 'keybindings',
    icon: KeyBindingIcon,
    path: '/preference/keybindings'
  }
]

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

const resolveGlobal = (container: VueI18nGlobalContainer | undefined): VueI18nGlobal | undefined => {
  if (!container) return undefined
  return typeof container.global === 'function' ? container.global() : container.global
}

const resolveLocale = (g: VueI18nGlobal | undefined): string => {
  if (!g || !g.locale) return 'en'
  if (typeof g.locale === 'string') return g.locale
  return g.locale.value ?? 'en'
}

// Creates a reactive translated mapping function
export const getTranslatedSearchContent: CachedTranslator = (() => {
  const fn = (() => {
    // Generate keys by iterating through each language
    const result: TranslatedSearchEntry[] = []
    Object.keys(preferencesSchema).forEach((k) => {
      const entry = preferencesSchema[k]
      if (!entry) return
      const { description, enum: emums } = entry

      if (description.endsWith('--internal')) return

      const [category] = description.split('--')
      const categoryName = category ?? ''

      // Map category names
      let mappedCategory = categoryName.toLowerCase()
      if (categoryName === 'General') mappedCategory = 'general'
      else if (categoryName === 'Editor') mappedCategory = 'editor'
      else if (categoryName === 'Markdown') mappedCategory = 'markdown'
      else if (categoryName === 'Theme') mappedCategory = 'theme'
      else if (categoryName === 'Image') mappedCategory = 'image'
      else if (categoryName === 'View') mappedCategory = 'view'
      else if (categoryName === 'Searcher') mappedCategory = 'searcher'
      else if (categoryName === 'Watcher') mappedCategory = 'watcher'
      else if (categoryName === 'Spelling') mappedCategory = 'spelling'
      else if (categoryName === 'Custom CSS') mappedCategory = 'custom css'
      else {
        // Handle special category names
        mappedCategory = categoryName.toLowerCase().replace(/\s+/g, '-')
      }

      // Compute the category for route navigation (only allow existing routes, otherwise fall back to general)
      let routeCategory = mappedCategory
      const validRoutes = [
        'general',
        'editor',
        'markdown',
        'spelling',
        'theme',
        'image',
        'keybindings'
      ]
      if (!validRoutes.includes(routeCategory)) routeCategory = 'general'

      // Try to translate the category and item
      const categoryKey = `preferences.search.categories.${mappedCategory}`
      const itemKey = `preferences.search.items.${k}`

      // Translate the category name
      let translatedCategory = categoryName
      const englishCategory = categoryName
      try {
        translatedCategory = t(categoryKey)
      } catch (e) {
        console.warn(`   ⚠️ Search category translation failed: ${errMessage(e)}`)
        // Try fallback to preferences.categories
        try {
          const fallbackKey = `preferences.categories.${mappedCategory}`
          translatedCategory = t(fallbackKey)
        } catch (e2) {
          console.warn(`   ❌ Search category fallback also failed: ${errMessage(e2)}`)
          translatedCategory = categoryName
        }
      }

      // Translate preference description
      let translatedPreference = description.split('--')[1] || description
      const englishPreference = description.split('--')[1] || description
      try {
        translatedPreference = t(itemKey)
      } catch (e) {
        console.warn(`   ⚠️ Search item translation failed: ${errMessage(e)}`)
        // Try fallback to preferences.items
        try {
          const fallbackKey = `preferences.items.${k}`
          translatedPreference = t(fallbackKey)
        } catch (e2) {
          console.warn(`   ❌ Search item fallback also failed: ${errMessage(e2)}`)
          translatedPreference = description.split('--')[1] || description
        }
      }

      result.push({
        key: k,
        category: translatedCategory,
        categoryEn: englishCategory,
        preference: translatedPreference,
        preferenceEn: englishPreference,
        routeCategory,
        description,
        enum: emums
      })
    })
    return result
  }) as CachedTranslator
  return fn
})()

// Add language change listener
export const setupLanguageChangeListener = (): void => {
  // Listen for language change events
  const handleLanguageChange = () => {
    // Trigger search content refresh
    if (window.__VUE_I18N__) {
      try {
        const g = resolveGlobal(window.__VUE_I18N__)
        const currentLanguage = resolveLocale(g)

        // Here we can dispatch a custom event to notify the search component to refresh
        window.dispatchEvent(
          new CustomEvent('languageChanged', {
            detail: { language: currentLanguage }
          })
        )
      } catch (e) {
        console.warn('⚠️ Failed to get updated language setting:', e)
      }
    }
  }

  // Listen for locale changes in the i18n instance
  if (window.__VUE_I18N__) {
    try {
      const g = resolveGlobal(window.__VUE_I18N__)
      if (g && g.locale && typeof g.locale !== 'string' && g.locale.value !== undefined) {
        // Use Vue's reactive system to listen for language changes
      }
    } catch (e) {
      console.warn('⚠️ Failed to set up language change listener:', e)
    }
  }

  // Add a polling fallback mechanism as a backup
  setInterval(() => {
    try {
      if (window.__VUE_I18N__) {
        const g = resolveGlobal(window.__VUE_I18N__)
        const currentLanguage = resolveLocale(g)
        if (currentLanguage !== getTranslatedSearchContent.lastLanguage) {
          getTranslatedSearchContent.lastLanguage = currentLanguage
          handleLanguageChange()
        }
      }
    } catch {
      // Ignore errors and continue checking
    }
  }, 1000) // Check once per second

  // Record the initial language
  try {
    if (window.__VUE_I18N__) {
      const g = resolveGlobal(window.__VUE_I18N__)
      getTranslatedSearchContent.lastLanguage = resolveLocale(g)
    }
  } catch {
    getTranslatedSearchContent.lastLanguage = 'en'
  }
}

// Initialize the language change listener
setupLanguageChangeListener()

// Add manual refresh function
export const refreshSearchContent = (): TranslatedSearchEntry[] => {
  // Clear the language cache to force re-fetch
  if (getTranslatedSearchContent.lastLanguage) {
    delete getTranslatedSearchContent.lastLanguage
  }

  // Trigger the language change event
  window.dispatchEvent(
    new CustomEvent('languageChanged', {
      detail: { language: 'force-refresh' }
    })
  )

  return getTranslatedSearchContent()
}
