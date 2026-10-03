/**
 * AI 模型错误分类的浏览器回归：真实消费方点击 + 严格合成接口。
 *
 * 每个用例都先让后端返回固定的 400 + code（模型不可用），断言界面显示本地化引导
 * 且不出现后端 message；随后让后端返回普通 400 字符串 detail（含「模型」字样），
 * 断言消费方仍沿用原有普通失败展示，证明没有按文案推断。onboarding 用例再补一次
 * 真实 provider 502 + 安全字符串 detail，证明它同样不被当成模型不可用。
 *
 * 不访问真实 provider，不读写真实项目数据；未登记的请求会被记录并导致断言失败。
 */
import { expect, test, type Page } from "@playwright/test";

import {
  CHAPTER_CONTENT,
  CHAPTER_ID,
  GUIDANCE_ANCHORS,
  installAiErrorApp,
  LABELS,
  ORDINARY_DETAIL,
  PROJECT_ID,
  PROJECT_TITLE,
  ROOT_OUTLINE_ID,
  UNAVAILABLE_MESSAGE,
  expectNoUnexpected,
  expectRequestShape,
  seedLastChapterMemory,
  type Language,
} from "./ai-model-errors-fixture";

test.use({
  serviceWorkers: "block",
  trace: "off",
  video: "off",
  screenshot: "off",
  viewport: { width: 1440, height: 1000 },
});

const LANGUAGES: Language[] = ["en", "zh-CN"];

/** 后端 ProviderError 的安全字符串 detail（真实 502 文案，story_setup.py）。 */
const PROVIDER_FAILURE_DETAIL = "模型服务调用失败，请稍后重试";

/**
 * 一致性分析回传的 issue 必须与后端返回的合成问题完全一致（夹具不导出该常量，
 * 因此按已知合成值显式声明，包含 sources，不做字段投影）。
 */
const EXPECTED_ISSUE = {
  type: "character_age",
  severity: "warning",
  message: "synthetic issue message",
  evidence: ["synthetic evidence"],
  suggestion: "synthetic suggestion",
  sources: [
    {
      chapter_id: CHAPTER_ID,
      chapter_order: 1,
      chapter_title: "Synthetic Chapter",
      excerpt: "synthetic excerpt",
      quote: "synthetic quote",
    },
  ],
};

function toastWithText(page: Page, text: string) {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

async function expectGuidanceToast(page: Page, language: Language) {
  for (const anchor of GUIDANCE_ANCHORS[language]) {
    await expect(toastWithText(page, anchor).first()).toBeVisible();
  }
  await expect(toastWithText(page, UNAVAILABLE_MESSAGE)).toHaveCount(0);
  await expect(page.getByText(UNAVAILABLE_MESSAGE)).toHaveCount(0);
}

async function expectOrdinaryToast(page: Page) {
  await expect(toastWithText(page, ORDINARY_DETAIL).first()).toBeVisible();
}

/** 通过共享夹具的原生 IndexedDB 接缝预置“最后访问章节”，让写作页自动打开编辑器。 */
async function openWritingWithChapter(page: Page) {
  await page.goto("/");
  await seedLastChapterMemory(page, PROJECT_ID, CHAPTER_ID);
  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.locator(".tiptap-editor .ProseMirror")).toBeVisible();
}

for (const language of LANGUAGES) {
  const labels = LABELS[language];

  test(`${language}: onboarding story setup shows localized model guidance and keeps ordinary 400 failures`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language, includeProject: false });
    state.enqueue("story-setup", { kind: "unavailable" });
    state.enqueue("story-setup", { kind: "detail", status: 400, detail: ORDINARY_DETAIL });
    state.enqueue("story-setup", { kind: "detail", status: 502, detail: PROVIDER_FAILURE_DETAIL });

    await page.goto("/");
    const dialog = page.locator(".onboarding-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: labels.begin, exact: true }).click();
    await dialog.locator(".onboarding-choice").filter({ hasText: labels.inspire }).click();
    await dialog.getByPlaceholder(labels.ideaPlaceholder).fill("Synthetic inspiration");
    await dialog.getByRole("button", { name: labels.generate, exact: true }).click();

    const errorBox = dialog.locator(".onboarding-story-error");
    await expect(errorBox).toBeVisible();
    for (const anchor of GUIDANCE_ANCHORS[language]) {
      await expect(errorBox).toContainText(anchor);
    }
    await expect(errorBox).not.toContainText(UNAVAILABLE_MESSAGE);

    // 普通 400 的字符串 detail 含有「模型」，也绝不能被当成模型不可用。
    await expect(dialog.getByRole("button", { name: labels.generate, exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: labels.generate, exact: true }).click();
    await expect(errorBox).toContainText(labels.generateFailedPrefix);
    await expect(errorBox).toContainText(ORDINARY_DETAIL);

    // 真实 provider 故障：502 + 安全字符串 detail，展示普通失败前缀与原始 detail，
    // 不能出现模型不可用引导，也不能出现「未配置轻量模型」的说法。
    await expect(dialog.getByRole("button", { name: labels.generate, exact: true })).toBeEnabled();
    await dialog.getByRole("button", { name: labels.generate, exact: true }).click();
    await expect(errorBox).toContainText(labels.generateFailedPrefix);
    await expect(errorBox).toContainText(PROVIDER_FAILURE_DETAIL);
    for (const anchor of GUIDANCE_ANCHORS[language]) {
      await expect(errorBox).not.toContainText(anchor);
    }
    await expect(errorBox).not.toContainText(UNAVAILABLE_MESSAGE);

    expect(expectRequestShape(state, "story-setup", 0, ["inspiration"])).toEqual({
      inspiration: "Synthetic inspiration",
    });
    expect(expectRequestShape(state, "story-setup", 1, ["inspiration"])).toEqual({
      inspiration: "Synthetic inspiration",
    });
    expect(expectRequestShape(state, "story-setup", 2, ["inspiration"])).toEqual({
      inspiration: "Synthetic inspiration",
    });
    await expectNoUnexpected(page, state);
  });

  test(`${language}: inline AI keeps its prefix and shows localized model guidance`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language });
    state.enqueue("inline-ai", { kind: "unavailable" });
    state.enqueue("inline-ai", { kind: "detail", status: 400, detail: ORDINARY_DETAIL });

    await openWritingWithChapter(page);
    await page.locator(".tiptap-editor .ProseMirror").click();
    await page.keyboard.press("Control+a");
    const trigger = page.locator(".inline-ai-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();

    const menu = page.locator(".inline-ai-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: labels.polish, exact: true }).click();

    for (const anchor of GUIDANCE_ANCHORS[language]) {
      await expect(toastWithText(page, anchor).first()).toBeVisible();
    }
    await expect(toastWithText(page, labels.aiRewriteFailed).first()).toBeVisible();
    await expect(page.getByText(UNAVAILABLE_MESSAGE)).toHaveCount(0);

    await menu.getByRole("button", { name: labels.polish, exact: true }).click();
    await expectOrdinaryToast(page);

    // 两次请求（不可用 / 普通失败）的原始报文都必须完全一致：真实调用方在省略
    // instruction 时序列化为 null（inline-ai-api.ts），selected_text 为整章正文。
    const inlineKeys = ["action", "chapter_id", "instruction", "project_id", "selected_text"];
    const expectedInline = {
      project_id: PROJECT_ID,
      chapter_id: CHAPTER_ID,
      action: "polish",
      selected_text: CHAPTER_CONTENT,
      instruction: null,
    };
    expect(expectRequestShape(state, "inline-ai", 0, inlineKeys)).toEqual(expectedInline);
    expect(expectRequestShape(state, "inline-ai", 1, inlineKeys)).toEqual(expectedInline);
    await expectNoUnexpected(page, state);
  });

  test(`${language}: outline AI shows localized model guidance and keeps ordinary failures`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language });
    state.enqueue("outline-improve", { kind: "unavailable" });
    state.enqueue("outline-improve", { kind: "detail", status: 400, detail: ORDINARY_DETAIL });

    await page.goto(`/outline?projectId=${PROJECT_ID}`);
    const node = page.locator(".outline-tree__label").first();
    await expect(node).toBeVisible();
    await node.click();

    const actions = page.locator(".outline-ai");
    await expect(actions).toBeVisible();
    await actions.getByRole("button", { name: labels.improve, exact: true }).click();
    const errorBox = page.locator(".outline-ai__error");
    await expect(errorBox).toBeVisible();
    for (const anchor of GUIDANCE_ANCHORS[language]) {
      await expect(errorBox).toContainText(anchor);
    }
    await expect(errorBox).not.toContainText(UNAVAILABLE_MESSAGE);

    await actions.getByRole("button", { name: labels.improve, exact: true }).click();
    await expect(errorBox).toContainText(ORDINARY_DETAIL);

    // 两次大纲请求（不可用 / 普通失败）的原始报文完全一致。
    const outlineKeys = ["instruction", "outline_id"];
    const expectedOutline = { outline_id: ROOT_OUTLINE_ID, instruction: null };
    expect(expectRequestShape(state, "outline-improve", 0, outlineKeys)).toEqual(expectedOutline);
    expect(expectRequestShape(state, "outline-improve", 1, outlineKeys)).toEqual(expectedOutline);
    await expectNoUnexpected(page, state);
  });

  test(`${language}: consistency check and issue analysis distinguish unavailable from ordinary failures`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language });
    state.enqueue("consistency-check", { kind: "unavailable" });
    state.enqueue("consistency-check", { kind: "detail", status: 400, detail: ORDINARY_DETAIL });
    state.enqueue("consistency-check", { kind: "success" });
    state.enqueue("consistency-analyze", { kind: "unavailable" });
    state.enqueue("consistency-analyze", { kind: "detail", status: 400, detail: ORDINARY_DETAIL });

    await page.goto(`/consistency?projectId=${PROJECT_ID}`);
    await expect(page.locator(".consistency-page__header [role=combobox]").first()).toContainText(
      PROJECT_TITLE,
    );
    const checkButton = page
      .locator(".consistency-page__header")
      .getByRole("button", { name: labels.check, exact: true });
    await expect(checkButton).toBeEnabled();

    await checkButton.click();
    await expectGuidanceToast(page, language);

    await expect(checkButton).toBeEnabled();
    await checkButton.click();
    await expectOrdinaryToast(page);

    await expect(checkButton).toBeEnabled();
    await checkButton.click();
    const issueCard = page.locator(".consistency-issue").first();
    await expect(issueCard).toBeVisible();

    const analyzeButton = issueCard.getByRole("button", {
      name: labels.analyze,
      exact: true,
      includeHidden: true,
    });
    await analyzeButton.click();
    await expectGuidanceToast(page, language);

    await expect(analyzeButton).toBeEnabled();
    await analyzeButton.click();
    await expectOrdinaryToast(page);

    // 三次检查请求（不可用 / 普通失败 / 成功）报文完全一致。
    const checkKeys = ["chapter_id", "scope", "volume_id"];
    const expectedCheck = { scope: "chapter", chapter_id: CHAPTER_ID, volume_id: null };
    expect(expectRequestShape(state, "consistency-check", 0, checkKeys)).toEqual(expectedCheck);
    expect(expectRequestShape(state, "consistency-check", 1, checkKeys)).toEqual(expectedCheck);
    expect(expectRequestShape(state, "consistency-check", 2, checkKeys)).toEqual(expectedCheck);

    // 两次分析请求（不可用 / 普通失败）回传的 issue 与后端合成问题完全一致，含 sources。
    const analyzeKeys = ["chapter_id", "issue", "scope", "volume_id"];
    const expectedAnalyze = {
      scope: "chapter",
      chapter_id: CHAPTER_ID,
      volume_id: null,
      issue: EXPECTED_ISSUE,
    };
    const firstAnalyze = expectRequestShape(state, "consistency-analyze", 0, analyzeKeys);
    const secondAnalyze = expectRequestShape(state, "consistency-analyze", 1, analyzeKeys);
    expect(firstAnalyze).toEqual(expectedAnalyze);
    expect(secondAnalyze).toEqual(expectedAnalyze);
    await expectNoUnexpected(page, state);
  });
}
