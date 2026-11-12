// Copyright 2023 chenbitao
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { app, BrowserWindow, clipboard, dialog, shell } from 'electron';
import { isAbsolute, join } from 'node:path';
import { createEngine } from './engine';
import { registerIpc } from './ipc';
import { startWebServer } from './web-server';

const userData = app.commandLine.getSwitchValue('user-data-dir');
if (isAbsolute(userData)) app.setPath('userData', userData);

let window: BrowserWindow | null = null;
const engine = createEngine(app.getPath('home'), join(app.getPath('userData'), 'index-rules.json'), {
  async chooseDirectory() {
    const options = { properties: ['openDirectory' as const] };
    const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    return result.canceled ? null : result.filePaths[0] ?? null;
  },
  open: path => shell.openPath(path),
  reveal: path => shell.showItemInFolder(path),
  copyPath: path => clipboard.writeText(path),
  trash: path => shell.trashItem(path),
});
const assets = join(__dirname, '../../dist');
const devUrl = app.isPackaged ? undefined : process.env.VITE_DEV_SERVER_URL;
let web: Awaited<ReturnType<typeof startWebServer>> | undefined;

function createWindow() {
  const created = new BrowserWindow({
    title: 'Harmony',
    width: 1100,
    height: 700,
    minWidth: 640,
    minHeight: 420,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window = created;
  created.on('closed', () => { window = null; });
  created.webContents.on('will-navigate', (event) => event.preventDefault());
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const loading = devUrl ? created.loadURL(devUrl) : created.loadFile(join(assets, 'index.html'));
  void loading.catch(console.error);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerIpc(() => window, async (name, args) => {
    if (name !== 'web:open') return engine.dispatch(name, args);
    if (!web) return { ok: false, message: '网页服务未能启动。' };
    try {
      await shell.openExternal(web.url);
      return { ok: true, value: undefined };
    } catch {
      return { ok: false, message: '无法打开默认浏览器。' };
    }
  });
  app.on('before-quit', () => {
    engine.close();
    web?.close();
  });
  void app.whenReady().then(async () => {
    try { web = await startWebServer(engine.dispatch, assets, devUrl); }
    catch (error) { console.error('网页服务启动失败', error); }
    createWindow();
    void engine.open();
  });
  app.on('activate', () => { if (!window && app.isReady()) createWindow(); });
  app.on('second-instance', () => {
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
