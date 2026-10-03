/**
 * 欢迎对话框顶部徽标对齐的浏览器回归：真实产物 + 严格合成接口 + 真实点击。
 *
 * 修复前 .onboarding-badge 的 display:flex 被 Radix 的 rt-Box 规则以同权重覆盖成 block，
 * 26px 的 BookOpenText 图标回到行内基线，图标在徽标内向左上方偏移；修复只把该规则的
 * 选择器收窄为 .onboarding-dialog .onboarding-badge（声明逐字节不变），用双类权重压过 rt-Box。
 *
 * 每个语种 x 视口组合都打开真实的首次使用欢迎对话框，量取真实元素的 getBoundingClientRect
 * 与 computedStyle：徽标 56x56、图标 26x26、display/align-items/justify-content 为
 * flex/center/center，图标在徽标内与徽标在既有 .onboarding-step 内的 center 误差 <= 1px，
 * 且对话框、欢迎内容、徽标与图标都落在视口内。随后正常点击主按钮，断言进入既有「怎么开始」
 * 步骤、顶部徽标消失，且全程没有 AI 请求。
 *
 * 不注入测试 CSS、不改用副本组件、不动态导入 /src、不使用 force click、不弱化断言、不放大
 * 超时；未登记的请求、未知 socket 事件与页面异常都会导致断言失败。
 */
import { expect, test, type Page } from "@playwright/test";

import { expectNoUnexpected, installAiErrorApp, type Language } from "./ai-model-errors-fixture";

test.use({
  serviceWorkers: "block",
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 10_000,
  navigationTimeout: 30_000,
});

/** 用例级 60 秒上限，重试 0 次；等待型断言统一用 EXPECT_TIMEOUT。 */
test.describe.configure({ retries: 0, timeout: 60_000 });

const EXPECT_TIMEOUT = 10_000;

const LANGUAGES: Language[] = ["en", "zh-CN"];

const VIEWPORTS = [{ width: 1600, height: 1000 }, { width: 390, height: 844 }];

/** 仅允许的取整误差（像素），以及徽标与图标的既有尺寸。 */
const TOLERANCE = 1;
const BADGE_SIZE = 56;
const ICON_SIZE = 26;

/** 与 src/i18n/locales/{en,zh-CN}.json 的 onboarding.title / begin / chooseTitle 一致。 */
const WELCOME_TEXT: Record<Language, { title: string; primary: string; startStep: string }> = {
  en: {
    title: "Welcome to OpenFix",
    primary: "Get started",
    startStep: "How would you like to begin?",
  },
  "zh-CN": {
    title: "欢迎使用 OpenFix",
    primary: "开始",
    startStep: "你想怎么开始？",
  },
};

interface Box { x: number; y: number; width: number; height: number }

interface WelcomeGeometry {
  dialog: Box;
  step: Box;
  badge: Box;
  icon: Box;
  badgeStyle: { display: string; alignItems: string; justifyContent: string };
  viewport: { width: number; height: number };
}

/**
 * 只读量取真实欢迎对话框：包围盒来自 getBoundingClientRect，徽标的布局来自 computedStyle，
 * 不注入测试 CSS、不新增应用钩子；缺少任一既有元素直接抛错。
 */
async function readWelcomeGeometry(page: Page): Promise<WelcomeGeometry> {
  return page.evaluate(() => {
    const box = (element: Element): Box => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const dialog = document.querySelector(".onboarding-dialog");
    const step = dialog?.querySelector(".onboarding-step") ?? null;
    const badge = dialog?.querySelector(".onboarding-badge") ?? null;
    const icon = badge?.querySelector("svg") ?? null;
    if (!dialog || !step || !badge || !icon) {
      throw new Error("welcome dialog is missing .onboarding-step, .onboarding-badge or its svg");
    }
    const style = window.getComputedStyle(badge);
    return {
      dialog: box(dialog),
      step: box(step),
      badge: box(badge),
      icon: box(icon),
      badgeStyle: {
        display: style.display,
        alignItems: style.alignItems,
        justifyContent: style.justifyContent,
      },
      viewport: {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
    };
  });
}

function center(box: Box, axis: "x" | "y"): number {
  return axis === "x" ? box.x + box.width / 2 : box.y + box.height / 2;
}

/** 断言盒子有正尺寸且完整落在视口内（仅允许 1px 取整误差）。 */
function expectInsideViewport(
  box: Box,
  viewport: { width: number; height: number },
  label: string,
): void {
  expect(box.width, `${label}: positive width`).toBeGreaterThan(0);
  expect(box.height, `${label}: positive height`).toBeGreaterThan(0);
  expect(box.x, `${label}: left edge`).toBeGreaterThanOrEqual(-TOLERANCE);
  expect(box.y, `${label}: top edge`).toBeGreaterThanOrEqual(-TOLERANCE);
  expect(box.x + box.width, `${label}: right edge`).toBeLessThanOrEqual(viewport.width + TOLERANCE);
  expect(box.y + box.height, `${label}: bottom edge`).toBeLessThanOrEqual(
    viewport.height + TOLERANCE,
  );
}

for (const viewport of VIEWPORTS) {
  const size = `${viewport.width}x${viewport.height}`;

  test.describe(size, () => {
    test.use({ viewport });

    for (const language of LANGUAGES) {
      const text = WELCOME_TEXT[language];

      test(`${language}: welcome badge keeps its size, centering and layout`, async ({ page }) => {
        const state = await installAiErrorApp(page, { language, includeProject: false });

        await page.goto("/");

        const dialog = page.locator(".onboarding-dialog");
        const badge = page.locator(".onboarding-dialog .onboarding-badge");
        const icon = page.locator(".onboarding-dialog .onboarding-badge svg");

        await expect(dialog).toBeVisible({ timeout: EXPECT_TIMEOUT });
        await expect(badge).toBeVisible({ timeout: EXPECT_TIMEOUT });
        await expect(icon).toBeVisible({ timeout: EXPECT_TIMEOUT });
        // 标题必须来自同一个对话框，且文案与当前语言文件一致。
        await expect(dialog.getByText(text.title, { exact: true })).toBeVisible({
          timeout: EXPECT_TIMEOUT,
        });

        const geometry = await readWelcomeGeometry(page);

        expect(geometry.badgeStyle).toEqual({
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        });
        expect(geometry.badge.width).toBeCloseTo(BADGE_SIZE, 1);
        expect(geometry.badge.height).toBeCloseTo(BADGE_SIZE, 1);
        expect(geometry.icon.width).toBeCloseTo(ICON_SIZE, 1);
        expect(geometry.icon.height).toBeCloseTo(ICON_SIZE, 1);

        expect(
          Math.abs(center(geometry.icon, "x") - center(geometry.badge, "x")),
          "icon is horizontally centered inside the badge",
        ).toBeLessThanOrEqual(TOLERANCE);
        expect(
          Math.abs(center(geometry.icon, "y") - center(geometry.badge, "y")),
          "icon is vertically centered inside the badge",
        ).toBeLessThanOrEqual(TOLERANCE);
        expect(
          Math.abs(center(geometry.badge, "x") - center(geometry.step, "x")),
          "badge is horizontally centered inside the welcome content",
        ).toBeLessThanOrEqual(TOLERANCE);

        for (const [label, box] of [
          ["dialog", geometry.dialog],
          ["welcome content", geometry.step],
          ["badge", geometry.badge],
          ["icon", geometry.icon],
        ] as const) {
          expectInsideViewport(box, geometry.viewport, label);
        }

        // 正常点击主按钮：进入既有「怎么开始」步骤，顶部徽标随之消失。
        await dialog.getByRole("button", { name: text.primary, exact: true }).click();
        await expect(badge).toHaveCount(0, { timeout: EXPECT_TIMEOUT });
        await expect(dialog.getByText(text.startStep, { exact: true })).toBeVisible({
          timeout: EXPECT_TIMEOUT,
        });

        expect(state.requests).toEqual([]);
        await expectNoUnexpected(page, state);
      });
    }
  });
}
