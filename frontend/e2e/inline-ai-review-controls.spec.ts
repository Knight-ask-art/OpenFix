/**
 * Inline AI 结果表面审查控件的浏览器回归（PRD §11：接受 / 拒绝 / 重新生成 / 插入下方）。
 *
 * 真实写作页 + 真实选区 + 真实点击，接口是严格合成夹具：只有 inline-ai 成功分支返回真实的
 * InlineAiTransformResponse 四字段，未登记请求、未知 socket 事件与页面异常都会导致断言失败。
 *
 * 覆盖点：
 * 1. 结果表面同时提供四个动作，且重新生成复用同一动作、同一选区与同一指令，浮层换成新候选时
 *    正文必须逐字保持原样；
 * 2. 重新生成失败不得写入正文，原候选与已保存选区都保留在结果表面；
 * 3. 插入下方在已保存选区最后一个段落之后插入候选，原文完整保留，候选紧跟在原文之后；
 * 4. 选区结束在段落中间时，插入下方仍把候选放在该段落之后，不把原文段落切成两半；
 * 5. 候选显示后正文发生变化时，插入下方沿用选区冲突守卫，拒绝写入；
 * 6. 文档被删短到已保存选区范围之外时，接受沿用同一守卫：不抛页面异常、不写正文、给出冲突提示。
 *
 * 不使用 force click、不放大超时、不注入测试专用应用钩子。
 */
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  CHAPTER_CONTENT,
  CHAPTER_ID,
  INLINE_MODEL,
  INLINE_RESULT_TEXT,
  ORDINARY_DETAIL,
  PROJECT_ID,
  TIMESTAMP,
  VOLUME_ID,
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
  viewport: { width: 1600, height: 1000 },
});

const LANGUAGES: Language[] = ["en", "zh-CN"];

/** 重新生成分支返回的第二个候选：必须与首次候选可区分，才能证明浮层真的换了内容。 */
const REGENERATED_TEXT = "Synthetic second-pass candidate for the selected text.";
/** 自定义指令分支使用的合成指令：重新生成必须原样复用。 */
const CUSTOM_INSTRUCTION = "Synthetic custom instruction for the selection.";
/** 候选显示后用户继续输入的内容，用于制造过期选区。 */
const PENDING_EDIT = "Synthetic pending edit ";
/** 候选显示后替换整章正文的短文本：比已保存选区更短，用于制造文档缩短后的过期选区。 */
const SHRUNK_CONTENT = "Shorter draft";

const INLINE_REQUEST_KEYS = ["action", "chapter_id", "instruction", "project_id", "selected_text"];

interface ReviewLabels {
  trigger: string;
  polish: string;
  accept: string;
  reject: string;
  regenerate: string;
  insertBelow: string;
  customPlaceholder: string;
  customSubmit: string;
  conflict: string;
}

const REVIEW_LABELS: Record<Language, ReviewLabels> = {
  en: {
    trigger: "AI rewrite",
    polish: "Polish",
    accept: "Accept",
    reject: "Reject",
    regenerate: "Regenerate",
    insertBelow: "Insert below",
    customPlaceholder: "Describe the change you want...",
    customSubmit: "Generate",
    conflict: "The original text changed; please select it again",
  },
  "zh-CN": {
    trigger: "AI 改写",
    polish: "润色",
    accept: "接受",
    reject: "拒绝",
    regenerate: "重新生成",
    insertBelow: "插入下方",
    customPlaceholder: "描述你想要的修改…",
    customSubmit: "生成",
    conflict: "原文已变化，请重新选中后再试",
  },
};

/** 真实调用方序列化后的请求体：省略 instruction 时为 null，selected_text 默认为整章正文。 */
function expectedInlineRequest(
  action: string,
  instruction: string | null,
  selectedText: string = CHAPTER_CONTENT,
) {
  return {
    project_id: PROJECT_ID,
    chapter_id: CHAPTER_ID,
    action,
    selected_text: selectedText,
    instruction,
  };
}

function toastWithText(page: Page, text: string): Locator {
  return page.locator("[data-sonner-toast]").filter({ hasText: text });
}

/** innerText 把段落分隔渲染成换行：比较可见文字前先折叠空白。 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 真实 DOM 选区快照：文本内容与是否收起，用于证明全选选区能否被方向键收起。 */
async function readDomSelection(page: Page): Promise<{ text: string; collapsed: boolean }> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    return {
      text: selection?.toString() ?? "",
      collapsed: selection?.isCollapsed ?? true,
    };
  });
}

/** 通过共享夹具的原生 IndexedDB 接缝预置“最后访问章节”，让写作页自动打开编辑器。 */
async function openWritingWithChapter(page: Page): Promise<Locator> {
  await page.goto("/");
  await seedLastChapterMemory(page, PROJECT_ID, CHAPTER_ID);
  await page.goto(`/projects/${PROJECT_ID}`);
  const editor = page.locator(".tiptap-editor .ProseMirror");
  await expect(editor).toBeVisible();
  return editor;
}

/**
 * 在正文里已有非空选区的前提下打开 Inline AI 动作菜单：触发按钮与动作菜单都必须真实可见。
 * 选区由调用方建立，因为不同用例需要不同类型的选区（见下方“过期选区”用例）。
 */
async function openInlineAiMenuForSelection(page: Page, labels: ReviewLabels): Promise<Locator> {
  const trigger = page.locator(".inline-ai-trigger");
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveText(labels.trigger);
  await trigger.click();

  const menu = page.locator(".inline-ai-menu");
  await expect(menu).toBeVisible();
  return menu;
}

/** 选中整章正文并打开 Inline AI 菜单。 */
async function openInlineAiMenu(page: Page, labels: ReviewLabels) {
  const editor = await openWritingWithChapter(page);
  await editor.click();
  await page.keyboard.press("Control+a");

  const menu = await openInlineAiMenuForSelection(page, labels);
  return { editor, menu };
}

/**
 * 正文被真实写入后，写作页会在 3 秒后自动保存章节（PATCH /chapters/{id}）。
 * 该端点不是本用例的断言对象，但必须显式接管：GET 一律回退给共享夹具，只有章节写入
 * 由这里应答，避免自动保存被记成未预期请求而污染断言。
 */
async function mockChapterSave(page: Page): Promise<void> {
  await page.route("**/api/v1/chapters/**", async (route) => {
    if (route.request().method() === "GET") {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      json: {
        id: CHAPTER_ID,
        project_id: PROJECT_ID,
        volume_id: VOLUME_ID,
        title: "Synthetic Chapter",
        order: 1,
        word_count: 5,
        content: CHAPTER_CONTENT,
        created_at: TIMESTAMP,
        updated_at: TIMESTAMP,
      },
    });
  });
}

for (const language of LANGUAGES) {
  const labels = REVIEW_LABELS[language];

  test(`${language}: regenerate repeats the same request and keeps the chapter unchanged`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);
    state.enqueue("inline-ai", { kind: "success" });
    state.enqueue("inline-ai", { kind: "success", inlineResult: REGENERATED_TEXT });

    const { editor, menu } = await openInlineAiMenu(page, labels);
    await menu.getByRole("button", { name: labels.polish, exact: true }).click();

    const result = menu.locator(".inline-ai-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(INLINE_RESULT_TEXT);
    await expect(result).toContainText(INLINE_MODEL);

    // 结果表面必须同时暴露四个审查动作。
    for (const name of [labels.accept, labels.reject, labels.regenerate, labels.insertBelow]) {
      await expect(result.getByRole("button", { name, exact: true })).toBeVisible();
    }

    // 候选只存在于浮层：正文在显式接受或插入前保持原样。
    await expect(editor).toContainText(CHAPTER_CONTENT);
    await expect(editor).not.toContainText(INLINE_RESULT_TEXT);

    await result.getByRole("button", { name: labels.regenerate, exact: true }).click();

    // 重新生成后浮层换成新候选，正文仍然原样。
    await expect(result).toBeVisible();
    await expect(result).toContainText(REGENERATED_TEXT);
    await expect(result).not.toContainText(INLINE_RESULT_TEXT);
    await expect(editor).toContainText(CHAPTER_CONTENT);
    await expect(editor).not.toContainText(REGENERATED_TEXT);

    // 两次请求的动作、选区与指令必须完全一致：重新生成不需要用户重新选中。
    expect(expectRequestShape(state, "inline-ai", 0, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("polish", null),
    );
    expect(expectRequestShape(state, "inline-ai", 1, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("polish", null),
    );

    // 重新生成之后选区仍然可用：显式“拒绝”关闭浮层且不动正文。
    await result.getByRole("button", { name: labels.reject, exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(editor).toContainText(CHAPTER_CONTENT);
    await expect(editor).not.toContainText(REGENERATED_TEXT);

    await expectNoUnexpected(page, state);
  });

  test(`${language}: regenerate reuses the custom instruction and selection`, async ({ page }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);
    state.enqueue("inline-ai", { kind: "success" });
    state.enqueue("inline-ai", { kind: "success", inlineResult: REGENERATED_TEXT });

    const { editor, menu } = await openInlineAiMenu(page, labels);
    await menu.getByPlaceholder(labels.customPlaceholder).fill(CUSTOM_INSTRUCTION);
    await menu.getByRole("button", { name: labels.customSubmit, exact: true }).click();

    const result = menu.locator(".inline-ai-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(INLINE_RESULT_TEXT);

    await result.getByRole("button", { name: labels.regenerate, exact: true }).click();

    await expect(result).toContainText(REGENERATED_TEXT);
    await expect(editor).toContainText(CHAPTER_CONTENT);
    await expect(editor).not.toContainText(REGENERATED_TEXT);

    // 自定义指令同样被原样复用，且选区仍是当初保存的整章正文。
    expect(expectRequestShape(state, "inline-ai", 0, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("custom", CUSTOM_INSTRUCTION),
    );
    expect(expectRequestShape(state, "inline-ai", 1, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("custom", CUSTOM_INSTRUCTION),
    );

    await expectNoUnexpected(page, state);
  });

  test(`${language}: a failed regenerate keeps the candidate and never writes`, async ({ page }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);
    state.enqueue("inline-ai", { kind: "success" });
    state.enqueue("inline-ai", { kind: "detail", status: 400, detail: ORDINARY_DETAIL });

    const { editor, menu } = await openInlineAiMenu(page, labels);
    await menu.getByRole("button", { name: labels.polish, exact: true }).click();

    const result = menu.locator(".inline-ai-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(INLINE_RESULT_TEXT);

    await result.getByRole("button", { name: labels.regenerate, exact: true }).click();

    await expect(toastWithText(page, ORDINARY_DETAIL).first()).toBeVisible();

    // 失败不写正文：原候选与已保存选区都保留，浮层仍然是结果表面。
    await expect(result).toBeVisible();
    await expect(result).toContainText(INLINE_RESULT_TEXT);
    await expect(editor).toContainText(CHAPTER_CONTENT);
    await expect(editor).not.toContainText(INLINE_RESULT_TEXT);

    expect(expectRequestShape(state, "inline-ai", 0, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("polish", null),
    );
    expect(expectRequestShape(state, "inline-ai", 1, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("polish", null),
    );

    await expectNoUnexpected(page, state);
  });

  test(`${language}: insert below appends the candidate and preserves the source`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);
    state.enqueue("inline-ai", { kind: "success" });

    const { editor, menu } = await openInlineAiMenu(page, labels);
    await menu.getByRole("button", { name: labels.polish, exact: true }).click();

    const result = menu.locator(".inline-ai-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(INLINE_RESULT_TEXT);

    const sourceBefore = (await editor.innerText()).trim();
    expect(sourceBefore).toContain(CHAPTER_CONTENT);

    await result.getByRole("button", { name: labels.insertBelow, exact: true }).click();

    // 插入后浮层关闭；原文被完整保留，并且候选紧接着出现在原文之后。
    await expect(menu).toHaveCount(0);
    const sourceAfter = await editor.innerText();
    expect(sourceAfter).toContain(sourceBefore);
    expect(sourceAfter).toContain(INLINE_RESULT_TEXT);
    expect(sourceAfter.indexOf(INLINE_RESULT_TEXT)).toBeGreaterThan(
      sourceAfter.indexOf(sourceBefore),
    );

    expect(expectRequestShape(state, "inline-ai", 0, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("polish", null),
    );
    await expectNoUnexpected(page, state);
  });

  test(`${language}: insert below keeps the paragraph whole for a mid-paragraph selection`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);
    state.enqueue("inline-ai", { kind: "success" });

    const editor = await openWritingWithChapter(page);
    const source = editor.locator("p").first();
    await expect(source).toHaveText(CHAPTER_CONTENT);

    // 段落内部选区：光标落在首行最左侧，再向右扩选两个字符，选区终点严格停在段落中间。
    await source.click({ position: { x: 3, y: 8 } });
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");

    const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
    expect(selected.length).toBeGreaterThan(0);
    expect(CHAPTER_CONTENT).toContain(selected);
    // 选区必须短于整段、且不落在段落结尾：只有终点在段落内部，才能区分插入位置的对错。
    expect(selected.length).toBeLessThan(CHAPTER_CONTENT.length);
    expect(CHAPTER_CONTENT.endsWith(selected)).toBe(false);

    const trigger = page.locator(".inline-ai-trigger");
    await expect(trigger).toBeVisible();
    await trigger.click();

    const menu = page.locator(".inline-ai-menu");
    await expect(menu).toBeVisible();
    await menu.getByRole("button", { name: labels.polish, exact: true }).click();

    const result = menu.locator(".inline-ai-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(INLINE_RESULT_TEXT);

    await result.getByRole("button", { name: labels.insertBelow, exact: true }).click();

    // 原文段落必须逐字完整，候选成为紧随其后的独立段落：正文没有被从选区终点切开。
    await expect(menu).toHaveCount(0);
    const blocks = editor.locator("p");
    await expect(blocks).toHaveCount(2);
    const blockTexts = (await blocks.allInnerTexts()).map((text) => text.trim());
    expect(blockTexts).toEqual([CHAPTER_CONTENT, INLINE_RESULT_TEXT]);

    expect(expectRequestShape(state, "inline-ai", 0, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("polish", null, selected),
    );
    await expectNoUnexpected(page, state);
  });

  test(`${language}: insert below refuses to write once the selection went stale`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);
    state.enqueue("inline-ai", { kind: "success" });

    const editor = await openWritingWithChapter(page);
    const source = editor.locator("p").first();
    await expect(source).toHaveText(CHAPTER_CONTENT);

    // 选区必须带真实文本光标：Control+a 产生的是元素级全选，方向键收不起它，随后的输入会直接
    // 替换整章。这里改为“点击段落首行最左侧 + 键盘扩选到行尾”，得到可被方向键收起的普通文本
    // 选区，下面的输入才是用户真实的“继续修改正文”。下面的断言要求选区覆盖整段正文，
    // 否则插入点会落在已保存选区之外，冲突守卫本来就不会被触发。
    await source.click({ position: { x: 3, y: 8 } });
    await page.keyboard.press("Shift+End");
    const selected = (await page.evaluate(() => window.getSelection()?.toString() ?? "")).trim();
    expect(selected).toBe(CHAPTER_CONTENT);

    const menu = await openInlineAiMenuForSelection(page, labels);
    await menu.getByRole("button", { name: labels.polish, exact: true }).click();

    const result = menu.locator(".inline-ai-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(INLINE_RESULT_TEXT);

    // 候选显示后用户继续修改正文：光标收起到选区起点后输入，原文仍在但选区已不再逐字一致。
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type(PENDING_EDIT);
    await expect(editor).toContainText(PENDING_EDIT.trim());
    await expect(editor).toContainText(CHAPTER_CONTENT);

    await result.getByRole("button", { name: labels.insertBelow, exact: true }).click();

    // 冲突守卫必须挡住写入：提示原文已变化，浮层关闭，候选绝不进入正文。
    await expect(toastWithText(page, labels.conflict).first()).toBeVisible();
    await expect(menu).toHaveCount(0);
    await expect(editor).not.toContainText(INLINE_RESULT_TEXT);

    expect(expectRequestShape(state, "inline-ai", 0, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("polish", null, selected),
    );
    await expectNoUnexpected(page, state);
  });

  test(`${language}: accept refuses a document shrunk below the saved selection`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);
    state.enqueue("inline-ai", { kind: "success" });

    const { editor, menu } = await openInlineAiMenu(page, labels);
    await menu.getByRole("button", { name: labels.polish, exact: true }).click();

    const result = menu.locator(".inline-ai-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(INLINE_RESULT_TEXT);

    // 候选显示后把整章正文换成更短的文本：已保存选区（整章范围）越过新的文档末尾。
    await page.keyboard.press("Control+a");
    await page.keyboard.type(SHRUNK_CONTENT);
    await expect.poll(async () => (await editor.innerText()).trim()).toBe(SHRUNK_CONTENT);

    await result.getByRole("button", { name: labels.accept, exact: true }).click();

    // 冲突守卫必须在不抛页面异常的前提下挡住写入：提示重新选中，浮层关闭，候选不落盘。
    await expect(toastWithText(page, labels.conflict).first()).toBeVisible();
    await expect(menu).toHaveCount(0);
    expect((await editor.innerText()).trim()).toBe(SHRUNK_CONTENT);
    await expect(editor).not.toContainText(INLINE_RESULT_TEXT);

    expect(expectRequestShape(state, "inline-ai", 0, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("polish", null),
    );
    await expectNoUnexpected(page, state);
  });

  /**
   * Control A：不经过 Inline AI 的最短路径。Ctrl+A 之后按一次方向键必须像普通文本选区一样收起，
   * 随后的输入只改变插入点，绝不替换整章。
   *
   * 回归的缺陷：Ctrl+A 在 Chromium 里产生元素级 AllSelection，方向键收不起它，随后的一次输入
   * 会把整章正文替换成输入内容（数据丢失）。这里同时固定两点：全选契约不变（Ctrl+A 仍覆盖整章），
   * 且该选区可被方向键收起、可被继续输入安全地局部修改。
   */
  test(`${language}: control+a collapses with ArrowLeft and keeps the chapter`, async ({ page }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);

    const editor = await openWritingWithChapter(page);
    await expect(editor.locator("p").first()).toHaveText(CHAPTER_CONTENT);

    await editor.click();
    await page.keyboard.press("Control+a");

    // 全选契约：Ctrl+A 之后选区覆盖整章正文。
    const selected = await readDomSelection(page);
    expect(selected.text.trim()).toBe(CHAPTER_CONTENT);
    expect(selected.collapsed).toBe(false);

    // 方向键必须能收起它：这一条正是 AllSelection 做不到、普通文本选区做得到的。
    await page.keyboard.press("ArrowLeft");
    expect(await readDomSelection(page)).toEqual({ text: "", collapsed: true });

    await page.keyboard.type(PENDING_EDIT);
    await expect(editor).toContainText(PENDING_EDIT.trim());
    // 正文逐字保留：输入只改变插入点，没有替换整章。
    await expect(editor).toContainText(CHAPTER_CONTENT);

    await expectNoUnexpected(page, state);
  });

  /**
   * Control C：全选的第二条契约——Ctrl+A 之后直接输入仍然整体替换正文。用两段正文覆盖长篇最
   * 常见的结构：多段必须被一次输入合并成一段，不能因为换了选区类型而残留空段落。
   */
  test(`${language}: control+a then typing still replaces the whole document`, async ({ page }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);

    const editor = await openWritingWithChapter(page);
    const source = editor.locator("p").first();
    await expect(source).toHaveText(CHAPTER_CONTENT);

    // 在段落中间回车拆成两段，得到真实的整章多段结构。
    await source.click();
    await page.keyboard.press("Enter");
    await expect(editor.locator("p")).toHaveCount(2);

    await page.keyboard.press("Control+a");
    await page.keyboard.type(SHRUNK_CONTENT);

    // 整章（两个段落）被一次输入整体替换，并且只留下一段。
    await expect.poll(async () => normalizeText(await editor.innerText())).toBe(SHRUNK_CONTENT);
    await expect(editor.locator("p")).toHaveCount(1);

    await expectNoUnexpected(page, state);
  });

  /**
   * Control B：Ctrl+A -> Inline AI 候选 -> ArrowLeft -> 输入，与既有 Shift+End 用例同一条过期选区
   * 路径，但起点换成 Ctrl+A。整章必须逐字保留，插入下方沿用冲突守卫拒绝写入。
   */
  test(`${language}: control+a with inline AI keeps the chapter and blocks the stale insert`, async ({
    page,
  }) => {
    const state = await installAiErrorApp(page, { language });
    await mockChapterSave(page);
    state.enqueue("inline-ai", { kind: "success" });

    const editor = await openWritingWithChapter(page);
    await expect(editor.locator("p").first()).toHaveText(CHAPTER_CONTENT);

    await editor.click();
    await page.keyboard.press("Control+a");
    const selected = (await readDomSelection(page)).text.trim();
    expect(selected).toBe(CHAPTER_CONTENT);

    const menu = await openInlineAiMenuForSelection(page, labels);
    await menu.getByRole("button", { name: labels.polish, exact: true }).click();

    const result = menu.locator(".inline-ai-result");
    await expect(result).toBeVisible();
    await expect(result).toContainText(INLINE_RESULT_TEXT);

    // 候选显示后用户按方向键收起选区继续修改正文：整章必须逐字保留。
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type(PENDING_EDIT);
    await expect(editor).toContainText(PENDING_EDIT.trim());
    await expect(editor).toContainText(CHAPTER_CONTENT);

    await result.getByRole("button", { name: labels.insertBelow, exact: true }).click();

    // 冲突守卫必须挡住写入：提示原文已变化，浮层关闭，候选绝不进入正文。
    await expect(toastWithText(page, labels.conflict).first()).toBeVisible();
    await expect(menu).toHaveCount(0);
    await expect(editor).not.toContainText(INLINE_RESULT_TEXT);

    expect(expectRequestShape(state, "inline-ai", 0, INLINE_REQUEST_KEYS)).toEqual(
      expectedInlineRequest("polish", null),
    );
    await expectNoUnexpected(page, state);
  });
}
