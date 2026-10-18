# enchanted-agent-audit

零依赖、**只读**的命令行工具：审计编码 Agent CLI 在你机器上安装并运行了什么。一条命令，对每个检测到的 Agent（Codex CLI、Claude Code、GitHub Copilot CLI、OpenCode）回答四个问题：

1. **常驻守护进程**：会自动启动的服务 / launchd 任务 / 计划任务 / 开机自启项，以及它们如何持久化。
2. **自动更新与版本解耦**：后台更新行为，以及正在运行的后端是否已经和包管理器版本脱钩。
3. **遥测**：能静态读到的端点，以及文档声明的关闭开关（并明确标注"效果未验证"）。
4. **危险默认值**：厂商文档或用户报告的问题，每条附来源链接。

English: [README.md](README.md)

## 它绝不做什么

- 绝不修改、停止、卸载或写入被审计的系统状态。
- 不联网、不需要账号。
- 绝不读取凭据内容（`auth.json`、`service.json`、`.env*`、`*.tokens.json`、密钥文件、`.ssh`、`.aws` 在打开前即被拒绝）。
- 绝不声称观测了网络流量或运行时加载。
- 绝不猜测：无法静态判断的内容标为 `unknown` 并给出原因。

两条独立证据支撑上述承诺：

```bash
npm test                          # 含"源码不含写 API"的静态测试
node scripts/readonly-proof.js    # 审计前后哈希对比
```

## 环境要求

- Node.js **>= 18.13**（本机验证：Windows 10 + Node v24.19.0）。
- 零依赖，无需安装步骤。

## 快速开始

```bash
git clone https://github.com/IsaacHuo/enchanted-agent-audit.git
cd enchanted-agent-audit
node bin/enchanted-agent-audit.js
```

```text
Agent                Installed Daemon          Auto-update  Decoupled  Tel.
-------------------- --------- --------------- ------------ ---------- ----
Codex CLI            yes       1 auto-start    enabled*     yes*       -
Claude Code          traces    none            enabled*     unknown    -
GitHub Copilot CLI   traces    none            unknown      unknown    -
OpenCode             yes       none            enabled*     yes~       -
legend: yes/no = observed on this host; * = vendor-documented default, not measured; ~ = inferred from observed files/processes; unknown = not statically established.
```

完整输出见 [`examples/`](examples/)。

## 参数

| 参数 | 说明 |
| --- | --- |
| `--json` | 完整结构化报告（`enchanted.agent-audit/v1`）。 |
| `--table` | 可读表格（默认）。 |
| `--ci` | 观测到常驻守护进程或已启用的后台自动更新时退出码为 `1`。 |
| `--only <ids>` | 只审计指定 Agent：`codex,claude-code,copilot-cli,opencode`。 |
| `--home <dir>` | 审计替代的主目录。 |
| `--fixture <file>` | 回放已采集的枚举数据，不查询本机；用于确定性 CI 演示。 |
| `--paths raw` | 输出绝对路径，而不是 `~` 相对路径。 |
| `--quiet` | 只输出表格，不输出逐项详情。 |
| `--version`、`--help` | 版本 / 用法。 |

## 置信度与观测方式

每个结论都带两个标签：

- `confidence`：`observed`（本次在本机读到）/ `inferred`（由已观测事实按明确规则推导）/ `documented`（引用外部来源，未在本机测量）/ `unknown`（无法静态判断，`value` 为 `null`）。
- `method`：`file-read` / `dir-enum` / `registry-read` / `process-enum` / `service-enum` / `scheduled-task-enum` / `external-doc` / `not-observed`。

CI 只用 `observed` 值判定。文档声明的默认值不会让构建失败，因为它不能证明被审计机器的实际状态。

详见 [docs/methodology.md](docs/methodology.md)。

## CI 门禁

```bash
node bin/enchanted-agent-audit.js --ci
```

退出码：`0` 干净，`1` 命中门禁，`2` 用法错误，`3` 内部错误。

GitHub Actions / GitLab CI / 通用 shell 的可复制片段见 [docs/ci-gate.md](docs/ci-gate.md)。门禁自测不需要真实安装 Agent：

```bash
node bin/enchanted-agent-audit.js --fixture test/fixtures/codex-daemon/fixture.json --ci   # -> 1
node bin/enchanted-agent-audit.js --fixture test/fixtures/autoupdate-off/fixture.json --ci # -> 0
```

## 支持矩阵

| Agent | 状态 | 说明 |
| --- | --- | --- |
| Codex CLI | 已支持 | 真实 Windows 服务、带版本哈希的整包副本、文档化开关。 |
| Claude Code | 部分支持 | 二进制不在 PATH 时仅有配置痕迹；遥测/更新开关为文档结论，未验证效果。 |
| GitHub Copilot CLI | 部分支持 | 仅配置痕迹；自动更新默认行为无文档，标为 `unknown`。 |
| OpenCode | 已支持 | 多份版本解耦安装、`autoupdate` 配置键、文档化的环境变量绕过。 |

完整矩阵与逐项观测方式：[docs/support-matrix.md](docs/support-matrix.md)。

## 开发

```bash
npm test                          # 32 个测试，全部基于 fixture
npm run examples                  # 由 fixture 重新生成 examples/
npm run readonly-proof            # 运行时只读证明
```

测试不会读取真实主目录，因此在干净的 CI runner 上也可确定性复现。

## 许可证

MIT，见 [LICENSE](LICENSE)。
