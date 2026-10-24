# OpenFix 0.12.6 修复与发布记录

## 基线与任务边界

2026-10-24；TaskStartSnapshot：feature/branding，HEAD 7ae5475，工作区干净，git diff --check通过。实际工程是本地Python/FastAPI + React/Electron Fork。

用户要求根据0.12.5重发版真实三章试写继续修复并发布新版本。默认递增至0.12.6，避免同版本更新无法发现。私有试稿与轨迹保留在忽略目录trial-0.12.5-reissue-20261024，公共测试只用合成文本。

已知证据：60初测6127后完成合同但有质量待修；61 Writer与Actor均耗尽预算；62初测6387后仍超范围。工具有时未传范围导致within_range=null，但最终可信合同仍拒绝。项目实际缺少有效confirmed文风卡，不是已证明加载器错误。修订存在无依据新事实与Reviewer误报/漏报，不能以硬编码词表冒充语义正确性。

## 方案与顺序

使用Aegis systematic-debugging与有界协作流程。TDD Mode: off，补比例适当的回归测试，不要求RED/GREEN先行。

1. 文风状态：Claude Code在现有style_profile_service/context边界保留细化跳过原因，沿用Note存储与800token预算；不自动建立或确认档案，不新增迁移。
2. 篇幅收敛：可信writing_contract为测量范围唯一来源；在既有measurement结果中反馈目标、保留/增减预算与剩余额度，初稿给有界场景预算建议。保持精确全文hash、总尝试额度、不截断正文。
3. 失败恢复：复用持久化子请求和工具历史，在只读子Agent详情中提供经真实测量验证的保留候选及失败原因/哈希。失败仍是error，不注册成功handoff；人工明确发起续修，不能自动清预算。
4. 修订验收：复用Reviewer/Actor/现有差异与preserve协议，要求对版本绑定的新增/删除事实、证据与不确定性作差分审查；不增加第二套RAG、不声称自动证明语义正确。核查已有接口后选择最小接入。
5. 定向与完整回归、类型/lint/build、隔离真实试写与包内核验；提交推送、构建签名状态披露、公开0.12.6并核验更新发现。

## 编辑前决策

Decision: code-change。规则与失败记录已有，缺口是可信合同到工具反馈、失败候选到用户可用详情、文风拒绝原因到状态的接线。不能仅再加提示词，也不通过扩大重试预算掩盖失败。

PatchShape：现有合同/上下文/子请求公开接口的窄扩展。CanonicalOwner：writing_contract与measure_text、style_profile_service、既有子请求历史。UpwardDrillSignal：跨执行/交付/展示边界。Decision：修owner，旧调用无合同保持兼容，不建立新候选存储或自动写入Canon。

所有试验只启动独立Python后端，不隐藏启动Electron，不影响用户桌面单实例。结束关闭本轮实例，核原作品hash。发布验收与文学质量验收分别报告，真实数据不足不报提升百分比。

## 实施结果

- `style_profile_service.py`、context part/source snapshot、前端 context panel：拒绝原因区分缺失、歧义、未确认、格式无效和超预算，保留旧快照原因兼容。Writer/Reviewer继续读取已有confirmed短卡，不自动确认档案。
- `writing_contract.py`、`measure_text.py`、`react_agent.py`：可信合同覆盖模型自填测量范围，反馈目标、允许增减范围和保留比例；剩余额度由真实声明顺序确定。总额度与最终精确全文hash校验保持不变。
- 实际试写暴露了接线缺陷：在graph取得工具结果后再添加反馈，晚于工具结束事件持久化。修复移至`MeasureTextTool._execute`返回之前，graph只传可信metadata；撤去后置装饰，避免两个反馈来源。补真实事件→MessagePersister→load_history逐字回归。
- `writing_recovery.py`、API schema/router、`writing-recovery-panel.tsx`：失败Writer/Actor可显式按需取回最新请求额度内最后一份经配对测量验证的稿。要求明确请求seq，拒绝旧轮、伪造、缺结果、超额度或运行中请求。返回`approved=false`，只读/复制，不自动保存或续跑。
- `compare_revision.py`及注册/权限/分类：只读核对前后hash，复用现有diff preview，限制输入/输出，支持字面preserve。始终要求语义复核，不声称差异证明质量合格。
- Writer/Reviewer/Actor提示词：补修订差异与新增事实审查，强调不确定性、来源、伤势/材料边界，不能为凑数量新增内容或把外观当安全证明。
- `tools/base.py`、`tools/errors.py`：参数校验失败不再拼接输入文本，ValidationError使用固定错误且不记录含输入的原异常。实际工具调用与日志的合成sentinel测试验证无回显。
- 版本四处及release-please manifest统一0.12.6。无数据库schema或migration变更。

## 真实试写与限制

所有正文与完整轨迹仅在忽略目录，不入公共报告。采用相同第60章作者请求、原模型配置和三次测量合同。

| 阶段 | 实测字数 | 结论 |
| --- | --- | --- |
| 首份候选包，反馈尚未进入持久化历史 | 6183 → 2487 → 2653 | error，未保存 |
| 修复持久化接线后 | 5026 → 2740 → 3206 | error，仍不在作者范围，未保存 |

第二轮三次持久化结果均包含writing_budget，remaining分别2/1/0，最后next_action为stop_and_retain_candidate。真实API取回最后3206字稿，hash与第三次测量一致，approved=false、within_contract_range=false。也验证了旧失败Actor的3232字稿可取回。未反复重置同一请求预算凑成功。

这些证据证明接线与失败保护，不证明篇幅稳定性或文学质量提升；不报告提升百分比。修订质量、事实保留与风格仍需人工审稿，通用diff工具不能证明语义正确。没有将试稿写入正式小说、Canon或E盘。

## 验证记录

- 早期focused夹具/mock失败已修正；第一轮完整为5 failed/2977 passed，第二轮为2 failed/2980 passed。后者是新增工具权限列表快照未更新，已补齐。失败记录保留，不计为通过。
- 冻结后定向命令：`python -m pytest tests/agent_runtime/graph/test_writing_contract_runtime.py tests/agent_runtime/tools/test_measure_text.py tests/api/test_settings.py tests/agent_runtime/test_writing_recovery.py tests/api/test_writing_recovery.py tests/agent_runtime/tools/test_compare_revision.py -q`：89 passed，16.37秒。
- 冻结后完整`python -m pytest tests -q`：2985 passed，778.11秒；无失败。
- 后端`ruff check app`与`ty check app`通过。
- 前端`oxlint . --type-aware --type-check`：0 warnings/0 errors；`OPENFIC_BUILD_VERSION=0.12.6 vp build`及precache生成通过。
- Desktop `vp build`、main/renderer `tsc`与ESLint通过。
- `node scripts/verify-release.mjs --config-only`全部通过。
- 最终wheel：697份源输入逐字核对，sha256为`5e60a18b920e1077409d6b23409eba9f020c7c0a4409317779344d1549195d05`。隔离TestClient健康版本0.12.6、前端HTTP200、精确候选通过且改字后交付被拒。
- 已完成冻结生产代码独立静态复核，无剩余已确认发布阻断缺陷。静态意见不替代测试或运行验收。

## 数据与桌面实例保护

正式库和旧试写副本保护表均无变化；两份本轮试写副本各11张保护表无变化。正式API逐章回读59章hash全部与基线相同。测试后端40644、50970已关闭，未启动Electron，不占桌面单实例。正式服务健康，仍由用户原进程运行。

## 发布状态

Windows x64/ARM64的NSIS和ZIP构建成功；ZIP CRC、PE架构、内置wheel、frontend index、app.asar与uv资源核验通过。两架构内置wheel均为上述最终hash，ASAR内运行时编译代码与本地dist逐字一致。

普通`verify-release.mjs`与`--prepared-update-assets`全部通过，生成双架构安装版/便携版/blockmap及三份更新清单，共9个资产。Authenticode实查两架构程序和安装包均为NotSigned，不能以构建日志的signing文字宣称已签名。ARM64无真机验收，未覆盖安装用户当前实例。

## 公开发布回执

- 修复提交及release tag：`5afc256b5d39d0e612ce78204413a3ab180fa161`，`v0.12.6`。
- Release：https://github.com/Knight-ask-art/OpenFix/releases/tag/v0.12.6 ，已公开且Latest指向0.12.6。
- GitHub端9个资产的大小及SHA-256全部与本地清单一致；tag精确指向上述修复提交。
- Git直连Schannel/OpenSSL均遇TLS错误，通过本机现有代理正常push成功。曾尝试Git Database API但未更新任何ref，最终未使用替代提交。
- 公开资产HTTP下载与真实GitHub provider更新探针遇TLS EOF/握手断连；Python、Node、curl及受限环境外只读复测均未完成联网验证。不能声称在线更新端到端验收通过。
- 使用实际electron-updater、0.12.5隔离AppAdapter和本次精确清单，经本地HTTP feed核验x86_64/aarch64均发现0.12.6并选对架构安装包；不下载/安装。该证据只证明清单兼容和版本发现，不证明公网连接。

## 用户追加的旧资产清理

按明确授权，逐项盘点并删除7处0.12.4/0.12.5旧安装包、便携包、blockmap、解包目录和旧wheel；删除前均核无Git跟踪文件、数据库、密钥、reparse point或进程引用。删除文件合计5,952,727,582字节，磁盘可用空间实测增加5,962,018,816字节，逐项目标已不存在。

最初包含本轮0.12.6作废目录的更大清单被自动审批拒绝，原因是`package-final-*`被判定可能是当前最终包；该操作没有执行。随后缩小到明确旧版本资产才执行清理，所有0.12.6目录、当前安装、源码、作品数据、配置和验收日志保留。清理后Git状态干净，正式服务healthy，59章hash再次全部一致。

任务边界：已完成本轮代码修复、实际回归、提交推送、双架构打包、公开发布及旧版本资产清理。尚未证明模型篇幅/文学质量稳定性，也未完成公网更新探针、覆盖安装、ARM64真机或新取回面板的交互验收。撤去graph后置预算装饰，MeasureTextTool为反馈单一生成位置；旧无合同测量与旧快照原因兼容保留。没有第二套候选库或RAG，没有Canon变更。
