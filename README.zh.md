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
  <img src="https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white" alt="Node.js 20 或更高版本">
</p>

<p align="center">
  <a href="https://discord.gg/eCUS8PpjG"><img src="https://img.shields.io/badge/Discord-Join%20Chat-5865F2?logo=discord&logoColor=white" alt="加入 MemoraX Code Discord 社群"></a>
  <a href="docs/assets/wechat-group-qr.jpg"><img src="https://img.shields.io/badge/WeChat-Join%20Group-07C160?logo=wechat&logoColor=white" alt="加入 MemoraX Code 微信群"></a>
</p>

<p align="center">
  <a href="README.md">English</a> · <strong>简体中文</strong>
</p>

## 让每次交互，都成为下一次的起点

Coding Agent 擅长解决眼前的问题，但新会话不会自动继承此前积累的架构认知、踩坑经验、仓库规则
和协作偏好。

MemoraX Code 让 Codex、Claude Code、WorkBuddy、DeepSeek Harness、OpenCode 和 Trae
共享一套能够持续积累的记忆。
它会沉淀代码任务中的工程经验，持续整理仓库知识，并在后续任务中找回相关的工作流程和偏好。

它追求的不是“记得更多”，而是在需要时带回与当前任务相关的 Memory，让 Agent 减少重复搜索和试错，
更快进入问题定位与事实验证。

## 快速开始

开始前，请确保已安装 Node.js 20 或更高版本（推荐 Node.js 24 LTS），以及 Codex、Claude Code、
WorkBuddy、DeepSeek Harness、OpenCode 或 Trae 中的至少一个。

当前 DeepSeek Harness（DSH）版本要求 Node.js `^22.19.0 || >=24.0.0`。运行 setup 前，
请先安装或初始化 DSH，创建至少一个 Profile，并确保 `pnpm` 在 `PATH` 中可用。
MemoraX Code 不会安装或更新 DSH。

Linux 下，setup 管理凭据需要 libsecret 提供的 `/usr/bin/secret-tool`，以及当前用户会话中可用的
Secret Service。使用 Remote SSH、WSL 或 Dev Container 时，请将 MemoraX Code 安装在
Coding Agent 所在的同一环境中。MemoraX 搜索和写回需要网络访问。

### 安装与接入

#### 1. 安装 npm 包

```bash
npm install -g @memorax/memorax-code
```

此命令只安装包，不会启动交互式安装引导。请勿使用 `--ignore-scripts`：替换包时，npm 生命周期
脚本会安全停止并恢复已有的运行中托管 Backend。

#### 2. 注册或接入 MemoraX 账号（推荐）

前往 [MemoraX](https://platform.memorax.net/) 注册账号；已有账号可直接使用，然后在正常的交互式终端中运行：

```bash
memorax-code setup --existing-account
```

按照安装引导，在本机终端中输入 MemoraX 用户名和 API Key。

> [!TIP]
> 跨设备使用时，可在一台已配置设备的配置文件（默认位于 `~/.memorax-code/config.toml`）中
> 找到 MemoraX 用户名和 API Key，再在新设备的安装引导终端中本地输入。
> 该文件包含您的 API Key，请妥善保管，不要粘贴到聊天记录或公开 Issue 中。

#### 或免账号体验（90 天游客模式）

如果您希望先体验并稍后再接入账号，请运行：

```bash
memorax-code setup
```

默认 setup 会复用已有的完整连接；否则会检测本机用户名和语言，必要时询问，再创建或恢复游客凭据。
如需替换已保存的连接，游客模式使用 `memorax-code setup --reconfigure`，
正式账号使用 `memorax-code setup --existing-account`。

如果稍后注册时希望保留游客记忆，请先直接在本机终端运行：

```bash
memorax-code account --show-mark-id
```

> [!IMPORTANT]
> 请先获取 Mark ID，再前往 [MemoraX](https://platform.memorax.net/) 注册并使用它激活游客账号。
> 当前暂不支持为已经注册的账号补绑 Mark ID。

#### 3. 激活并验证

两种安装引导都会自动检测受支持的 Coding Agent。完成后，请重启或刷新检测到的 Coding Agent。

| 客户端 | 完成激活 |
| --- | --- |
| Codex | 如果尚未启用，请在 Plugins 或 `/plugins` 中启用 **MemoraX Code Codex Adapter**。 |
| Claude Code | 重启或刷新客户端，加载受管插件和 Hooks。 |
| CodeBuddy/WorkBuddy | 重启或刷新 WorkBuddy，加载受管插件、Hooks 和 Skill。 |
| DeepSeek Harness | 重启或刷新 DSH，加载已注册到现有 Profile 中的插件。 |
| OpenCode | 重启或刷新客户端，自动发现受管插件和 Skill。 |
| Trae | 打开 **设置 → Hooks → 全局 → 已配置的 Hooks**，开启已注册的 Global Hooks。setup 会安装 Hooks 和 Skill，但这个开关需要手动开启一次。 |

打开项目，新建客户端会话并发送一次 Prompt，然后在项目目录中运行：

```bash
memorax-code --version
memorax-code status
memorax-cli status
```

Windows PowerShell 请使用 `memorax-cli.cmd status`。客户端真正执行 Hook 之前，已配置好的集成
仍可能显示 `hook-runtime=unverified`；成功执行 Hook 后，对应客户端的 Hook runtime 应变为
`observed`。

`memorax-code status` 检查本地 Backend 和客户端集成；`memorax-cli status` 检查本地记忆配置
和工作区作用域。这两个命令都不会向 MemoraX 发送测试请求；实际搜索或写入才会验证远端连接与凭据。
接着按下方示例体验跨会话记忆，验证实际效果。各客户端的诊断命令见[故障排查](docs/troubleshooting.md)。

### 安装故障排查

npm 包安装完成后不会自动启动 setup，请在交互式终端中运行上面适合您的安装引导命令。
如果 setup 未完成或记忆不可用，请先运行状态检查命令，再按[故障排查](docs/troubleshooting.md)处理。

#### Windows：找不到 `memorax-code` 或 `memorax-cli`

两个命令均由同一个包提供。请按
[Windows PATH 修复步骤](docs/troubleshooting.md#windows-memorax-code-or-memorax-cli-is-not-found)
启动 setup，或修复仍使用旧环境的终端。

### 体验跨会话记忆

克隆示例仓库，并在项目目录中打开 Codex、Claude Code、WorkBuddy、DeepSeek Harness、OpenCode 或 Trae：

```bash
git clone https://github.com/SWE-agent/test-repo.git
cd test-repo
```

在 Codex 中使用 `$memorax-code`，在 Claude Code 或 DeepSeek Harness 中使用 `/memorax-code`
调用该 Skill。在 OpenCode、WorkBuddy 或 Trae 中，直接让 Agent 使用名为 `memorax-code` 的 Skill。
下面的指令使用产品名称，所有客户端均可直接理解。

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
> 本地活动与状态会以受内容控制的 trace 和 reconciliation 记录保存在 `MEMORAX_CODE_HOME` 下。

## 四类 Memory，各有清晰边界

| Memory | 回答的问题 | 典型内容 |
| --- | --- | --- |
| **Coding&nbsp;Memory** | 哪些工程经验值得带入下一次任务？ | 已验证的修复、失败方案、设计依据、常见陷阱和非回归检查 |
| **Repo&nbsp;Memory** | Agent 需要了解这个仓库的哪些信息？ | 架构地图、模块职责、代码入口，以及 Commit、PR、MR 和 Issue 等历史证据 |
| **Personal&nbsp;Memory** | Agent 应该如何与你沟通和协作？ | User Profile 中记录的语言、语气、解释深度和结果呈现偏好 |
| **Procedure&nbsp;Memory** | 这类任务应该如何执行？ | 可复用的步骤、检查清单、前置条件、例外情况和验证要求 |

Personal Memory 和 Procedure Memory 保存在当前仓库的 `.repo_memory/` 下。涉及已有内容时，
MemoraX Code 会先比较含义：语义相同的请求不重复写入；长期有效的补充或冲突规则会更新匹配项，
并彻底移除被替代的文字；适用环境失效时先修正范围，只有整条记忆完全过时时才删除。
用户明确要求忘记时，只删除点名的偏好、流程主题、段落或步骤，其他记忆保持不变。
一次性任务指令不会改写已保存的记忆；是否长期有效或目标不清楚时，Agent 会先询问。

## 产品能力

| 能力 | 作用 |
| --- | --- |
| **后台写入记忆** | 任务完成后，在后台提取可复用知识并写入 Coding Memory。 |
| **用户偏好延续** | 在 User Profile 中记录用户偏好，并按设定周期将其带入后续任务。 |
| **Procedure 自动复用** | 记录可复用的任务流程，并在后续任务中自动提醒 Agent 按流程执行。 |
| **记忆作用反馈** | 在 Codex、Claude Code、WorkBuddy、DeepSeek Harness、OpenCode 和 Trae 中，当本轮主动 Search 的 Coding Memory，或本轮读取、注入的 Repo、Procedure、Profile Memory 确实指导了任务时，Agent 会在最终回复开头用自然语言简要说明。 |
| **Repo Memory 后台整理** | 在支持无头任务的客户端中后台整理仓库结构、代码入口和历史证据，并按策略自动更新，避免反复搜索和总结。Trae 可通过 Skill 使用 Repo Memory，但目前没有可供自动维护使用的无头 worker。 |
| **主动记忆控制** | 使用内置的 MemoraX Code Skill 或 CLI，主动查找和添加记忆。 |
| **客户端集成** | 与 Codex、Claude Code、WorkBuddy、DeepSeek Harness、OpenCode 和 Trae 集成，触发记忆检索、提醒和写入。目前 Codex、Claude Code、WorkBuddy、OpenCode 和 Trae 支持自动额度提醒。 |
| **本地可观测性** | 通过受内容控制的本地 trace 和 reconciliation 记录查看活动统计、召回与写入状态。 |

## 你的记忆，由你控制

云端记忆依赖 MemoraX。完成安装引导后，会启用 MemoraX 搜索/添加，以及生成配置中的自动写回；
不会再出现第二次写回确认。自动召回默认保持关闭，需要显式启用。

受支持客户端的本地 trace 默认开启。根据客户端能力，`MEMORAX_CODE_HOME` 下保留的 trace
可能包含用户指令、Agent 回复、召回的 Memory、提醒文本和本地路径。可通过
[本地 trace 配置](docs/configuration.md#local-traces)改为仅记录元数据，或关闭对应客户端的 trace。

游客额度提醒可能显示完整的 Mark ID；请将包含该信息的提醒文本和本地 trace 视为敏感信息。

主动记忆操作会将查询或选中的内容发送至 MemoraX。自动写回会从受信任工作区的任务中，发送经过
选择的用户指令和对应的 Agent 最终回复，并先移除最终回复中的记忆作用说明，再用于提取和保存记忆；它不会上传完整的本地客户端 trace
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

完成 setup 后，托管 Backend 运行期间也会自动检查并更新。更新会短暂停止运行中的托管 Backend，
再按保留的客户端选择恢复。发布通道、自定义状态目录、客户端选择、Backend 恢复规则和关闭后台检查
的方法见[更新配置](docs/configuration.md#setup-automatic-update-and-package-transition-state)。
如果更新修改了运行中客户端已加载的集成资产，请重启或刷新客户端。

### Windows 升级提示

如果较旧的 Windows 安装在升级时遇到 `EBUSY` 重命名错误，请按
[旧版升级恢复步骤](docs/troubleshooting.md#npm-package-transition-fails)处理。

## 卸载

请先运行产品自身的卸载流程：

```bash
memorax-code uninstall
```

该命令会移除受管客户端集成和全局 npm 包，同时保留配置与已保存的记忆。
请勿先运行 `npm uninstall -g`，否则可能在清理客户端集成之前就移除了产品命令。
完整的保留数据清单见[卸载与数据保留](SECURITY.md#uninstall-and-retention)。

完整卸载后重新安装时，请再次运行 `memorax-code setup`；默认会复用保留的完整连接。
正常执行 `memorax-code stop` 或仅卸载部分客户端集成会保留 setup 完成状态。

## 文档

- [安装与首次使用](#快速开始)
- [配置](docs/configuration.md)
- [故障排查](docs/troubleshooting.md)
- [参与贡献](CONTRIBUTING.md)
- [安全策略](SECURITY.md)

## 开发与贡献

欢迎提交 Issue 和 Pull Request。修改前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，
公开报告中不要包含 API Key、原始对话、私有记忆或本地 trace 文件。

## 开源许可证

MemoraX Code 基于 [MIT License](LICENSE) 开源。
