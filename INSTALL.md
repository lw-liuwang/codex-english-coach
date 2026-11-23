# 安装与维护

适用于 Windows 和 Node.js 24.x。Codex 收到本页链接及安装请求后，应完成安装和检查，保留已有的无关配置。

## 安装

先确认依赖可用：

```powershell
node --version
npm --version
git --version
codex --version
```

将源码放到独立程序目录，学习数据默认另存于 `%LOCALAPPDATA%\CodexEnglishCoach`：

```powershell
$coachProgramDir = Join-Path $env:LOCALAPPDATA 'Programs\codex-english-coach'
git clone https://github.com/lw-liuwang/codex-english-coach.git $coachProgramDir
Set-Location $coachProgramDir
node scripts/cli.mjs install
```

已有源码时，在对应目录运行 `npm run setup`。已有同名目录时先核对内容，不覆盖其他项目。

安装器依次安装依赖、构建、验证后端、安装 Skill、注册 MCP，最后将托管段加入全局 Codex 指令。Skill 保持隐式启用，新聊天默认遵循学习规则；用户明确要求和适用的任务指令优先。

### 可选参数

```powershell
node scripts/cli.mjs install --codex-home 'D:\CodexHome' --data-dir 'D:\EnglishCoachData' --port 47832
```

| 参数 | 用途 |
| --- | --- |
| `--codex-home` | Codex 配置与 Skill 目录；默认使用 `CODEX_HOME` 环境变量，未设置时为 `~/.codex`。 |
| `--data-dir` | 个人数据目录；默认 `%LOCALAPPDATA%\CodexEnglishCoach`。 |
| `--port` | 本机端口；默认 `47831`。 |
| `--skip-build` | `install/update` 跳过依赖安装和构建，复用已有产物。 |

使用自定义数据目录后，管理命令继续传 `--data-dir`。端口从该目录的安装记录读取，也可通过 `--port` 指定。

## 检查

```powershell
node scripts/cli.mjs doctor
```

打开 [http://127.0.0.1:47831](http://127.0.0.1:47831)；使用自定义端口时替换地址。新数据库没有记录属于正常情况。

重新加载 MCP 或重启 Codex，并在新聊天检查：

1. Skill `codex-english-coach` 和 MCP 工具 `capture_learning` 可用。
2. 一条真实的中英混写消息得到英文说法、中文词汇说明及原任务回应。
3. 主动求助一个真实遇到的英文词句后，网页出现记录。

`doctor` 只检查配置与后端，不能证明当前聊天已加载工具。没有真实学习内容时，不为检查安装而伪造记录。

## 启动与停止

在源码目录运行：

```powershell
npm run start
```

后端只监听 `127.0.0.1`，多个聊天共用。MCP 也可自动启动它。需要停止时运行：

```powershell
npm run stop
```

MCP 仍连接时，后续调用可能再次启动服务。

## 更新

```powershell
npm run update
```

更新先备份数据库，再停止后端、快进拉取源码、构建并重新安装集成。源码有未提交改动或无法快进时会停止，不强制重置。更新后重新加载 Codex 配置。

手动备份完整学习数据时，先断开 MCP、停止后端，再复制整个数据目录，包含待发送队列。只复制运行中的数据库文件可能遗漏 WAL 中的数据。

## 卸载

```powershell
npm run uninstall
```

卸载停止后端，移除本项目的 Skill、MCP 注册和全局托管段，保留数据库、待发送队列、日志及源码。之后重新加载 Codex 配置或关闭旧 MCP 连接。删除个人数据需要另行明确操作。

## 问题处理

- **端口冲突**：用 `--port` 选择空闲端口；不会停止其他程序。
- **待同步**：记录已进入本地队列，后端恢复后补传；尚未确认写入数据库。
- **聊天没有工具**：先运行 `doctor`，再重新加载 MCP 或新开聊天。工具不可用时仍可获得语言帮助，但不能声称记录成功。

日常读写、暂停与复习规则见 [使用说明](docs/learning.md)。
