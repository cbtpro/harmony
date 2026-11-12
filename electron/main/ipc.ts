import { BrowserWindow, ipcMain } from 'electron';
import type { Dispatch } from './engine';

export function registerIpc(getWindow: () => BrowserWindow | null, dispatch: Dispatch) {
  ipcMain.handle('harmony:request', (event, name: string, args: unknown[]) => {
    const window = getWindow();
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) {
      return { ok: false, message: '此窗口无权执行该操作。' };
    }
    if (typeof name !== 'string' || !Array.isArray(args) || args.length > 4) {
      return { ok: false, message: '请求格式无效。' };
    }
    return dispatch(name, args);
  });
}
