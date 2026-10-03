/**
 * Inline AI 浮层定位的浏览器回归：真实写作页 + 真实本地章节记忆 + 真实选区与点击。
 *
 * 每个组合在同一章节正文上执行 Control+A 全选，等待真实触发器，正常点击打开菜单，
 * 正常点击“润色”，断言触发器、菜单、动作按钮与结果表面的包围盒都完整落在视口内
 * （仅允许 1px 取整误差）；随后点击“拒绝”，断言正文未被改动。
 *
 * 接口是严格合成夹具：只有 inline-ai 成功分支返回真实的 InlineAiTransformResponse
 * 四字段，其余端点、未登记请求、未知 socket 事件与页面异常都会导致断言失败。
 * 不使用 force click、不放大超时、不注入人工定位 CSS 或测试专用应用钩子。
 *
 * 另有两组内部滚动回归：视口从 1600x1000 收缩到 1280x400 后，在菜单内部用原生
 * 鼠标滚轮滚动，菜单必须保持打开且行内滚动真实推进、零 AI 请求；以及正常视口下
 * 长候选项的结果 diff 原生滚动，候选与正文在显式“拒绝”前保持不变，拒绝后正文原样保留。
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  CHAPTER_CONTENT,
  CHAPTER_ID,
  INLINE_MODEL,
  INLINE_RESULT_TEXT,
  PROJECT_ID,
  expectNoUnexpected,
  expectRequestShape,
  installAiErrorApp,
  seedLastChapterMemory,
  type Language,
} from "./ai-model-errors-fixture";

test.use({
  serviceWorkers: "block",
  trace: "off",
  video: "off",
  screenshot: "off",
});

const LANGUAGES: Language[] = ["en", "zh-CN"];

const VIEWPORTS = [
  { width: 1600, height: 1000 },
  { width: 1280, height: 720 },
];

/** 仅允许的取整误差（像素）。 */
const VIEWPORT_TOLERANCE = 1;

const POSITION_LABELS: Record<Language, { trigger: string; polish: string; reject: string }> = {
  en: { trigger: "AI rewrite", polish: "Polish", reject: "Reject" },
  "zh-CN": { trigger: "AI 改写", polish: "润色", reject: "拒绝" },
};

/** 通过共享夹具的原生 IndexedDB 接缝预置“最后访问章节”，让写作页自动打开编辑器。 */
async function openWritingWithChapter(page: Page) {
  await page.goto("/");
  await seedLastChapterMemory(page, PROJECT_ID, CHAPTER_ID);
  await page.goto(`/projects/${PROJECT_ID}`);
  await expect(page.locator(".tiptap-editor .ProseMirror")).toBeVisible();
}

/** 断言元素包围盒完整落在视口内（仅允许 1px 取整误差）。 */
async function expectWithinViewport(page: Page, locator: Locator, label: string) {
  const box = await locator.boundingBox();
  const viewport = page.viewportSize();
  expect(viewport, `${label}: viewport size is known`).not.toBeNull();
  expect(box, `${label}: has a bounding box`).not.toBeNull();
  if (!box || !viewport) return;
  expect(box.width, `${label}: has a positive width`).toBeGreaterThan(0);
  expect(box.height, `${label}: has a positive height`).toBeGreaterThan(0);
  expect(box.x, `${label}: left edge is inside the viewport`).toBeGreaterThanOrEqual(
    -VIEWPORT_TOLERANCE,
  );
  expect(box.y, `${label}: top edge is inside the viewport`).toBeGreaterThanOrEqual(
    -VIEWPORT_TOLERANCE,
  );
  expect(box.x + box.width, `${label}: right edge is inside the viewport`).toBeLessThanOrEqual(
    viewport.width + VIEWPORT_TOLERANCE,
  );
  expect(box.y + box.height, `${label}: bottom edge is inside the viewport`).toBeLessThanOrEqual(
    viewport.height + VIEWPORT_TOLERANCE,
  );
}

for (const language of LANGUAGES) {
  const labels = POSITION_LABELS[language];

  for (const viewport of VIEWPORTS) {
    const size = `${viewport.width}x${viewport.height}`;

    test.describe(`${language} ${size}`, () => {
      test.use({ viewport });

      test(`${language} ${size}: trigger, menu and result stay inside the viewport`, async ({
        page,
      }) => {
        const state = await installAiErrorApp(page, { language });
        state.enqueue("inline-ai", { kind: "success" });

        await openWritingWithChapter(page);
        await page.locator(".tiptap-editor .ProseMirror").click();
        await page.keyboard.press("Control+a");

        const trigger = page.locator(".inline-ai-trigger");
        await expect(trigger).toBeVisible();
        await expect(trigger).toHaveText(labels.trigger);
        await expectWithinViewport(page, trigger, "trigger");

        await trigger.click();

        const menu = page.locator(".inline-ai-menu");
        await expect(menu).toBeVisible();
        await expectWithinViewport(page, menu, "menu");

        const polish = menu.getByRole("button", { name: labels.polish, exact: true });
        await expect(polish).toBeVisible();
        await expectWithinViewport(page, polish, "polish action");

        await polish.click();

        const result = menu.locator(".inline-ai-result");
        await expect(result).toBeVisible();
        await expect(result).toContainText(INLINE_RESULT_TEXT);
        await expect(result).toContainText(INLINE_MODEL);
        await expectWithinViewport(page, result, "result");

        const reject = result.getByRole("button", { name: labels.reject, exact: true });
        await expect(reject).toBeVisible();
        await expectWithinViewport(page, reject, "reject action");

        await reject.click();

        await expect(menu).toHaveCount(0);
        await expect(page.locator(".tiptap-editor .ProseMirror")).toContainText(CHAPTER_CONTENT);

        // 请求报文必须与真实调用方一致：省略 instruction 时序列化为 null，selected_text 为整章正文。
        const inlineKeys = ["action", "chapter_id", "instruction", "project_id", "selected_text"];
        expect(expectRequestShape(state, "inline-ai", 0, inlineKeys)).toEqual({
          project_id: PROJECT_ID,
          chapter_id: CHAPTER_ID,
          action: "polish",
          selected_text: CHAPTER_CONTENT,
          instruction: null,
        });
        await expectNoUnexpected(page, state);
      });
    });
  }
}

/**
 * 仅供长候选项滚动回归使用的多行合成结果：与整章正文没有公共行，足以让
 * .inline-ai-result__diff（max-height 260px）真实溢出并产生原生滚动。
 */
const LONG_CANDIDATE_TEXT = Array.from(
  { length: 30 },
  (_, index) => `Synthetic polished line ${index + 1} for the long candidate.`,
).join("\n");

/** 读取元素自身的纵向滚动度量。 */
async function readScrollMetrics(locator: Locator) {
  return locator.evaluate((node) => ({
    scrollTop: node.scrollTop,
    scrollHeight: node.scrollHeight,
    clientHeight: node.clientHeight,
  }));
}

/** 在元素内部给定比例高度处，用原生鼠标滚轮滚动不超过剩余行程的一半。 */
async function wheelInside(page: Page, locator: Locator, overflow: number, fraction: number) {
  const box = await locator.boundingBox();
  expect(box, "scroll surface has a bounding box").not.toBeNull();
  if (!box) return;
  const delta = Math.max(1, Math.floor(overflow / 2));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * fraction);
  await page.mouse.wheel(0, delta);
}

// ============================================================
// 回归 1：视口收缩后，菜单内部的原生滚动不得关闭浮层
// ============================================================

for (const language of LANGUAGES) {
  const labels = POSITION_LABELS[language];

  test.describe(`${language} resized menu internal scroll`, () => {
    test.use({ viewport: { width: 1600, height: 1000 } });

    test(`${language}: native scroll inside the resized menu keeps it open`, async ({ page }) => {
      const state = await installAiErrorApp(page, { language });

      await openWritingWithChapter(page);
      await page.locator(".tiptap-editor .ProseMirror").click();
      await page.keyboard.press("Control+a");

      const trigger = page.locator(".inline-ai-trigger");
      await expect(trigger).toBeVisible();
      await expect(trigger).toHaveText(labels.trigger);
      await trigger.click();

      const menu = page.locator(".inline-ai-menu");
      await expect(menu).toBeVisible();
      await expectWithinViewport(page, menu, "menu before resize");

      await page.setViewportSize({ width: 1280, height: 400 });
      await expect
        .poll(async () => {
          const box = await menu.boundingBox();
          return box ? box.y + box.height : Number.POSITIVE_INFINITY;
        })
        .toBeLessThanOrEqual(400 + VIEWPORT_TOLERANCE);
      await expectWithinViewport(page, menu, "menu after resize");

      const before = await readScrollMetrics(menu);
      expect(before.scrollHeight, "resized menu really overflows").toBeGreaterThan(
        before.clientHeight,
      );
      expect(before.scrollTop, "resized menu starts unscrolled").toBe(0);

      await wheelInside(page, menu, before.scrollHeight - before.clientHeight, 0.9);

      await expect.poll(async () => (await readScrollMetrics(menu)).scrollTop).toBeGreaterThan(0);
      await expect(menu).toBeVisible();
      await expect(menu).toHaveCount(1);
      await expectWithinViewport(page, menu, "menu after native scroll");

      await expect(page.locator(".tiptap-editor .ProseMirror")).toContainText(CHAPTER_CONTENT);
      expect(
        state.requests.filter((request) => request.endpoint === "inline-ai"),
        "menu-only interaction issues no AI request",
      ).toHaveLength(0);
      await expectNoUnexpected(page, state);
    });
  });
}

// ============================================================
// 回归 2：正常视口下长候选项 diff 的原生滚动不得关闭浮层
// ============================================================

for (const language of LANGUAGES) {
  const labels = POSITION_LABELS[language];

  test.describe(`${language} long candidate diff internal scroll`, () => {
    test.use({ viewport: { width: 1600, height: 1000 } });

    test(`${language}: native diff scrolling keeps the candidate until reject`, async ({
      page,
    }) => {
      const state = await installAiErrorApp(page, { language });
      state.enqueue("inline-ai", { kind: "success", inlineResult: LONG_CANDIDATE_TEXT });

      await openWritingWithChapter(page);
      const editor = page.locator(".tiptap-editor .ProseMirror");
      await editor.click();
      await page.keyboard.press("Control+a");

      const trigger = page.locator(".inline-ai-trigger");
      await expect(trigger).toBeVisible();
      await trigger.click();

      const menu = page.locator(".inline-ai-menu");
      await expect(menu).toBeVisible();
      await expectWithinViewport(page, menu, "menu before request");

      await menu.getByRole("button", { name: labels.polish, exact: true }).click();

      const result = menu.locator(".inline-ai-result");
      await expect(result).toBeVisible();
      const diff = result.locator(".inline-ai-result__diff");
      await expect(diff).toBeVisible();
      await expectWithinViewport(page, result, "result before diff scroll");

      // 结果数据证明：候选的每一行都必须作为新增行原样出现在 diff 里，浮层头部显示真实模型。
      const addedRows = diff.locator(".inline-ai-result__line--added .inline-ai-result__text");
      await expect(addedRows).toHaveText(LONG_CANDIDATE_TEXT.split("\n"));
      await expect(result.locator(".inline-ai-result__header")).toContainText(INLINE_MODEL);

      const before = await readScrollMetrics(diff);
      expect(before.scrollHeight, "long candidate diff really overflows").toBeGreaterThan(
        before.clientHeight,
      );
      expect(before.scrollTop, "long candidate diff starts unscrolled").toBe(0);

      await wheelInside(page, diff, before.scrollHeight - before.clientHeight, 0.5);

      await expect.poll(async () => (await readScrollMetrics(diff)).scrollTop).toBeGreaterThan(0);
      await expect(menu).toBeVisible();
      await expect(menu).toHaveCount(1);
      await expect(result).toBeVisible();
      await expectWithinViewport(page, menu, "menu after diff scroll");
      await expectWithinViewport(page, result, "result after diff scroll");

      // 候选在滚动后仍逐行完全一致：原生滚动没有改写或丢失任何一行。
      await expect(addedRows).toHaveText(LONG_CANDIDATE_TEXT.split("\n"));

      // 候选仍未应用：正文保持原样，长候选项只出现在浮层里。
      await expect(editor).toContainText(CHAPTER_CONTENT);
      await expect(editor).not.toContainText("Synthetic polished line 30");

      await result.getByRole("button", { name: labels.reject, exact: true }).click();

      await expect(menu).toHaveCount(0);
      await expect(editor).toContainText(CHAPTER_CONTENT);
      await expect(editor).not.toContainText("Synthetic polished line 30");

      const inlineKeys = ["action", "chapter_id", "instruction", "project_id", "selected_text"];
      expect(expectRequestShape(state, "inline-ai", 0, inlineKeys)).toEqual({
        project_id: PROJECT_ID,
        chapter_id: CHAPTER_ID,
        action: "polish",
        selected_text: CHAPTER_CONTENT,
        instruction: null,
      });
      await expectNoUnexpected(page, state);
    });
  });
}
