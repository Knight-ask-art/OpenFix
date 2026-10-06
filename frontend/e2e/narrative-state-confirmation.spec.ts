/**
 * 叙事状态确认区块的合成接口回归测试。
 *
 * 覆盖 story-memory 页新增的叙事状态区块：
 * - 候选 / 推断 / 已确认 / 已拒绝 的展示与依据（溯源）展开；
 * - 确认请求必须携带读取该行时的 updated_at，且确认后只刷新本类资源；
 * - 409 冲突不得自动重试确认，必须刷新并展示变更前后的内容；
 * - 手工录入只能产生候选请求体，绝不提交已确认状态；
 * - 分页按资源独立（页码、偏移量、项目作用域）；
 * - 人物信念与场景计划只读可确认，并声明暂不支持手工新增；
 * - 场景计划确认前可展开完整字段（14 个语义字段 + 原始 JSON），面板只读且不触发写入；
 * - 场景计划的 409 冲突逐字段比对，只列出真正被改动的字段并展示变更前后内容；
 * - 加载 / 错误 / 空状态可用，确认按钮可键盘操作。
 *
 * 本文件完全使用合成接口与 WebSocket 拦截，不依赖真实后端、数据库或模型提供商。
 */

import { expect, test, type Page } from "@playwright/test";

test.use({
  serviceWorkers: "block",
  trace: "off",
  video: "off",
  screenshot: "off",
  viewport: { width: 1440, height: 1000 },
});

const PROJECT = { id: "narrative-alpha", title: "Narrative Alpha" };
const TIMESTAMP = "2026-01-01T00:00:00";
const SECOND_TIMESTAMP = "2026-01-02T00:00:00";
const WORLD_FACT_CONFLICT_DETAIL = "世界事实已被修改，请刷新后重新确认";

type Row = Record<string, unknown>;

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

interface MockServer {
  worldFacts: Row[];
  characterBeliefs: Row[];
  plotlines: Row[];
  scenePlans: Row[];
  requests: RecordedRequest[];
  /** 这些资源返回 500，用于验证错误状态。 */
  failingSegments: Set<string>;
}

interface NarrativePayloadOptions {
  id: string;
  updatedAt?: string;
  confirmation?: string;
  statement?: string;
}

function worldFactRow({
  id,
  updatedAt = TIMESTAMP,
  confirmation = "candidate",
  statement = "北境关口只在冬季开放",
}: NarrativePayloadOptions): Row {
  return {
    id,
    project_id: PROJECT.id,
    statement,
    subject_ref: "北境关口",
    status: "uncertain",
    superseded_by_id: null,
    source_type: "chapter",
    source_id: "chapter-3",
    source_chapter_id: "chapter-3",
    quote_anchor: "第 3 章 第 12 段",
    created_by: "reviewer",
    confidence: 0.5,
    confirmation,
    confirmed_at: confirmation === "confirmed" ? updatedAt : null,
    confirmed_by: confirmation === "confirmed" ? "local-user" : null,
    created_at: TIMESTAMP,
    updated_at: updatedAt,
  };
}

function beliefRow({
  id,
  updatedAt = TIMESTAMP,
  confirmation = "inferred",
}: NarrativePayloadOptions): Row {
  return {
    id,
    project_id: PROJECT.id,
    character_id: "char-1",
    proposition: "她相信队长还活着",
    belief_state: "believed",
    learned_at_chapter_id: "chapter-7",
    superseded_by_id: null,
    invalidated_at: null,
    source_type: "chapter",
    source_id: null,
    source_chapter_id: "chapter-7",
    quote_anchor: "第 7 章",
    created_by: "reviewer",
    confidence: 0.7,
    confirmation,
    confirmed_at: null,
    confirmed_by: null,
    created_at: TIMESTAMP,
    updated_at: updatedAt,
  };
}

function plotlineRow({
  id,
  updatedAt = TIMESTAMP,
  confirmation = "candidate",
}: NarrativePayloadOptions): Row {
  return {
    id,
    project_id: PROJECT.id,
    title: "失踪的哨兵",
    description: "哨兵失踪引出边境阴谋",
    current_question: "哨兵是否叛逃",
    payoff: "第三卷揭示哨兵被俘",
    state: "progressing",
    introduced_chapter_id: "chapter-1",
    advanced_chapter_id: null,
    related_character_ids: ["char-1"],
    related_outline_ids: [],
    source_type: "outline",
    source_id: "outline-1",
    source_chapter_id: null,
    quote_anchor: "",
    created_by: "planner",
    confidence: 0.4,
    confirmation,
    confirmed_at: null,
    confirmed_by: null,
    created_at: TIMESTAMP,
    updated_at: updatedAt,
  };
}

function scenePlanRow({
  id,
  updatedAt = TIMESTAMP,
  confirmation = "candidate",
}: NarrativePayloadOptions): Row {
  return {
    id,
    project_id: PROJECT.id,
    chapter_id: "chapter-4",
    scene_index: 0,
    goal: "让主角发现密道",
    pov_character_id: "char-1",
    location: "旧钟楼",
    tone: "压抑",
    preconditions: [],
    participants: ["char-1"],
    character_goals: [],
    known_information: [],
    hidden_information: [],
    active_plotline_ids: [],
    world_constraints: [],
    expected_changes: [],
    result: {
      fact_changes: [],
      belief_changes: [],
      relationship_changes: [],
      state_changes: [],
      plotline_changes: [],
    },
    source_type: "agent",
    source_id: null,
    source_chapter_id: "chapter-4",
    quote_anchor: "",
    created_by: "agent",
    confidence: null,
    confirmation,
    confirmed_at: null,
    confirmed_by: null,
    created_at: TIMESTAMP,
    updated_at: updatedAt,
  };
}

/** 场景结果的「读取时」快照：只有事实变化一类有内容。 */
const SCENE_RESULT_BEFORE: Row = {
  fact_changes: ["密道确实存在"],
  belief_changes: [],
  relationship_changes: [],
  state_changes: [],
  plotline_changes: [],
};

/** 场景结果的「被改写后」快照：五类变化中的四类都换了内容。 */
const SCENE_RESULT_AFTER: Row = {
  fact_changes: ["密道通向地窖"],
  belief_changes: ["主角相信队长被俘"],
  relationship_changes: ["主角与守卫敌对"],
  state_changes: [],
  plotline_changes: ["失踪的哨兵推进"],
};

interface DetailedScenePlanOptions {
  id: string;
  updatedAt?: string;
  confirmation?: string;
  hiddenInformation?: string[];
  expectedChanges?: string[];
  result?: Row;
}

/**
 * 结构化字段全部填充的合成场景计划。
 *
 * 用于两件事：确认前展开完整字段（14 个语义字段 + 原始 JSON），
 * 以及只有隐藏信息 / 预期变化 / 场景结果被改写时的冲突比对。
 * 关联情节线故意留空，用来验证空值字段仍以「未填写」可读展示。
 */
function detailedScenePlanRow({
  id,
  updatedAt = TIMESTAMP,
  confirmation = "candidate",
  hiddenInformation = ["密道入口在雕像后"],
  expectedChanges = ["主角掌握密道位置"],
  result = SCENE_RESULT_BEFORE,
}: DetailedScenePlanOptions): Row {
  return {
    ...scenePlanRow({ id, updatedAt, confirmation }),
    goal: "让主角发现密道",
    pov_character_id: "char-1",
    location: "旧钟楼",
    tone: "压抑",
    preconditions: ["钟楼在午夜前未上锁"],
    participants: ["char-1"],
    character_goals: [{ character_id: "char-1", goal: "找到密道入口" }],
    known_information: ["钟楼里有一尊铜像"],
    hidden_information: hiddenInformation,
    active_plotline_ids: [],
    world_constraints: ["北境关口只在冬季开放"],
    expected_changes: expectedChanges,
    result,
  };
}

/** 场景计划在完整字段面板里应逐条展示的语义字段标签。 */
const SCENE_PLAN_DETAIL_LABELS = [
  "场景目标",
  "所属章节",
  "地点",
  "基调",
  "视角人物",
  "前置条件",
  "参与者",
  "人物目标",
  "已知信息",
  "隐藏信息",
  "关联情节线",
  "世界约束",
  "预期变化",
  "场景结果",
] as const;

const SEGMENTS = {
  worldFacts: "world-facts",
  characterBeliefs: "character-beliefs",
  plotlines: "plotlines",
  scenePlans: "scene-plans",
} as const;

type Segment = (typeof SEGMENTS)[keyof typeof SEGMENTS];

const CONFLICT_LABELS: Record<Segment, string> = {
  "world-facts": WORLD_FACT_CONFLICT_DETAIL,
  "character-beliefs": "人物信念已被修改，请刷新后重新确认",
  plotlines: "情节线已被修改，请刷新后重新确认",
  "scene-plans": "场景计划已被修改，请刷新后重新确认",
};

const CONFIRM_PATTERN = /^\/projects\/([^/]+)\/narrative\/([^/]+)\/([^/]+)\/confirm$/;
const RESOURCE_PATTERN = /^\/projects\/([^/]+)\/narrative\/([^/]+)$/;

function rowsFor(server: MockServer, segment: Segment): Row[] {
  switch (segment) {
    case "world-facts":
      return server.worldFacts;
    case "character-beliefs":
      return server.characterBeliefs;
    case "plotlines":
      return server.plotlines;
    default:
      return server.scenePlans;
  }
}

function countRequests(server: MockServer, method: string, segment: Segment): number {
  return server.requests.filter(
    (request) => request.method === method && request.path.endsWith(`/narrative/${segment}`),
  ).length;
}

/** 确认请求的路径以 /confirm 结尾，不能与列表请求共用一个过滤器。 */
function confirmRequests(server: MockServer, segment: Segment): RecordedRequest[] {
  const pattern = new RegExp(`/narrative/${segment}/[^/]+/confirm$`);
  return server.requests.filter(
    (request) => request.method === "POST" && pattern.test(request.path),
  );
}

/**
 * 安装合成 API：项目列表 / 项目校验 / 故事记忆状态 / 四类叙事状态资源。
 * 列表接口按 limit + offset 真实分页，确认接口按 updated_at 做乐观锁。
 */
async function installApiMock(page: Page, server: MockServer): Promise<void> {
  await page.route("**/runtime-config.json", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route(/https?:\/\/[^/]*(posthog|sentry)\.[^/]+\//, (route) =>
    route.fulfill({ status: 204, body: "" }),
  );

  await page.route("**/api/v1/**", async (route) => {
    const request = route.request();
    const apiPath = new URL(request.url()).pathname.replace(/^.*\/api\/v1/, "");
    const method = request.method();
    const query = new URL(request.url()).searchParams;
    const body = (() => {
      try {
        return request.postDataJSON() as unknown;
      } catch {
        return null;
      }
    })();

    if (apiPath === "/auth/status") {
      await route.fulfill({ status: 200, json: { enabled: false, authenticated: true } });
      return;
    }
    if (apiPath === "/auth/preferences" || apiPath === "/settings") {
      await route.fulfill({
        status: 200,
        json: {
          language: "zh-CN",
          theme: "light",
          font_family: "noto-sans-sc",
          code_font_family: "jetbrains-mono",
          base_font_size: 14,
          editor_font_size: 16,
        },
      });
      return;
    }
    if (apiPath === "/health") {
      await route.fulfill({ status: 200, json: { status: "ok", version: "test" } });
      return;
    }
    if (apiPath === "/runtime-config") {
      await route.fulfill({
        status: 200,
        json: { posthog_enabled: false, posthog_api_key: "", posthog_host: "" },
      });
      return;
    }
    if (apiPath === "/projects") {
      await route.fulfill({
        status: 200,
        json: {
          items: [
            {
              id: PROJECT.id,
              title: PROJECT.title,
              description: null,
              word_count: 0,
              chapter_count: 1,
              cover_url: null,
              created_at: TIMESTAMP,
              updated_at: TIMESTAMP,
            },
          ],
          total: 1,
          page: 1,
          page_size: 100,
        },
      });
      return;
    }

    const listMatch = apiPath.match(RESOURCE_PATTERN);
    if (listMatch && method === "GET") {
      const segment = decodeURIComponent(listMatch[2]) as Segment;
      server.requests.push({ method, path: apiPath, body: null });
      if (server.failingSegments.has(segment)) {
        await route.fulfill({ status: 500, json: { detail: "合成故障" } });
        return;
      }
      const rows = rowsFor(server, segment);
      const limit = Number(query.get("limit") ?? 20);
      const offset = Number(query.get("offset") ?? 0);
      await route.fulfill({
        status: 200,
        json: {
          items: rows.slice(offset, offset + limit),
          total: rows.length,
          limit,
          offset,
        },
      });
      return;
    }

    if (listMatch && method === "POST") {
      const segment = decodeURIComponent(listMatch[2]) as Segment;
      server.requests.push({ method, path: apiPath, body });
      const payload = (body ?? {}) as Record<string, unknown>;
      const created =
        segment === "world-facts"
          ? worldFactRow({
              id: `wf-${server.worldFacts.length + 1}`,
              statement: String(payload.statement ?? ""),
              confirmation: String(payload.confirmation ?? "candidate"),
            })
          : plotlineRow({
              id: `pl-${server.plotlines.length + 1}`,
              confirmation: String(payload.confirmation ?? "candidate"),
            });
      rowsFor(server, segment).push(created);
      await route.fulfill({ status: 201, json: created });
      return;
    }

    const confirmMatch = apiPath.match(CONFIRM_PATTERN);
    if (confirmMatch && method === "POST") {
      const segment = decodeURIComponent(confirmMatch[2]) as Segment;
      const itemId = decodeURIComponent(confirmMatch[3]);
      server.requests.push({ method, path: apiPath, body });
      const rows = rowsFor(server, segment);
      const row = rows.find((candidate) => candidate.id === itemId);
      const payload = (body ?? {}) as Record<string, unknown>;
      if (!row) {
        await route.fulfill({ status: 404, json: { detail: "记录不存在" } });
        return;
      }
      if (payload.expected_updated_at !== row.updated_at) {
        await route.fulfill({ status: 409, json: { detail: CONFLICT_LABELS[segment] } });
        return;
      }
      if (row.confirmation === "confirmed") {
        await route.fulfill({ status: 200, json: row });
        return;
      }
      row.confirmation = "confirmed";
      row.confirmed_at = SECOND_TIMESTAMP;
      row.confirmed_by = "local-user";
      row.updated_at = SECOND_TIMESTAMP;
      await route.fulfill({ status: 200, json: row });
      return;
    }

    const projectMatch = apiPath.match(/^\/projects\/([^/]+)$/);
    if (projectMatch) {
      await route.fulfill({
        status: 200,
        json: {
          id: PROJECT.id,
          title: PROJECT.title,
          description: null,
          word_count: 0,
          chapter_count: 1,
          cover_url: null,
          created_at: TIMESTAMP,
          updated_at: TIMESTAMP,
        },
      });
      return;
    }

    const storyMemoryMatch = apiPath.match(/^\/projects\/([^/]+)\/story-memory\/status$/);
    if (storyMemoryMatch) {
      await route.fulfill({
        status: 200,
        json: {
          project_id: PROJECT.id,
          embedding_configured: true,
          index_status: "ready",
          last_error: null,
          last_ready_at: TIMESTAMP,
          rebuild_job_status: null,
          counts: { characters: 1, world_entries: 0, outlines: 1, notes: 0, chapters: 1 },
        },
      });
      return;
    }

    const chaptersMatch = apiPath.match(/^\/projects\/([^/]+)\/chapters$/);
    if (chaptersMatch) {
      await route.fulfill({ status: 200, json: { volumes: [], total_chapters: 0 } });
      return;
    }

    await route.fulfill({ status: 404, json: { detail: `未拦截的接口: ${apiPath}` } });
  });
}

/** Socket.IO 是应用初始化的一部分，这里同时拦截 WebSocket 与长轮询。 */
async function mockSocketIo(page: Page): Promise<void> {
  const engineOpen = `0{"sid":"mock-engine","upgrades":[],"pingInterval":25000,"pingTimeout":20000,"maxPayload":1000000}`;

  await page.routeWebSocket(/\/socket\.io\//, (webSocket) => {
    webSocket.onMessage((message) => {
      const payload = typeof message === "string" ? message : message.toString("utf8");
      if (payload === "2") {
        webSocket.send("3");
        return;
      }
      if (payload.startsWith("40")) {
        webSocket.send(`40{"sid":"mock-namespace"}`);
      }
    });
    webSocket.send(engineOpen);
  });

  let namespaceConnected = false;
  await page.route(/\/socket\.io\//, async (route) => {
    if (route.request().method() === "POST") {
      await route.fulfill({ status: 200, contentType: "text/html", body: "ok" });
      return;
    }
    if (!new URL(route.request().url()).searchParams.has("sid")) {
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=UTF-8",
        body: engineOpen,
      });
      return;
    }
    if (!namespaceConnected) {
      namespaceConnected = true;
      await route.fulfill({
        status: 200,
        contentType: "text/plain; charset=UTF-8",
        body: `40{"sid":"mock-namespace"}`,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "text/plain; charset=UTF-8",
      body: "6",
    });
  });
}

async function openNarrativeSection(page: Page, server: MockServer): Promise<void> {
  await installApiMock(page, server);
  await mockSocketIo(page);
  await page.goto(`/story-memory?projectId=${PROJECT.id}`);
  await expect(page.locator(".narrative-state")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".narrative-state__row").first()).toBeVisible({ timeout: 30000 });
}

function createServer(overrides: Partial<MockServer> = {}): MockServer {
  return {
    worldFacts: [worldFactRow({ id: "wf-1" })],
    characterBeliefs: [beliefRow({ id: "cb-1" })],
    plotlines: [plotlineRow({ id: "pl-1" })],
    scenePlans: [scenePlanRow({ id: "sp-1" })],
    requests: [],
    failingSegments: new Set<string>(),
    ...overrides,
  };
}

function worldFactRowLocator(page: Page, id: string) {
  return page.locator(`.narrative-state__row[data-item-id="${id}"]`);
}

test("候选条目展示确认状态，并可展开查看依据", async ({ page }) => {
  const server = createServer();
  await openNarrativeSection(page, server);

  const row = worldFactRowLocator(page, "wf-1");
  await expect(row.getByText("候选", { exact: true })).toBeVisible();
  await expect(row.getByText("北境关口只在冬季开放")).toBeVisible();
  await expect(row.getByText("主体：北境关口")).toBeVisible();

  await row.getByRole("button", { name: "查看依据" }).click();
  const provenance = row.locator(".narrative-state__provenance");
  await expect(provenance).toBeVisible();
  await expect(provenance.getByText("来源：正文")).toBeVisible();
  await expect(provenance.getByText("来源章节：chapter-3")).toBeVisible();
  await expect(provenance.getByText("定位锚点：第 3 章 第 12 段")).toBeVisible();
  await expect(provenance.getByText("置信度：50%")).toBeVisible();
  await expect(provenance.getByText(`读取版本：${TIMESTAMP}`)).toBeVisible();
});

test("确认携带读取时的 updated_at，成功后只刷新本类资源", async ({ page }) => {
  const server = createServer();
  await openNarrativeSection(page, server);

  // 先访问情节线标签页，让另一类资源也有缓存与请求记录。
  await page.getByRole("tab", { name: "情节线" }).click();
  await expect(page.locator('.narrative-state__row[data-kind="plotlines"]')).toBeVisible();
  const plotlineRequestsBefore = countRequests(server, "GET", "plotlines");

  await page.getByRole("tab", { name: "世界事实" }).click();
  const row = worldFactRowLocator(page, "wf-1");
  const worldFactRequestsBefore = countRequests(server, "GET", "world-facts");

  await row.getByRole("button", { name: "确认", exact: true }).click();

  await expect(row.getByText("已确认", { exact: true })).toBeVisible();

  const confirmedOnce = confirmRequests(server, "world-facts");
  expect(confirmedOnce).toHaveLength(1);
  expect(confirmedOnce[0].path).toBe(`/projects/${PROJECT.id}/narrative/world-facts/wf-1/confirm`);
  expect(confirmedOnce[0].body).toEqual({ expected_updated_at: TIMESTAMP });

  await expect
    .poll(() => countRequests(server, "GET", "world-facts"))
    .toBeGreaterThan(worldFactRequestsBefore);
  expect(countRequests(server, "GET", "plotlines")).toBe(plotlineRequestsBefore);
  expect(
    server.requests.filter((request) => request.method !== "GET" && request.method !== "POST"),
  ).toHaveLength(0);
});

test("409 冲突不自动重试确认，刷新后展示变更前后的内容", async ({ page }) => {
  const server = createServer();
  await openNarrativeSection(page, server);

  const row = worldFactRowLocator(page, "wf-1");
  await expect(row.getByText("北境关口只在冬季开放")).toBeVisible();

  // 模拟另一个写入者在读取之后改写了同一行。
  server.worldFacts[0].statement = "北境关口全年开放";
  server.worldFacts[0].updated_at = SECOND_TIMESTAMP;

  await row.getByRole("button", { name: "确认", exact: true }).click();

  const conflict = row.locator(".narrative-state__conflict");
  await expect(conflict).toBeVisible();
  await expect(conflict.getByText("内容已被修改")).toBeVisible();
  await expect(conflict.getByText("事实陈述")).toBeVisible();
  await expect(conflict.getByText("北境关口只在冬季开放")).toBeVisible();
  await expect(conflict.getByText("北境关口全年开放")).toBeVisible();

  // 刷新后的最新内容进入正文展示，确认入口变成显式的人工再确认。
  await expect(row.locator(".narrative-state__primary")).toHaveText("北境关口全年开放");
  await expect(row.getByRole("button", { name: "核对后重新确认" })).toBeVisible();
  await expect(row.getByText("已确认", { exact: true })).toHaveCount(0);

  // 只提交过一次确认请求：冲突后不得自动重试。
  await expect.poll(() => confirmRequests(server, "world-facts").length).toBe(1);
  expect(server.worldFacts[0].confirmation).toBe("candidate");

  // 用户核对后再次确认：这次携带刷新后的令牌并成功。
  await row.getByRole("button", { name: "核对后重新确认" }).click();
  await expect(row.getByText("已确认", { exact: true })).toBeVisible();
  const confirmedTwice = confirmRequests(server, "world-facts");
  expect(confirmedTwice).toHaveLength(2);
  expect(confirmedTwice[1].body).toEqual({ expected_updated_at: SECOND_TIMESTAMP });
});

test("手工新增只提交候选，确认后才会变成已确认", async ({ page }) => {
  const server = createServer();
  await openNarrativeSection(page, server);

  await page.getByRole("button", { name: "手动新增世界事实候选" }).click();
  await page.locator("#narrative-candidate-worldFacts-primary").fill("潮汐每月倒灌一次");
  await page.locator("#narrative-candidate-worldFacts-secondary").fill("潮汐");
  await page.getByRole("button", { name: "保存为候选" }).click();

  const createPath = `/projects/${PROJECT.id}/narrative/world-facts`;
  const isCreate = (request: RecordedRequest) =>
    request.method === "POST" && request.path === createPath;
  await expect.poll(() => server.requests.filter(isCreate).length).toBe(1);

  const [createRequest] = server.requests.filter(isCreate);
  expect(createRequest.body).toEqual({
    statement: "潮汐每月倒灌一次",
    subject_ref: "潮汐",
    confirmation: "candidate",
    source_type: "user",
  });
  expect(JSON.stringify(createRequest.body)).not.toContain("confirmed");

  const newRow = worldFactRowLocator(page, "wf-2");
  await expect(newRow).toBeVisible();
  await expect(newRow.getByText("候选", { exact: true })).toBeVisible();
  await expect(newRow.getByRole("button", { name: "确认", exact: true })).toBeVisible();
});

test("分页按资源独立：每页 20 条并按偏移量请求", async ({ page }) => {
  const server = createServer({
    worldFacts: Array.from({ length: 21 }, (_, index) =>
      worldFactRow({
        id: `wf-${index + 1}`,
        statement: `世界事实 ${index + 1}`,
      }),
    ),
  });
  await openNarrativeSection(page, server);

  await expect(page.getByText("第 1 / 2 页")).toBeVisible();
  await expect(page.locator(".narrative-state__row")).toHaveCount(20);

  const firstPageRequest = server.requests.find(
    (request) => request.method === "GET" && request.path.endsWith("/narrative/world-facts"),
  );
  expect(firstPageRequest).toBeTruthy();

  await page.getByRole("button", { name: "下一页" }).click();
  await expect(page.locator(".narrative-state__row")).toHaveCount(1);
  await expect(page.getByText("第 2 / 2 页")).toBeVisible();
  await expect(page.getByRole("button", { name: "下一页" })).toBeDisabled();

  await expect.poll(() => countRequests(server, "GET", "world-facts")).toBe(2);
  expect(countRequests(server, "GET", "plotlines")).toBe(0);

  await page.getByRole("tab", { name: "情节线" }).click();
  await expect(page.locator('.narrative-state__row[data-kind="plotlines"]')).toBeVisible();
  await expect.poll(() => countRequests(server, "GET", "plotlines")).toBe(1);
  await expect(page.getByText("共 1 条")).toBeVisible();
});

test("人物信念与场景计划可读可确认，并声明暂不支持手工新增", async ({ page }) => {
  const server = createServer();
  await openNarrativeSection(page, server);

  await page.getByRole("tab", { name: "人物信念" }).click();
  await expect(page.getByText("当前仅支持查看与确认，暂不支持在此手动新增。")).toBeVisible();
  await expect(page.getByRole("button", { name: "手动新增情节线候选" })).toHaveCount(0);

  const beliefRow = page.locator('.narrative-state__row[data-item-id="cb-1"]');
  await expect(beliefRow.getByText("推断", { exact: true })).toBeVisible();
  await expect(beliefRow.getByText("她相信队长还活着")).toBeVisible();
  await beliefRow.getByRole("button", { name: "确认", exact: true }).click();
  await expect(beliefRow.getByText("已确认", { exact: true })).toBeVisible();
  expect(server.characterBeliefs[0].confirmation).toBe("confirmed");

  await page.getByRole("tab", { name: "场景计划" }).click();
  const sceneRow = page.locator('.narrative-state__row[data-item-id="sp-1"]');
  await expect(sceneRow.getByText("让主角发现密道")).toBeVisible();
  await sceneRow.getByRole("button", { name: "确认", exact: true }).click();
  await expect(sceneRow.getByText("已确认", { exact: true })).toBeVisible();
});

test("空状态与错误状态可用，并且确认可按键盘操作", async ({ page }) => {
  const server = createServer({
    plotlines: [],
    failingSegments: new Set<Segment>(["scene-plans"]),
  });
  await openNarrativeSection(page, server);

  await page.getByRole("tab", { name: "情节线" }).click();
  await expect(page.getByText("该项目还没有情节线。")).toBeVisible();

  await page.getByRole("tab", { name: "场景计划" }).click();
  await expect(page.getByText("无法读取叙事状态，请重试。")).toBeVisible();
  await page.getByRole("button", { name: "重试" }).click();
  await expect.poll(() => countRequests(server, "GET", "scene-plans")).toBeGreaterThan(1);

  await page.getByRole("tab", { name: "世界事实" }).click();
  const row = worldFactRowLocator(page, "wf-1");
  const confirmButton = row.getByRole("button", { name: "确认", exact: true });
  await confirmButton.focus();
  await expect(confirmButton).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(row.getByText("已确认", { exact: true })).toBeVisible();
  expect(server.worldFacts[0].confirmation).toBe("confirmed");
});

test("确认前可展开场景计划的完整字段", async ({ page }) => {
  const server = createServer({
    scenePlans: [detailedScenePlanRow({ id: "sp-1" })],
  });
  await openNarrativeSection(page, server);

  await page.getByRole("tab", { name: "场景计划" }).click();
  const row = page.locator('.narrative-state__row[data-item-id="sp-1"]');

  // 展开前：仍是候选，完整字段面板尚未渲染。
  await expect(row.getByText("候选", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "确认", exact: true })).toBeVisible();
  await expect(row.locator(".narrative-state__details")).toHaveCount(0);

  // 展开按钮的可访问名称会在展开后从「查看完整字段」变成「收起完整字段」，
  // 因此用稳定的 aria-controls 锚定同一个按钮。
  const toggle = row.locator('button[aria-controls="narrative-state-details-scenePlans-sp-1"]');
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();

  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText(/收起完整字段/);
  const details = row.locator("#narrative-state-details-scenePlans-sp-1");
  await expect(details).toBeVisible();

  // 面板只读：不提供任何写回控件。
  await expect(details.locator("button, input, textarea, select")).toHaveCount(0);

  // 14 个语义字段逐条展示，标签齐全。
  await expect(details.locator(".narrative-state__detail")).toHaveCount(
    SCENE_PLAN_DETAIL_LABELS.length,
  );
  const block = (label: string) =>
    details.locator(".narrative-state__detail").filter({
      has: page.locator(".narrative-state__detail-label", { hasText: new RegExp(`^${label}$`) }),
    });
  for (const label of SCENE_PLAN_DETAIL_LABELS) {
    await expect(block(label)).toHaveCount(1);
  }

  const values = (label: string) => block(label).locator(".narrative-state__detail-value");
  await expect(values("场景目标")).toHaveText(["让主角发现密道"]);
  await expect(values("所属章节")).toHaveText(["chapter-4 #0"]);
  await expect(values("地点")).toHaveText(["旧钟楼"]);
  await expect(values("基调")).toHaveText(["压抑"]);
  await expect(values("视角人物")).toHaveText(["char-1"]);
  await expect(values("前置条件")).toHaveText(["钟楼在午夜前未上锁"]);
  await expect(values("参与者")).toHaveText(["char-1"]);
  await expect(values("人物目标")).toHaveText(["char-1：找到密道入口"]);
  await expect(values("已知信息")).toHaveText(["钟楼里有一尊铜像"]);
  await expect(values("隐藏信息")).toHaveText(["密道入口在雕像后"]);
  await expect(values("关联情节线")).toHaveText(["未填写"]);
  await expect(values("世界约束")).toHaveText(["北境关口只在冬季开放"]);
  await expect(values("预期变化")).toHaveText(["主角掌握密道位置"]);
  await expect(values("场景结果")).toHaveText(["事实变化：密道确实存在"]);

  // 原始记录一并可读，且仍标记为候选。
  const json = details.locator(".narrative-state__json");
  await expect(json).toContainText(/"sceneHiddenInformation"/);
  await expect(json).toContainText(/"confirmation": "candidate"/);
  await expect(json).toContainText(/"updatedAt": "2026-01-01T00:00:00"/);
  await expect(json).toContainText("密道入口在雕像后");

  // 展开完整字段没有触发任何写入，确认入口依然可用。
  expect(confirmRequests(server, "scene-plans")).toHaveLength(0);
  expect(server.scenePlans[0].confirmation).toBe("candidate");
  await expect(row.getByText("候选", { exact: true })).toBeVisible();
  await expect(row.getByRole("button", { name: "确认", exact: true })).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(toggle).toHaveText(/查看完整字段/);
  await expect(row.locator(".narrative-state__details")).toHaveCount(0);
});

test("场景计划 409 冲突只列出被改动的隐藏信息、预期变化与场景结果", async ({ page }) => {
  const server = createServer({
    scenePlans: [detailedScenePlanRow({ id: "sp-1" })],
  });
  await openNarrativeSection(page, server);

  await page.getByRole("tab", { name: "场景计划" }).click();
  const row = page.locator('.narrative-state__row[data-item-id="sp-1"]');
  await expect(row.getByRole("button", { name: "确认", exact: true })).toBeVisible();

  // 另一个写入者在本次读取之后只改写了三个字段。
  const stored = server.scenePlans[0];
  stored.hidden_information = ["密道入口已封死", "守卫换班提前"];
  stored.expected_changes = ["主角放弃密道"];
  stored.result = SCENE_RESULT_AFTER;
  stored.updated_at = SECOND_TIMESTAMP;

  await row.getByRole("button", { name: "确认", exact: true }).click();

  const conflict = row.locator(".narrative-state__conflict");
  await expect(conflict).toBeVisible();
  await expect(conflict.getByText("内容已被修改")).toBeVisible();

  // 逐字段比对：恰好这三个字段，顺序与字段定义一致，未改动字段不得混入。
  const changes = conflict.locator(".narrative-state__conflict-change");
  await expect(changes).toHaveCount(3);
  const changedKeys = await changes.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-field-key") ?? ""),
  );
  expect(changedKeys).toEqual(["sceneHiddenInformation", "sceneExpectedChanges", "sceneResult"]);
  for (const untouched of ["sceneGoal", "sceneLocation", "sceneTone", "sceneWorldConstraints"]) {
    await expect(
      row.locator(`.narrative-state__conflict-change[data-field-key="${untouched}"]`),
    ).toHaveCount(0);
  }

  // 变更前后的内容都可读：列表逐条、场景结果按类别展开。
  const hiddenBlock = conflict.locator(
    '.narrative-state__conflict-change[data-field-key="sceneHiddenInformation"]',
  );
  await expect(hiddenBlock).toContainText("隐藏信息");
  await expect(hiddenBlock).toContainText("确认前你看到的内容：密道入口在雕像后");
  await expect(hiddenBlock).toContainText("当前最新内容：密道入口已封死；守卫换班提前");

  const expectedBlock = conflict.locator(
    '.narrative-state__conflict-change[data-field-key="sceneExpectedChanges"]',
  );
  await expect(expectedBlock).toContainText("预期变化");
  await expect(expectedBlock).toContainText("确认前你看到的内容：主角掌握密道位置");
  await expect(expectedBlock).toContainText("当前最新内容：主角放弃密道");

  const resultBlock = conflict.locator(
    '.narrative-state__conflict-change[data-field-key="sceneResult"]',
  );
  await expect(resultBlock).toContainText("场景结果");
  await expect(resultBlock).toContainText("确认前你看到的内容：事实变化：密道确实存在");
  await expect(resultBlock).toContainText(
    "当前最新内容：事实变化：密道通向地窖；信念变化：主角相信队长被俘；关系变化：主角与守卫敌对；情节线变化：失踪的哨兵推进",
  );

  // 未改动的正文内容保持展示，未经人工确认不得显示为已确认。
  await expect(row.locator(".narrative-state__primary")).toHaveText("让主角发现密道");
  await expect(row.getByText("已确认", { exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "核对后重新确认" })).toBeVisible();
  await expect(row.getByRole("button", { name: "确认", exact: true })).toHaveCount(0);

  // 只提交过一次确认请求：冲突后不得自动重试，令牌仍是读取时的值。
  await expect.poll(() => confirmRequests(server, "scene-plans").length).toBe(1);
  const [firstAttempt] = confirmRequests(server, "scene-plans");
  expect(firstAttempt.body).toEqual({ expected_updated_at: TIMESTAMP });
  expect(server.scenePlans[0].confirmation).toBe("candidate");
  expect(server.scenePlans[0].updated_at).toBe(SECOND_TIMESTAMP);

  // 人工核对后再次确认：携带刷新后的确切令牌（CAS），成功后冲突提示消失。
  await row.getByRole("button", { name: "核对后重新确认" }).click();
  await expect(row.getByText("已确认", { exact: true })).toBeVisible();
  await expect(conflict).toHaveCount(0);

  const attempts = confirmRequests(server, "scene-plans");
  expect(attempts).toHaveLength(2);
  expect(attempts[1].body).toEqual({ expected_updated_at: SECOND_TIMESTAMP });
  expect(server.scenePlans[0].confirmation).toBe("confirmed");
});
