# TH08 Web — Imperishable Night (vertical slice)

**在线 Demo / Play:** <https://agentmystia.github.io/th08_web/>

《东方永夜抄 ～ Imperishable Night》(TH08) 的浏览器 TypeScript 移植，原作数据驱动：
嵌入的 ECL/ANM/STD/MSG/SHT 二进制由真实解析器与 VM 执行。当前交付物是
**Stage 1 + Stage 2 + Reimu/Yukari Border Team + 原版标题/菜单/UI**，并与 T8RP
replay（`tests/replays/th8_udLy01.rpy`，Lunatic）做 Stage 1/2 收敛对齐。

权威行为/格式文档见 `AGENTS.md`（§0 是 TH08 覆盖层）。本仓库已完全 TH08 化：
TH07 母工程的路径、数据与测试已在垂直切片分支中移除（姊妹工程
[th07_web](https://github.com/AgentMystia/th07_web) 单独发布）。

## 操作 / Controls

| 按键 | 作用 |
|---|---|
| 方向键 | 移动（低速移动时缩小判定点显示） |
| Z / Enter | 射击（确认） |
| X | 灵击/炸弹（返回） |
| Shift | 低速移动（Border Team 切换人间/妖怪形态） |
| Ctrl | 对话快进 |
| Esc | 暂停（返回） |

标题 → 难度 → 队伍（Border Team）→ Stage 1。
`?test=1&difficulty=0..3&menu=1` 等探测参数见 `AGENTS.md §5`。

## 运行 / Run

```bash
npm install
npm run build        # esbuild → dist/th08.js
npx serve .          # 或任意静态服务器打开 index.html
```

## 验证 / Verification

```bash
npm run check        # tsc
npm test             # th08-* + engine-* 测试（node --test）
npm run replay:verify:th08   # Stage 1/2 Lunatic replay 收敛 oracle（fixture 已入库）
npm run verify:fast  # check + build + test + 干净启动
npm run verify:full  # + 像素抽查 + Pages 打包 + 静态启动
```

`replay:verify:th08`（`--stage 1|2`，可加 `--clear-check`）是收敛验收：把录像逐帧
灌入产品 StageScene，与原生下一关卡入场快照逐字段对比（score/power/lives/graze/
pointItems/gauge/clock/RNG 残差）。CI 以 advisory（非阻塞）方式运行它，输出当前
`EARLIEST DIVERGENCE` 作为收敛反馈通道。

## 已知差距 / Known gaps

- **范围**：垂直切片 = Stage 1 + Stage 2 + Border Team。无 Stage 3+/其他
  队伍/全难度完整回归。
- **Replay 收敛**：Stage 1 在 ~f2884、Stage 2 在 ~f1052 处发散（自动炮相位的
  RNG 抽签残差，首个幻影弹着，其余为级联），根因候选与完整分析记录在
  `AGENTS.md` §0 与 `HANDOFF.md`。playable 路径本身（弹幕、对话、HUD、炸弹、
  Boss 呈现）由 th08-* 回归测试与 CI 浏览器启动检查守护。
- 近似项登记在 `AGENTS.md §7`（graze 计步、ghost tint 通道序等）。

## 资产生成 / Regenerating embedded data

需要本地-only 的 `reference/th08-original/`（不入库）：

```bash
npm run extract-assets   # 解包资源图到 assets/th08-img 等
npm run generate-data    # 重建 src/data/th08-data.ts（ECL/ANM/STD/MSG/SHT 嵌入）
npm run generate-bgm     # 切 BGM ogg + loop 表
```

## 结构 / Layout

- `src/game/` — StageScene/EclVm/Player 与 `th08-*.ts`（状态、对话、宣告、炸弹、物品、HUD）
- `src/formats/` — ECL v8 / ANM v3 / STD / MSG / SHT(56B) / T8RP 解析器
- `src/data/th08-data.ts` — 嵌入的原作数据（stage 1 + stage 2）
- `scripts/` — dev-shot/dev-menu/pixel-report/native-trace 等验证工具
- `tests/` — th08-* 回归 + engine-* 引擎钉子 + `tests/replays/th8_udLy01.rpy`

## 原作致谢

Touhou 08 © ZUN / 上海アリス幻樂団。本仓库为学习性移植；运行时不含任何
`reference/` 原作文件。
