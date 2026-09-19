import {
  BrowserWindow,
  Menu,
  MenuItem,
  ipcMain,
  type IpcMainEvent,
  type WebContents
} from 'electron'
import log from 'electron-log'
import type { MenuTemplate, MenuTemplateItem, MenuPopupPosition } from '@shared/types/menu'

const windowFromEvent = (event: IpcMainEvent): BrowserWindow | null =>
  BrowserWindow.fromWebContents(event.sender)

interface PopupEntry {
  sender: WebContents
}
const popups = new Map<number, PopupEntry>()
let popupIdCounter = 0

const buildMenu = (template: MenuTemplate | undefined, popupId: number, windowId: number): Menu => {
  const menu = new Menu()
  for (const item of template || []) {
    if (item.type === 'separator') {
      menu.append(new MenuItem({ type: 'separator' }))
      continue
    }
    const id = item.id
    menu.append(
      new MenuItem({
        label: item.label,
        type: item.type as 'normal' | 'submenu' | 'checkbox' | 'radio' | undefined,
        accelerator: item.accelerator,
        enabled: item.enabled !== false,
        checked: !!item.checked,
        click: () => {
          const sender = popups.get(popupId)?.sender
          try {
            sender?.send('mt::menu::click', { windowId, id })
          } catch {
            /* sender destroyed */
          }
        },
        submenu: item.submenu ? buildMenu(item.submenu as MenuTemplateItem[], popupId, windowId) : undefined
      })
    )
  }
  return menu
}

export const registerWindowHandlers = (): void => {
  ipcMain.on('mt::win::minimize', (event) => {
    const win = windowFromEvent(event)
    if (win) win.minimize()
  })
  ipcMain.on('mt::win::toggle-maximize', (event) => {
    const win = windowFromEvent(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('mt::win::maximize', (event) => {
    const win = windowFromEvent(event)
    if (win) win.maximize()
  })
  ipcMain.on('mt::win::unmaximize', (event) => {
    const win = windowFromEvent(event)
    if (win) win.unmaximize()
  })
  ipcMain.on('mt::win::close', (event) => {
    const win = windowFromEvent(event)
    if (win) win.close()
  })
  ipcMain.on('mt::win::set-fullscreen', (event, flag: boolean) => {
    const win = windowFromEvent(event)
    if (win) win.setFullScreen(!!flag)
  })
  ipcMain.on('mt::win::toggle-fullscreen', (event) => {
    const win = windowFromEvent(event)
    if (win) win.setFullScreen(!win.isFullScreen())
  })
  ipcMain.handle('mt::win::is-maximized', (event) => {
    const win = windowFromEvent(event as unknown as IpcMainEvent)
    return !!win && win.isMaximized()
  })
  ipcMain.handle('mt::win::is-fullscreen', (event) => {
    const win = windowFromEvent(event as unknown as IpcMainEvent)
    return !!win && win.isFullScreen()
  })

  ipcMain.on('mt::menu::popup', (event, template: MenuTemplate, position?: MenuPopupPosition) => {
    const win = windowFromEvent(event)
    if (!win) return
    // Use a unique popup ID so overlapping menus for the same window don't
    // overwrite each other's sender entry in the map.
    const popupId = ++popupIdCounter
    popups.set(popupId, { sender: event.sender })
    try {
      const menu = buildMenu(template, popupId, win.id)
      menu.popup({
        window: win,
        x: position?.x,
        y: position?.y,
        callback: () => {
          popups.delete(popupId)
          try {
            event.sender.send('mt::menu::closed', { windowId: win.id })
          } catch {
            /* destroyed */
          }
        }
      })
    } catch (err) {
      popups.delete(popupId)
      log.error('menu popup failed:', err)
    }
  })

  ipcMain.on('mt::menu::popup-application', (event, position?: MenuPopupPosition) => {
    const win = windowFromEvent(event)
    if (!win) return
    try {
      const appMenu = Menu.getApplicationMenu()
      if (!appMenu) return
      appMenu.popup({ window: win, x: position?.x, y: position?.y })
    } catch (err) {
      log.error('application menu popup failed:', err)
    }
  })
}
