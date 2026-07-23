# 贡献指南 / Contributing

感谢你对本项目的关注！这是一个 Ulanzi DX200 / Ulanzi Deck 的 JavaScript 插件基座。

## 开发环境

- **Node.js 24+**（测试套件依赖当前版本 `node:test` 的异步语义，20/22 会失败）
- 无需额外全局工具

```bash
# 克隆后，安装示例插件与模板的依赖
cd plugins/com.ulanzi.lexutility.ulanziPlugin && npm ci && cd -
cd template/com.example.hello.ulanziPlugin && npm install && cd -

# 在仓库根目录跑测试
npm test
```

## 提交前检查

- `npm test` 全绿（CI 也会在 Node 24 上运行）
- 遵循 [docs/development-rules.md](docs/development-rules.md) 的命名与结构约定
- 新增 action 时补齐四层命名：`plugin/actions/<key>.js`、`property-inspector/<key>.html` + `<key>.js`、`assets/icons/action<Key>.svg`、`manifest.json`

## 提交流程

1. Fork 并从 `main` 切出特性分支
2. 保持提交信息清晰（推荐 Conventional Commits，如 `feat:` / `fix:` / `docs:`）
3. 开 Pull Request，说明动机与验证方式
4. 确保 CI 通过

## 行为准则

请保持友善、专业。围绕技术本身讨论。

---

Thanks for contributing! This is a JavaScript plugin starter for the
Ulanzi DX200 / Ulanzi Deck. Requires **Node.js 24+**. Run `npm test`
before opening a PR against `main`, and keep CI green.
