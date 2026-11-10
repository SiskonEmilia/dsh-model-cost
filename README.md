# dsh-model-cost

基于 [LiteLLM Model Cost Map](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) 的 DeepSeek Harness 花费统计插件。

它把会话日志里每次模型调用的 usage（未缓存输入 / 缓存读 / 缓存写 / 输出）按价目表换算成美元，
并且按 LiteLLM 的 `off_peak_pricing` 规则判断这次调用落在**峰时**还是**谷时**——用完成时间定价，
与 LiteLLM 自身的计费口径一致。

## 两个界面

### 1. 输入框状态栏的会话成本 pill

在与 `1 轮 2 步 · 383 tok/s`、`14K tok · 缓存命中 3%` 同一行的 dock 里，追加一枚价格标签：

```
[价格图标] $0.042 · 谷
```

- **图标颜色表示当前档位**：峰时黄（`--dsw-alias-state-warn-primary`）、谷时绿（`--dsw-alias-state-success-primary`）、
  该模型没有峰谷价时用正常文字色（`--dsw-alias-label-tertiary`）、未映射到价格时红。
- **悬停**（或点击钉住）显示计价细节：当前模型与计价 key、当前时段与「多久后进入峰/谷」、
  每百万 token 的输入/输出/缓存读/缓存写单价、**今天的时间条**（按本地时区把一天切成峰/谷区段，
  区段上方标峰/谷、下方标时间刻度、条内用颜色区分并画出「现在」的位置）、
  本会话请求数与 tokens、峰/谷花费拆分，以及按模型的花费明细。面板底部给出
  「查看完整计价规则」链接，指向价目表条目自带的 `source`（供应商官方定价页）；
  条目没有 `source` 时退回 [models.litellm.ai](https://models.litellm.ai/)。
- 会话还没有任何计费调用时不显示，避免空占位。

### 2. 左侧栏「模型成本」入口 → 全局统计页

- **时间范围**：全部 / 今天 / 近 7 天 / 近 30 天。
- **统计口径**：模型、Provider、会话、日期、峰谷。
- **概览卡片**：总成本、请求数、总 tokens、缓存命中率、峰/谷占比、未定价调用数。
- **用量走势图**：按天一根柱子的花费 / 请求 / Tokens 走势，可在三种指标间切换。
  花费模式下柱子按峰（黄）/ 谷（绿）/ 无峰谷（主题色）堆叠；没有记录的日子画成空位，
  时间轴按真实日期连续铺开，不会把空档挤掉。时间跨度长时自动汇总：超过 120 天按周、
  超过 540 天按月，标题会注明当前口径。悬停任意柱子，底部显示那天（或那周/那月）的
  日期、花费、调用数、tokens 与峰/谷拆分。
- **分组表**：每组成本、占比条形、调用数、输入/缓存读/输出 tokens。
- **价格映射**：列出会话记录里观察到的每一条 `provider / model` 路由，
  显示当前解析结果（自动 / 多义 / 未定价）与它使用的价目表 key，并可改成本地映射规则。
  规则按 `provider + model` 或仅 `model` 生效，保存后立即用于统计与 pill。

## 计价规则

- 单位：LiteLLM 价目表统一是 **USD / token**；界面上的「单价」显示为每百万 token。
- 分桶：`input_cost_per_token`、`output_cost_per_token`、`cache_read_input_token_cost`、
  `cache_creation_input_token_cost`；某项缺失时按该条目的 input 价计（缓存读还会先尝试
  `input_cost_per_token_cache_hit`）。
- 峰谷：`off_peak_pricing` 的 `hours_utc`（支持字符串或数组）、`windows[].weekdays`、
  `weekday_timezone` 全部支持；窗口可跨午夜，`00:00-00:00` 表示全天；命中窗口时用块内单价**替换**标准单价。
  UI 上按浏览器时区把「今天」切成峰/谷区段画成时间条（完整周规则去供应商定价页看）。
- 请求按 `assistant/message` 事件的完成时间定价。
- 长上下文阶梯价（`input_cost_per_token_above_200k_tokens` 等）、批量/优先档
  （`_batches` / `_priority` / `_flex`）、图片/音频/秒计费暂不参与计算。

## 价格映射

自动解析顺序：**手动规则** → 价目表里 `model` 或 `provider/model` 完全一致 → 模型名（key 最后一段）唯一命中。
多义时按 provider 亲和度排序取第一个并标注「多义」，界面可一键改成显式规则。

规则保存在 `$DSH_HOME/model-cost/config.json`（默认 `~/.dsh/model-cost/config.json`）：

```json
{
  "version": 1,
  "rules": [
    { "provider": "zai-coding-cn", "model": "glm-5.3", "key": "zai/glm-5.3" }
  ],
  "prefs": {}
}
```

## 价目表

随插件内置一份精简快照（`data/cost-map.json`，约 1 MB，只保留计价与峰谷字段）。
页面右上角「更新价目表」会让 Host 拉取上游最新 JSON 并存到
`~/.dsh/model-cost/cost-map.json`，之后该文件优先于内置快照。

重新生成内置快照：

```sh
node tools/build-cost-map.mjs                 # 下载上游并写入 data/cost-map.json
node tools/build-cost-map.mjs path/to.json    # 用本地 JSON 生成
```

## 安装（Desktop profile）

```powershell
pwsh -File .\install-desktop.ps1
```

脚本用 Desktop 自带的 Electron Node 运行 `dsh plugin --profile desktop add`，
把插件作为 bundle 写进 `~/.dsh/profiles/desktop`。装完需要重启 Desktop 才会加载 Host 半边；
已在运行时改过 `index.js`（Host 代码）也一样——重启 Desktop，或在 Settings → Plugins 里把
`dsh-model-cost` 关掉再打开，让 Cordis 重新 import Host 模块。改 `client.js` 只需刷新页面。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：`modelCost` Remote 服务，读会话日志、算钱、管映射与价目表 |
| `pricing.js` | 纯计价引擎：窗口解析、峰谷判定、今日谷时段换算、单价与成本计算、key 解析、按日序列补空（无 Cordis 依赖，可直接测试） |
| `client.js` | 浏览器半边：composer dock 的 pill 与左侧栏全局统计页 |
| `data/cost-map.json` | 内置精简价目表快照 |
| `test/pricing.test.mjs` | 计价引擎单测（`node --test "test/*.test.mjs"`） |
| `tools/build-cost-map.mjs` | 从上游或本地 JSON 重新生成内置快照 |
| `tools/cli-run.mjs` | 用 Desktop 自带 Electron Node 跑任意 `dsh ...` 子命令（安装、`--dump-config` 等） |

数据来源：会话日志的 `request/header`（provider、model）与 `assistant/message`（usage、完成时间）；
会话枚举与冷会话读取走 `ctx.sessionQuery`，活跃会话走 `ctx.sessions`。

## 已知限制

- 只在 `assistant/message` 携带 `usage` 时计价；适配器未上报 usage 的调用不计。
- 缓存写入价缺失时按输入价计，这是 LiteLLM 的兜底口径，个别供应商的真实账单可能不同。
- 全局统计一次最多扫描 800 个会话（按最新优先），超出的会提示截断。
- 会话详情页的标题来自 `session/title`，读取失败时回退到会话 id 前 8 位。
