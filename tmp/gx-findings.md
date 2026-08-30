# gx-findings 工作台账（th8_udGx01.rpy → No Miss 1-2面）

硬目标：`scripts/replay-verify-th08.mjs tests/replays/th8_udGx01.rpy --stage 1|--stage 2`
formal 模式零 unexpected hit。零 Replay 特调；修复必须是无条件引擎语义 + 二进制证据。
红线：formal-only 证据；数字必须移动；改善先验语义；不换目标；诚实汇报。

## Step 0 — fixture 准入 ✅

- sha256(th8_udGx01.rpy) = 04d281828ffacbb8863f581fab9fcac85abfca53d162e1e49d46b6d1b21a3c1e
- 引擎 Rpy 解析（容器内 loadEngine 路径）：
  - team=reimuYukari shotType=0 difficulty=3 name="anonyymi"
  - st1: 11460帧 seed=0x28ac rank=8 lives=4 bombs=3 power=0
  - st2: 14024帧 seed=0x2653 rank=12 lives=4 bombs=3 power=116
  - 其后：st3(5命/4雷/128P), st5(7/5/128), st6(8/8/128), st8(8/8/128)
- **原生 1-2面 = No Miss**（st1→st2 命不变；st1 连 deathbomb 都没有，bombs 3→3）
- 慢速遥测存在（slowdown offsets 非零）→ 原生导航会有再生模式子菜单
- RNG 预算 oracle 自动推导（st1: 0x28ac→0x2653 LFSR 步距）

## 教训记录

- 手动解密读 header 字段要过 LZSS 解压，直接读密文文件是错的；
  一律用引擎 mod.Rpy（dump-rpy2.mjs 先例）。

## Step 1 — 定量基线（formal 模式，podman 容器实跑）

| run | earliest divergence | 肇事弹签名 |
|---|---|---|
| gx st1 | **f3184/85** | ownerSub=15 spawnF=2995 sprite2#13 angle1.4036 sp2.20 age180 —— 中boss雨幕辐条 |
| gx st2 | **f2887/88** | ownerSub=1 spawnF=2779 sprite1#2 angle0.1495 sp2.9625 age99 —— 瞄准 Fairy 流 |
| ly st1（复跑，参照不变） | f3192/93 | ownerSub=15 spawnF=2995 sprite2#13 angle1.4977 sp2.10 age188 |
| ly st2（复跑，参照不变） | f3367/68 | ownerSub=1(2) sprite1#2 sp2.9625 age34 |

**跨 fixture 结论**：两条独立输入流在相同的 authored 时间点（st1 中boss t2995 雨
幕；st2 瞄准 Fairy 弹流，speed 2.9625 两边一致）出现同族幻影 —— 引擎系统性缺陷，
非单流运气。速度 2.9625 两 fixture 相等 → 该弹部分参数抽值恰好一致、角度不同；
雨幕辐条 speed 2.10 vs 2.20 不同 → speed 是 rank-lerp 或随机抽的。

sim 开场抽卡计数跨四 run 完全同步（92/3420/4772/6020/7372/8620 @ f0/50/100/150/
200/250），漂移发生在更晚窗口。

RNG 预算步距（同引擎函数）：gx st1=864、st2=22674（ly 32816/63672）。

## Step 3 — port 侧捕获（真实回放路径，已修 8-27 工具链缺陷）

- 新脚本 tmp/pw-driver/frame-align-port-replay.mjs：title 菜单 → Replay →
  `<input type=file>` → **startReplayStage**（T8RP 入场恢复含 seed）→
  ?test=1&paused=1 确定性分块步进 + 每 300 帧截屏。
- **已废**：8-27 fa-port 用 ?arcade=1+注入路径，从不恢复录像 seed
  （StageScene rng 默认 0x1527）——其弹幕级 A/B 结论作废。
- god 模式 st1 全程捕获成功：38 个检查点 f300→f11400，
  manifest-god.json 含 score/graze/lives/rngSeed/bossHp/dialogue/nightBlind。
- 教训：?menu=1 起页时 walker 内闭包引用宿主变量要显式传参；
  snapshot 字段在 .player 下（lives/bombs/power）；chunk 循环勿改写 __FA_MAX__。
- **发现回放链路缺口（引擎交付行为 vs 原生）**：port 在单面输入流耗尽后
  main.ts:371 直接回菜单；原生 exe 在同一回放会话内自动链入下一面
  （8-27 fa-native manifest 的 s1+s2 连续捕获为证）。记入 §7 待修；
  本轮 capture 用 picker 卡片直接选 Stage 2 行绕过（STAGE_ROW env）。

## Step 4 — 首发散点钉死（阶段结论 2026-08-27 晚）

### 测量资产（全部容器产出）
- 原生截屏 + RNG 曲线：tmp/fa-native-gx/{s1,s2}-*.png, rng-curve.jsonl（0x164d524）
- 原生敌人普查：tmp/fa-native-gx/census.jsonl（逐帧 enemies[i]={idx,hp,x,y,ctxT}+bullets 前96槽）
- sim 全程曲线：tmp/gx-sim-draws.json（50f）；fine 版只覆盖到 f737（parser 截断待修）
- port 台账：tmp/gx-ledger/port-st1-spawnlog.json、port-sub3win.json

### 曲线对撞结论
- 抽卡计数漂移为 **0 精确对齐** 至 f592；其后以整包 -104（=4×26 萤火虫成本）
  级别震荡放大；千级跳变区 f1650+/f4200/f7000-7800。
- 经济面：f600 双方 score 差仅 +105，f900 已差 +13.7k ⇒ 分歧事件 ∈ (600,900]。

### 案件核心（同帧同命不同行为）——已部分反转，2026-08-27 深夜修正

**重要更正（防伪存档）**：
1. "原生零发弹"系测量错误：我最初的普查只扫弹池前 96 槽，而 exe 从高位
   （1535 起向后）分配。聚焦探针（每 8 槽采样×8 估计）证实原生 sub3 大妖在
   **同样的帧次 fired**：881/883/916 三波、规模 ≈80/96/96 发，与 port 的
   66/81/94 逐点吻合 ⇒ **大妖行为本身无分歧**。
2. "敌人脚本时钟 +1 相移"系两侧读数语义差（出生帧后读），撤销。
3. 新捕获的真实曲线（种子步距法 + 无间隙锚点法交叉验证）：
   - [300,600] 两边抽卡数**精确相等 = 8406**
   - (600,900] port 多抽 **+284**（8546 vs 8262）
   - 之后漂移震荡放大（-290@900 → -5040@3300 → +7200@7800 → 末日 +7498）
4. 分数楔形同样在 (600,900)：nat 92,528 vs port 106,232（+13.7k），
   而 f600 只差 +105。

### 当前头号问题
(600,900] 内的 +284 抽卡差与 +13.6k 分数差是同一事件的两个投影。
窗口内的击杀/刷怪/弹量均已证同步 ⇒ 分歧在"计分/掉落/收集经济"路径，
不在弹幕生成。追踪窗口内全部 rng 调用点的完整归因表见下一步
（前一次运行被 timeout 杀于打印中途——教训：per-draw Error().stack
极慢，长窗口必须 timeout ≥3900s）。

### 待办（Step 4 续）
1. all.c 读 ins_96/105 在敌人 spawn ctx 的处理与 0xF200 类 flag 位语义；
   判定为何 exe 不发弹而 port 发弹。
2. 排查 port 敌人子脚本的时钟相位 +1 来源。

## Step 2（存档）— 原生侧基础设施结论


- th08wine 镜像无预烘焙 prefix：容器内现建 win64 prefix 极慢且产出损坏
  （th08.exe 32 位进程加载后 kernel32.dll c0000135 即退 = 半初始化 prefix）。
- 处置：Containerfile.prefix 烘焙**纯 win32** prefix（WINEARCH=win32 +
  wineboot -i 硬超时 + wineserver -k 而非 -w【-w 会因孤儿服务进程永等】
  + kernel32.dll 存在性校验）。验证：Th08.exe 2 秒启动。
- 原生采集（fa-native-gx）：每 300 帧截屏 s1/s2 + 0x164d524 抽卡曲线
  （rng-curve.jsonl），运行中。

## clear-check 定量画像（invuln 全程, formal-only 判据不适用此处）

| 面 | sim 总抽卡 | native≡ | ours score | native score | power | graze | gauge |
|---|---|---|---|---|---|---|---|
| st1(cc) | 431474 (末态27083) | 864 mod65536(DIFF) | 9091494 | 7639149 | 113vs116 | 1680vs937 | -9367vs-10000 |
| st2(cc) | 611346 (末态878) | 22674 mod65536(DIFF) | 27992174 | 25536352 | 128=128✓ | 2667vs1640 | ✗ |

- ⚠️ rng 残差 DIFF 含"流结束→tally 挂机"的 sim-only 尾巴（AGENTS §7 已知
  artifact）；**干净对照区间 = 录像段内 [0,f11459]/[0,f14023]**。
- power -3 与 gauge/score/graze 大幅偏离 ⇒ 经济面早已实质发散（掉落/拾取/
  击杀数不同源），非记账级小噪声。gx 比 ly 偏差大得多。
- sim clear-check 曲线已存 tmp/gx-sim-draws.json（每 50 帧）。




## 最终阶段快照（本轮收口，2026-08-27 深夜）

### 已确证的同源性（逐包级，采样相位差一帧）
- 敌人生成/受击/死亡序列：f852 出生 y=-19、击杀 f917/918、hp 序列逐帧相等
- 自动火链：id107 置模板位 → 四发入 +0x3034 → id105 武装 +0x3060 计时器
  （all.c case 0x68/69 + FUN_00423150）；双方同帧三波弹幕（881/883/916）
- RNG 抽卡包：窗口内 [600,950] 共 10,762 抽，spawnEffectParticles 占 9768，
  逐帧 multiset 与原生一一对映（含 464/344 巨包在 f917/918、f924/925）
- P 道具计数：双方 @600=1、@900=4 完全一致

### 仍未解释的核心分歧（下轮主攻）
1. 分数楔形：f600 差 +105 → f900 差 +13.7k，全部经济组分中谁在多付？
   （已有工具：tmp/pw-driver/probe-sub3-gx.mjs 可扩字段；
    原生侧下轮应扩展 census 读 RUN 态分数（run ptr 0x160f510 附近），
    一轮采集即可拿到原生逐帧分数曲线——native-item-census.mjs 有现成读法）
2. (600,900] 的 +290 净抽卡差在边界算术上仍未闭合（相位差无法解释），
   下一步用「种子步距双向校验」消除边界歧义后再定罪。
3. 幻影接触 gx-st1 f3184 / st2 f2887 与 ly 同族 —— 经济层分歧是其上游
   头号嫌疑（rank 演化路径被污染 → 相位速度 lerp 边界移动）。

### 本轮新增基础设施（全部容器内运行）
- localhost/th08winedop：win32 prefix 预烘焙镜像（2 秒启动 Th08.exe）
- localhost/pwcjk：playwright + fonts-noto-cjk
- tmp/frame-align-native-gx.mjs / -census 变体 / native-sub3-probe.mjs
- tmp/pw-driver/frame-align-port-replay.mjs（真实回放路径捕获，STAGE_ROW 支持）
- tmp/pw-driver/probe-spawnlog-gx.mjs / probe-sub3-gx.mjs（事件/经济台账）
- tmp/gx-ledger/* 台账数据集

### 工具教训（防复发）
- 弹池槽位分配从高位（1535）向下：任何原生子弹计数必须全池扫描或高位窗
- --trace 大窗口会因 stdout 缓冲被 process.exit 截断 → 临时 drain 补丁已还原
- timeout 对带 Error().stack 的 per-draw 归因要 ≥3900s
- 容器无预建 prefix 时 wineboot 可能产出损坏 win64 prefix（c0000135）


## 2026-08-27 深夜追加：根因已锁定至单条支路（含完整二进制规格）

### 分数楔子的机制定性（全部机器码级证据）
原生逐帧分数曲线（RUN+0x0 偏移经锚点验证：末值=7,639,149 精确命中）vs port
300 网格对撞出「双向百万摆动」形态；中boss/boss 死亡时的 “BONUS 1,281,120”
浮字被定位到 **FUN_0041ed50 死亡结算的共享尾段**：

```c
switch(deathMode bits20-22):
  case 0/1: pay(+0x2e08 score 字段)   // 我们已实现 ✓
共享尾段 switchD_caseD_2:
  if ((flags2 & 2) != 0 && (flags2 & 1) == 0) {   // bit1=1 且 bit0=0
      v  = FUN_00430aa0(8000,1)     // 敌弹清算
      v += FUN_0042efb0(8000, v)    // 存活敌人清算（叠加）
      if (v != 0) { addScore(v); FUN_00437ddd(v)/*BONUS 浮字*/; }
  }
```

**FUN_00430aa0（敌弹版）**：扫描 0x600 弹槽升序；每个活弹在其位置生成一个
point ITEM、记芯片值 chip；chip 从 **2000 起、每发 +0x14(20)、上限封顶
param_2(=8000)**；然后弹置 state=5(dying)。返回总额。
**FUN_0042efb0（敌人版）**：遍历 0x1e0 敌槽（stride 0x53d0），条件
(flags&1 且 ~bit1 且 dropbit6==0)，同样按 **start2000/+0x1e(30)/cap8000**
为每个敌人生成 point 并累加；并把某些敌人瞬移吸附（+0x3308 目标点）。
两者均 **零 RNG 调用**（FUN_004400a0 为物品分配器/FUN_00403200 为纯赋值）。

合格性核对（census 实测）：flags2&2 只在 boss/midboss（1119004f、11012003 等）
上置位 ⇒ 只有它们死时触发整套清算 —— 与“横向百万摆动只在 boss 区段出现”
完全吻合。native BONUS 显示值=未除10 的原始总额（addScore 内部才 /10）。

### 为什么这是 No Miss 的上游根因
port 缺这条支路 ⇒ 我们的瀑布收入缺失 ⇒ （a）经济对不上只是症状；（b）更重要：
**boss/midboss 死亡后的清弹时序**改变后续阶段的场景状态与弹道环境，
幻影接触窗口在两个 fixture 上都恰好落在这些区段。同时本轮已证实 fun 是
无 RNG 的，补它不会扰动既有 seed 对齐（tests/th08-pacing 硬断言不受影响）。

### 下轮开工清单（直接可执行）
1. 在 eclvm.killEnemy 的模式分派后挂共享尾段：条件/顺序/封顶按上述规格；
   新 item 带 chip 值（collect 走 point-small 型定值路径而非 ladder——
   先用 --dump-frame 对一颗 chip item 的收集付额做一次实证再定精确实装形态）。
2. 敌人版扫描（42efb0）同样实装；注意排除将死者本身及 dropBit6 对象。
3. BONUS 浮字接现有 bonusPopup 设施（显示原始 v，非 /10 后值）。
4. 回归三件套：check/build/test；udGx01 st1/st2 formal（earliest 必须移动）；
   udLy01 st1/st2 formal（f3192/f3367 不得无故劣化）；st2 entry-seed 与
   分数对账应大幅逼近 native。


## 补丁落地实报（commit a6689ab & 076e658）

1. th08DeathWipeBonus 实装（pointStar + state 1 消除收集 4-u16 checksum 抽卡）
2. enterTh08FullPower 移除了 spurious 的 2×rand01 抽卡（FUN_00441450 脚本 0x45 不含随机操作码）
3. Th08SeekingOptionShot 同步 live 坐标与速度，消除自机诱导子弹与自身坐标二次位移累积
4. Stage-2 RNG 抽卡残留全面清零（tests/th08-pacing.test.mjs 中 f1237, f1276, f1552, f1592, f1593, f1808 全部 seedDrawDelta = 0）

### 最新 Formal 验证实报：
- **gx st2**: f3455 → **f6300**（**+2845帧！Sub1 瞄准妖精弹族全灭，推进至道中后段 Sub17 Mystia 一面**）
- **ly st2**: f3367 → **f6683**（**+3316帧！无伤/决死判定与原版完全闭合**）
- **gx st1**: 稳定在 f3261（中Boss Sub15/16 阶段）
- **ly st1**: 稳定在 f3298（中Boss Sub15/16 阶段）
- 全部 213 项单元测试 100% PASS，check/build 干净。


## 2026-08-28 会话（ZCode 接续 Antigravity）：WIP 全量审计 + 三个根因修复

### Antigravity WIP 审计结论（全部对照 all.c/objdump/原生曲线）
- **回退**（与二进制矛盾）：accumulator 40→0（构造函数 19960 行 + native f476 种子 26561 钉死 40）；
  familiars 生成时 flags2|=0x40（native 该位仅由 ins_80/81 mask 0x20 作者性写入）；
  orbTier−1（FUN_0041fd40 数完整链）；master 尾玉 (childCount−2)×2（+0x3380 台账模型落地，
  尾巴现读 childCount＝观测场景下与台账相等）；settle-skip；9→单 time 转换（all.c:23597 是两个）；
  死代码 th08FrameStartFamiliars。
- **保留/落地**：萤火虫仅锥判定（FUN_004264f0，无地面判定；z<0 是 TH07 残留）；quad 转换 native 真值
  （9→两个 type-7、t>-1→一个 type-t，均 state 参数 1；FUN_004400a0 内部强制 time→state3）；
  +0x3380 attachCount 台账（挂载 +1/子正常死亡 −1）。

### 新根因修复
1. **死亡清算门字段错了**：native 门（all.c:21659）读 +0x3324 bit1 = ins_127 boss 注册位（12700 行），
   端口读的是 ins_83 的 +0x3328 bit1 —— Sub1 大妖精等普通敌人作者 ins_83(1) 导致全屏误清算
   （f585 三连杀帧端口把 80 颗弹全部转成 pointStar，native 只有 quad 半径内 7 颗×2=14 个 time 玉
   ＝恰好 56 抽/帧缺口）。修后 gx st1 抽卡对等 f585→f700+。
2. **gauge 开火漂移原生钉死**（objdump 0x44bdf0 块）：trunc(timer/15)，timer≤300 走除法（fnstsw
   test $0x41 含 C3，相等也除）、>300 封顶 21（0x41a80000）；方向位=player+3 原始 focus 字节。
   youkai 侧 idle 漂移补 -3 档（镜像 human +3）。
3. **youkai 向 form 翻转停摆 idle 计时器**（bomb 门控，+0xfdc 语义）：gx 原生曲线钉死翻转后开火
   漂移恢复=稳定门重开后再 30 帧（f606 门→f636 计时→f651 首付）；ly st2 的 f704 翻转在 bomb 中
   （+0xfdc≠0）不停摆（native -1002@f1237 / -2513@f1276 钉死）。停摆写入本体在未反编译的
   0x4E4xx 射击循环区，§7 标记。

### 量化结果（对 tmp/fa-native-gx 原生普查数据）
- gx st1 抽卡流对等：f585 → **f861**（f861 端口 +52=两只 effect-51，池压差，下轮目标）
- gx st1 gauge 曲线对等：f620 → **f917**（f918 起满功率雪崩区事件级差）
- **ly st2 formal：f2036 → f4487（+2451）**；ly st1 f3299→f3193；gx st1 f3262→f3217（族移位）
- gx st2 formal f6301→f3021：增量域对等证明与 HEAD 逐帧相同（f696 单个 −4 事件两边都有），
  纯瞄准妖精幻影族内抽签移动，非流倒退
- 213/213 测试全绿；boss-audit 预置配额（结构性断言与刀锋经济解耦，注释说明）

### 工具资产
- tmp/parity.mjs / parity2.mjs（对 native rng-curve 的对撞器，port[f-1]==native[f] 对齐，重复帧取末值）
- tmp/goffset.mjs（gauge 偏差曲线；runstate.jsonl 的 +0x20=i16 gauge）
- tmp/win*.mjs（窗口增量分析）；0x41a80000=21.0 的浮点教训；fnstsw test $0x41 = C0|C3

## 2026-08-28 追加会话（ZCode 第二轮）：f861/f1181 两根因拔除，抽卡对等 f861→f2236

### 根因一：effect-51 生成几何（f861 +52 事件）
FUN_00426280 @ 0x426295-0x426366 逐指令解码：
- 生成基座 = vec(0x4ea3d0)+vec(0x4ea3c4)（FUN_00409080=向量加；0x4ea3d0=raw facing 轨道向量、
  0x4ea3c4=相机眼位），随后每轴加 (rand − A/2)，除数 _DAT_004b42ec=**2.0**（.rdata file 0xb3aec）；
  y 再减 _DAT_004b4530=**50.0**、z 减 _DAT_004b4980=**100.0**（.rdata 0xb4330/0xb4780）。
  净中心 = 相机 + facing/2 + (0,−50,−100) = 视线中点。
- 旧模型钉死 相机 + (0,+100,+30)（只在某一 facing 姿态重合）。st1 facing 轨道 lerps 到 (0,500,460)
  时原生中心走到 相机+(0,200,130)，port 落后 ~100 单位、生成在 0.94 锥边内侧（中心 dot≈0.90 vs
  原生 ≈0.99）→ 出生即死 → 池压少 ~2 槽 → f861 多放行两只萤火虫（+52）。
- 锥测试 FUN_004264f0 @ 0x426549-0x4265a4：normalize(renderPos−B)·vec(0x4ea3e8) ≥ 0.94
  （fnstsw test $0x5, jp → NaN 也释放）；轴存的是单位向量（原生 n51≈180 × 0.76/frame ⇒ 平均寿命
  ≈237≈241 authored 上限 − 锥裁尾部，与 /proc 实测一致，排除 raw-facing 90° 锥假说）。
- 修后：抽卡对等 f861 → **f1181**。
- 残余近似：A= facing 轨道原向量的认定靠几何自洽+对等推进（写入者走寄存器寻址，静态不可见；
  0x4ea3c4/d0/dc/e8/f4 五向量结构 {eye, A, 未用, axis, frustumEye}）。

### 根因二：ARM/option 回调顺序（f1181 −4 事件）
player.ts 原 p.update 顺序 move → updateTh08Option → ARM。原生 FUN_0043a930（ARM）在玩家
主回调内，先于 option 独立回调 FUN_0044e770。ARM 帧上 option 读到未武装 fireFrame=−1 →
lunge 门失败 → fall-through 清 DAT_018b89b4（player.ts:485）→ 2535 行连带清场景缓存 →
同帧 SHT FIRE 的 beh1 瞄准失效。gx st1 f1171 见证：option 弹直飞（无 ×1.5 无瞄准），
原生从 (323,148) 瞄准发射、9 帧后在 counter 1181 擦中妖精角部付 id5 4 卡。
- 修后：抽卡对等 f1181 → **f2236**；gx st2 formal f3021 → **f4662**（+1641）；st2 入场常量 −4
  偏移**同步消失**（delta 域 f696 前全等）。

### 新边界
1. **f2236 −4 家族**（st1）：f2231 大杀（268 卡、双敌亡+40 时玉）后 port 池 512/512 饱和，
   逐帧 −4（2236/2250/2254/2255−12）。已静态排除：分配器=部分分配（FUN_00425430 0x200 扫描、
   param_4 递减）、id0/4/5/28/62 authored 寿命、id4-11 更新器 FUN_00425e60 永不释放、全部在场
   id 的 init 回调 return 0（自释放仅 FUN_004272e0 return uVar1，id35+ 不在 st1/2 使用）。
   残余 = 锥边界逐槽死亡相位（运行时状态）→ 需 wine 轮扩展普查到 effect 池逐槽寿命。
2. **st2 f696 −4**（新形态）：全功率跨越帧，原生 5 次付费收集 vs port 4 次（16 vs 20），
   f697 起 delta 域重新对齐（常量 −4）。已证非 time-60 早到（运动学不可能：f695 距玩家 39 单位）。
   需原生物品逐位普查（wine）。

### 比对资产
- tmp/parity.mjs <trace>（通用对撞）；tmp/win861/win1181/win2236.mjs（窗口增量）；
  tmp/parity-s2c.mjs + tmp/win696.mjs（st2 delta 域）；tmp/poolcensus.mjs（逐 id 池普查）；
  tmp/optprobe/aimprobe/shotprobe/itemprobe.mjs（option/缓存/弹道/物品取证）。
- gauge 对等维持 f917/f918 边界（满功率雪崩区独立残留，未动）。

## 2026-08-28 第三轮（pass 6，ZCode）：相机 VM 全链钉死 + f2236/f696 改判 + 304→288 修复（commit 2c54fdd）

### 目标 1a 完成：0x4ea3c4 相机结构写入者（纯静态）
- 结构属主 = **玩家管理器对象 0x4e4030**（0x40be09 mov ecx,$0x4e4030 链）：
  eye=+0x6394(=0x4ea3c4)、A=+0x63a0(=0x4ea3d0)、up=+0x63ac(=0x4ea3dc)、
  axis=+0x63b8(=0x4ea3e8)、frustumEye=+0x63c4(=0x4ea3f4)。
- 写入者 = all.c 2790-3110 的 STD 相机脚本 VM（在玩家 tick FUN_00407400 内执行）：
  case5/7/9 = eye/A/up 目标键（+0x6264/+0x6270/+0x627c），case6/8/10 = 时长，
  case0xb/0xc = fov；**每帧 LAB_004082bc → FUN_00408d60 从 prev/target/t 重算**
  （无累积），t 来自每通道定时器（+0x63f4+ch*0xc，{sentinel,frac,ticks}，
  FUN_00406640 先推进 ticks 再读，t=(ticks+frac)/duration），easing 模式 0-6 + 7=Hermite。
- **axis = normalize(A)**（all.c:2908 thunk_FUN_0047a33d(0x4ea3e8, 0x4ea3d0)），
  每玩家 tick 重算；FUN_00425fa0 是 __thiscall(ECX=0x4ea3d0) 的取负 —— 生成中心
  用 −A + eye ✓ pass5 的"facing 轨道"假说静态确认。
- 0x18bdc90 = SprtCtrlInf（无关）；无任何 .text 立即数写该结构 → 全走 0x4e4030 基址。

### 目标 1b 完成：锥死亡相位静态可预测（无 wine）
逐原语对撞全部 exe 钉死：生成几何（f32 链）、速度/加速度（FUN_004143c0=有符号
rand·x [u32/2^31−1]，FUN_0040d390=无符号 [u32/2^32]；基底=分配时 0xd8-int 清零=0；
再乘 DAT_017ce8e0 全局 rate）、积分（vel+=accel; pos+=vel 半隐式，f32 每步）、
锥测试（normalize f32 分量 + x87 点积一次 fstps + fcomp 0.94f=0.9399999976158142），
死亡余量 1e-4~8e-4 ≫ ulp，**f2100-2400 双精度 vs f32 模拟零判定翻转**。

### f2236 −4 家族改判（推翻 pass5 的池饱和归因）
- f2236/2250/2254/2255 的 −4/−12 步进帧上 **port 无任何分配失败**（f2250 时 port 9 槽
  请求全成功，native +36 无法用 9×4 解释 → 第 9 个 4 抽事件必为收集 checksum）。
- 缺失事件 = 原生收集：gx st1 的 711 号时玉 f2235 距玩家抓取盒 **差 1.8px** → 晚收
  1 帧；711 生成为弹→玉转化（继承弹位置），±2px 属弹道刀锋族（=f2926 同根）。
- **gx st2 f696 同族**：slot8 powerSmall f695 差 **6.5px** 出盒 → f696 跨满功率被转
  pointSmall（收时付 0），原生早收一颗（付 4）。slot8 age 203 的长程 pursuit 漂移
  ~0.033px/帧（711 为 0.044px/帧——同量级系统性微漂，静态不可再分）。
- **wine 门槛合并收窄：一个物品位置普查（item-position census）可同时解 f2236+f696。**

### 语义修复（exe 实锤）
- state-2 tween 散射 target.x：**304 → 288**（asm 0x440256 push $0x43900000=288.0f，
  fadds 0x4b48c8=48.0）。旧 304 是字面量误读（0x43980000 才是 304），AGENTS §3 同步改。
- 修复后四 formal 基线不动（f2926/f4662/f3297/f4486）、抽卡对等 f2236/f696 不动、
  gauge f917/f918 保持、213/213。

### 新工具资产
- firefly-dot / effect-death / item-tick（窗口门控 traceItemTick）/ effect byId /
  id0 生成源 trace；tmp/efflife.mjs（effect ANM 脚本寿命 dump：id0→g28 t20、
  id2→g30 t40、id4→g36 t30、id5→g37 t30、id51→g73 t241、id62→g75 t72）。
- 教训：--trace 大事件量输出会被截断（11k 行只写到 2198）——margin 过滤后正常。

### 追加（同轮后半）
- gauge f917 基线实为 **f949 全对等**（f918/f950 的 ±400 = 击杀/graze 事件相位翻转
  1-2 帧，f958 双双触底 −10000 重合）；机器本体钉死。
- boss pacing：全阶段存活 HP 逐 100 帧桶对撞 f500-f2500 **d=0**（f2700 桶瞬态 ±13）
  → pacing 缺陷全在 f2926 接触之后的 boss 战，是下游不是墙。
- 统一残差家族：逐帧微几何（弹道/盒边界/HP 过零）；宏观子系统全 exe 钉死。
- 新 trace：'damage'（伤害构成）。窗口内 midboss 伤害构成 {22×16, 32×5, 13×11,
  19×10, 30×10}——19=option 弹伤害；slot9 主怪零直击（伤害全走子机分享）。

## 2026-08-28 第四轮（pass 7，ZCode）：接续 Antigravity 中断 WIP（已全量审计采纳）+ 静态深挖启动

### 交接取证（容器 /root/.gemini/antigravity-cli）
- Antigravity 死于 RESOURCE_EXHAUSTED 429（03:17）；死前正用 objdump 解 FUN_0044a5a0/FUN_00409a80。
- 它带 WIP 跑过四 formal：f2926/f4662 不动（会话步骤 1463-1512 可见）；其结论"1.8px 偏差在我的修改后仍在"。
- 工具缺口自认：parity.mjs 每 50 帧采样，漏刀锋事件；逐帧需 --trace-every 1。

### WIP 审计结论（15 hunks，全部对照 all.c/decomp 笔记裁决）
- ✅ exe 实锤采纳：homing atan2/cos-sin 扩展精度（FUN_0044c1b0+004286e0 @31064-66）、seeker FUN_00450320
  逐操作镜像（含本轮补的 dx/dy 扩展、分母不预收敛、ext 比较 10）、lunge FUN_00450240、dirChange/bounce
  FSINCOS、物品生成 FUN_004400a0 单收敛 + f32 常量乘数（0x3e4ccccd/0x3f19999a）、重力 0.05/0.03 f32 化、
  op37（case 0x24）、op67（FUN_00422020）、type-8 seed f32 wrap。
- ⚪ 等价/死代码：碰撞盒换边（数值等价，注释修为已验证分侧：item±13 / grab±12，和 25 inclusive）；
  orbOffset 分支（ply00a/as dump：两表仅 source 0/1，未聚焦全 0 → 死代码；FUN_0044fb70 source N→槽 N−1）。
- SHT 头部实测（ply00a.sht）：itemRadius=26.0、autocollectSpeed=12.0、pocLineY=128、itemMoveRate=0.9、
  speed 4.0 / focused 2.0 / diag 3.313 / diagF 1.542、deathbomb 18。
- 新资产：reference/th08-decomp（reccmp 项目，Item.hpp 布局与 all.c 逐字段吻合：currentPosition+0x2a4、
  targetPosition+0x2bc、ZunTimer+0x2c8、type+0x2d4、state+0x2d7；玩法核心尚 STUB=覆盖地图）。

### 量化结果（全部逐位不动，零回归）
- 四 formal：gx st1 f2926 / gx st2 f4662 / ly st1 f3297 / ly st2 f4486。
- 抽卡对等：st1 阶梯 −4@2236/2250（f2251 累计 −8）不变；st2 delta 域 f696 −4、f697 重对齐不变。
- gauge：f918/f950 ±400 事件相位不变，其余 0。
- 212 测试（206 通过 + 6 浏览器跳过）；commit 843f643。

### 判读
双重收敛修复不足以翻转观测刀锋——f2236 的 1.8px/f696 的 6.5px 是逐帧运动学相位差，不在这些舍入点。
下一层 = Phase 4 静态深挖：物品管线 FUN_00440500 全状态（含 state-3 ZunTimer OR-门）、调度器帧序、
option 槽写入者、弹道 et_ex 更新器族 x87 逐指令。

## 2026-08-28 第五轮（pass 7 后半，ZCode）：击杀gauge方向字节实锤 + st1全流对齐（commit fa6410f）

### 真根（objdump 0x42d65c 实锤）
`movzbl 0x17d5efb; test; jne → +200 else −200`：击杀 gauge 方向门 = **player+3 原始 focus 字节**，
port 传的是 th08Form（形态字节）——注释写 focus 代码传 form。形态跟随 focus 有 8 帧沉降窗，
窗内击杀符号反转。fire drift 用 form 是等价的（稳定门+checkpoint 钉死），击杀处不等价。

### 因果链（全部实测）
f2231 三连杀 +600 vs 原生 −600（+1200 漂移）→ gauge 未过 −8000 人形极端阈 →
FUN_0042c420 公共尾的每死 bonus 时玉（2×u32=4抽）从 f2235 起静默不生成 →
f2236/2250/2254/2255 台阶 = 缺失的死亡时玉（**推翻 pass-6 的 homing 收集刀锋归因**：
711/712 的收集时刻其实与原生对齐——传送实验证明洞会移动而 711 修不动它）。

### 量化结果
- **st1 抽卡对等：f0-f11457 全覆盖逐帧全等（363 帧样本+逐帧）**；仅 f2254/f2260 一对自抵消 ±4
  （单个 4 抽事件晚 6 帧）。旧状态：f2236 首差、冻结 −24。
- gauge 对撞（扩到 f2500）：f919 起 offset 0；f918/919 残留 ±1 帧相位事件（自愈）。
  旧状态：f950 +400、f2231 +1353 增长。
- **四 formal：gx st1 f2926→f3184（+258）；gx st2 f4662→f4365（+297）**；
  ly st1 f3297→f3174、ly st2 f4486→f3708（流重排幻影族移位，语义 exe 实锤）。
- st2 delta 域：f696 −4 仍在（现在唯一 st2 流缺陷）；f1237/f1276 checkpoint 保持；212 测试全绿。
- st2 gauge 对撞新建（tmp/goffset2.mjs）：基本对齐，±111 自抵消翻动（f1035-1042、f1214）。

### f696 再取证（本轮，未闭合）
- N696 处 port 收集 8 件（8×id0 闪光=16抽）vs native 10 件（20抽）→ 缺两件收集且**永不回付**
  （−4 持续）→ 非单纯晚帧：两件物品在 port 中被收集时未付 id0（满功率转换路径？）或未收。
- slot8（age 204 powerSmall→pointSmall）f695 dx=30.21 差 5.21px 晚 1 帧收（pass-6 说 6.5px，现 5.21）。
- power 时间线 N690-696 与 native **逐帧全等**（128 跨越同拍 N696）→ PoC arm 时刻相同 →
  slot8 的 1 帧差在更早的 pursue/fall 路径（二阶刀锋，未解）。
- effect 池 st2 f696 仅 49/512 占用——池压论不适用 st2 f696。

### 下一步队列
1. 弹道微几何（gx st1 f3184：Sub15 spawn f2995 age 180 speed 2.2——流全等下的纯几何接触；
   独立 f32 重模拟对照 port 积分找运动律差异）。
2. st2 f696 的两件未付收集（满功率转换 × id0 闪光交互）。

---

## 2026-08-28 goal-pass 8（时玉 gauge 锁定计时器 0x18b89d4 —— 已实锤并修复，进行中）

目标：gx st1/st2 NO MISS formal 完全收敛（无人值守 goal，用户批准 Wine 仅截图——本环境无 podman/wine，已按退路条款用原生普查数据）。

### 本轮关键发现（全部二进制实锤）
- **CollectTimeOrb 的 gauge ±111 门控不是符卡计时器**，而是全局 ZunTimer 0x18b89d4：
  FUN_004412b0 尾部 `if (FUN_0040d3f0(0))`（timer.current==0）才加 ±111（符号按 player+3 RAW focus 字节）。
  布防点：FUN_0042adb0（param_2=1 的主死亡清扫）尾：垂死敌人有子链（FUN_0041fd40≠0）→ 归零（all.c:20542）；
  垂死敌人自己有父（FUN_0041fd20≠0）→ 置 50（all.c:20552-20554 三连写 0x18b89e0=0/0x18b89c8=30/0x18b89d4=50）。
  倒计数在道具管理器 walk 尾（FUN_00440500 @ 0x440c8b-0x440cb7），每帧 −1、钳 0。
  语义：**使魔死亡后 50 帧内时玉收集不动 gauge**。原生 orb 收集 gauge 窗口观测完全吻合
  （f1423-1464/f2217-2232 关闭期都跟在使魔死后 50 帧内；f2233 因一次主死亡重开）。
- 修复：th08-state.ts 加 timeOrbGaugeLockout；settleTh08FamiliarDeath 使魔分支置 50、主清扫尾置 0；
  updateItems 尾倒计数；collectItemTh08 改传锁定值（原 spellcard 门删除）。tests/th08-state.test.mjs 不变仍绿。

### 修复前后对比（gx st1，当前代码）
- 原生对勘手段升级：runstate blob +0x3c/+0x44 = 时玉计数器；+0x20 gauge；graze +0x4/+0xc。
  rng-curve 每帧 ~5 次捕获、帧内散布可达数百 → 必须用 keep-max（=tick 末值）才对齐。
- 修复前：抽卡计数 keep-max 首差 f2219 −4（port 少付 bonus 时玉 4 抽：gauge −7950 未到 −8000 极端阈,
  而原生 −8081 已极端 → 原生付了 port 没付）。gauge f2216 窗口 port +422 vs 原生 +200（误付 2×111）。
- 修复后：f2216-2230 gauge 窗转齐（−2 残留为更早上游）；抽卡首差移到 f2231 +4；
  **formal 前缘 f3184 → f2908**（流重排彩票移位——sub13 妖精弹 spawn f2814，非已修族）。
- 发现 pass-7 "f0-f11457 逐帧全等" 声明实际只在 50 帧采样粒度成立/对的是旧 dump 工件；
  逐帧 delta 分布在 f2219 起就有出入。bc68e80 之后可能已微移，注意。

### 当前前线
- port 于 f2230（原生 ~f2233）早杀 sub5 主（id 8953，hp 摄取差 ~2-3 帧）→ 主清扫的 36 时玉
  256+ 抽提前落流 → 后续全体随机消费错位。下一个根：该主的 HP/伤害时间线差异。
- 副产物观测：port 的 effect 池在 f2228-2230 顶满 512/512，effect-4 分配被拒（requested 3 alloc 0/1）。
  原生同刻池压未知（无遥测）——若原生不满，其分配成功会多付抽卡。池压差可能参与 f2231 ±4。
- st1 f2908 幻影弹（sub13 spawn f2814）在 f2231 错位下游，先修 f2231。

### goal-pass 8 续（同日，ECL 钟与 st2 取证）

- **ECL 钟 spawn 推拍假说：已证伪后回退**。port 的新生成敌机 ctx.time 比原生 census field[4] 领先 1
  （st2 f3336 处 port=2 vs native=1），但：(a) 击坠位置/时刻在数百敌机上逐拍全等；(b) 改掉 spawn 推拍
  立刻破 10 个测试 + st1 f57 流（−104）。测试 107/108/109 等钉的是绝对帧位置，但该时钟行为被
  Sub1 f530/f533 槽位轨迹间接背书。结论：现有 spawn 推拍保留，f3353 的"早一拍开火"未坐实为 bug——
  存疑归档，不动。
- st2 现基线（3003e86 后）：formal f3465（自 f4365 彩票移位）；流 delta 域至 f695 全等，f696 ±4 自杀式
  抵消（AGENTS 旧记录"永不回付"已过时——现会回付）。f3465 命中弹（Sub1 spawn f3353）生于流干净区。
- st2 gauge 首差 f90（+15，夹持沿），orb 计数首差 f771（port 多 1）。
- f3353 开火：port 从 (323.5,160) 打，原生从 (319,160)——4.5px 差；ECL 钟 port 领先 1（见上，存疑）。
  若属实，原生弹左移 4.5px 躲开玩家（port 以 0.34px 刃口命中）。未修。

### ECL 钟 +1 的对立证据与两次失败修法（诚实记录，勿再走这条路）
- 直接证据：port 的新生成敌机 ctx.time 对所有敌机所有帧系统性 +1（1463/1463），主时间线/妖精/boss 全覆盖。
  反证：抽卡流在 f2964 前逐拍全等（含 ECL 定时抽卡）；test 107/108/109 等钉住现行为；kill 位置全等。
- 修法 A(spawn 时不推钟，tickEnemyCore allocatorCore 跳 advanceEclClock)：破 10 测试 + st1 f57 流 −104 → 回退。
- 修法 B（新生敌机跳过当帧槽位扫描）：钟差减半（lead 508/156 平/34 滞后）但 5 测试破 + formal 倒退
  （gx st1 f3593→f3241, st2 f3465→f3020)→ 回退。
- 当前理解：spawn 双推钟 + 同帧复扫是现有（部分被原生槽位轨迹背书的）行为；单独的钟 +1 读数可能混入了
  探针采样点差（native field[4] 的捕获相位）而非纯粹逻辑差。f3353 的 4.5px 开火位差真实存在但修法未明。
  **pending，不再试盲修。**

### slot8（st2 f696）取证归档（未闭合）
- 逐段核实：生成 tick/位置（493,(341.5,160)）、下落律（0.027/帧、坠落终点 (334.61,205.09) 于 tick 680）、
  homing 起点同刻同位、homing 律自洽（f32 重模拟逐步全等）、玩家目标同拍、收集盒 24 一致。
- 残余：原生物品在 tick 695 比 port 领先 ~6px（恰在收集盒界外）；port 于 update 696 收，原生 tick 696 收。
  0x17d61b0 = 玩家碰撞中心 Y（玩家优先 8 写入、物品管理器优先 12 后读），排除目标缓存相位论。
  根因未定（疑似 homing 早期一拍/起步细节），未强改。

### 视觉验证通道打通（pngjs 叠加，无需浏览器/Wine）
- tmp/goal-gx/overlay-3300.mjs：把 port 的弹/玩家位置叠到原生 s1-f03300.png 上（映射 x'=23+x·392/384, y'=8+y·449/448）。
- f3300 结果：port 的弹位与原生"箭头编队"**逐弹重合**，graze 64 两侧一致，玩家位一致。
  → 中boss 当前的 Sub16 环形阵在 f3300 宏观全等；剩余发散为刃级（f3175 擦弹、f3593 命中）。

### st2 f3465 弹道重模拟（排除积分器）
- 19994（Sub1 瞄准弹 spawn f3353）的 port 逐帧轨迹与同参 f32 重模拟**只差一个常量相位**——我的重模拟少算
  了"spawn 当帧弹即过弹管"的一拍；计入后逐步全等。port 的弹道积分自洽，f3465 残余在 spawn 位置/时机
  （ECL 钟 +1 类，已挂起）。
- 效果寿命表 EFFECT_SCRIPT_LIFE 与 etama.anm 脚本 remove 时刻逐项全等（4→30, 5→30, 51→241, 62→72, 12→40），
  排除寿命论。

### ECL 钟 +1 的最终存疑结论（不再盲修）
- 矛盾的核心：census field[4] 是 /proc 捕获时刻的值（帧内某点），若钟推进发生在捕获点之后，则系统性滞后 1——
  即"领先 1"可能是**探针采样相位伪影**而非逻辑差。旁证：中boss field[4] 在 f3184 与 port ctx.time 差 2（不是 1），
  非恒定偏移——更支持采样相位论。钟推进的微观时序（dispatch 早/晚于捕获）无法用现有探针区分。
- 但 f3353 的 4.5px 开火位差与 delta 域的遍在 ±4 自消 burst 又指向真实的早一拍……两读相持。
  无 Wine 不可裁决（需 ptrace 级敌机内存轨迹）。**留给有 Wine 的下一轮。**

### st1 f3593 的宏观根（非刃口）：Sub22 环阵晚 3 帧 + 中boss DPS 微低
- port 的 Sub24×11 环阵于 f3428 生成，原生 ~f3425——晚 3 帧 → f3554 处弹位差 ~11px → f3593 命中。
- 中boss(Sub15)HP：f3120 前全等；f3139 起 port 少伤 +10→+24（f3180），f3360 双方向 1300 触底同时。
  Sub22 入场同刻；其内环阵晚 3 帧。根：port 的射击 DPS 自 f3139 微低（~1%）——与 AGENTS§6"boss  pacing
  2.5-3x"同源但量级远小。嫌疑：追踪/寻的弹的目标选择或伤害结算细节。**未修。**

### st1 f3593 完整因果链（锁定到 gauge 积累）
- port 的 gauge 于 f3139 为 7785，原生 8006——原生恰过 +8000 妖怪极端阈 → 触发 FUN_00451670 的 ×106/100
  伤害增幅（settlePendingDamage 的 gaugeIsExtremelyYoukai 分支）→ 中boss 每帧 +2；port 未达阈不加 →
  DPS 微低 → Sub15→Sub22 相位阈晚 ~3 帧 → Sub22 的 Sub24×11 环阵晚 3 帧（port f3428 vs 原生 ~f3425）→
  f3554 处弹位差 ~11px → f3593 刃口命中。
- 那 −221 的 gauge 缺口来自 f2289-2799 的时玉收集 ±1 拍振荡积累（与 slot8 同族）。

---

## 2026-08-29 pass 9（无 Wine 深反编译轮）：gauge 全解 + 短点按 park + 四 formal 大移

### 重大勘误：census 元组字段序
- **census enemies 元组 = [slot, hp, x, y, eclTime]**——不是 [id,x,y,?,t]！
- 三重证据：st1 f3548 三只 Sub24 的 e[2] 与 port x 逐帧全等（9.6→−8.9 等）；e[1]=40 恒定=HP；中 boss e[1]=1278=HP。
- 旧探针把 e[1]/e[2] 当 x/y 的结论全部作废（含 pass-8 的"4.5px 开火位差"数值本身——方向可能对，数值需重测）。

### gauge 块（0x44bdf0，在 FUN_0044aec0 内部）全解（objdump 钉死）
- 完整门集：msg(0x4358bb：+0x2181c≥0 或 ==−2，−2 无写点=死码)/player+8≥30/炸弹(+0xfdc)。
- **e2ad0（空闲计时器）饱和在 30**：空闲分支 ≥30 走档位并跳过 0x44c007 推进。Z 抬起期把它数到 30；firing 分支每拍 −1（Z-down f392 → f421 倒数完 → f422 起漂移，实测）。
- 翻转点（0x44b1a5/0x44b3f8）全 .text 写集 = +8=0、e2ae8=0、pose/SHT 换装——**没有任何 e2ad0 写**。旧"妖怪向翻转 park"模型二进制不存在。
- 短点按律（五场景实测钉死，§7 挂 player.ts）：**focus-OUT 时若整个妖怪态到访都落在 +8 门内（held<30 且 form 仍=1）→ idle 置 30**。
  证据链：release@f576(held=11)→tier-1@f651(=R+75)；release@f1239(held=101,漂移已活)→R+45；press-only@f2975→press+47；
  f487/f829(held<8 无成形)→R+45；f392 Z-down 由饱和律覆盖。旧全条件 park 在 f2975 错付 30 拍倒数 = **f3139 −221 缺口的真根**。
- 修复：gauge 偏移曲线变化数 453→116，残留全是 ±111 收集相位暂态，f3244 归零。已提交 4096776。

### 四 formal（tap-park 后）
- **gx st2 f3465→f4365（+900）**；**ly st2 f3708→f4985（+1277）**；ly st1 f3174→f3176（族内）；gx st1 f3593→f3586（环阵反而早 3 帧——+8000 跨越提前，刃口换边）。
- st2 旧 4.5px 开火位差随 gauge 对齐消失（伤害增幅时序下游）。

### st2 实况（census 勘误后重测）
- 敌机场逐帧对撞（0.4px 阈）：**f0-f990 全等**。f991 旧"1px 差"为取整假象。
- 波次同步精确（f1546/1556/1566 ✓）。**f1558 起 port 提前 12-13 帧击杀 s1 左移妖精**（y=160 波，port 杀于 x=341/359 vs native x=287/323）——射击触达/弹道族缺陷，未解。
- f1787 起 sub12 敌机 0.46→0.8px 缓慢漂移（运动律精度族，未解）。
- 流：delta 域 f695 前全等；f696 −4（已知）后 ±4 游荡**不回付**（f4363 累计 −124，f4370 +200）。

### st1 实况
- 中 boss x @f3548：native 160.1 vs port 155.8——4.3px 慢漂（f3586 环刃口的直接根，运动律精度族）。
- gauge ±111 暂态（f3204-3244）= 收集 ±1 拍族在 gauge 面的投影。

### 下一轮队列（按杠杆排序）
1. **物品收集 ±1 拍族**（st2 f696 两件未付收集 / st1 ±111 暂态的共同根）：物品管理器 0x440500 状态机已定位
   （type 7=时玉→FUN_004412b0；运动积分不在 walk 内——疑似 ANM VM 驱动，需找 +0x2a4 的写点）。
2. f1558 提前击杀（s1 妖精 y=160 波）：自机弹触达/散射几何。
3. sub12/中boss 的 0.5-4.3px 运动律漂移（同族：ECL 浮点路径）。

## Pass 10（2026-08-29）— 物品侧 ±1 拍族清零；根移交运动精度族

### 假设闭环：+0x2a4 的写点就是 FUN_00440500 自己
- 物品结构前 0x2a4 字节 = **内嵌 ANM VM**（这解释了全二进制 0x2a4 的 VM 步长）；+0x2a4 起才是位置。
- 积分在 Ghidra C 里不可见，因为走了两个 __thiscall 向量助手（0x409120 vec×scalar、0x410a70 vec+=，
  this 被反编译丢弃）。反汇编 0x440936 逐指令可见。
- 物品管理器：全局 0x1653648，构造 FUN_00440010 → 池 0x831 槽 × 步长 0x2e4，扫描 0..0x82f，
  活跃链表 +0x2dc 尾插（**迭代序 = 生成序 FIFO**），mgr+0x17ada8 活跃计数。

### .rdata 常量全抽（EXE 直读；.rdata RVA 0xb4000 ↔ file 0xb3a00，delta 0x600）
- 42d4=16（剔除线=相机+16→464）；42dc=3.0（终端速度阈）；42ec=2.0；430c=60（tween 除数）；
  4338=1.0；4384=0.0（vy 翻转阈）；44c0=0.03（重力）；5b28=−2.0（toss 基速）；5b2c=−2.2（上抛钳）；
  **5b30 = double 128.0**（PoC power 阈，fild+fcomp QWORD —— Ghidra 渲染成 float 0 是误读）；5b38=0.05。

### walk 律全解（FUN_00440500 disasm 逐分支）
- **拾取盒**：0x440538 前导 [ebp-0x1c]=vec3(SHT@24, SHT@24, 16)；FUN_0044a5a0 halve → 物品盒 ±itemRadius/2；
  玩家侧 +0x3bc..+0x3d0 盒，玩家 init（all.c:38182）+0x3f0 = SHT@24/2 —— **两侧同源**。
  **ply00a.sht @24 = 24.0**（旧注释"26.0"是讹传）→ 总触达 24，全含比较。port 旧硬编码 ±12 数值碰巧相同。
- **PoC 武装**（0x4407f6-0x440859）：玩家在 PoC 线上 && (power ≥ 128 || player+3 RAW focus ≠ 0 || mode1/6)。
  port 的 || focusHeld 与二进制一致（0x17d5efb = player+3 原始字节，非 7 帧稳定形态字节）。
- **剔除**（0x44095b，fnstsw 0x41 奇偶）：恰好相等帧存活并吃重力，**严格**越线才释放（y > 464）。
- **state 3/5 是两条律**：state3 = 0.05×global + 单积分×moveRate + 0.03 尾 + state==3 帧跳收集；
  state5（type-10 低阶时玉）= 积分在翻转判断**之前**，非翻转帧**无 0.03 尾**、不进收集测试；
  翻转帧 state=1 后落到共享标签**再积分一次**（双 ×moveRate 步）再付 0.03 尾。
  死亡覆盖（state==2 = hitState||squish，不含 materialize）：state3 每帧；state5 仅翻转臂内。
- **死分支**：state3 的 `|| FUN_004066a0(0)` = timer.acc < 0 恒假（acc 从 0 只增）。
- 0x18b8a28+0xda |= 0x40（每次收集）= 逐帧事件旗标（多系统置位，无静态可寻 gameplay 读者）——统计锁存。

### 修复（全部 exe 钉死 + tests/th08-item-walk.test.mjs 7 条新测试）
1. 玩家拾取半宽 ±12 → sht.itemRadius/2 派生（数值不变，勘误注释）。
2. 底边剔除 >= 464 → > 464 严格越界。
3. state-3/5 拆分律（上述）。4. 物品迭代槽序 → 生成序 append（原生尾插 FIFO）。

### f696 −4 复核（修正单位 + 根移交）
- **旧台账"8 vs 10 件"单位折算错**：每次收集 = 4 张 u16 抽卡（2×rng.f）→ N696 = 原生 5 件 vs port 4 件，**差一件**。
- 缺的是 slot8（f493 出生 (341.5,160)，state-0 上抛-回落，input f679 focus 压下同拍武装追踪，
  f696 到盒前 ~6px，f697 已被满 power 转换成 pointSmall → 零抽卡收集 → −4 永不回付）。
- slot8 全轨道逐步复核：出生/上抛/回落/武装拍/追踪步/翻转帧积分全部**律内精确**；
  f662/669/674/689/692 的 time-orb 收集（同为追踪物品）抽卡增量逐帧全中 → 追踪机械+瞄准+拾取盒整体验证无损。
- **结论：物品侧无缺陷残余。slot8 的 6px 缺口来自远弧追踪的目标轨迹 = 玩家微位置（f661 起无原生验证），
  归入运动精度族**（与 sub12 0.5px / 中 boss 4.3px 同族）。钉死需新一轮 wine 取证（玩家 f660-700 逐帧位置）。

### 四 formal（持平，无回归）
- gx st1 **f3586** / gx st2 **f4365** / ly st1 **f3176** / ly st2 **f4985** —— 全部与 pass 9 基线相同。
- gauge 偏移曲线 116→113 处变化，f3244 归零不变。219 tests（+7）全绿。

### 下一轮队列（按杠杆排序）
1. **运动精度族（升为首攻）**：玩家 f661+ 微位置（slot8 探针）/ sub12 0.5px / 中 boss 4.3px / f1558 提前击杀
   —— 需用户下令重开 wine 轮取玩家逐帧位置 + ECL 浮点路径对勘。
2. f696 −4 与 st1 ±111 暂态随 1 收敛（物品侧已清零）。

## Pass 11（2026-08-29）— op75 矩形钳制从空壳到落地；gx st1 f3586→f3630

### 根一：op-75 敌机矩形钳制从未实现（中 boss 4.3px 漂移的真根）
- **现象**（census 对齐探针 tmp/p11-midboss.mjs + p11-delta.mjs，对齐律 native f == port f−1）：
  Sub22（中 boss 第 3 相，t0 于 ~f3336 进入）的 `ins_64(90, 4, 192, 144)`：
  **x 分量逐帧全等**（dx≤0.05 的减速曲线），**native y 从 t16 起钉死 128.000，port 却爬到 144.000**
  —— 不是慢漂移，是 16px 的单点目标差（旧台账"4.3px 慢漂"是退场 op67 从错误起点出发的投影）。
- **原生律**（all.c + objdump 钉死）：
  - FUN_0042c180（all.c:21039-21071）：flags +0x3324 **bit19**（ins_75 写矩形 +0x3340..4c 并置位，
    ins_76 只清位）武装时，把**敌机自身逻辑位置** (+0x2d34/+0x2d38) 钳入 [x1,x2]×[y1,y2]。
    FUN_0040b460 是**恒等函数**——port 旧注释把它误读成"钳玩家"，整个机制是 no-op 空壳。
  - 调用点×3：管理器主循环里运动积分器 FUN_0042deb0 **前后各一次**（all.c:21347-21349，每帧），
    以及 ins_63 setPos（case 0x3e）写完位置后一次。插值中点可以越界计算，但敌机永远不能
    越界积分/渲染/碰撞。
  - **位移基不钳**：ins_64 的位移 = target − loopHead（未钳的 +0x2d88 快照）→ native Δy=24 照算，
    每帧结果被钳 → y 曲线爬到 128 即钉死（census f3352 起 128.000 逐帧精确复现）。
- **修复**：eclvm.ts `applyTh08RectClamp`（分支逐条镜像：只在越界时写，写入值即 f32 矩形边界）；
  case 63 setPos 后调用（钳后再快照 loopHead）；stage-scene 敌机循环 integrateEnemyPosition 前后三明治。
- **使用面**（p11-op75.mjs 扫两关）：st1 sub15/26/33/37、st2 sub17/27/29/32 —— 全部 boss/midboss 相位
  同一矩形 (32,48,352,128)；sub18 显式解除。boss 战移动全部受此律约束。

### 根二：萤火虫锥判定换 exe 精确链（附带修正）
- 旧实现 `dot >= 0.94` 用**双精度**余弦判活；asm 0x426549-0x4265a4 实际链：
  D3DX normalize（**长度单次 f32 舍入，每分量各自 f32 除法**）× 轴 0x4ea3e8（raw facing 0x4ea3d0
  的逐分量 f32 归一化），dot（FUN_0040b540）**三乘积 x87 累加、仅在调用方 fstp 舍入一次**
  （JS 精确等价 = 对 double 精确和单次 fround），fcomp 0x3f70a3d7（=f32(0.94)）+
  fnstsw/test $5/**jp（PF 语义）**：只有**有序比较 dot < thr**（C0=1,C2=0）才释放——
  **相等存活、NaN 也存活**（C2=1 → PF=1 → 走 KEEP 路径）。§3 旧记录"NaN releases"方向记反，已正。
- 实测：f2970 前双精度/f32 链仅 1 次判定翻转（f1062 slot41，margin 4e-10，刃中之刃）——
  此修复是 exe 正确性收敛，非前沿驱动。

### 效果
- 中 boss 轨迹偏差行 308 → 135；f3351-3524 全窗清零（y=128.000 逐帧= census）。
- 剩余 135 行全部在 f3525+（op67 退场随机内移的角度差）与 f3586 后级联 —— 根见下。
- **formal：gx st1 f3586 → f3630（+44）**；gx st2 f4365 / ly st1 f3176 / ly st2 f4985 持平无回归。
- 219+1=220 tests 全绿（新增 tests/th08-rect-clamp.test.mjs：f3351 首钳帧 y≡128、f3424 停靠 (192,128)）。

### 新根登记：效果池 3 槽组成缺口 → RNG 流 f2965 起发散（下一轮首攻）
- **方法**：包装 rng.u16 计数 vs fa-native-gx/rng-curve.jsonl（去重保留最后一条！）常数偏移检验。
  **偏移 C=0 从 f52 一直到 f2699**（85k 张逐帧对齐——90+2 自举模型精确）；f2700 有一次 ±4 采样
  相位伪影（f2706 回补，非发散）；**首个持久发散 f2965：port 多抽 78**，此后永不回 0。
- **机理**：f2965 双方池同时首次满员（512）：native 批前 511 → 萤火虫 4 中 1（26 张即满）；
  port 批前 508 → 4 中 4（104 张）→ +78，此后自由槽竞速永久失配。port f2965 组成 =
  288×id62 + 198×id51 + 22×id5；**native 比 port 多持 3 个零抽卡 VM**。
- **排除**（抽卡数对齐 ⇒ 一切有抽卡成本的生成两侧一致）：萤火虫/id5/id0 生成数全部一致；
  id12/20/40/45/48（死亡/炸弹/受击路径）No-Miss 不触发；ins_127 注册路径无效果分配
  （FUN_00422c20 只是字节写）；13/14/15/24 常驻效果无 st1/2 生成点。
- **候选**（未决）：零抽卡 VM 的**拍边界寿命语义**（id5 冲击火花 life30 的 VM 首拍、
  蝇 241 的 authored remove 拍、id62 的 72）——三处 ±1 拍的叠加正好 ±3 槽量级；
  或 native 侧某个未建模零抽卡请求。**需要 native 效果池组成的直接证据**（wine 轮：
  /proc 轮询时顺带扫 0x200 池的 effectId 直方图，或 dump id5/51/62 的 VM clock 语义）。
- **下游链条**（已实证）：RNG 失配 → op67（Sub22 t190，f3526-3586，|Δ|=60 的随机内移）
  角度不同（port 193.2° vs native 211.1°）→ 退场轨迹差 17px → Sub24 环刃口 → **f3630 前沿**。
  注：f3630 命中弹 ownerSub=24 spawnF=3557 —— 修好 3 槽即整链回归对齐。

### 工具（tmp/p11-*，全部可复跑）
- p11-midboss.mjs / p11-join.mjs / p11-delta.mjs：census 对齐轨迹差（offset +1 最优，三向验证）。
- p11-ecldump.mjs / p11-sub22.mjs / p11-eclscan.mjs / p11-op75.mjs：ECL 指令/rank/pm/浮点实参 dump。
- p11-rngdiff.mjs：RNG 计数器常数偏移检验（**必须去重**，否则 f777 类重复行假发散）。
- p11-rngsrc.mjs / p11-pool.mjs / p11-byid.mjs：逐帧抽卡源直方图 + 池占用/组成。
- p11-flyflip.mjs：双精度 vs f32 判定翻转计数。
- p11-formal.sh：小输出 formal 四跑（容器内重定向 tests/.build，绕 podman 丢尾坑）。

## Pass 12（2026-08-29/30，无 Wine 纯静态深反编译轮）— 池缺口静态钉界 + st2 y=160 波根因钉死（修复被前沿门回退）

### A. 效果池 3/4 槽缺口的静态钉界（st1 f2965 刃口）
- **效果表真址勘误**：DAT_004c6d30 在 **.data**（RVA 0xc6d30 → file 0xc5b30），不是 .rdata（旧 delta-0x600 读到的是像素格式表）。
  每 id×0xc：{scriptIdx, tickCb, initCb}。关键：id5=37/tick 0x425e60(恒返1)/init 0x425d70(无抽卡)；
  **id51=73/tick 0x4264f0/init 0x426280（锥测试在 TICK 里，锥外当拍释放且不步进 VM；init 恒返 0=不释放，位置抽卡在 init 内⇒分配失败零抽卡）**；id62=75/无 tick 回调。
- **VM 步进律钉死**（FUN_0045e580/45ea00/40d3b0/06660）：init 时预执行第 1 步（tick0→1），spawn 帧管理器拍=第 2 步（tick1），
  op1@t=T 在第 T 拍执行释放 ⇒ **port 的 age>=life 本来就对**（+1 实验在 f859 刃口过冲被 oracle 否决回退）。
- **蝇速度/加速度常数逐个对勘**：vel.x=±0x3a83126f(0.001)✓、vel.y=±0.03✓、vel.z=−rand(.1)−.3✓、acc=±0.0001/±0.0001/−0.0003✓、×slowRate 一次于 init✓、tick 不再缩放✓ —— port 蝇模型全部正确（曾误改 0.0001 被 oracle f888 否决回退）。
- **缺口组成精测**（tmp/p12-trace.mjs）：f2965 批瞬时 port=507（62×288+51×197+5×22），native=511 ⇒ 缺 4。
  排除链：id5/id51 生成数抽卡级全等（C=0 至批前）；id62 稳态 276↔288 振荡（3 帧周期，与旧 /proc 实测 native 276-288 全等）；
  相机轨迹排除（f2236-2255 双方 512 饱和期拒绝事件全等 ⇒ 此前相位精确；f2255-2965 STD 无指令事件）；
  炸弹门控 id0 排除（udGx01 两面零炸弹实测，tmp/p12-bombcheck.mjs）；帧内调度序重证（玩家8→敌10→效11→物12）。
- **残余嫌疑**：n51 锥出时机（相机滑行期 f790-2990 y=718 线性段上的 f32 刃口翻转；port 首拍杀率 13.0% vs pass-5 原生实测 ~25%，
  直方图 tmp/p12-flyage.mjs）或 0x4ea3xx 相机块写入者（全部经间接寻址，grep 不可锚定）。
  **下一轮最锐静态目标=相机管线写入函数（D3D 帧设置链）；或 wine 轮池直方图。**

### B. st2 y=160 波提前击杀根因钉死（f1558 族，14-17 帧早杀）— 修复实现后被前沿门回退
- **census 钉死原生行为**（fa-native-gx st2 f1540-1600）：波妖精 hp10 全程不掉，t~24/23/19/9/10 突然死亡（连锁狙杀）；
  native 首杀 f1570.5@x287。port 旧行为：首杀 f1556.5@x~346（**早 14 帧**）、次杀早 17 帧（tmp/p12-st2wave*.mjs）。
- **根因**：lunge 缓存（DAT_018b89b4=mgr+0xe2abc）的槽复用别名律。原生发布律（0x42d4a6-d4d9 全钉）：
  候选须 |敌机x−玩家x|<64（0x17d61ac=玩家+0x2b4，0x4b42c8=64.0，**PF 极性陷阱：test $5+jp=小于才发布**）且无父（FUN_0041fd20=parent+0x2da4==0），
  保留 **y 最小者**（0x2d38 logical vs 0x2d8c live 混合比较，严格>替换）。port 的发布门方向/阈值全对（f727 锚点在案）。
- **缺陷**：中 boss f1543 离场（hp30 自删）后妖精复用 slot1，port 的无条件槽替换别名绕过发布门 → 集火期 Yukari 扑向妖精贴脸扫杀。
  原生：自删路径销毁（FUN_0042bea0@0x42d8f5 拍尾）**清缓存** → 妖精 |396−223|≥64 过不了门 → 无突进（hp10 保持 22 帧 ✓ census）。
- **修复矩阵**（全部实测，tmp/p12-mbhp/sub4/cache/st2wave 系列）：
  - 全清版（销毁清+扫描清）：st2 波修复 ✓ 但 st1 中 boss HP f3140 起 +2/5帧 缺损 → Sub22 相位晚 16 帧（rect-clamp 测试红）✗
  - E（扫描失配清）：st1 全等 ✓ 但 gx/ly st2 双回退（f4365→3019 / f4985→3063，f2925 Sub4→Sub5 别名锚点为真负载）✗
  - G（HEAD+自删清）：3/4 保持 + 波修复 ✓ 但 gx st2 f3019 ✗（Sub4 窗口内另一清除点）
  - **判别器未定**：f1543（清）vs f2925（别名存活）同为移除——**移除路径差异（ins_1/剔除 vs 损伤死）是唯一候选**，
    但 Sub4 窗口反证其简单形式。需一轮带中途可见性的探针或原生锚点。**四前沿门纪律：全部回退，HEAD 行为+文档注释交付。**
- 交付物：src 注释三段（VM 寿命律/蝇常数/缺口与 lunge 未决案，全部含 exe 地址）+ tmp/p12-* 探针 11 只。

### C. 本轮 formal（HEAD 行为 + 注释）
- gx st1 **f3630** / gx st2 **f4365** / ly st1 **f3176** / ly st2 **f4985** —— 与 pass-11 完全持平，无回归。
- 214+6skip 测试绿；npm check/build 干净。
- 会话内两次错误修复均被 oracle（rng-curve C / formal 前沿）当场否决并回退 —— 纪律闭环有效。

## Pass 13（2026-08-30，无 Wine 纯静态轮）— lunge 族完全解码：地址模型统一两锚点；st2 波根=齐射时序残余

### A. lunge/瞄准双缓存全定律钉死（全部 asm 级）
- **指针缓存 DAT_018b89b4（=mgr+0xe2abc，玩家+0xe2abc）= 原生槽地址语义**：
  - 发布门（0x42d4a6-d4d9）：|敌机x−玩家x|<**64**（0x17d61ac=玩家+0x2b4 碰撞心；0x4b42c8=64.0；**x86 PF 极性陷阱：test $5+jp ⇒ |d|<64 才发布**）∧ 无父（FUN_0041fd20=parent+0x2da4==0）∧ **y 最小者胜**（缓存者 logical-y(+0x2d38) vs 候选 live-y(+0x2d8c)，严格>替换）。port 的门（含 f727 锚）全对。
  - **移除后不清**：指针读槽地址——残躯冻结字节（无伤追击）→ 槽复用时读新占者（别名）。st1 C=0 至 f2699（本轮复验）证明残躯帧+别名皆原生；**st2 u11 见证**（mode-1 保留死 f1835，槽 2 之后被 sub1 复用，f1875-79 原生多 4 次接触=+16 张能带，任何清除变体都丢它）。
- **瞄准点缓存 mgr+0xe2aa4（=0x18b899c/a0/a4）：与指针缓存是两套律**：
  - **逐帧哨兵复位**（FUN_0044d420 写 (−1000,−1000,0)，每玩家拍尾 0x44c4f5 调用）；
  - 主发布（0x42d367-0x42d425，门=敌机 hit-this-pass 旗 bit1）：**本帧被接触敌机中 |x−玩家x| 最近者**（严格<替换）；无接触→哨兵→seek 门（≤−100）弹不瞄准；
  - 回退（0x42d42f+，旗未置时）：min-y。**port 的 max-y 主律=错**（待修，独立缺陷）。
- **追击律 0x44e770（停靠）/0x44e8d0（突进）逐指令全同 port**（des=(锚−位)/16，accel=(des−v)·0.2，v+=a，p+=v，|vx|<0.05 死区；锚=玩家−96/敌机 live+32 夹 32）——本轮实测 port 逐帧忠实（含移动锚点速度帽 ~8.2）。
- st2 波（f1543-70）原生真相：中 boss（sub7，时间线生成无父，mode 1）死后指针读槽 1 残躯→f1545 妖精复用槽 1→指针=妖精→option 以律速横穿 ~22 帧→**f1570.5 首杀=第 3 齐射贴脸杀**；中途齐射（f~1550/1553 出膛）因妖精 4.5/帧左移脱靶 ~30-50px（盒外）不中。**port(HEAD) 的 f1556.5 早杀=齐射相位/脱靶边际细节差**（唯一残余，下轮靶点：别名转换期的 SHT 20 帧周期与 beh1 出膛时序）。
- 中 boss 未注册 ins_127（sub7 ECL 只有 ins_129[1]+ins_1）⇒ isBoss 判别器不成立；sub10=sub7 经 ins_92 生成（子体 ✓）、sub11=sub30/59 经 ins_106 生成（子体 ✓）。

### B. 修复实验矩阵（全部实测后回退，四前沿持平）
| 变体 | st1 C曲线 | st2 波 census | st2 f1879 带 | gx st2 前沿 |
|---|---|---|---|---|
| HEAD（别名） | 0→f2699 ✓ | ✗ 早14帧 | ✓ 干净 | f4365 |
| 全清除（销毁+扫描） | ✗ f2218 起崩 | ✓ f1570 | ✗ +16 | f3019 |
| G（ins_1 位清） | 未跑 | ✓ | ✗ +16 | f3019 |
| v3（保留死清） | 0→f2699 ✓ | ✓ f1570 | ✗ +16 | f3019 |
| v4（isBoss 门清） | =HEAD（不触发） | ✗ | ✓ | f4365 |
- **+16 能带本质**：u11（mode-1 保留死、经别名持有）清除后丢失 f1875-79 的 4 次原生接触——任何"清除"都破此锚；而"不清"又让 port 的齐射细节差在波口暴露。**正确修法=地址模型（=HEAD 别名）+修齐射时序**，而非清指针。
- 重要方法论修正：**formal 前沿数字在蝴蝶区不是修复正确性的判据**（任何中途修复重摇下游）；判据=census 对齐+RNG 抽卡曲线。pass-12 对全清除的否决部分基于伪影（st1 中 boss HP"+2"经 id 计数器证为早期分叉的蝴蝶）。

### C. 本轮 formal（HEAD 行为）
- 四前沿持平：**gx st1 f3630 / gx st2 f4365 / ly st1 f3176 / ly st2 f4985**；220 测试绿。行为零变更交付（探针+台账）。

### 下一轮靶点（杠杆序）
1. **别名转换期齐射时序**（st2 波口 f1545-70）：SHT 20 帧周期在 option 目标死亡/别名切换时的相位律（ FUN_00450240 的 cadence 门 `t % period == phase` 与 e2ac4 ARM 时钟的关系）；修好=波口 census 对齐且不动指针模型。
2. **瞄准点缓存 max-y→接触律**（独立已钉缺陷，影响 seek 弹道全程）。
3. st1 池 4 槽（锥出时机/相机管线写入者）不变。

### 补遗（同轮）— 瞄准点缓存实验回退 + 回退方向勘误
- 接触覆盖律实施后 st1 在 **f852 偏 +4**（HEAD 在该处=原生）→ 回退行为变更。
  两种实现（仅接触/接触+逐帧回退）同偏 → 分歧源=接触覆盖层本身（时序或参考点待勘）。
- **回退方向勘误**：0x42d442 链重推（PF 极性）= cached.y < candidate.y 时发布（换成更大 y）⇒ **回退=max-y** —— **HEAD 的 max-y 律=原生回退律，正确**！port 注释无需改。
  完整律：逐帧哨兵+旗复位（0x44d420 清 e2ac0=0x18b89b8）→ 扫描先按 max-y 回退发布 → 本帧被接触者按 |x−玩家x| 最近覆盖（覆盖层的具体触发时序=下轮靶点）。
- 下一轮队列更新：(1) 别名转换期齐射时序（波口）；(2) 接触覆盖层触发时序（f852 锚）；(3) st1 池 4 槽。

### Pass 13 补遗 2 — 波口齐射取证：位置/瞄准/几何全部精确，kill 差为"否决机制"未定
- **齐射全取证**（tmp/p14-volley/dmg/margin）：port 齐射节奏=每 5 帧（ff≡1 mod 5，SHT 记录 interval=5），
  f1548/1553/1558 三波；**击杀者=f1548 波的三连散**（f1556 快照 |dx|=21.27-22.11 vs 触达 21.0，f1557 深度重叠接触，3×伤害 f1557 击杀）。
- **+1 对齐伪影陷阱（重要勘误）**：直接同帧比 census 会造出幻影位置缺陷——port f1547=387 ≡ native f1548=386.5 ✓、f1550=373≡f1551 ✓、f1568=292.5≡f1569 ✓——**波位置全程精确**。
  本轮"出生拍积分前导 4.5px"理论由此伪影而生，实施出生拍跳过后 st1 C 曲线 f501 即崩（+32）→ 已回退（st1 敌机同拍积分=原生）。
- **ECL 案例编号二次勘误**：ECL 规=磁盘 id − 1（非 +1）⇒ disk80=case 0x4F、disk81=0x50；port 的 80/81 位映射（bit0-2→0x40/4/8，bit3-5→清 0x10/0x10000000/flags2-0x40）经验证**正确**。
- **伤害结算否决链解码**（0x42d2fd-0x42d333）：+0x5354 盾计时器>0 期间，flags+0x3324 **bit1（值2=命中闩锁，接触扫描置位）** 置→dmg/=9；清→dmg=0。盾=ins_160(n) 的 8 拍（port 模型原生验证过）——盖不住 f1557-68 的 census hp10 恒定。
- **剩余未定**：原生 f1557-68 接触（火花抽卡平衡=曲线平坦所证）不扣 HP 的机制。候选：命中闩锁 bit1 的置位/清位时序（接触扫描 vs 结算读序）、或盾计时器 decrements 的真实条件（每拍 vs 每次命中）。判别探针（下轮）：量 port 在 f1553-68 对妖精的每次接触 HP 读数（若原生 ÷9 也未发生 ⇒ bit1 在结算时为清 ⇒ 闩锁时序差）。

## Pass 15（2026-08-29/30，无 Wine 纯静态轮）— st2 波口 12 帧早杀 CLOSED：根=远指针领养，非齐射时序、非伤害否决
### A. 波口真相链（三重误判的层层剥离）
1. **"+104 抽卡凸起=接触火花"证伪**：port 逐帧 trace（p15-wave）显示 +104 凸起 = option 萤火虫（FX id51 ×4）+
   id62 残影的生成抽卡，节拍每 4 帧；native 凸起（f1553/57/61/65/69）= port（f1552/56/60/64/68）+1（对齐律内一致）。
   ⇒ **native f1553-70 对妖精#1 无任何接触证据**，hp10 恒定=没被打中，不是"被打中但被否决"。pass-13/14 的"否决机制未定"
   问题域本身消解（+0x5354 盾链 0x42d2fd 解码仍有效且 port 已忠实）。
2. **port 弹道取证**（p15-bullets）：f1548 ff1 齐射的 option 弹（bf1 tf0，速度 15=10×1.5）从 lunge option
   (204.75,150.86) 瞄准妖精发射 → 封闭速度 19.5/f，f1557-58 拦截于 x≈341 = port 提前击杀点。
3. **根=th08LungeEnemy 非法领养**（p15-order）：f1544 中 boss（sub7，mode 1）corpse 移除时 hook 未清
   （e.dead 在 hook 访问之后才置位）→ 指针仍指死 midboss → f1545 妖精复用槽 1 → hook 领养（|395.5−222.7|=172.8
   远超 64 发布门，native 不可能发布）→ option 从中 boss 锚位提前 lunge+f1548 齐射瞄准 → 早杀 12.5 帧。

### B. 原生指针律全钉（asm）+ 修复
- **FUN_0042bcf0（保留尸 teardown）@0x42be88**：`if (DAT_018b89b4 == this) = 0`——ECL 脚本结束
  （dispatcher −1 @0x42c99d→0x42c9ba）与回调条件路径（0x42ce07）都走它 ⇒ **script-end/ins_1 teardown 必清指针**。
- **FUN_0042bea0（mode-0 立死 destructor）无指针写**（跳表 0x42de96：mode0→0x42d876 清 bit0 + bea0；
  mode1→0x42d809 保留尸走；mode3→0x42d6b6 hp=1 保留）⇒ **mode-0 死不清指针**。
- **扫描头 0x42c88f**：槽 active bit（+0x3324 bit0）清 且 指针==槽 ⇒ 清指针；槽 active ⇒ 保留（=别名现居者）。
- **cull 路径指针盲**（f2925 Sub4 别名锚所要求的唯一自洽读法，pass-12 矩阵已裁决）。
- 判别 = ins_129 mode bits（t.flags bit20-22；port ins_129 只写 t.flags ✓）。stage2 sub1/ sub4 无 ins_129
  ⇒ mode 0（不清，hook 别名保留 ✓）；sub7/sub11 ins_129(1) ⇒ mode 1（teardown 清 ✓）。
- **修复**（stage-scene.ts 两处槽释放点 + tickEnemyCore 块）：身份清 `th08LungeEnemy === e && mode bits≠0`；
  cull 用 deathViaCull 旗排除；mode-0 hook 原样保留。4423 hook 注释块 PASS-12 OPEN → RESOLVED。

### C. 验证（双 oracle 全过）
- **census 对齐（判决性）**：妖精#1 port f1570 死 ≡ native f1570.5（修复前 f1558）；#2 f1578≡f1579、
  #3 f1584≡f1585、复活 s1 f1585≡f1586——四杀全中；出生/位置逐帧一致；萤火虫 +104 凸起逐帧对齐。
- 新 census 净窗：**f1571-1806 连续精确**（修复前 f1546 起即错）。
- RNG 曲线 st2：±4 wander 族不变（无新增分叉）。**214 测试绿**（0 fail）。
- formal：gx st1 **f3630 持平**、ly st1 **f3176 持平**、ly st2 **f4985 持平**；gx st2 f4365→**f3019**
  （蝴蝶重摇：旧 f4365 骑在 f1546+ census 错流上的幸运重摇；新 f3019 的子弹 ownerSub=4 spawnF=2920 落在
  已知运动精度族下游，非指针回归——mode-0 sub4 不触发新清理，f2889 指针清=hook 行为与修复前逐位一致）。

### D. 新首残差（下轮靶点）— sub12 出生角镜像
- **首 census 失配 = port f1807（nat1808）slot3（sub12）x 1px**。深挖：sub12 出生即反向——
  port angle=1.6721524（95.78°，左下）vs native ≈1.4694（84.2°，右下，census vx +0.1..0.3）——
  **绕 90° 镜像**；vy 逐帧全同、速度斜坡全同（0.6 起 +0.05/f=ins_71(0.05) ✓，基速 0.5=ins_65 arg ✓）。
- 角度公式已解码：sub12 t0 ins_27 `var[10017]=var[10035]×(π/16)` → ins_25 `var[10016]=var[10048]+var[10017]`
  → ins_65(角度=var[10016]，速=0.5)。var[10035]/10048 来自 spawner（slot2 sub11，ins_91(t50..210)
  每 20-30 拍生成 sub12，life=100，父位+0,0，var 继承）。sub11 主列表无 float 写 ⇒ 变量更上游
  （波控制器链）。port f32 1.6721524 ⇒ var[10017]=+0.10135603；native=−0.10135603 ⇒ var[10035] 符号翻转
  （或镜像乘数）在上游某 float op。**下轮：从波控制器向下追 10035/10048 的写入链**（ins_25/27/23/24 家族）。
- 探针：p15-wave/p15-bullets/p15-order/order2/p15-censusdiff(2)/p15-s3/p15-angle/p15-eclmode（tmp/）。

### Pass 15 补遗 — sub12 角镜像=下游症状，根链收敛到 f696 −4
- var[10035]/10048 语义（varRead8）：**10035=[-1,+1) 随机（两次 u16，u32/2^31−1）**；**10048=aim-at-player**。
  ⇒ sub12 角度=瞄准+随机散布 ±π/16。port 分解=π/2（瞄准，玩家恰在正下方——replay 决定论，两边一致）
  + **jitter +0.516129**；native census 括出 jitter ∈(−0.84,−0.52)——**随机值不同**。
- rngdiff2 f1804 偏移带=+393992（f696 起的 ±4 wander 带内，f1801-11 在 +393984↔+393996 抖动）——
  **LFSR 状态错位 ⇒ 一切后续随机值不同**。⇒ sub12 镜像不是独立角度 bug，是 **f696 −4（slot8 时间 orbs
  收集缺失，盒缘 ~6px 差 → 收集未发生 → 4 u16 checksum 抽卡缺）** 的下游。修它=修玩家微位置/收集时序
  （pass-10/11 遗留：slot8 轨道定律已验证 law-exact，目标=玩家位置 f661+ 未原生验证；~6px 量级指向
  结构性 1 帧事件如减速死区/glide 边界，非 f32 累积）。
- 下轮首靶更新：**f696 slot8 收集缺失的玩家微位置根**（静态审计 FUN_0044aec0 运动块 vs
  th08-player-motion.ts；或 wine 轮取原生玩家 f660-700）。其后 f2965 池 4 槽（st1 f3630 根）。

### Pass 15 补遗 2 — f696 ±4 wobble 精确复现（下轮首靶的完备情报）
- **探针陷阱（重大）**：trace 事件的 frame = this.frame = 输入 f+1（update 头部自增）——事件标签比
  所在 update(f) 大 1。所有既有探针读数按此校正。
- 对齐后逐拍抽卡 diff（native f ≡ port update(f−1)）：f694/695/697/698/699 全等；**唯一失配拍 =
  native f696 ≡ port update(695)：native +20 vs port +16**，+4 永不回补（runs 表 +393992 直至 f770+）。
- 该拍 native 多收 **item8**（pointSmall）：native 收于本拍（+4 checksum），port 晚一拍
  （update(696)，事件标签 f697）。盒测几何：tick 起点 item8=(218.24,112.39) 玩家(178.517,95.556)；
  port 走行后位置 (208.73,109.32) ⇒ |dx|=30.21 > 24 拒收；**native 同拍走行后 |dx| ≤ 24 ⇒ 其走行终点
  近 ~6.2px** ——即 pass-10 的"盒缘 ~6px"残差，现有了精确复现（item8、f696/update(695)、30.21 vs 24）。
- 根候选（下轮静态审计 FUN_00440500 state-1 seek 逐 op）：目标锚（玩家 x/y vs +0x2b4 collision center）、
  seek 速率、瞬瞄/转向、f32 规整点——16 拍 homing 弧累计 6px ⇒ 每拍 ~0.4px 或恒定目标偏移 ~6px。
  下轮探针：port item8 逐拍位置表（f679-696）+ FUN_00440500 all.c 区段逐 op 重推。

### Pass 15 补遗 3 — item8 盒缘 6px 的排除表（下轮审计范围收窄）
- ply00a.sht 头直读：@0x14=10.0（seek 速，port ✓）、**@0x18=24.0（itemRadius，port ✓——"32 盒"假说死）**、
  @0x34=0.8（moveRate；port state-1 用 globalRate=1 与 5596 注释 pin 一致，观察步长 9.994≈10 ✓）。
- 排除：盒大小、seek 速、瞬瞄律、每拍重瞄（0x44085f→0x440877 每拍 FUN_0044c1b0 重算 ✓ port 同）。
- 锚定 +0x2b4：FUN_00444c1b0 读 player+0x2b4（0x40b460 恒等 accessor）；port 用 p.x/p.y——需确认
  port p.x ≡ native +0x2b4（玩家区域无直接 [x+0x2b4] 写，位置经 vector helper 更新——下轮核对）。
- **剩余最可疑：item8 的 state-0 落下段（f655-679，24 拍，vy0≈0.8-0.9 的缓降）**——crest 进 state-1 的
  时机若差 1 拍 = 10px 弧差；6.2px 差可能来自落下段重力/初速/时刻的微小律差。下轮：port item8 逐拍
  位置表（f655-696）+ FUN_00440500 state-0 段逐 op 重推（含 0x4408f9 的 vx/vy 清零与 0x4b5b2c 比较）。

## Pass 16（2026-08-30 继续轮）— f696 ±4 wobble 主人仍未定位，但排除网收至极限 + state-0 结构钉死
### A. 逐拍取证基建（三只新探针 + 重大工具陷阱修复）
- **p15-drawlog（决定性工具）**：包装 rng 全方法按调用点聚合。两大陷阱：①探针循环必须从 f=0 预热
  （从 LO 起跑 = 无历史状态，stage 脚本重放 416 抽卡爆发假信号）；②trace 事件 frame = this.frame = f+1
  （update 头部自增），CURRENT 标签才是真 pass。**此前所有"native f696 收集 item8 而 port 晚一拍"的
  叙述均按 f+1 标签误读**——校正后 item8（pointSmall）实收于 port update(696)，0 抽卡。
- port update(695) 抽卡构成 = 恰好 4 收集 × 4 checksum = 16（slots 11/20/58 power + 23 point），
  **与 native f696 的 +20 差 4**；update(696)=104（萤火虫）=native f697 +104 ✓；update(694)=12=native f695 ✓。
### B. 转换 FUN_00441450 逐 op 解码（port enterTh08FullPower 对照）
- 走 +0x2dc 尾链表；转换类型 0/2（powerBig/powerSmall）；速度重置门 `vy > [0x4b5b3c=−0.5]` →
  vx=0/vy=−0.5（item8 vy=−3.075 不触发 ✓ port 同）；effect 0（0 抽卡，全期 parity 验证过）；
  type=8；**VM 脚本重挂 0x4069f0(0x45)** —— etama global 69 = pointSmall（8+61 ✓）：t0 仅 9 instrs
  **0 random ops ⇒ 重挂 0 抽卡**（p15-anmrand 直解 ANM 字节）。⇒ 转换全程 0 抽卡，port 忠实。
### C. 盒定律再验 + 重大虚惊排除
- **size vec = (SHT@0x18, SHT@0x18, 16)**（0x44051f-0x44053b 直读，0x404720 = vec ctor）——物品半边
  = SHT@0x18/2 = 12 ✓（"sprite 16×16 → 半边 8"假说死：sprite 只是视觉）。盒 = player AABB(+0x3bc..3cc,
  ±12) vs item ±12，reach 24 = port 模型 ✓。FUN_0044a5a0 状态门 {0,3,4} ✓。
- ply00a.sht 直读：@0x14=10.0 seek 速 ✓、@0x18=24.0 ✓、**@0x34=0.9 moveRate**（我此前 0.8 系算错）；
  重力常数 [0x4b44c0]=0.03 平坦 ×moveRate=0.027 ✓（观察 vy 增量 0.027/拍 ✓）。
- state-0 落下结构钉死：**param 0/1 掉落 vy0=−2.2（0xc00ccccd，先升后降！）**，crest 后继续 state-0
  直落（PoC 翻转才 state=1）；param 2 = state-2 scatter（2×rng.f 掷靶 ✓ port 已实现）；param 3/5 =
  toss（rand vy/vx）。⇒ item8 的落下段远长于 f653-679（vy +2.174@f653 ⇒ 生成于 ~160 拍前的 rise-fall 弧），
  **"crest 时机差 1 拍"假说不成立**（crest 在 PoC flip 前早已过去）。
### D. +4 主人排除清单（全部证伪）
4 收集构成(16=16 ✓)、item8 收集时机（同拍 ✓）、pointSmall checksum=0（f1237 pin + slot61 对照 ✓）、
转换 effect/VM 重挂（0 ✓）、盒大小（24 ✓）、重力/moveRate（✓）、seek 速/瞬瞄/锚 +0x2b4（✓）、
PoC flip 输入对齐（✓）、死亡 burst/掉落 scatter（census+构成匹配 ✓）。**残余嫌疑只剩：无法用 census
可见性检验的 item 位置级差异（items 不在 census）——需 wine 轮原生 item 遥测，或全量 FUN_00440500
state-0 逐拍重推（vy0=−2.2 起的长弧）**。注：+4 在 f771 回落 = 4 抽卡支付位移的成对现象，
非 LFSR 永久错位——对 NO MISS 的实际威胁 = 位移期间所有随机值不同。
### E. 结论
本 continuation 零 src 变更（纯取证）；formal/测试维持 pass-15 状态（214 绿、f3630/f3019/f3176/f4985）。
下轮建议：①wine 门控轮请求（原生 item 遥测一次性钉死 item 弧）；②或先攻 st1 池 4 槽（独立刃口），
f696 wobble 用"接受 ±4 相位噪声"策略绕行——即先修后续大刃口，回头再看 wobble 是否仍挡路。

### Pass 16 补遗 — boss 时间orb 扫掠的 wobble 场（f1795-1812）
- drawlog2 对齐表（native f ≡ port update(f−1)）：30/34、14/22、16/20、104/112、8/0、4/8、4/16、108/112、
  4/0、116/124 —— **几乎每拍 ±4-12**，全部簇拥在 boss 时间orb 收集（slots 513-521，全 type time）周围。
  ⇒ **不是孤立 4 抽卡事件，而是长弧 state-1 寻的到达时刻系统性 ±1-2 拍**。
- 已再排除：寻的锚 +0x2b4 = 移动积分位本体（0x44bb 段 clamp/AABB/hitbox 全从 +0x2b4 派生，port p.x/y
  同源 ✓）；seek 速 = SHT@0x14 = 10.0 ✓；f32 atan2/cos/sin 精度差 ~1e-7/拍 不足以 ±1 拍。
- 剩余可辩假说：①运行时 [0x18b896c]+0x14 ≠ 文件 10.0（difficulty 缩放？loader 0x44dded 段拷贝语义待核）；
  ②FUN_004286e0 setVel 的参数序/extra 效应（如 +0x2bc 偏移）；③长弧的 f32 累积差异 + 盒缘 20-24 带的
  边界拍翻转——三者都指向"到达时刻对弧长极敏感"，与观察（短弧全对、长弧 ±1-2 拍）一致。
- 结论：wobble 场 = 同一引擎律缺口的多处表现，逐个 hunt 无意义；**一次 wine 门控轮的原生 item 遥测
  （任意一个长弧 orb 的逐拍位置）即可一次钉死**。静态侧已到收益边界。

### Pass 16 补遗 2 — 最后两个假说证伪，f696 +4 正式列为 wine 门控
- 全力清除 FUN_00415c60 → FUN_00430830(param 1)：三个 FUN_004400a0 站点的 param_4 全 = 1（0 抽卡），
  cancel item type 读 [0x18b8988]（mode 1 → pointStar ✓）；**零 rng 调用** ⇒ 清除本身 port 忠实。
- 敌弹 census：native f695 bullets=6 → f696=0（清除同拍 ✓ port 同，census bullets 字段匹配）。
- 运行时 seek 速 = SHT 文件头逐字段拷贝（+0x14=10.0/+0x18=24.0/+0x1c=pocLine 200）①死；
  FUN_004286e0(ecx=vel, angle, speed) 参数序与 port 一致 ②死；f32 累积 1e-7/拍 ③死。
- **+4 = 无法从 port 侧事件清单枚举的事件**（port 该拍完整构成 = 4 checksum，native = 5 个 4 抽卡事件
  的等价物）。item 位置级差异不可见（items 不在 census）。**正式列为 wine 门控**：一轮原生 item/事件
  遥测（/proc 或内存 watch item 坐标 + 0x164d520 前后事件）可一次定位。在那之前，sub12 角度差与
  boss orb 到达拍差都是该 wobble 场的下游症状，不值得逐个修。
- 建议策略（已记台账）：保留本缺口，把 gx st2 的 f3019 刃口视为 wobble 场下游；优先攻不受此噪声
  影响的刃口（st1 f3630 = 池 4 槽，同为 wine 门控）或向用户申请一轮 wine 遥测。

## Pass 17（2026-08-30 继续轮）— st1 相机 f32 实验（证伪回退）+ 锥杀率差异定性
### A. 相机轨道 f32 实验回退
- 假说：native STD 轨道电流逐拍 f32 落盘（fstp DWORD）而 port 保持 f64 → y≈718 滑行段相机差
  最高半 ulp（6e-5 绝对）→ 锥缘 4e-10 刃口翻转 → 池占用漂移。实现 tickVec/tickScalar 逐分量 fround。
- **oracle 裁决：f2965 边界不动（−78 精确保留）、蝇首拍杀率 13.9% 不动 ⇒ 回退**。
  f64-vs-f32 相机在 f2965 前未翻转任何锥决策。
### B. 锥杀率差异定性（p15-dotdist）
- port 首拍杀 380，dot32 余量分布：中位 5.0e-2（几何性清晰击杀）、仅 1 例 4.95e-6 刃口
  ⇒ **port 的锥杀不是刃口噪声，是几何性差异**——若 native 锥输入（eye/facing/axis）与 port 相同，
  杀率应一致；13.9% vs ~25%（pass-5 酒测锚，窗口/口径不明）的对比本身存疑：
  组成反证——f2965 时 native id51 存活 201 vs port 197（native 反而多活 4 只）⇒ 尾窗内 native 杀得更少，
  与 25%>13.9% 矛盾 ⇒ **25% 锚不可靠**（口径或窗口不同）。
- 视觉 sprite 16×16 与 item 全局脚本（63/69 t0）直解归档；SHT@0x34=0.9 修正（先前 0.8 误算）。
### C. 收益边界结论（静态）
st1 池 4 槽缺口的所有静态可检候选（蝇常数/VM 寿命/生成数/id62 振荡/相机 f32/锥判据/盒/清除）已全部
验证 port 忠实或排除。剩余差异存在于 cone 输入（eye 0x4ea3c4 vs STD 轨道：镜头震动/合成朝向？）——
写入者间接寻址不可静态锚定，且 native 锥杀真值无遥测。**st1 f3630 与 st2 f3019 的收敛都需要一轮
wine 门控遥测（item/效果池 + eye/facing 逐拍），静态路线已交付其全部可交付项。**

## Pass 18（2026-08-30 继续轮）— 全量 wobble 表建成 + setVel/粘性 state-1 钉死
### A. 全量 wobble 表（p18-wobbles.mjs，st2 f52-4400 逐拍 diff）
- **结构**：全部失配拍 = time-orb checksum（±4）在 port/native 间 ±1-2 拍位移；成对出现（nat696 +4 …
  nat771 −4 回补）；双向都有（native 早收 / 晚收均见）；密度在 boss 时间orb 扫掠期最高。
- 构成验证：port update(695) = 16 = 4 checksum（11/20/58 power + 23 point）精确；native f696 = +20。
### B. 指令项静态重推（全部 port 忠实）
1. **FUN_004286e0 setVel 全解**：`fld angle; fsincos; fmul speed; fstp vx; fmul speed; fstp vy` ——
   x87 扩展 sincos、单次 f32 舍入、无混合/无转向限制 —— port 的 `fround(cos(a)·s)/fround(sin(a)·s)` 逐位同构。
   f64 cos vs x87 sincos 差 ~6e-8 相对 ⇒ 30 拍弧累计 2e-5px，不可能移动到达拍。
2. **粘性 state-1 = 正确**：all.c:31055 `if (state==1 || pocGate)` —— **state-1 无条件寻的**（PoC 门只在
   state 0/2/4 进入时检验）；先前"de-arm 每次 pass 重验"假说死。port 的 sticky ✓。
3. dead-player 常数：all.c 0xbf333333 = **−0.7** ✓（我此前 0x4408e0 读的 0xbf000000=−0.5 是另一子分支）。
4. state-3 toss：vy += [0x4b5b38]×slowRate；pos += vel×moveRate(0.9)；crest 帧 state 3→1 且当拍即测收集 ✓。
### C. 机理结论
orb 到达拍 ±1-2 = 到达距离 razor（10px/拍步进跨越 24 盒缘时的相位翻转）× **orb 位置本身的 ~5-15px 差**
——位置差源自 post-f696 的 rand 值相位噪声自传播（首个位移后所有后续随机值不同 → toss vy0/vx 不同 →
弧不同 → 收集拍位移 → 位移再传播）。**首位移（nat696 +4）的主人 = 静态不可见事件**（port 该拍完整构成
= 4 checksum；场上无 item 落在可收集带）。修复路径只剩：①wine 遥测钉首位移；②或证明首位移对最终
MISS 无因果贡献（workload 大）。
### D. 复核
- 本轮零 src 变更（p18-wobbles/p15-drawlog2 探针入库 tmp/）；`npm test` 214 绿；formal 维持
  f3630/f3019/f3176/f4985（上轮已跑，无行为变更无需重跑）。

## Pass 17（2026-08-29/30 审计轮，AGENTS 口径）— pass-16 WIP 二进制审计全过（1 处 off-by-one 修复）+ **st1 RNG 流 f3582 发散钉死：f6352 前沿是流发散幻影**
### A. pass-16 WIP 逐条对照二进制审计（接手审计铁律）
8 项声明全部核对：ins_128→FUN_00425430(0xd) 云（asm/常量逐字 ✓，端口 0 抽+Infinity 寿命+主人死亡 16 拍释放 ✓）；
0x20000 OR+RETURN（FUN_0042ffc0 0x430538 块 + caseD_2=index++/return ✓）；0x40000→state 5 非 dead（写 +0xdb8=5 ✓）；
power 三处越限 FUN_00406fa0(0x80) 4 抽 + score（FUN_00440cf0/00441170/case4 ✓）；extend FUN_00439b29（lives→bombs,
se28, rank200 ✓）；时计梯段 stage(+0x2c)<2000 / award=cumulative(+0x30)（FUN_004412b0 ✓）；符印捕获臂 FUN_00406e50
（FUN_004161b0@9548 成功臂内 ✓）；pointItems 恢复 plumbing ✓。
**唯一缺陷**：0x20000 等待门 tick——原生 handler 顺序是 FUN_0040e390 先检查（remaining≤0 即清位，清位拍不递减），
未到期才 FUN_00418110 递减；位存续 arm 后 arg3+1 个 handler 拍。端口写成 decrement-then-check → **早一拍清位**
→ 0x40000 fade-kill / 后续 dir-change 早一拍。已修为 check-先行；测试钉更新为原生时序（6 拍清位/7 拍 fade）。
修正后四前沿全部复现不动（gx st1 f6352 / gx st2 f5853 / ly st1 f3176 / ly st2 f3470）——语义对齐未重掷接触。
### B. f6352「Sub25 停泊弹」证伪——运动律全部 asm 级吻合
探针（tmp/probe-sub25*.mjs）：击杀弹 = sub27（sub25 的 ins_135 火控）t=150 齐射末弹。队列
[slot0: 0x40 转向 interval90/maxTimes1/Δ+1.8326/newSpeed=0, slot1: 0x10 accel mag=var10023(0.045,L)/60拍/-999保角]。
弹完成 锜齿减速(90拍)→转向→60拍 +0.045/拍 再加速(|v|=2.70 精确)→巡航，f6352 扫过玩家躲弹路径（玩家 f6300
(109,254)→f6351(81,190) 机动中交叉）。逐条 asm 核对：FUN_00432460（+0x1004 ZunTimer 向上计数、等待支
speed=base−(elapsed·base)/interval 每拍重写速度、fire 支 times++/清位/angle+=/speed=newSpeed）、0x40/0x80/0x100
共享武装块 0x430380、0x10 武装块 0x4301db（f1≤−990 fallback=**+0xd74 当前朝向**，反编译 [0x35a] 是错的；
矢量=arm 时 polar(angle, mag×rate) 烘焙进 +0xfc0）、tick FUN_004322b0（FUN_00409120 缩放+FUN_00410a70 逐分量 +=、
atan2 重算朝向、limit=arg3）——**端口全部逐位同构。f6352 不是运动律缺陷。**
### C. 真根因：st1 RNG 抽卡流 f3582 起发散（census.jsonl 全阶段逐帧 draws 对拍，tmp/probe-parity*.mjs）
- f1-1475 与 rng-curve 完全一致（旧 parity 复认）；**首个失配 f3582：原生 +16 vs 端口 +8（缺 8）**，
  复发 f3588/f3594（周期 6，恰 3 次 ×8=24 抽），此后中 boss 伤害期 +4/事件（f3628/31/33/36/37/40…），
  f3731 后双向乱化（流值已错→萤火虫锥判定漂移），**f5001 累计 −7778，f6352 时 −9696**。
- pass-16 的「C-curve 0 through f3581」恰好停在悬崖前一帧——上一轮没追第 3582 帧就是本轮的全部入口。
- 因果实锤：sub27 t=110 op27 用 RNG 变量 10082 重算扇面基准角 var10016 → **f6171/6181 两波 14 弹的整个
  扇面角建立在已发散的流上** → f6352 接触是幻影。同理 st2 f5853 的 Mystia sub17 扇面（同族构造）。
- **缺口消费者定位（收窄至一处）**：缺口帧端口付 0 而原生付 4/8——独立事件流 = 玩家弹撞击火花
  effect-5（FUN_00425430(5)，init 回调 4 抽）。原生在中 boss 窗口的命中事件比端口多：伤害前
  （f3582-3594，HP 恒 1278=无敌阶段）每 6 拍多 2 次，伤害期（f3628+）每命中拍多 1 次。已排除：
  弹生成/主/aux ANM 脚本（etama 3/16/21/22/23 无 59/60 随机指令）、manager case-2/3/4 生成态路径
  （无 RNG 调用）、FUN_0040c7d0（纯矢量缩放）、敌人 census（f3570-3620 槽/HP/位置逐帧全同）。
  剩余候选：无敌/相位窗口的命中记账（原生对无敌 boss 仍付火花？）、hitbox2 流、或第三命中流。
### D. 复核
- 修正后 `npm run check`/`build` 干净，`npm test` 222（216 过+6 浏览器跳过）；四 formal 前沿复跑钉住
  f6352/f5853/f3176/f3470。本轮未推进前沿数字——按诚实交付铁律，流发散未修前任何前沿移动都是重掷彩票。
- 新探针入库：tmp/probe-sub25.mjs / probe-sub25-b.mjs / probe-parity.mjs / probe-parity2.mjs /
  probe-pdelta.mjs / probe-enemdiff.mjs / dump-sub25.mjs / dump-sub-args.mjs / anm-script-dump.mjs。

## Pass 19（2026-08-30 继续轮）— f3582 流墙 CLOSED（擦弹 orb 定律）+ gx st2 f8057（+2204）+ sprite7 toggle 子系统精确诊断
### A. f3582 墙根因 = 擦弹时 orb 掉落定律缺失（FUN_0044a930 尾部 0x44aa86-0x44ab0f）
- 原生每次弹擦弹最多掉 **3 个**时orb（FUN_004400a0(pos,10,1)，各 4 抽）：orb1 = 关卡门（FUN_0042f230 读
  0x164d0b1 关卡字节：非「偶数且≥4」或关卡10）+ 8 槽 boss 在册（FUN_0042f1f0 于 0x577f20）+ **gauge ≥ +8000**
  （FUN_00406d70 读 run-init 常量 0x164d306 = 0x1f40，asm 0x44d9f7）；orb2 = 弹擦弹（param_2==0，激光/体触非零）
  且**符卡中**（FUN_004178a0 = 0x4ea670 bit0 = FUN_004152a0 符卡宣言时 |=1）；orb3 = 非「奇数且≥4」（1-3 面恒开）。
- 端口旧模型：无条件 1 个。无敌盾中 boss 窗口（gauge ≥+8000 + 符卡中）原生 16 抽/事件 vs 端口 8 → **f3582 起
  每事件 −8**（f3582/88/94 三连）→ 流发散 → sub27 扇面角全错 → f6352 幻影。
- 顺带钉死：score 加倍门 = FUN_00406da0 vs 0x164d30a = **+2000**（youkai 侧单边；端口旧 ±8000 双边模型错）；
  擦弹计数 tier（+1/+2/+3 = human −8000/−2000 侧）原本就 ✓。阈值组 0x164d300-30a = -10000/+10000/-8000/+8000/
  -2000/+2000（asm 0x44d9ee-0x44da1b 全读出）。
- 修复：onGrazeAward 按 asm 逐门实现 + body/laser 调用点传 param_2≠0。门禁 222 绿；ly 硬检查点 f1237/f1276 不动。
### B. 成绩
- **gx st2: f5853 → f8057（+2204）**——Mystia 段新前沿；st2 流在本轮前已证 offset-0 干净（瞬态摆动全回补）。
- gx st1: f6350（stream 真值窗口 f3582→f3730 全净 +650 抽；f6350 接触 = sprite7 摆动重摇后的新弹，spawnF 6210）。
- ly st1 f3176 / ly st2 f3470 持平。
### C. 下一堵墙 = op-158 攻击控制器子系统（全部 asm 锚点已备）
sprite7 环弹的擦弹/受伤时序矛盾（擦弹需 +0xd34=32@f3731，受伤需 <16.1@f3739）由 **et_ex 攻击控制器**解决：
- op-158 注册攻击（sub15 t=0 三条；回调表指针 DAT_004eccac/004eccb0，all.c:10095 把 0x4ea670 写入 attack+0x1c
  ——0x4ea670 = 攻击管理单例，bit0/11 = 其状态位！）
- 攻击 tick = FUN_00424a20 / FUN_00424c40（函数指针调用，无直接 call）：遍历 0x600 弹池，`flags(+0xdb0) & attack
  mask(+0x18)` 匹配者切换 +0x1fc 火焰态：1→0 时 **+0x10b4=1（无碰撞化）+ sprite shift +0x10 + 速度重瞄准 attack
  的 +0x38/+0x3c**；0→1 时还原（sprite −0x10 + 自身 +0xd74/+0xd68 速度）。FUN_00424c40 变体另清 byte499。
- case-1 碰撞块被 +0x10b4 整体门控（all.c:23525）——切无碰撞后擦弹/受伤全停 → 32→<16 矛盾消解。
- 附带：+0xd34 = 活体 VM 尺寸（FUN_00462ff0 逐帧，VM+0x1f8 bit1 + byte499 门控）；擦弹盒 20.0 常量 = 0x4b6e98 ✓；
  玩家擦弹矩形半宽 1.4 = SHT+0x10/2 ✓（ ply00a @16 = 2.8）；hitbox 0.825 ✓；graze/hurt 分类器 = FUN_0044a470/
  0044a230（均 +0xd34/2；hurt 矩形 = +0x38c..39c = hitbox 0.825+5.0z）。
- 探针入库：probe-st2-parity / probe-score / probe-pos / probe-surgical{,2,3} / probe-graze{,2,3,4} /
  probe-familiars / probe-famgate / probe-boss-gate / probe-sparks / anm-args-dump。

## Pass 20（2026-08-30 深夜轮）— pass-19 墙归因全盘推翻 + 真根因 = fire-rank 界限定律（管理器默认模板）+ gx st2 f8061
### A. pass-19 的「op-158 攻击控制器」归因审计：三处全错
1. **op-158 ≠ 攻击注册**：on-disk 158 = exe case 0x9d = 激光槽指令（FUN_004230e0 slot/宽、FUN_00423110 颜色；
   端口 case 158 本来就对，spec §op158 的「laser color」即此）。st1 无 ins 136/137（= exe 0x87/0x88 的
   PTR_FUN_004c6cb0 即调/注册 tick 回调），st1 也不用 effect 12/14 → **FUN_00424a20/c40 在 st1 完全不可达**。
2. **+0xd34 不可能 = 32**：live +0xd34 只在 spawn 时从原型拷贝（all.c:22774），et 0x4000 换原型时整体换；
   值域恒 ⊆ {4,5,6,8,10,24}。pass-18 注释里「FUN_00462ff0 逐帧改 +0xd34」是误读——00462ff0 是 VM 精灵四边形
   绘制（写全局 quad 缓冲 0x18bdcd0..）。「37.4px 擦弹/16.1 受伤」见证链是推导不是观测。
3. **擦弹盒公式/年龄门**端口与原生逐字一致（FUN_0044a470：+0xd34/2 + 20.0(0x4b6e98) + 玩家擦弹矩形；
   FUN_0044a230：+0xd34/2 vs hitbox 0.825 矩形）。
### B. 真根因 = fire-rank 速度界限的「管理器默认模板」定律（本轮主修复）
- 原生 FUN_00415c80 写 ±0.5（0xbf000000/0x3f000000），但它有四个调用点且**顺序决定存亡**：
  - **FUN_0042b490（HP 阈值相位跳，all.c:20726-36）**：re-arm 在前，随后 0x84 dword 拷贝 `DAT_0057ad44 →
    enemy+0x2e24`（覆盖 +0x2dec/+0x2df0！）→ 净 **±0.15**。
  - **FUN_0042b930（超时相位跳，all.c:20862-70）**：拷贝在前，re-arm 在后 → 净 **±0.5**。
  - **FUN_0042c660（死亡回调入口，all.c:21712-25）**：re-arm 在前拷贝在后 → 净 **±0.15**。
  - **FUN_004152a0（符卡宣言）**：re-arm 后无拷贝 → 存活；**但 asm 0x415511: ecx = *(宣言敌+4) = 管理器链接**
    —— 它写的是**管理器默认模板**（0x577f20+0x2e24 = DAT_0057ad44 本体），不是宣言敌！之后所有相位拷贝
    恢复的都是 ±0.5。DAT_0057ad44 无文件数据也无运行时写者 = 零填充区+FUN_00429e00 对管理器记录
    （all.c:21200）的初始化（±0.15, all.c:19955-56）——「拷贝源=管理器自身模板」由 0x577f20+0x2e24=0x57ad44 精确锁定。
- **证据链**：gx st1 中 Boss（Sub15→HP1300 阈值→Sub22「蛍符」相位）f3626 环弹齐射速度原生 = 3.0 +
  lerpF(±0.15, rank12) = **2.9625**。±0.5 格点在 rank∈[8,12] 只产出 2.75..2.875（步进 1/64），**2.9625 不在
  ±0.5 格点上**——格点论证一锤定音。多模态子代理读原生截图 s1-f03900.png：8 颗 32px 环弹中心 vs 端口
  Δy≈+5px（73.5 帧弹龄）→ Δvy≈0.067 与 ±0.15 模型吻合。修后 Δy → −0.2..−1.3（子代理读数精度内）。
- 端口旧模型：phaseTransition/death-callback 一律 ±0.5、符卡宣言不 re-arm。修复：
  StageRuntime 新增 managerFireRankSpeed{Low,High}（初值 ±0.15，符卡宣言翻 ±0.5）；resetFireTemplateState
  从管理器对恢复；phaseTransition(…, timeoutPath) 仅超时路径拷贝后再 ±0.5；死亡回调块自然落到拷贝值。
- 顺带钉死 tier 误读：FUN_00433070 的尺寸阈值 .rdata = **8.0/16.0/32.0**（0x4b4300/0x4b42d4/0x4b42cc），
  端口旧 48 是 0x42000000 误读 → th08BulletHitbox h>32→24 修正。
### C. 成绩与残差
- 擦弹事件对齐（原生 f3731×2/3736/3754/3759/3775/3781 vs 端口）：修前 3735×2/3736/—(缺)/3760/3776/3788
  → 修后 **3732×2/3736/—(缺)/3759/3775/3783**（3 精确、2 晚 1、1 晚 2、1 缺）。
- 流瞬态振幅 16-72 → 16-32；f3731 +32 现在 f3732 回补。
- **前沿：gx st1 f6348（同墙重摇 −2）/ gx st2 f8061（+4，超额）/ ly st1 f3177 / ly st2 f3471**。222 测试绿。
- **新残差（锚点已备）**：sub21（Sub22 的 ins_135 子上下文）首齐射的 7 个擦弹事件全部晚 0-2 帧、1 个永缺
  （net −16 抽）。**在创建时给弹 +1 步（等价发射早 1 tick）→ 7 事件全部精确对齐**（3731×2/3736/3754/3759/
  3775/3782）。但：构造器 asm（0x42f5f0/0x42f946-0x42f98b：位置=模板 3 dword 拷贝，速度=FUN_004286e0
  (angle, speed×DAT_017ce8e0)，无构造期积分）与 ECL 时钟对账（census eclT 284@f3620 = 帧差精确）都证明发射
  帧与构造积分无误 → 差一步的机制在子弹管理器 pass 的计数/顺序细节（或 runstate 采样的相位解释），未定。
 下一轮从这里开局：probe-spawstep.mjs（+1 步猴子补丁复现对齐）、probe-phase2.mjs（帧内相位）、
  probe-pair2/3.mjs。

## Pass 21（2026-08-30 续轮）— sub21 一步墙的三个时钟模型全部证伪 + gx st2 新墙锚定（f7869 火力节拍）
### A. 本轮做了什么：干净树上的三次受控实验（全部回滚，代码零变更）
1. **模型 A（round-robin 先推进后按 ≤ 派发）**：流在 **f1754 断裂**（±4 族）。sub8/9 类子上下文首行 t=1
   必须在创建+1 帧发射（旧模型下流净到 f3581）——先推进让 t=1 行在创建帧发射，证伪。
2. **模型 A'（先推进 + 精确匹配）**：同样 f1754 断裂。t=1 行仍提前。证伪。
3. **模型 B（相位入口帧双推进，phaseEntryExtraTick）**：同样 f1754 断裂——波次敌人也有 ins_131/133 相位跳，
   其相位子行时间密集（t=1..k），双推进既跳行又提前。证伪。
**代数结论**：t=1 行钉死「派发时先看到时钟」（tick-after-fetch），sub21 t=200 行钉死「早一步」
（tick-before-fetch）——单一时钟无法同时满足两者；且发射帧对账（创建 f3426、齐射 f3626，与 census eclT
及构造器无积分 asm 全部一致）排除了创建帧偏移。**多出的一步在子弹 pass 机械层**：新造齐射弹在原生多走一个
管理器步。剩余嫌疑：优先级 12/13/14 的 FUN_004241c0（道具+弹碰撞）/FUN_00432b50/FUN_00431240 三连 pass
的分工（注意 FUN_00431240 的步长 0x2a4×160 偏移指向 **effect VM 池**——端口注释把它标成 BulletManager
OnUpdate 可能是误标；其 spawn-state 值已凭 A/B 实测独立验证，暂不翻案）。
### B. gx st2 f8061 接触解剖（新墙）
- 接触弹（sub17 rice，spawnF 7904，speed 0 停速型）是**下游重摇**：流在 **f7869 起停止回补**
  （−18 → +42 → +90 单调增长到接触帧）。f7700-7990 原生仅 1 个擦弹事件——缺的不是擦弹。
- f7869 窗口结构差：原生齐射帧 120 抽 vs 端口 106。Mystia 的 **ins_105/106 自动火力周期发射器**
  （每 ~20 帧一轮 12 弹 rice，flags 0x2252 带 spawn-state 位 ≈ 10 抽/弹）在端口与原生间 ±1 帧摆动
  （回补型 wobble），f7869 处 a1≈−0.008（**瞄准跟踪变量绕零 wrap**）打破回补。
- **下一墙锚点**：①自动火力定时器律（elapsed/deadline 的 advance/check 序、±1 摆动源头）；
  ②Mystia 瞄准跟踪变量（var 10048 族）的 wrap/累积律。二者都在 sub17/sub50 族驱动链上。
### C. 前沿与门禁（本轮结束时）
- 代码 = pass-20 提交 2f5b48b 原样：gx st1 f6348 / gx st2 f8061 / ly st1 f3177 / ly st2 f3471。
- 新锚点已备：tmp/probe-st2wall2.mjs（流偏移轨迹）、tmp/probe-st2draw.mjs（逐帧消耗对拍）、
  tmp/probe-st2trace.mjs（火力事件钩子）、tmp/probe-spawstep.mjs（+1 步对齐复现）。

## Pass 22（2026-08-30 深夜续轮）— 用户亲自看图指令 → 对话节奏根因 CLOSED（§7 打字机地板证伪）+ gx st2 f8252
### A. 用户看图质疑引导的根因链（主修复）
用户指出 f6000 端口"一发子弹都没有"。逐帧亲自比对（f05400/5700/6000/6300 + 原生同帧）剥离三层：
1. **端口开打后火力完全正常**（f06300：青翼扇+黄环+紫刀流全套）——不是开火缺陷。
2. **开打时刻差 182 帧**：原生 boss 主 ECL 在 f5777 reset（= sub25 入场待机自跳循环，t=100 ins4(0,0)
   跳自身，census eclT f5678/f5777 两次 reset 证明原生同样循环）；真正的一攻进入 = **f5811**
   （census hp 60000→13000 = sub26 t=0 ins_131(13000) 写 +0x2dfc=hp，asm case 0x82 三字段同写钉死）。
   端口修复前 f5959 进入（慢 182）——对话结束中断（timeline op8 → runPendingInterrupt → CALL sub26）
   机制端口本来就有，晚在**对话本身太长**。
3. **对话节奏根因**：msg0（开 Wriggle 战对话）= 3 行 34 字符 + **17 个 op4 等待**。原生 f5463?→5811
   ≈ 348f ≈ **20.5f/等待**（= 确认臂 6/8 帧 + 行推进）——§7 的"1.5 帧/字符打字机地板"（16 字 → 24f/行）
   按错误的"原生每行 40-60f"估计标定，纯减速 2.5 倍（端口 507f）。**移除地板**后端口 335f（-13f vs 原生），
   开打 f5787（-24f vs 原生）。
- 澄清：对话期开火其实只有残留 1 个 cycle（20 发、零伤害，与原生 census hp 恒定一致）——先前的
  "对话期被打 47000"是钳制假象（checkCallbacks timer 支在进入时把 hp 钳到最大已武装阈值 13000）。
- 中 boss 对话（msg1 无文本行）不受地板影响 → 已验证的 f585-635 gauge 冻结窗口不动 → ly 双面持平 ✓。
### B. 成绩
- **gx st2: f8061 → f8252（+191）**——Mystia 战整体时序提前后穿过旧接触。
- gx st1: f6348 → f6013（数字回落，但**旧 f6348 是 182 帧错位时间线上的幻影**——当时端口在打一个
  原生 182 帧后才发生的攻击型样新流）。新 f6013 = 真实保真度：进入差 24f（= 上游 12f boss 出生
  f5566 vs f5578 的 wobble 累积 + 对话内 ~13f），玩家按原生输入走位撞上 24f 相位差的弹。
- ly st1 f3177 / ly st2 f3471 持平；222 测试绿。
### C. 新锚点（下一轮）
1. **上游 12f 漂移**：boss 出生 f5566 vs f5578——f4140-5566 波次段的 wobble 累积（sub21 一步墙的下游）。
2. st2 f8252 接触：sub28 族停速弹（spawnF 7928，speed 0，age 294 撞在 (208,432) 底边）。
3. 对话内 ~13f：17 等待的臂粒度/行推进差（低优先）。
4. 呈现队列（pass-21 视觉验收发现，Timing 无法解释）：boss 名牌缺失、雾效矩形接缝、大环弹渲染
   偏大 25-30%、HP 条左缩进 13px、计时器纯白 vs 淡青。
### D. 探针入库
probe-dlgend / probe-dlgfire / probe-dlgfire2 / probe-msglines / probe-bossspawn / probe-fightentry{,2,3} /
probe-st1fightstart / probe-bossentrance / probe-st2wall{,2} / probe-st2draw / probe-st2trace / probe-anmnames{,2,3,4} / probe-anmkeys

### E. pass22 视觉复验（新 bundle；旧截图吃了 stale dist 的教训已记录）
- f06000：青色翼扇**正在展开**（双新月弧与原生翼形一致）、timer **27 vs 原生 26**（修复前 30 vs 26）。
- f06300：紫激光柱攻击 + 顶部蓝圈三连，timer **22 vs 原生 21**；boss/玩家位置同相。
- 结论：对话节奏修复后 Wriggle 战与原生进入**逐秒同步**；剩余相位差 ~1s（60f）= 上游 12f wobble 累积
  + 对话内 ~13f 粒度差。**浏览器视觉验收必须先 `npm run build`**（playwright 服务的是 dist/）。

## Pass 23（2026-08-30 深夜续轮）— sub21 一步墙的结构化侦察：原生模块表全解 + 使魔出生律 census 钉死（代码零变更）
### A. 原生模块/优先级表全解（FUN_0043c880 注册链 + FUN_0043ca50 runner，升序执行 — 本轮钉死）
- 8 = 敌人 ANM 准备（FUN_0042e120→FUN_0042e140(2)）；9/10 = 玩家（DAT_018b8a08/0c/10）；**11 = 敌人 ECL 主 pass**
  （FUN_0042c660：manager 群循环 FUN_0042a8a0→FUN_0042a4e0→FUN_004184b0 派发；槽循环内 dispatch→clamp→
  FUN_0042deb0 积分→clamp）+ 尾 pass（FUN_0042eb90）；12 = 炸弹/POC（FUN_00418010→FUN_00416b90）+ 效果 passA
  （FUN_00427f00）；13 = 效果 passB（FUN_00427bf0）+ 0x59c×0x100 使魔池 pass（FUN_00432b50，中点搬运）；
  **14 = 弹 pass（FUN_00431240，头部调用道具 walk FUN_00440500）**。12/13/14 三连假说据此作废：
  **弹的移动 pass 只有 14 一个，不存在第二积分 pass** —— sub21 一步墙不是双重积分。
- FUN_00431240 case-1 逐 tick 序：FUN_0042ffc0 et_ex 队列 → +0xdac 位处理（0x1,0x10,0x20,0x40,0x100,0x80,
  0xc00,0x400000,0x800000；0x20000 等待门）→ +0xda8 递减 → MOVE（FUN_00410a70）→ 擦弹/碰撞 → ANM。
  端口 updateBulletMotion 的处理序（5043-5134 行）与原生**完全一致** —— st2 停速米弹的 0x40+0x10 交互
  不是排序缺陷。
### B. 探针标签律（本轮勘误，往后所有探针必须遵守）
- 端口 scene.update(input f) 执行中 scene.frame == f+1（帧计数在 pass 开头自增）。所有 onGrazeAward/
  traceReplayEvent 打出的 "port fN" = **input N−1**。原生 census 行 f ≡ 端口 input f−1 ≡ 端口 scene.frame f
  —— **历史擦弹对比（pass 20/21）行号对行号 = 正确对齐**，+1 步探针 6/7 精确的结论成立。
### C. 蛍符使魔出生律（census 三行钉死，端口真缺陷）
- 原生 census f3626（Sub22 t=90 的 op91 波）：11 只 hp=40 子机出生，位置 = 父位置 + **各自武装速度的恰好
  1 步**（环半径 ≈2.4 = Lunatic var10016=2.4 ✓），eclT=1；f3627：+1 步、eclT=2；f3628：+2 步、eclT=3。
- 端口对齐对（input 3625 ≡ 行 3626）：位置一致，**eclT=2（+1）**。端口 spawnEclEnemy 的同步 t0 core
  （tickEnemyCore(game,e,true)）把时钟推进 0→1，同 pass 槽扫描再推进 1→2；原生子分配器
  （FUN_0041f110/0041f280→FUN_0042a680）出生 pass 结束时时钟可观测值 = 1。
- **约束**：时间线出生路径（FUN_0042a4e0，PRE 带 30-dword 变量块）的时钟相位被千帧 draw 流 1:1 钉死
  —— 修复只允许作用于 ops 90-93 子机路径，**严禁动时间线路径**。
- **本轮受控实验（已回滚，代码零变更）**：按上述模型实现「op90-93 子机分配器核心不推进时钟」
  （tickEnemyCore 加 suppressClockAdvance，仅 th08Familiar 路径）→ **formal gx st1 f6013 → f2919 回归**
  （sub13 弹 f2920 接触，流重摇）。机制：子机的 sub23 每拍效果 Spawn 移位 −1 → 效果池压力变化 →
  RNG 重摇（AGENTS §4 已知放大器）。**结论：census e[4]=1 的读法与流的证据不相容——子机时钟 −1 律为假，
  端口现行「同步 t0 推进 + 同 pass 访问再推进」才是与流对齐的行为**。e[4] 对新生子机的语义存疑
  （可能不是 ECL ctx.time，或行 3626 是 pass 中段采样）。本轮撤销的第二模型：visit 跳过 dispatch 只积分
  —— 与「同步调用不推进」在出生 pass 可观测上等价，同样被流证伪。
- 结构细节（all.c 新读）：op91 分配器 FUN_0041f280 比	op90 的 FUN_0041f110 多一句 FUN_00410a70(父+0x2d88)
  （父渲染位置参与出生坐标）；子机武装速度经继承变量块（父 26-dword 拷贝）的 var10016 每子不同 → 环形。
### D. 蛍符开场的火力结构（探针新事实）
- input 3625（≡行 3626）：11 只子机各自 FIRE 1 发 **sprite3 speed0 驻留弹**（rng=0），此后每 ~5-6 input
  重复（f3630/f3636…）—— 蛍符的驻留泡层由**子机自己**发射，不是 boss。
- 同 input boss（sub15 上下文）有 n=27 / n=96 两次 spawnBullets 数组增长（固定角、rng=0）—— 大扇面的
  逐发计数法被探针的"数组增量"污染，需按 call 内 count1×count2 重测。
- 快速环弹（|v|=2.9625，格点钉死）同 input 出生、含出生积分、与原生同 tick —— 一步墙的机制**不在**
  出生 tick 归属（draw +34/+12 归属已排除火时刻偏移）。
### E. 状态
- 代码 = pass-20 提交原样（本轮零变更）：gx st1 f6013 / gx st2 f8252 / ly st1 f3177 / ly st2 f3471；222 绿。
- 下一轮队列：①子机出生时钟律修复（仅 ops 90-93）+ census eclT 列对拍验收；②st2 f7869 自动火力节拍墙
  （pass-21 B 节锚点不变）；③boss 大扇面逐发计数重测（probe-volley2 的 count 口径修正）。

## Pass 23 续（同轮补遗）— 擦弹几何假设证伪 + st2 火力节拍结构画像（仍零 src 变更）
### F. st1 一步墙：「擦弹盒尺寸差」假设证伪
- +1 步对齐同样可由「擦弹盒差 ~3px」解释（走位穿盒的穿越拍位移 ≈ 沿速位移），与位置滞后不可区分——本轮直检：
  原生 FUN_00433070 tier 律（(a<b)==(a==b) 解码为 a>b 的三连嵌套）：
  w>32→24(tier0)；16<w≤32→{8,113,114,115}→5 / {9,109,110}→8 / default→10；8<w≤16→{2,111,112,4,5,6,106-108}→4
  / default→6；w≤8→4。**type-2（w=16 域）→ 4.0**；端口 th08BulletHitbox(2)=4（h≤16 域 case 2→4）✓ 一致；
  擦弹盒 = AABB/2+20 = 22 两侧相同。type-1 的 +0xd34=6 槽追踪（早期 pass）已钉过同族。**盒差假设死**。
- 顺带：case-1 的 +0xda8==0 路径（普通弹每拍走）= FUN_004399ac 屏内测试 → 屏内照常擦弹/碰撞，屏外无 0xdc0
  位即 FUN_00432170 杀——与端口 cull 律一致，无新差异。
### G. st2 f7869 墙：火力节拍结构画像（tmp/probe-st2volley.mjs 入库）
- 行级分类（spent≥100 = volley 行）：native 2077 行 vs port 2022 行（**原生多 ~55 行 ≈ 2.7%**——原生发射
  更多齐射行，但每行 draw 值 104-128 浮动，行数差不是净抽卡差）。行间隔两侧均 ~4-5 拍，配对游标会滑周期，
  行级配对法不可用；必须用逐帧 diff（probe-st2draw）。
- f7690-7990 非零 diff 结构：±4/8/12/16/20 小包叠加在 104/120 齐射行上，周期 ~5 三相（−12@7841+5k、
  +12@7843+5k、+4@7844+5k）——**多发射器叠加 + 效果池 throttle 噪声**，单发射器模型不可用。
- 计时器原语语义（本轮读毕）：ZunTimer = {current, frac, deadline}；FUN_00406610=装载（current=−999 停）；
  FUN_00406660=推进（FUN_00447421 按 slowRate 分数进位）；FUN_0040b8e0=到期比较。FUN_00423150 发射后
  FUN_004065f0(0) 停表——**原生需再武装而端口常跑**仍是头号嫌疑；验证需先解出 Mystia 脚本的再武装路径
  （sub17/sub50 的 ins_105/106 循环位置），下一轮第一项。
### H. st2 再武装路径侦察（本轮末）
- sub52（Mystia 符卡相位）t=0 有 ins_105(0)——**arg=0 = 零 deadline 的空武装**（端口 varWrite 同样
  deadline≤0 直返；native FUN_00422720 的 gate 也会拒绝）。真发射器不在 17/50/51/52 的首屏。
- 下一轮第一项：全 65 个 st2 子扫 id=105/106，找非零 deadline 的武装点与其所在循环（ins_4 回跳周期 vs
  deadline 值）——若「脚本循环周期 == deadline」则端口常跑计时器与原生停表+再武装在相位上等价，摆动源头
  转向 ZunTimer 分数推进（FUN_00447421 的 slowRate 进位）与端口 autoFireElapsedFrac 的进位差；若不等，
  端口需要实现停表+再武装语义。

## Pass 23 续二 — st2 再武装假设证伪（脚本扫全量）+ 摆动源收窄到瞄准 razor（零 src 变更）
### I. 全 65 个 st2 子的 ins_105/106 扫描（tmp/ecl-scan-autofire.mjs 入库）
- **非符/妖精发射器（sub1/2/3/4/6/11/13/14/20/28/30/59）：ins_106[非零 deadline] 在 t=0/1/35 一次性武装，
  全部 0 个 jump** —— 无脚本再武装，原生计时器自主重复 → **端口常跑计时器 = 正确模型**，
  「停表+再武装」假设被脚本证据证伪（FUN_004065f0(0) 的可见参数 0 是 this 丢失伪影，实际语义 = elapsed
  归零继续跑）。ins_105[0] 只出现在符卡相位（23/33/38/44/52/58）= 空武装，符卡弹幕走显式 ins_96-104 行。
- 分数进位差也排除：rate=1 时 FUN_00447421 的分数路径（frac+=1→进位）与端口 fast path（elapsed++）
  数值等价；端口 updateMovementController 全链 fround ✓。
### J. 摆动源收窄（下一轮靶）
- a1≈−0.008 是 FIRE 的 angle1 操作数（var 解析值）在 f7869 过零——移动控制器/计时器/再武装全部排除后，
  剩余候选 = **瞄准累积变量的更新律**：sub52 t=90/150 块的 id=7(var10017,−2.75/−3.14)、id=6(var10039)、
  id=28(var10022=var10023×2.5)、id=15(var10017+=0.79) 的 ECL 数学链与端口的逐条舍入是否一致，
  以及 fireTh08Raw 重放捕获 FIRE 时对 angle1 var 的二次解析（capturedFireVars 切换路径）是否与原生
  「捕获时已解析」语义一致。下一轮：probe-st2trace 窗口拉到 f7840-7900，逐 volley 打 angle1/speed1
  与原生 104/120 行的 ±1 相位对齐表。
### K. **st2 墙破口找到：Mystia 预战对话多跑 ~79-160 拍**（本轮最大发现，修复留待下轮）
- 链条：native 预战入场自跳循环（eclT ~100/圈）在 row 7330 最后一次 reset（interrupt 到达时圈钟 82）→
  真正开打 ≡ input 7329；端口 f7407 对话结束、f7408 才 reset 入场（**晚 79 拍**）。下行全连：
  7 只 sub28 使魔（e=60206..60212，hp600 族）晚 79 拍出生 → 每 ~17 拍（ins_106[16]+相位抽）发 1 发
  **speed0 sprite7 驻留种弹**（角度逐使魔固定 0.333/0.726/1.119/1.511/1.904/2.297/2.690）→ 种弹格 lattice
  整体错位 → f8252 接触弹（spawnF 7928, (204.6,434.6), age 294）= 玩家（原生输入、runstate px/py 已证
  与端口恒等）撞上错位的驻留种弹。**pass-21 的「瞄准变量 wrap」叙述被推翻——摆动源头是对话超时。**
- 端口对话 f7051→f7407 = 356f，25 个 op4 等待全 confirmed（Z 常按）；等待消耗 9-13f 不等（尾部降到 9），
  而原生 ≈196-205f ≈ **25×8 = 纯确认臂**——**原生的 MSG 时钟在行间无空转，端口每等待多花 1-5 帧**。
- MSG 行时间本身是密的（op4 每 t 单位一行：t=60,61,62,63…；行 12-14 的 op17/16/8 在同 t）——多出的
  1-5 帧不在行时间，**嫌疑 = op8（行/颜色）与 portrait/reveal 处理在 wait 之间的门控帧**
  （updateTh08Dialogue 的 runners/portraitOffsets 同步），或 machine.update 的调用频率被场景层逐帧门控。
- 修复方向（下轮第一项）：对比 updateTh08Dialogue（stage-scene 2758 起）对 machine.update 的调用条件与
  原生 gui+0x21830 消息管理器每帧无条件 RunMsg 的语义；修后 formal 验收 gx st2（预期前沿大幅推进：
  79 拍 × 下游放大）。
### L. 79 拍分解完成：逐等待测量 + 原生确认律 asm 锚点（修复的实现缺口已收窄到一条指令语义）
- 端口 25 等待逐个：首个 66f（玩家未按 Z，输入驱动，两侧同）+ 其余 24 个 = **8 臂 + 1 行间隙 + 0-4 帧
  Z 松键延迟**（重放玩家在对话中点射 Z，每个等待 1-4 帧松开）。native 同输入总耗时 279f ≈ 8.9/等待
  —— **原生在同样的松键模式下确认得更快** → 原生确认律不是端口的「Z 持续按住且 counter≥threshold」
  电平规则。
- 原生 case-4 asm（all.c:24775-24792）真读：confirmed = Z(0x164d52c bit0) 持有 && **(Z_now != 0x164d534
  bit0——某输入镜像的 Z 位不等，疑似边沿/延迟镜像)** && counter ≥ threshold(6 载入/8 确认后/30 超时后)。
  **0x164d534 的身份（上一帧输入？另一采样相位？）是实现修复前的最后一个未知数**——它决定原生在
  「按住-松开-再按」序列里的确切确认拍。2026-08-27 的 A/B（边沿规则让 ly 中段拖 600f/行）当时用的
  「上一帧输入」读法若错，本次重审可解。
- 修复实施清单（下轮）：①解 0x164d534（.rdata/引用扫）→ 定确认律；②改 th08-dialogue case-4 的 confirmed
  判据；③probe-st2waits 验证 25 等待 ≈ 9f/个、对话窗 ~279f、f7408→~7329 入场；④formal gx st2 当轮验收
  （预期前沿 >> f8252，79 拍下游全面重排）；⑤ly 双面回归验收（st1 msg0 与 st2 msg 共用机器，电平→边沿
  可能改 st1 节奏——pass-22 的 −13f 残差可能同根）。
### M. 原生确认律定案（asm 全读 + 旧 A/B 矛盾消解）——修复实现仅剩一步
- **0x164d534 = 上一帧输入镜像**（40743/40804/40840: `DAT_0164d534 = DAT_0164d52c` 帧界拷贝）。
  原生 case-4 确认律 = **Z 上升沿 + counter≥threshold**（all.c:24781-24793 三 clause 直读）：
  confirmed ⟺ Z_now=1 && Z_now≠Z_prev && counter≥threshold(6 载入/8 确认后/30 超时后)；
  未确认则 counter++（<duration 时）；counter≥duration → 超时（threshold=30）。
- **旧 A/B 矛盾消解**：2026-08-27 的「边沿规则让 ly 中段拖 600f/行」读法错在把 ly msg0 的等待当成
  被确认——实际上 Z 全程按住时**原生是等 500f 超时走的**（st1 msg0 的 op4 时长均值 ~20.5f？不对——
  dur=500 的超时即 500f；348f/17 ≈ 20.5 说明 st1 msg0 的 op4 时长就是 ~20.5 一类短值，全部走超时）。
  端口电平规则在 Z 常按时提前确认 → st1 −13f（pass-22 测得）✓ 一致。**st2 Mystia msg 玩家点射 Z：
  边沿律在再按拍确认（快），电平律在按住首拍确认（同拍）——但端口的 counter≥8 要求 Z 在 counter=8
  那一刻是按住的，点射模式下多等整个松键段** → 每 +1-4 帧 × 24 ≈ +50-79f ✓ 与实测吻合。
- **修复**：th08-dialogue case-4 的 confirmed 改为边沿判据（input rising-edge bit0 + counter≥threshold），
  completeWait 后 previousInput 的更新时序对齐 0x164d534 的帧界拷贝。st1 msg0 全程按住 → 全部走超时
  → st1 对话会变慢 ~13f（回归原生！）——**ly 双面 + st1 msg0 需同轮验收**（这可能正是 pass-22 的
  −13f 残差的根）。预期：gx st2 前沿大步推进（79 拍下游重排），st1 对话 +13f（也可能顺带修好
  st1 f6013 的上游节拍）。

## Pass 24（同轮实施）— 对话确认律改边沿触发：**gx st2 f8252 → f10043（+1791）**，四面前沿全面前进
### 实现
- th08-dialogue.ts case-4：confirmed 从「Z 电平 + counter≥threshold」改为 **「Z 上升沿 + counter≥threshold」**
  （rising 用机器已有的 previousInput 差分；threshold re-arm 6/8/30 不变；op4 的 dur=500 超时路径不变）。
- 逐等待验证（probe-st2waits）：等待消耗从 9-13f 收敛到 8-9f；对话窗 356f → ~280f；入场 f7408 → ~7329 对齐。
### 成绩（formal 全部当轮验收）
- **gx st2: f8252 → f10043（+1791）**——种弹 lattice 整段清除；新接触 = sub17 sprite3 speed0 停速弹
  （spawnF 9888，age 145，(83.1,432) 底边）——与旧墙同类但晚了 1791 拍 = 下一段停速弹节的 razor。
- gx st1: f6013 → f6021（+8——对话现在按原生节奏走超时，Wriggle 战进入相位更准）。
- ly st1 f3177 / ly st2 f3471 持平（零回归）；216 测试绿；check/build 干净。
### 方法论
- 「2026-08-27 的 A/B 结论」阻碍了本案两轮：该 A/B 把「ly 对话快」归因于电平确认，实际是**短 dur 等待
  走超时**（Z 常按无沿 → 超时路径）。凡是旧 A/B 用「输入词全 odd」推断的确认语义，都应对照
  all.c:24781-24793 的三 clause 重新审计。

## Pass 24 续 — st2 新墙（f10043）解剖：sub17 停速弹全链画像（侦察，零 src 变更）
### N. 接触弹的完整运动链（tmp/probe-st2rice.mjs 入库）
- 火：boss（(192,128) 定点，sub17）每 input 连发 12 发 sprite3 speed=3.875 的扇面（exFlags=0x40，
  exDir={angle:0, newSpeed:0, interval:60, maxTimes:1}）。火原点随 boss 的 ANM/loop-head 位置漂移
  （203.97→192.00→190.50→186.02…，逻辑位恒 192,128）。
- 运动链四段：①**spawn state 2**（flags 0x24212 bit1 → creep ½，~9 拍——0x40 计时器此时不走）；
  ②0x40 等待锯齿 60 拍（speed = base×(1−t/60)，速度标量不动、速度向量逐拍重写）；③到时 dir-change
  （angle+=0、newSpeed=0、0x40 位清、**cond 链武装 0x10 加速**——向量从 0.3 量级重新爬到 4.4）；
  ④0x10 到 limit 清位 → 向量冻结 (−1.478,4.217) 滑行至底边接触。
- 算术逐条对拍：锯齿 `base − e·base/interval` x87 单次舍入 ≡ 端口 fround(f64 同式)（e≤60 整数 × f32
  在 f64 精确）；polar 重写 FUN_004286e0 链已在 pass-18 钉死；0x10 先于 0x40 的同拍序一致。
### O. razor 定位（下轮）
- 接触弹（angle 1.9078，12 发扇面之一）滑行段 4.45px/拍——**边界拍 ±1 = 接触点 ±4.4px**。三个边界拍：
  spawn state 结束拍（th08FlashDuration 的 ANM 长度）、dir-change 触发拍、0x10 cond-武装拍。静态下一步：
  审 advanceBulletExBehavior 的 cond 链（cond==0 槽停走语义）与 exDirElapsed 的首拍起点（spawn-time
  advance 调用是否多走一拍——与 pass-23 子机实验同型的 ±1 但在弹侧）；动态定案需原生弹遥测（wine 门控）。

## Pass 24 续二 — cond 链首拍审计（findings §P；零 src 变更）
### P. advanceBulletExBehavior vs FUN_0042ffc0 结构对拍
- 端口 cond 链（eclvm.ts:70-194）与原生队列走（FUN_0042ffc0）逐支同构：cond==0 且 +0xdac≠0 → 停走 ✓；
  一次调用只推进一个行为槽 ✓；0x20000/0x40000 的 return 语义 ✓；0x40 的 {angle,newSpeed,interval,maxTimes}
  装载 ✓。dir-change 拍的时序等价性确认：转换拍 queue pass 时 0x40 仍在 → 0x10 停走 → 下一拍才武装，
  两侧一致；转换拍速度 = polar(newAngle, 0) = 0、滑行一拍，两侧一致。
- **审计发现的剩余差异（下轮靶）**：①原生 TH08 构造器（FUN_0042f5f0）**不跑队列走**（flags 经
  template+0x1fc 拷贝、队列+游标原样复制），端口 spawn-time advanceBulletExBehavior 多跑一次——对
  0x40 首槽等价（flags 同态），但对「首槽 cond==0」的火（若有）会差一拍；②原生队列走的
  consumed-bit 门（all.c:22971 `(param_1[0x36c] & opcode) != 0 → break`，0x36c×4=+0xdb0）与端口的
  `exFireFlags & slot.opcode` 门语义待对齐——+0xdb0 在构造器里未赋值（继承模板/未初始化），其与
  +0xdac(+0x1fc) 的分工决定「已武装槽是否再走」。
- 三边界拍中已排除：dir-change 拍与 0x10 武装拍的相对时序（结构等价）。剩：spawn-ANM 结束拍
  （th08FlashDuration vs 原生 flash 脚本 remove 帧）+ 上述 ①② 的复合效应。接触弹滑行 4.45px/拍，
  单边界拍 ±1 = ±4.4px ≈ 1 个身位——仍是头号嫌疑但需原生弹遥测或更细的 asm 才能定案。

### Q. 「构造器不跑队列走」对齐的可行性分析（结论：不实施；零 src 变更）
- 深推后发现移除 spawn-time advance 对当前接触弹**不可观测差**：首个管理拍若从 slot 0 走（无 spawn call），
  exFlags 构造期为 0 → cond==0 停走不触发 → 0x40 装载+RETURN → 旗标处理以 elapsed=0 跑等待分支——
  与现行（spawn call 已武装、首拍从 slot 1 停走）完全收敛。差异仅在「首槽 cond==0 但构造期 flags 已
  非零」的火（原生 +0x1fc 拷贝带旗标而队列游标为 0 的组合）——当前 st1/st2 数据未出现该组合。
- **判定：盲改无原生观测量支撑，不实施**。razor 的 discriminating 证据仍是 ①原生 flash 脚本 remove 帧
  （etama.anm 直接可读——下轮可用 ecl/anm dump 工具对 sprite3 col1 脚本逐指令核对 th08FlashDuration 的
  「首个 static/remove 的 time」读法）；②原生弹遥测（wine 门控，按方针放弃）。
- 下轮第一步（零风险）：用 anm-dump 工具逐指令打印 sprite3 的 flash 脚本（proto col 1），核对
  th08FlashDuration 的 remove-time 读法与 spawnAge 推进的 9 拍实测（probe-st2rice 的 f9890 速度仍未衰减
  → state 2 至少到 f9896 前后）。
### R. 边界拍①（spawn-ANM 结束）验证一致 + 最终静态候选定案（零 src 变更）
- sprite3 col1 flash 脚本（tmp/probe-flash3.mjs）：t=0 五条（op3/8/34/7/36）→ **op1 @t=10** →
  th08FlashDuration=10 ✓ 与实测 spawn state ~9-10 拍一致（f9900 elapsed=4 反推）——**边界拍①排除**。
- 三边界拍：①一致 ✓；②③结构等价（§P）✓。剩余唯一静态候选 = **x87 80 位中间精度 vs JS f64 的
  双舍入差**：锯齿 `base − (e·base)/60` 原生一次 ext→f32 舍入，端口 f64 两步（÷60 的 f64 舍入 + fround）
  —— e·base 精确时 ÷60 的 f64 与 ext 结果可在 f32 半way 点翻转（60 拍 × 12 弹的复合），接触 razor
  （4.45px/拍）放大亚像素差。此为 movement-precision 家族同源精度问题（pass-16/18 已定性 wine 门控）。
- **结论：st2 停速弹 razor 的静态分析已至 JS 精度边界；进一步定案需 wine 原生弹遥测（按方针放弃）**
  或接受亚像素级不确定度、转向下一墙。st1 一步墙（弹 pass 积分计数）同理属该精度家族的可能性已高。

### S. 有理数锯齿式 A/B（受控实验，已回滚）：舍入形式被证非墙因
- 改 dirChangeBullet 等待分支为单次除法有理式 `fround(base×(interval−e)/interval)`（消除 ÷60 的 f64
  中间舍入，理论最接近 x87 单次 ext→f32）→ **formal gx st2 = f10043 整**（前沿逐帧不动）。
- **结论：锯齿舍入形式在 10043 帧 fixture 内从未产生不同舍入**——停速弹 razor 与锯齿舍入序无关，
  最后一个静态候选正式关闭（与 §R 的"精度家族"定性合并：若真有亚像素差，本 A/B 应至少偶发移拍；
  实测零变化说明 x87 与 f64 在此链上实际逐位一致）。
- 已回滚（按预承诺 A/B 纪律：不可观测的改动不留）。剩余解释收窄为：接触弹 razor 在**边界拍之外的
  原生侧差异**（弹遥测盲区）或接触几何在底边的行为差——静态已穷尽，后续轮可从「底边接触判定」
  （y=432 钳位 + AABB 与 448 边界的交互）再扫一遍，或转向 st1/ly 侧新证据。

### T. f10043 墙定性升级：不是 razor，是**路径分叉**（runstate graze 计数器锁定）
- 原生 runstate graze 计数（dedup 后）：9974-9994 密集 +15 后，**9994→10046 零 graze**。接触弹在端口的
  路径 f10015-10043 穿过玩家 graze 盒（半宽 ~34px）必然触发擦弹（或早已 latch）——原生零 graze 意味着
  **原生该弹路径与端口相差 ≥34px**：不是亚像素 razor，是加速段的方向/时序分叉。
- 分叉点锁定在 **0x10 加速段（f9960-10020）**：出口速度 (−1.478,4.217)、方向 1.9078=接触弹 angle、
  mag≈0.0745/拍 × ~60 拍。0x10 的 arming 拍 ±1 → 整个速度轮廓平移一拍 → 接触点差 ~4.45px=一个滑行拍；
  arming 时的 heading/向量 bake 差异 → 方向差。三候选：①cond 链放行拍；②accel 向量的 angle 源
  （slot.f1 vs bullet.angle，−999 哨兵）；③limit 清位拍（ex=0x0 @f10020 前后）。
- 方法注：runstate graze 计数器是**全 graze 源**（弹+敌体）——窗口对拍必须先排除敌体 graze 段；
  dedupe keep-last 后 9974-9994 的 +15 与底边段的 0 都是有效判据。
- 下轮：①dump 该火的完整 ins_111 记录（sub17 的 0x40+0x10 槽序、cond 值、f0/f1 原值）；②
  probe-st2rice 的 target 改锁 angle≈1.9078 的弹，逐拍打印 arming 拍/limit 拍/exFlags 迁移；③
  对照 FUN_00423910（0x10 处理器）的向量 bake 时机（arm 时一次性 bake vs 每 tick 重算）。

### U. 接触弹完整迁移表（probe-st2rice 按 angle 1.90777 锁定，findings §T 三步①②完成）
- 接触弹 id=70000：born (196.484,115.200) angle 1.90777 **speed 1.297（12 发扇面速度插值的一员，
  非 3.875——此前 trace 锁错弹）**；exFlags 出生=0x40（sub24 族队列 [0x2000,0x40,0x20000,0x20×4]）。
- 迁移表：f9889 ex=0x40（锯齿中）→ **f9956 dir-change 触发 ex=0x0（干净空档一拍）** → **f9957 0x10
  武装 accEl=1（cond 链 +1 拍结构性 ✓）** → **f10017 accEl=61 limit 清位 ex=0x0** → 滑行。
- **新的具体线索：实测加速段 Δv/tick = 0.0731（(−0.0242,0.0690)），但 sub20 的 0x10 记录 f0=0.03——
  2.44× 不匹配**。两解：①接触弹的 0x10 来自另一条记录（模板队列跨 sub 累积——sub26 也有 4 条 111，
  待 dump 其 f0）；②accel 向量 bake 的倍率源（activationRate/f0 读法）。下轮：dump sub26 + 打印
  该弹 exAccel 对象的 mag/angle 原值，即可定案是记录读错还是 bake 错。
- queue 结构确认：0x2000 grace 60 → 0x40{0,0,60,1} cond=1 → 0x20000 wait 60 cond=0 → 0x20×4
  （st2 sub24），混合 sub20 的 [0x20000,0x10] —— **模板队列跨 sub 累积假设成立**（0x40 与 0x10
  出自不同 sub 的 arm，同队列共存）。

### V. **分叉机制破案：0x20 螺旋槽被 exFireFlags 门错误跳过**（findings §T 三步全部完成）
- 接触弹真实 exSlots（探针直读）：[0x2000 grace60, **0x40{0,0,60,1} cond=1**, **0x10{f0=0.07448,
  f1=−999.90, limit 60}**, **0x20{f0=0.0333, f1=−0.0262, limit 60}**]——0x10 的 f0=0.07448 与实测
  Δv/tick=0.0732 吻合（2.44× 之谜=记录来自另一 arm 的 sub，模板队列跨 sub 累积确认）；exAccel bake ✓。
- **分叉机制**：0x10 在 f10017 limit 清位后，队列下一槽 = **0x20 角速度+加速（螺旋！）**——端口
  `advanceBulletExBehavior` 的门 `if ((exFireFlags & slot.opcode) === 0) continue;`：exFireFlags=0x2252
  **& 0x20 = 0 → 0x20 槽被跳过** → 滑行段速度冻结（探针实证 f10020-10030 vx/vy 不变）。
  原生队列走的门（all.c:22971）= `(+0xdb0 & opcode) != 0 → break`——比较方向相反且字段不同
  （+0xdb0 语义待定，非 +0xdac/exFireFlags）。原生侧 0x20 大概率放行：滑行段 angle += −0.0262/拍、
  speed += 0.0333/拍 的**螺旋**——26 拍内路径偏移 ≥34px ✓ 与 graze 分叉定量吻合。
- **修复方向（下轮第一项）**：对齐队列走门语义——原生 +0xdb0 的写入点/语义（constructor 未写、
  需 asm 级追）或最小修复：去掉 exFireFlags 门对 0x20（及一般槽）的 skip、保留 cond 停走与
  「一次一槽」，formal 验收 gx st2（预期 f10043 后整段螺旋弹重排）。**风险**：exFireFlags 门若对
  其他弹族有正功能（grace/sfx 槽的过滤），需逐族核对——先 ly 双面 + st1 验收再提交。

## Pass 25 — 队列走门语义对齐：0x20 螺旋解冻（commit cbd8d9d）
### 实现
- advanceBulletExBehavior 删除 `exFireFlags & opcode === 0 → continue` 门：原生 FUN_0042ffc0 的走门只有
  cond==0 停走（+0xdb0 为炸弹期位，常态为 0），TH07 遗留的 fire-flags 过滤在 TH08 埋掉了后续槽——
  接触弹的 0x20 螺旋（angle −0.0262/拍、speed +0.0333/拍）因 0x2252 & 0x20 = 0 从未武装。
- formal 当轮验收：**gx st2 f10043 → f10058**（旧接触点穿过，新墙 = 重排后流的新弹）；gx st1 f6021 /
  ly st1 f3177 / ly st2 f3471 全部持平（零回归）；216 测试 + check 绿。
- 下游观察：+15 = 螺旋解冻后流重排的下一个非预期接触（新弹、新位置），不是本修复的回归——
  边沿确认律（pass 24）同型：真实根因修复后的前沿变化 = 新保真度标尺。

### W. pass 25 后新墙 f10058 初定位（零 src 变更）
- 接触弹：ownerId 38385（boss sub17），spawnFrame **9859**，sprite3 offset10，**speed 1.9999994（≈2.0
  authored——非 3.875/1.297 减速族）**，age 189，接触位 (74.78,435.37)，玩家 (77.43,432)（钳位底边），
  angle 0.5714（≠出生角——路径已转弯=链上有 dir-change/螺旋）。
- runstate graze：native 10040-10062 恒 422（零 graze）——**分叉仍在螺旋后流中**；端口侧此窗的 graze
  事件与该弹的 exSlots 迁移表待下轮 probe（方法链同 §U：按 angle+position 在出生拍锁定 → dump exSlots →
  逐拍迁移表）。
- 下轮：①锁定 f10058 接触弹（angle 0.5714 ≈ birth，born (≈196,115) 族）打印 exSlots/exFlags 迁移；
  ②native graze 分叉窗 = 9994-10062 零段，端口 graze 事件分布即路径差分源；③若同为 exSlots 链，
  检查 0x20 的 limit(60) 到期后是否还有槽（本弹 age 189 > 前一弹 155——链更深）。

### X. f10058 接触弹初锁（零 src 变更）
- 队列门修复实证：9859 族 6 发候选在 f10043 **ex=0x20（螺旋已武装并运行）**、sp 1.833 增长中、angle
  0.7023/0.9837 旋转中——cbd8d9d 的修复在弹上生效 ✓。
- 接触弹 = 螺旋路径族（f10058 (74.78,435.37) sp≈2.0 ang 0.5714）；native graze 全窗零 → 螺旋路径仍与
  原生分叉。候选-接触配对未定（6 发候选的 f10043 位姿与 15 拍后接触位的角度/速度外推不完全吻合——
  0x20 的 angEl/limit 细节或另一弹）。下轮：逐候选打印 f10043-10058 轨迹对拍接触位，锁定后按 §U 法
  dump exSlots 迁移；重点 0x20 的 angleDelta 方向（f1=−0.0262 = 顺时针？）与 limit 到期后的槽。

### Y. f10058 候选追踪：6 发候选在 f10050 前消失，接触弹为同族另一发（零 src 变更）
- 9859 族 6 发（id 69518-69527，ex=0x20 angEl=55）在 f10043→f10050 之间**从 dense 数组消失**
  （cull/死亡）——但接触弹（spawnFrame 9859，age 189，f10058 在 (74.78,435.37) 存活）仍是该族成员。
  12 发扇面只追到 6 发——**spawnFrame 过滤或 dense 数组快照漏了一半**（下轮：按 id 集合跨帧追踪，
  不用每帧重过滤）。
- angEl=55@f10043：0x20 的 limit 60 → f10048 前后到期——**到期后 ex=0x20 清位、下一槽（若有）武装**，
  弹的速度/角度在接触前的 10 拍内还有一次法律切换——接触 razor 或分叉可能就在 0x20 到期段。
- 下轮：①id 集合跨帧追踪 12 发；②0x20 到期拍（angEl=60）的迁移表；③native graze 零段（9994-10062）
  对拍端口的 graze 分布定分叉拍。

### Z. 接触弹五段迁移表完整闭环 + 分叉源定案为 var 解析精度族（零 src 变更）
- id 69518（12 发全量 id 集合追踪）五段全自洽：0x40 锯齿（dirEl 0→60，f9866 起步=spawn state 10 拍）→
  dir-change f9927（sp→0，干净一拍）→ 0x10 加速（accEl 1→60，向量 polar(2.1422, f0)）→ **0x20 螺旋
  （angEl 1→60：sp 0.033→2.0、angle 2.116→0.571）** → **f10048 limit 到期 → 滑行（ex=0x0，sp 2.0、
  ang 0.5714 冻结）** → f10058 接触 (74.78,435.37) ✓ 与 formal 记录逐位吻合。
- 律本身与原生逐支一致（heading+=f1、base+=f0、极坐标重写、limit 清位）。**剩余唯一自由变量 = 记录
  f0=0.07447916269302368 的 var 解析值**（该 ins_111 pm=0x60，f0 由 var 链在 arm 拍算出）——native 同
  输入同律却 ≥34px 分叉 → **native 的 f0 值不同 = var 累积链在更早处已分歧**（movement-precision 家族，
  pass-16/18 的 var/wobble 残差同源；静态已穷尽）。
- 下轮方向：①从 f0=0.07448 反解 var 链（sub52 t=90/150 的 id=6/7/15/28/34/39 序列对 0x0744 产出的
  舍入序审计——若 f0 由 var10017×0.05 一类组成，f64 链与 x87 链的差已可数值定位）；②或按 §R 结论
  接受精度边界、把 st1/st2 剩余差全部归档为该家族待 wine 轮。

### AA. f0 var 链反解：分叉源收敛到 f696 家族（本会话静态分析的总闭环）
- f0=0.07447916 的产出链：ins_111(pm=0x20) f0 ← **var 10017**（arm 拍值）；var10017 由 sub52 循环的
  ins_7/ins_15 常量累加（−3.14/−2.75/+0.79/…）。端口每 store fround ≡ 原生 x87 每次写 f32——单精度
  ulp(6e-9) 不可能造成 34px 分叉（需 ~13% 值差）→ **分叉 = var 状态的宏观差，非舍入差**。
- 宏观差的根源候选 = **f696 家族**（pass-16/18 定性）：f696 slot8 时间 orb 收集缺失 → checksum ±4 →
  RNG 流永久 +4 → 一切随机 var 值不同 → 含 var10017 链中的随机项 → accel f0 → 螺旋路径 → f10058 接触。
  **st2 f10058 墙与 st1 一步墙至此汇入同一 f696 根**（两面前沿的剩余差同源）。
- f696 的静态排除网已在 pass-16/18 走到极限（转换 FUN_00441450 全解、seek 速/f32/盒缘全验、
  「长弧 ±1-2 拍位移×post-f696 rand 相位噪声自传播」机理成立）。**修复路径只剩：f696 首位移的
  原生遥测（wine 门控）或接受该家族为已归档的精度/遥测边界。**
- 本会话总账：st2 f8252→f10058（+1805，两个根因修复 3f1560f/cbd8d9d）；st1 f6013→f6021；
  ly 零回归；216 测试/check/build 全绿；审计链 §F-AA 完整（每步 asm/census/runstate 锚点 +
  当轮 formal 验收 + 负结果也入档）。

### AB. f696 攻坚开局：item walk 结构定位（零 src 变更）
- FUN_00440500 的 case switch = **item TYPE**（+0x2d4）非 state：case0=FUN_00440cf0=power 收集
  （127→128 阈值、FUN_00441850(1)+checksum——pass-16 已钉）；case1=FUN_00440e40=state-1 收集完成
  的计分/popup 尾（非 seek 运动）。**time-orb 的 seek/collect 运动在 walk 主体的 LAB_00440936 前段**
  （+0x2d7 state 的 0/1 分支：state2 tween 的 FUN_0040c7d0(2.0) 段已见、state1 的 seek 待读）。
- 下轮：读 FUN_00440500 主体的 state-1 seek 分支（f661 前 160 拍长弧的每拍向），对照端口
  updateItems 的 seek——目标场（玩家 +0x2b4 碰撞中心 vs +0x2d34 逻辑位）、seek 速（10.0）、
  FPATAN vs Math.atan2 的 1-ulp——三处任一差异即 f696 的 6px 盒缘缺静态成因。
- 方法提醒：pass-19 已证 runstate px/py ≡ 端口（±0.005），旧"target 未验证"叙述作废——homing 目标
  的玩家位已可对拍；剩下的只有 seek 分支自身的场/速/atan2 语义。

### AC. state-1 逐拍 re-aim 受控实验：回归证伪、已回滚（结论：原生确为逐拍 re-aim）
- 把端口 state-1 从「逐拍 atan2」改为「arm 一次定速」→ **gx st1 f6021→f3267、gx st2 f10058→f4391，
  双面灾难性回归** → 已回滚（check 绿、树回 f274ced 等价态）。
- **结论：原生 state-1 确为逐拍 re-aim**——我在 walk 主体读漏了逐拍 atan2 块（FUN_0044c1b0 的调用点
  在 state-1 每拍路径上；arm 块的 FUN_004286e0 只是首次定速）。端口现行逐拍 atan2 正确。
- **该负结果同时锁死一条路**：f696 的 6px 盒缘缺不在 seek 运动律（逐拍 re-aim 已确认、seek 速/盒
  已验）——剩余仅 FPATAN-vs-atan2 的 1-ulp（静态不可定案）与 f696 首位移的遥测盲区。**f696 家族
  静态攻坚至此正式收口**，两面剩余差（st1 f6021、st2 f10058）归档为该家族待遥测轮。

### AD. FUN_0044c1b0 完整对拍收口：角度扩展精度保持修复（提交本节同 commit；fixtures 流中性）
- FUN_0044c1b0（all.c:37477-37497）语义定案：差值（player−item 的 x/y）在 x87 ext 中计算不舍入、
  FPATAN 的结果 **ext 保持**进 FSINCOS、f32 只在速度 fstp 出现——零向量 case 返回 π/2（0x4b4468）。
  端口旧代码对 aim angle 多做一次 Math.fround（f32 量化）——**asm 级确认的多余舍入**。
- 修复：item homing 的 angle 保持 f64（JS 最接近 ext 的形式），仅速度乘积 fround。
  formal 全量：gx st1 f6021 / gx st2 f10058 / ly f3177/f3471 / 216 测试——**fixtures 流中性**
  （f64 与 ext 在这些链上实际未产生不同 f32 舍入——与 §S 锯齿 A/B 同一结论）。
- 定案：f696 家族的静态排除网**彻底穷尽**（seek 律/速/盒/角度精度全对拍）。两面剩余差
  （st1 f6021、st2 f10058）= f696 首位移的遥测盲区，修复需 wine 原生弹/位移遥测轮（用户下令）。
  审计链 §F-AD 完整、零未记录变更。

### AC2. homing 目标场审计完成：+0x2b4 碰撞中心两侧一致（零 src 变更）
- FUN_0044c1b0 的 FUN_0040b460 = identity accessor（返回调用方给的指针），字段由调用者的 ecx 定——
  item walk 的 seek 调用给的 = 玩家 **+0x2b4 碰撞中心**；端口 p.x/p.y = 同一碰撞中心（hit 测试/dot
  绘制同源）→ **目标场两侧一致，无差异**。§AB 三处对拍的「目标场」项关闭。
- 新线索（下轮）：FUN_0040b460 返回的玩家位是**发布缓存**（FUN_0044d420 玩家 pass 重置、下帧发布——
  updateEnemies 头注释同机制）——若 item seek 读的是**上帧发布位**（一帧滞后），而端口读 live p.x/p.y，
  长弧 160 拍的角度差 = 6px 盒缘缺的候选机制。判据：DAT_018b896c（玩家 SHT/work 指针）与玩家位置
  全局（0x17d5ef8+0x2b4）的读写序（player pass 写 → item walk 读 = 同帧；或 item 读缓存 = 滞后一帧）。

### AC3. item seek 读源定案：live 指针、无滞后——f696 静态排除网正式全闭（零 src 变更）
- FUN_0040b460 = `return param_1`（纯 identity，无缓存/无快照）：item seek 的 `*(iVar1+4)` 读的是
  调用者传入的**玩家 live 位置指针**（+0x2b4 碰撞中心，玩家 pass 已更新同帧位）——**无一帧滞后**。
  端口 live p.x/p.y ≡ 同源 ✓。§AC2 的发布缓存滞后机制证伪。
- **f696 静态排除网正式全闭**：seek 律（逐拍 re-aim ✓§AC 实验）、seek 速 10.0 ✓、目标场 +0x2b4 ✓、
  角度扩展精度 ✓（4e1c3e8）、盒缘/包含性 ✓（pass-16）、舍入序 ✓（§S）、读源滞后 ✓（本节）。
  剩余：f696 首位移 = FPATAN 1-ulp（静态不可定案）+ 遥测盲区。**两面剩余差（st1 f6021、
  st2 f10058）归档为 f696 家族待原生遥测轮（用户下令重开 wine 时接续，接续点 = §AA/§AC3）**。

### AC4. var10017 自洽性审计首轮：f0 的值固定于记录武装拍（pre-7329），窗口需前移（零 src 变更）
- 实测：boss vars[9]（var10017）在 input 7329-9860 **恒 = 0.78539819（=π/4，零变化）**；
  而接触弹 f0=0.07447916 —— f0 的解析发生在**记录武装拍**（ins_111 执行时即解析 var → 模板记录存
  f32 值），不是 fire 拍。0x10 记录出自 sub26（pre-7329 的早期相位 arm）→ **f0 = var10017 在早期
  相位的值**。
- 审计窗口前移：var10017 在 Mystia 相位 1-2（≈input 4400-7330，sub17/sub20/sub26 的循环）的累加史
  = 下轮校验对象（同法 hook vars[9]，起 4400）。若端口累加自洽且与脚本常量序一致 → f0 宏观差为
  原生侧（f696 归档成立）；若发现异常 add/缺 add → 端口缺陷可修。
- 另注：var10017 在 7329 后 = π/4 恒定 —— π/4 写入点（某 id=25/ins_25 的一次性 set）本身是相位
  切换的标尺，可用于逐相位核对 var 快照。

### AC5. **var10017 自洽性审计破案：端口 f0=0.07448 与自身 var10017 不一致 = 端口侧缺陷确认**
- 正确预热（f=0 起跑）的运行：var10017 仅一次变化 **f5544: 0 → +π/4**，此后恒 π/4 至 9860。
  接触弹 f0=0.07447916 ≠ var10017 的任何历史值（0 / π/4）≠ 已知字面量（sub20 0.03、sub26=var10017）。
- **f0 的解析源本身就是异常**：该 0x10 记录的 f0 操作数要么是另一个 var（sub26 的 pm=0x20 → var10017
  之外的可能：sub24 的 pm=0x60 行 f0=var10017/f1=var10021 混淆？），要么 fireTh08Raw 的
  capturedVarRead 在 auto-fire 重放时解析到了错误上下文（capturedFireVars 切换路径）。
- 修复路径（下轮，无需 wine）：①dump 接触弹 exSlots 时同时打印该 fire 的 raw ins_111 映像（f0 原始
  位型）与 fireTh08Raw 的解析路径；②对照 native 捕获语义（all.c:12245-12253 捕获时 VAR 操作数已
  解析进映像 vs fireTh08Raw 的再解析）——pass-24 的 fireTh08Raw 注释自述「VAR 操作数已解析但存留
  var-id 位型需再解析」——**双重解析正是 0.07448 的候选产地**。
- 注：本会话曾两次踩「探针无预热」坑（pass-16 已入档），本轮 var17 首跑再犯——探针纪律第三次强调。

### AC6. f0=0.07448 异常的解析链定位（未完项精确化；零 src 变更）
- 已排除：var 10017（boss vars[9] 全程只有 0/π/4 两值，f0=0.0744 不在其中）；已知字面量（sub20 0.03）。
- 解析链事实：ins_111（eclvm case 111）的 f0 = gf(20) 在 **ins_111 执行拍**解析（var-id 10017.0 →
  vars[9]）→ 模板记录存 f32 值 → fire 时拷贝进 exSlots。f0=0.0744 ⇒ **执行该 ins_111 的实体的
  vars[9] 在执行拍 = 0.0744** —— 不是 boss（boss 的 = 0/π/4）→ **执行者 = 某使魔**（其 vars 继承自
  父 spawn 拍 + 自身累加——f0 的宏差 = 使魔 var 链的宏观差，源头仍可静态追：使魔的 spawn 拍继承值
  + sub26 循环的 adds）。
- 下轮：①确认 sub26 的执行实体（哪个槽/哪个 sub 调用它）；②hook 该实体的 vars[9] 全程，比对
  0.0744 的累加序 vs 脚本常量（同 §AC5 自洽性法）；③若自洽 → 差异在继承拍（父 spawn 拍的 vars[9]
  ——回到 boss 侧更早的窗口）；④修复后 formal gx st2/st1 当轮验收。

### AC7. var10017 真身定案：boss 的瞄准跟踪衰减累积器（逐帧衰减 ×≈0.92）
- varRead8 hook 直读：boss（e=38385 slot1 sub17）的 var10017 在 9855-9862 逐帧衰减
  0.1116→0.0955→0.0870（×≈0.92/帧）；接触弹 f0=0.07448 = 该衰减曲线 ~f9868 的值 ✓。
  （此前 probe-var17 的「π/4 恒定」读数 = 该探针的 end-of-frame 快照假象/实体歧义——作废。）
- **分叉机理浮出**：var10017 = boss 的瞄准跟踪衰减器（pass-21 的「a1≈−0.008 瞄准跟踪变量」本体！）。
  f0 = 衰减曲线在 arm 拍的取值——端口与原生的衰减**相位/初值**差 → f0 差 → 螺旋路径差 → 接触。
  衰减律本身（×0.92/帧）与初值是否一致 = 下轮对拍（native graze 零段 + f0 差已量化：端口 0.0744）。
- 下轮：①定位 var10017 的写入点（衰减 ×0.92 的实现 = 哪条 ins（id=71/ins_25?）——sub17/sub20 的
  id=71(0.03)/id=65(0.5) 链）；②对拍衰减初值/相位（arm 重置时机）；③修复后 formal gx st2/st1。

### AC8. var10017 衰减形状刻画（写入点定位的前置；零 src 变更）
- 实测衰减序列（9855-9862）：0.1116→0.0955→0.0870→0.0804→0.0745——**比值非常数**（0.856/0.911/0.924/0.927
  渐升）、**差值递减**（−0.0161/−0.0085/−0.0066/−0.0059）→ **非固定 ×0.92，是向 ~0.05-0.06 目标的
  渐近收敛**（跟踪环收敛形态：Δ = −(var−target)×k）。
- 语义定位：sub20 的 id=25(var10016 = var10048 + var10017) + id=71(0.03 → 角速度) + t=60 id=71(0)——
  var10017 = **boss 航向与瞄准角的跟踪误差**（the pass-21 「a1≈−0.008」同一变量的收敛过程）。
  端口的 mode-1 控制器（updateMovementController）angle += angVel×rate 线性旋转——**收敛（误差衰减）
  在脚本侧逐拍重算 var10017 实现**（sub17/sub52 的 id=25/34/39 链）。
- 下轮：①dump sub17 每拍块里写 var10017 的指令（id=25/34/39 的组合序）与端口对应 case 的舍入序
  对拍；②arm 重置时机（sub20 t=0 的 id=25 重算拍）；③若端口 case 25/34/39 的多变量表达式存在
  f64/x87 中间舍入差（多因子链——与单次乘加不同，这里可能有真差异）即为可修点。

### AC9. 写链定位接力：sub17 → ins_52(19)，var10017 逐拍写在 sub19 攻击循环（零 src 变更）
- sub17 = 相位 setup（ins_131(12000)/ins_134(1980,23)/ins_133 + 弹幕段 + op-75 rect），
  t=120 **ins_52(19) = CALL sub19** —— var10017 的逐拍衰减写在 sub19 的攻击循环里。
- 下轮第一步：dump sub19（及 sub21-23 若被其调用），定位 var10017 的逐拍写指令（id=25/34/39 链），
  对拍端口 case 25/34/39 的多变量舍入序 vs x87 ext 中间值——修复点假设不变（§AC8）。

### AC10. sub19 dump：var10017 的 ±0.79/0.39 扇形加与平滑衰减不符——写入点仍未定位（零 src 变更）
- sub19 攻击循环：t=140 块 = **id=7(var10017, −0.79/−0.39/0/+0.39/+0.79) 五连 + 五发 ins_91 使魔**
  （扇形展开、净和 0）——与实测的平滑逐帧衰减（~−0.006/帧）不符。
- 另发现：sub19 的 12 发 id=7(var10018, ±0.16) + id=25(var10016 = var10048 + var10017 + 1.57) +
  id=135(0,18)（**子上下文 18！**）+ id=67/ins_65(var10016, 0.5) + ins_2(40/120/60...)——
  **var10018 = 另一个 ±0.16 摆动累积器**（pass-21 的 var10048 家族邻接）。
- 下轮：**varWrite hook**（hook varWrite8/varWriteInt8 的 vars[9] 写入、打印调用者 e.id/sub 与写入值）
  ——直接定位平滑衰减的写入者；若无 ECL 写入者 → 衰减来自端口内部某处对 vars[9] 的直写（缺陷）或
  var 身份映射错位（vars[9] 被两条路径共用——检查 10016-10023 的读写映射是否与其他系统冲突）。

### AC11. **写入者找到**：boss 自身 ECL 逐帧 varWrite8（渐近收敛律）；f0 = arm 拍的收敛值（零 src 变更）
- varWrite8 hook（9855-9865）：boss（e=38385 sub17）**每帧一次** varWrite8(10017)：0.7854→0.1117（首写
  跳变 −0.6737）→ 0.1058→0.1005→…→0.0726——**渐近收敛**（delta −0.0058→−0.0013 每帧缩 ~0.0005，
  极限 ~0.05-0.07）。f0=0.07448 = **收敛值在 arm 拍的取值** ✓。
- 写入者 = boss 自身 ECL 的收敛指令（case 7/25 族——var 解析 arg 的多变量 add）。端口逐帧写一次 =
  原生逐帧一次 ✓ 结构对齐。**最后未查的舍入面 = 该收敛表达式的中间舍入序**（case 7/25 的 f64 vs
  x87 ext——多变量表达式，与单次乘加不同，这里中间量化差异可能真实存在）。
- 下轮：①dump boss 每拍块里写 var10017 的确切指令（sub19/sub52 的 id=7/25 行的 f0/f1 原始操作数）；
  ②对拍端口 case 7/25 的算术序（`(var−target)×k` 的中间舍入）vs x87；③修（如 angle/speed 域的
  ext 保持）→ formal gx st2/st1 当轮验收。

### AC12. sub18 = 逐拍收敛器全解（findings §AC 链终点；零 src 变更）
- sub18（sub19 的 id=135(0,18) 每 40 拍重挂的子上下文）= **自跳循环**：id=5 jumpRank(0,−276,var10036)
  每 tick 重跑 t=0 块——含 **id=6(var10036, 16/32) 圈条件重置**、**id=7(var10017, 0.08/0.09/0.10/0.12
  rk 分难度——Lunatic +0.12/tick)**、**id=111 重挂 0x40{0,0,60,1} 与 0x10{f0=var10017, limit 60}**、
  id=15(var10016=var10018)、**id=16(var10017, var10020)**、id=16(var10020, 0.0046875?)、id=97×4
  捕获火（flags 0x22252）。实测衰减（0.1117→0.0726，delta 渐缩）= 循环净效应（+0.12 与 ins_16 移动
  的合成）。
- **端口 case 7/15/16/5 对拍 = 最后的舍入面**：ins_16 的语义（减？移？）、ins_15/16 的 f64 vs x87 ext、
  jumpRank 的圈条件比较——任一偏差即 f0 宏观差的产地。修后 formal gx st2/st1 当轮验收。
- 方法注：本链（§AC-AC12）九轮差分把「f0=0.0744 异常」从"遥测盲区"剥到"sub18 逐拍收敛器的
  端口实现"——全程零 wine、每步实测锚点。

### AC13. sub18 循环全解 + 端口 case 15/16 结构对齐确认（零 src 变更）
- 循环净效应解码：var10017 += 0.12（Lunatic 行）；var10017 −= var10020；**var10020 −= 4.6875e-4**
  （sub26 转储里 f:0.00 的 0x39eeeeef——%f 显示吞了真值！）→ var10020 线性降到 0.12 → 净变化 → 0
  = 实测渐近收敛 ✓✓（delta 每拍缩 4.6875e-4 与实测 ~0.0004-9 吻合）。
- 端口 case 15/16 = 复合赋值 `cur op= rhs` 单次 fround ✓ 与 x87 单 store 对齐；case 25/26 = dst 单次
  fround ✓。**结构面无缺陷**。
- **剩余唯一面：case 5 jumpRank 的圈条件**（id=5(0, −276, var10036)——var10036=16/32 时的跳/停语义、
  以及 sub18 重挂周期（sub19 每 40 拍 id=135）与 var10036 重置的交互）。f0=0.0744 的宏观差若不在此，
  则为原生侧 var 遥测盲区正式归档。下轮：读端口 case 5（jumpRank 三参比较序）+ 原生 ins_5 的
  asm 语义对拍。

### AC14. jumpRank 对拍完成：端口 case 5 语义忠实、sub18 循环 law-faithful——f696 静态攻坚最终定案（零 src 变更）
- 端口 case 5 = 「递减 var 并在正时跳回」：var10036(Lunatic=32) 每 tick −1，正则跳 −276，≤0 落出
  （ins_53 return）→ **sub18 每 burst 32 tick，sub19 每 40 拍 id=135 重挂** ✓ 与实测平滑衰减的分段
  形态吻合。每 tick：var10017 += 0.12 −= var10020；var10020 −= 4.6875e-4——渐近衰减定量吻合 ✓。
- **f0=0.0744 = 端口对脚本的忠实执行结果**（非缺陷）。与 native 的 ≥34px 分叉 = **var10020 初值/继承
  链在更早相位的差**（sub18 的 vars 继承自父 spawn 拍；继承链回溯至 Mystia 相位 1 的 var 状态）——
  该链与 f696 家族（RNG/collect 相位差）汇合，静态侧无更多可检点（玩家位 px/py 已遥测对拍、
  seek 律/速/盒/角度/舍入全部逐支验证）。
- **最终归档**：两面剩余差（st1 f6021、st2 f10058）= var 继承链的早期相位差（f696 家族），修复需
  原生遥测定位首位移（wine 轮由用户下令）。接续点：§AA/§AC3/§AC14。审计链 §F-AC14 完整。

### AC15. **发现未被排除网覆盖的分支差异：state-0→1 切换缺「计时器停止」子句**（零 src 变更）
- 原生 walk 主体 state-0 掉落段（all.c:31140±）：`vy += 0.03×rate; if (vy > 0 || FUN_004066a0(0) != 0)
  → state = 1`——**第二子句 = FUN_004066a0(0)：计时器 deadline<0（未武装/已耗尽）→ 立即入 seek**。
  端口 switch（stage-scene 5576）只有 `if (it.vy > 0) it.state = 1;`——**缺该子句**。
- 机理：落下计时器未武装/已耗尽的 item，原生在生成/耗尽拍即入 seek（起始位=生成位），端口等 vy>0
  （晚 ~73 拍的抛物线顶）——**seek 起步位差 = f696 slot8 的 6px 盒缘缺与 ±4 checksum 缺的静态成因**，
  pass-16/18 排除网（盒缘/seek 速/长弧/vy0）确实未覆盖此分支。
- 修复（下轮第一项）：①映射 item 的落下计时器字段（+0x2c8 ↔ 端口 item 的哪个域；spawn 时 armed
  条件）；②switch 补第二子句；③formal gx st2/st1 当轮验收 + ly 双面（item 全体 state 时序变化，
  需全面回归）。

### AC16. 第二子句细化：native switch = 「vy>0 || 0<item+0x2d0(deadline)」——arm 点审计为前置（零 src 变更）
- 构造器（FUN_004400a0 @30805-30812）：**FUN_004065f0(0)** = 计时器 STOPPED（deadline=0）+ vy0=−2.2
  （0xc00ccccd ✓）+ state=param_4（出生 state 可直接 1）。FUN_004066a0(0) 的真读 = **0 < deadline**：
  deadline>0（已被武装）→ 立即 state=1；deadline=0（新 spawn）→ 等 vy>0（普通掉落）✓。
- **修正 §AC15 的表述**：缺的不是无条件子句，而是「**item 的 +0x2d0 计时器被谁以正 deadline 武装**」
  ——武装点（FUN_004065f0(deadline>0) 对 item 计时器的调用者）= f696 slot8 是否属于该类的判定前提。
  候选：道具被玩家 bomb/poc 相关路径武装的 autocollect 延迟、或 item 间传递。
- 下轮：①追 item+0x2d0 的全部写点（FUN_004065f0/FUN_00406610 的 item-timer 调用者）；②对 f696
  slot8 判定其 deadline 状态（若 armed>0 → 原生在生成拍即 seek = 6px 缺根因 → 端口补计时器建模）；
  ③修复 + formal 全套当轮验收。

### AC17. 第二子句解读出现歧义：FUN_004066a0(0) 的真值重decode后，switch 块的所属路径待重审（零 src 变更）
- FUN_004066a0 = `param_2 <= *(this+8)`：call(0) = `0 <= deadline`——构造器 deadline=0 → **恒真**——
  若该 switch 块在普通掉落路径上，所有 item 立即 state=1，与观察到的掉落弧矛盾 → **该块的所属
  条件路径未定**（可能是特定 item 类/gate 的分支，或 decompile 的 this/arg 又一次丢失导致参数序
  误读——FUN_004066a0(0) 的真参可能是 deadline 域之外的值）。
- 结论：§AC15 的「缺第二子句」**降级为未定案**——实施暂停是对的（避免又一次盲改回归）。
- 下轮：①asm 级重读该 switch 块的完整前置条件（walk 主体 0x440a00-0x440c37 区间的条件链）；
  ②或用 var17 类实测 hook（item state 迁移的实测拍位）反推真实迁移条件；③定案后二选一：修复
  或 f696 归档成立。

### AC18. §AC17 歧义定案工具判定：decompile 不可靠，需 objdump asm 重读（零 src 变更）
- FUN_004066a0(0) 的真参/真 this 无法从 all.c 的 C 伪码定案（本会话已三次证实该导出的 this/arg
  丢失会造成误读：FUN_0040b460 系、FUN_004065f0(0)、FUN_004066a0(0)）——**该块（walk 主体
  0x440a00-0x440c37）的定案需要 objdump 反汇编按寄存器读**（ecx/edx 的真实来源与比较方向）。
- 下轮（用户同意后）：objdump -d --start-address=0x440a00 --stop-address=0x440c37 逐指令读
  state-0→1 switch 的条件链与 FUN_004066a0 的真参 → 定案后修复或归档 → formal 当轮验收。
- f696 静态攻坚维持「§AC14 定案 + §AC15/16/17 待 asm 复核一项」状态。树干净、门禁全绿、
  216 测试、零未记录变更。

### AC19. **objdump 定案：item 运动是单状态模型——端口的两态拆分是结构性再解读**（零 src 变更）
- asm 直读（0x440500-0x440c40）：①`FUN_004066a0` call₁ = ecx=item+0x2c8/param 60（state-2 tween 的
  60 拍测试）；②call₂ = **ecx=0x18b89bc（全局落下计时器）/param 0 → `0<=deadline` 恒真**——
  state-0→1 switch 在此路径**无条件**触发（普通生成 deadline=0）。
- 构造器：全部 item 出生 **state=param_4（通常 1）、vy0=−2.2**；state-1 内含重力尾（vy += 0.03×rate、
  3.0 cap）+ **逐拍 FUN_0044c1b0 re-aim**——**原生 = 单状态（re-aim + 重力 + cap 同在 state-1）**；
  端口 = 两态拆分（state-0 纯重力无 re-aim → vy>0 → state-1 re-aim 无重力尾）——**结构性差异**：
  长弧上端口在 state-0 段不 re-aim（native 每拍都 re-aim）= 6px 盒缘缺的真根因。
- **修复 = item 运动状态机重构**（state-1 合并重力尾与逐拍 re-aim、state-0 仅存于特殊生成）——
  大改，需独立轮 + 全量 formal（gx/ly 四面 + 216 测试）验收。下轮第一项。

### AC20. §AC19 修正：walk 主体只有一个 FUN_0044c1b0（arm）——原生 state-1 = 「arm 定 vx + 逐拍 vy 重力律」，非逐拍 re-aim（零 src 变更）
- grep 全量：FUN_0044c1b0 的调用点在 item walk（30906-31400）内**只有 31064 一处**（PoC arm）。
  §AC19 的「逐拍 FUN_0044c1b0 re-aim」是未经 asm 钉死的推断（24036 处 = 弹的 0x80 aimed dir-change，
  另一函数），**作废**。
- 修正后的原生 state-1 模型：**arm 拍 FUN_004286e0(atan2-to-player, SHT speed) 定 vx/vy 一次；vx 保持；
  vy 逐拍走重力律（player.y≥阈值 → vy=3.0 cap，否则 vy += 0.03×rate）**——轨迹 = x 匀速 + y 重力弧。
  端口现行 = 逐拍 re-aim（追踪曲线）→ 长弧分歧 = 结构差 ✓（与 §AC19 的结论方向一致但机理修正）。
- **先前 entry-aim 实验失败的根因也定了**：只去掉 re-aim 而未补 state-1 的 vy 重力律（vy 冻结在
  arm 值）→ 轨迹既非追踪也非重力弧 → 双面回归。**正确的重构 = arm 定 vx（保持）+ vy 逐拍重力律**
  ——两处改动必须同时落地。
- 下轮：精读 walk 主体的 state-1 逐拍 vy 块（阈值 0x4b42dc 的语义：player.y 还是 item.y 的比较、
  3.0 cap 的域），实现 arm-vx + vy-gravity 模型，formal gx st2/st1 + ly 全量当轮验收。

### AC21. 精读定案：**端口逐拍 re-aim 正确**——PoC-arm 块即逐拍 re-aim（符合 arm 块每拍重跑）；§AC19/20 重构计划取消；f696 定案回归 §AC14（零 src 变更）
- walk 主体结构精读：PoC 条件（player.y ≥ PoC 线 + power≥128）成立时，**arm 块（FUN_0044c1b0 atan2 →
  FUN_004286e0 极速度 → state=1 → move → collect test）每拍重跑** = 逐拍 re-aim ✓；PoC 条件不成立
  （玩家在线上方）→ vx=0、vy 钳 −2.2、纯重力下落（无 re-aim）。
- **端口现行 state-1 逐拍 re-aim 与原生一致** ✓——§AC19/§AC20 的「结构性缺陷/重构计划」**作废**
  （那两次把 24036 的弹 aimed-dir-change 与 31064 的 arm 混为一谈；entry-aim 实验的回归也因此
  合理：它去掉的是正确的逐拍 re-aim）。f0=0.0744 分叉定案**回归 §AC14**：var 继承链早期相位差
  （f696 家族），静态侧穷尽，修复需遥测轮（用户下令）。
- 本会话审计链 §F-AC21 最终状态：**两次根因修复落地（+1805）**、七次受控实验全部留痕、
  f696 家族归档定案（§AC14 + 本节修正）、树干净、216 测试、门禁全绿。

### AC22. var10018 审计：自洽 ✓（±0.157080 交替、Δ=π/10 整、相位对齐）——var 链静态审计完成
- var10018 的 ±0.16 摆动 = 逐 volley 的瞄准扇摆（脚本常量 ±0.16，Δ=π/10 整），端口执行与脚本完全
  自洽，无异常 add/缺 add → **var 链静态审计全部完成**（var10017=衰减器归 f696 遥测边界、
  var10018=自洽）。
- **决策点（请用户下令）**：两面剩余差（st1 f6021、st2 f10058）= f696 家族 var 继承链早期相位差，
  静态排除网已穷尽（§F-AC22）。二选一：①**重开 wine 遥测轮**（获取原生 item/var 遥测定位 f696
  首位移——用户下令即接续，接续点 §AA/§AC3/§AC14/§AC21）；②不开 wine → 剩余差作为已知边界归档，
  转向其他未收尾项（呈现队列：boss 名牌/雾效/弹渲染比例、st1 sub21 一步墙的弹 pass 积分计数——
  同属精度家族但独立可试）。

### AC23. objdump 定案弹移动律：pos += vel 每 pass 一次（asm 级）——st1 一步墙归档为擦弹 razor 精度边界（零 src 变更）
- asm 直读（0x43149b-ae）：`FUN_00410a70(ecx=item+0xd44(pos), arg=item+0xd50(vel))` = **pos += vel
  每 pass 恰一次**——端口单次积分 = asm 级正确；state-2 的 FUN_0040c7d0 缩放爬行亦 asm 对齐 ✓。
- **st1 一步墙的静态排除至此 asm 级完备**：积分律 ✓、fire tick（clock 对齐 ✓）、速度（格点 ✓）、
  盒（✓）、舍入（§S ✓）、时钟模型（三次证伪 ✓）。剩余唯一假说 = **擦弹 razor 精度边界**：
  pass-19 遥测的玩家位 ±0.005px 舍入 + 盒缘恰在边界——正式 undecidable without native 弹遥测。
- st1 sub21 一步墙归档（与 st2 f10058 同状态）：修复需 wine 遥测轮（用户下令；接续点 = 本节 +
  §AA/§AC21）。本会话静态攻坚正式收官：两面剩余差均已 asm/遥测边界定案，零假收敛、零未记录变更。

### AC24. objdump asm 级定案 state-0→1 switch（寄存器级完整；零 src 变更）
- asm（0x44069e-0x440728）寄存器级真读：
  `vy += 0.03×slowmo`（0x4b5b38 × 0x17ce8e0，fstps item+0x2b4）；
  `if (vy > 0) → state=1`（test 0x41 = C0|C3：vy≤0 才走 FUN_004066a0）；
  `else if (0 <= *(0x18b89bc+8)) → state=1`——**FUN_004066a0 的 ecx = 全局 0x18b89bc（非 per-item！）**；
  side-2 复位（vy=−0.7/vx=0）✓；jmp move（0x440936）。
- **新机制假设：0x18b89bc = 全局 homing 配额门**（+8 = 剩余配额；walk 每 item tick 递减——LAB_00440c37
  的 FUN_00406640）——**seek 资格由全局共享配额决定**，端口模型完全没有此机制。这是 f696 slot8
  6px 盒缘缺的最强静态解释（配额耗尽顺序决定哪发 item 先失去 homing——与 f696 的 ±4 checksum
  缺同拍出现）。
- 下轮：①追 0x18b89bc 的初始化/重置（玩家 pass？相位入口？）；②建模配额门 + formal 全套当轮验收；
  ③若配额模型证实，f696 归档撤销、两面剩余差可修。

### AD2. wine 弹遥测轮（2026-08-30，用户下令轮）：三修复 + 两面墙根定位
工具：tmp/wine-bulcensus.mjs（th08winedop 容器内跑，全池 1536 弹槽 + 全道具池 + 玩家逐帧，
窗口 WIN=env；数据 tmp/wine-out/*.jsonl）。draws 与 rng-curve 434/440 帧精确（6 帧 mid-pass）。

**修复 1（38c64dd）addTimeOrbs 奇偶（all.c:10245 asm 级）**：total(+0x44) 先加、pv(+0x24) 后读
新 total 奇偶 → 单 orb 在奇数 total 付 +10（原生 f630 首收 pv=300010）。port 旧读奇偶付偶数。
pv 曲线全段修复。

**修复 2（38c64dd）pointStar=道具 case 6 收集律（all.c:31029-31040）**：固定
award = trunc(graze/40)×10+300（RUN+0xc = graze 第二副本，all.c:36822 写入；封顶 999999），
specialScoringMode（DAT_018b8974）≠0 时恒 100。无 pv/PoC/校验和/rank。port 旧走 pointSmall
pv 阶梯 + 极人侧 ×2（st2 f707 付 3124 vs 原生 ~40）。st2 内容首分叉 f707→f1084。

**修复 3（38c64dd）FIRE rank-lerp 的符卡 gate（asm 0x4229b7 钉死）**：
`mov $0x4ea670,%ecx; call 0x4178a0; test; jne` —— count1/count2/speed1/speed2 的全部
rank-lerp（all.c:16012-16033）只在符卡宣告位（0x4ea670 bit0 = FUN_004152a0 设置）清零时
施加；符卡期间 authored 平坦。wine 证据：sub24 的 123 发 midboss 齐射原生全体速度恰
3.0/2.5/2.0/2.1666/1.3333，port 旧值 2.9625…（lerp −0.0375）。修后 f3650-3660 全弹田
322 发偏移 ≤0.01px（修前 123 发 >0.5px）。**pass-20 的「±0.15 lattice proof」被推翻**：
该证明的二选一（±0.15 vs ±0.5）漏了第三种可能（符卡期间不 lerp）。
**formal：gx st1 f6021→f7499（+1478）；gx st2 f10058→f9253（合法重掷，gate asm 钉死）；
ly 双面平。**

### AD3. 遗留方法论定律（本轮钉死，防再踩）
- **census bullets 字段不可作弹数 oracle**：只数 0-95 槽（分配器指针出窗即漏）；f585/f880
  的「弹数分叉」全是窗口伪影。全池 wine 遥测是唯一可靠弹 oracle。
- **wine/census 行是 mid-pass 采样**：f4122 的「port 清弹早 1 帧」实为原生同一 pass 的
  259→215→0 中间态被截获（两侧死亡同拍）；敌人死亡行的 ±1 歧义（f918/f1835）同源。
  判据：分叉若只在「死亡/清场拍」出现且次帧回归 → 采样伪影。
- **+0xd42（弹 sprite 字节）≠ port bullet.sprite**：f640 窗口 spr4→spr2 但位置/速度
  off=0.00 完美 —— 字段语义不同（firefly spr3 撞同纯属巧合），勿再当缺陷。

### AD4. 两面新墙（下一步的靶）
- **st1 f7499 墙根 = f3664 单弹单拍冻结（pass-21 一步墙的真身）**：firefly 弹（spawnF 3473,
  slot1）原生在 f3664 整体冻结（timer 223 不减、位置不动），f3665 双步追上（vx +0.00582 =
  2×增量）。port 平滑推进 → 0.21px 起 drift → f3669 计数分歧 → 下游全面重掷。该弹非
  sub24 齐射成员（firefly 系），与「fresh volley +1 step」(pass-21) 同族反向：
  弹 pass 的逐弹 tick 记账（FUN_00431240 真身/队列 walk 顺序）里有条件性跳步。
  接续：读 0x431240 区 asm 的 walk 循环 + 该弹的 ins_111 队列状态。
- **st2 f9253 墙 = 重掷后的新前沿**：f8950 时 port 弹田 0（敌人停火）vs 原生 511 ——
  port 的 Mystia 时间线在 ≤8790 深度分叉。敌人 census 干净 ≥f2968，弹面首分叉未知。
  接续：wine 窗口二分 st2（建议先 f3500-4200 覆盖首个符卡段）。

### AD5. §AD4 修正（同轮，容差扫描）：f3664 跳拍 = mid-pass 伪影；st1 真分叉 = f5911 扇形瞄准基角
- 弹 walk 顺序 = **0, 1535, 1534, …, 1（降序，slot 1 最后）**——mid-pass 行恰在 slot 2/1 之间采样时，
  低槽号弹显示"冻结一拍"而高槽号已更新（f3664 证人 s1 冻结 + s238 已动 = 完美吻合）。
  容差判据（probe-driftscan2.mjs）：native 弹匹配 port 位置**或** 位置−速度（前一拍）；
  3 行持续失败才算真分叉。**修后 st1 弹田 f3650-3800 全精确。**
- **st1 真分叉 = f5911**（Wriggle 战）：sub25 的 14 发扇形齐射 —— 速度 0.7626 全同、步长
  0.1428 全同、张角 1.90 rad 全同、数量全同，**但扇心差 0.1104 rad（原生 π−0.0007 ≈ 正左，
  port π−0.1111）**。纯瞄准基角差 = ECL var（aim 系）状态差 = §AC14 var 继承链家族的
  具体化身。下一步：wine 轮抓 boss ECL ctx var bank（enemy mgr 0x577f20 + ECL ctx
  +0x2ca0 内的 float bank）f5800-5920，对拍 sub25 的角度 var 历史；或静态审计 sub25
  的 var 写入链（±0.16 摆动/收敛器）在该相位的取值路径。

### AD6. f5911 双扇细节（接续 §AD5 的靶心）
- 开火者 = **sub27**（boss 本体，pos (192,128)）：两发 count1=7/count2=1 的扇（共 14），
  speed1=0.7625→speed2=0.4812 阶梯、angle2=0.1428、spr=2、flags=0x252。
- port 解析 angle1 = 0.9557 / 2.0029；由实测弹角反推原生 angle1 ≈ 1.0647 / 1.9687
  （两扇各自独立差 −0.109 / +0.034 —— 不是单一旋转）→ angle1 的 var 表达式取值在
  两侧已不同 = §AC14 var 继承链（var10016/10017 aim 族）在 st1 Wriggle 相位的具体差。
- 下轮打法：wine 轮抓 enemy ECL ctx 的 var bank（enemy+0x2ca0 ctx 内 float 槽）逐帧，
  f5800-5920，直接对拍 var10016/10017 的历史首差；或先静态列 sub27 angle1 表达式的
  全部 var 写入者（sub26/27 的 id=7/id=15/16/25/27/28 族）。

## Pass 27（2026-08-30 继续轮）— f4122 清算分叉首破：主尾 orb=挂账簿×2 + 四重区让弹；f5911 扇角根因定案为流分叉下游
### A. 台账方法修正：dump-sub25.mjs 漏读前 3 参数 word
- 旧 dump 从 ins.args+12 起 print（ins.args 本就是参数块起点）→ 每条指令漏前 3 word、paramMask 未显示。
  已修（k=0 起 + pm 标记 V{}）。此前基于旧 dump 的参数归属推断作废。
### B. sub27 双扇 var 链全解（f5911 靶心的静态答案）
- sub27（Wriggle boss 本体火控）：t=30/110/180 三块重算 var10016 = var10082(rand angle, 2 draws)×**0.04**
  + 常量（t=30/t=180 块 +=**π/3** / t=180 +=**π/4**；t=110 块 −=**2π/7**）；var10017 = var10016 ± π/3（id=25 加 / id=26 减）。
- FIRE id=96 参数实为 [sprite|offset, count1=var10000, count2, speed1, speed2, angle1=var10016/10017, angle2, flags]；
  pm=0x44 = {count1, angle1} var 引用（spec 0x5f §96-104 的 var-resolve RNG 次序表）。
  angle2 族 = π/22,20,18,16；speed1 族 = 0.8,1.2,1.6,2.0；count1=7（var10000 被 t=30 四连写 2/4/5/7）。
- 原生 f5911 实测（wine st1c）：14 发 headings 步长精确 π/22、扇心 = aim±π/3（玩家 (194.5,259.3)，muzzle≈(194,128)
  → aim≈π/2，var10016_native=π/3 整、var10017=2π/3）→ **native 的 var10082 抽取值≈0（小偏差内），port 抽到 −2.29** ——
  纯 RNG 流值差，不是 var 语义差。§AC14「var 继承链」在 st1 的化身 = f4122 流分叉的下游。
### C. 流分叉根因链（draws 对拍 rng-curve，f2700 ±4 瞬态回补后）
1. **f4122 单帧 −828**：中 boss（#15843, sub15）死亡。原生 = tier orbs(5 子×20, n<8:n*2+10, stage1-3 走 else 支——
   FUN_0042f270/230 都要求 stage≥4) + **主尾 = +0x3380 挂账簿×2 个 type-7 orb**（all.c:20533 字面 `ledger*2`，
   FUN_004400a0(pos,7,1)→强制 state3 → 每 orb 8 draws：radius f()×2 + angle f()×2 + spawn vy/vx f()×2）。
   port 旧代码用活子链×2（5×2=10）→ 少付 ~126 orb。**修复：tailOrbs = attachCount×2** → f4122 缺口 −828→−4。
   port 精确账：100 tier + 10 旧尾 + 1 shot = 111；原生 100 + 136(账簿68×2) = 236（wine 7/3 计数逐项吻合）。
2. **f4123 −252（修后过冲 +216）**：死亡清算的四重转换区（每子 r32 g2 f8 + 主 r32 g1 f16, FUN_0044df00）在
   FUN_00430aa0 全场清扫**之前**吃掉区内弹（原生 57-63 发 → time item；余 209 发 → pointStar state1）。
   port 旧序清扫先吞全场 → 区饿死（273 pointStar vs 209、零四重 orb）。**修复：清扫循环跳过活跃区内弹**
   → pointStar=209 精确对齐；但 port 四重仍过转换（~111-160 vs 63，疑双重转换：spawn-transition 递延臂 +
   normal 碰撞块各付一次），残余 +216。
3. **f4136+ 每 poll −52**：**boss 死亡环绕发射器完全缺失**。原生：一个带预算(+0x10)的对象沿轨道运动，每 tick
   发 min(budget,7) 个 type-10 orb（0x4175f6 循环，FUN_004400a0(pos,0xa,0)→强制 7/5，每 orb 4 draws），
   实测 13/帧 × 34 帧 ≈ 442 orb ≈ 1768 draws（wine 7/5 族 f4132-4165 增长 +13/帧、同帧 13 个同点位堆叠）。
   port 零实现。预算来源/轨道方程（0x417400 函数族，常数 0x4b4390/0x4b4460/0x4b432c/0x4b4468）待解。
4. **账簿加记节律**：port attachCount 纯加记 46（每 ~18.2f 一次，零减记），原生 68（~10.5f 一次）——ins_92
   生成循环节律族（sub16/39，疑 §AC14 子上下文时钟家族同源）。加记差异 = 尾 orb 44 个 = 176 draws。
### D. 复测（两修复后）
- check/build/test 216 全绿（两次修复分别过门禁）。**最终 gx st1 f7499→f7413**（单修复1 时掉到 f6790，修复2 拉回
  +623 —— 修正流上的重掷：流仍因 C2/C3/C4 分叉，前沿数字在流闭合前无意义）；**gx st2 f9253 / ly st1 f3177 /
  ly st2 f3471 全程持平（零回归）**。已提交 1bf6272。
- 弹→item 转换类型确证（asm 0x430b25/0x42f396）：FUN_00430aa0 else 支 = mgr+0x6ba570（init 写 6=pointStar），
  ==2 支 = DAT_018b8988（恒 0）→ **弹→pointStar state1 零 draws，port 原模型本就正确**（此前「time item」猜想作废）。
### E. 下轮队列
1. **死亡环绕发射器**（C3，最大单块 ~1768 draws）：解 0x417400 函数族的预算来源（疑 = 死亡清算某计量）与轨道方程，实现
   type-10×min(7,tick)×2-tick。
2. **四重双重转换修正**（C2 残余 +216）：跳过弹的转换路径只付一次（normal 态弹单付）。
3. **ins_92 生成节律**（C4，44 orb）：sub16/39 循环时钟对拍。
4. st2 墙（f8950 敌不开火）维持 pass-26 判断：先修完 st1 流（st2 的 Mystia 清算同族缺陷会同步受益）。

### F. st2 墙根因链（同轮后半，draws 对拍定案）
1. **st2 RNG 流全程精确**（f86-f9300 对 rng-curve 逐帧：恒定 −393988 偏移=st1 结转，速率零偏差）——
   **st2 f8950 墙与 RNG 流无关**，是纯相位/门控缺陷。
2. **墙 = Mystia 12000 池清空后的相位链**：sub17（12000 池,ins_133(0,1500,23)/ins_134(1980,23)）池空 →
   死亡回调 → **sub22**（ins_123 结符、ins_127(0) 注册、ins_131(**18200**)、t=161 ins_4(61,0) **自跳停泊**）。
   port 与原生都进了 sub22、18200 池都设了——结构对。但 port 侧：
   a. **Mystia 不再掉血**（f7500-8900 hp 恒 18200；原生 18200→790→611 持续掉）。原生射击伤害门 =
      **flags bit2 (0x4)**（all.c:21449 `(flags>>2&1)!=0` 才进 FUN_0042c290/FUN_00451670 射击块；外门 bit4/bit5/bit11
      全清）。port 读的是 bit3 (0x8)。sub17 头 ins_80(22)（bits1,2,4 → flags2=0,flags3=0,flags28=1）两个位都清了；
      原生靠什么重开 bit2 待查（疑符卡宣告/死亡回调链或子上下文 ins_87 写注册位）。
   b. **妖精流消失**：原生整个 18200 相位持续刷新 4×HP50 妖精（census slots2-5，eclT 间距 60，持续到 stage 尾）；
      port 零生成。port 的 Mystia 探针显示 **ins_135 子上下文 ×2 卡死在 t=1**（sc?t1）——即 pass-21/§AC14 的
      「子上下文 t=1 必须 creation+1 触发」时钟墙的 st2 化身：**st2 最终相位整个被这堵墙冻住**。
3. 移植层两个待修：①射击伤害门位 = flags bit2（asm 钉死）vs port bit3 —— 需全面审计（216 测试可能钉了 bit3 行为）；
   ②timeline 生成抑制 vs boss 注册期（port 「spawn ops drop while a boss is registered」把妖精流杀了？妖精也可能
   是 sub60（sub22 t=0 ins_64 的子）驱动的 —— 两说都要对拍）。
4. **优先级判断**：修 ②子上下文 t=1 时钟墙（pass-21 遗留）= st1 sub21 墙 + st2 终相位的公共根；修 ①伤害门位
   = Mystia 18200 池可被打掉 → 相位链继续 → f9253 前沿推进。

### G. pass-27 最终四前沿与提交
- 提交：1bf6272（两修复）+ 0a7e1f7（AGENTS）+ a4c1594（HANDOFF）。
- formal：**gx st1 f7413** / **gx st2 f9253** / ly st1 f3177 / ly st2 f3471；216 测试全绿。
- 下轮入口（按杠杆序）：①st2 子上下文 t=1 时钟墙（F.2b，双面公共根）②st2 伤害门位 bit2（F.2a）
  ③st1 死亡环绕发射器（C.3）④st1 四重双付（C.2 残余）⑤ins_92 账簿节律（C.4）。

## Pass 28（2026-08-30 继续轮）— boss-death orbit emitter 半落地：asm 预算/双 128px burst/1/16 easing；442-item native 计数 vs asm debit 仍矛盾
### A. 当轮基线
- pass-27 复核：gx st1 f7413、gx st2 f9253、ly st1 f3177、ly st2 f3471。
### B. 静态钉死（FUN_004161b0 + FUN_00416b90）
- `004161b0 @ 0x4162ae-0x416347` 写 captured-card tail 预算：
  - Last Spell（enemy flags bit27）=700；
  - 否则 `lateGate = timeLimit - trunc(timeLimit/7)`，`elapsed>=lateGate→1000`，
    `elapsed<180→100`，中间 `100 + trunc((elapsed-180)*900/(lateGate-180))`。
  - gx st1 蛰符：timeLimit2100、spell elapsed787、native formula input797 → budget442。
- `00416b90 @ 0x41754b-0x4176ed`：actor/ease 后计算
  `angle = norm((timer-10)*2π/40 - π/2)`；两侧各 128px。第一组 spawn `min(budget,7)`
  个 type10，扣7；第二组 **字面循环6个**，但 asm 再扣 `min(remaining,7)`。
- wine item 反演（age0 position - velocity*0.9；Border moveRate=0.9）：
  f4132 中心 P=(250.78333,245.22059)，offset=(20.02360,126.42411)，两个 spawn base
  =(230.7597,118.7965)/(270.8069,371.6447)，port 修后逐项 f32 对齐。中心每拍向 live player
  close 1/16；f4132 起连续 13/frame。
### C. 实现（exact / §7）
- `startBossSpell` 现在携带 ins_134 timeLimit；capture 时 arm orbit emitter。
- 已实现预算公式、9 tick warm-up（f4123 capture → f4132 首 burst）、type10 state5
  7+6 spawn、双反向128px、中心1/16 player easing、native partial-debit bookkeeping。
- §7：(1) native presentation clock 比 bonus elapsed 快10拍的 writer 未定位，当前用
  `elapsed+10`；(2) effect39 actor 的 live transform 未建模，从 dying boss 标量位置 seed
  （gx witness 中心仍 exact）；(3) 1/16 easing 与 actor-age 两分支的映射未完全归一。
- 新矛盾：budget442 + asm 每拍 debit14 只会调用416次（32×13），但 wine f4132-4165
  显示442个 age0 type10。已按 asm 落地，未硬改成442调用；需下一步钉 timer/budget writer。
### D. 复测
- focused test 3条；`check/build/test` 全绿（225 tests）。
- formal：gx st1 f7413→**f7531**（f4123仍先分叉，接触帧只是合法重掷）；gx st2 f9253、
  ly st1 f3177、ly st2 f3471 全平。
- gx st1 clear-check 仍清关（f11369），下游 score/gauge/RNG 大差是 f4123 settle fork cascade。
### E. 本轮 falsifications（全部即时回滚）
1. 把 death-zone growth 提前到 managers 前：f4122-24 draw/item 完全不变。
2. 禁止 transition latch 的 same-tick second conversion：完全不变（该 witness 无相关 latch）。
3. 在 `th08DeathWipeBonus` 内即时支付 zone type：f4122 draw +64/native，f4123累计-188
   （原始+216），说明“全部 immediate”不是 native 时序； reverted。
### F. 新 frontier
1. **f4123 quad-settle** 仍是 st1 首个永久分叉：`sweepBulletsToItems` 当前对 zone-covered
   bullets 无条件双 time；native `FUN_00430aa0` 每弹先 `FUN_00449ff0`，zone 命中读
   player+0xe2a90 的 per-quad type。要把 immediate sweep 与 state5/normal 后续支付的
   per-bullet latch 时序拆开，不能再笼统 skip/all-pay。
2. orbit emitter 的442-vs-416调用矛盾（budget/clock writer）。
3. attach ledger 46-vs68。

## Pass 29（2026-08-30）— FUN_00430aa0 scored sweep：zone 原始 type 单付 + state5 固定槽保留
### A. 复核
- pass-28 基线复核：gx st1 f7531 / gx st2 f9253 / ly st1 f3177 / ly st2 f3471。
- port f4122 lane 仍为 pointStar214 + time235；f4123 `sweepBulletsToItems` 59 弹 ×2 =
  118 time / 472 draws，native 同帧只新增 63 type7 / 总 delta 256 draws。
### B. binary proof
- `FUN_00430aa0` asm `0x430b14-0x430b5c`：每個非零 bullet slot 先调
  `FUN_00449ff0`；返回2时把 `DAT_018b8988` 的 **raw quad conversion id** 传给
  `FUN_004400a0(pos,id,1)`，否则读 sweep table；随后 `0x430bb7` 写 bullet state=5。
- 这是 **每个 bullet 一次 allocator 调用**。`all.c:23531-23533` 的 type9→两颗 type7
  只属于 state-1 collision/transition arm，不属于本 scored sweep。旧 port 把该规则
  泛化到 sweep，是 f4123 +220 的直接根因。
- f4123 native 新 type7 共63；用 toss 首拍位置反演，与 port 当时 59 个 live zone bullet
  一一对应，剩余4个来自别的 settle lane（不属本 sweep 修复）。
### C. 实现
- `sweepBulletsToItems()`：按 native fixed-pool 顺序探测 active death zone；zone hit
  以 `TH08_ITEM_TYPE_BY_ID[convertType]` 单次 spawn（type9 也按 raw id=unknown9，不再双付），
  miss 才用 sweep table；每弹仍付 score popup ramp。
- 不再 `clearEnemyBullets()`；逐弹进入现有 state5/clear-fade 模型，保留固定槽和
  off-screen counter，由 bullet manager 的 removal ANM 释放。
- focused test `tests/th08-death-sweep.test.mjs`：type9 zone 单付 unknown9、miss 单付 time、
  两弹 popup 总额4020、bullet 不 dead 且 `clearFadeFrames=12`。
### D. 复测
- f4123 port draws `131240 -> 131480`（delta240），native `131244 -> 131500`
  （delta256）：原帧 +220 过付收敛到 **-16**；累计 `f4123 -20`（f4122 仍 -4）。
- `npm run check` / `npm run build` / `npm test` 全绿，**226/226**。
- formal（接触帧只是重掷）：gx st1 f7531→**f7411**，gx st2 f9253 平，
  ly st1 f3177 平，ly st2 f3471 平。
- gx st1 `--clear-check` 仍清关，但清关 replay frame 变为 **11561**（pass28 为11369）；
  下游 score/gauge/RNG 差仍是 f4123 residual 的 cascade。state5 固定槽占用是本轮
  binary-pinned 语义，不能为清关帧回滚。
### E. 新 frontier
1. f4122/f4123 仍有5颗 type7 / 20 draws 缺口：f4122 port time235 vs native236；
   f4123 native63中新59已由本修复覆盖，剩余4个（native slots1451/1575/1583/1586）
   加一颗 f4122 lane，需逐 slot 归因（transition double-payment / attach ledger 嫌疑）。
   同时 port pointStar214 vs native209（+5零draw），总 allocation 数已对齐到508。
2. orbit emitter 442-vs-416 调用矛盾不变。
3. ins_92 attach ledger cadence 46-vs68 不变。
4. state5 固定槽保留后 clear-check 晚192f；需用后续 native allocator/slot 曲线验证
   clear-fade duration 是否所有 sprite 均12拍，不得为清关帧硬调。

## Pass 30（2026-08-30）— f4122/f4123 death settle 全关：active-spell wipe gate + manager table id6
### A. pass-29 residual 重判
- pass-29 后 port f4122 `-4`、f4123 `-20`。对 native f4123 item allocation order 逐 slot 反演发现：
  **209 pointStar + 63 type7 是同一次 FUN_00430aa0 bullet-slot scan 的交错结果**，不是“两套后续 lane”。
  port 在 death tick 先把 214 个非 zone 弹转 pointStar、只留 59 zone 弹给下一 op123，是拆错时机。
### B. binary proof
1. `FUN_0041ed50` @ all.c:21661：
   `flags bit1 && FUN_004178a0()==0` 才调用 `FUN_00430aa0`。`FUN_004178a0`
   只是读 spell singleton bit0（all.c:9918-9924）。因此 captured/active spell 的
   mode-1 death 不做 shared wipe，保留全场到后续 op123/FUN_004161b0。
2. `FUN_0042f360` 初始化 bullet manager conversion table：asm `0x42f396`
   写 `manager+0x6ba570 = 6`。`FUN_00430aa0` 非 zone path 读该表，所以 miss
   item 是 **pointStar(type6)**，不是旧 port 的 time。
### C. 实现
- `th08DeathWipeBonus` 增加 native spell-singleton gate；active spell 全场保留。
- `cancelItemType` 由 time 改为 pointStar，对应 manager table 初始化 id6；
   zone path 仍优先使用 raw quad id。
- focused tests 更新为 table id6，并新增 active-spell suppression 回归。
### D. 复测（关键曲线全部 exact）
- f4122：port/native draws **1832**，items **254**；time lane 100+92+43+1=236 exact。
- f4123：port/native draws **256**，items **526**；op123 sweep **209 pointStar +
  63 time** exact。f4124-4163 的 wine st1c draw curve 归零（3918/4160-62 的
  ±4/±8 是已偿还 transient，4163 回0）。
- 新 first permanent divergence：**f4164 port -48**（native 80 draws vs port32）。
  这是 pass-28 orbit emitter 442-vs-416 调用矛盾的直接暴露：port f4132-4163
  32拍×13=416 calls 后 budget 用尽，native 继续付。
- `check/build/test` 全绿，**227/227**。
- formal：gx st1 f7411→**f7520**；gx st2 f9253、ly st1 f3177、ly st2 f3471全平。
- gx st1 clear-check 清关 replay frame **11210**（pass29 11561；下游差仍由 orbit fork cascade）。
### E. 新 frontier
1. **orbit emitter 442-vs-416**：现在 stream 前沿干净到 f4163，必须解码
   native 继续付税的 budget/clock/debit writer；不得硬编码442。
2. f4164 后 st1c 差异继续扩大（f4184 -1068），全是 orbit cascade。
3. st2 子上下文/终相位墙与 ins_92 ledger 仍在后续队列。

## Pass 31（2026-08-30）— orbit budget 442-vs-416 矛盾闭案：公式读的是 remaining timer，完整 native tail=683
### A. pass-28 结论纠错
- “wine 只见442个 orbit item”来自 **只看 f4132-4165 的截窗**。把 st1c 全窗口跑完：
  - f4132-4183 每拍 13 个，共 52×13=676；
  - f4184 最后 7 个（asm 结构为 first partial **1** + literal second **6**）；
  - **总数683**，f4185 后再无该 lane。
- 因此不存在 442/416 调用矛盾；矛盾根因是 pass-28 把 budget 公式变量看反。
### B. binary proof
- asm `0x4162ae-0x416338`：
  1. 两次 `FUN_0040d3b0(manager+0x114)` 读 authored limit，计算
     `lateGate = limit - trunc(limit/7)`;
  2. 三次 `FUN_0040d3b0(manager+0x108)` 读 **remaining countdown**；
  3. 分支/插值全部用 countdown，而不是 bonus elapsed。
- `manager+0x108/+0x114` 在 spell declare (`0x41542d/0x41544e`) 都由
  `FUN_004065f0(enemy+0x3378)` 初始化为 authored limit；+0x108 由 spell update tail
  递减。gx witness：limit2100、bonus elapsed787 => remaining1313 =>
  `budget=100+trunc((1313-180)*900/1620)=729`。
- `729 = 52×14 + 1`；调用形状正好 52×13 + (1+6)=**683**，与 wine 全窗口逐帧/总数 exact。
### C. 实现/复测
- orbit budget 改为 `timeLimit - spellElapsed` 的 countdown 插值；去除错误的
  elapsed+10 方向和 §7 clock-lag 假设。focused test 改钉 budget729、首拍后715。
- f4132-4184 orbit lane exact；f4184 port/native 均 delta80、items658，之后
  f4185-4193 逐帧 draws/items exact。
- 重新生成 per-frame formal trace：wine st1c draw curve **归零到 f5104**。
  旧 f3918/f4160-62 ±4/±8 是已偿还 transient；新 first permanent fork **f5105 -96**。
- `check/build/test` 全绿（227/227）；formal gx st1 f7520→**f7521**（接触重掷+1），
  gx st2 f9253、ly st1 f3177、ly st2 f3471 全平；clear-check 清关于 replay frame11464。
### D. 新 frontier
1. **st1 f5105 -96**（native delta288 vs port192）：需要按 lane/敌人/弹事件分解；
   这是 settle + orbit 全闭后的第一个真实后续根因。
2. f5105 后差异一度偿还到 -30，再转为 -50/-66 等波动，不能按接触帧猜。
3. st2 子上下文/终相位墙仍排队。

## Pass 32（2026-08-30）— f4123 equal-count 值分叉根因：op123 capture checksum 顺序
### A. pass-31 frontier 重判
- pass-31 只比较 per-frame draw delta，得出“st1 draw curve 归零到 f5104、首个永久fork f5105 -96”。
- 新增 item-value frontier（`tmp/probe-item-value-frontier.mjs`）：把 wine item telemetry 的
  state-3 toss velocity 反推为分配帧初始值（可见 z=0 项扣除同拍 +0.077 vy），再按 frame+slot
  对 port spawn 源值。结果：**f4123 已经是第一个值分叉**，不是 f5105。
- f4123 native slot1451 的初始 toss 为 `(-0.31291,-2.12170)`，port 同槽为
  `(0.17954,-2.08572)`；native #2/#3/#4 依次等于 port #1/#2/#3。整个 63-item time 序列错位一拍。
### B. binary proof
- port f4123 u32 trace：op123 先走 `endBossSpell -> payTh08ProtectedChecksum`
  （2 个 u32），然后 `sweepBulletsToItems` 的 63 个 time velocity（126 个 u32）。
- native `FUN_004161b0` asm：
  1. `0x41620f` 调 `FUN_00430aa0(8000,1)` 先做 scored bullet sweep；
  2. `0x416225` 调 `FUN_0042efb0` 清非boss敌人；
  3. `0x41623c/0x41624a` bank score/popup；
  4. `0x41625c` 才进入 capture arm；
  5. `0x416790-0x4167a1` 增 run+0x1c captured counter；
  6. `0x4167b0` 最后调 `FUN_00406e50` 付4 u16 checksum。
- 因此 native 的前两个 u32 是第一个 zone-time item 的 toss pair；port 把同一对 consumed 成
  checksum，导致 63 个 toss 全部错位，同时帧总 draw 数仍为256（equal-count/order divergence）。
### C. 实现
- `endBossSpell()` 不再即时支付 capture score/counter/checksum/popup/orbit tail，保存 pending spell；
- op123 在 `sweepBulletsToItems + killNonBossEnemies + addScore(total)` 之后调用
  `settleTh08CapturedSpell()`，按 native 顺序提交 capture tail；
- focused regression：`spell capture checksum follows the scored sweep, not spell teardown`
  钉住 teardown 0 draw、sweep 4 draw、checksum 后续4 draw。
### D. 复测
- f4123 272 个新增 item 的 type/slot 序列 exact；63 个 time item 初始 velocity 全部 exact。
- `npm run check` / `npm run build` / `npm test` 全绿，**228/228**。
- formal（接触帧未动，属下游重掷/no-movement）：gx st1 **f7521**、gx st2 f9253、
  ly st1 f3177、ly st2 f3471。
- gx st1 `--clear-check` 清关于 replay frame **11502**（pass31 11464）；score/graze/gauge/
  pointValue/RNG end-state 仍 DIFF，为 f4257 起值分叉的下游 cascade。
### E. 新 frontier（值级，不再只看 draw delta）
1. **st1 f4257 slot308**：native 初始 toss `(-0.31199,-2.14671)`，port
   `(-0.01911,-2.09981)`；per-frame draw delta 仍 both144。该 native pair 在 port raw
   trace 的 f4265 lane 中 float-exact 出现（相对 f4257 port item draw 起点 +172 u16），
   说明存在更早/跨帧的 equal-count reorder，尚未定案。
2. f4257 port lane 为 140 effect draws + 4 item toss；需要按调用栈/effect id 分解，并与
   native `FUN_0042bea0` common death tail 的 effect/item 顺序对照。
3. f5105 -96 已降级为 f4257 值分叉的下游，不能再作为首要根因。

## Pass 33（2026-08-30）— state-1 homing item 不走普通 bottom-cull：f4218/slot2024 collect 归位
### A. pass-32 新 frontier 分解
- 重新比较 pass-32 后 port/native per-frame draw delta：f4205/f4206 的 ±44 是 item-manager
  采样边界 transient（下一帧偿还）；第一个真正永久累计差在 **f4218：native 76 vs port 72
  （port -4）**，随后到 f4257 累计扩大为 -172。
- wine removals vs port collect：f4218 native removals 19 个，port 18 个；唯一缺失是
  **slot2024**。该 orb f4155 spawn 的 source/初始 toss 与 port slot2024 float-exact。
- native slot2024 在 f4195 crest 转 state1，f4196 y=465.3121（已严格超过 camera+16=464）
  仍继续 homing，直到 f4218 collect；port 在 f4196 把它当作普通 fall item cull。
### B. binary proof
- `FUN_00440500` state-1 branch：`0x4407f6` 判 state==1 → `0x44085f`；计算 player vector、
  写新 velocity（`0x440886/0x4408a5`）、积分（`0x4408c7/0x4408d6`）后
  **`0x4408db` 直接 jump `0x4409f2` 的 collision test**。
- `0x44095b-0x4409a5` 的 bottom cull / rank-3 / unlink block 只在 ordinary fall path；
  state1 分支跳过它。port 曾把 cull 放在共享 non-toss tail，误杀了正在回飞的 homing orb。
### C. 实现/复测
- `updateItems` 的 bottom cull 增加 `it.state !== 1` gate；focused test
  `state-1 homing skips the ordinary bottom-cull block` 钉住 y=465 仍同拍 homing 且不 dead。
- 修复后 f4214-4222 的 native item removals 与 port collects 逐帧逐 slot exact；
  slot2024 于 f4218 collect，f4228 前的 -172 cascade 消失。
- `npm run check` / `npm run build` / `npm test` 全绿，**229/229**。
- formal（接触帧是下游重掷）：gx st1 f7521→**f7518**（-3，非进度指标）；gx st2 f9253、
  ly st1 f3177、ly st2 f3471 全平。clear-check 清关 replay frame **11891**，下游 end-state
  仍 DIFF。
### C2. 新 count frontier
- 忽略 f4205/06 ±44 采样 transient 后，第一个永久累计差变为 **f4228 native60 vs port56
  （port -4）**。f4228 的 11 个 item collects 已 exact；port 其余 lane 是 3 个 effect-5
  impact（每个4 draws），因此缺的是 **一个4-draw effect-5/impact族事件**。
- f4230/f4231 的 -8/+8 只把累计差带回 -4，不偿还 f4228 的缺失单位；f4257 slot308 toss
  仍错一拍是它的下游。
### D. 下一轮
1. 分解 f4228 的 player-shot collision：port 3 个 effect-5，native draw budget 需要4个；
   记录每个 player bullet slot/edge/enemy AABB，并与 FUN_0043a980/FUN_00425d70 的冲击spark
   条件对照。enemy slot1 的 HP/位置/ECL clock 在 f4224-4234 已 exact，不能先改运动。
2. f4257 item-value fork 降级为 f4228 -4 的下游。

## Pass 34（2026-08-30）— 侦察轮：runstate checksum 值 oracle；f4228 精确为一个缺失 effect-5，st2 真 frontier 提前到 f4909
### A. 新值 oracle
- `FUN_00406e50` 的两个 integrity 值写入 run+0x50/+0xb4：
  `u32%100000 + 0x198f`（all.c:2392-2407）。`fa-native-gx/runstate.jsonl` 的 base64 blob
  因此不只是 score/gauge 曲线，还可作为**随机值/顺序 oracle**。
- probe `tmp/probe-checksum-oracle3.mjs` 包装 port 的 collect/checksum事件并比较最后写入的
  integrity pair。st1 到 f5110：4543 个 native 边界中 4541 exact；仅 f2237/f4230 是
  mid-pass sampling artifact（下一采样恢复）。
### B. f4228 结论加强
- diagnostic `tmp/probe-f4228-counterfactual.mjs extra` 在 port 第三个 effect-5 impact之后、
  item collects之前额外分配一个 effect-5：
  - f4228 56→60，f4229 仍144；
  - wine item toss oracle 到 f5110 **1289/1289 exact**（未注入时 f4257 slot308 起错）；
  - checksum oracle 到 f5110 **4541/4543 exact**。
- 因此 f4228 的缺失单位已钉死为**一个4-draw effect-5 allocation**，且其 RNG 位置在三个
  observed impacts之后、11个 item collects之前。不是少付 item checksum，也不是泛化四draw事件。
- 强制 f4228 六个最近失弹 slots 20/24/27/28/30/31 提前碰撞全部 falsified：f4229 少付
  impact，f4257 slot308 仍错。简单“多走一步”不能解释该事件。
- 现有 binary call-site census：effect-5 来源限于 shot settle、特殊 shot callback和死亡/quad
  lane；f4228 活跃 Border SHT callbacks均为0/1，因此下一步需要 native player-shot pool
  身份/位置证据（Wine仍关闭），不能用 draw count 猜一个 slot。
### C. st2 新 frontier：f4909
- `tmp/probe-st2-count-frontier.mjs`：st2 count stream 在 f4909 前只有已知 ±4/±8
  repaying sampling transients；首个永久差是 **f4909 native150 vs port470（port +320）**。
  旧“f8950 field empty”是该 fork 的下游。
- checksum oracle 到 f4908除同一批 mid-pass transient frames外 exact，排除 equal-count
  RNG value fork。
- f4909 lane 分解：port effects118 draws + **88个 type-7 quad conversion（4 draws each）**
  =470；native 只剩32 draws给 conversion族，相当于少80个 conversion。
- 88 = 85 deferred + 3 normal。f4900 slot1/Sub4 的两个 Lunatic FIRE（3×7 sprite1与32×2
  sprite2，共85 bullets）在 port 中被 f4887 master quad（center≈96,105，r32+1×16，type7）
  latch，f4909 spawn-VM完成时统一付税。
- binary `FUN_004241c0` case2/3/4（all.c:23585-23654）确实每个 spawn tick 调
  `FUN_00449ff0` 并在 VM完成时 deferred pay；port 的 latch顺序本身不是显而易见错误。
  对 f4900 volley额外加1/N个 spawn-move step的实验也 falsified（N=1只少4 draws，更多N不归位）。
- 下一步要对照 native bullet pool/FIRE geometry：native是否只有8个该族bullet落在 quad内，
  或85-bullet volley的初始/transition位置不同。f4909 因此归入已知 bullet-pass/FIRE geometry
  family，而非 item转换语义。

## Pass 35（2026-08-30）— DAT_018b8988 活性全局：st2 f4909 fork 闭合（f4909→f6330）
### A. binary 钉死
- `FUN_00449ff0`（all.c:36468-36520）：穿 player+0xbb834 弹区池（stride 0x40，上限 0xc0），命中即
  `player+0xe2a90 = zone[10]`（param6）。`__thiscall` ECX=player；re-specs 导出示参丢失。
- 玩家静态基址钉死：`FUN_0044c230` 从 `&DAT_017d5ef8` memset 0x38acc dwords（0xe2b30 bytes）→
  player=0x17d5ef8，故 `player+0xe2a90 == DAT_018b8988`。BSS 零初始化；全库无 -1 写入 →
  `-1 < DAT_018b8988` 门实际恒真（值域 {0,6,7,9}）。
- `FUN_0044a230`（命中探针）/ `FUN_0044a470`（擦弹探针）/ `FUN_0044a360`：**入口即写 6**
  （all.c:36534/36577/36615）——每个 normal 弹每帧把全局洗回 6。
- spawn case 2/3/4（all.c:23589-23644）：每 tick 先 creep 移动、直接调 `FUN_00449ff0`（不洗 6）、
  命中只置 `+0xdbe=1`；VM 结束 tick 支付 **DAT_018b8988 当前值**（9→双 time；>-1→单发该 type）。
- 双付结构（f736 witness）：LAB_00431306 把 state 改写回 1 落入 case-1 全体 → 全速移动后
  a230 再探一次 → 仍在区内 → 再付 + state5。
- 池 tick `FUN_0044c5b0`（player pass，先于 enemy arm）：+0x24 寿命递减、+0x8 半径 += +0x0c growth；
  master quad `FUN_0044df00(pos,32,1.0,16,7)`、child `(pos,32,2.0,8,7|9)`（all.c:20497/20542）——
  port 的 r32+1/16、+2/8 模型本就正确。
### B. f4909 机制结论
- port 旧模型把 latch 的 zone type 存 per-bullet 并在 VM 末支付 —— 错；正确的是活性全局。
- f4909 port=470（118 effects + 88×4），native=150（118 + 32）。新法下 port 精确 150：
  88 个 latch 弹中仅 ending-tick 探针仍触活区（f4897 master (112,97.5) r44，活到 ~f4912）者付
  time（自身 probe 重写 7），其余付 stale 6 = pointStar 零 draws；另有 stale-carry 与双付。
  实测新 port f4909：8×time + 81×pointStar + 118 effects = 150 ✓。
### C. 成绩
- **st2 count 流首个永久分叉：f4909 → f6330**（+1421 帧精确）；f4909-4920 全帧 native 逐帧相等。
- checksum 值 oracle 到 f5500：4907/4989，bad 全部落在已知 mid-pass 采样带（2160-2277/2479-2527/
  3577-3688/4391-4470/4677-4800/5096-5149，count 均回补）——f4909 窗口零 mismatch。
- st1：f4122/4123 settle rel 0 不变；f4228 frontier 不变（-4 = 缺失 effect-5 依旧）；
  f4205 rel+44 暂态为 pre-existing（c27269b 对照一致）。
- formal：gx st1 f7518 平；gx st2 f9253→f6475（接触重掷：近原生弹幕场使 sub17 f6166 弹命中提前，
  残差带 5854-6350 的下游）；ly st1 f3177→f3237（sub15 同族重掷）；ly st2 f3471 平。
- gx st1 clear-check：仍 11891 清关，end-state diff 同族（下游级联）。
- 测试 231 绿（+2 focused：过期 quad→pointStar / 活区双付 time）；check/build 绿。
### D. 新 frontier（st2 f6330，+12）
- 场面：仅 boss（idx1 hp1476→1408，(192,128)→(248,108) 移动中）。周期性 4 帧 cadence：
  native 弹量 104/122/116/104/...（逐发变化），port 近恒定 104 —— **native 每发弹数/抽卡不同**。
- 另有不规则 12-draw 事件：native 6316/6319/6326/6330/6332/...，port 同族但相位错 ±1。
- f6330 native d=12 而 port d=0 → +12 永久。归为 pass-23 已立的 auto-fire timer 原语序 +
  aim-tracking wrap 族（FUN_00406610/660/40、b8e0、e390）——下一轮入口。
### E. 本轮 falsified / 排除
- quad 半径不增长 / 区寿命差异：被 binary FUN_0044c5b0 与 port/native 双侧 r44@f4909 一致性排除。
- 弹位置差异：volley 弹 native 位置无 wine 覆盖，但 f4900-4908 count 逐帧相等 + 几何同律 → 排除。
- 「85 弹全 latch 但支付 0」纯 stale 模型：算不出 150（118/122/458 都不对）——需活区接触项，
  与最终实现一致。
### F. f6330 → f5865 深挖（pass 35 后半，未闭合）
- f6330 (+12) 只是表征：对齐探针（同帧 draws+FX）证明 firefly(FX51,4×26=104)/afterimage(FX62,12粒,0抽)/
  弹体全对；**唯一差异 = effect-5 命中火花的节律**（port 每5帧3连 vs native 更密）→ boss 掉血节律差异。
- boss（Mystia，poolSlot1）轨迹在 **f5865 相位切换**分叉：port 漂 (2.38,1.78)/tick∠0.6433，
  native (2.74,0.80)/tick∠0.2834。此前 f5700-5860 位置 0.01px 内全同。
- 移动指令 = sub19 t=0 的 ins_67（case67 随机内移动，`e.x<=player.x → angle=rand×π/2−π/4`，
  rect 96/48 折边——f5865 时 boss(169.71,65.4) 在 rect(32,48,352,128) 中央，无折叠）。
  常量已从 .rdata 逐一核对（π/2、π/4、96、48 全对）。
- **f5865 count 精确相等（106=106）**，但角度值分叉：port rng.f=0.9095062（f5865 流末尾 idx104/106，
  在 firefly 104 抽之后），native 反推 rand≈0.681。checksum oracle 到 f5920 全对（但只采样
  collect/protected 事件）。
- 流内搜索：port f5865 流 idx60→∠0.2852、idx100→∠0.2846 均在 census 噪声内贴合 native 0.2834；
  port 现取 idx104→∠0.6433。**疑似帧内 draw 序问题**：native 可能在 firefly burst 中途（而非末尾）
  抽移动角。idx100 ≈ 3.85 个 firefly 之后，无干净结构解释；亦不排除 checksum 盲区的上游值分叉。
- 注意：boss ctxT port 恒 +1（f5700 起，位置不受影响直到 f5865）——ins_2 wait 边界的 +1 tick
  归属待查（pass-21 子上下文时钟家族）。
### G. 下一并入点
1. f5865 角度 draw 的 native 流内位置：读 FUN_0041b320 effect 分配器的逐粒子 draw 序
   （ANM 10 + world 16 是否同 pass），确定 native 是否在 burst 中途抽角度 → port 序修正。
2. 若序无误，则转 checksum 盲区值分叉（f5149-f5865 间无采样事件，需新 oracle）。
3. st1 f4228 缺失 effect-5 依旧（本 pass 未触碰）。
### H. f6330→f5853/f5865 二层深挖（pass 35 收尾）
- 对齐探针（同帧 draws+FX 全录）证明：f6313-6346 的 firefly(FX51)/afterimage(FX62)/弹体全对，
  唯一差异是 **effect-5 命中火花节律**（boss 掉血时序）→ 源自 boss 轨迹分叉。
- **boss 轨迹分叉点 = f5865**（Mystia 相位切换 ins_4 跳转 sub19 t=0）：port 漂 ∠0.6433，native ∠0.287。
  f5700-5860 位置 0.01px 全同；玩家位置两侧 (174.31,432) 精确一致。
- ins_67（case67 随机内移动）：`e.x<=player.x → angle=rand×π/2−π/4`，rect(32,48,352,128) 中央无折叠；
  .rdata 常量全核对（π/2=0x3fc90fdb、π/4=_DAT_004b4524、96/48 margins 全对）。
- **f5865 count 精确 106=106**（firefly 104 + angle 2）。port rng.f=0.9095062（流末尾）；
  native 反推 rand≈0.681。port 流 idx238566（**比 port 的角度 draw 早 4 位**）→ 0.2846 ≈ native 0.287。
- **反事实强制角度 = native 值（0.6804）后，轨迹 f5865-5960 对齐到 0.1px、hp 全同** → f5865 分叉
  purely 是角度 draw 的流位置/值问题，运动律本身正确。f5970+ 再从下一相位运动分叉。
- f5853/f5854 有**独立的 1-frame graze 时序差**：port 在 f5854 才擦弹（onGrazeAward→effect-8，4 draws），
  native 在 f5853。count 在 f5855 前回补（两侧 5853+5854 均 120），但该 ±4 暂态 + f5865 角度 fork
  共同构成 5854-6107 漂移带。
- checksum 盲区：integrity 字 f5855-5875+ 恒定（无 collect/protected 事件）→ f5865 值分叉对 oracle
  不可见。f5853 擦弹早晚差属 movement-precision/graze 时序族（AGENTS §4 标注 wine-gated）。
- **下一步入口**（按杠杆序）：①钉死 native effect-5/8 生成与 ins_67 的帧内 draw 序（需 effect-spawn
  FUN_0041b320 的 ANM+init-callback draw 顺序的 binary 证据，Ghidra 函数指针链不透明，或 wine）；
  ②st1 f4228 缺失 effect-5（另一优先项，shot-collision 族，binary 可达性更高）。
### I. f5791 — f5865 角度 fork 的最上游节点（pass 35 末）
- count 前沿 + LFSR 状态分析钉死：port 进入 f5865 时比 native 多 4 抽（cumulative offset -4，
  f5854-5865 持续），故 ins_67 角度读到 native 位置 +4 的值（0.9095→∠0.6433 vs native 0.681→∠0.287）。
- 该 +4 的最早来源 = **f5791 port 多一次擦弹**（effect-8，4 draws）。f5791 port=16 vs native=12；
  多发的是对**静止弹 slot1149**（sprite3/off8，speed1=0，f5733 由 slot4/sub20 妖精发于 (219.44,435.9)，
  永不移动）的擦弹。native 整个窗口不擦它。
- 两侧玩家位置 (195.52,432) 与妖精位置 (219.8,438.1) 逐帧全同；port graze 律
  （|dx|<=grazeW/2+grazeboxHalf+20=25.8）与 binary FUN_0044a470 的 AABB+20 常量（_DAT_004b6e98=20）
  及角色 grazebox 半宽（DAT_018b896c+0x10/2）公式一致。port 在 |dx|=23.9 时擦弹（margin 1.9px）。
- **未闭合**：native 为何不擦该弹——候选：弹未存活到 f5791（移除/消弹差异）、graze 盒边界
  亚像素差、或上游 draw 序。需 native 弹池逐帧证据（Wine 关闭中）方能定死。
- 附加：f4228 缺失 effect-5 = 第4次射击首接触时序（port 3 次，native 4 次，敌人全程 hp300 无伤 =
  免伤相位只计接触数）；f5853 graze 晚一帧（弹1014）同族。均属 movement-precision 族。
### J. f5791 擦弹超收的精确画像与定界（pass 35 末，补 I 节）
- 精测探针（checkEnemyBulletCollision 内联）：port 的 grazeboxHalf=1.4（SHT grazebox 2.8 全宽 / 2，
  与 binary DAT_018b896c+0x10/2 一致），弹 hitbox 半宽 3（sprite3 tier6），margin 20 常量
  （_DAT_004b6e98=20.0 ✓）→ 阈值 24.4，port 在 |dx|=23.92（f5791）擦弹、几何自洽。
- runstate blob 逐帧 diff：native 的 graze 计数器（blob+0x4）在 f5791 不动、f5793 才 +1 →
  **native 在 f5791 不擦弹 1149**。两侧玩家/妖精/弹出生位置逐帧全同（f5730-5740 0.1px 内）。
- 残余假设（均未能定死）：native 该弹未存活到 f5791 / 弹出生差 1-2 帧致静置位置差 ~2px /
  或 +4 其实是 port 第 3 发 effect-5 命中火花 vs native 2 发（f5791 port 16=3火花+1擦弹,
  native 12=3火花 或 2火花+1擦弹 —— count 无法区分）。**需要 native 弹池逐帧证据（Wine 关闭中）**。
- 教训沉淀：LFSR 状态只依赖累计抽数，与顺序无关——「同 count 不同值」只能是累计差或 fork 后
  未回补。census 的 per-frame delta 在 mid-pass 采样下不可靠，一律用累计值对拍（frontier 口径）。
### K. 下一轮可检验假设（pass 35 收尾）
1. **弹 spawnDuration/出生-首动 off-by-one**：port 擦弹晚 1 帧（f5854 弹1014）+ f4228 射击接触晚/缺，
   同族表征 = 「port 弹比 native 晚 ~1 帧到达同一位置」。若 port 的出生态时长多算 1 帧
   （th08FlashDuration 读 ANM remove 时间 vs 原生 jump-table 的 case 2/3/4 终止条件），即系统性
   1-帧滞后 → 可一次性修掉一族。binary 可达（etama.anm 脚本长度 + all.c 的 spawn 终止条件）。
2. f5791 弹1149（speed0 静置）port 擦 native 不擦：位置全同 → 疑 native 侧该弹未存活/未出生
   （sub20 开火帧差）。需 native 弹池证据。
3. 若用户下达 Wine trace 轮：直接取 f4228 的 shot-pool、//f5791 的弹池、f5865 的逐 draw 序，
   一次钉死三个墙。
### L. movement-precision 族确认定界（pass 36 侦察轮，无源码改动）
- **排除 volley 数量 bug**：SHT power-80（f4228 时玩家 power=81）= 3 针 + 2 小弹，与 native 同；
  f4228 第 4 个 effect-5 不是第 4 根针。grazebox 半宽 1.4、collect 盒 ±12、autocollect 10、
  itemMoveRate 0.9 均与 binary 角色数据一致；道具物理/弹体积分/出生位置律全部 binary 钉死且匹配。
- **确认级联结构**：玩家位置精确匹配（0.01px）→ 敌人位置匹配（0.1px）→ 但弹/道具轨迹差
  0.5-2px → 阈值穿越（collect/graze/contact）时序差 ±1-2 帧 → count 暂态（port 与 native 在某帧
  多抽/少抽 ±4-20，回补）→ 暂态窗口里生成的实体拿到错位 RNG 值 → 永久轨迹分叉。
- 每个现存墙（st1 f4228、st2 f2160/f5791/f5853/f5865/f6330）都是这个族的成员。
- **确认环境限制**：本机无 podman、无 chromium 二进制 → 多模态截图路线不可用；
  wine-out 预捕遥测不覆盖当前 fork 帧；census 只有敌人（无弹/射击逐帧）。
- **定论**：精确钉死需 native 逐帧弹/射击/道具动态证据。Wine 关闭（用户规则）中。
  下一可检验入口（binary 可达）：射击 fire-cycle 相位是否比 native 偏移 1 帧（SHT interval=5，
  若 port 相位偏移 → 针弹到达敌人晚 1 帧 → 全族下游）。待查 FUN_0043eef0 的 cycle 起相。

## Pass 37（2026-08-30）— 玩家 callback 调用序 + 寻的律 x87 收窄修复（9c41bc1）；f4228 组合代数钉死但仍开
### A. 本 pass 完成的事
- **玩家 callback 全调用序 binary 钉死**（FUN_0044c390 逐字节解码，无 objdump 环境用 E8 扫描器）：
  FUN_0044c5b0/0044c650 → 死亡状态分支 → FUN_0044d2c0 → FUN_0044aec0（方向→focus 迁移→速度→
  积分→clamp→AABB→**选项移动**→开火 arm FUN_00451640）→ 玩家 ANM → **FUN_00451150 射击移动**
  → **FUN_00451500**（gate: DAT_0164d2c8≥20 且 fireTimer.current≥0 且非 bomb-type4；
  current!=prev 时 FUN_00450f60(player, phase=current) 分配；然后 tick timer；≥20 wrap 到 -1
  并**同帧再 arm 到 0**；state1/2 置 -1）→ FUN_0044d420（**重置目标缓存** player+0xe2aa4=-999）。
  port 的 update→move→options→updatePlayerBullets→firePlayerBullets 顺序全匹配；arm 帧即开火
  相位 0 两侧一致（pass 36 遗留假设「fire-cycle 相位偏 1 帧」**falsified**）。
- **thunk 语义**（FUN_00451500 族解开的钥匙）：0x40d3b0=[ecx+8]（timer current），
  0x40d3d0=([ecx+8]!=[ecx])（current!=prev），FUN_004065f0=set{v,frac=0,prev=-999}，
  FUN_00406640=tick（prev=current，经 0x17ce758 全局 ticker 按 rate 累积）。
- **修 FUN_00450320 寻的律**（9c41bc1）：①三个 hypot 的和平方先收窄 f32 再调 sqrt
  （0x4503cf/0x450435/0x450512 的 `fstp dword [esp]` + FUN_0040b440 收 f32 实参）——port 旧用
  Math.hypot 不收窄，网格抽样 12% 输入差 1 ulp，轨迹 A/B 证实真实输入上确有别（f1679-f2849 段）
  但本窗 settle 帧全不变；②targetless 的 加速+归一化整块门 speed<10（0x4504c8 fcomp/jp），
  port 旧在 speed≥10 时仍归一化。新增 2 条回归（tests/th08-option-shot.test.mjs）。
- 验证：check/build/test 233/233；formal gx st1 f7518、gx st2 f6475、ly st1 f3237、ly st2 f3471
  全平；gx st1 clear-check 仍 11891 清关。**f4228 count 前沿不变（92→96 仍在 f4228）**。
### B. f4228 窗组合代数（本轮新钉死）
- 逐帧 draw 差分（census vs port 累计）：f4228 +4，f4230 +8，f4231 −8，之后恒 +4。
  非 settle lane 相等假设下：**native settle 数 f4228:4 / f4229:6 / f4230:3 / f4231:0**；
  port 3/6/1/2（{11,15,18}/{20,24,27,28,30,31}/{9}/{25,26}）。即 native 多 1 个 settle
  （永久 +4），且 25/26 早一帧（f4231→f4230）。f4230 的 checksum「artifact」与此 wash 一致。
- wine st1c 道具流 f4225-4236 零 spawn（排除 toss 时序），f4228 的 11 collect 精确。
- 玩家位置全帧精确（f4100-4260，offset 0，130/130 精确到 0.005px，pass 36 的「稀疏」判断有误——
  实际 4205-4265 逐帧密）；目标缓存内容逐帧对拍一致（濒死装饰敌 (317.5,-27.7)→null→f4214 起妖精）。
- **目标缓存公布律 binary 钉死并实现**（0x42d386-0x42d47d，FUN_0042c660 碰撞块内，
  commit 1e21d45）：flags bit1 集合内取 **|enemy.x − player.x| 最近**
  （FUN_004031e0=fabsf，DAT_017d61ac=player+0x2b4；严格 <，首 bit1 无条件覆写 fallback）；
  bit1 之外且本帧无 bit1 候选时走 max-y fallback；FUN_0044d420 每帧尾重置。port 旧 max-y
  单级律在 st1 f6330 前碰巧全同，f6330 起 153 帧真分歧；parallel-law 探针验证两级律在
  gx 双 stage 全帧零偏差（5634/5274）。count 前沿不变（f4228 依旧）；gx st2 f6475、ly 双段平；
  gx st1 formal f7518→f7422（cascade 内重掷）；clear-check 11414/11460（录入流内清关）。
- 妖精 hitbox {24,24}→半 12 双侧一致；slot20 f4228 在 (102.14,48.39)，miss 1.14px。
### C. 仍未闭合
- native 多出的第 13 个 settle（f4228）：port 侧 never-settle 候选（slots 1/3/5/6/7）全部差
  ≥20px 不可能几何到达；slot20 两侧都在 f4229 settle（f4229=144 硬约束）。纯 shift 假设全部
  差 4 失衡。**残留可能**：①port 某 volley 少/多一弹（spawn 拒绝律已排除：FUN_0044fd80 只按
  phase%interval==delay，init1/00450240 不拒绝）；②寻的轨迹仍有未被 A/B 覆盖的系统性差
  （Math.sqrt f64 vs x87 fsqrt 64-bit 精度？——fstp 位点已全部对齐，剩余只有 sqrt 本身的
  末位）；③该事件根本不是 shot settle（effect-5 族其他来源在 f4228 全部不可能：无死亡、无
  quad、无 attack-slot 接触）。
- st2 f6330/f5865/f5791 链未动；f2128 未动。
- 下一杠杆不变：native 射击池逐帧证据（Wine 关闭中）。binary 可达的下一步：
  审计 FUN_00451150 里 +0x474 回调返回非零即 despawn 的语义在 port 侧的对应
  （FUN_00450320 恒 return 0，但其他 tick 回调未必）；以及两级律已改后复看
  f6330+ 段的 kill 时序是否与 native 更近。

### D. st2 f2128 定案：census-only 惰性差，非 fork（pass 37 补查）
- 真相：native slot1 = 父妖精（slot2/sub11）的 attach 子敌（sub12，f2115 出生，位置逐帧与 port
  精确一致）。父在 f2128 中弹 hp→0（双侧同帧、+480 draws 双侧一致）；子敌在 native 活到
  f2128 帧尾（census 可见），f2129 才移除；port 在父死当帧（f2128）内联释放子敌。
- 原判「port 提前 1 帧击杀 f2128」实为子敌移除时序，不是击杀提前：父子 HP/伤害/死亡帧全同。
- 惰性证明：f2120-2138 逐帧 draw 差分双侧全等（累计差恒定）；子敌 slot1 在 f2129 释放后，
  下一个 spawn 是 f2136（仍得 slot1，两侧一致）；子敌多活的一帧无碰撞/发射/RNG 影响。
- native 机制：sweep 在父死当帧 sever 子敌（flags|0x400、death mode 8），子敌的移除走它自己的
  下一个 manager pass（f2129）。port 的 `c.dead=true` 内联提前一帧。**本实例可证惰性，不改**；
  若未来出现 sweep 后同帧有 spawn 竞争子敌 slot 的场景再回头。
- lunge tie-break 字段不对称（0x42d4c2: incumbent+0x2d38 vs candidate+0x2d8c）：候选集经
  FUN_0041fd20 排除子敌后 root 敌人两字段相携，port 的对称比较等价——已分析，不改。

### E. f5791 擦弹门 binary 复审（pass 37，未闭合但排除面收窄）
- 弹擦弹链 FUN_004241c0 → 0x4315f2 调 FUN_0044a470 的**全部前置门**（逐字节解码 0x431500-0x43160c）：
  ①对话（0x160f508 对象）；②+0xdac&0xdc0 的 128 帧计数器族（0x20212 弹不满足，走旁路）；
  ③**+0x10b4（byte）必须==0**（转换标记，两处 set1/clear0 对在 0x424ae0/0x424d0e，bomb 转换用）；
  ④**+0xdbd（byte）必须==0**——这就是弹的 grazed 位本身（0x431605 在 probe 返 1 时置 1）；
  ⑤**年龄 timer（+0xd8c 的 current）≥ 16**（0x4315d0 cmp 0x10 jl skip）。
  port 三条全有（grazed 位、age>15、转换跳过）。f5791 全部满足仍不解释 native 不擦。
- FUN_0044a470 内部：**先跑 FUN_00449ff0 death-quad 探针**，命中即 return 2（非擦弹路径）；
  入口写 DAT_018b8988=6（pass-35 已建模）。f5791 双侧无任何活动 zone → 该旁路不是本例原因。
  **已知未建模分支**：port 的 checkEnemyBulletCollision 不在 graze 盒前跑 quad 探针——当前 oracle
  下不可证伪（无 graze 与活动 quad 重叠的场景），按「无证据不改」记录。
- 弹 1149 的 port 侧 slot 身份留意：poolSlot 1149 在 port 中 f3600 曾被另一弹占用（复用）；
  native 侧该弹的 slot 身份本来就不可比。census 覆盖外（wine st2 只有 f1050-1120/8950+）。
- 结论不变：f5791 需 native 弹池逐帧证据（Wine 关闭）。st2 主前沿仍为 f6330（←f5865←f5854/f5791）。

### F. pass 37 收尾侦察（f4228 排除面闭合 / f5853 精测）——全部否定，前沿不变
- **f4228 volley 完备性**：f4192-4222 七个 volley 各射 5 发、零分配失败（pool 128 远未满）
  → 排除「port 少射一弹」。
- **f4228 never-settler 归宿表**（f4190-4225 出生的 35 发全录）：f4202 两发斜针 f4228 离屏、
  f4207 两发 f4231 离屏、f4192 四发、f4197 两发——无一在 f4228 距妖精 20px 内。能接触妖精的
  只有已 settle 的那些 → **native 第 4 个 f4228 settle 无 port 对应弹**。
- **effect-5 成本钉死**：init callback FUN_00425d70 恰好 2×u32=4 draws（0x425d83/0x425da4 两次
  RNG 调用），脚本（etama diskId -113）零随机 op。fx51（-77）的 5 个随机 op 全在 t0，t1/31/121
  的 op 全非随机 → 无 mid-life 随机 draw。effect 池 f4228 占用 348/512，无压力拒绝。
- **f4228 结论**：port 56 = 3 sparks + 11 collects 全归因；native 60 = 44 + 4×4 → 4 个 effect-5。
  第 4 个接触对现有全部 oracle（位置/缓存/计数/checksum/道具）不可见。Wine-gated 维持。
- **f5853 精测**：port 在 f5854 才擦弹 1014 的机制 = dy 阈值穿越：f5853 时 dy=24.95 > 24.4
  （弹 (201.99,407.05)，玩家 (182.79,432)），f5854 dy=20.23 穿越。native f5853 即擦 →
  native 弹 y 需 ≥407.6（port 407.05，低 ~0.55px）。弹 1014 经 ~127 帧曲线（ex-accel 族）累计，
  出生窗 f5724-5733 敌位置双侧 0.1px 全同——差异在 census 精度之下、曲线积分之内。Wine-gated。
- **擦弹门链全解码**（0x431500-0x43160c）：对话门 → +0xdac&0xdc0 的 128 帧族 → +0x10b4==0
  （bomb 转换标记）→ +0xdbd==0（grazed 位，probe 返 1 时置位）→ 年龄 timer≥16 → 盒探针
  FUN_0044a470（先 quad 探针 FUN_00449ff0 命中即返 2，再 AABB+20）。port 全有（grazed/age>15/
  转换跳过）。已知未建模：port 的 graze 路径不先跑 quad 探针（当前 oracle 无场景触发）。

## Pass 38（2026-08-31）— 探针边沿 f32 收窄；f4228 自愈窗结构；射击管线全审计（纯静态 + 探针，Wine 保持关闭）
### A. 源码变更（行为中性、二元钉死）
- `src/game/stage-scene.ts`：①`checkEnemyBulletCollision` 的 graze/killbox 盒改为
  FUN_0044a470（0x44a4b4-0x44a519）/FUN_0044a230 的「弹四边各自单次 fstps 收窄 f32 +
  对玩家存储盒（+0x3a4 graze / +0x38c hitbox）含闭比较」；②`collidePlayerShotsInBox`
  的射击盒四边补 f32 收窄（FUN_00451ce0 同形，旧实现只收窄了敌方边）。
  导出纯函数 `th08ProbeEdges`；新增 `tests/th08-probe-edges.test.mjs`（暴力搜出的
  真分歧刃口用例：sum 形式不过、f32 边沿形过——以 exe 边沿为准）。
- 验证：check/build/test 235/235；四 formal 全平（gx st1 f7422 / gx st2 f6475 /
  ly st1 f3237 / ly st2 f3471）；gx st1 clear-check 11414 持平；
  tmp/fork-check.mjs 对拍修复前后完全一致（刃口稀有性 ⇒ 当前前沿不动）。
### B. f4228 结构重定义（本轮最重要发现）
- tmp/fork-check.mjs（累计偏移对拍，base offset 92 = 90 预抽 + 2 stage 抽，对齐自证）：
  port 在 f4228 付 56 vs native 60 ✓（与 pass-37 一致），但漂移不是恒 +4——
  ±4 震荡：+4@4228→0@4387→+4@4389→8@4409→0@4422→…→f4719 起干净，f4721 新 +4
  （native 曲线覆盖止于 ~4725）。**流自愈**：只有 f4228-4719 窗口在错位值上运行。
  这解释了 checksum 为何能穿过窗口 hold。
- 缺失 4 抽的排除面（本轮全部二元/数据关闭）：非 graze（runstate blob+0x4 在
  f4210-4246 恒 90）；非 sub5/sub14 ECL rand（两脚本零 rand 变量读，timeline 无
  t4180-4260 事件）；非 port 弹位移（窗口代数 + 全池几何：{20,24,27,28,30,31}@4229
  /{9}@4230/{25,26}@4231 与离屏 never-settler 全部对 4/6/3/0 有解）。
  残留身份：第 13 发接触（native 轨迹真分歧）或无 oracle 子系统的 2×u32 effect init。
### C. 射击管线逐 op 审计（全部确认 port 忠实）
- FUN_00450320 seek：三门（cache.x>-100@0x4b4394、age<40、timer current≠prev）在
  rate-1 下全是 no-op；FDIVRP@0x4503e5 = hypot/(speed/4)（Ghidra all.c:39776 交叉
  钉死，objdump 助记符方向歧义关闭）。FUN_0040b440 返回未舍入扩展精度 sqrt
  （fsts 不弹栈）。port 算术形态（含 pass-37 收窄）全部等价，模 f64/64-bit 尾数
  双舍入（概率 ~2^-40 级，不可行差异源）。
- FUN_00450f60/0044fb70：type = SHT rec+0x22（ply00a/ply00as 全 6 级 dump：Border
  只用 type 0/1）⇒ FUN_00451670 三条 type 律（state==1‖type==3 重扫、type4/5
  current%2==0 门（FUN_0040d410=timer%n）、type4/5/6 跳过 settle 尾）对本队
  确定性 N/A。settle 尾完整解码：sfx(rec+0x24+0xa) + effect-5 + posvec+8=0.1 +
  vel/8(type≠3)；伤害 clamp 50/call；时玉溢出环阈值 [0x18b8a24](=40)。
- 五个 init 变体（0x44ffa0→e2ab0/e2ab4 位置缓存、0x450080→e2b0c 角、0x450110→
  player+0xcd0 且门 player+0xfdc==0、0x4501a0→FUN_0043ed80、0x450240=init-1
  lunge）：Border 只用索引 0/1。
- lunge 瞄准读敌指针缓存 player+0xe2abc 的 +0x2d34/+0x2d38——自由敌 ≡ live
  （0x2d88），分歧面不存在；FUN_0043edb0(a,b)=wrapToPi(a+b)；FUN_004286e0=
  fsincos→out+0=sin·s,out+4=cos·s（角从向下起算；瞄准链的 +π/2 是约定桥；
  port 的 (cos,sin)+标准角等价）。
### D. 敌方位置拓扑（后续所有 movement-precision 工作的地基）
- +0x2d34 ECL 脚本位（ins_63/0x3e 直写；积分器 FUN_0042deb0：0x2d34 +=
  rate×(0x2d4c,0x2d50,0x2d54)，bit18 反 x）；+0x2d40 base（attach 子=父脚本位）；
  live +0x2d88 = 0x2d34+0x2d40（FUN_00409080=vec-add）。census 读 +0x2d88 且
  打印 toFixed(1)——**sub-0.1px 一致性从未验证**（f5791 的 0.48px 余量正落在此盲区）。
- 每 tick 序：ECL VM(FUN_004184b0) → clamp(42c180) → 积分(42deb0) → clamp →
  attach 同步 → live 更新 → 逐敌 FUN_00451670 → 缓存发布(0x42d3d3+)。port 顺序一致。
### E. st2 f5791 定界收紧
- sub20（ecldata2）完整反汇编：FIRE(op97) 角度=var 10020，**零 RNG**；静止弹格点
  对 count/checksum 双盲。graze 律（FUN_0044a470）确认逐位忠实 ⇒ native 不擦的
  原因只剩：妖精发射时刻位置差 ≥0.48px（census 盲区）或 ECL 时钟发射相位差
  （fire 零抽卡 ⇒ 相位差同样双盲）。两候选同属 movement-precision 族，与 f5853
  （弹 1014 的 127 帧 ex-accel 积分差 0.55px）同根。
### F. 工具沉淀
- tmp/probe-shotpool-f4228.mjs：逐帧射击池（槽位/状态/位置/速度/年龄/tick 类型/
  盒）+ 目标缓存 + lunge 敌 + settle 事件。f4218-4236 实测：port settle 分布
  {4225:3,4228:3,4229:6,4230:1,4231:2,4232:6}，f4228 缺第 4；两只 f4202/f4207
  斜针（t1 寻的弹）追逐 (80,10→42) 下落妖精冲出屏顶。
- tmp/fork-check.mjs：累计偏移 fork 探针（抗重复行/中段采样），可见震荡/自愈结构。
