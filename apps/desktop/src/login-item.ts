import type { App } from 'electron';
import type { LoginItemState } from '../../../src/desktop/contracts.js';

type LoginApp = Pick<
  App,
  'isPackaged' | 'isInApplicationsFolder' | 'getLoginItemSettings' | 'setLoginItemSettings'
>;
const options = { type: 'mainAppService' as const };

/** macOS owns this preference. Never re-register it from a cached draft at startup. */
export class LoginItemController {
  constructor(
    private readonly app: LoginApp,
    private readonly platform = process.platform,
  ) {}

  read(): LoginItemState {
    if (this.platform !== 'darwin')
      return {
        supported: false,
        canEnable: false,
        status: 'unavailable',
        enabled: false,
        requested: false,
        message: '此版本仅支持 macOS 登录后自动打开。',
      };
    if (!this.app.isPackaged)
      return {
        supported: false,
        canEnable: false,
        status: 'unavailable',
        enabled: false,
        requested: false,
        message: '开发模式不注册登录项。请安装 CodexConnector.app 后，在应用内开启。',
      };
    try {
      const installed = this.app.isInApplicationsFolder();
      const native = this.app.getLoginItemSettings(options);
      const status = native.status;
      if (!['enabled', 'not-registered', 'requires-approval', 'not-found'].includes(status))
        throw new Error('Unknown login item status');
      const messages = {
        enabled: '已开启，下次登录 Mac 时自动打开 App。',
        'not-registered': '未开启，登录 Mac 时不会自动打开 App。',
        'requires-approval':
          '等待系统批准，请在 macOS 系统设置的“登录项”中允许 CodexConnector，再刷新状态。',
        'not-found': '系统未找到此应用的登录项。请确认 App 已安装到“应用程序”，再重新开启。',
      };
      return {
        supported: true,
        canEnable: installed,
        status,
        enabled: status === 'enabled',
        requested: status === 'enabled' || status === 'requires-approval',
        message: installed
          ? messages[status]
          : '请先将 App 移到“应用程序”文件夹，再开启自启；已有登录项仍可关闭。',
      };
    } catch {
      return {
        supported: true,
        canEnable: false,
        status: 'error',
        enabled: false,
        requested: false,
        message: '暂时无法读取 macOS 登录项状态，请刷新重试。',
      };
    }
  }

  set(enabled: boolean): LoginItemState {
    const before = this.read();
    if (!before.supported || before.status === 'error' || (enabled && !before.canEnable))
      throw new Error(before.message);
    // Idempotent writes avoid duplicate registrations, including pending approvals.
    if (before.requested === enabled && before.status !== 'not-found') return before;
    try {
      this.app.setLoginItemSettings({ ...options, openAtLogin: enabled });
    } catch {
      throw new Error('未能修改 macOS 登录项，请在系统设置的“登录项”中检查权限后重试。');
    }
    const after = this.read();
    if (after.status === 'error' || after.status === 'not-found') throw new Error(after.message);
    if (enabled && !after.requested) throw new Error('系统尚未启用登录项，请检查系统设置后重试。');
    if (!enabled && after.requested) throw new Error('系统尚未关闭登录项，请检查系统设置后重试。');
    return after;
  }
}
