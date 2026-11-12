import { app, Notification } from 'electron';

export interface SystemNotification {
  title: string;
  body: string;
}

export function configureSystemNotifications() {
  // Match the app ID registered by the NSIS installer.
  if (process.platform === 'win32') app.setAppUserModelId('com.chenbitao.harmony');
}

export function showSystemNotification({ title, body }: SystemNotification) {
  if (!Notification.isSupported()) return;
  const notification = new Notification({ title, body, silent: true });
  notification.once('failed', (_, error) => console.warn('无法显示系统通知', error));
  notification.show();
}
