import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  CheckResult,
  DesktopApi,
  DesktopSettings,
  DesktopSnapshot,
  DesktopStatus,
  LoginItemState,
} from '../../../src/desktop/contracts.js';
import './style.css';
import { ConnectorMark, Icon } from './icons.js';
import { FeedbackViewport, type FeedbackNotice } from './feedback.js';
import { SelectField, TextInput, type SelectOption } from './form-controls.js';
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
const permissionOptions: SelectOption[] = [
  { value: 'disabled', label: '禁止远程执行', description: '保留项目，不接受飞书发起的任务' },
  { value: 'read-only', label: '只读分析', description: '允许分析代码，不允许修改文件' },
  {
    value: 'workspace-write',
    label: '允许修改项目文件',
    description: '允许在授权的项目范围内写入',
  },
];
function App() {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot | null>(null);
  const [settings, setSettings] = useState<DesktopSettings | null>(null);
  const [secret, setSecret] = useState('');
  const [projectlessCheck, setProjectlessCheck] = useState<{
    binary: string;
    result: CheckResult;
  } | null>(null);
  const secretRef = useRef('');
  const cache = useRef<DesktopDraftCache | null>(null);
  const [cacheState, setCacheState] = useState<DraftCacheState>('saved');
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [page, setPage] = useState<Page>('overview');
  const contentRef = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<FeedbackNotice | null>(null);
  const dismissNotice = useCallback(() => setNotice(null), []);
  const [logs, setLogs] = useState<string[]>([]);
  const [loginState, setLoginState] = useState<LoginItemState | null>(null);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const loginPending = useRef(false);
  const lastLoginError = useRef('');
  const settingsRef = useRef<DesktopSettings | null>(null);
  const editorRevision = useRef(0);
  const mounted = useRef(false);
  const refreshing = useRef(false);
  const lastProjectError = useRef('');
  const [projectStatus, setProjectStatus] = useState({ loading: false, error: false, text: '' });
  const [unavailableProjectRoots, setUnavailableProjectRoots] = useState<string[]>([]);
  const [feishuCheck, setFeishuCheck] = useState<{
    phase: 'checking' | 'success' | 'error';
    text: string;
  } | null>(null);
  const checkRevision = useRef(0);
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
  const runtimeError = snapshot?.status.error;
  useEffect(() => {
    if (runtimeError) setNotice({ text: runtimeError, error: true, source: 'runtime' });
    else setNotice((current) => (current?.source === 'runtime' ? null : current));
  }, [runtimeError]);
  const refreshLoginItem = useCallback(
    async (manual = false) => {
      if (!api || loginPending.current) return;
      loginPending.current = true;
      setLoginLoading(true);
      setLoginError('');
      try {
        const value = await api.loginItem();
        setLoginState(value);
        if (value.status === 'error') throw new Error(value.message);
        lastLoginError.current = '';
        if (manual) setNotice({ text: value.message, error: false, source: 'login' });
        else
          setNotice((current) => (current?.source === 'login' && current.error ? null : current));
      } catch (error) {
        const text = error instanceof Error ? error.message : '暂时无法读取自启状态，请重试。';
        setLoginError(text);
        if (manual || text !== lastLoginError.current)
          setNotice((current) =>
            manual
              ? { text, error: true, source: 'login' }
              : (current ?? { text, error: true, source: 'login' }),
          );
        lastLoginError.current = text;
      } finally {
        loginPending.current = false;
        setLoginLoading(false);
      }
    },
    [api],
  );
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
    setNotice(null);
    try {
      const value = await api.setLoginItem(enabled);
      setLoginState(value);
      if (value.status === 'error') throw new Error(value.message);
      lastLoginError.current = '';
      setNotice({ text: value.message, error: false, source: 'login' });
    } catch (error) {
      const text = error instanceof Error ? error.message : '修改自启状态失败，请重试。';
      setLoginError(text);
      lastLoginError.current = text;
      setNotice({ text, error: true, source: 'login' });
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
  const refreshProjects = useCallback(
    async (manual = false) => {
      const current = settingsRef.current;
      if (!api || !current || refreshing.current || closingRef.current) return;
      refreshing.current = true;
      setProjectStatus({ loading: true, error: false, text: '正在读取本机 Codex 项目…' });
      try {
        const discovery = await api.discoverProjects(
          [...current.projects.map((p) => p.root), ...current.hiddenProjectRoots],
          current.feishu,
        );
        if (!mounted.current || !settingsRef.current || closingRef.current) return;
        const latest = settingsRef.current;
        if (JSON.stringify(latest.feishu) !== JSON.stringify(current.feishu)) {
          if (manual)
            setNotice({
              text: '飞书身份已变化，请刷新对应项目。',
              error: false,
              source: 'projects',
            });
          setProjectStatus({
            loading: false,
            error: false,
            text: '飞书身份已变化，请刷新对应项目。',
          });
          return;
        }
        const next = mergeDiscoveredProjects(latest, discovery);
        if (next !== latest) update(next);
        const unavailableRoots = discovery.unavailableRoots ?? [];
        setUnavailableProjectRoots(unavailableRoots);
        const unavailableConfigured = next.projects.filter((p) =>
          unavailableRoots.includes(p.root),
        ).length;
        const text =
          `已刷新 · 发现 ${discovery.projects.length} 个项目（含远程创建）` +
          (discovery.warning ? ` · ${discovery.warning}` : '') +
          (discovery.unavailable ? ` · ${discovery.unavailable} 个目录暂不可用` : '') +
          (unavailableConfigured ? ` · 已配置项目中有 ${unavailableConfigured} 个目录不可用` : '') +
          (next.projects.length >= 100 ? ' · 最多保留 100 个项目' : '');
        setProjectStatus({ loading: false, error: false, text });
        lastProjectError.current = '';
        if (manual) setNotice({ text, error: false, source: 'projects' });
        else
          setNotice((current) =>
            current?.source === 'projects' && current.error ? null : current,
          );
      } catch (error) {
        if (mounted.current) {
          const text =
            error instanceof Error ? error.message : '项目读取失败，请稍后刷新或手动添加。';
          setProjectStatus({ loading: false, error: true, text });
          if (manual || text !== lastProjectError.current)
            setNotice((current) =>
              manual
                ? { text, error: true, source: 'projects' }
                : (current ?? { text, error: true, source: 'projects' }),
            );
          lastProjectError.current = text;
        }
      } finally {
        refreshing.current = false;
      }
    },
    [api],
  );
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
    contentRef.current?.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [page, step]);
  function resetFeishuCheck() {
    checkRevision.current++;
    setFeishuCheck(null);
    setNotice((current) => (current?.source === 'feishu' ? null : current));
  }
  async function checkConnection() {
    if (!settings || busy) return;
    const revision = ++checkRevision.current;
    setBusy('检查飞书');
    setNotice(null);
    setFeishuCheck({ phase: 'checking', text: '正在检查凭据与会话历史读取权限…' });
    try {
      const result = await api.checkFeishu(settings, secret);
      if (revision === checkRevision.current) {
        setFeishuCheck({ phase: result.ok ? 'success' : 'error', text: result.message });
        setNotice({ text: result.message, error: !result.ok, source: 'feishu' });
      }
    } catch (error) {
      if (revision === checkRevision.current) {
        const text = error instanceof Error ? error.message : '连接检查失败，请重试。';
        setFeishuCheck({ phase: 'error', text });
        setNotice({ text, error: true, source: 'feishu' });
      }
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
    label: ReactNode,
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
  const startReason = busy
    ? `正在${busy}，请稍候。`
    : !stopped
      ? '连接正在运行或停止中。请先在总览停止连接，再重新启动。'
      : !snapshot?.configured
        ? '首次配置尚未应用。请完成连接信息与项目设置，再点击「应用配置」。'
        : snapshot.hasDraft || dirty
          ? '有尚未应用的修改。自动缓存只保存填写内容，请先应用配置，再启动连接。'
          : '';
  function startButton(primary = true) {
    return (
      <button
        className={primary ? 'button primary' : 'button'}
        disabled={Boolean(startReason)}
        title={startReason || undefined}
        aria-describedby={
          startReason || !settings?.projects.length ? 'connection-guidance' : undefined
        }
        onClick={() => {
          run('启动服务', async () => {
            const value = await api.start();
            setSnapshot((s) => (s ? { ...s, status: value } : s));
            setPage('overview');
          }).catch(() => {});
        }}
      >
        <Icon name="power" />
        {busy === '启动服务' ? '正在启动…' : '启动连接'}
      </button>
    );
  }
  function connectionHint(inWizard = false) {
    if (!settings || !snapshot) return null;
    const noProjects = settings.projects.length === 0;
    if (!startReason && !noProjects) return null;
    return (
      <div id="connection-guidance" className={`connection-hint ${startReason ? 'attention' : ''}`}>
        <span className="connection-hint-icon" aria-hidden="true">
          i
        </span>
        <div>
          <strong>
            {busy ? '操作进行中' : startReason ? '启动前还需一步' : '尚未添加本地项目'}
          </strong>
          {startReason && <p>{startReason}</p>}
          {noProjects && (
            <p>
              {settings.projectless?.enabled !== false
                ? '没有本地项目也能连接。普通聊天能力检查通过后，直接在飞书发送消息即可开始。'
                : settings.remoteProjectCreation.enabled
                  ? '本地项目列表为空。连接后可从飞书新建项目，也可以现在添加本地目录。'
                  : '当前没有本地项目。添加后才能向该项目发起任务；也可先应用连接配置，稍后添加。'}
            </p>
          )}
          <div className="connection-hint-actions">
            {!busy && startReason && !inWizard && (
              <button
                className="text-button"
                onClick={() => {
                  setStep(
                    !snapshot.configured
                      ? !settings.codexBinary.trim()
                        ? 0
                        : Object.values(settings.feishu).some((value) => !value.trim()) ||
                            (!snapshot.hasSecret && !secret.trim())
                          ? 1
                          : noProjects && !settings.remoteProjectCreation.enabled
                            ? 2
                            : 3
                      : 3,
                  );
                  setPage('setup');
                }}
              >
                {snapshot.configured ? '检查并应用' : '继续配置'} <Icon name="arrow" />
              </button>
            )}
            {!busy && active && inWizard && (
              <button className="text-button" onClick={() => setPage('overview')}>
                前往总览停止连接 <Icon name="arrow" />
              </button>
            )}
            {!busy && noProjects && (
              <button
                className="text-button"
                onClick={() => (inWizard ? setStep(2) : setPage('projects'))}
              >
                添加本地项目 <Icon name="arrow" />
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }
  function codexForm() {
    if (!settings) return null;
    return (
      <section className="panel">
        <div className="section-heading">
          <span className="eyebrow">CODEX RUNTIME</span>
          <h2>连接你的 Codex</h2>
          <p>复用这台 Mac 上的安装和登录状态。</p>
        </div>
        <div className="field">
          <label htmlFor="codex-binary">Codex 可执行文件</label>
          <div className="input-action">
            <TextInput
              id="codex-binary"
              spellCheck={false}
              placeholder="选择本机 Codex 可执行文件"
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
        </div>
        <div className="helper">
          支持自动识别新旧 Codex 安装目录，也可手动选择可执行文件。若尚未登录，请先打开 Codex
          完成登录。
        </div>
        {snapshot?.codexPathNotice && <div className="helper">{snapshot.codexPathNotice}</div>}
        <div className="action-row">
          {button('检查版本与协议', () =>
            run('检查 Codex', async () => {
              const result = await api.checkCodex(settings.codexBinary);
              if (settingsRef.current?.codexBinary !== settings.codexBinary) return;
              if (result.binary && result.binary !== settings.codexBinary)
                update({ ...settingsRef.current, codexBinary: result.binary });
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
              <span id={`feishu-${field.key}-label`}>{field.label}</span>
              <TextInput
                aria-labelledby={`feishu-${field.key}-label`}
                aria-describedby={`feishu-${field.key}-hint`}
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
              <small id={`feishu-${field.key}-hint`}>{field.hint}</small>
            </label>
          ))}
          <label className="field full">
            <span id="feishu-secret-label">App Secret</span>
            <TextInput
              aria-labelledby="feishu-secret-label"
              aria-describedby="feishu-secret-hint"
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
            <small id="feishu-secret-hint">使用 macOS Keychain 保护，已保存的密钥不会回显。</small>
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
          <div className={`check-feedback ${feishuCheck.phase}`}>
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
      <>
        <section className="panel workspaces-panel">
          <div className="section-heading split">
            <div>
              <span className="eyebrow">LOCAL WORKSPACES</span>
              <h2>选择可以连接的项目</h2>
              <p>每个项目单独授权；远程创建的项目沿用本机预设权限。</p>
            </div>
            <div className="action-row">
              {button(
                <>
                  <Icon name="refresh" />
                  {projectStatus.loading ? '刷新中…' : '刷新项目'}
                </>,
                () => refreshProjects(true),
                false,
                projectStatus.loading,
              )}
              {button(
                <>
                  <Icon name="plus" />
                  添加项目
                </>,
                () =>
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
            自动读取本机 Codex 和远程创建的项目；回到 App 或每隔 30 秒刷新。
            本机添加的项目需授权并应用；远程项目创建成功后即可按预设权限使用。
          </p>
          {projectStatus.text && (
            <p className={`project-feedback ${projectStatus.error ? 'error' : ''}`}>
              {projectStatus.text}
            </p>
          )}
          {settings.projects.length === 0 ? (
            <div className="empty">
              <Icon name="projects" />
              <h3>尚未添加本地项目</h3>
              <p>普通聊天无需选择目录；需要处理文件时，再添加项目并授权。</p>
            </div>
          ) : (
            <div className="project-list">
              {settings.projects.map((project, index) => (
                <article className="project-row" key={index}>
                  <div className="project-index" aria-hidden="true">
                    <Icon name="projects" />
                  </div>
                  <div className="project-body">
                    <div className="form-grid">
                      <label className="field">
                        项目名称
                        <TextInput
                          placeholder="例如：我的项目"
                          value={project.name}
                          onChange={(e) => changeProject(index, 'name', e.target.value)}
                        />
                      </label>
                      <label className="field">
                        项目标识
                        <TextInput
                          spellCheck={false}
                          placeholder="例如：my-project"
                          value={project.key}
                          onChange={(e) => changeProject(index, 'key', e.target.value)}
                        />
                      </label>
                    </div>
                    <p className="path" title={project.root}>
                      {project.root}
                    </p>
                    {unavailableProjectRoots.includes(project.root) && (
                      <div
                        className={`project-availability ${canExecuteProject(project) ? 'error' : ''}`}
                        role="status"
                      >
                        <strong>目录不可用</strong>
                        <span>
                          {canExecuteProject(project)
                            ? '该项目已授权。请恢复目录，或关闭远程执行后应用配置，再启动连接。'
                            : '已禁止远程执行，不影响连接启动。挂载磁盘或恢复目录后刷新即可。'}
                        </span>
                      </div>
                    )}
                    <div className="project-footer">
                      <SelectField
                        label="远程任务权限"
                        value={
                          project.remotePermissions?.mode ??
                          (project.remoteWrite ? 'legacy' : 'disabled')
                        }
                        onChange={(mode) =>
                          changePermissions(index, {
                            ...projectPermissions(project),
                            mode: mode as RemotePermissions['mode'],
                          })
                        }
                        options={
                          project.remoteWrite && !project.remotePermissions
                            ? [
                                {
                                  value: 'legacy',
                                  label: '旧版：允许执行，按需审批',
                                  disabled: true,
                                },
                                ...permissionOptions,
                              ]
                            : permissionOptions
                        }
                      />
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
        </section>
        <section className="panel conversation-settings">
          <div className="section-heading">
            <span className="eyebrow">CONVERSATIONS</span>
            <h2>无项目对话</h2>
            <p>直接聊天，也可以从飞书的项目列表切换到「无项目」。</p>
          </div>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={settings.projectless?.enabled !== false}
              onChange={(event) =>
                update({ ...settings, projectless: { enabled: event.target.checked } })
              }
            />
            <span className="toggle" />
            <span>允许无项目对话</span>
          </label>
          <p className="helper">
            普通聊天禁止文件读写、命令和外部工具，仅允许内置时钟。与项目任务共用并发上限，同一会话按顺序执行。
          </p>
          <div className="action-row">
            {button('检查普通聊天能力', () =>
              run('检查普通聊天能力', async () => {
                const binary = settings.codexBinary;
                const result = await api.checkProjectless(binary);
                setProjectlessCheck({ binary, result });
                if (!result.ok) throw new Error(result.message);
                inform(result.message);
              }),
            )}
          </div>
          <div
            className={`check-feedback ${projectlessCheck?.binary === settings.codexBinary ? (projectlessCheck.result.ok ? 'success' : 'error') : ''}`}
            role="status"
          >
            <strong>
              {projectlessCheck?.binary === settings.codexBinary
                ? projectlessCheck.result.ok
                  ? '能力已验证'
                  : '暂不可执行'
                : '尚未检查'}
            </strong>
            <span>
              {projectlessCheck?.binary === settings.codexBinary
                ? projectlessCheck.result.message
                : '请检查当前 Codex；版本更新后需重新验证。未通过时项目功能仍可使用。'}
            </span>
          </div>
          {snapshot?.status.projectless && !stopped && (
            <div
              className={`check-feedback ${snapshot.status.projectless.ready ? 'success' : 'error'}`}
              role="status"
            >
              <strong>
                {snapshot.status.projectless.enabled
                  ? snapshot.status.projectless.ready
                    ? '普通聊天后端在线'
                    : '普通聊天暂不可用'
                  : '无项目对话已关闭'}
              </strong>
              <span>
                {snapshot.status.projectless.error ??
                  '后端状态由当前生效配置决定；修改后请停止并应用。'}
              </span>
            </div>
          )}
          <p className="helper">
            设置自动缓存，停止连接后应用才生效。关闭后保留历史，拒绝新建和续聊。
          </p>
        </section>
        <section className="panel remote-creation">
          <div className="section-heading">
            <span className="eyebrow">REMOTE PROJECTS</span>
            <h2>远程新建项目</h2>
            <p>在飞书点击「新建项目」后回复名称，或发送 /新建项目 项目名称。</p>
          </div>
          <label className="toggle-label">
            <input
              type="checkbox"
              checked={settings.remoteProjectCreation.enabled}
              onChange={(e) =>
                update({
                  ...settings,
                  remoteProjectCreation: {
                    ...settings.remoteProjectCreation,
                    enabled: e.target.checked,
                  },
                })
              }
            />
            <span className="toggle" />
            <span>允许飞书创建项目</span>
          </label>
          {settings.remoteProjectCreation.enabled && (
            <>
              <div className="action-row">
                {button('选择保存目录', () =>
                  run('选择远程项目目录', async () => {
                    const root = await api.chooseDirectory();
                    const latest = settingsRef.current;
                    if (root && latest)
                      update({
                        ...latest,
                        remoteProjectCreation: { ...latest.remoteProjectCreation, root },
                      });
                  }),
                )}
                <span className="path">
                  {settings.remoteProjectCreation.root ||
                    '请选择独立目录，例如 ~/Code/RemoteProjects'}
                </span>
              </div>
              <div className="form-grid">
                <SelectField
                  label="新项目默认权限"
                  value={settings.remoteProjectCreation.permissions.mode}
                  onChange={(mode) =>
                    update({
                      ...settings,
                      remoteProjectCreation: {
                        ...settings.remoteProjectCreation,
                        permissions: {
                          ...settings.remoteProjectCreation.permissions,
                          mode: mode as RemotePermissions['mode'],
                        },
                      },
                    })
                  }
                  options={permissionOptions.map((option) =>
                    option.value === 'disabled'
                      ? {
                          ...option,
                          label: '仅创建目录，暂不执行任务',
                          description: '创建空目录，之后可在本机调整权限',
                        }
                      : option,
                  )}
                />
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    disabled={settings.remoteProjectCreation.permissions.mode === 'disabled'}
                    checked={settings.remoteProjectCreation.permissions.networkAccess}
                    onChange={(e) =>
                      update({
                        ...settings,
                        remoteProjectCreation: {
                          ...settings.remoteProjectCreation,
                          permissions: {
                            ...settings.remoteProjectCreation.permissions,
                            networkAccess: e.target.checked,
                          },
                        },
                      })
                    }
                  />
                  <span className="toggle" />
                  <span>允许新项目任务联网</span>
                </label>
              </div>
            </>
          )}
          <p className="helper">
            停止服务后应用设置。仅在指定目录下创建空文件夹，不覆盖已有目录。
            默认权限只作用于之后创建的项目；已有项目请在上方单独修改。关闭此开关不会删除已有项目。
          </p>
        </section>
        <section className="panel">
          <div className="section-heading">
            <span className="eyebrow">EXECUTION</span>
            <h2>执行与并发</h2>
            <p>为这台 Mac 分配合适的任务容量。</p>
          </div>
          <SelectField
            label="最多同时执行"
            className="concurrency-field"
            value={String(settings.maxConcurrentTasks)}
            onChange={(value) => update({ ...settings, maxConcurrentTasks: Number(value) })}
            options={Array.from({ length: 8 }, (_, i) => ({
              value: String(i + 1),
              label: `${i + 1} 个任务`,
            }))}
          />
          <div className="inline-note">
            仅在本机修改，停止服务后应用。等待审批、输入和状态待核对的任务仍占名额；同一会话或
            checkout 串行，独立目录可并行。
            新权限限制不可通过飞书审批扩大。只读分析禁止文件写入；联网开关控制命令网络与网页搜索，不影响模型连接。文件读取范围由
            Codex 沙箱决定。
          </div>
        </section>
      </>
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
          >
            {loginError || loginState?.message || '正在读取系统登录项…'}
          </div>
          <div className="action-row">
            {button('刷新系统状态', () => refreshLoginItem(true), false, loginLoading)}
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
    const executable = applied.projects.filter(canExecuteProject).length;
    return (
      <>
        <div className="page-title overview-title split">
          <div>
            <span className="eyebrow">OVERVIEW</span>
            <h1>你的本地工作台</h1>
            <p>连接飞书与 Codex，工作始终在这台 Mac 上进行。</p>
          </div>
          <span className="device-label">
            <Icon name="laptop" /> macOS
          </span>
        </div>
        <section className={`connection-panel ${status.phase === 'ready' ? 'online' : ''}`}>
          <div className="connection-copy">
            <span className="connection-label">
              <i className="dot" /> {phaseLabels[status.phase]}
            </span>
            <h2>
              {status.phase === 'ready'
                ? '连接就绪，随时开始。'
                : status.phase === 'stopped'
                  ? '让工作，从一次连接开始。'
                  : phaseLabels[status.phase]}
            </h2>
            <p>
              {status.phase === 'ready'
                ? '在飞书发送消息，交给本机 Codex 处理。'
                : '启动后，飞书消息与任务状态将在这里同步。'}
            </p>
            <div className="action-row">
              {active
                ? button(
                    <>
                      <Icon name="stop" />
                      停止连接
                    </>,
                    () =>
                      run('停止服务', async () => {
                        const value = await api.stop();
                        setSnapshot((s) => (s ? { ...s, status: value } : s));
                      }),
                  )
                : startButton()}
            </div>
          </div>
          <div className="connection-map" aria-hidden="true">
            <div className={`map-node ${status.feishuConnected ? 'online' : ''}`}>
              <div className="node-icon">
                <Icon name="feishu" />
              </div>
              <span>飞书</span>
              <small>消息入口</small>
            </div>
            <div className={`map-line ${status.feishuConnected ? 'online' : ''}`}>
              <i />
            </div>
            <div className="map-node connector-node">
              <div className="node-icon">
                <ConnectorMark />
              </div>
              <span>Connector</span>
              <small>本地网关</small>
            </div>
            <div className={`map-line ${status.rpcReady ? 'online' : ''}`}>
              <i />
            </div>
            <div className={`map-node ${status.rpcReady ? 'online' : ''}`}>
              <div className="node-icon">
                <Icon name="terminal" />
              </div>
              <span>Codex</span>
              <small>本机执行</small>
            </div>
          </div>
        </section>
        {!active && connectionHint()}
        {status.error && <div className="inline-note error">{status.error}</div>}
        <div className="status-grid">
          <section className="status-cell">
            <div className="metric-heading">
              <span>飞书连接</span>
              <Icon name="feishu" />
            </div>
            <h3>
              <i className={status.feishuConnected ? 'dot green' : 'dot'} />
              {status.feishuConnected ? '长连接在线' : '尚未连接'}
            </h3>
            <p>接收消息与卡片操作</p>
          </section>
          <section className="status-cell">
            <div className="metric-heading">
              <span>Codex 后端</span>
              <Icon name="terminal" />
            </div>
            <h3>
              <i className={status.rpcReady ? 'dot green' : 'dot'} />
              {status.rpcReady ? '执行后端就绪' : '尚未就绪'}
            </h3>
            <p>独立管理飞书任务</p>
          </section>
          <section className="status-cell">
            <div className="metric-heading">
              <span>未完成任务</span>
              <Icon name="activity" />
            </div>
            <h3 className="task-metric">
              {status.pending}
              <span className="metric-unit">个</span>
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
        <div className="overview-bottom">
          <section className="panel workspace-summary">
            <div className="section-heading split">
              <div>
                <span className="eyebrow">WORKSPACES</span>
                <h2>
                  本地项目 <span className="count-badge">{applied.projects.length}</span>
                </h2>
              </div>
              <button className="text-button" onClick={() => setPage('projects')}>
                管理项目 <Icon name="arrow" />
              </button>
            </div>
            {applied.projects.length ? (
              <div className="workspace-preview">
                {applied.projects.slice(0, 3).map((project) => (
                  <div className="workspace-preview-row" key={project.key}>
                    <span className="workspace-icon">
                      <Icon name="projects" />
                    </span>
                    <div>
                      <strong>{project.name || project.key}</strong>
                      <span className="path" title={project.root}>
                        {project.root}
                      </span>
                    </div>
                    <span
                      className={`permission-tag ${canExecuteProject(project) ? 'allowed' : ''}`}
                    >
                      {!canExecuteProject(project)
                        ? '未授权'
                        : projectPermissions(project).mode === 'read-only'
                          ? '只读'
                          : '可执行'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="workspace-empty">
                <Icon name="projects" />
                <p>还没有本地项目。需要处理文件时，再添加目录并授权。</p>
                <button className="text-button" onClick={() => setPage('projects')}>
                  添加项目 <Icon name="arrow" />
                </button>
              </div>
            )}
            <p className="summary-footnote">
              {executable} 个项目已授权
              {applied.projects.length > 3
                ? ` · 另有 ${applied.projects.length - 3} 个项目可在列表中查看`
                : ' · 权限仅在本机管理'}
            </p>
          </section>
          <section className="panel local-summary">
            <span className="local-summary-icon">
              <Icon name="shield" />
            </span>
            <h3>本地运行，权限由你掌控</h3>
            <p>项目权限与连接配置在这台 Mac 上管理，飞书端无法修改。</p>
            <div className="local-summary-detail">
              <span>无项目对话</span>
              <strong>
                {applied.projectless?.enabled === false
                  ? '已关闭'
                  : status.projectless?.ready
                    ? '已就绪'
                    : status.projectless?.error
                      ? '暂不可用'
                      : '已开启 · 启动时验证'}
              </strong>
            </div>
            <div className="local-summary-detail">
              <span>同时执行上限</span>
              <strong>{applied.maxConcurrentTasks} 个任务</strong>
            </div>
            <div className="local-summary-detail">
              <span>退出 App</span>
              <strong>停止任务与连接</strong>
            </div>
          </section>
        </div>
      </>
    );
  }
  function setup() {
    return (
      <>
        <div className="page-title">
          <span className="eyebrow">GETTING STARTED</span>
          <h1>建立你的连接</h1>
          <p>四个步骤，让飞书与本机 Codex 协同工作。</p>
        </div>
        <div className="wizard-steps">
          {['Codex', '飞书连接', '本地项目', '检查与启动'].map((label, i) => (
            <button
              key={label}
              className={step === i ? 'selected' : ''}
              aria-current={step === i ? 'step' : undefined}
              onClick={() => setStep(i)}
            >
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
              {startButton(false)}
            </div>
            {connectionHint(true)}
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
      onBlurCapture={(event) => {
        // A blur-triggered save would remove the retry button before its click
        // arrives. Feedback controls manage their own save operation.
        if (
          event.relatedTarget instanceof Element &&
          event.relatedTarget.closest('.feedback-viewport')
        )
          return;
        cache.current?.flush().catch(() => {});
      }}
    >
      <FeedbackViewport
        notice={notice}
        busy={busy}
        cacheFailed={cacheState === 'error'}
        onDismiss={dismissNotice}
        onRetrySave={() => {
          save(false).catch(() => {});
        }}
      />
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <ConnectorMark />
          </div>
          <div>
            Codex<span>Connector</span>
          </div>
        </div>
        <div className="sidebar-caption">
          WORKSPACE <span>本地控制台</span>
        </div>
        <nav aria-label="主导航">
          {(['overview', 'feishu', 'projects', 'preferences', 'logs'] as Page[]).map((item) => (
            <button
              key={item}
              className={page === item ? 'nav-item selected' : 'nav-item'}
              aria-current={page === item ? 'page' : undefined}
              onClick={() => {
                setPage(item);
                if (item === 'logs')
                  run('读取日志', async () => setLogs(await api.logs())).catch(() => {});
              }}
            >
              <Icon name={item} />
              {pageLabels[item]}
              {page === item && <span className="nav-indicator" />}
            </button>
          ))}
        </nav>
        <button
          className={page === 'setup' ? 'nav-item setup selected' : 'nav-item setup'}
          aria-current={page === 'setup' ? 'page' : undefined}
          onClick={() => setPage('setup')}
        >
          <Icon name="setup" />
          配置向导
        </button>
        <div className="sidebar-bottom">
          <span className="local-badge">
            <Icon name="shield" /> 数据保存在本机
          </span>
          <small>macOS · 内部测试版 0.1</small>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span className="breadcrumb">
            控制台 <Icon name="chevron" />
            <strong>{pageLabels[page]}</strong>
          </span>
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
              className={`status-pill phase-${snapshot?.status.phase ?? 'loading'} ${snapshot?.status.phase === 'ready' ? 'connected' : ''}`}
            >
              <i className="dot" />
              {snapshot ? phaseLabels[snapshot.status.phase] : '正在加载'}
            </span>
          </div>
        </header>
        <div className="content" ref={contentRef}>
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
                    <p>管理机器人身份与本机 Codex，建立可靠的消息通道。</p>
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
                    <p>选择工作目录，设定每个项目的执行边界。</p>
                  </div>
                  {projectsForm()}
                </>
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
        {settings && snapshot && (page === 'projects' || page === 'feishu') && (
          <div className="save-bar">
            <span>
              {active ? '配置自动缓存到本机；停止服务后应用。' : '配置自动缓存到本机，应用后生效。'}
            </span>
            <div>
              {button('立即保存', () => save(false))}
              {button('应用配置', () => save(true), true, !stopped)}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
