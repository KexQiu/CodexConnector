import { useEffect, useMemo, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import type { DesktopApi, DesktopSettings, DesktopStatus } from '../../../src/desktop/contracts.js';
import {
  FEISHU_SETUP_MANIFEST,
  type FeishuSetupAction,
  type FeishuSetupState,
  type OfficialEntry,
} from '../../../src/feishu/setup-contracts.js';
import { Icon } from './icons.js';
import { TextInput } from './form-controls.js';

const lessons: {
  title: string;
  route: string[];
  instruction: string;
  done: string;
  entry: OfficialEntry;
  copy?: 'permissions' | 'events';
}[] = [
  {
    title: '创建企业自建应用',
    route: ['飞书开放平台', '开发者后台', '创建企业自建应用'],
    instruction:
      '使用目标企业账号登录，填写应用名称。已有机器人可以直接进入原应用；App ID 与 Secret 在“凭证与基础信息”中。',
    done: '能看到以 cli_ 开头的 App ID 和 App Secret。',
    entry: 'credentials',
  },
  {
    title: '启用机器人',
    route: ['应用能力', '添加应用能力', '机器人'],
    instruction: '为应用添加机器人能力，设置名称和头像。首次接入无需配置机器人自定义菜单。',
    done: '机器人能力显示已启用。',
    entry: 'bot',
  },
  {
    title: '配置最小权限',
    route: ['权限管理', '批量导入/导出权限', '导入 JSON'],
    instruction:
      '复制下方权限配置，导入应用身份权限。用途仅限接收单聊、发送消息、更新卡片和读取回执。扫码与手动使用同一份清单。平台审批完成前，申请成功不代表权限已生效。',
    done: '所列权限已开通，并按企业要求完成审批。',
    entry: 'permissions',
    copy: 'permissions',
  },
  {
    title: '事件与卡片回调',
    route: ['事件与回调', '事件配置 / 回调配置', '使用长连接接收'],
    instruction:
      '在“完成飞书设置”步骤保持配置连接在线，再到平台保存长连接设置。消息事件添加 im.message.receive_v1；回调添加 card.action.trigger。两个配置页都需要核对。已有 Webhook 应用请先确认切换影响，手动切换后再继续。',
    done: '消息事件、卡片回调均已添加，接收方式均为长连接。',
    entry: 'events',
    copy: 'events',
  },
  {
    title: '发布与可见范围',
    route: ['版本管理与发布', '创建版本', '申请发布'],
    instruction:
      '确认可见范围包含将要使用机器人的账号，创建版本并按企业要求发布或审批。审批中可以保留本页进度，稍后继续。',
    done: '版本已发布，目标账号能在飞书找到机器人。',
    entry: 'publish',
  },
  {
    title: '绑定机器人单聊',
    route: ['在飞书打开机器人', '发送本页绑定指令', '返回本机确认'],
    instruction:
      '打开机器人单聊，复制本页生成的绑定指令并发送。指令 5 分钟内有效，只接受用户单聊；若没有扫码账号信息，还需在本机确认候选账号。也可以在绑定步骤手动填写三个身份字段。',
    done: '本页显示绑定完成，核对账号及会话后进入“检查并保存”。',
    entry: 'console',
  },
];
type Props = {
  api: DesktopApi;
  settings: DesktopSettings;
  configured: boolean;
  stopped: boolean;
  status: DesktopStatus;
  hasOtherDraft: boolean;
  onApply: (revision: string) => Promise<void>;
  onStop: () => Promise<void>;
  registerLeave: (leave: (() => Promise<void>) | null) => void;
  notify: (text: string, error?: boolean) => void;
};
const titles = ['接入机器人', '完成飞书设置', '绑定单聊', '检查并保存'];
const emptyFields = { appId: '', tenantKey: '', allowedOpenId: '', testChatId: '' };
export function FeishuConnection(props: Props) {
  const { api } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  const [state, setState] = useState<FeishuSetupState | null>(null);
  const stateRef = useRef(state);
  const [view, setView] = useState<'manage' | 'choose' | 'flow'>(
    props.configured ? 'manage' : 'choose',
  );
  const [fields, setFields] = useState(emptyFields);
  const [secret, setSecret] = useState('');
  const [name, setName] = useState('CodexConnector');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cached, setCached] = useState(true);
  const [manual, setManual] = useState(false);
  const [help, setHelp] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [savedNotice, setSavedNotice] = useState('');
  const editor = useRef({
    fields: emptyFields,
    name: 'CodexConnector',
    secret: '',
    version: 0,
    saved: 0,
  });
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const saveAfterCheck = useRef(false);
  const qrContainer = useRef<HTMLDivElement>(null);
  const bindingContainer = useRef<HTMLDivElement>(null);
  const lastFeedback = useRef('');
  const checkResults = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const accept = (next: FeishuSetupState) => {
    stateRef.current = next;
    if (!mounted.current) return;
    setState(next);
    if (next.draft && editor.current.saved === editor.current.version) {
      editor.current = {
        ...editor.current,
        fields: next.draft.fields,
        name: next.draft.name,
        secret: '',
      };
      setFields(next.draft.fields);
      setName(next.draft.name);
      setSecret('');
    }
  };
  const report = (cause: unknown) => {
    const text = cause instanceof Error ? cause.message : '操作未完成，请重试';
    if (mounted.current) {
      setError(text);
      setBusy(false);
    }
    propsRef.current.notify(text, true);
  };
  const flush = () => {
    clearTimeout(timer.current);
    const operation = queue.current.then(async () => {
      while (editor.current.saved < editor.current.version) {
        const draft = stateRef.current?.draft;
        if (!draft) throw new Error('配置进度暂不可用，请重新打开页面');
        const value = { ...editor.current };
        const next = await api.feishuSetup({
          kind: 'edit',
          revision: draft.revision,
          fields: value.fields,
          name: value.name,
          secret: value.secret,
        });
        editor.current.saved = value.version;
        accept(next);
      }
      if (mounted.current) setCached(true);
    });
    queue.current = operation.catch(() => {});
    return operation;
  };
  const change = (patch: Partial<Pick<typeof editor.current, 'fields' | 'name' | 'secret'>>) => {
    editor.current = { ...editor.current, ...patch, version: editor.current.version + 1 };
    setFields(editor.current.fields);
    setName(editor.current.name);
    setSecret(editor.current.secret);
    setCached(false);
    setError('');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      flush().catch(report);
    }, 500);
  };
  const run = (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    operation()
      .catch(report)
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };
  const act = async (action: FeishuSetupAction) => {
    const next = await api.feishuSetup(action);
    accept(next);
    return next;
  };
  const leave = async () => {
    saveAfterCheck.current = false;
    await flush();
    await act({ kind: 'suspend' });
  };
  useEffect(() => {
    mounted.current = true;
    api
      .feishuSetup({ kind: 'load' })
      .then((next) => {
        accept(next);
        if (next.draft && !propsRef.current.configured) setView('flow');
      })
      .catch(report);
    const off = api.onFeishuSetup(accept);
    propsRef.current.registerLeave(leave);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      clearInterval(clock);
      off();
      propsRef.current.registerLeave(null);
    };
  }, [api]);
  const step = state?.draft?.step ?? 1;
  useEffect(() => {
    heading.current?.focus();
  }, [view, step]);
  useEffect(() => {
    if (
      view === 'flow' &&
      (step === 2 || step === 3) &&
      props.stopped &&
      !stateRef.current?.connectionExpiresAt
    )
      api.feishuSetup({ kind: 'connect' }).then(accept).catch(report);
  }, [view, step, props.stopped]);
  useEffect(() => {
    if (state?.bindingCommand)
      bindingContainer.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [state?.bindingCommand?.text]);
  useEffect(() => {
    if (
      !state ||
      (!['error', 'expired'].includes(state.phase) &&
        !(state.phase === 'complete' && state.check.status === 'failed'))
    )
      return;
    const key = `${state.phase}:${state.message}:${state.check.checkedAt}`;
    if (lastFeedback.current !== key) {
      lastFeedback.current = key;
      propsRef.current.notify(state.message || '基础检查未通过，请查看具体结果', true);
    }
  }, [state?.phase, state?.message, state?.check.checkedAt]);
  useEffect(() => {
    if (state?.phase === 'checking' || state?.check.status === 'failed')
      checkResults.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [state?.phase === 'checking', state?.check.checkedAt]);
  const commit = async () => {
    const revision = stateRef.current?.draft?.revision;
    if (!revision) throw new Error('配置进度丢失，请重新打开');
    await propsRef.current.onApply(revision);
    accept(await api.feishuSetup({ kind: 'load' }));
    setView('manage');
    setSavedNotice('飞书配置已保存，连接仍需手动启动。');
    propsRef.current.notify('飞书配置已保存');
  };
  useEffect(() => {
    if (!saveAfterCheck.current || state?.operationId || state?.phase !== 'complete') return;
    saveAfterCheck.current = false;
    if (state.check.status === 'passed') run(commit);
  }, [state?.operationId, state?.phase, state?.check.status]);
  const begin = (
    mode: 'create' | 'existing',
    intent: 'replace' | 'credentials' | 'binding' | 'resume',
  ) =>
    run(async () => {
      await flush();
      await act({ kind: 'begin', mode, intent });
      setView('flow');
      setSavedNotice('');
      setManual(false);
    });
  const advance = (target: number) =>
    run(async () => {
      await flush();
      await act({ kind: 'step', step: target });
      setManual(false);
    });
  const copy = (item: 'permissions' | 'events' | 'binding') =>
    run(async () => {
      await api.copyFeishu(item);
      propsRef.current.notify('已复制到剪贴板');
    });
  const open = (entry: OfficialEntry) => run(() => api.openFeishu(entry));
  const qr = useMemo(() => {
    if (!state?.qr) return null;
    const code = qrcode(0, 'M');
    code.addData(state.qr.url);
    code.make();
    return code.createDataURL(4, 16);
  }, [state?.qr?.url]);
  const expires = state?.qr?.expiresAt ?? state?.bindingCommand?.expiresAt;
  const seconds = Math.max(0, Math.ceil(((expires ?? now) - now) / 1000));
  const draft = state?.draft;
  const running = !!state?.operationId;
  const bound = !!fields.tenantKey && !!fields.allowedOpenId && !!fields.testChatId;
  const checkLabel =
    state?.check.status === 'passed'
      ? '基础检查通过'
      : state?.check.status === 'failed'
        ? '基础检查未通过'
        : state?.check.status === 'changed'
          ? '配置已变更，待验证'
          : '尚未验证';
  const input = (key: keyof typeof fields, label: string, placeholder: string) => (
    <label className="field" key={key}>
      <span>{label}</span>
      <TextInput
        value={fields[key]}
        placeholder={placeholder}
        spellCheck={false}
        disabled={busy || running || !!state?.connectionExpiresAt}
        onChange={(event) =>
          change({ fields: { ...editor.current.fields, [key]: event.target.value } })
        }
      />
    </label>
  );
  const details = (
    <div className="flow-check-results" ref={checkResults}>
      {(['credentials', 'history', 'websocket'] as const).map((key) => (
        <div key={key}>
          <Icon
            name={
              state?.check[key].status === 'passed'
                ? 'check'
                : state?.check[key].status === 'failed'
                  ? 'alert'
                  : 'activity'
            }
          />
          <strong>
            {{ credentials: '应用凭据', history: '历史读取', websocket: '长连接' }[key]}
          </strong>
          <span>{state?.check[key].message ?? '尚未检查'}</span>
        </div>
      ))}
    </div>
  );
  const lesson = (index: number) => {
    const item = lessons[index]!;
    return (
      <div className="flow-lesson" key={index}>
        <h3>{item.title}</h3>
        <div className="tutorial-diagram">
          {item.route.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <p>{item.instruction}</p>
        {index === 2 && (
          <pre>{JSON.stringify({ scopes: FEISHU_SETUP_MANIFEST.scopes }, null, 2)}</pre>
        )}
        {index === 3 && <code>im.message.receive_v1 / card.action.trigger</code>}
        <small>完成标准：{item.done}</small>
        <div className="action-row">
          <button className="button" disabled={busy} onClick={() => open(item.entry)}>
            打开飞书后台
          </button>
          {item.copy && (
            <button className="button" disabled={busy} onClick={() => copy(item.copy!)}>
              复制配置
            </button>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="feishu-flow">
      {view === 'manage' && (
        <>
          <div className="flow-page-heading">
            <span className="eyebrow">FEISHU CONNECTION</span>
            <h1 tabIndex={-1} ref={heading}>
              飞书连接
            </h1>
            <p>你的机器人、单聊与连接状态，都在这里。</p>
          </div>
          <section className="panel flow-manager">
            <div className="flow-identity">
              <span className="flow-app-icon">
                <Icon name="feishu" />
              </span>
              <div>
                <h2>机器人已配置</h2>
                <p className="path">{props.settings.feishu.appId}</p>
                <small>Secret 已加密保存在本机</small>
              </div>
              <span className={`status-pill ${props.status.feishuConnected ? 'connected' : ''}`}>
                {props.status.feishuConnected
                  ? '正式连接在线'
                  : props.status.phase === 'error' || props.status.phase === 'degraded'
                    ? '正式连接异常'
                    : props.status.phase === 'starting'
                      ? '正式连接启动中'
                      : '正式连接已停止'}
              </span>
            </div>
            <dl className="flow-binding-summary">
              <div>
                <dt>绑定用户</dt>
                <dd>{props.settings.feishu.allowedOpenId}</dd>
              </div>
              <div>
                <dt>专用单聊</dt>
                <dd>{props.settings.feishu.testChatId}</dd>
              </div>
            </dl>
            <div className="flow-manager-actions">
              <button
                className="button"
                disabled={busy}
                onClick={() => begin('existing', 'credentials')}
              >
                修改凭据
              </button>
              <button
                className="button"
                disabled={busy}
                onClick={() => begin('existing', 'binding')}
              >
                重新绑定
              </button>
              <button className="text-button" disabled={busy} onClick={() => setView('choose')}>
                更换机器人 <Icon name="arrow" />
              </button>
            </div>
          </section>
          {(draft || state?.hasPending) && (
            <div className="flow-resume">
              <div>
                <strong>还有一份未完成的配置</strong>
                <p>当前机器人保持原配置，可随时继续。</p>
              </div>
              <button
                className="button"
                disabled={busy}
                onClick={() => begin(draft?.mode ?? 'existing', 'resume')}
              >
                继续配置
              </button>
            </div>
          )}
          <section className="panel">
            <div className="section-heading split">
              <div>
                <h2>{draft ? '有配置尚未完成' : checkLabel}</h2>
                <p>
                  {draft
                    ? '继续配置可检查并保存新连接；当前机器人保持原配置。'
                    : state?.check.checkedAt
                      ? `检查于 ${new Date(state.check.checkedAt).toLocaleString('zh-CN')}`
                      : '检查结果与正式运行状态分别记录。'}
                </p>
              </div>
              <button
                className="button"
                disabled={busy || running || !!draft}
                onClick={() =>
                  run(async () => {
                    await act({ kind: 'check' });
                  })
                }
              >
                {state?.phase === 'checking' ? '检查中…' : '检查连接'}
              </button>
            </div>
            {!draft && details}
            {running && (
              <button
                className="button"
                onClick={() =>
                  run(async () => {
                    await act({ kind: 'cancel' });
                  })
                }
              >
                取消检查
              </button>
            )}
            <p className="helper">基础检查不代表消息订阅和卡片回调已完成实际验证。</p>
          </section>
          {savedNotice && <p className="inline-note">{savedNotice}</p>}
          {props.hasOtherDraft && (
            <p className="inline-note">
              其他页面仍有待应用修改；启动前请完成应用，飞书配置已单独保存。
            </p>
          )}
          <button className="text-button" onClick={() => setHelp(0)}>
            查看完整配置教程 <Icon name="arrow" />
          </button>
        </>
      )}
      {view === 'choose' && (
        <>
          <div className="flow-page-heading">
            <span className="eyebrow">LET’S CONNECT</span>
            <h1 tabIndex={-1} ref={heading}>
              连接你的飞书机器人
            </h1>
            <p>从新机器人开始，或接入你已经配置好的应用。</p>
          </div>
          {(draft || state?.hasPending) && (
            <div className="flow-resume">
              <div>
                <strong>配置进度已保存</strong>
                <p>继续使用已获取的应用，避免重复创建。</p>
              </div>
              <button
                className="button primary"
                onClick={() => begin(draft?.mode ?? 'existing', 'resume')}
              >
                继续配置
              </button>
            </div>
          )}
          <div className="flow-entry-grid">
            {(['create', 'existing'] as const).map((mode) => (
              <button
                className="flow-entry"
                key={mode}
                disabled={busy}
                onClick={() => {
                  if (
                    (draft || state?.hasPending) &&
                    !window.confirm(
                      '开始另一份配置会替换未完成进度；已经在飞书创建的应用不会删除。是否继续？',
                    )
                  )
                    return;
                  begin(mode, 'replace');
                }}
              >
                <span className="flow-app-icon">
                  <Icon name={mode === 'create' ? 'plus' : 'feishu'} />
                </span>
                <h2>{mode === 'create' ? '创建新机器人' : '连接已有机器人'}</h2>
                <p>
                  {mode === 'create'
                    ? '使用飞书扫码，自动保存应用凭据。'
                    : '填写 App ID 与 Secret，保留原有应用。'}
                </p>
                <span className="flow-entry-tail">
                  {mode === 'create' ? '扫码创建 · 试用' : '开始接入'}
                  <Icon name="arrow" />
                </span>
              </button>
            ))}
          </div>
          {props.configured && (
            <button className="text-button" onClick={() => setView('manage')}>
              返回当前连接
            </button>
          )}
        </>
      )}
      {view === 'flow' && draft && (
        <section className="flow-shell">
          <header className="flow-header">
            <span className="eyebrow">
              {draft.mode === 'create' ? '创建新机器人 · 试用' : '连接已有机器人'}
            </span>
            <span className="flow-cache">{cached ? '进度已保存在本机' : '正在保存…'}</span>
          </header>
          <nav className="flow-steps" aria-label="飞书接入进度">
            {titles.map((title, index) => (
              <button
                key={title}
                className={step === index + 1 ? 'current' : step > index + 1 ? 'done' : ''}
                aria-current={step === index + 1 ? 'step' : undefined}
                disabled={busy || running || index + 1 >= step}
                onClick={() => advance(index + 1)}
              >
                <span>{step > index + 1 ? <Icon name="check" /> : index + 1}</span>
                <b>{title}</b>
              </button>
            ))}
          </nav>
          <div className="flow-body">
            <div className="flow-step-title">
              <span>步骤 {step} / 4</span>
              <h2 tabIndex={-1} ref={heading}>
                {titles[step - 1]}
              </h2>
            </div>
            {!props.stopped && (
              <div className="flow-stop">
                <p>正式服务正在运行。填写内容会保存；继续配置前需要停止连接。</p>
                <button className="button" disabled={busy} onClick={() => run(props.onStop)}>
                  停止服务并继续
                </button>
              </div>
            )}
            {step === 1 && (
              <>
                {draft.mode === 'create' && !manual && !draft.hasSecret ? (
                  <>
                    <p>飞书授权后，凭据会直接加密保存。你不需要复制 Secret。</p>
                    <label className="field">
                      <span>机器人名称</span>
                      <TextInput
                        value={name}
                        maxLength={60}
                        disabled={busy || running}
                        onChange={(event) => change({ name: event.target.value })}
                      />
                    </label>
                    {qr && state?.qr && (
                      <div className="flow-qr" ref={qrContainer}>
                        <img
                          src={qr}
                          width="208"
                          height="208"
                          alt="飞书授权二维码"
                          onLoad={() =>
                            qrContainer.current?.scrollIntoView({
                              block: 'center',
                              behavior: 'smooth',
                            })
                          }
                        />
                        <div>
                          <h3>用飞书扫描二维码</h3>
                          <p>
                            {seconds > 0
                              ? `剩余 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
                              : '二维码已过期'}
                          </p>
                          <button
                            className="text-button"
                            disabled={busy || !seconds}
                            onClick={() => open('authorization')}
                          >
                            在浏览器中打开 <Icon name="arrow" />
                          </button>
                          <button
                            className="button"
                            disabled={busy}
                            onClick={() =>
                              run(async () => {
                                await act({ kind: 'cancel' });
                              })
                            }
                          >
                            取消扫码
                          </button>
                        </div>
                      </div>
                    )}
                    <button
                      className="text-button"
                      disabled={busy || running}
                      onClick={() => {
                        setManual(true);
                        setHelp(0);
                      }}
                    >
                      无法扫码？手动创建并填写凭据
                    </button>
                  </>
                ) : (
                  <>
                    {draft.mode === 'create' && draft.hasSecret && (
                      <div className="inline-note">应用凭据已加密保存，继续下一步即可。</div>
                    )}
                    {input('appId', 'App ID', 'cli_…')}
                    <label className="field">
                      <span>App Secret</span>
                      <TextInput
                        type="password"
                        autoComplete="new-password"
                        disabled={busy || running}
                        value={secret}
                        placeholder={draft.hasSecret ? '已保存，留空保持原值' : '填写应用密钥'}
                        onChange={(event) => change({ secret: event.target.value })}
                      />
                      <small>由 macOS Keychain 保护，不会回显已保存的密钥。</small>
                    </label>
                    <div className="action-row">
                      <button className="text-button" onClick={() => setHelp(0)}>
                        在哪里获取凭据？
                      </button>
                      {draft.mode === 'existing' && (
                        <button
                          className="text-button"
                          disabled={busy || running || !props.stopped || !fields.appId}
                          onClick={() =>
                            run(async () => {
                              await flush();
                              await act({
                                kind: 'register',
                                mode: 'existing',
                                appId: fields.appId,
                                name,
                              });
                            })
                          }
                        >
                          扫码补齐权限与订阅
                        </button>
                      )}
                    </div>
                    {qr && (
                      <div className="flow-qr" ref={qrContainer}>
                        <img
                          src={qr}
                          width="208"
                          height="208"
                          alt="飞书补配二维码"
                          onLoad={() =>
                            qrContainer.current?.scrollIntoView({
                              block: 'center',
                              behavior: 'smooth',
                            })
                          }
                        />
                        <button
                          className="button"
                          onClick={() =>
                            run(async () => {
                              await act({ kind: 'cancel' });
                            })
                          }
                        >
                          取消扫码
                        </button>
                      </div>
                    )}
                  </>
                )}
              </>
            )}
            {step === 2 && (
              <>
                <p>在飞书后台完成以下设置。此处确认只记录你的操作，不代表平台检查通过。</p>
                <div className={`flow-channel ${state?.connected ? 'online' : ''}`}>
                  <i className={`dot ${state?.connected ? 'green' : ''}`} />
                  <span>
                    {state?.connected
                      ? '配置连接在线 · 可到飞书后台保存长连接设置'
                      : state?.connectionExpiresAt
                        ? '正在建立配置连接…'
                        : '配置连接未开启'}
                  </span>
                  <button
                    className="text-button"
                    disabled={busy || !props.stopped}
                    onClick={() =>
                      run(async () => {
                        await act({ kind: 'suspend' });
                        await act({ kind: 'connect' });
                      })
                    }
                  >
                    重新连接
                  </button>
                </div>
                <div className="flow-checklist">
                  {[1, 2, 3, 4].map((index, i) => (
                    <details key={index} open={i === 0}>
                      <summary>
                        <span>{String(i + 1).padStart(2, '0')}</span>
                        <strong>{lessons[index]!.title}</strong>
                        <Icon name="chevronDown" />
                      </summary>
                      {lesson(index)}
                    </details>
                  ))}
                </div>
              </>
            )}
            {step === 3 && (
              <>
                <p>只需向机器人发送一次绑定指令。它不会创建 Codex 任务。</p>
                {bound && !state?.bindingCommand && !state?.candidate && (
                  <div className="flow-bound">
                    <Icon name="check" />
                    <div>
                      <strong>已有单聊绑定，可直接继续</strong>
                      <p className="path">
                        {fields.allowedOpenId}
                        <br />
                        {fields.testChatId}
                      </p>
                    </div>
                  </div>
                )}
                {state?.bindingCommand && (
                  <div className="flow-code" ref={bindingContainer}>
                    <span>在机器人单聊中发送</span>
                    <code>{state.bindingCommand.text}</code>
                    <div className="action-row">
                      <button
                        className="button primary"
                        disabled={busy || seconds === 0}
                        onClick={() => copy('binding')}
                      >
                        复制绑定指令
                      </button>
                      <small>{seconds ? `${seconds} 秒后过期` : '已过期，请重新生成'}</small>
                    </div>
                  </div>
                )}
                {state?.candidate && (
                  <div className="flow-candidate">
                    <h3>确认这是你的账号和单聊</h3>
                    <dl>
                      <dt>企业</dt>
                      <dd>{state.candidate.tenantKey}</dd>
                      <dt>用户</dt>
                      <dd>{state.candidate.allowedOpenId}</dd>
                      <dt>单聊</dt>
                      <dd>{state.candidate.testChatId}</dd>
                    </dl>
                    <button
                      className="button primary"
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          await act({ kind: 'confirm' });
                        })
                      }
                    >
                      确认是我的单聊
                    </button>
                  </div>
                )}
                <div className="action-row">
                  <button
                    className="button"
                    disabled={busy || !props.stopped}
                    onClick={() =>
                      run(async () => {
                        await flush();
                        await act({ kind: 'flow-bind' });
                      })
                    }
                  >
                    {state?.bindingCommand
                      ? '重新生成指令'
                      : bound
                        ? '重新绑定其他单聊'
                        : '生成绑定指令'}
                  </button>
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await act({ kind: 'suspend' });
                        setManual(!manual);
                      })
                    }
                  >
                    手动填写身份字段
                  </button>
                </div>
                {manual && (
                  <div className="form-grid">
                    {input('tenantKey', 'Tenant Key', '企业标识')}
                    {input('allowedOpenId', '用户 Open ID', 'ou_…')}
                    {input('testChatId', '单聊 Chat ID', 'oc_…')}
                  </div>
                )}
                <p className="helper">
                  绑定码 5 分钟有效。没有收到结果时，核对消息事件与发布状态。
                </p>
                <button className="text-button" onClick={() => setHelp(5)}>
                  查看绑定帮助
                </button>
              </>
            )}
            {step === 4 && (
              <>
                <p>只保存飞书配置，其他页面尚未应用的修改会继续保留。</p>
                <dl className="flow-final-summary">
                  <dt>机器人</dt>
                  <dd>{fields.appId}</dd>
                  <dt>授权用户</dt>
                  <dd>{fields.allowedOpenId}</dd>
                  <dt>专用单聊</dt>
                  <dd>{fields.testChatId}</dd>
                </dl>
                <div className="flow-check-heading">
                  <h3>{state?.phase === 'checking' ? '正在检查连接，最长 30 秒…' : checkLabel}</h3>
                  <small>不会发送消息、创建卡片或执行模型任务。</small>
                </div>
                {details}
                {state?.phase === 'checking' && (
                  <button
                    className="text-button"
                    onClick={() =>
                      run(async () => {
                        saveAfterCheck.current = false;
                        await act({ kind: 'cancel' });
                      })
                    }
                  >
                    取消检查
                  </button>
                )}
                <p className="helper">
                  检查不包含真实消息与卡片操作；跳过后仍会在正式启动时检查必需条件。
                </p>
              </>
            )}
            {(error || state?.phase === 'error' || state?.phase === 'expired') && (
              <div className="check-feedback error" role="alert">
                {error || state?.message}
              </div>
            )}
          </div>
          <footer className="flow-footer">
            <div>
              <button
                className="text-button"
                disabled={busy || running || step === 1}
                onClick={() => advance(step - 1)}
              >
                上一步
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await leave();
                    setView(props.configured ? 'manage' : 'choose');
                  })
                }
              >
                稍后继续
              </button>
            </div>
            <div>
              {step === 4 ? (
                <>
                  <button
                    className="button"
                    disabled={busy || !props.stopped}
                    onClick={() =>
                      run(async () => {
                        saveAfterCheck.current = false;
                        await flush();
                        await act({ kind: 'flow-skip' });
                        await commit();
                      })
                    }
                  >
                    跳过检查，直接保存
                  </button>
                  <button
                    className="button primary"
                    disabled={busy || running || !props.stopped}
                    onClick={() =>
                      run(async () => {
                        await flush();
                        if (state?.check.status === 'passed') await commit();
                        else {
                          saveAfterCheck.current = true;
                          await act({ kind: 'flow-check' });
                        }
                      })
                    }
                  >
                    {state?.check.status === 'passed' ? '保存配置' : '检查并保存'}
                  </button>
                </>
              ) : (
                <button
                  className="button primary"
                  disabled={
                    busy ||
                    (running && step !== 3) ||
                    (step === 3 && (!bound || !!state?.candidate)) ||
                    !props.stopped
                  }
                  onClick={() => {
                    if (step === 1 && draft.mode === 'create' && !manual && !draft.hasSecret)
                      run(async () => {
                        await flush();
                        await act({ kind: 'register', mode: 'create', name });
                      });
                    else advance(step === 1 && draft.platformConfirmed && bound ? 4 : step + 1);
                  }}
                >
                  {step === 1 && draft.mode === 'create' && !manual && !draft.hasSecret
                    ? state?.phase === 'authorizing'
                      ? '等待飞书授权…'
                      : '生成授权二维码'
                    : step === 2
                      ? '已完成设置，继续'
                      : '下一步'}
                  <Icon name="arrow" />
                </button>
              )}
            </div>
          </footer>
        </section>
      )}
      {view !== 'flow' && error && (
        <div className="check-feedback error" role="alert">
          {error}
        </div>
      )}
      {help !== null && (
        <div className="flow-help-backdrop" onClick={() => setHelp(null)}>
          <aside
            className="flow-help"
            role="dialog"
            aria-modal="true"
            aria-label="飞书配置帮助"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setHelp(null);
              if (event.key === 'Tab') {
                const targets = [
                  ...event.currentTarget.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), a[href], input:not(:disabled)',
                  ),
                ];
                const first = targets[0],
                  last = targets.at(-1);
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <header>
              <h2>配置帮助</h2>
              <button className="button" autoFocus onClick={() => setHelp(null)}>
                关闭帮助
              </button>
            </header>
            <nav>
              {lessons.map((item, index) => (
                <button
                  className={help === index ? 'selected' : ''}
                  key={item.title}
                  onClick={() => setHelp(index)}
                >
                  {index + 1}. {item.title}
                </button>
              ))}
            </nav>
            {lesson(help)}
            <p className="helper">教程可离线查看；官方后台入口需要联网。</p>
          </aside>
        </div>
      )}
    </div>
  );
}
