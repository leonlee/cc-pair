# cc-pair

[English](README.md) | 中文

`pair` 让 Claude Code 和 Codex 互相审查代码，也可以自己审自己：Claude 审 Claude，Codex 审 Codex。
一个 agent 负责写（作者），另一个负责审（审查者），双方通过共享目录里的文件交换消息，角色对等。

- **自动模式**：`pair start` 打开作者会话，每一轮审查自动启动审查者，审查结果直接返回给作者。
- **手动模式**：两个 agent 都由你自己启动，Codex 由 MCP 服务唤醒，不需要轮询。

本文是英文 README 的精简版。完整说明以英文版为准，协议、存储结构和已知限制见 [DESIGN.md](DESIGN.md)。

## 特性

- **两种模式**：自动模式（[§3](#3-自动模式)）和手动模式（[§5](#5-手动模式)）。
- **任意组合**：默认跨厂商互审，也支持同厂商互审，以及 `alice`、`bob` 这样的自定义参与者（[§4](#4-参与者)）。
- **代码审查**：带编号和严重程度的问题列表，结论为 `approve` 或 `changes`；超过轮数上限仍未解决的问题升级给你处理。
- **方案审查**：任何格式的计划或设计文档；之后的代码审查可以引用已批准的方案。
- **头脑风暴**：在还没有设计时先讨论思路，轮数固定，最后给出选项和待决定事项。
- **并行工作**：子代理在各自的 worktree 里各跑一套审查流程，最多同时 N 个审查。
- **随时调整审查者**：`pair reviewer` 不用重启就能更换审查者的模型或 effort。
- **Worktree**：每个 worktree 一个独立通道，多组 pair 可以并行。
- **可恢复**：作者对话可续接；审查失败时请求留在磁盘上可重试；有历史记录和重置功能。
- **安全护栏**：审查者按说明只读，pair 不放宽任何权限，作者也不能挑选审查自己的模型（[§11](#11-安全)）。
- **小巧**：一个没有运行时依赖的 Node CLI。agent 通过 Claude skill 和 `AGENTS.md` 里的一段说明学会用法，你用自然语言吩咐即可。

手动模式下，一个审查线程大致是这样（自动模式下，审查者由 pair 每轮自动启动）：

```
终端 A：claude                              终端 B：codex（"be my reviewer"）
  完成任务
  pair send request ──▶ ~/.pair/<repo>-<hash>/claude-to-codex/<thread>/001-request.md
  pair wait  ⏳                              pair wait ◀── 收到请求
                    002-review.md ◀── pair send review --verdict changes
  核对问题，修复
  pair send response ──▶ 003-response.md
  pair wait  ⏳                              pair wait ◀── 复查修复
                    004-review.md ◀── pair send review --verdict approve
  完成 ✓
```

## 1. 术语

- **通道（channel）**：目录 `~/.pair/<repo>-<hash>/`（设置了 `$PAIR_HOME` 时在其下）。每个 git worktree 有自己的通道。
- **参与者（participant）**：pair 一方的名字，如 `claude`、`codex`、`alice`。用哪个 CLI 运行由会话决定，与名字无关。
- **方向（lane）**：两个参与者之间的一个方向，如 `claude-to-codex/`。
- **线程（thread）**：一个方向里的一次交流，由编号消息组成：`request`，然后 `review` 和 `response` 交替。审查者批准即结束；超过 `PAIR_MAX_ROUNDS` 轮（默认 3）仍有未解决的问题，就**升级**（escalated），双方停下来问你。头脑风暴以 **completed** 结束。
- **自动会话（auto session）**：一次 `pair start`，包括交互式的作者、每轮启动的审查者，以及监管它们的进程。

## 2. 安装与设置

```sh
npm install -g claude-codex-pair     # 需要 Node 22 或更高版本，安装 `pair` 命令
```

手动模式下，两个 agent 的沙箱都必须能写通道根目录。`pair init` 会打印带你实际路径的配置片段，默认路径下是：

```toml
# ~/.codex/config.toml
[sandbox_workspace_write]
writable_roots = ["/Users/you/.pair"]
```

```jsonc
// ~/.claude/settings.json
"sandbox": { "filesystem": { "allowWrite": ["~/.pair"] } }
```

自动模式不需要这些设置：`pair start` 只授权每个会话写它自己的通道。

agent 通过 worktree 里的说明文件学会 pair：Claude Code 读 `.claude/skills/pair/SKILL.md`，Codex 读 `AGENTS.md` 里标记过的一段。`pair start` 会在缺少时写入；手动模式需要在每个 worktree 里运行一次 `pair init`。

## 3. 自动模式

自动模式支持 macOS 和 Linux。用到的 CLI 必须已安装并登录，`pair start` 必须在你自己的终端里运行（不能在 agent 会话里）。Windows 或想自己运行两个 agent 时，用[手动模式](#5-手动模式)。

```sh
pair start claude          # 交互式 Claude，自动启动 Codex 审查者
pair start codex           # 交互式 Codex，自动启动 Claude 审查者
pair start claude claude   # Claude 审 Claude（审查者名为 claude_reviewer）
```

第一个词是作者的 CLI，第二个是审查者的（默认是另一个）。

**引导式启动**：在终端里直接运行 `pair start`（不带 CLI）会依次提问：

1. 是否续接这个 checkout 上次记录的对话（有记录时才问，回车即续接）。续接会沿用当时的 CLI、名字等设置，并显示审查者的模型和 effort：回车保留，输入 `n` 重新选择。
2. 作者和审查者的 CLI；
3. 在哪里运行：当前 checkout，或一个 `--worktree` 分支名；
4. 审查者的模型和 effort。模型菜单列出 Claude 的别名或 Codex 自带的模型列表，也可以输入任意模型 ID。

每个问题回车取默认值。命令行上已经给出的选项优先，不再提问。随后打印它选定的命令，例如 `pair: command: pair start claude --worktree feat`。

**启动摘要**：在创建 worktree、写文件或启动 agent 之前，`pair start` 先显示要做什么，等你确认：

```
pair: start auto mode in /Users/you/your-repo-feat (new worktree, branch feat); pair init runs there if its branch lacks the instructions
pair:   author claude · session 3f6c2a1e-5b7d-4c1f-9a2e-0d8b4e6f1a73 (new)
pair:   reviewer codex · model CLI default · effort CLI default
pair:   review time limit 1800s per round · reviewer launches no limit
Start? [Y/n]
```

回车开始；其他输入、Ctrl-C 或输入结束都会取消。`-y` 不等待直接开始。

之后像平常一样给作者布置任务。作者每次发出请求或回复，pair 就启动审查者跑一轮，审查结果直接返回给作者的 `pair send`。

### 3.1. 选项

| 选项 | 默认 | 含义 |
|---|---|---|
| `--as NAME`、`--reviewer NAME` | CLI 名 | 参与者名字（[§4](#4-参与者)） |
| `--worktree NAME` | 当前 worktree | 在 `../<repo>-NAME` 运行（[§7](#7-worktree)） |
| `--resume` | 新对话 | 续接这个 worktree 上次记录的作者对话 |
| `--reviewer-model MODEL` | CLI 默认 | 审查者模型 ID 或别名（Codex 区分大小写） |
| `--reviewer-effort LEVEL` | CLI 默认 | Codex：`none` `minimal` `low` `medium` `high` `xhigh` `max` `ultra`；Claude：`low` `medium` `high` `xhigh` `max` `ultracode` |
| `-- ARGS...` | 无 | 传给交互式作者的选项 |

高级选项：

| 选项 | 默认 | 含义 |
|---|---|---|
| `-y`、`--yes` | 等待回车 | 不等待直接开始 |
| `--reviewer-args="ARGS"` | 无 | 传给审查者的更多选项（必须用 `=` 写法） |
| `--serve-worktrees` | 关 | 同时审查子代理各自的 worktree（[§6.3](#63-并行工作)） |
| `--reviewers N` | 1（最多 8） | 同时进行的审查轮数，需配合 `--serve-worktrees` |
| `--claude PATH`、`--codex PATH` | `PATH` 上第一个 | 各 CLI 的绝对路径 |
| `--timeout SECONDS` | 1800（最多 86400） | 每轮审查的时限，不计系统睡眠时间 |
| `--max-reviews N` | 0（不限） | 本次运行允许启动审查者的次数，含重试 |
| `--grace SECONDS` | 2（最多 30） | 终止与强制终止之间的等待 |

```sh
pair start claude --worktree feature/login --reviewer-effort high -- --model opus
pair start claude --worktree feature/login --resume
```

`--` 之后和 `--reviewer-args` 里只接受白名单内的选项，凡是会改变审查者工具、权限或沙箱的选项一律拒绝。完整列表见英文版 [§3.2](README.md#32-forwarded-arguments)。

### 3.2. 作者对话

| 要续接 | Claude 作者 | Codex 作者 |
|---|---|---|
| 指定的对话 | `pair start claude -- --resume <id>` | `pair start codex -- resume <id>` |
| worktree 里最新的对话 | `pair start claude -- --continue` | 不支持 |
| pair 上次为这个 worktree 记录的对话 | `pair start claude --resume` | `pair start codex --resume` |

pair 会为每个 worktree 记录作者的对话 ID。`pair status` 和 `pair stop` 会显示这个 ID，以及一条在该 worktree 里续接它的重启命令。

带 CLI 的 `pair start claude --resume` 只续接对话，审查者等其他设置取自这次的命令行（没写就用默认值）。要连同记录下来的设置（包括 `pair reviewer` 保存的审查者设置）一起续接，就直接运行 `pair start`（引导式），或者用那条重启命令。

### 3.3. 控制与恢复

在会话所在的 worktree 里，另开一个终端：

```sh
pair status          # 各方向状态、正在进行和上一轮审查、作者对话、日志
pair status --json   # 同上，供脚本使用
pair ps -v           # 按 worktree 列出 pair 的进程
pair reviewer        # 修改审查者的模型、effort 或时限
pair stop            # 停止作者、审查者及其工具
```

- 一个 worktree 同时只能有一个启动器。
- 审查者启动失败、没给结论就退出或超时，请求都会留在磁盘上；作者用 `pair wait --as <作者>` 重试。如果报错显示重试也没用（内容被拒、未登录、额度用完），作者会直接来问你，不会白白再启动一次。
- `pair status` 显示正在进行的一轮和上一轮的结果，以及审查者用了多少 token（从 CLI 自己的会话文件读取；Claude 这一轮如果压缩过上下文，则不显示）。启动前设置 `PAIR_BELL=1`，每轮结束时终端会响铃。
- 退出作者会停止它管理的所有进程。

### 3.4. 修改审查者

`pair reviewer` 不用重启就能修改审查者设置。必须在你自己的终端里运行，作者和审查者都不能运行，所以谁都不能挑选评判自己的模型。

```sh
pair reviewer --reviewer-model gpt-6.1-sol --reviewer-effort high   # 之后新开的线程
pair reviewer --reviewer-effort default                             # 恢复 CLI 默认
pair reviewer --thread current --reviewer-model gpt-6.1-sol         # 审查失败的那个线程
pair reviewer --timeout 3600                                        # 从下一轮起的每轮时限
pair reviewer --max-reviews 20                                      # 本次运行允许的启动次数，0 为不限
```

- 一个线程沿用它第一轮的设置，所以普通修改只影响新线程。
- `--thread` 只用于最后一轮失败了的线程（比如模型名写错了），改完让作者重试即可。已经结束的线程不会再审查；如果它就是这个 worktree 最近一轮审查的线程，`pair status` 会标上 `finished`。
- 设成和原来一样的值时，会显示 `unchanged`。
- 会话没在运行时，修改会保存到这个 worktree 上次对话的记录里，下次续接（直接 `pair start` 或重启命令，见 [§3.2](#32-作者对话)）就会用新设置。

## 4. 参与者

一组 pair 有两个参与者：一个写，一个审。默认名字是 `claude` 和 `codex`，互为搭档。名字由小写字母、数字和下划线组成，以字母开头，最长 32 个字符。

**自动模式**：`pair start` 后面的词选 CLI，`--as` 和 `--reviewer` 选名字。

| 命令 | 作者 | 审查者 |
|---|---|---|
| `pair start claude` | claude（Claude） | codex（Codex） |
| `pair start codex codex` | codex（Codex） | codex_reviewer（Codex） |
| `pair start claude --as alice` | alice（Claude） | codex（Codex） |
| `pair start claude claude --as alice --reviewer bob` | alice（Claude） | bob（Claude） |

**手动模式**：启动 agent 时设置名字和搭档：

```sh
PAIR_AGENT=alice PAIR_PARTNER=bob claude     # 终端 A：作者
PAIR_AGENT=bob PAIR_PARTNER=alice claude     # 终端 B："be my reviewer"
```

Codex 的命令可能在它的后台服务里运行，看不到终端的环境变量，所以要用配置传入：

```sh
codex -c 'shell_environment_policy.set.PAIR_AGENT="alice"' -c 'shell_environment_policy.set.PAIR_PARTNER="bob"'
```

也可以直接告诉 agent：“你是 bob，你的搭档是 alice”。

## 5. 手动模式

先运行 `pair init`，然后在同一个 worktree 的两个终端里分别启动 Claude Code 和 Codex。

1. 在审查者的终端里说 **“be my reviewer”**。
2. 在作者的终端里完成任务后说 **“ask codex for a review”**（或 “ask claude”，或搭档的名字）。
3. 作者逐条核对问题，修复或说明理由驳回，然后回复。
4. 线程在批准或升级时结束。

### 5.1. 唤醒 Codex

Codex 不会轮询（每次检查都要调用一次模型），而是由 pair 的 MCP 服务在有消息时唤醒。注册一次即可，`pair init` 会打印带你实际路径的命令：

```sh
codex mcp add --env 'PAIR_CODEX=/opt/homebrew/bin/codex' pair -- '/path/to/node_modules/claude-codex-pair/dist/pair.js' mcp
```

之后 Codex 会运行 `pair register` 并调用 `pair_listen` 工具来等待。说 “stop as reviewer”（或 `pair unregister`）即停止唤醒。细节见英文版 [§5.1](README.md#51-waking-codex)。

## 6. 工作流

用自己的话吩咐作者，pair 命令由它来运行。在 Claude Code 里，`/pair <请求>` 会显式加载 pair 的说明。

| 对作者说 | 审查者做什么 | 线程何时结束 |
|---|---|---|
| “ask codex for a review” | 列出问题和严重程度：`approve` 或 `changes` | 批准，或 `PAIR_MAX_ROUNDS` 轮后升级 |
| “ask codex to review the plan in docs/plan.md” | 审查文档：`approve` 或 `changes` | 同上 |
| “brainstorm with codex how to …” | 提出选项和问题：`continue` 或 `complete` | 完成，最迟在最后一轮 |
| “每个 PR 用一个子代理，各在自己的 worktree” （需 `--serve-worktrees`） | 审查每个子代理的 worktree，最多同时 `--reviewers N` 个 | 每个子代理各自结束 |

较大的改动可以串起来：先头脑风暴方案，再写计划并审查，最后实现，并在代码审查里引用方案审查。

### 6.1. 方案审查

计划、设计文档可以是任何格式（Markdown 计划、OpenSpec change、ADR）。请求里写明文档路径和所在的提交；格式自带校验工具的（如 `openspec validate`），先跑一遍并附上结果。审查者检查的是文档本身：需求是否含糊或矛盾、是否遗漏边界情况、验收标准能否测试、范围是否合适。批准只针对这一版文档。

实现时，代码审查请求用 `## Spec` 一节引用它：

```
## Spec
Thread 2026-11-06T05-19-31-945Z-da0bac (pair history da0bac).
docs/plan.md, approved at abc1234; unchanged since.
```

### 6.2. 头脑风暴

适合还没有设计时讨论思路。作者用 `pair send request --brainstorm` 发起，写明问题、约束和已决定的事；第一条消息可以先不写自己的方案，以获得独立的想法。审查者每轮给出选项、权衡和问题，结论为 `continue` 或 `complete`。共 `PAIR_MAX_ROUNDS` 轮（默认 3），最后一轮必须 `complete`，并给出考虑过的选项、推荐和待决定事项。头脑风暴不会升级。

### 6.3. 并行工作

作者可以把工作分给子代理：

- **一个改动，多个子代理**：只有作者运行 pair。子代理只交回改动和验证结果，作者整合后再请求审查整体改动。
- **多个 PR，依次审查**：作者在会话的 worktree 里逐个切换分支，审完一个再审下一个。
- **多个 PR，并行审查**：每个 PR 一个 `pair start --worktree NAME` 会话，或者用一个会话服务所有子代理的 worktree：

```sh
pair start claude --serve-worktrees --reviewers 2
```

各个 worktree 的审查共用一个先到先服务的队列，最多同时 N 个；一个 worktree 失败不影响其他。pair 不会在被服务的 worktree 里写任何文件，也不会创建、合并或删除 worktree。分开批准的几部分，合并后仍要审查整体结果。

## 7. Worktree

每个 worktree 有自己的通道，不同 worktree 里的 pair 互不干扰。作者和审查者必须在同一个 worktree 里运行。

自动模式下，`--worktree NAME` 在 `../<repo>-NAME` 运行（斜杠变成短横线）：

- 路径不存在时，pair 用 `git worktree add` 在分支 `NAME` 上创建它：已有本地分支就检出，只在远端有就跟踪远端，否则从 `HEAD` 新建。
- 路径已存在时，必须是这个仓库的 worktree；pair 不会切换它检出的分支。
- worktree 缺少说明文件时，pair 在那里运行 `pair init`。
- 会话结束后 worktree 保留，用 `git worktree remove` 删除。

手动模式下，在 worktree 里启动两个 agent：

```sh
git worktree add ../your-repo-feature -b feature/x
cd ../your-repo-feature
pair init
```

## 8. 命令

agent 运行 `send` 和 `wait`；你通常用 `start`、`stop`、`status`、`reviewer`、`history` 和 `upgrade`。`pair help <命令>` 查看每个命令的说明。

```
pair start [AUTHOR_CLI [REVIEWER_CLI]] [--as NAME] [--reviewer NAME] [options] [-- AUTHOR_ARGS...]
pair stop
pair reviewer [--reviewer-model MODEL|default] [--reviewer-effort LEVEL|default] [--thread current|ID]
pair reviewer --timeout SECONDS
pair send <request|review|response> --as NAME [--to NAME] [--brainstorm] [--verdict VERDICT] <file|->
pair wait --as NAME [--timeout seconds]
pair status
pair history [thread-id]
pair clean --keep N
pair reset [--as NAME] [--dry-run]
pair init | uninit | upgrade
pair register | unregister [--as NAME]
pair mcp
pair ps [-v]
pair help [command]
```

`pair status` 的输出示例：

```
channel: /Users/you/.pair/your-repo-12345678
worktree: /Users/you/your-repo
version: claude-codex-pair 0.10.0
claude-to-codex: idle
codex-to-claude: idle
instructions on disk (does not verify what running agents loaded):
  AGENTS.md (pair section): current
  .claude/skills/pair/SKILL.md: current
codex notifications: no session registered
auto mode: claude author, codex reviewer · idle · owner 41820 · pair 0.10.0
  author session: 3f6c2a1e-5b7d-4c1f-9a2e-0d8b4e6f1a73 (resumed)
  reviewer for new threads: model gpt-6.1-sol · effort high
  last round: thread 2026-11-06T05-19-31-945Z-da0bac · verdict approve · finished 14:57:39, took 2m7s · tokens 545.1K in (85% cached), 3.8K out
  log: /Users/you/.local/state/pair/your-repo-12345678/auto.log
```

说明文件的状态有 `current`、`stale`、`missing`、`unreadable`、`newer`（由更新的 pair 写入）。`missing` 或 `stale` 时运行 `pair init`，然后重新加载 agent。

## 9. 维护

### 9.1. 重置

`pair reset` 把整个方向移到 `<channel>/resets/<reset-id>/`，用来清理卡住的请求：

```sh
pair reset --dry-run      # 预览
pair reset                # 所有方向
pair reset --as claude    # 只重置 claude 发起的方向
```

自动会话运行时会拒绝重置（`--dry-run` 除外）。

### 9.2. 升级

在你自己的终端里运行 `pair upgrade`：安装最新版本，并刷新当前 worktree 的说明文件。之后重启 Claude Code 和 Codex。

`pair start` 也会帮你升级：

- 有新版本时显示提示。设置 `PAIR_AUTO_UPGRADE=1` 后，会先用 npm 安装新版本，再用新版本执行同一条命令；安装失败就用当前版本照常启动。npm 检查每天最多一次，设置 `PAIR_NO_UPDATE_CHECK` 时不检查。
- 启动 agent 之前，刷新由旧版本 pair 写的说明文件。
- 如果这个 worktree 里正在运行的会话用的是旧代码（更旧的版本，或同一版本的另一个构建），`pair start` 会问是否停掉它，再用当前版本启动，必须输入 `y` 才会停。直接运行 `pair start` 还会提议续接那个对话。`pair status` 和 `pair ps` 会显示每个会话的 pair 版本。

### 9.3. 卸载

在每个 worktree 里运行 `pair uninit`（加 `--purge` 同时删除消息历史和自动模式的状态），然后：

```sh
codex mcp remove pair
npm uninstall -g claude-codex-pair
```

并从沙箱设置里删除 `~/.pair`。

## 10. 环境变量

| 变量 | 默认 | 含义 |
|---|---|---|
| `PAIR_HOME` | `~/.pair` | 通道根目录 |
| `PAIR_AGENT` | 无 | 你的参与者名字，即 `--as` 的默认值 |
| `PAIR_PARTNER` | 默认搭档 | 不带 `--to` 时新请求发给谁 |
| `PAIR_MAX_ROUNDS` | `3` | 升级前的审查轮数；头脑风暴的轮数 |
| `PAIR_KEEP` | `100` | 保留多少个已结束的线程；`all` 全部保留 |
| `PAIR_NO_UPDATE_CHECK` | 未设置 | 任意值：关闭 npm 版本检查 |
| `PAIR_AUTO_UPGRADE` | 未设置 | 任意值：`pair start` 先安装新版本（需要 npm 版本检查） |
| `PAIR_BELL` | 未设置 | 任意值：每轮审查结束时终端响铃 |
| `PAIR_AUTO_SOCKET_DIR` | `/tmp/pair-auto-<uid>` | 自动模式 socket 所在的私有目录，路径要短 |

Codex 需要通过 `-c 'shell_environment_policy.set.NAME="value"'` 设置这些变量；`pair start` 会替它启动的 agent 设置好。

## 11. 安全

- **审查者受限**：Codex 审查者在 `workspace-write` 沙箱中运行，按说明不得修改源码；Claude 审查者以 `dontAsk` 模式运行，只能读取、搜索和运行几个 pair 命令。两者都不会加载仓库自带的 agent 配置（如 `.claude/settings.json`、`.codex/config.toml`），以免某个分支借此运行钩子或 MCP 服务。
- **不放宽权限**：自动模式不会给审查者传权限绕过类选项，`--reviewer-args` 也不能改变它们的工具、权限或沙箱。
- **只授权自己的通道**：自动模式下，每个 agent 只能写自己的通道。例外是 `--serve-worktrees`：作者被授权写整个通道根目录（`$PAIR_HOME`，通常是 `~/.pair`），因为子代理要写各自 worktree 的通道。手动模式需要的全局授权同样覆盖所有仓库的通道。
- **终端输出转义**：`pair wait`、`history`、`status` 输出到终端时，会转义 agent 写入的控制字符。
- **文件安全**：pair 只读取通道和 worktree 里的普通文件，限制大小，不跟随末端符号链接；说明文件只在 worktree 内、`.git` 之外读写。
- **进程**：pair 从不按保存的 PID 或按程序名发信号。

这些措施防的是失误和一般的提示注入，不是蓄意的 agent。完整说明和已知限制见英文版 [§11](README.md#11-security-considerations)。

## 附录：审查示例

真实运行的消息（已缩短），第 1 轮的 bug 是故意埋的：

```
== pair: review from codex · claude-to-codex · round 1 · verdict changes ==
### F1 [medium] src/paginate.js:8: Partial last pages are omitted from the page count
`totalPages(5, 2)` returns 2 ... Use `Math.ceil(count / pageSize)`.
### F2 [medium] src/paginate.js:2: Invalid pagination inputs produce unrelated items
`paginate([1, 2, 3, 4, 5], 1, -2)` returns `[1, 2, 3]` ...

== pair: review from codex · claude-to-codex · round 2 · verdict approve ==
F1 and F2 are fixed. I re-read src/paginate.js and ran 41 assertions ... All passed.
```
