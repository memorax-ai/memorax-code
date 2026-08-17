<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/memorax-code-lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/memorax-code-lockup-light.svg">
    <img src="docs/assets/memorax-code-lockup-light.svg" alt="MemoraX Code" width="420">
  </picture>
</h1>

<p align="center">
  <a href="https://trendshift.io/repositories/105791?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-105791" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/105791/daily?language=JavaScript" alt="memorax-ai/memorax-code | Trendshift" width="250" height="55" /></a>
</p>

<h2 align="center">上下文不断档，开发无需重来</h2>

<p align="center">
  <sub>
    不止于代码，更记住架构演进与研发脉络。
  </sub>
</p>

<p align="center">
  <a href="https://code.memorax.net/"><img src="https://img.shields.io/badge/website-code.memorax.net-2563eb" alt="MemoraX Code 产品网站"></a>
  <a href="https://www.npmjs.com/package/@memorax/memorax-code"><img src="https://img.shields.io/npm/v/@memorax/memorax-code.svg" alt="npm 版本"></a>
  <img src="https://img.shields.io/npm/v/@memorax/memorax-code.svg?label=version&color=f59e0b" alt="npm 包版本">
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node.js 24 或更高版本">
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

## 让每次交互，都成为下一次的起点

Coding Agent 擅长解决眼前的问题，但新会话不会自动继承此前积累的架构认知、踩坑经验、仓库规则
和协作偏好。

MemoraX Code 让 Codex、Claude Code 和 OpenCode 共享一套能够持续积累的记忆。它会沉淀代码任务中的
工程经验，持续整理仓库知识，并在后续任务中找回相关的工作流程和偏好。

它追求的不是“记得更多”，而是在需要时带回与当前任务相关的 Memory，让 Agent 减少重复搜索和试错，
更快进入问题定位与事实验证。

## 快速开始

开始前，请确保已安装 Node.js 24 或更高版本，以及 Codex、Claude Code 或 OpenCode 中的至少一个。
Repo Memory 操作还需要 Python 3。

### 安装与接入

#### 1. 获取 MemoraX Memory API Key

前往 [MemoraX Console](https://platform.memorax.net/) 注册账号并创建 API Key。请只在本机安装终端中
输入该 Key，不要将其粘贴到聊天记录或公开 Issue 中。

#### 2. 安装并按提示配置

```bash
npm install -g @memorax/memorax-code --foreground-scripts
```

请保留 `--foreground-scripts`，以便查看完整的安装过程。安装器会自动检测本机可用的 Codex、
Claude Code 和 OpenCode，并为检测到的客户端启用集成。按照终端提示输入 Base User ID、偏好语言
和 API Key；Codex 用户还需按提示完成 Hook 的激活和信任确认。安装完成后，请重启或刷新所有检测到的
客户端，再开始新会话。

如果跳过配置或安装过程无法交互，npm 包仍会安装，但 MemoraX 搜索、召回和写回功能无法使用。

### 体验跨会话记忆

克隆示例仓库，并在项目目录中打开 Codex、Claude Code 或 OpenCode：

```bash
git clone https://github.com/SWE-agent/test-repo.git
cd test-repo
```

在 Codex 中使用 `$memorax-code`，在 Claude Code 中使用 `/memorax-code` 调用该 Skill。
在 OpenCode 中，直接让 Agent 使用名为 `memorax-code` 的 Skill。下面的指令使用产品名称，三个客户端
均可直接理解。

在同一个会话中依次发送以下指令：

> 1. 请使用 MemoraX Code Skill 帮我构建 Repo Memory，只拉取最近
>    3 条 Issue、PR 和 Commit 记录。
> 2. Repo Memory 中最近的一条 Issue 提到，第 0 个数字曾经计算错误。请检查当前代码，避免再次出现同类问题。
> 3. 请使用 MemoraX Code Skill 记住这次的代码开发经验。

结束当前对话，然后在同一仓库中开启一个新会话，再发送：

> 请使用 MemoraX Code Skill 回忆之前的开发经验，看看有哪些建议。

此时，Agent 应能找回此前保存的经验，并结合当前仓库给出建议。

> [!TIP]
> 上述指令仅用于快速验证。正常使用时，无需主动调用 MemoraX Code Skill 添加记忆；
> MemoraX Code 会根据当前仓库和任务在后台写入相关记忆，并引导 Agent 在需要时搜索。
> 你可以通过 [Memory Viewer](http://127.0.0.1:8787/memory-viewer)
> 查看不含正文的本地活动与状态。

## 四类 Memory，各有清晰边界

| Memory | 回答的问题 | 典型内容 |
| --- | --- | --- |
| **Coding&nbsp;Memory** | 哪些工程经验值得带入下一次任务？ | 已验证的修复、失败方案、设计依据、常见陷阱和非回归检查 |
| **Repo&nbsp;Memory** | Agent 需要了解这个仓库的哪些信息？ | 架构地图、模块职责、代码入口，以及 Commit、PR、MR 和 Issue 等历史证据 |
| **Personal&nbsp;Memory** | Agent 应该如何与你沟通和协作？ | User Profile 中记录的语言、语气、解释深度和结果呈现偏好 |
| **Procedure&nbsp;Memory** | 这类任务应该如何执行？ | 可复用的步骤、检查清单、前置条件、例外情况和验证要求 |

## 产品能力

| 能力 | 作用 |
| --- | --- |
| **后台写入记忆** | 任务完成后，在后台提取可复用知识并写入 Coding Memory。 |
| **用户偏好延续** | 在 User Profile 中记录用户偏好，并按设定周期将其带入后续任务。 |
| **Procedure 自动复用** | 记录可复用的任务流程，并在后续任务中自动提醒 Agent 按流程执行。 |
| **Repo Memory 后台整理** | 在后台整理仓库结构、代码入口和历史证据，并按策略自动更新，避免反复搜索和总结。 |
| **主动记忆控制** | 使用内置的 MemoraX Code Skill 或 CLI，主动查找和添加记忆。 |
| **客户端集成** | 与 Codex、Claude Code 和 OpenCode 集成，触发记忆检索、提醒和写入。 |
| **本地可视化** | 通过本地 Memory Viewer 查看活动统计、召回与写入状态。 |

## 你的记忆，由你控制

云端记忆依赖 MemoraX。用户在阅读安装披露后输入 Base User ID 和 API Key，会启用
MemoraX 搜索/添加，以及生成配置中的自动写回；不会再出现第二次写回确认。自动召回默认保持关闭，
需要显式启用。

主动记忆操作会将查询或选中的内容发送至 MemoraX。自动写回会从受信任工作区的任务中，发送经过
选择的用户指令和对应的 Agent 最终回复，用于提取和保存记忆；它不会上传完整的本地客户端 trace
文件或本地 trace 路径。

登录 [MemoraX Console](https://platform.memorax.net/) 后，可以随时查看、修改或删除已经保存的记忆。
MemoraX 云端不会接收模型服务商凭据或本地 Backend Token。

完整行为请参阅[配置](docs/configuration.md)，网络、本地数据和保留边界请参阅
[安全策略](SECURITY.md)。

## 更新

全局 npm 安装使用：

```bash
memorax-code update
```

该命令会沿用当前发布通道并保留配置。如果新版本修改了插件资产或 Skill，请重启或刷新
Codex、Claude Code 和 OpenCode。

## 卸载

请先运行产品自身的卸载流程：

```bash
memorax-code uninstall
```

该命令会移除受管客户端集成和全局 npm 包，同时保留 `MEMORAX_CODE_HOME`
（默认为 `~/.memorax-code`）、Claude 插件数据、模型服务配置，以及已保存到 MemoraX
的云端记忆。请在确认不再需要后，分别清理保留的本地或云端数据。

## 文档

- [安装指南](INSTALL.md)
- [配置](docs/configuration.md)
- [故障排查](docs/troubleshooting.md)
- [参与贡献](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 开发与贡献

欢迎提交 Issue 和 Pull Request。修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，
公开报告中不要包含 API Key、原始对话、私有记忆或本地 trace 文件。

## 开源许可证

MemoraX Code 基于 [MIT License](LICENSE) 开源。
