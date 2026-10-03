import type { LanguageCode } from "@/i18n";
import type { ThemeAppearance, ThemeVariables } from "@/lib/theme";

export interface DesktopAppearancePayload {
  appearance?: ThemeAppearance;
  fontFamily?: string;
  codeFontFamily?: string;
  themeVariables?: ThemeVariables;
  persist?: boolean;
}

export interface SocketDiagnosticPayload {
  event:
    | "connect-start"
    | "connect-error"
    | "reconnect-attempt"
    | "reconnect-failed"
    | "connected"
    | "disconnected"
    | "connection-timeout";
  active?: boolean;
  attempt?: number;
  durationMs?: number;
  message?: string;
  transport?: string;
  url?: string;
}

/** 定时自动备份开始前，桌面主进程发给写作窗口的暂停请求。 */
export interface AutoBackupPauseRequest {
  requestId: string;
}

/** 自动备份结束后解除暂停。备份失败或恢复服务失败时同样会收到。 */
export interface AutoBackupResumeRequest {
  requestId: string;
}

/** 提交给主进程的确认；只有 ok 为 true 时主进程才会停止后端。 */
export interface AutoBackupPauseAck {
  requestId: string;
  ok: boolean;
  reason?: string;
}

/** 保存与暂停的结果：ok 为 false 时 reason 是主进程可读的稳定标识。 */
export type AutoBackupPauseOutcome = { ok: true } | { ok: false; reason: string };

/**
 * 写作界面注册的响应者：确认当前章节已写库后才允许主进程停止后端。
 *
 * 响应者被调用之前桥接层已经同步上了写入锁（见 isAutoBackupWriteLocked），因此它读到的
 * 快照在确认送达主进程之前不会再被输入改写。
 */
export type AutoBackupPauseResponder = (request: AutoBackupPauseRequest) => Promise<AutoBackupPauseOutcome>;

declare global {
  interface Window {
    openficDesktopHost?: {
      publishAppearance: (payload: DesktopAppearancePayload) => void;
      publishLanguage: (language: LanguageCode) => void;
      publishSocketDiagnostic: (payload: SocketDiagnosticPayload) => void;
      onAutoBackupPause?: (handler: (request: AutoBackupPauseRequest) => void) => () => void;
      onAutoBackupResume?: (handler: (request: AutoBackupResumeRequest) => void) => () => void;
      /**
       * 提交"已保存并暂停"确认。返回 false 表示主进程已经放弃这次备份（超时或已结算），
       * 写作界面必须立刻解除暂停。
       */
      acknowledgeAutoBackupPause?: (ack: AutoBackupPauseAck) => Promise<boolean>;
    };
  }
}

export function publishDesktopAppearance(payload: DesktopAppearancePayload): void {
  window.openficDesktopHost?.publishAppearance(payload);
}

export function publishDesktopLanguage(language: LanguageCode): void {
  window.openficDesktopHost?.publishLanguage(language);
}

export function publishSocketDiagnostic(payload: SocketDiagnosticPayload): void {
  window.openficDesktopHost?.publishSocketDiagnostic?.(payload);
}

// 定时自动备份的写作暂停协议

/**
 * 暂停状态放在模块级而不是某个组件里：主进程确认的是「这个写作窗口」而不是某次渲染，
 * 标签页切换、编辑器重新挂载后必须继续保持只读，直到收到解除消息。
 */
let autoBackupPaused = false;
/**
 * 暂停请求已经到达、这次请求还没有结算（保存写库还在途中）期间为 true。
 *
 * 保存快照取自编辑器当时的内容，请求在途期间的新输入既进不了快照，也不会被这次确认写库；
 * 一旦这时候确认成功，主进程就会停掉后端，那些字只留在编辑器里。因此这段时间必须和正式
 * 暂停一样只读。解除消息、确认被拒或本次尝试失败都会立刻结束这个状态。
 */
let autoBackupPauseInFlight = false;
/**
 * 最近一次收到解除消息的请求 id：只在保存写库还没返回时才有意义。
 *
 * 解除是主进程的权威信号（超时或这次备份已经取消），晚到的保存结果不允许再把窗口按回暂停；
 * 否则用户刚恢复的输入会在一次短暂的只读窗口里被吃掉。请求结算后立即清除，不长期保留。
 */
let autoBackupReleasedRequestId: string | null = null;
const autoBackupPauseListeners = new Set<() => void>();
const autoBackupPauseResponders = new Set<AutoBackupPauseResponder>();

/** 暂停与写入锁共用同一个订阅：两者的变化都要通知写作界面重新套用编辑权限。 */
function notifyAutoBackupPauseListeners(): void {
  for (const listener of autoBackupPauseListeners) listener();
}

function setAutoBackupPaused(next: boolean): void {
  if (autoBackupPaused === next) return;
  autoBackupPaused = next;
  notifyAutoBackupPauseListeners();
}

function setAutoBackupPauseInFlight(next: boolean): void {
  if (autoBackupPauseInFlight === next) return;
  autoBackupPauseInFlight = next;
  notifyAutoBackupPauseListeners();
}

/** 写作界面订阅暂停状态与写入锁；配合 useSyncExternalStore 使用，也用于直接同步套用只读。 */
export function subscribeAutoBackupPause(listener: () => void): () => void {
  autoBackupPauseListeners.add(listener);
  return () => {
    autoBackupPauseListeners.delete(listener);
  };
}

/** 当前窗口是否因为定时自动备份暂停了写作。 */
export function isAutoBackupPaused(): boolean {
  return autoBackupPaused;
}

/**
 * 当前窗口是否必须只读：已进入暂停，或暂停请求正在处理（保存写库在途）。
 *
 * 写作界面必须在收到暂停请求的同一个 tick 里同步套用这个结果，不能等下一次 React 渲染，
 * 否则保存快照取好之后、编辑器真正只读之前敲进去的字会被漏掉。
 */
export function isAutoBackupWriteLocked(): boolean {
  return autoBackupPaused || autoBackupPauseInFlight;
}

/** 注册写作界面的保存响应者，返回注销函数。 */
export function registerAutoBackupPauseResponder(responder: AutoBackupPauseResponder): () => void {
  autoBackupPauseResponders.add(responder);
  return () => {
    autoBackupPauseResponders.delete(responder);
  };
}

function readAutoBackupRequestId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const requestId = (payload as { requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
}

/**
 * 处理一次暂停请求：先同步锁住写作界面（不许再有新输入落进保存快照之后），
 * 再让写作界面保存当前章节，确认成功后才保持暂停并回复主进程。
 *
 * 没有挂载编辑器时（首页、笔记页等）没有待保存的章节，可以直接确认；有编辑器时任何
 * 失败都不确认，让这次备份取消并在下一个调度周期重试。
 */
async function handleAutoBackupPauseRequest(requestId: string): Promise<void> {
  const host = window.openficDesktopHost;
  if (!host?.acknowledgeAutoBackupPause) return;

  // 同步上锁必须发生在响应者读取快照之前：这个 tick 之后到确认送达之间的输入都不该存在。
  setAutoBackupPauseInFlight(true);
  if (autoBackupReleasedRequestId === requestId) autoBackupReleasedRequestId = null;

  let outcome: AutoBackupPauseOutcome = { ok: true };
  let accepted = false;
  try {
    if (autoBackupPauseResponders.size > 0) {
      const results = await Promise.all(
        [...autoBackupPauseResponders].map((responder) =>
          responder({ requestId }).catch((): AutoBackupPauseOutcome => ({ ok: false, reason: "pause-failed" })),
        ),
      );
      outcome = results.find((result) => !result.ok) ?? { ok: true };
    }
    // 期间收到解除时不再进入暂停：这次备份已经结束，编辑器必须留在可编辑状态。
    if (outcome.ok && autoBackupReleasedRequestId !== requestId) setAutoBackupPaused(true);

    try {
      accepted = await host.acknowledgeAutoBackupPause(
        outcome.ok
          ? { requestId, ok: true }
          : { requestId, ok: false, reason: outcome.reason },
      );
    } catch {
      accepted = false;
    }
  } finally {
    if (autoBackupReleasedRequestId === requestId) autoBackupReleasedRequestId = null;
    // 请求已经结算：暂停成立时由 paused 继续维持只读，否则立刻恢复可编辑。
    // 主进程不再等待这次确认（超时、已结算或本次备份被取消）时也必须解除，避免编辑器被永久锁住。
    setAutoBackupPauseInFlight(false);
    if (!accepted) setAutoBackupPaused(false);
  }
}

/**
 * 安装桌面壳与主进程之间的定时备份暂停通道。浏览器环境（非桌面壳）下是空操作。
 */
export function installDesktopAutoBackupBridge(): () => void {
  const host = window.openficDesktopHost;
  if (!host?.onAutoBackupPause) return () => undefined;
  const disposePause = host.onAutoBackupPause((request) => {
    const requestId = readAutoBackupRequestId(request);
    if (requestId === null) return;
    void handleAutoBackupPauseRequest(requestId);
  });
  const disposeResume = host.onAutoBackupResume?.((request) => {
    // 解除是主进程的权威信号：这次暂停已经结束。即使保存写库还在途中也要恢复可编辑，
    // 编辑器里的新输入会重新变成未保存改动，由正常保存路径接手，不会丢。
    const requestId = readAutoBackupRequestId(request);
    if (requestId !== null) autoBackupReleasedRequestId = requestId;
    setAutoBackupPauseInFlight(false);
    setAutoBackupPaused(false);
  });
  return () => {
    disposePause();
    disposeResume?.();
  };
}
