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
- [todo] 增加明确的“新建 Codex thread”流程，让 Chaop 可以创建本机 Codex/app-server thread，而不只是 attach 已存在的本机 sessions。
- [todo] 通过 connector 将 Chaop archive/unarchive 操作同步到本机 Codex app-server archive 状态，同时保持本机 history 文件只读。
- [pending] 将 Codex CLI adapter 替换为真实 Codex app-server protocol execution。
