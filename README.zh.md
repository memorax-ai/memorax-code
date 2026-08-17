<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/memorax-code-lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/memorax-code-lockup-light.svg">
    <img src="docs/assets/memorax-code-lockup-light.svg" alt="MemoraX Code" width="420">
  </picture>
</h1>

<h2 align="center">上下文不断档，开发无需重来</h2>

<p align="center">
  <sub>不止于代码，更记住架构演进与研发脉络。</sub>
</p>

<p align="center">
  <a href="https://code.memorax.net/"><img src="https://img.shields.io/badge/website-code.memorax.net-2563eb" alt="MemoraX Code 产品网站"></a>
  <a href="https://www.npmjs.com/package/@memorax/memorax-code"><img src="https://img.shields.io/npm/v/@memorax/memorax-code.svg" alt="npm 版本"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node.js 24 或更高版本">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

## 让下一次任务从已有经验开始

Coding Agent 擅长解决当前对话中的问题，但新会话往往无法继承此前形成的架构认知、失败经验、
仓库知识、工作流程和沟通偏好。

MemoraX Code 为 Codex 和 Claude Code 提供共享记忆，帮助后续会话找回相关工程经验，更快理解
当前仓库，并延续你习惯的协作方式。

使用 MemoraX Code，你可以：

- 跨会话延续有价值的工程经验；
- 让 Codex 和 Claude Code 共享仓库上下文；
- 复用偏好的工作流程和协作方式；
- 通过 Memory Viewer 查看本地活动。

## 快速开始

开始前，请准备 Node.js 24 或更高版本，以及 Codex 或 Claude Code。只有使用 Repo Memory
功能时才需要 Python 3。

运行：

```bash
npm install -g @memorax/memorax-code
memorax-code
```

首次运行会完成尚未完成的安装引导。请按提示填写 User ID 并选择记忆语言偏好；
无需提前注册账号或创建 API Key。完成初始化后，再次运行 `memorax-code` 会显示当前状态。

以后需要主动重新配置或再次运行安装引导时，可以运行：

```bash
memorax-code setup
```

## 体验跨会话记忆

在一个真实项目中打开 Codex 或 Claude Code，并完成一次代码任务。在 Codex 中使用
`$memorax-code`，在 Claude Code 中使用 `/memorax-code`。

让 Agent 记住一条经过验证的工程经验，然后在同一仓库中开启新会话并让它回忆这条经验。
MemoraX Code 会为新任务带回相关上下文。

## 常用命令

```bash
memorax-code status
memorax-code update
memorax-code setup
memorax-code uninstall
```

## 了解更多

- [安装指南](INSTALL.md)
- [配置](docs/configuration.md)
- [故障排查](docs/troubleshooting.md)
- [安全策略](SECURITY.md)
- [参与贡献](CONTRIBUTING.md)

## 开源许可证

MemoraX Code 基于 [MIT License](LICENSE) 开源。
