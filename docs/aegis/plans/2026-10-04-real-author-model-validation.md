# 作者样本与真实模型验证

## 基线与范围

本地基线 `edcd674f28054133e88e8f11ba4b7ffcac33feb2`，分支 `feature/branding`，开始时仓库干净、只有一个工作树。沿用当前 Skills、Notes 文风档案、Agent dispatch、加密凭据和审批。用户授权配置本地兼容网关、分析本人样本并采用项目文风；实测模型固定为 `cline-pass/mimo-v2.6-flash` 与 `cline-pass/deepseek-v4.1-flash`。

## 实施与验证

1. 通过现有 API 保存提供商、两个模型和独立样本项目；凭据只进入应用加密存储。
2. 导入四个公开文字章节；目录跳转和图片页不计完整文字样本。原文和模型输出仅保留于本地应用数据。
3. 两模型对同一批样本分析，人工复核共同结论并去除机械否定作者惯例的条目，保存确认档案和短声线/场景卡。
4. 通过现有 Build → Writer → Reviewer → Actor 协议进行实测，记录实际用量、缓存、错误、修改范围；原章保持不变。
5. 补齐并运行相关回归、lint/typecheck；提交和推送新增代码及匿名验收报告，不提交密钥、样本或数据库。

## 实测触发的修复切片

观察到 reasoning 耗尽输出额度时子 Agent 可能无正文。Claude Code 只读审查和协调者源码复核发现 `_last_assistant_content` 向前扫描所有历史，存在后续回合误用旧正文的判定缺陷。

决策：`code-change`。只修 `subagent_runner.py` 的本回合最终正文判定并补同 owner 测试；不改变 Provider 重试、模型调用、状态持久化、Tool 审批或 Agent 架构。最新 HumanMessage 是本回合边界；当前最终 AIMessage 为空或仅有工具调用应失败，不能退回旧回复；合法文本 block 应可读取，reasoning block 不作为正文。

TDD Mode 为 off；使用 mock/fake 和 SQLite 现有 fixture 验证当前请求到完成判定的 seam，无付费测试依赖。Claude Code 仅获两个文件的编辑范围，协调者独立复核与运行门禁。

## 兼容与边界

保留既有数据库、用户自定义 Agent/Prompt、默认审批和无正文错误状态。修复不新增 owner、迁移、fallback、依赖或工作树。真实模型实测不是盲评，也不是旧/新 Prompt 的受控 benchmark，不能推断全书质量提升或整体 V1 发布完成。服务未提供价格元数据时费用未知，不能用本地默认零单价声称免费。
