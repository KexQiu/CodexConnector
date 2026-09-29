import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import type { DesktopApi, DesktopSettings } from '../../../src/desktop/contracts.js';
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
      '先点击本页“绑定单聊”保持配置连接在线，再到平台保存长连接设置。消息事件添加 im.message.receive_v1；回调添加 card.action.trigger。两个配置页都需要核对。已有 Webhook 应用请先确认切换影响，手动切换后再继续。',
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
      '打开机器人单聊，复制本页生成的绑定指令并发送。指令 5 分钟内有效，只接受用户单聊；若没有扫码账号信息，还需在本机确认候选账号。也可以在高级配置手填三个身份字段。',
    done: '本页显示绑定完成，核对账号及会话后保存到草稿。',
    entry: 'console',
  },
];
type Props = {
  api: DesktopApi;
  settings: DesktopSettings;
  configured: boolean;
  stopped: boolean;
  credentials: ReactNode;
  identity: ReactNode;
  onFlush: () => Promise<void>;
  onMerge: () => Promise<void>;
  onComplete: () => Promise<void>;
  notify: (text: string, error?: boolean) => void;
};
export function FeishuConnection(props: Props) {
  const { api, settings, configured, stopped, notify } = props;
  const [mode, setMode] = useState<'summary' | 'create' | 'existing' | 'manual'>(
    configured ? 'summary' : 'create',
  );
  const [state, setState] = useState<FeishuSetupState | null>(null);
  const [name, setName] = useState('CodexConnector');
  const [tutorial, setTutorial] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let live = true;
    api
      .feishuSetup({ kind: 'load' })
      .then((next) => {
        if (live) setState(next);
      })
      .catch(() => {});
    const off = api.onFeishuSetup(setState);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live = false;
      off();
      clearInterval(timer);
    };
  }, [api]);
  const qrRef = useRef<HTMLDivElement>(null);
  const bindingRef = useRef<HTMLDivElement>(null);
  const checkRef = useRef<HTMLDivElement>(null);
  const lastFeedback = useRef('');
  useEffect(() => {
    const target = state?.qr
      ? qrRef.current
      : state?.bindingCommand
        ? bindingRef.current
        : state?.phase === 'checking' || state?.phase === 'complete'
          ? checkRef.current
          : null;
    target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [state?.qr?.url, state?.bindingCommand?.text, state?.phase]);
  useEffect(() => {
    if (!state || !['complete', 'error', 'expired'].includes(state.phase)) return;
    const key = `${state.phase}:${state.message}:${state.check.checkedAt}`;
    if (lastFeedback.current === key) return;
    lastFeedback.current = key;
    notify(
      state.message,
      state.phase === 'error' || state.phase === 'expired' || state.check.status === 'failed',
    );
  }, [state, notify]);
  const qr = useMemo(() => {
    if (!state?.qr) return null;
    const code = qrcode(0, 'M');
    code.addData(state.qr.url);
    code.make();
    return code.createDataURL(4, 16);
  }, [state?.qr?.url]);
  const perform = (operation: () => Promise<void>) => {
    if (working) return;
    setWorking(true);
    setError('');
    operation()
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : '操作未完成，请重试。';
        setError(message);
        notify(message, true);
      })
      .finally(() => setWorking(false));
  };
  const action = (value: FeishuSetupAction) =>
    perform(async () => {
      if (!['cancel', 'skip', 'load', 'tutorial', 'confirm'].includes(value.kind))
        await props.onFlush();
      const next = await api.feishuSetup(value);
      setState(next);
    });
  const open = (entry: OfficialEntry) => perform(() => api.openFeishu(entry));
  const copy = (item: 'permissions' | 'events' | 'binding') =>
    perform(async () => {
      await api.copyFeishu(item);
      notify('已复制到剪贴板');
    });
  const running = !!state?.operationId;
  const disabled = working || running;
  const complete = Object.values(settings.feishu).every(Boolean);
  const hasBinding = state?.hasPending
    ? state.phase === 'bound' || (state.appId === settings.feishu.appId && complete)
    : complete;
  const remaining = Math.max(
    0,
    Math.floor(((state?.qr?.expiresAt ?? state?.bindingCommand?.expiresAt ?? now) - now) / 1000),
  );
  const summary =
    state?.check.status === 'passed'
      ? '基础连接检查通过'
      : state?.check.status === 'failed'
        ? '基础连接检查未通过'
        : state?.check.status === 'changed'
          ? '配置已变更，待验证'
          : state?.phase === 'checking'
            ? '正在检查连接…'
            : '配置已保存，未验证';
  return (
    <section className="panel feishu-onboarding">
      <div className="onboarding-heading">
        <div>
          <span className="eyebrow">FEISHU · CONNECT</span>
          <h2>让飞书成为你的工作入口</h2>
          <p>连接一个机器人，在手机上继续与 Codex 对话。</p>
        </div>
        <span className="onboarding-private">
          <Icon name="shield" />
          仅保存在本机
        </span>
      </div>
      {mode === 'summary' ? (
        <div className="connection-summary">
          <div className="connection-summary-icon">
            <Icon name="feishu" />
          </div>
          <div>
            <strong>机器人已配置</strong>
            <p className="path">{settings.feishu.appId}</p>
            <small>单聊 {settings.feishu.testChatId || '待绑定'}</small>
          </div>
          <button className="button" disabled={working} onClick={() => setMode('existing')}>
            修改配置
          </button>
          <button className="button" onClick={() => setTutorial(true)}>
            查看教程
          </button>
        </div>
      ) : (
        <>
          <div className="onboarding-choices" aria-label="选择连接方式">
            {(
              [
                ['create', '扫码创建机器人', '从一个新的机器人开始', 'plus'],
                ['existing', '连接已有机器人', '保留原应用与单聊绑定', 'feishu'],
                ['manual', '手动配置', '跟随教程逐步完成', 'logs'],
              ] as const
            ).map(([value, title, subtitle, icon]) => (
              <button
                key={value}
                type="button"
                className={`onboarding-choice ${mode === value ? 'selected' : ''}`}
                disabled={disabled}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  if (value === 'manual') setTutorial(true);
                }}
              >
                <Icon name={icon} />
                <strong>{title}</strong>
                <small>{subtitle}</small>
              </button>
            ))}
          </div>
          {mode === 'create' && (
            <div className="onboarding-stage">
              <div>
                <span className="eyebrow">01 / AUTHORIZE</span>
                <h3>扫码授权，自动获取应用凭据</h3>
                <p className="helper">
                  使用国内飞书扫码。平台可能要求管理员审批；扫码完成后仍需核对事件、长连接与发布状态。
                </p>
              </div>
              {!state?.hasPending && (
                <label className="field">
                  <span>机器人名称</span>
                  <TextInput
                    value={name}
                    maxLength={60}
                    disabled={disabled}
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
              )}
              <div className="action-row">
                <button
                  className="button primary"
                  disabled={disabled || !stopped || !name.trim() || !!state?.hasPending}
                  onClick={() => action({ kind: 'register', mode: 'create', name })}
                >
                  生成授权二维码
                </button>
                <span className="helper">试用功能 · 也可使用手动配置</span>
              </div>
              {state?.hasPending && (
                <p className="inline-note">
                  已保存待配置应用 {state.appId}，请继续配置此应用，避免重复创建。
                </p>
              )}
            </div>
          )}
          {mode === 'existing' && (
            <div className="onboarding-stage">
              <h3>使用已有应用凭据</h3>
              {props.credentials}
              <div className="action-row">
                <button
                  className="button primary"
                  disabled={disabled || !stopped}
                  onClick={() => action({ kind: 'use-existing' })}
                >
                  保存凭据并继续
                </button>
                <button
                  className="button"
                  disabled={disabled || !stopped || !settings.feishu.appId}
                  onClick={() =>
                    action({
                      kind: 'register',
                      mode: 'existing',
                      appId: settings.feishu.appId,
                      name: 'CodexConnector',
                    })
                  }
                >
                  扫码补齐权限与订阅
                </button>
              </div>
              <p className="helper">
                补配只添加缺失项，保留现有配置；更改 Webhook 接收方式需在平台手动确认。
              </p>
            </div>
          )}
        </>
      )}
      {state?.qr && qr && (
        <div className="authorization-card" ref={qrRef}>
          <img
            src={qr}
            width="208"
            height="208"
            alt="使用飞书扫码授权创建机器人"
            onLoad={() => qrRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          />
          <div>
            <span className="eyebrow">SCAN WITH FEISHU</span>
            <h3>使用飞书扫描二维码</h3>
            <p>
              {remaining > 0
                ? `剩余 ${Math.floor(remaining / 60)} 分 ${remaining % 60} 秒`
                : '二维码已过期，请取消后重新生成'}
            </p>
            <div className="action-row">
              <button
                className="button"
                disabled={working || remaining === 0}
                onClick={() => open('authorization')}
              >
                在浏览器中打开
              </button>
              <button
                className="button"
                disabled={working}
                onClick={() => action({ kind: 'cancel' })}
              >
                取消扫码
              </button>
            </div>
          </div>
        </div>
      )}
      {state && state.phase !== 'idle' && (
        <div
          className={`check-feedback ${state.phase === 'error' || state.phase === 'expired' ? 'error' : ''}`}
          role="status"
        >
          <strong>
            {state.phase === 'authorizing'
              ? '等待授权'
              : state.phase === 'binding'
                ? state.connected
                  ? '配置连接在线'
                  : '配置连接正在建立'
                : '配置进度'}
          </strong>
          <span>{state.message}</span>
          {running && (
            <button
              className="button"
              disabled={working}
              onClick={() => action({ kind: 'cancel' })}
            >
              取消当前操作
            </button>
          )}
        </div>
      )}
      {(state?.hasPending || mode === 'existing' || mode === 'manual') && (
        <div className="onboarding-stage binding-stage">
          <div>
            <span className="eyebrow">02 / BIND</span>
            <h3>{hasBinding ? '单聊绑定' : '让机器人认出你的单聊'}</h3>
            <p className="helper">
              先开启配置连接，再去平台保存长连接设置并发布。这条连接不会启动 Codex。
            </p>
          </div>
          <div className="action-row">
            <button
              className="button"
              disabled={disabled || !stopped}
              onClick={() => action({ kind: 'bind' })}
            >
              {hasBinding ? '重新绑定单聊' : '绑定单聊'}
            </button>
            <button
              className="button"
              disabled={working}
              onClick={() => {
                setTutorial(true);
                open('events');
              }}
            >
              打开事件与回调设置
            </button>
          </div>
          {state?.bindingCommand && (
            <div className="binding-command" ref={bindingRef}>
              <p>在机器人单聊中发送以下指令，剩余 {remaining} 秒：</p>
              <code>{state.bindingCommand.text}</code>
              <button
                className="button"
                disabled={working || !remaining}
                onClick={() => copy('binding')}
              >
                复制绑定指令
              </button>
            </div>
          )}
          {state?.candidate && (
            <div className="binding-candidate">
              <strong>确认这个账号与单聊</strong>
              <dl>
                <dt>企业</dt>
                <dd>{state.candidate.tenantKey}</dd>
                <dt>用户 Open ID</dt>
                <dd>{state.candidate.allowedOpenId}</dd>
                <dt>Chat ID</dt>
                <dd>{state.candidate.testChatId}</dd>
              </dl>
              <p className="helper">仅在刚才确实由你在自己的单聊发送了绑定指令时确认。</p>
              <button
                className="button primary"
                disabled={working}
                onClick={() => action({ kind: 'confirm' })}
              >
                确认绑定此账号
              </button>
            </div>
          )}
          {state?.hasPending && state.phase === 'bound' && (
            <button
              className="button primary"
              disabled={disabled || !stopped}
              onClick={() =>
                perform(async () => {
                  await props.onMerge();
                  notify('绑定已保存到草稿');
                })
              }
            >
              保存绑定到当前配置
            </button>
          )}
        </div>
      )}
      {complete && !state?.hasPending && (
        <div className="onboarding-stage connection-check" ref={checkRef}>
          <div>
            <span className="eyebrow">03 / OPTIONAL CHECK</span>
            <h3>{summary}</h3>
            <p className="helper">
              只检查凭据、历史读取与长连接握手。不会发送消息、创建卡片或执行任务。
            </p>
          </div>
          <div className="action-row">
            <button
              className="button primary"
              disabled={disabled}
              onClick={() => action({ kind: 'check' })}
            >
              检查连接
            </button>
            <button
              className="button"
              disabled={working || (running && state?.phase !== 'checking') || !stopped}
              onClick={() =>
                perform(async () => {
                  await props.onFlush();
                  setState(await api.feishuSetup({ kind: 'skip' }));
                  await props.onComplete();
                  notify('配置已保存，未验证');
                })
              }
            >
              跳过验证，完成配置
            </button>
            {state?.check.status === 'passed' && (
              <button
                className="button"
                disabled={disabled || !stopped}
                onClick={() => perform(props.onComplete)}
              >
                完成配置
              </button>
            )}
          </div>
          {state && (
            <details className="check-details" open={state.check.status === 'failed'}>
              <summary>
                检查详情
                {state.check.checkedAt
                  ? ` · ${new Date(state.check.checkedAt).toLocaleString('zh-CN')}`
                  : ''}
              </summary>
              <ul>
                {(['credentials', 'history', 'websocket'] as const).map((key) => (
                  <li key={key}>
                    <Icon
                      name={
                        state.check[key].status === 'passed'
                          ? 'check'
                          : state.check[key].status === 'failed'
                            ? 'alert'
                            : 'activity'
                      }
                    />
                    <strong>
                      {{ credentials: '应用凭据', history: '历史读取', websocket: '长连接' }[key]}
                    </strong>
                    <span>{state.check[key].message}</span>
                  </li>
                ))}
              </ul>
              <p className="helper">
                基础检查不代表消息订阅和卡片回调已完成实际验证；正式运行状态在总览中单独展示。
              </p>
              <button className="button" onClick={() => setTutorial(true)}>
                查看修复教程
              </button>
            </details>
          )}
        </div>
      )}
      {error && (
        <div className="check-feedback error" role="alert">
          {error}
        </div>
      )}
      {!stopped && mode !== 'summary' && (
        <div className="inline-note">
          正式服务运行中。填写内容仍会自动缓存；请先在总览停止服务，再进行扫码、绑定或应用配置。
        </div>
      )}
      {mode !== 'summary' && (
        <details className="onboarding-advanced" open={mode === 'manual'}>
          <summary>高级配置 · 手动编辑身份字段</summary>
          {mode !== 'existing' && props.credentials}
          {props.identity}
        </details>
      )}
      <div className="tutorial-heading">
        <div>
          <h3>飞书机器人配置指南</h3>
          <p className="helper">教程可离线查看。勾选仅记录你的操作进度，不代表检测通过。</p>
        </div>
        <button className="button" aria-expanded={tutorial} onClick={() => setTutorial(!tutorial)}>
          {tutorial ? '收起教程' : '查看教程'}
        </button>
      </div>
      {tutorial && (
        <div className="feishu-tutorial">
          {lessons.map((lesson, index) => (
            <details key={lesson.title} open={index === 0 && !state?.tutorial.includes(0)}>
              <summary>
                <span className={`lesson-number ${state?.tutorial.includes(index) ? 'done' : ''}`}>
                  {state?.tutorial.includes(index) ? '✓' : String(index + 1).padStart(2, '0')}
                </span>
                <strong>{lesson.title}</strong>
                <Icon name="chevronDown" />
              </summary>
              <div className="lesson-content">
                <div
                  className="tutorial-diagram"
                  aria-label={`操作路径示意：${lesson.route.join(' → ')}`}
                >
                  {lesson.route.map((label, step) => (
                    <span key={label}>
                      {step > 0 && <Icon name="chevron" />}
                      <b>{label}</b>
                    </span>
                  ))}
                </div>
                <p>{lesson.instruction}</p>
                {index === 2 && (
                  <pre>{JSON.stringify({ scopes: FEISHU_SETUP_MANIFEST.scopes }, null, 2)}</pre>
                )}
                {index === 3 && (
                  <div className="tutorial-events">
                    <code>im.message.receive_v1</code>
                    <code>card.action.trigger</code>
                  </div>
                )}
                <p className="lesson-standard">
                  <Icon name="check" />
                  完成标准：{lesson.done}
                </p>
                <div className="action-row">
                  <button className="button" disabled={working} onClick={() => open(lesson.entry)}>
                    打开官方入口
                  </button>
                  {lesson.copy && (
                    <button
                      className="button"
                      disabled={working}
                      onClick={() => copy(lesson.copy!)}
                    >
                      复制配置
                    </button>
                  )}
                  <label className="lesson-completed">
                    <input
                      type="checkbox"
                      checked={state?.tutorial.includes(index) ?? false}
                      disabled={working}
                      onChange={(event) =>
                        action({
                          kind: 'tutorial',
                          steps: event.target.checked
                            ? [...(state?.tutorial ?? []), index]
                            : (state?.tutorial ?? []).filter((item) => item !== index),
                        })
                      }
                    />
                    我已完成此步
                  </label>
                </div>
              </div>
            </details>
          ))}
          <p className="helper">可选：机器人自定义菜单可以稍后配置，不影响首次连接。</p>
        </div>
      )}
    </section>
  );
}
