# OpenFix 0.12.4 验收记录

## 基线与范围

- 本地 `feature/branding`，任务开始 HEAD `3387234`，工作区干净。
- 评估自有仓库 PR #3/#4，按当前实现语义吸收，未合并其旧分支。
- 产品修改：文笔润色与连续性体检、Story Memory 中断状态恢复、Inline AI 输出清理、卷按钮翻译；版本同步到 0.12.4。
- 小说数据与模型输出保存在 Git 忽略的私有验收目录，正文和数据库不进入代码仓库。

## 实际执行

| 检查 | 结果 |
| --- | --- |
| `backend: .venv/Scripts/python.exe -m pytest tests -q` | 2667 passed in 437.31s |
| `backend: .venv/Scripts/ruff.exe check app` | exit 0，All checks passed |
| `backend: .venv/Scripts/ty.exe check app` | exit 0，All checks passed |
| 独立复审 `test_story_memory_recovery.py` + `test_novel_naturalness.py` | 66 passed in 8.69s |
| 收尾重跑 `test_inline_ai.py`、`test_story_memory_recovery.py`、`test_agent_definitions.py`、`test_novel_naturalness.py` | 110 passed in 8.17s |
| `frontend: node scripts/test-volume-header-labels.mjs` | 两种语言的卷按钮 common keys 均有有效翻译 |
| `frontend: pnpm type-check` / `pnpm lint` | 均 exit 0，0 warnings / 0 errors |
| `frontend: pnpm build` | exit 0；存在 Vite chunk 超过 500 kB 和插件耗时警告 |
| `desktop: pnpm type-check && pnpm lint && pnpm build` | exit 0 |
| `desktop: pnpm package && pnpm verify:release` | exit 0，本地 x86_64 安装包、zip、wheel、清单及 SHA512 校验通过 |
| Windows `Get-AuthenticodeSignature` | 安装包为 NotSigned；打包日志中的签名阶段不等于有受信任发布证书 |

构建使用私有 uv cache 避开全局临时文件故障，`uv.lock` 仅更新项目版本，无依赖升级。公开 Release、在线更新端点、arm64 打包及安装后升级验收不包含在以上结果中。

## 真实运行验证

安装版 0.12.3 的 Story Memory 状态为 `building`，但活动重建任务为 null。
将安装数据库通过 SQLite backup 复制到私有隔离目录，复制本地加密配置后，以当前源码和新前端启动验收实例；后台 worker 关闭，避免重跑历史付费任务。

- 状态 API 实测返回 `failed`、活动任务 null，以及“故事记忆索引重建已中断，请重新重建。”
- `embedding_configured=true`，不把状态中断误报为未配置模型。
- Chrome 源码页面实测卷按钮显示“展开”，没有原始 `common.collapse` 标签。
- 测试进程版本环境指定为 0.12.4；wheel 版本由打包校验独立证明。
- 用户安装实例尚未升级，不能据此声称安装版现场缺陷已消失。
- 额外的卷按钮点击校验被自动审批以目标无法可靠识别为由拒绝，未完成该点击；页面标签读回及翻译回归已通过。

## 写作验收边界

第16—21章候选通过既有 OpenFix Inline AI custom 接口调用已配置的 Gemini，再做场景纠偏与局部编辑。该证据不是完整 Writer → Reviewer → Actor 自动流水线的端到端保证。

初稿出现超长、伤势漂移、装备提前出现、管网细节膨胀、人物承担知识灌输等问题。本次稿件逐项纠正；不据此宣称所有模型幻觉已由运行时根治。

主代理通读并核对前章、时间、人物认知、伤势与章际接口，修正晚饭接缝和比试判胜/私练限制的歧义，最终接受六章。应用同一 `count_words` 口径：16章2720字、17章2759字、18章2720字、19章2797字、20章2766字、21章2774字，合计16536字。

- 通过安装版公开API新建六章并关联对应大纲，正文SHA256读回一致。
- SQLite备份和逐表比对确认前15章及Canon表未变，允许的变化仅为新章、六个大纲关联及项目/卷汇总字段。
- 安装版Chrome项目页实测显示第一卷21章。
- 从API重新导出全部21章，共58018字，已同步至用户授权E盘正文目录的 `OpenFix已验收` 子目录；21份目标文件SHA256逐一匹配，原有旧草稿保留。
- 六份新章摘要、16—21区间摘要和21章正文索引已完成；首轮Story Memory整批重建已ready，刷新后台脚本exit0。
- 严格来源比对发现旧第9章小幅修改未超过已有摘要100字符差异阈值；普通入队会复用ready摘要。通过现有定向维护API补刷时，Gemini网关8317停止响应，生成失败。已从刷新前备份仅恢复该条原ready摘要，未回滚整库或正文；第9章精确重算未完成，原有1—10区间摘要继续保留。
- 最终读回：21章摘要ready且依现行策略未过期，新六章摘要来源与正文精确匹配；第9章原摘要仍有阈值内差异，不能称全部21章来源完全一致。正文索引fresh、21章已索引、StoryMemory ready，数据库integrity_check为ok；前15章与Canon表再次确认不变。

Claude Code 连接重试返回READY，真实读取了六章及前一章；生成完整小说复审结论时遇到重复502，已停止无效重试。后续有界章际摘录复审明确未见阻塞问题，逐项核对时序、伤势和物品；其非阻塞疑问由主代理结合完整正文裁定，不为迎合摘要审查机械补句。该报告只证明摘录范围，最终小说接受责任由主代理承担。

Claude Code代码复审最终返回“未发现可确认的新引入缺陷”，覆盖Inline AI清理和Story Memory生命周期；它没有运行测试，与主代理真实全量测试证据分开记录。

## 兼容性与未验证风险

- 没有 schema 变化或 migration，不覆盖数据库 Agent 自定义清单；已有覆写可能需要手动启用 continuity-audit / prose-polish。
- Skill 只按清单和 activate_skill 按需加载，references 不默认注入。
- 账本是非 Canon 分析候选；Prompt 协议不是事务性安全保证，仍使用现有写入审批。
- 当前 Story Memory 测试覆盖不同 replacement job、失败、取消、超时、重启、ready 保护及项目隔离；同 job_id 租约转移后旧 worker 的晚回调没有 attempt CAS，此并发场景尚未验证。
- 单独一对引号包围的短文本仍可能被识别为模型包装；多对白与嵌套正文有回归覆盖，但字符串本身不能完全辨别孤立对白与包装。
- 不将本地安装包准备描述为已公开发布或自动更新渠道已切换。
- Gemini网关恢复后，值得补验第9章摘要精确重算和真实新版完整Writer/Reviewer/Actor流水线；当前创作验收不替代该流水线验收。

## Git交付

代码、测试、版本及首轮QA提交为 `510e868`：`feat(writing): prepare 0.12.4 continuity review and runtime fixes`。最终补充验收记录为独立文档提交。使用显式路径allowlist与暂存diff检查；无小说、数据库、密钥或私有模型输出进入Git。当前只完成本地准备，未推送公共发布标签。
