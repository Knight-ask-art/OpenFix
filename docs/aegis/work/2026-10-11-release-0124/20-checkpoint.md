# 当前进度

- 本地分支feature/branding、开始HEAD 3387234。已语义吸收PR #3/#4，不整支合并旧架构。
- 已实现：按需continuity-audit、Actor文笔局部修订、Writer轻量自检；移除prose-polish固定比例/修辞配额；StoryMemory孤儿building恢复及终态hook；Inline AI真实引号/围栏尾文保护；卷按钮中英翻译。
- 后端全量pytest：2667 passed in437.31s；ruff check app与ty check app均exit0。前端翻译回归、type-check、lint、build均exit0；Vite存在chunk体积警告。
- Desktop type-check/lint/build/package/verify:release均exit0；安装包和wheel为0.12.4，latest.yml本地产物校验通过。尚未公共发布、升级用户安装版或证明在线更新渠道。
- 用安装DB的SQLite backup副本启动源码9000，后台worker关闭；API确认孤儿building显示failed与安全重建提示，embedding_configured=true。Chrome源码页卷按钮显示“展开”，状态栏0.12.4；版本为该测试进程环境指定，不以此证明wheel版本。
- 六章final主审完成，修正19的纠偏残留、19/20晚饭接缝、18私练与比试规则歧义。2720/2759/2720/2797/2766/2774字，合计16536字，hash审批完成。
- API保存六章并关联大纲，保护表比对通过，前15章与Canon不变；安装Chrome实测21章。导出全部21章58018字并同步用户授权E盘“OpenFix已验收”，目标SHA256全部匹配、旧稿保留。
- 六份新章摘要、16—21区间摘要、21章正文fresh索引完成；首轮StoryMemory重建ready、刷新脚本exit0。严格来源比对发现旧9章小幅修改未超已有摘要过期阈值，补刷新9章/1—10区间/StoryMemory，终态待回收。
- Claude Code连接重试实际返回READY，真实读取六章及前章，但完整报告反复502，停止无效重试。最终代码静态复审未确认新缺陷，未执行测试；有界章际摘录复审未见阻塞问题，非完整六章审查。
- Codex独立代码复审未确认阻塞问题，实跑相关66测试通过。残余风险：同job_id旧worker租约回调无attempt CAS；用户DB覆写Agent不会自动获得新默认技能；Prompt协议非事务保证。
- 私有正文、模型输出、数据库和凭据始终在Git忽略的backend/.venv/novel-acceptance。隔离源码进程已停止，Chrome已回安装实例。下一步：派生资料精确来源终检、QA与发行记录→显式allowlist本地提交。公共发布仍未授权。
