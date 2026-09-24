import { expect, it, vi } from 'vitest';
import { LoginItemController } from '../apps/desktop/src/login-item.ts';
import { desktopSettingsSchema, uiRequestSchema } from '../src/desktop/contracts.ts';
import { defaultSettings } from '../src/desktop/vault.ts';

function setup() {
  let native = { status: 'not-registered', openAtLogin: false, wasOpenedAtLogin: false };
  const app = {
    isPackaged: true,
    isInApplicationsFolder: vi.fn(() => true),
    getLoginItemSettings: vi.fn(() => native),
    setLoginItemSettings: vi.fn(({ openAtLogin }) => {
      native = { ...native, status: openAtLogin ? 'enabled' : 'not-registered', openAtLogin };
    }),
  };
  return {
    app,
    controller: new LoginItemController(app, 'darwin'),
    native: (value) => {
      native = { ...native, ...value };
    },
  };
}
it('reads the OS preference without registering anything at startup', () => {
  const { controller, app } = setup();
  expect(controller.read()).toMatchObject({
    status: 'not-registered',
    enabled: false,
    canEnable: true,
  });
  expect(app.getLoginItemSettings).toHaveBeenCalledWith({ type: 'mainAppService' });
  expect(app.setLoginItemSettings).not.toHaveBeenCalled();
});
it('registers only the main application and verifies enable and disable results', () => {
  const { controller, app } = setup();
  expect(controller.set(true)).toMatchObject({ status: 'enabled', enabled: true, requested: true });
  expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
    type: 'mainAppService',
    openAtLogin: true,
  });
  expect(controller.set(false)).toMatchObject({
    status: 'not-registered',
    enabled: false,
    requested: false,
  });
  expect(app.setLoginItemSettings).toHaveBeenLastCalledWith({
    type: 'mainAppService',
    openAtLogin: false,
  });
});
it('does not register duplicates on repeated enable or disable', () => {
  const { controller, app } = setup();
  controller.set(false);
  controller.set(true);
  controller.set(true);
  controller.set(false);
  controller.set(false);
  expect(app.setLoginItemSettings).toHaveBeenCalledTimes(2);
});
it('shows pending approval as requested rather than enabled, and lets the user cancel it', () => {
  const { controller, app, native } = setup();
  app.setLoginItemSettings.mockImplementationOnce(() =>
    native({ status: 'requires-approval', openAtLogin: false }),
  );
  expect(controller.set(true)).toMatchObject({
    status: 'requires-approval',
    requested: true,
    enabled: false,
  });
  expect(controller.set(true).enabled).toBe(false);
  expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
  expect(controller.set(false).requested).toBe(false);
});
it('reflects external changes and never re-enables an OS-disabled login item from local cache', () => {
  const { controller, app, native } = setup();
  controller.set(true);
  native({ status: 'not-registered', openAtLogin: false });
  expect(controller.read()).toMatchObject({ requested: false, enabled: false });
  expect(app.setLoginItemSettings).toHaveBeenCalledTimes(1);
});
it('refuses to register development Electron or change its login settings', () => {
  const { controller, app } = setup();
  app.isPackaged = false;
  expect(controller.read()).toMatchObject({ supported: false, status: 'unavailable' });
  expect(() => controller.set(true)).toThrow('开发模式');
  expect(() => controller.set(false)).toThrow('开发模式');
  expect(app.getLoginItemSettings).not.toHaveBeenCalled();
  expect(app.setLoginItemSettings).not.toHaveBeenCalled();
});
it('requires an installed application to enable, but permits removal after moving it', () => {
  const { controller, app } = setup();
  app.isInApplicationsFolder.mockReturnValue(false);
  expect(() => controller.set(true)).toThrow('应用程序');
  expect(app.setLoginItemSettings).not.toHaveBeenCalled();
  app.isInApplicationsFolder.mockReturnValue(true);
  controller.set(true);
  app.isInApplicationsFolder.mockReturnValue(false);
  expect(controller.set(false).requested).toBe(false);
});
it('does not call platform-specific APIs on other systems', () => {
  const { app } = setup();
  const controller = new LoginItemController(app, 'linux');
  expect(controller.read().supported).toBe(false);
  expect(() => controller.set(true)).toThrow('macOS');
  expect(app.getLoginItemSettings).not.toHaveBeenCalled();
});
it('reports read failures and unfamiliar OS status instead of treating them as disabled', () => {
  const { controller, app, native } = setup();
  native({ status: 'future-status', openAtLogin: true });
  expect(controller.read().status).toBe('error');
  app.getLoginItemSettings.mockImplementation(() => {
    throw new Error('native details');
  });
  expect(controller.read()).toMatchObject({ status: 'error', canEnable: false });
  expect(() => controller.set(false)).toThrow('暂时无法读取');
  expect(app.setLoginItemSettings).not.toHaveBeenCalled();
});
it('surfaces native write errors without exposing native internals or claiming success', () => {
  const { controller, app } = setup();
  app.setLoginItemSettings.mockImplementation(() => {
    throw new Error('private native details');
  });
  expect(() => controller.set(true)).toThrow('未能修改');
  expect(controller.read().enabled).toBe(false);
});
it('requires confirmation from the OS after a no-op setter and reports missing registrations', () => {
  const { controller, app, native } = setup();
  app.setLoginItemSettings.mockImplementation(() => {});
  expect(() => controller.set(true)).toThrow('尚未启用');
  native({ status: 'enabled', openAtLogin: true });
  expect(() => controller.set(false)).toThrow('尚未关闭');
  native({ status: 'not-found', openAtLogin: false });
  expect(controller.read().status).toBe('not-found');
  expect(() => controller.set(true)).toThrow('未找到');
});
it('exposes only a boolean setting over IPC, without arbitrary executable or service options', () => {
  expect(uiRequestSchema.parse({ method: 'setLoginItem', enabled: true })).toEqual({
    method: 'setLoginItem',
    enabled: true,
  });
  for (const extra of [
    { path: '/bin/sh' },
    { type: 'daemonService' },
    { args: ['execute'] },
    { serviceName: 'other' },
  ])
    expect(
      uiRequestSchema.safeParse({ method: 'setLoginItem', enabled: true, ...extra }).success,
    ).toBe(false);
  expect(uiRequestSchema.safeParse({ method: 'setLoginItem', enabled: 'true' }).success).toBe(
    false,
  );
  expect(desktopSettingsSchema.safeParse({ ...defaultSettings(), openAtLogin: true }).success).toBe(
    false,
  );
});
