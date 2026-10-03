/**
 * 桌面壳定时自动备份暂停协议的浏览器回归：真实写作页 + 合成接口 + 桩化的桌面宿主。
 *
 * 主进程在停止后端前要求写作窗口确认「当前章节已保存且编辑已暂停」。这里用真实章节编辑器与真实
 * 保存路径验证四件事：保存还在途中时不得确认（确认必须等写库完成）；写库在途期间编辑器已经只读，
 * 因此快照之后没有输入能漏进已确认的保存；确认成功后编辑器保持只读并显示暂停提示，解除后恢复可编辑；
 * 保存失败、确认被主进程拒绝或收到解除消息时都必须回一个可编辑的编辑器，且不丢用户输入。
 *
 * 桌面宿主只桩住 openficDesktopHost 这一个接缝，其它请求仍走夹具的严格路由：任何未登记的请求都会
 * 以 501 失败并被记录，因此"暂停期间没有额外写库"这类断言由夹具的未预期请求检查兜底。
 */
import { expect, test, type Page } from "@playwright/test";
import type { AutoBackupPauseRequest, AutoBackupResumeRequest } from "../src/lib/desktop-appearance-bridge";

import {
  CHAPTER_CONTENT,
  CHAPTER_ID,
  PROJECT_ID,
  TIMESTAMP,
  VOLUME_ID,
  expectNoUnexpected,
  installAiErrorApp,
  seedLastChapterMemory,
} from "./ai-model-errors-fixture";

const EDITOR_SELECTOR = ".tiptap-editor .ProseMirror";
const PAUSE_BANNER_SELECTOR = ".chapter-editor-backup-pause";
const PAUSE_NOTICE = "Automatic backup in progress";
const TYPED_SUFFIX = " Extra words.";
/** 解除或拒绝确认之后写进去的后续内容。 */
const RECOVERED_SUFFIX = " Still editable.";
const EXPECT_TIMEOUT = 10_000;
/** 只匹配本项目章节正文的读写端点。 */
const CHAPTER_PATTERN = new RegExp(`/api/v1/chapters/${CHAPTER_ID}$`);

interface RecordedAcknowledgement {
  requestId?: unknown;
  ok?: unknown;
  reason?: unknown;
}

declare global {
  interface Window {
    __desktopBackupHost: {
      emitPause: (requestId: string) => void;
      emitResume: (requestId: string) => void;
      acknowledgements: RecordedAcknowledgement[];
    };
  }
}

test.use({
  serviceWorkers: "block",
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 10_000,
  navigationTimeout: 30_000,
});

test.describe.configure({ retries: 0, timeout: 60_000 });

/**
 * 真实桌面壳接缝的桩：记录确认，并允许用例主动发出暂停与解除消息。
 *
 * 确认结果按真实主进程的两个状态建模：`acceptAcknowledgements` 对应「主进程已经放弃这次尝试、
 * 一律拒绝确认」，收到解除消息的请求同样按已结算处理，晚到的确认不会返回成功。
 */
async function installDesktopBackupHost(
  page: Page,
  options: { acceptAcknowledgements?: boolean } = {},
): Promise<void> {
  await page.addInitScript((acceptAcknowledgements: boolean) => {
    const pauseHandlers: ((request: AutoBackupPauseRequest) => void)[] = [];
    const resumeHandlers: ((request: AutoBackupResumeRequest) => void)[] = [];
    const acknowledgements: RecordedAcknowledgement[] = [];
    /** 已经收到解除消息的请求：主进程不再等待它们的确认。 */
    const settledRequests = new Set<string>();

    window.__desktopBackupHost = {
      emitPause: (requestId: string) => {
        for (const handler of pauseHandlers) handler({ requestId });
      },
      emitResume: (requestId: string) => {
        settledRequests.add(requestId);
        for (const handler of resumeHandlers) handler({ requestId });
      },
      acknowledgements,
    };
    window.openficDesktopHost = {
      publishAppearance: () => undefined,
      publishLanguage: () => undefined,
      publishSocketDiagnostic: () => undefined,
      onAutoBackupPause: (handler) => {
        pauseHandlers.push(handler);
        return () => undefined;
      },
      onAutoBackupResume: (handler) => {
        resumeHandlers.push(handler);
        return () => undefined;
      },
      acknowledgeAutoBackupPause: (acknowledgement) => {
        const recorded = acknowledgement as RecordedAcknowledgement;
        acknowledgements.push(recorded);
        if (!acceptAcknowledgements) return Promise.resolve(false);
        const requestId = typeof recorded.requestId === "string" ? recorded.requestId : "";
        return Promise.resolve(!settledRequests.has(requestId));
      },
    };
  }, options.acceptAcknowledgements ?? true);
}

/** 与真实后端 PATCH /chapters/:id 的响应形状一致（消费方为 transformChapter）。 */
function chapterPayload(body: { title?: unknown; content?: unknown; word_count?: unknown }) {
  return {
    id: CHAPTER_ID,
    project_id: PROJECT_ID,
    volume_id: VOLUME_ID,
    title: typeof body.title === "string" ? body.title : "Synthetic Chapter",
    order: 1,
    word_count: typeof body.word_count === "number" ? body.word_count : 5,
    content: typeof body.content === "string" ? body.content : "",
    created_at: TIMESTAMP,
    updated_at: "2026-10-04T08:00:00Z",
  };
}

function readAcknowledgements(page: Page) {
  return page.evaluate(() => window.__desktopBackupHost.acknowledgements);
}

/** 打开项目并让写作页恢复记住的章节，返回正文编辑器。 */
async function openRememberedChapter(page: Page) {
  await page.goto("/");
  await seedLastChapterMemory(page, PROJECT_ID, CHAPTER_ID);
  await page.goto(`/projects/${PROJECT_ID}`);
  const editor = page.locator(EDITOR_SELECTOR);
  await expect(editor).toHaveText(CHAPTER_CONTENT, { timeout: EXPECT_TIMEOUT });
  return editor;
}

test("保存写库完成后才确认暂停，解除后恢复编辑", async ({ page }) => {
  await installDesktopBackupHost(page);
  const state = await installAiErrorApp(page, { language: "en" });

  const saved: { content: string }[] = [];
  let releaseFirstSave: () => void = () => undefined;
  const firstSaveGate = new Promise<void>((resolve) => {
    releaseFirstSave = resolve;
  });
  await page.route(CHAPTER_PATTERN, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as {
      title?: unknown;
      content?: unknown;
      word_count?: unknown;
    };
    saved.push({ content: typeof body.content === "string" ? body.content : "" });
    // 所有写库都停在闸门上：确认必须在写库完成之后，因此闸门未放开前不该出现任何确认。
    await firstSaveGate;
    await route.fulfill({ status: 200, json: chapterPayload(body) });
  });

  try {
    const editor = await openRememberedChapter(page);
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(TYPED_SUFFIX);
    // 以编辑器里的真实文本为基准：保存必须把这次改动原样写库。
    const expectedContent = await editor.evaluate((node) => node.textContent ?? "");
    expect(expectedContent).toContain(TYPED_SUFFIX.trim());
    await expect(editor).toHaveText(expectedContent, { timeout: EXPECT_TIMEOUT });

    await page.evaluate(() => window.__desktopBackupHost.emitPause("auto-backup-1"));
    // 保存请求已经发出但还没写库：此时既不能确认，也不能进入暂停。
    await expect
      .poll(() => saved.length, { timeout: EXPECT_TIMEOUT })
      .toBeGreaterThan(0);
    expect(await readAcknowledgements(page)).toEqual([]);
    await expect(page.locator(PAUSE_BANNER_SELECTOR)).toHaveCount(0);

    // 写库在途期间编辑器已经只读：这段时间的输入不会落在保存快照之后又被确认成功。
    await expect(editor).toHaveAttribute("contenteditable", "false");
    await page.evaluate(() => {
      const node = document.querySelector(".tiptap-editor .ProseMirror");
      if (node instanceof HTMLElement) node.focus();
    });
    await page.keyboard.type("ZZZ");
    await expect(editor).toHaveText(expectedContent);

    releaseFirstSave();
    await expect
      .poll(() => readAcknowledgements(page), { timeout: EXPECT_TIMEOUT })
      .toEqual([{ requestId: "auto-backup-1", ok: true }]);

    // 确认里必须带上刚写库的那次改动，而不是只确认「编辑器存在」；在途期间的输入不允许混进来。
    expect(saved[0]?.content).toBe(expectedContent);
    await expect(page.locator(PAUSE_BANNER_SELECTOR)).toBeVisible();
    await expect(page.locator(PAUSE_BANNER_SELECTOR)).toContainText(PAUSE_NOTICE);
    await expect(editor).toHaveAttribute("contenteditable", "false");

    // 暂停期间不能继续写正文。
    await page.evaluate(() => {
      const node = document.querySelector(".tiptap-editor .ProseMirror");
      if (node instanceof HTMLElement) node.focus();
    });
    await page.keyboard.type("ZZZ");
    await expect(editor).toHaveText(expectedContent);

    await page.evaluate(() => window.__desktopBackupHost.emitResume("auto-backup-1"));
    await expect(page.locator(PAUSE_BANNER_SELECTOR)).toHaveCount(0);
    await expect(editor).toHaveAttribute("contenteditable", "true");

    await expectNoUnexpected(page, state);
  } finally {
    await page.unroute(CHAPTER_PATTERN);
  }
});

test("保存失败时回否定确认且不进入暂停", async ({ page }) => {
  await installDesktopBackupHost(page);
  await installAiErrorApp(page, { language: "en" });

  const attempted: string[] = [];
  await page.route(CHAPTER_PATTERN, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    attempted.push(route.request().method());
    await route.fulfill({ status: 500, json: { detail: "synthetic save failure" } });
  });

  try {
    const editor = await openRememberedChapter(page);
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(TYPED_SUFFIX);
    const expectedContent = await editor.evaluate((node) => node.textContent ?? "");
    expect(expectedContent).toContain(TYPED_SUFFIX.trim());
    await expect(editor).toHaveText(expectedContent, { timeout: EXPECT_TIMEOUT });

    await page.evaluate(() => window.__desktopBackupHost.emitPause("auto-backup-failed"));
    await expect
      .poll(() => readAcknowledgements(page), { timeout: EXPECT_TIMEOUT })
      .toEqual([{ requestId: "auto-backup-failed", ok: false, reason: "save-failed" }]);

    expect(attempted.length).toBeGreaterThan(0);
    await expect(page.locator(PAUSE_BANNER_SELECTOR)).toHaveCount(0);
    await expect(editor).toHaveAttribute("contenteditable", "true");

    // 失败不锁住编辑器：失败之后的输入照常生效，仍然是未保存改动而不是被丢弃。
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(RECOVERED_SUFFIX);
    await expect(editor).toHaveText(`${expectedContent}${RECOVERED_SUFFIX}`);
  } finally {
    await page.unroute(CHAPTER_PATTERN);
  }
});

test("确认被主进程拒绝时立刻恢复编辑", async ({ page }) => {
  // 主进程超时或已经结算：所有确认都会返回 false，写作窗口必须自行解除只读。
  await installDesktopBackupHost(page, { acceptAcknowledgements: false });
  const state = await installAiErrorApp(page, { language: "en" });

  await page.route(CHAPTER_PATTERN, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as {
      title?: unknown;
      content?: unknown;
      word_count?: unknown;
    };
    await route.fulfill({ status: 200, json: chapterPayload(body) });
  });

  try {
    const editor = await openRememberedChapter(page);
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(TYPED_SUFFIX);
    const expectedContent = await editor.evaluate((node) => node.textContent ?? "");
    expect(expectedContent).toContain(TYPED_SUFFIX.trim());
    await expect(editor).toHaveText(expectedContent, { timeout: EXPECT_TIMEOUT });

    await page.evaluate(() => window.__desktopBackupHost.emitPause("auto-backup-refused"));
    // 保存成功但确认被拒：只发了一次肯定确认，绝不进入暂停。
    await expect
      .poll(() => readAcknowledgements(page), { timeout: EXPECT_TIMEOUT })
      .toEqual([{ requestId: "auto-backup-refused", ok: true }]);
    await expect(page.locator(PAUSE_BANNER_SELECTOR)).toHaveCount(0);
    await expect(editor).toHaveAttribute("contenteditable", "true");

    // 解除只读之后输入照常写进正文，被拒的确认不会吞掉用户的新内容。
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(RECOVERED_SUFFIX);
    await expect(editor).toHaveText(`${expectedContent}${RECOVERED_SUFFIX}`);

    await expectNoUnexpected(page, state);
  } finally {
    await page.unroute(CHAPTER_PATTERN);
  }
});

test("写库途中收到解除消息时恢复编辑且保留新输入", async ({ page }) => {
  await installDesktopBackupHost(page);
  const state = await installAiErrorApp(page, { language: "en" });

  const saved: string[] = [];
  let releaseSave: () => void = () => undefined;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(CHAPTER_PATTERN, async (route) => {
    if (route.request().method() !== "PATCH") {
      await route.fallback();
      return;
    }
    const body = route.request().postDataJSON() as {
      title?: unknown;
      content?: unknown;
      word_count?: unknown;
    };
    saved.push(typeof body.content === "string" ? body.content : "");
    await saveGate;
    await route.fulfill({ status: 200, json: chapterPayload(body) });
  });

  try {
    const editor = await openRememberedChapter(page);
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(TYPED_SUFFIX);
    const expectedContent = await editor.evaluate((node) => node.textContent ?? "");
    expect(expectedContent).toContain(TYPED_SUFFIX.trim());
    await expect(editor).toHaveText(expectedContent, { timeout: EXPECT_TIMEOUT });

    await page.evaluate(() => window.__desktopBackupHost.emitPause("auto-backup-release"));
    await expect
      .poll(() => saved.length, { timeout: EXPECT_TIMEOUT })
      .toBeGreaterThan(0);
    await expect(editor).toHaveAttribute("contenteditable", "false");
    expect(await readAcknowledgements(page)).toEqual([]);

    // 主进程解除这次备份（超时或取消）：写库还在途中也必须立刻恢复可编辑，不能一直锁着。
    await page.evaluate(() => window.__desktopBackupHost.emitResume("auto-backup-release"));
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(page.locator(PAUSE_BANNER_SELECTOR)).toHaveCount(0);
    expect(await readAcknowledgements(page)).toEqual([]);

    // 解除之后写进去的字不能被稍后返回的旧快照结果覆盖掉。
    await editor.click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(RECOVERED_SUFFIX);
    const recoveredContent = `${expectedContent}${RECOVERED_SUFFIX}`;
    await expect(editor).toHaveText(recoveredContent);

    releaseSave();
    // 迟到的确认不再被主进程接受（请求已经结算）：写库内容仍是暂停那一刻的快照。
    await expect
      .poll(() => readAcknowledgements(page), { timeout: EXPECT_TIMEOUT })
      .toEqual([{ requestId: "auto-backup-release", ok: true }]);
    expect(saved[0]).toBe(expectedContent);
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(editor).toHaveText(recoveredContent);

    await expectNoUnexpected(page, state);
  } finally {
    await page.unroute(CHAPTER_PATTERN);
  }
});
