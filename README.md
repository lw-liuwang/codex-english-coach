# Codex English Coach

在与 Codex 完成真实任务时练习英语读写，把需要记住的表达保存到本机网页，之后用卡片复习。英语解释由当前 Codex 生成，无需另配 API Key。

0.1.0 从源码安装，目前没有发布 npm 包。

## 安装

需要 Windows、Node.js 24.x、npm、Git 和可运行的 `codex` 命令。把这段发给 Codex：

```text
请按照 https://github.com/lw-liuwang/codex-english-coach/blob/main/INSTALL.md 安装 Codex English Coach。
```

安装器会构建项目、安装 Skill 和 MCP，并加入全局指令，让新聊天默认使用英语协作；保留已有的无关配置。详见 [安装说明](INSTALL.md)。

## 使用

- **写作**：你可以中英混写。Codex 给出自然英文和中文词汇说明，同时继续原任务。只保存修改与词汇片段，不保存整段需求；自然的英文不强行纠错。
- **阅读**：普通回复使用易懂英文。你主动问词句时，再用中文解释并记录；重要决定附简短中文说明。
- **复习**：打开 [本机网页](http://127.0.0.1:47831)，在记录列表查看详情，进入复习后先回忆、再揭晓，用“忘了 / 费劲 / 熟悉”自评。它不代表客观掌握程度。
- **暂停**：说“赶时间”或“暂停英语学习”，当前聊天停止教学与记录；说“恢复英语学习”再继续。

个人数据默认保存在 `%LOCALAPPDATA%\CodexEnglishCoach`，与源码分开。MCP 可自动启动后端；`saved` 才表示保存成功，`queued` 表示本地待同步。

## 管理

在源码目录运行：

| 命令 | 操作 |
| --- | --- |
| `npm run start` | 启动网页与后端。 |
| `npm run doctor` | 检查安装。 |
| `npm run stop` | 停止后端；后续 MCP 调用可再次启动。 |
| `npm run update` | 备份数据库并更新。 |
| `npm run uninstall` | 移除集成，保留学习数据和源码。 |

第一版是本机单用户应用，未验证 macOS/Linux，不含手机同步或多人账户。

[学习与复习规则](docs/learning.md) · [架构与开发](docs/architecture.md) · [MIT License](LICENSE)
