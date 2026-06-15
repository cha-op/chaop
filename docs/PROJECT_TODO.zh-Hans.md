[ [British English](PROJECT_TODO.md) | 简体中文 ]

# 项目待办

- [done] 将已生成的视觉方向全部纳入第一版互补视图：Operations Map、Operations Task Board、Thread Command Centre 和 Budget Reliability Board。
- [in_progress] 扩展面向用户的文档：英文 canonical 文件保留在默认路径，简体中文正文放在配套的 `*.zh-Hans.md` 文件中。
- [done] 在私有部署仓库/subrepo 或本地已忽略 env 文件中收集第一轮真实部署所需的 Cloudflare account、Access、domain、Wrangler 和 connector bootstrap 配置，不写入主仓库 tracked docs。
- [done] 将 Cloudflare-first placeholder connector 控制闭环从本地骨架强化到可部署的 command dispatch、D1 persistence、Durable Object relay 和 connector lifecycle reporting。
- [done] 使用私有 Cloudflare 配置、Access service-token auth 和第一台本地 connector 跑通 deployed placeholder E2E smoke。
- [done] 在私有 connector 配置后面加入 opt-in 本机 Codex CLI command execution。
- [done] 加入 task archive、Host Sessions attach，以及 Thread Centre 的真实 thread selection。
- [done] 增加 GitHub Actions unit-test CI，跑 shared pnpm 和 Rust test gate。
- [done] 增加明确的“新建 Codex thread”流程，让 Chaop 可以创建本机 Codex/app-server thread，而不只是 attach 已存在的本机 sessions。
- [done] 为已 attach 的 Host Sessions 增加旧 session history backfill，同时默认不上传宽泛的本机 transcripts。
- [done] 通过 connector 将 Chaop archive/unarchive 操作同步到本机 Codex app-server archive 状态，同时保持本机 history 文件只读。
- [done] 为 attach 到本机 app-server Host Session 的 Chaop thread 加入真实 Codex app-server protocol execution。
- [done] PR0：合并已跟踪的 Web deploy script，并通过完整测试、三重 review 和 GitHub conversations resolved 检查。
- [done] PR1：清理 execution UX 和 capability 文案，让 `codex_exec` 只作为 private fallback。
- [done] PR2：增加 connector-managed single app-server lifecycle。
- [done] PR3：增加 cost-safe AppServerInstance state model，覆盖 dedupe、debounce、batching 和 rate limits。
- [done] PR4：在 Operations 和 Host Sessions 相关界面加入 AppServerInstance state UI。
- [done] PR5：让 managed app-server execution 成为默认 command path。
- [done] PR6：增加 drain、scheduled restart 和 upgrade flow。
- [done] PR7：增加 multi-instance 和 thread placement foundation。
- [done] PR8：用真实且 bounded 的 usage/cost metrics 替换 Budget Board placeholder。
