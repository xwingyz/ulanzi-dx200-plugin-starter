# 安全策略 / Security Policy

## 报告漏洞 / Reporting a Vulnerability

请**不要**通过公开 Issue 报告安全漏洞。

请使用 GitHub 的私密漏洞报告渠道：
仓库 **Security** 标签页 → **Report a vulnerability**
（GitHub Private Vulnerability Reporting）。

我们会尽快确认并处理。

---

Please do **not** report security vulnerabilities through public issues.
Use GitHub's private reporting instead: the repository's **Security** tab →
**Report a vulnerability**.

## 说明 / Notes

本项目是一个本地运行的 Ulanzi 插件基座，部分 action 会读取本机凭据
（如 macOS 钥匙串中的 Claude Code token、Codex CLI 的登录状态、
Synology/Bambu 的账号）。这些凭据仅在本机使用，不随仓库分发；运行态
数据存放在被 `.gitignore` 排除的 `plugins/*/data/` 目录下。
