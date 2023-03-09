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

import {
  app,
  BrowserWindow,
  Menu,
  shell,
  Tray,
  ipcMain,
  BrowserWindowConstructorOptions,
  nativeTheme,
} from 'electron';
import { release } from 'node:os';
import { join } from 'node:path';

// The built directory structure
//
// ├─┬ dist-electron
// │ ├─┬ main
// │ │ └── index.js    > Electron-Main
// │ └─┬ preload
// │   └── index.js    > Preload-Scripts
// ├─┬ dist
// │ └── index.html    > Electron-Renderer
//
process.env.DIST_ELECTRON = join(__dirname, '..');
process.env.DIST = join(process.env.DIST_ELECTRON, '../dist');
process.env.PUBLIC = process.env.VITE_DEV_SERVER_URL
  ? join(process.env.DIST_ELECTRON, '../public')
  : process.env.DIST;

// Disable GPU Acceleration for Windows 7
if (release().startsWith('6.1')) app.disableHardwareAcceleration();

// Set application name for Windows 10+ notifications
if (process.platform === 'win32') app.setAppUserModelId(app.getName());

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Remove electron security warnings
// This warning only shows in development mode
// Read more on https://www.electronjs.org/docs/latest/tutorial/security
// process.env['ELECTRON_DISABLE_SECURITY_WARNINGS'] = 'true'
let win: BrowserWindow | null = null;
const preload = join(__dirname, '../preload/index.js');
const url = process.env.VITE_DEV_SERVER_URL;
const index = join(process.env.DIST, 'index.html');

// nativeTheme.themeSource = 'dark';

const createWindow = function <T extends BrowserWindowConstructorOptions>(
  options: T
): void {
  win = new BrowserWindow(options);

  // electron-vite-vue#298
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(url);
    // 启动devtools
    win.webContents.openDevTools();
  } else {
    win.loadFile(index);
  }

  // Test actively push message to the Electron-Renderer
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('main-process-message', new Date().toLocaleString());
  });

  // Make all links open with the browser, not with the application
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) shell.openExternal(url);
    return { action: 'deny' };
  });
  // win.webContents.on('will-navigate', (event, url) => { }) #344

  console.log(`欢迎来到 Electron 👋`);
};

/**
 * 通知vue跳转关于页面
 */
const linkAbout = () => {
  if (win) {
    win.webContents.send('jump-router', '/about');
  }
};

/**
 * 退出应用
 */
const quit = () => {
  app.quit();
};

ipcMain.on('send-msg', (event, ...args)=> {
  const [msg] = args
  console.log('当前时间：', msg);
  // event.reply('jump-router', '/about');
});

let tray: Tray | null = null;
/**
 * 使用app.on('ready', () => {});直接监听nodejs事件可能会带来一些问题，详情见https://github.com/electron/electron/pull/21972
 */
app.whenReady().then(() => {
  const icon = join(process.env.PUBLIC, 'favicon-16x16.png');
  tray = new Tray(icon);
  const contextMenu = Menu.buildFromTemplate([
    // { label: 'Item1', type: 'radio' },
    // { label: 'Item2', type: 'radio' },
    // { label: 'Item3', type: 'radio', checked: true },
    { label: '关于', type: 'normal', click: linkAbout },
    { label: '退出', type: 'normal', click: quit }
  ])
  tray.setToolTip('Harmony 好用的跨平台文件管理工具')
  tray.setContextMenu(contextMenu)

  const options: BrowserWindowConstructorOptions = {
    title: 'harmony',
    width: 1100,
    height: 660,
    icon: join(process.env.PUBLIC, 'favicon.ico'),
    // false为隐藏标题栏，需要开发并使用自定义标题栏
    frame: true,
    titleBarStyle: "hidden",
    titleBarOverlay: {
        color: "#fff",
        // symbolColor: "black",
    },
    // hasShadow: false,
    webPreferences: {
      devTools: true,
      preload,
      // Warning: Enable nodeIntegration and disable contextIsolation is not secure in production
      // Consider using contextBridge.exposeInMainWorld
      // Read more on https://www.electronjs.org/docs/latest/tutorial/context-isolation
      nodeIntegration: true,
      contextIsolation: false,
    },
  };
  createWindow(options);

  /**
   * 如果没有窗口打开则打开一个窗口 (macOS)
   */
  app.on('activate', () => {
    const allWindows = BrowserWindow.getAllWindows();
    if (allWindows.length === 0) {
      createWindow(options);
    } else {
      allWindows[0].focus();
    }
  });
});

/**
 * 关闭所有窗口时退出应用 (Windows & Linux)
 */
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('second-instance', () => {
  if (win) {
    // Focus on the main window if the user tried to open another
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

// New window example arg: new windows url
ipcMain.handle('open-win', (_, arg) => {
  const childWindow = new BrowserWindow({
    webPreferences: {
      preload,
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    childWindow.loadURL(`${url}#${arg}`);
  } else {
    childWindow.loadFile(index, { hash: arg });
  }
});
