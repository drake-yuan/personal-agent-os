# Personal Agent OS — 开源发布行动手册（Playbook）

> 回答的问题是：**这个项目如何真正开源出去，而不是「把代码传上去」。**
> 上游依据：《Personal Agent OS 详细设计落地文档 V2.0》§19（开源发布策略）+ §20（G0–G4 门）+ §18.3（数据隔离）。

---

## 0. 一句话结论

**先过门，再发布。** 开源不是把 `code/` 推到 GitHub 那一刻，而是「陌生人能在 30 分钟内、无密钥、无陪访跑通第一条任务闭环，且跑的过程中没有任何个人数据出库」。按设计文档的五阶段门（G0–G4）逐关验收，任何一门不过就停在原地修门。

---

## 1. 发布前硬门（来自设计 §20，全部 MUST）

| 门 | 内容 | 当前状态（2026-10-25） |
|---|---|---|
| **G0** | 核心状态/风险/契约无双重定义；每项不变量有测试；空库建库 + v1 fixture 迁移 + 重跑安全 + 失败可回滚 | ✅ 已过：enums 单一生成源 + drift check；22 表基线 + 迁移账本 + 幂等重跑 + 校验和拒绝；137 测试 |
| **G1** | 无密钥 Demo 端到端；强制杀进程 + 断网可恢复；任务不因 Agent 声称完成而自动完成；越权 API/路径测试通过 | ✅ 已过：DemoAdapter fixture 闭环；outbox 五故障注入；done 仅 Verifier 可写；snapshot 越界检测 |
| **G2** | 一个本地 CLI Adapter 的 probe/plan/dispatch/stream/cancel/reconcile/mapResult + 参数按本机实测 | ⚠️ 部分：接口与 Demo 实现已落；**真实 CLI 适配器（codex/claude-code）待本机 probe 实测** |
| **G3** | WorkBuddy PoC：OAuth 审核、真机链路、凭证不泄露、出站预览、超时不重复创建 | ⬜ 未过（依赖应用审核，G0 硬门；handoff 为兜底） |
| **G4** | README 首屏权限模型/平台/Adapter 状态/限制；安全 checklist；3–5 人无陪同试用；发布件可备份/恢复/升级/诊断 | ⬜ 未过（README 已按 §19.1 写；试用未做） |

**止损条件（设计 §20）：** G1 未过（本人或试用者不愿每日使用）暂停后续，先修操作层。

---

## 2. 仓库治理配置（已完成）

| 文件 | 作用 |
|---|---|
| `LICENSE` | Apache-2.0（ADR D12：专利授权明确） |
| `README.md` | 首屏定位陈述 + 权限模型 + 支持平台 + Adapter 实际状态 + 已知限制 + 不支持能力（评审 §9 阶段 4） |
| `SECURITY.md` | 漏洞报告流程 + 诚实边界（v0.1 不是沙箱）+ 威胁/缓解对照表 |
| `CONTRIBUTING.md` | 七条 ground rules + PR checklist + good first issues |
| `.github/workflows/ci.yml` | `build → test → typecheck → drift:check → evals:deterministic → sqlite 版本断言 → gitleaks secret 扫描 → pnpm audit` |
| `.gitignore` | `data/`、`dist/`、`.env*`、`*.pem/key`、`installation.secret` 全量忽略（设计 §18.3：公开仓库零个人数据） |
| `demo/` | 只用合成数据（Alex Chen / Acme / Project Aurora） |

---

## 3. 数据隔离三闸（设计 §18.3，发布前逐条过）

1. **gitignore 闸**：`me/`、`data/`、任何真实资产路径不进版本库。
2. **secret 扫描闸**：CI 每次 PR 跑 gitleaks；本地提交前也跑一次。
3. **合成数据闸**：`demo/`、fixtures、evals cases 只允许虚构实体；提交前人工过一遍 `git diff --cached`。

---

## 4. 冷启动与首发 UX（设计 §19.3）

首体验只走通**一条**闭环：`npx paos init` 四问初始化 → `paos demo`（无密钥 fixture）→ `paos adapter doctor` → 第一个真实任务全程 UI 引导。其余视图空态 + 导航，不一次上线七个复杂页面。

**试用纪律**：找 3–5 位未参与开发的用户，记录阻塞点与完成时长；改进依据是「首次成功完成的任务」，不是页面数量或 Star 数。

---

## 5. 许可证与贡献者治理（设计 §19.2）

- Apache-2.0；**接受外部贡献前先明确 CLA 策略，不事后改规则**（当前 README 已如实标注「CLA 待定，规则不会追溯修改」）。
- 贡献入口：`good first issue`（manifest / evals case / Domain Pack 模板）；Discussions 先行；ADR 公开可评论。

---

## 6. 真实性纪律（设计 §19.4，README 同款）

必须持续标注的内容：
- 适配器参数是 2026-10 文档快照，按本机已装版本实测后才可去掉 `[未验证]` 标签；
- WorkBuddy OAuth 需审核且 G3 前未实测；
- Evals 指标不证明「Agent 变聪明」；
- 项目未经大规模社区验证；
- v0.1 无 OS 级沙箱。

**把局限写清楚是信任策略的一部分，不是谦虚。**

---

## 7. 发布路线图（建议节奏）

| 周 | 动作 | 出口标准 |
|---|---|---|
| W+1 | 真实 CLI 适配器 probe 实测（codex/claude-code 本机参数）→ 关 G2 | 七种场景（成功/非零退出/超时/取消/输出格式错/权限拒绝/scope 违规）有可重现测试 |
| W+2 | ADR 逐票批准（设计 §4 的 28 条 proposed → accepted） | `docs/50_决策日志/` 有对应票记 |
| W+3 | 安全测试套件落地（注入/越界/凭证扫描/CSRF/供应链/恶意 manifest） | G4 checklist 全绿 |
| W+4 | 3–5 人无陪同试用 + 修复阻塞 | 试用者独立跑通 Demo |
| W+5 | 打 tag v0.1.0，发布；同步 workbuddy-mcp 路线图 | 发布件可备份、恢复、升级、诊断 |

---

## 8. 仓库位置与命名

- 公开仓库名：`personal-agent-os`（设计 §18.1）
- 当前工程根：`D:\Personal Agent OS\code\`（git 已初始化；个人 docs/assets 在库外，零个人数据入库）
- 后续可拆出的公开子仓（可选，不阻塞主线）：`paos-schemas`（paos:// schema 仓库）、`paos-domain-packs`（领域包模板）
