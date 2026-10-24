<template>
  <div
    v-if="currentNotification"
    class="editor-notifications"
    :class="currentNotification.style"
    :style="{ 'max-width': `calc(100vw - ${effectiveSideBarWidth}px)` }"
  >
    <div class="msg">
      {{ currentNotification.msg }}
    </div>
    <div class="controls">
      <div>
        <span
          v-if="currentNotification.secondaryLabel"
          class="inline-button wide"
          @click.stop="handleSecondaryClick"
        >
          {{ currentNotification.secondaryLabel }}
        </span>
        <span
          v-if="currentNotification.showConfirm"
          class="inline-button"
          :class="{ wide: !!currentNotification.primaryLabel }"
          @click.stop="handleClick(true)"
        >
          {{ currentNotification.primaryLabel ?? t('common.ok') }}
        </span>
        <span
          class="inline-button"
          @click.stop="handleClick(false)"
        >
          <el-icon
            class="close-icon"
            :size="12"
          >
            <Close />
          </el-icon>
        </span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useEditorStore } from '@/store/editor'
import { useLayoutStore } from '@/store/layout'
import { storeToRefs } from 'pinia'
import { Close } from '@element-plus/icons-vue'
import { t } from '../../i18n'

const editorStore = useEditorStore()
const layoutStore = useLayoutStore()

const { currentFile } = storeToRefs(editorStore)
const { effectiveSideBarWidth } = storeToRefs(layoutStore)

const currentNotification = computed(() => {
  const notifications = currentFile.value?.notifications
  if (!notifications || notifications.length === 0) {
    return null
  }
  return notifications[0]
})

const handleClick = (status: boolean) => {
  const notifications = currentFile.value?.notifications
  if (!notifications || notifications.length === 0) {
    console.error(t('editor.notifications.notificationNotFound'))
    return
  }

  const item = notifications.shift()
  const action = item?.action
  if (action) {
    action(status)
  }
}

// The labeled extra button (e.g. the merge banner's "view changes"): consumes
// the banner and runs the secondary action — the primary `action` (OK/cancel
// semantics) is intentionally left untouched.
const handleSecondaryClick = () => {
  const notifications = currentFile.value?.notifications
  if (!notifications || notifications.length === 0) {
    console.error(t('editor.notifications.notificationNotFound'))
    return
  }

  const item = notifications.shift()
  const secondaryAction = item?.secondaryAction
  if (secondaryAction) {
    secondaryAction()
  }
}
</script>

<style scoped>
.editor-notifications {
  position: relative;
  display: flex;
  flex-direction: row;
  max-height: 100px;
  margin-top: 4px;
  background: var(--notificationPrimaryBg);
  color: var(--notificationPrimaryColor);
  padding: 8px 10px;
  user-select: none;
  overflow: hidden;
  &.warn {
    background: var(--notificationWarningBg);
    color: var(--notificationWarningColor);
  }
  &.crit {
    background: var(--notificationErrorBg);
    color: var(--notificationErrorColor);
  }
}
.msg {
  font-size: 13px;
  flex: 1;
}
.controls {
  display: flex;
  flex-direction: column;
  justify-content: center;
  & > div {
    display: flex;
    flex-direction: row;
  }
  & .inline-button:not(:last-child) {
    margin-right: 3px;
  }
  & .inline-button {
    display: flex;
    justify-content: center;
    align-items: center;
    width: 24px;
    height: 24px;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.1);
  }
  /* Labeled extra button (e.g. "view changes"): sized by its text. */
  & .inline-button.wide {
    width: auto;
    padding: 0 8px;
    white-space: nowrap;
  }
  & .inline-button:hover {
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.6);
  }
}
</style>
