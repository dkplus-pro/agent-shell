# word-count 插件

演示插件工具源：`plugin.json`（manifest，含 `apiVersion`）+ `entry.mjs`（`definePlugin()`）只注册一个工具
`word_count`，core 把它命名空间化为 `plugin__word_count__word_count`（docs/01 §5.4）；计数逻辑在
`count-words.mjs`，纯函数，可脱离插件 API 单测。信任边界如实描述：插件与 shell **同进程、完整 Node 权限、
不是沙箱**，可绕过审批，故只加载 `plugins.dirs` 显式声明的可信目录（ADR-0007）；`entry.mjs` import
`@agent-shell/core/plugin`，需先 `pnpm --filter @agent-shell/core build` 才能加载。
