import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  DesktopApi,
  DesktopSettings,
  DesktopSnapshot,
  DesktopStatus,
  LoginItemState,
} from '../../../src/desktop/contracts.js';
import './style.css';
import { DesktopDraftCache, type DraftCacheState } from '../../../src/desktop/draft-cache.js';
import { appendProject, mergeDiscoveredProjects } from '../../../src/desktop/project-selection.js';
import {
  canExecuteProject,
  projectPermissions,
  type RemotePermissions,
} from '../../../src/config/project-policy.js';

declare global {
  interface Window {
    desktop: DesktopApi;
  }
}
type Page = 'overview' | 'feishu' | 'projects' | 'logs' | 'preferences' | 'setup';
const pageLabels: Record<Page, string> = {
  overview: '连接总览',
  feishu: '飞书连接',
  projects: '本地项目',
  logs: '日志与诊断',
  preferences: '应用设置',
  setup: '首次设置',
};
const phaseLabels: Record<DesktopStatus['phase'], string> = {
  stopped: '已停止',
  starting: '正在启动',
  ready: '已连接',
  degraded: '正在连接',
  stopping: '正在停止',
  error: '需要处理',
};
const taskLabels: Record<string, string> = {
  queued: '排队中',
  starting: '启动中',
  running: '运行中',
  unknown: '待核对',
  completed: '已完成',
  failed: '失败',
  interrupted: '已中断',
};
function Icon({ name }: { name: string }) {
  const paths: Record<string, string> = {
    overview: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    feishu: 'M5 5h14v11H10l-5 4z M8 9h8 M8 12h5',
    projects: 'M3 6h6l2 3h10v11H3z',
    logs: 'M6 3h12v18H6z M9 8h6 M9 12h6 M9 16h4',
    setup: 'M12 3v18 M3 12h18',
    preferences: 'M4 7h16 M4 17h16 M8 4v6 M16 14v6',
    arrow: 'M5 12h14 M14 7l5 5-5 5',
    play: 'M8 5l11 7-11 7z',
    stop: 'M6 6h12v12H6z',
    check: 'M5 12l4 4L19 6',
  };
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.setup} />
    </svg>
  );
}
function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [secret, setSecret] = useState('');
  const secretRef = useRef('');
  const cache = useRef<DesktopDraftCache | null>(null);
  const [cacheState, setCacheState] = useState<DraftCacheState>('saved');
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [page, setPage] = useState<Page>('overview');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [loginState, setLoginState] = useState<LoginItemState | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const loginPending = useRef(false);
  const settingsRef = useRef<DesktopSettings | null>(null);
  const editorRevision = useRef(0);
  const mounted = useRef(false);
  const refreshing = useRef(false);
  const [projectStatus, setProjectStatus] = useState({ loading: false, error: false, text: '' });
  const [feishuCheck, setFeishuCheck] = useState<{
    phase: 'checking' | 'success' | 'error';
    text: string;
  } | null>(null);
  const checkRevision = useRef(0);
  const checkResultRef = useRef<HTMLDivElement>(null);
  const api = window.desktop;
  useEffect(() => {
    if (!api) {
      setNotice({ text: '请在 CodexConnector App 中打开此界面。', error: true });
      return;
    }
    mounted.current = true;
    const loading = api
      .load()
      .then((value) => {
        if (!mounted.current) return;
        cache.current = new DesktopDraftCache(
          value.settings,
          api,
          setCacheState,
          (saved, revision, applied) => {
            setSnapshot(saved);
            if (revision !== editorRevision.current) return;
            setDirty(false);
            if (applied) {
              settingsRef.current = saved.settings;
              setSettings(saved.settings);
              secretRef.current = '';
              setSecret('');
              checkRevision.current++;
              setFeishuCheck(null);
            }
          },
        );
        setSnapshot(value);
        settingsRef.current = value.settings;
        setSettings(value.settings);
        if (!value.configured) setPage('setup');
      })
      .catch((error) => setNotice({ text: String(error), error: true }));
    const unsubscribe = api.onStatus((status) =>
      setSnapshot((current) => (current ? { ...current, status } : current)),
    );
    const beforeClose = api.onBeforeClose(async () => {
      closingRef.current = true;
      setClosing(true);
      await loading;
      await cache.current?.flush();
    });
    const cancelled = api.onCloseCancelled(() => {
      closingRef.current = false;
      setClosing(false);
    });
    const flush = () => {
      cache.current?.flush().catch(() => {});
    };
    window.addEventListener('blur', flush);
    return () => {
      mounted.current = false;
      cache.current?.dispose();
      unsubscribe();
      beforeClose();
      cancelled();
      window.removeEventListener('blur', flush);
    };
  }, [api]);
  useEffect(() => {
    if (api && page === 'logs') return api.onLogs(setLogs);
  }, [api, page]);
  const refreshLoginItem = useCallback(async () => {
    if (!api || loginPending.current) return;
    loginPending.current = true;
    setLoginLoading(true);
    setLoginError('');
    try {
      setLoginState(await api.loginItem());
    } catch {
      setLoginError('暂时无法读取自启状态，请重试。');
    } finally {
      loginPending.current = false;
      setLoginLoading(false);
    }
  }, [api]);
  useEffect(() => {
    if (page !== 'preferences') return;
    const refresh = () => {
      refreshLoginItem().catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [page, refreshLoginItem]);
  async function changeLoginItem(enabled: boolean) {
    if (loginPending.current) return;
    loginPending.current = true;
    setLoginLoading(true);
    setLoginError('');
    try {
      setLoginState(await api.setLoginItem(enabled));
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '修改自启状态失败，请重试。');
      try {
        setLoginState(await api.loginItem());
      } catch {
        /* Keep the last observed state, with the error visible. */
      }
    } finally {
      loginPending.current = false;
      setLoginLoading(false);
    }
  }
  async function run(label: string, operation: () => Promise<void>) {
    if (busy) return;
    setBusy(label);
    setNotice(null);
    try {
      await operation();
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : '操作失败', error: true });
    } finally {
      setBusy('');
    }
  }
  function update(next: DesktopSettings) {
    if (closingRef.current) return;
    settingsRef.current = next;
    setSettings(next);
    editorRevision.current =
      cache.current?.update(next, secretRef.current) ?? editorRevision.current;
    setDirty(true);
  }
  const refreshProjects = useCallback(async () => {
    const current = settingsRef.current;
    if (!api || !current || refreshing.current || closingRef.current) return;
    refreshing.current = true;
    setProjectStatus({ loading: true, error: false, text: '正在读取本机 Codex 项目…' });
    try {
      const discovery = await api.discoverProjects([
        ...current.projects.map((p) => p.root),
        ...current.hiddenProjectRoots,
      ]);
      if (!mounted.current || !settingsRef.current || closingRef.current) return;
      const latest = settingsRef.current;
      const next = mergeDiscoveredProjects(latest, discovery);
      if (next !== latest) update(next);
      setProjectStatus({
        loading: false,
        error: false,
        text:
          `已刷新 · 发现 ${discovery.projects.length} 个本机 Codex 项目` +
          (discovery.unavailable ? ` · ${discovery.unavailable} 个目录暂不可用` : '') +
          (next.projects.length >= 100 ? ' · 最多保留 100 个项目' : ''),
      });
    } catch (error) {
      if (mounted.current)
        setProjectStatus({
          loading: false,
          error: true,
          text: error instanceof Error ? error.message : '项目读取失败，请稍后刷新或手动添加。',
        });
    } finally {
      refreshing.current = false;
    }
  }, [api]);
  const loaded = Boolean(settings);
  useEffect(() => {
    if (!loaded) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') refreshProjects().catch(() => {});
    };
    refresh();
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loaded, refreshProjects]);
  useEffect(() => {
    if (page === 'projects' || (page === 'setup' && step === 2)) refreshProjects().catch(() => {});
  }, [page, step, refreshProjects]);
  useEffect(() => {
    if (feishuCheck) checkResultRef.current?.scrollIntoView({ block: 'nearest' });
  }, [feishuCheck, page, step]);
  function resetFeishuCheck() {
    checkRevision.current++;
    setFeishuCheck(null);
  }
  async function checkConnection() {
    if (!settings || busy) return;
    const revision = ++checkRevision.current;
    setBusy('检查飞书');
    setFeishuCheck({ phase: 'checking', text: '正在检查凭据与会话历史读取权限…' });
    try {
      const result = await api.checkFeishu(settings, secret);
      if (revision === checkRevision.current)
        setFeishuCheck({ phase: result.ok ? 'success' : 'error', text: result.message });
    } catch (error) {
      if (revision === checkRevision.current)
        setFeishuCheck({
          phase: 'error',
          text: error instanceof Error ? error.message : '连接检查失败，请重试。',
        });
    } finally {
      setBusy('');
    }
  }
  const stopped = snapshot?.status.phase === 'stopped';
  const active = snapshot && snapshot.status.phase !== 'stopped';
  const inform = (text: string) => setNotice({ text, error: false });
  async function save(apply: boolean) {
    if (!settings || !cache.current) return;
    await run(apply ? '应用配置' : '保存缓存', async () => {
      if (apply) await cache.current!.apply();
      else await cache.current!.flush();
      inform(apply ? '配置已应用。可以回到总览启动连接。' : '填写内容已缓存到本机，应用后生效。');
    });
  }
  const button = (
    label: string,
    action: () => Promise<void>,
    primary = false,
    disabled = false,
  ) => (
    <button
      className={primary ? 'button primary' : 'button'}
      disabled={Boolean(busy) || disabled}
      onClick={() => {
        action().catch(() => {});
      }}
    >
      {label}
    </button>
  );
  function codexForm() {
    if (!settings) return null;
    return (
      <section className="panel">
        <div className="section-heading">
          <span className="eyebrow">01 / CODEX</span>
          <h2>连接你的 Codex</h2>
          <p>复用这台 Mac 上的安装和登录状态。</p>
        </div>
        <label className="field">
          Codex 可执行文件
          <div className="input-action">
            <input
              value={settings.codexBinary}
              onChange={(e) => update({ ...settings, codexBinary: e.target.value })}
            />
            {button('选择文件', () =>
              run('选择文件', async () => {
                const path = await api.chooseCodex();
                if (path && settingsRef.current)
                  update({ ...settingsRef.current, codexBinary: path });
              }),
            )}
          </div>
        </label>
        <div className="helper">
          选择应用包内 Contents / Resources / codex。若尚未登录，请先打开 Codex 完成登录。
        </div>
        <div className="action-row">
          {button('检查版本', () =>
            run('检查 Codex', async () => {
              const result = await api.checkCodex(settings.codexBinary);
              setNotice({ text: result.message, error: !result.ok });
            }),
          )}
        </div>
      </section>
    );
  }
  function feishuForm() {
    if (!settings) return null;
    const fields: {
      key: keyof DesktopSettings['feishu'];
      label: string;
      placeholder: string;
      hint: string;
    }[] = [
      {
        key: 'appId',
        label: 'App ID',
        placeholder: 'cli_…',
        hint: '飞书开放平台 → 凭证与基础信息',
      },
      {
        key: 'tenantKey',
        label: 'Tenant Key',
        placeholder: '企业标识',
        hint: '机器人所属企业的 tenant_key',
      },
      {
        key: 'allowedOpenId',
        label: '允许使用的用户',
        placeholder: 'ou_…',
        hint: '只接受此用户的消息与卡片操作',
      },
      {
        key: 'testChatId',
        label: '机器人单聊',
        placeholder: 'oc_…',
        hint: '任务结果将发送到此专用单聊',
      },
    ];
    return (
      <section className="panel">
        <div className="section-heading">
          <span className="eyebrow">FEISHU CONNECTION</span>
          <h2>配置机器人连接</h2>
          <p>连接信息只保存在这台 Mac 上，不能从飞书修改。</p>
        </div>
        <div className="form-grid">
          {fields.map((field) => (
            <label className="field" key={field.key}>
              {field.label}
              <input
                spellCheck={false}
                placeholder={field.placeholder}
                value={settings.feishu[field.key]}
                onChange={(e) => {
                  resetFeishuCheck();
                  update({
                    ...settings,
                    feishu: { ...settings.feishu, [field.key]: e.target.value },
                  });
                }}
              />
              <small>{field.hint}</small>
            </label>
          ))}
          <label className="field full">
            App Secret{' '}
            <input
              type="password"
              autoComplete="new-password"
              placeholder={
                snapshot?.hasSecret ? '已保存；留空保持原值，输入可替换' : '填写应用密钥'
              }
              value={secret}
              onChange={(e) => {
                resetFeishuCheck();
                if (closingRef.current) return;
                secretRef.current = e.target.value;
                setSecret(e.target.value);
                editorRevision.current =
                  cache.current?.update(settings, e.target.value) ?? editorRevision.current;
                setDirty(true);
              }}
            />
            <small>使用 macOS Keychain 保护，已保存的密钥不会回显。</small>
          </label>
        </div>
        <div className="inline-note">
          在飞书后台启用长连接，订阅消息事件与 card.action.trigger 回调，并开通
          im:message.history:readonly 后发布生效。
        </div>
        {snapshot?.hasDesktopNotifications && (
          <div className="inline-note">
            已保留原部署的桌面任务通知。更换上方任一身份或会话字段后，新档案不会接收原桌面通知；
            原通知脚本与缓存目录会保留。
          </div>
        )}
        <div className="action-row">
          {button(
            feishuCheck?.phase === 'checking' ? '正在检查…' : '检查连接配置',
            checkConnection,
          )}
          <span className="helper">不会发送测试消息</span>
        </div>
        {feishuCheck && (
          <div
            ref={checkResultRef}
            className={`check-feedback ${feishuCheck.phase}`}
            role={feishuCheck.phase === 'error' ? 'alert' : 'status'}
            aria-atomic="true"
          >
            <strong>
              {feishuCheck.phase === 'checking'
                ? '检查中'
                : feishuCheck.phase === 'success'
                  ? '检查通过'
                  : '检查未通过'}
            </strong>
            <span>{feishuCheck.text}</span>
          </div>
        )}
      </section>
    );
  }
  function projectsForm() {
    if (!settings) return null;
    function changeProject(index: number, field: 'key' | 'name' | 'root', value: string) {
      if (settings)
        update({
          ...settings,
          projects: settings.projects.map((project, i) =>
            i === index ? { ...project, [field]: value } : project,
          ),
        });
    }
    function changePermissions(index: number, policy: RemotePermissions) {
      if (settings)
        update({
          ...settings,
          projects: settings.projects.map((p, i) =>
            i === index ? { key: p.key, name: p.name, root: p.root, remotePermissions: policy } : p,
          ),
        });
    }
    return (
      <section className="panel">
        <div className="section-heading split">
          <div>
            <span className="eyebrow">LOCAL WORKSPACES</span>
            <h2>选择可以连接的项目</h2>
            <p>每个项目单独授权，新增项目默认关闭远程执行。</p>
          </div>
          <div className="action-row">
            {button(
              projectStatus.loading ? '刷新中…' : '刷新项目',
              refreshProjects,
              false,
              projectStatus.loading,
            )}
            {button('＋ 添加项目', () =>
              run('选择目录', async () => {
                const root = await api.chooseDirectory();
                const latest = settingsRef.current;
                if (!root || !latest) return;
                if (latest.projects.some((p) => p.root === root)) {
                  inform('这个目录已经在项目列表中。');
                  return;
                }
                if (latest.projects.length >= 100)
                  throw new Error('最多保留 100 个项目，请先移除不用的项目。');
                update({
                  ...latest,
                  hiddenProjectRoots: latest.hiddenProjectRoots.filter((p) => p !== root),
                  projects: appendProject(latest.projects, {
                    key: `project-${latest.projects.length + 1}`,
                    name: root.split('/').pop() || '项目',
                    root,
                  }),
                });
              }),
            )}
          </div>
        </div>
        <p className="helper">
          自动读取本机 Codex 的项目目录；回到 App 或每隔 30
          秒刷新。新增项目需在本机授权并应用后才能执行任务。
        </p>
        {projectStatus.text && (
          <p
            className={`project-feedback ${projectStatus.error ? 'error' : ''}`}
            role={projectStatus.error ? 'alert' : 'status'}
          >
            {projectStatus.text}
          </p>
        )}
        {settings.projects.length === 0 ? (
          <div className="empty">
            <Icon name="projects" />
            <h3>添加第一个本地项目</h3>
            <p>选择一个目录，然后决定是否允许飞书发起任务。</p>
          </div>
        ) : (
          <div className="project-list">
            {settings.projects.map((project, index) => (
              <article className="project-row" key={index}>
                <div className="project-index">{String(index + 1).padStart(2, '0')}</div>
                <div className="project-body">
                  <div className="form-grid">
                    <label className="field">
                      项目名称
                      <input
                        value={project.name}
                        onChange={(e) => changeProject(index, 'name', e.target.value)}
                      />
                    </label>
                    <label className="field">
                      项目标识
                      <input
                        value={project.key}
                        onChange={(e) => changeProject(index, 'key', e.target.value)}
                      />
                    </label>
                  </div>
                  <p className="path" title={project.root}>
                    {project.root}
                  </p>
                  <div className="project-footer">
                    <label className="field">
                      远程任务权限
                      <select
                        value={
                          project.remotePermissions?.mode ??
                          (project.remoteWrite ? 'legacy' : 'disabled')
                        }
                        onChange={(e) =>
                          changePermissions(index, {
                            ...projectPermissions(project),
                            mode: e.target.value as RemotePermissions['mode'],
                          })
                        }
                      >
                        {project.remoteWrite && !project.remotePermissions && (
                          <option value="legacy" disabled>
                            旧版：允许执行，按需审批
                          </option>
                        )}
                        <option value="disabled">禁止远程执行</option>
                        <option value="read-only">只读分析</option>
                        <option value="workspace-write">允许修改项目文件</option>
                      </select>
                    </label>
                    <label className="toggle-label">
                      <input
                        type="checkbox"
                        disabled={!project.remotePermissions || !canExecuteProject(project)}
                        checked={projectPermissions(project).networkAccess}
                        onChange={(e) =>
                          changePermissions(index, {
                            ...projectPermissions(project),
                            networkAccess: e.target.checked,
                          })
                        }
                      />
                      <span className="toggle" />
                      <span>允许任务联网</span>
                    </label>
                    <button
                      className="text-button danger"
                      onClick={() => {
                        if (
                          settings.hiddenProjectRoots.length >= 500 &&
                          !settings.hiddenProjectRoots.includes(project.root)
                        ) {
                          setNotice({
                            error: true,
                            text: '已达到移除记录上限，暂时无法移除更多项目。',
                          });
                          return;
                        }
                        update({
                          ...settings,
                          hiddenProjectRoots: [
                            ...new Set([...settings.hiddenProjectRoots, project.root]),
                          ],
                          projects: settings.projects.filter((_, i) => i !== index),
                        });
                      }}
                    >
                      移除
                    </button>
                  </div>
                  {!project.remotePermissions && project.remoteWrite && (
                    <p className="helper">
                      保留旧版审批行为；选择新的权限后应用，才会启用严格限制。
                    </p>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
        <label className="field concurrency-field">
          最多同时执行
          <select
            value={settings.maxConcurrentTasks}
            onChange={(e) => update({ ...settings, maxConcurrentTasks: Number(e.target.value) })}
          >
            {Array.from({ length: 8 }, (_, i) => (
              <option key={i + 1} value={i + 1}>
                {i + 1} 个任务
              </option>
            ))}
          </select>
        </label>
        <div className="inline-note">
          仅在本机修改，停止服务后应用。等待审批、输入和状态待核对的任务仍占名额；同一会话或
          checkout 串行，独立目录可并行。
          新权限限制不可通过飞书审批扩大。只读分析禁止文件写入；联网开关控制命令网络与网页搜索，不影响模型连接。文件读取范围由
          Codex 沙箱决定。
        </div>
      </section>
    );
  }
  function preferences() {
    const labels: Record<LoginItemState['status'], string> = {
      enabled: '已开启',
      'not-registered': '未开启',
      'requires-approval': '等待系统批准',
      'not-found': '登录项不可用',
      unavailable: '暂不可用',
      error: '读取失败',
    };
    return (
      <>
        <div className="page-title">
          <span className="eyebrow">APP PREFERENCES</span>
          <h1>应用设置</h1>
          <p>这台 Mac 上的启动与退出行为。</p>
        </div>
        <section className="panel">
          <div className="section-heading split">
            <div>
              <span className="eyebrow">STARTUP</span>
              <h2>开机自启</h2>
            </div>
            <span className={`status-pill ${loginState?.enabled ? 'connected' : ''}`} role="status">
              {loginLoading
                ? '正在读取 / 更新…'
                : loginState
                  ? labels[loginState.status]
                  : '正在读取…'}
            </span>
          </div>
          <label className="toggle-label startup-toggle">
            <input
              type="checkbox"
              checked={loginState?.requested ?? false}
              disabled={
                Boolean(busy) ||
                loginLoading ||
                Boolean(loginError) ||
                !loginState?.supported ||
                loginState.status === 'error' ||
                (!loginState.canEnable && !loginState.requested)
              }
              onChange={(e) => {
                changeLoginItem(e.target.checked).catch(() => {});
              }}
            />
            <span className="toggle" />
            <span>登录 Mac 后自动打开 CodexConnector</span>
          </label>
          <p className="helper">
            开关即时生效，由 macOS 保存，无需应用飞书配置。开机后需要先登录当前用户。
          </p>
          <div
            className={`inline-note ${loginError || loginState?.status === 'error' ? 'error' : ''}`}
            role={loginError ? 'alert' : 'status'}
          >
            {loginError || loginState?.message || '正在读取系统登录项…'}
          </div>
          <div className="action-row">
            {button('刷新系统状态', refreshLoginItem, false, loginLoading)}
          </div>
          <div className="startup-behavior">
            <h3>打开后显示控制台</h3>
            <p>
              飞书连接仍由你点击“启动连接”开启。退出 App
              会停止网关；关闭窗口即退出，不会隐藏到后台继续运行。
            </p>
          </div>
        </section>
      </>
    );
  }
  function overview() {
    if (!snapshot || !settings) return null;
    const { status } = snapshot;
    const applied = snapshot.activeSettings ?? settings;
    return (
      <>
        <section className="hero">
          <div>
            <span className="eyebrow">YOUR LOCAL CONNECTION</span>
            <h1>
              让连接，
              <br />
              <em>保持简单。</em>
            </h1>
            <p>从飞书发起，让这台 Mac 上的 Codex 执行。</p>
            <div className="action-row">
              {active
                ? button(
                    '停止连接',
                    () =>
                      run('停止服务', async () => {
                        const value = await api.stop();
                        setSnapshot((s) => (s ? { ...s, status: value } : s));
                      }),
                    false,
                  )
                : button(
                    '启动连接',
                    () =>
                      run('启动服务', async () => {
                        const value = await api.start();
                        setSnapshot((s) => (s ? { ...s, status: value } : s));
                      }),
                    true,
                    !snapshot.configured || snapshot.hasDraft || dirty,
                  )}
            </div>
          </div>
          <div className="connection-art" aria-hidden="true">
            <div className={`orbit ${status.phase === 'ready' ? 'online' : ''}`}>
              <div className="orbit-core">
                C<span>CONNECTOR</span>
              </div>
              <span className="satellite top">飞书</span>
              <span className="satellite bottom">Codex</span>
            </div>
            <small>
              {status.phase === 'ready' ? 'CONNECTED ON YOUR MAC' : 'READY WHEN YOU ARE'}
            </small>
          </div>
        </section>
        <div className="status-grid">
          <section className="status-cell">
            <span className="eyebrow">FEISHU</span>
            <h3>
              <i className={status.feishuConnected ? 'dot green' : 'dot'} />
              {status.feishuConnected ? '长连接在线' : '尚未连接'}
            </h3>
            <p>接收消息与卡片操作</p>
          </section>
          <section className="status-cell">
            <span className="eyebrow">CODEX</span>
            <h3>
              <i className={status.rpcReady ? 'dot green' : 'dot'} />
              {status.rpcReady ? '执行后端就绪' : '尚未就绪'}
            </h3>
            <p>独立管理飞书任务</p>
          </section>
          <section className="status-cell">
            <span className="eyebrow">TASKS</span>
            <h3>
              {status.pending}
              <span className="metric-unit"> 个未完成</span>
            </h3>
            <p>
              {status.tasks.length
                ? status.tasks
                    .map((t) => `${taskLabels[t.status] ?? t.status} ${t.count}`)
                    .join(' · ')
                : '暂无任务记录'}
            </p>
          </section>
        </div>
        {status.error && <div className="inline-note error">{status.error}</div>}
        <section className="panel compact">
          <div className="split">
            <div>
              <h3>本地项目</h3>
              <p>
                {applied.projects.length} 个项目 ·{' '}
                {applied.projects.filter(canExecuteProject).length} 个允许远程执行 · 最多同时执行{' '}
                {applied.maxConcurrentTasks} 个任务
              </p>
            </div>
            <button className="text-button" onClick={() => setPage('projects')}>
              管理项目 <Icon name="arrow" />
            </button>
          </div>
        </section>
        {!snapshot.configured && (
          <section className="panel compact">
            <div className="split">
              <p>还没有连接配置。完成首次设置后即可开始。</p>
              <button className="button primary" onClick={() => setPage('setup')}>
                开始设置
              </button>
            </div>
          </section>
        )}
      </>
    );
  }
  function setup() {
    return (
      <>
        <div className="wizard-steps">
          {['Codex', '飞书连接', '本地项目', '检查与启动'].map((label, i) => (
            <button key={label} className={step === i ? 'selected' : ''} onClick={() => setStep(i)}>
              <span>{i + 1}</span>
              {label}
            </button>
          ))}
        </div>
        {step === 0 ? (
          codexForm()
        ) : step === 1 ? (
          feishuForm()
        ) : step === 2 ? (
          projectsForm()
        ) : (
          <section className="panel">
            <span className="eyebrow">READY TO CONNECT</span>
            <h2>准备好建立连接</h2>
            <p>应用配置后，点击启动。只有飞书长连接与 Codex 后端都就绪时才显示“已连接”。</p>
            <dl className="review">
              <div>
                <dt>机器人</dt>
                <dd>{settings?.feishu.appId || '未填写'}</dd>
              </div>
              <div>
                <dt>本地项目</dt>
                <dd>{settings?.projects.length ?? 0} 个</dd>
              </div>
              <div>
                <dt>退出行为</dt>
                <dd>停止飞书任务与连接，Codex 桌面任务继续</dd>
              </div>
            </dl>
            <div className="action-row">
              {button('应用配置', () => save(true), true, !stopped)}
              {button(
                '启动连接',
                () =>
                  run('启动服务', async () => {
                    await api.start();
                    setPage('overview');
                  }),
                false,
                !snapshot?.configured || snapshot.hasDraft || dirty,
              )}
            </div>
          </section>
        )}
        <div className="wizard-bottom">
          <button
            className="text-button"
            disabled={step === 0}
            onClick={() => setStep((i) => i - 1)}
          >
            上一步
          </button>
          {button('立即保存', () => save(false))}
          {step < 3 && (
            <button className="button primary" onClick={() => setStep((i) => i + 1)}>
              下一步 <Icon name="arrow" />
            </button>
          )}
        </div>
      </>
    );
  }
  return (
    <div
      className="app-shell"
      inert={closing}
      onBlurCapture={() => {
        cache.current?.flush().catch(() => {});
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            C<span>↗</span>
          </div>
          <div>
            Codex<span>Connector</span>
          </div>
        </div>
        <div className="sidebar-caption">本地控制台</div>
        <nav>
          {(['overview', 'feishu', 'projects', 'preferences', 'logs'] as Page[]).map((item) => (
            <button
              key={item}
              className={page === item ? 'nav-item selected' : 'nav-item'}
              onClick={() => {
                setPage(item);
                if (item === 'logs')
                  run('读取日志', async () => setLogs(await api.logs())).catch(() => {});
              }}
            >
              <Icon name={item} />
              {pageLabels[item]}
            </button>
          ))}
        </nav>
        <button
          className={page === 'setup' ? 'nav-item setup selected' : 'nav-item setup'}
          onClick={() => setPage('setup')}
        >
          <Icon name="setup" />
          配置向导
        </button>
        <div className="sidebar-bottom">
          <span className="local-badge">
            <i className="dot green" /> 数据保存在本机
          </span>
          <small>macOS · 内部测试版 0.1</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>{pageLabels[page]}</span>
          <div>
            {snapshot && (
              <span
                className={`cache-status ${cacheState === 'error' ? 'error' : ''}`}
                role="status"
              >
                {closing
                  ? '正在保存并退出…'
                  : cacheState === 'error'
                    ? '缓存失败'
                    : cacheState === 'saving' || cacheState === 'pending'
                      ? '正在缓存…'
                      : snapshot.hasDraft
                        ? '已缓存 · 待应用'
                        : snapshot.configured
                          ? '配置已保存'
                          : '自动缓存已开启'}
              </span>
            )}
            <span
              className={`status-pill ${snapshot?.status.phase === 'ready' ? 'connected' : ''}`}
            >
              <i className="dot" />
              {snapshot ? phaseLabels[snapshot.status.phase] : '正在加载'}
            </span>
          </div>
        </header>
        <div className="content">
          {cacheState === 'error' && (
            <div className="notice error" role="alert">
              <span>本地缓存保存失败。请检查 Keychain 授权和数据目录写入权限，再重试保存。</span>
              {button('重试保存', () => save(false))}
            </div>
          )}
          {notice && (
            <div
              className={`notice ${notice.error ? 'error' : ''}`}
              role={notice.error ? 'alert' : 'status'}
            >
              <span>{notice.text}</span>
              <button aria-label="关闭提示" onClick={() => setNotice(null)}>
                ×
              </button>
            </div>
          )}
          {busy && busy !== '检查飞书' && (
            <div className="busy" role="status">
              <span />
              {busy}…
            </div>
          )}
          {settings && snapshot ? (
            <>
              {page === 'overview' && overview()}
              {page === 'preferences' && preferences()}
              {page === 'setup' && setup()}
              {page === 'feishu' && (
                <>
                  <div className="page-title">
                    <span className="eyebrow">CONNECTION SETTINGS</span>
                    <h1>飞书连接</h1>
                  </div>
                  {feishuForm()}
                  {codexForm()}
                </>
              )}
              {page === 'projects' && (
                <>
                  <div className="page-title">
                    <span className="eyebrow">YOUR WORKSPACES</span>
                    <h1>本地项目</h1>
                  </div>
                  {projectsForm()}
                </>
              )}
              {(page === 'projects' || page === 'feishu') && (
                <div className="save-bar">
                  <span>
                    {active
                      ? '配置自动缓存到本机；停止服务后应用。'
                      : '配置自动缓存到本机，应用后生效。'}
                  </span>
                  <div>
                    {button('立即保存', () => save(false))}
                    {button('应用配置', () => save(true), true, !stopped)}
                  </div>
                </div>
              )}
              {page === 'logs' && (
                <>
                  <div className="page-title">
                    <span className="eyebrow">OBSERVABILITY</span>
                    <h1>日志与诊断</h1>
                    <p>展示连接状态与错误摘要，不包含消息正文和密钥。</p>
                  </div>
                  <div className="action-row">
                    {button('刷新日志', () =>
                      run('读取日志', async () => setLogs(await api.logs())),
                    )}
                    {button('复制诊断摘要', () =>
                      run('复制摘要', async () => {
                        await api.copyDiagnostics();
                        inform('诊断摘要已复制。');
                      }),
                    )}
                    {button('打开数据目录', () => run('打开目录', () => api.openData()))}
                  </div>
                  <div className="log-panel">
                    <div className="log-title">
                      <i className="dot" /> RUNTIME LOG<span>{logs.length} 条</span>
                    </div>
                    <pre>
                      {logs.length
                        ? logs.join('\n')
                        : '暂无运行日志。启动连接后，状态变化会显示在这里。'}
                    </pre>
                  </div>
                  <p className="helper path">{snapshot.dataDir}</p>
                </>
              )}
            </>
          ) : (
            <div className="empty">
              <h2>正在打开本地控制台</h2>
              <p>读取配置和运行状态…</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
