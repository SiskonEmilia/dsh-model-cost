# dsh-model-cost 参考：计价、缓存与实现

日常使用看 [README](../README.md) 就够了。这一页写给想弄清「这个数字从哪来」、或者要改插件的人。

## 计价规则

- 单位：LiteLLM 价目表统一是 **USD / token**；界面上的「单价」显示为每百万 token。
- 分桶：`input_cost_per_token`、`output_cost_per_token`、`cache_read_input_token_cost`、
  `cache_creation_input_token_cost`；某项缺失时按该条目的 input 价计（缓存读还会先尝试
  `input_cost_per_token_cache_hit`）。
- 峰谷：`off_peak_pricing` 的 `hours_utc`（支持字符串或数组）、`windows[].weekdays`、
  `weekday_timezone` 全部支持；窗口可跨午夜，`00:00-00:00` 表示全天；命中窗口时用块内单价**替换**标准单价。
  UI 上按浏览器时区把「今天」切成峰/谷区段画成时间条（完整周规则去供应商定价页看）。
- 请求按 `assistant/message` 事件的完成时间定价。
- **fork 子会话只计自己产生的调用**：fork 时父会话的事件前缀会原样复制进子会话日志
  （`inheritedEventCount` 之前的那些事件），这些调用已经记在父会话名下，所以扫描时跳过，
  全局合计不会重复。会话成本面板的标题金额写成 `$0.238 (+fork $1.23)` —— 括号里是
  fork 前的继承花费，底部注释说明当前会话是 fork、与父对话分别计算。
  前缀是 fork 时刻的冻结副本：父会话之后新增的消息只追加到父会话日志，不会进入子会话，
  「fork 前」金额因此不会随父会话继续活动而变化。
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

规则按 `provider + model` 匹配；省略 `provider` 时只按 `model` 匹配，对任意 provider 生效。`model` 与 `key` 必填。

## 价目表

随插件内置一份精简快照（`data/cost-map.json`，约 1 MB，只保留计价与峰谷字段）。
页面右上角「更新价目表」会让 Host 拉取上游最新 JSON 并存到
`~/.dsh/model-cost/cost-map.json`，之后该文件优先于内置快照。

重新生成内置快照：

```sh
node tools/build-cost-map.mjs                 # 下载上游并写入 data/cost-map.json
node tools/build-cost-map.mjs path/to.json    # 用本地 JSON 生成
```

## 本地缓存

统计页与会话面板读同一份「每会话已解析的 usage 行」。这份数据按会话落盘在
`$DSH_HOME/model-cost/cache/<session>.json`，重启后不再重读未变化的日志：

- **格式版本**：每个文件带 `version`。当前实现不认识的版本直接当未命中，读完日志后覆盖重写。
- **增量依据**：文件里记着读日志时 `sessionPersistence` 给出的 `revision`（由文件 stat 派生，
  追加或改写都会变）。下次统计先比对 revision：一致就直接用缓存，**不打开日志**；
  不一致才重读该会话，并复用已解析的前缀、只解析追加的尾部。
  活跃会话（`ctx.sessions` 里还在内存中的）不走磁盘缓存——它们的事件可能比已刷盘的新，
  直接按内存增量解析；只有落盘且 revision 可比的会话才走缓存。
- **计价签名**：`pricing` = 计价引擎版本（`PRICING_VERSION`）+ 价目表内容指纹 + 映射规则指纹。
  签名一致就沿用缓存里的 `cost`/`phase`；更新价目表、改映射规则或升级计价引擎后，
  只对已缓存的行重新定价，不重读日志。
- **清理**：写入走「临时文件 + rename」，中断不会留下半截文件；统计时顺手删除已不在
  会话列表里、且超过 7 天的缓存，以及一小时前的临时文件。

## 数据来源

会话日志的 `request/header` 提供 provider、model，`assistant/message` 提供 usage 与完成时间。

会话枚举与冷会话读取走 `ctx.sessionQuery`，活跃会话走 `ctx.sessions`，
冷会话的变更判定走 `ctx.sessionPersistence` 报告的 `revision`。

插件只读取这些结构化字段，不读取消息正文；唯一的外网请求是手动更新价目表时拉取上游 JSON。

## 代码结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：`modelCost` Remote 服务，读会话日志、算钱、管映射与价目表 |
| `usage.js` | 会话日志解析：跟踪 `request/header` / `request/context` 的计价路由，抽取 `assistant/message` 的 usage，跳过 fork 继承的前缀；并支持从上次读到的位置续读 |
| `pricing.js` | 纯计价引擎：窗口解析、峰谷判定、今日谷时段换算、单价与成本计算、key 解析、按日序列补空、按小时分桶（无 Cordis 依赖，可直接测试） |
| `cache.js` | 会话行缓存的文件格式：版本号、行的编码与校验、计价签名 |
| `client.js` | 浏览器半边：composer dock 的会话成本 pill、新会话的模型价签、左侧栏全局统计页 |
| `data/cost-map.json` | 内置精简价目表快照 |
| `test/pricing.test.mjs` | 计价引擎单测（`node --test "test/*.test.mjs"`） |
| `test/usage.test.mjs` | 日志解析、续读前缀校验与 fork 前缀跳过单测 |
| `test/cache.test.mjs` | 缓存格式的编解码与损坏数据拒绝 |
| `test/service.test.mjs` | Host 服务的端到端行为（重启续用缓存、追加只读尾部、改规则重定价、版本不匹配回退、来源筛选） |
| `test/support/` | 上述 Host 测试用的 Cordis / Typert 桩与模块解析钩子 |
| `tools/build-cost-map.mjs` | 从上游或本地 JSON 重新生成内置快照 |
| `tools/cli-run.mjs` | 用 Desktop 自带 Electron Node 跑任意 `dsh ...` 子命令（安装、`--dump-config` 等） |

## 已知限制

- 只在 `assistant/message` 携带 `usage` 时计价；适配器未上报 usage 的调用不计。
- 缓存写入价缺失时按输入价计，这是 LiteLLM 的兜底口径，个别供应商的真实账单可能不同。
- 全局统计一次最多扫描 800 个会话（按最新优先），超出的会提示截断。
- 会话详情页的标题来自 `session/title`，读取失败时回退到会话 id 前 8 位。
- 第一次统计（或缓存被清空后）仍要读一遍所有会话日志；之后只读 revision 变化过的日志。
  上次运行期间活跃的会话不写缓存（内存事件可能比已刷盘的多），重启后第一次统计会重读它们。

## 文档与截图

文档中的截图使用模拟数据渲染：数字与峰谷判断由真实 Host 服务算出，
输入框外壳按 DSH 的实际布局复刻，pill、价签与弹层都是插件真实组件。
