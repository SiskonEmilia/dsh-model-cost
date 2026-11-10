/** Model cost browser half.
 *
 * Adds two surfaces to the Web client. A composer-dock pill shows the running
 * cost of the current Session beside the speed and usage readings, with a price
 * tag whose color states the peak/off-peak tariff now in force. The left
 * sidebar's "Model cost" entry opens a global page: range and grouping
 * selectors over every Session, the per-route price table, and the mapping
 * editor that points local provider/model ids at cost-map keys.
 *
 * The host half (index.js) owns pricing, the cost map, and persistence; this
 * half only reads it through the `modelCost` Remote namespace.
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-cost',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    /* ------------------------------------------------------------------ */
    /* Primitives (platform module; absent only in a stripped shell)       */
    /* ------------------------------------------------------------------ */

    let primitives = {}
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch (error) {
      console.warn('[model-cost] UI primitives unavailable', error)
    }
    const { useAnchoredPosition, useDismissOnOutsidePointer } = primitives

    const NS = 'modelCost'
    const PANEL_ID = 'model-cost'
    const PILL_ID = 'cost'
    const PANEL_MARGIN = 12
    const PANEL_GAP = 8
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 }
    /** Fallback detail page when a cost-map entry carries no provider price source. */
    const COST_MAP_BROWSE_URL = 'https://models.litellm.ai/'
    /** Browser-local memory of the sources the reader hid from the statistics. */
    const HIDDEN_SOURCES_KEY = 'dsh-model-cost:hidden-sources'

    /**
     * Read the hidden-source list, tolerating a browser that forbids storage.
     * @returns {string[]} provider ids.
     */
    function readHiddenSources() {
      try {
        const raw = window.localStorage.getItem(HIDDEN_SOURCES_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        return Array.isArray(parsed) ? parsed.filter(value => typeof value === 'string') : []
      } catch (_unavailable) {
        return []
      }
    }

    /**
     * Persist the hidden-source list for the next visit.
     * @param {string[]} list - provider ids.
     * @returns {void}
     */
    function writeHiddenSources(list) {
      try {
        window.localStorage.setItem(HIDDEN_SOURCES_KEY, JSON.stringify(list))
      } catch (_unavailable) {
        // Storage is optional: the filter still applies to this page view.
      }
    }

    /* ------------------------------------------------------------------ */
    /* Locale                                                              */
    /* ------------------------------------------------------------------ */

    const en = {
      'panel': 'Model cost',
      'title': 'Model cost',
      'subtitle': 'Session and corpus spend priced with the LiteLLM Model Cost Map',
      'refresh': 'Refresh',
      'refreshMap': 'Update price map',
      'refreshingMap': 'Updating…',
      'mapMeta': 'Price map · {entries} models · snapshot {date}',
      'mapMetaNoDate': 'Price map · {entries} models',
      'mapOriginUser': 'Updated locally',
      'mapOriginSnapshot': 'Bundled with the plugin',
      'mapSource': 'Source',
      'scanMeta': 'Scanned {scanned} of {available} sessions',
      'scanCached': '{count} from cache',
      'scanCapped': 'Only the newest {scanned} sessions were scanned.',
      'loading': 'Reading session history…',
      'empty': 'No priced model calls in this range yet.',
      'error': 'Could not read cost statistics: {message}',
      'retry': 'Retry',
      'range.all': 'All time',
      'range.today': 'Today',
      'range.7d': 'Last 7 days',
      'range.30d': 'Last 30 days',
      'dimension.model': 'Model',
      'dimension.provider': 'Provider',
      'dimension.session': 'Session',
      'dimension.day': 'Day',
      'dimension.phase': 'Peak / off-peak',
      'dimensionLabel': 'Group by',
      'rangeLabel': 'Range',
      'sourcesLabel': 'Sources',
      'sourcesEmpty': 'Every source is hidden. Turn one back on above.',
      'sourceUnknown': 'Unknown',
      'card.cost': 'Total cost',
      'card.requests': 'Requests',
      'card.tokens': 'Tokens',
      'card.cacheHit': 'Cache hit',
      'card.phase': 'Peak / off-peak',
      'card.unpriced': 'Unpriced calls',
      'phase.peak': 'Peak',
      'phase.offpeak': 'Off-peak',
      'phase.flat': 'Flat',
      'phase.unresolved': 'Unpriced',
      'phaseShort.peak': 'Peak',
      'phaseShort.offpeak': 'Off-peak',
      'phaseShort.flat': 'Flat',
      'phaseShort.unresolved': 'Unpriced',
      'costColumn': 'Cost',
      'shareColumn': 'Share',
      'requestsColumn': 'Calls',
      'inputColumn': 'Input',
      'cacheReadColumn': 'Cache read',
      'cacheWriteColumn': 'Cache write',
      'outputColumn': 'Output',
      'items.input': 'Uncached input',
      'items.cacheRead': 'Cache read',
      'items.cacheWrite': 'Cache write',
      'items.output': 'Output',
      'mappingTitle': 'Price mapping',
      'mappingIntro': 'Point a provider or a model id recorded in your sessions at a cost-map key. Rules win over automatic matching.',
      'mappingEmpty': 'No model call has been recorded yet.',
      'mappingProvider': 'Provider',
      'mappingModel': 'Model id',
      'mappingKey': 'Cost-map key',
      'mappingStatusAuto': 'Auto',
      'mappingStatusRule': 'Mapped',
      'mappingStatusAmbiguous': 'Ambiguous',
      'mappingStatusMissing': 'Unpriced',
      'mappingSearch': 'Search a cost-map key…',
      'mappingNoResults': 'No key matches that text.',
      'mappingAdd': 'Add mapping',
      'mappingRemove': 'Remove mapping for {model}',
      'mappingApply': 'Save mapping',
      'mappingDiscard': 'Discard',
      'mappingUnsaved': 'Unsaved mapping changes',
      'mappingSaved': 'Mapping saved.',
      'mappingSavedRules': 'Saved {count} rules.',
      'mappingViaExact': 'exact key',
      'mappingViaTail': 'matched by model name',
      'mappingViaRule': 'your rule',
      'mappingFailed': 'Saving failed: {message}',
      'mappingUnresolved': 'Not priced — choose a key',
      'mappingPick': 'Choose a key',
      'mappingChange': 'Change the key for {model}',
      'openPage': 'Open global statistics',
      'dialogTitle': 'Session cost',
      'dialogRoute': 'Model',
      'dialogKey': 'Priced as',
      'dialogPhase': 'Tariff now',
      'dialogNext': 'Next change',
      'dialogRates': 'Rates per 1M tokens',
      'dialogRateInput': 'Input',
      'dialogRateOutput': 'Output',
      'dialogRateCache': 'Cache read',
      'dialogRateWrite': 'Cache write',
      'dialogSpent': 'Spent this Session',
      'dialogTokens': 'Tokens this Session',
      'dialogPeakSplit': 'Peak / off-peak spend',
      'dialogForkExtra': ' (+fork {cost})',
      'dialogForkNote': '*This Session is a fork; its spend and the parent Session are counted separately.',
      'dialogModels': 'Per-model spend',
      'dialogUnpriced': '{count} unpriced calls',
      'dialogEmpty': 'Nothing priced in this Session yet.',
      'dialogHint': 'Click for details · the tag color states the tariff',
      'inMinutes': 'in {minutes} min',
      'inHours': 'in {hours} h {minutes} min',
      'phasePeakHint': 'Peak hours: the standard rate applies',
      'phaseOffpeakHint': 'Off-peak window open: the discounted rate applies',
      'phaseFlatHint': 'This model has no peak/off-peak schedule',
      'phaseUnresolvedHint': 'This model is not mapped to a price yet',
      'timelineCaption': "Today's tariff (local time)",
      'timelineNow': 'Now',
      'nextChangeInto': '{when} → {phase}',
      'priceSource': 'Full pricing rules',
      'allTime': 'all time',
      'sessionsCount': '{count} sessions',
      'sessionsWithUsage': '{count} sessions with usage',
      'trendTitle': 'Usage trend',
      'trendMetric': 'Metric',
      'metric.cost': 'Cost',
      'metric.requests': 'Requests',
      'metric.tokens': 'Tokens',
      'trendDaily': 'daily',
      'trendWeekly': 'weekly',
      'trendMonthly': 'monthly',
      'trendHourly': 'hourly',
      'trendSpanDays': '{count} days',
      'trendSpanWeeks': '{count} weeks',
      'trendSpanMonths': '{count} months',
      'trendEmpty': 'Nothing recorded in this range yet.',
      'trendHint': 'Hover a bar for its detail.',
      'trendTotal': 'Total {value}',
      'trendAria': 'Usage trend',
      'close': 'Close',
    }

    const zh = {
      'panel': '模型成本',
      'title': '模型成本',
      'subtitle': '基于 LiteLLM Model Cost Map 的会话与全局花费统计',
      'refresh': '刷新',
      'refreshMap': '更新价目表',
      'refreshingMap': '更新中…',
      'mapMeta': '价目表 · {entries} 个模型 · 快照 {date}',
      'mapMetaNoDate': '价目表 · {entries} 个模型',
      'mapOriginUser': '本地更新',
      'mapOriginSnapshot': '随插件内置',
      'mapSource': '来源',
      'scanMeta': '已扫描 {scanned} / {available} 个会话',
      'scanCached': '{count} 个来自本地缓存',
      'scanCapped': '仅扫描了最新的 {scanned} 个会话。',
      'loading': '正在读取会话记录…',
      'empty': '该范围内还没有可计价的模型调用。',
      'error': '读取成本统计失败：{message}',
      'retry': '重试',
      'range.all': '全部',
      'range.today': '今天',
      'range.7d': '近 7 天',
      'range.30d': '近 30 天',
      'dimension.model': '模型',
      'dimension.provider': 'Provider',
      'dimension.session': '会话',
      'dimension.day': '日期',
      'dimension.phase': '峰谷',
      'dimensionLabel': '统计口径',
      'rangeLabel': '时间范围',
      'sourcesLabel': '来源',
      'sourcesEmpty': '所有来源都被隐藏了，在上方重新打开一个即可恢复统计。',
      'sourceUnknown': '未记录',
      'card.cost': '总成本',
      'card.requests': '请求数',
      'card.tokens': 'Tokens',
      'card.cacheHit': '缓存命中',
      'card.phase': '峰 / 谷',
      'card.unpriced': '未定价调用',
      'phase.peak': '峰时',
      'phase.offpeak': '谷时',
      'phase.flat': '无峰谷',
      'phase.unresolved': '未定价',
      'phaseShort.peak': '峰',
      'phaseShort.offpeak': '谷',
      'phaseShort.flat': '平',
      'phaseShort.unresolved': '未定价',
      'costColumn': '成本',
      'shareColumn': '占比',
      'requestsColumn': '调用',
      'inputColumn': '输入',
      'cacheReadColumn': '缓存读',
      'cacheWriteColumn': '缓存写',
      'outputColumn': '输出',
      'items.input': '未缓存输入',
      'items.cacheRead': '缓存读',
      'items.cacheWrite': '缓存写',
      'items.output': '输出',
      'mappingTitle': '价格映射',
      'mappingIntro': '把会话记录中的 provider 或模型 id 指向价目表中的 key。手动映射优先于自动匹配。',
      'mappingEmpty': '还没有记录到模型调用。',
      'mappingProvider': 'Provider',
      'mappingModel': '模型 id',
      'mappingKey': '价目表 key',
      'mappingStatusAuto': '自动',
      'mappingStatusRule': '已映射',
      'mappingStatusAmbiguous': '多义',
      'mappingStatusMissing': '未定价',
      'mappingSearch': '搜索价目表 key…',
      'mappingNoResults': '没有匹配的 key。',
      'mappingAdd': '添加映射',
      'mappingRemove': '移除 {model} 的映射',
      'mappingApply': '保存映射',
      'mappingDiscard': '放弃',
      'mappingUnsaved': '有未保存的映射改动',
      'mappingSaved': '映射已保存。',
      'mappingSavedRules': '已保存 {count} 条规则。',
      'mappingViaExact': '精确匹配',
      'mappingViaTail': '按模型名匹配',
      'mappingViaRule': '手动映射',
      'mappingFailed': '保存失败：{message}',
      'mappingUnresolved': '未定价 — 请选择 key',
      'mappingPick': '选择 key',
      'mappingChange': '修改 {model} 的 key',
      'openPage': '打开全局统计',
      'dialogTitle': '会话成本',
      'dialogRoute': '模型',
      'dialogKey': '计价 key',
      'dialogPhase': '当前时段',
      'dialogNext': '下次切换',
      'dialogRates': '单价（每百万 token）',
      'dialogRateInput': '输入',
      'dialogRateOutput': '输出',
      'dialogRateCache': '缓存读',
      'dialogRateWrite': '缓存写',
      'dialogSpent': '本会话花费',
      'dialogTokens': '本会话 tokens',
      'dialogPeakSplit': '峰 / 谷 花费',
      'dialogForkExtra': ' (+fork {cost})',
      'dialogForkNote': '*当前会话为 fork 对话，和父对话价格分别计算',
      'dialogModels': '分模型花费',
      'dialogUnpriced': '{count} 次未定价',
      'dialogEmpty': '本会话还没有可计价的花费。',
      'dialogHint': '点击查看明细 · 图标颜色表示当前档位',
      'inMinutes': '{minutes} 分钟后',
      'inHours': '{hours} 小时 {minutes} 分后',
      'phasePeakHint': '峰时：按标准价计费',
      'phaseOffpeakHint': '谷时：按优惠价计费',
      'phaseFlatHint': '该模型没有峰谷价',
      'phaseUnresolvedHint': '该模型尚未映射到价格',
      'timelineCaption': '今日时段（本地时间）',
      'timelineNow': '现在',
      'nextChangeInto': '{when}进入{phase}',
      'priceSource': '查看完整计价规则',
      'allTime': '全部时间',
      'sessionsCount': '{count} 个会话',
      'sessionsWithUsage': '{count} 个会话有花费',
      'trendTitle': '用量走势',
      'trendMetric': '指标',
      'metric.cost': '花费',
      'metric.requests': '请求',
      'metric.tokens': 'Tokens',
      'trendDaily': '按天',
      'trendWeekly': '按周',
      'trendMonthly': '按月',
      'trendHourly': '按小时',
      'trendSpanDays': '{count} 天',
      'trendSpanWeeks': '{count} 周',
      'trendSpanMonths': '{count} 个月',
      'trendEmpty': '这个范围内还没有记录。',
      'trendHint': '悬停柱状查看明细',
      'trendTotal': '合计 {value}',
      'trendAria': '用量走势',
      'close': '关闭',
    }

    /* ------------------------------------------------------------------ */
    /* Remote contribution                                                 */
    /* ------------------------------------------------------------------ */

    const unusedCreate = () => {
      throw new Error('dsh-model-cost: hand-built descriptor codec has no Zod schema')
    }

    /**
     * Build one direct Remote method descriptor for the hand-written host service.
     * @param {string} method - host method name.
     * @param {string[]} params - ordered parameter names.
     * @returns {object} descriptor accepted by ctx.remote.$mount.
     */
    function directMethod(method, params) {
      return {
        id: `dsh-model-cost#modelCost/${method}`,
        namespace: 'modelCost',
        method,
        service: 'modelCost',
        invocation: { kind: 'direct' },
        parameters: params.map(name => ({
          name,
          wire: name,
          source: 'json',
          codec: { mode: 'strict', typeSymbol: `dsh-model-cost#modelCost/${method}:${name}`, create: unusedCreate },
        })),
        result: { mode: 'src-json' },
      }
    }

    const contribution = {
      package: 'dsh-model-cost',
      descriptors: [
        directMethod('session', ['sessionId', 'timeZone']),
        directMethod('report', ['query']),
        directMethod('searchKeys', ['query']),
        directMethod('saveMapping', ['rules']),
        directMethod('refreshMap', []),
      ],
    }

    /* ------------------------------------------------------------------ */
    /* Formatting helpers                                                  */
    /* ------------------------------------------------------------------ */

    /**
     * Format a USD amount with enough digits to stay informative.
     * @param {number} value - amount in USD.
     * @returns {string} display text.
     */
    function formatCost(value) {
      const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (amount === 0) return '$0'
      if (amount < 0.0001) return '<$0.0001'
      if (amount < 0.01) return `$${amount.toFixed(4)}`
      if (amount < 1) return `$${amount.toFixed(3)}`
      if (amount < 1000) return `$${amount.toFixed(2)}`
      return `$${Math.round(amount).toLocaleString('en-US')}`
    }

    /**
     * Format a per-million-token rate, keeping sub-cent prices readable.
     * @param {number} value - USD per 1M tokens.
     * @returns {string} display text.
     */
    function formatRate(value) {
      const amount = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (amount === 0) return '$0'
      if (amount < 0.01) return `$${amount.toFixed(3)}`
      if (amount < 1) return `$${amount.toFixed(2)}`
      if (amount < 100) return `$${amount.toFixed(2)}`
      return `$${amount.toFixed(0)}`
    }

    /**
     * Format a token count compactly.
     * @param {number} value - token count.
     * @returns {string} `1.2M`, `14K`, or the exact count.
     */
    function formatTokens(value) {
      const count = typeof value === 'number' && Number.isFinite(value) ? value : 0
      if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`
      if (count >= 1_000) return `${(count / 1_000).toFixed(count >= 10_000 ? 0 : 1)}K`
      return String(Math.round(count))
    }

    /**
     * Format a share as a whole percentage.
     * @param {number} ratio - 0..1.
     * @returns {string} `42%`.
     */
    function formatPercent(ratio) {
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—'
      return `${Math.round(ratio * 100)}%`
    }

    /**
     * CSS color class for one tariff state.
     * @param {string} state - `peak`, `offpeak`, `flat`, or `unresolved`.
     * @returns {string} class name that sets the matching color.
     */
    function tagClassOf(state) {
      if (state === 'peak') return 'dsh-mc-tag-peak'
      if (state === 'offpeak') return 'dsh-mc-tag-offpeak'
      if (state === 'unresolved') return 'dsh-mc-tag-unresolved'
      return 'dsh-mc-tag-flat'
    }

    /**
     * Render the distance to the next tariff change and the state it enters.
     * @param {number|null} nextAt - instant of the change.
     * @param {'peak'|'offpeak'|null} nextState - state after the change.
     * @param {number} now - current instant.
     * @param {(key: string, params?: object) => string} t - translator.
     * @returns {string} display text, or an empty string when no change is scheduled.
     */
    function formatNextChange(nextAt, nextState, now, t) {
      if (typeof nextAt !== 'number') return ''
      const minutes = Math.max(1, Math.round((nextAt - now) / 60000))
      const when = minutes < 60
        ? t('inMinutes', { minutes })
        : t('inHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
      if (nextState === null || nextState === undefined) return when
      return t('nextChangeInto', { when, phase: t(`phase.${nextState}`) })
    }

    /**
     * Read `HH:MM` as minutes after midnight.
     * @param {string} clock - time text.
     * @returns {number} minutes, 0..1440.
     */
    function clockMinutes(clock) {
      const [hours, minutes] = clock.split(':').map(Number)
      return hours * 60 + minutes
    }

    /**
     * One day's tariff as a proportional bar: state labels above, a colored
     * track with a "now" mark, and boundary times below.
     * @param {{segments: {start: string, end: string, state: string}[], nowAt: number, t: Function}} props - day segments.
     * @returns {object} timeline element.
     */
    function PhaseTimeline({ segments, nowAt, t }) {
      const DAY = 1440
      const percentOf = clock => (clock === '24:00' ? DAY : clockMinutes(clock)) / DAY * 100
      const now = new Date(nowAt)
      const nowPercent = Math.min(100, Math.max(0, (now.getHours() * 60 + now.getMinutes()) / DAY * 100))

      const boundaries = []
      for (const segment of segments) if (!boundaries.includes(segment.start)) boundaries.push(segment.start)
      const lastBoundary = segments[segments.length - 1]?.end ?? '24:00'
      if (!boundaries.includes(lastBoundary)) boundaries.push(lastBoundary)
      const ticks = []
      let previous = Number.NEGATIVE_INFINITY
      boundaries.forEach((clock, index) => {
        const percent = percentOf(clock)
        const isLast = index === boundaries.length - 1
        // Keep the trailing 24:00 even when it crowds its neighbour; other
        // labels need about six percent of the bar to stay legible.
        if (!isLast && percent - previous < 6) return
        ticks.push({ clock, percent })
        previous = percent
      })

      return h('div', { className: 'dsh-mc-timeline' },
        h('div', { className: 'dsh-mc-timeline-labels', 'aria-hidden': true },
          segments.map((segment, index) => {
            const left = percentOf(segment.start)
            const width = percentOf(segment.end) - left
            const label = t(`phaseShort.${segment.state}`)
            // Roughly 1.7% of the panel per character at the 10px label size;
            // a segment too narrow for its word shows the color alone.
            const needed = Math.max(3, label.length * 1.7)
            return h('span', {
              key: `label-${index}`,
              className: `dsh-mc-timeline-label dsh-mc-tl-${segment.state}`,
              // Position is inline so a stale stylesheet can never reflow the
              // bar into running text; only the colors come from CSS.
              style: { position: 'absolute', left: `${left}%`, width: `${width}%` },
            }, width >= needed ? label : '')
          })),
        h('div', {
          className: 'dsh-mc-timeline-track',
          role: 'img',
          'aria-label': segments.map(segment => `${segment.start}–${segment.end} ${t(`phaseShort.${segment.state}`)}`).join(', '),
        },
          segments.map((segment, index) => {
            const left = percentOf(segment.start)
            return h('span', {
              key: `segment-${index}`,
              className: `dsh-mc-timeline-seg dsh-mc-tl-${segment.state}`,
              style: {
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${left}%`,
                width: `${percentOf(segment.end) - left}%`,
              },
              title: `${segment.start}–${segment.end} ${t(`phaseShort.${segment.state}`)}`,
            })
          }),
          h('span', {
            className: 'dsh-mc-timeline-now',
            style: { position: 'absolute', left: `${nowPercent}%` },
            title: t('timelineNow'),
          })),
        h('div', { className: 'dsh-mc-timeline-ticks', 'aria-hidden': true },
          ticks.map(tick => h('span', {
            key: tick.clock,
            className: 'dsh-mc-timeline-tick',
            style: { position: 'absolute', left: `${tick.percent}%` },
          }, tick.clock))),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Price-tag glyph; inherits `currentColor`, so the tariff state colors it.
     * @param {{size?: number, className?: string}} props - size and class.
     * @returns {object} svg element.
     */
    function PriceTag({ size = 14, className }) {
      return h('svg', {
        className,
        width: size,
        height: size,
        viewBox: '0 0 16 16',
        fill: 'none',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: 'M8.05 1.6H13.4a1 1 0 0 1 1 1v5.35a1.6 1.6 0 0 1-.47 1.13l-4.6 4.6a1.6 1.6 0 0 1-2.26 0L2.32 8.93a1.6 1.6 0 0 1 0-2.26l4.6-4.6a1.6 1.6 0 0 1 1.13-.47Z',
          stroke: 'currentColor',
          strokeWidth: '1.2',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: '11.3', cy: '4.7', r: '1.05', fill: 'currentColor' }),
      )
    }

    /**
     * Chevron used by the selectors.
     * @param {{size?: number}} props - size.
     * @returns {object} svg element.
     */
    function Chevron({ size = 12 }) {
      return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', { d: 'M4 6.5 8 10.5 12 6.5', stroke: 'currentColor', strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    /* ------------------------------------------------------------------ */
    /* Styles                                                              */
    /* ------------------------------------------------------------------ */

    const CSS = `
.dsh-mc-anchor { display: inline-flex; min-width: 0; font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px); line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); }
.dsh-mc-pill { display: inline-flex; align-items: center; gap: 6px; box-sizing: border-box; max-width: 100%; padding: 1px 8px; border: none; border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-variant-numeric: tabular-nums; line-height: inherit; white-space: nowrap; cursor: pointer; }
.dsh-mc-pill[aria-expanded='true'] { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
@media (hover: hover) { .dsh-mc-pill:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); } }
.dsh-mc-pill svg { flex: none; }
.dsh-mc-pill-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.dsh-mc-sep { color: var(--dsw-alias-separator-primary, currentColor); margin: 0 5px; opacity: .7; }
.dsh-mc-tag-peak { color: var(--dsw-alias-state-warn-primary); }
.dsh-mc-tag-offpeak { color: var(--dsw-alias-state-success-primary); }
.dsh-mc-tag-flat { color: var(--dsw-alias-label-tertiary); }
.dsh-mc-tag-unresolved { color: var(--dsw-alias-state-error-primary); }

.dsh-mc-panel { position: fixed; z-index: 1100; box-sizing: border-box; width: max-content; min-width: min(300px, calc(100vw - 24px)); max-width: min(430px, calc(100vw - 24px)); padding: 14px 16px; border: 0; border-radius: var(--dsw-radius-lg, 12px); background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2)); backdrop-filter: var(--dsw-menu-backdrop-filter, blur(12px)); box-shadow: var(--dsw-elevation-prominent, 0 8px 32px rgba(0,0,0,.28)); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: default; }
.dsh-mc-panel-title { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 8px; color: var(--dsw-alias-label-primary); font-weight: 500; }
.dsh-mc-panel-title-label { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.dsh-mc-panel-extra { color: var(--dsw-alias-label-tertiary); font-weight: 400; font-size: 11px; white-space: nowrap; }
.dsh-mc-panel-rule { margin-bottom: 10px; border-top: .5px solid var(--dsw-alias-border-l2); }
.dsh-mc-details { display: grid; grid-template-columns: minmax(82px, auto) minmax(0, 1fr); gap: 5px 16px; margin: 0; }
.dsh-mc-details dt, .dsh-mc-details dd { min-width: 0; margin: 0; }
.dsh-mc-details dt { color: var(--dsw-alias-label-tertiary); }
.dsh-mc-details dd { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }
.dsh-mc-details dd.dsh-mc-left { text-align: left; }
.dsh-mc-phase-value { font-weight: 600; }
.dsh-mc-subhead { margin: 12px 0 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; letter-spacing: .02em; text-transform: uppercase; }
.dsh-mc-block { margin-top: 12px; padding-top: 10px; border-top: .5px solid var(--dsw-alias-border-l2); }
.dsh-mc-block-caption { margin-bottom: 6px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-mc-timeline { display: flex; flex-direction: column; gap: 3px; }
.dsh-mc-timeline-labels { position: relative; height: 13px; font-size: 10px; line-height: 13px; }
.dsh-mc-timeline-label { position: absolute; top: 0; overflow: hidden; text-align: center; white-space: nowrap; }
.dsh-mc-timeline-label.dsh-mc-tl-peak { color: var(--dsw-alias-state-warn-primary); }
.dsh-mc-timeline-label.dsh-mc-tl-offpeak { color: var(--dsw-alias-state-success-primary); }
.dsh-mc-timeline-track { position: relative; height: 12px; overflow: hidden; border-radius: 6px; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.16)); }
.dsh-mc-timeline-seg { position: absolute; top: 0; bottom: 0; opacity: .4; }
.dsh-mc-timeline-seg.dsh-mc-tl-peak { background: var(--dsw-alias-state-warn-primary); }
.dsh-mc-timeline-seg.dsh-mc-tl-offpeak { background: var(--dsw-alias-state-success-primary); }
.dsh-mc-timeline-now { position: absolute; top: -2px; bottom: -2px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--dsw-alias-label-primary); box-shadow: 0 0 0 1.5px var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2)); }
.dsh-mc-timeline-ticks { position: relative; height: 12px; color: var(--dsw-alias-label-tertiary); font-size: 9px; font-variant-numeric: tabular-nums; }
.dsh-mc-timeline-tick { position: absolute; top: 0; white-space: nowrap; transform: translateX(-50%); }
.dsh-mc-timeline-tick:first-child { transform: none; }
.dsh-mc-timeline-tick:last-child { transform: translateX(-100%); }
.dsh-mc-model-row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; font-variant-numeric: tabular-nums; }
.dsh-mc-model-key { color: var(--dsw-alias-label-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mc-model-cost { color: var(--dsw-alias-label-tertiary); flex: none; }
.dsh-mc-note { margin: 10px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-mc-link { border: none; background: none; padding: 0; font: inherit; font-size: 11px; color: var(--dsw-alias-link, var(--dsw-alias-brand-primary)); cursor: pointer; }
.dsh-mc-link:hover { text-decoration: underline; }
.dsh-mc-badge { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; border-radius: 9px; font-size: 11px; line-height: 18px; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.12)); color: var(--dsw-alias-label-tertiary); }
.dsh-mc-badge-warn { color: var(--dsw-alias-state-warn-primary); }
.dsh-mc-badge-ok { color: var(--dsw-alias-state-success-primary); }
.dsh-mc-badge-bad { color: var(--dsw-alias-state-error-primary); }

.dsh-mc-page { display: flex; flex-direction: column; gap: 18px; box-sizing: border-box; width: 100%; height: 100%; padding: 22px 26px 32px; overflow: auto; color: var(--dsw-alias-label-primary); }
.dsh-mc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dsh-mc-h1 { margin: 0; font-size: 18px; font-weight: 600; letter-spacing: -.01em; }
.dsh-mc-sub { margin: 4px 0 0; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-mc-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.dsh-mc-button { box-sizing: border-box; height: 28px; padding: 0 12px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.dsh-mc-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-mc-button:disabled { opacity: .5; cursor: default; }
.dsh-mc-button-primary { background: var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary)); border-color: transparent; color: var(--dsw-alias-label-primary-inverted, #fff); }
.dsh-mc-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); color: var(--dsw-alias-label-primary-inverted, #fff); }
.dsh-mc-toolbar { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.dsh-mc-field { display: inline-flex; align-items: center; gap: 8px; }
.dsh-mc-field-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-mc-segments { display: inline-flex; padding: 2px; gap: 2px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08)); }
.dsh-mc-segment { border: none; background: transparent; color: var(--dsw-alias-label-tertiary); font: inherit; font-size: 12px; line-height: 24px; padding: 0 10px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.dsh-mc-segment[aria-pressed='true'] { background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.18)); color: var(--dsw-alias-label-primary); }
.dsh-mc-segment:hover:not([aria-pressed='true']) { color: var(--dsw-alias-label-secondary); }
.dsh-mc-sources { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.dsh-mc-sources-label { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-mc-chips { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.dsh-mc-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 240px; min-height: 24px; padding: 0 9px 0 7px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 12px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; line-height: 20px; cursor: pointer; }
.dsh-mc-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-mc-chip:focus-visible { outline: 1px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-mc-chip-mark { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 12px; height: 12px; border: .5px solid var(--dsw-alias-border-l2); border-radius: 3px; color: transparent; font-size: 9px; line-height: 1; }
.dsh-mc-chip[aria-pressed='true'] .dsh-mc-chip-mark { border-color: transparent; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-inverted, #fff); }
.dsh-mc-chip[aria-pressed='false'] { color: var(--dsw-alias-label-tertiary); }
.dsh-mc-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mc-chip-cost { flex: none; color: var(--dsw-alias-label-tertiary); font-size: 11px; font-variant-numeric: tabular-nums; }
.dsh-mc-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.dsh-mc-card { padding: 12px 14px; border-radius: var(--dsw-radius-md, 10px); background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.06)); border: .5px solid var(--dsw-alias-border-l1); }
.dsh-mc-card-label { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-mc-card-value { margin-top: 4px; font-size: 17px; font-weight: 550; font-variant-numeric: tabular-nums; }
.dsh-mc-card-note { margin-top: 2px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-mc-section { border: .5px solid var(--dsw-alias-border-l1); border-radius: var(--dsw-radius-md, 10px); overflow: hidden; }
.dsh-mc-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: .5px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsh-mc-section-title { margin: 0; font-size: 13px; font-weight: 550; }
.dsh-mc-section-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-mc-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.dsh-mc-table th { padding: 7px 14px; text-align: left; color: var(--dsw-alias-label-tertiary); font-weight: 400; font-size: 11px; border-bottom: .5px solid var(--dsw-alias-border-l1); white-space: nowrap; }
.dsh-mc-table th.dsh-mc-num, .dsh-mc-table td.dsh-mc-num { text-align: right; font-variant-numeric: tabular-nums; }
.dsh-mc-table td { padding: 7px 14px; border-bottom: .5px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.dsh-mc-table tr:last-child td { border-bottom: none; }
.dsh-mc-table tr:hover td { background: var(--dsw-alias-interactive-bg-hover); }
.dsh-mc-name { color: var(--dsw-alias-label-primary); }
.dsh-mc-bar { position: relative; height: 4px; min-width: 60px; border-radius: 2px; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.16)); overflow: hidden; }
.dsh-mc-bar > span { position: absolute; inset: 0 auto 0 0; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.dsh-mc-trend { display: flex; flex-direction: column; gap: 6px; padding: 14px; }
.dsh-mc-trend-controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.dsh-mc-trend-legend { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-mc-trend-legend-item { display: inline-flex; align-items: center; gap: 5px; }
.dsh-mc-trend-swatch { display: inline-block; width: 8px; height: 8px; border-radius: 2px; }
.dsh-mc-trend-frame { display: flex; gap: 8px; }
.dsh-mc-trend-yaxis { position: relative; flex: none; width: 48px; height: 148px; color: var(--dsw-alias-label-tertiary); font-size: 10px; font-variant-numeric: tabular-nums; }
.dsh-mc-trend-yaxis > span { position: absolute; right: 0; transform: translateY(-50%); white-space: nowrap; }
.dsh-mc-trend-yaxis > span:first-child { transform: translateY(0); }
.dsh-mc-trend-yaxis > span:last-child { transform: translateY(-100%); }
.dsh-mc-trend-plot { position: relative; flex: 1 1 auto; min-width: 0; height: 148px; border-bottom: .5px solid var(--dsw-alias-border-l2); }
.dsh-mc-trend-grid { position: absolute; inset: 0; pointer-events: none; }
.dsh-mc-trend-grid > span { position: absolute; left: 0; right: 0; border-top: .5px dashed var(--dsw-alias-border-l1); }
.dsh-mc-trend-bars { position: absolute; inset: 0; display: flex; align-items: flex-end; }
.dsh-mc-trend-col { position: relative; display: flex; flex: 1 1 0; flex-direction: column; justify-content: flex-end; align-items: center; min-width: 0; height: 100%; border-radius: 3px; }
.dsh-mc-trend-col:hover, .dsh-mc-trend-col:focus-visible { background: var(--dsw-alias-interactive-bg-hover); outline: none; }
.dsh-mc-trend-bar { box-sizing: border-box; display: flex; flex-direction: column; width: 70%; min-width: 2px; max-width: var(--dsh-mc-bar-max, 96px); min-height: 2px; overflow: hidden; border-radius: var(--dsh-mc-bar-radius, 3px) var(--dsh-mc-bar-radius, 3px) 0 0; background: var(--dsw-alias-bg-layer-3, rgba(127,127,127,.14)); }
.dsh-mc-trend-seg { flex: 1 1 0; min-height: 0; }
.dsh-mc-trend-solid { background: var(--dsw-alias-brand-primary); }
.dsh-mc-trend-peak { background: var(--dsw-alias-state-warn-primary); }
.dsh-mc-trend-offpeak { background: var(--dsw-alias-state-success-primary); }
.dsh-mc-trend-xaxis { display: flex; margin-left: 56px; color: var(--dsw-alias-label-tertiary); font-size: 9px; line-height: 12px; }
.dsh-mc-trend-tick { flex: 1 1 0; min-width: 0; text-align: center; white-space: nowrap; overflow: visible; }
.dsh-mc-section.dsh-mc-trend-section { overflow: visible; }
.dsh-mc-trend-tip { position: absolute; z-index: 5; box-sizing: border-box; min-width: 156px; max-width: 260px; padding: 8px 10px; border-radius: var(--dsw-radius-md, 8px); background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2)); backdrop-filter: var(--dsw-menu-backdrop-filter, blur(12px)); box-shadow: var(--dsw-elevation-prominent, 0 8px 24px rgba(0,0,0,.28)); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 16px; pointer-events: none; }
.dsh-mc-trend-tip-head { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; margin-bottom: 5px; }
.dsh-mc-trend-tip-when { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-mc-trend-tip-value { color: var(--dsw-alias-label-primary); font-size: 13px; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-mc-trend-tip-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.dsh-mc-trend-tip-label { display: inline-flex; align-items: center; gap: 5px; color: var(--dsw-alias-label-tertiary); }
.dsh-mc-trend-tip-amount { color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dsh-mc-empty { padding: 26px 14px; text-align: center; color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-mc-error { padding: 12px 14px; border-radius: var(--dsw-radius-md, 10px); background: var(--dsw-alias-interactive-bg-hover-danger, rgba(220,80,80,.12)); color: var(--dsw-alias-state-error-primary); font-size: 12px; display: flex; gap: 10px; align-items: center; justify-content: space-between; }
.dsh-mc-loading { color: var(--dsw-alias-label-tertiary); font-size: 12px; }
.dsh-mc-mapping-row { display: grid; grid-template-columns: minmax(120px, 1fr) minmax(150px, 1.2fr) minmax(200px, 1.6fr) auto; gap: 12px; align-items: center; padding: 8px 14px; border-bottom: .5px solid var(--dsw-alias-border-l1); font-size: 12px; }
.dsh-mc-mapping-row:last-child { border-bottom: none; }
.dsh-mc-mapping-head { color: var(--dsw-alias-label-tertiary); font-size: 11px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,.05)); }
.dsh-mc-mono { font-family: var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mc-keycell { display: flex; align-items: center; gap: 8px; min-width: 0; }
.dsh-mc-keyvalue { border: none; background: none; padding: 0; font: inherit; color: var(--dsw-alias-link, var(--dsw-alias-brand-primary)); cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
.dsh-mc-keyvalue:hover { text-decoration: underline; }
.dsh-mc-keyvalue-missing { color: var(--dsw-alias-state-warn-primary); }
.dsh-mc-input { box-sizing: border-box; width: 100%; height: 26px; padding: 0 8px; border: .5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm, 6px); background: var(--dsw-alias-bg-layer-1, transparent); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
.dsh-mc-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.dsh-mc-picker { position: fixed; z-index: 1200; box-sizing: border-box; width: min(360px, calc(100vw - 24px)); max-height: 260px; overflow: auto; padding: 6px; border-radius: var(--dsw-radius-md, 10px); background: var(--dsw-specific-menu, var(--dsw-alias-bg-layer-2)); box-shadow: var(--dsw-elevation-prominent, 0 8px 32px rgba(0,0,0,.3)); }
.dsh-mc-picker-option { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; width: 100%; padding: 5px 8px; border: none; border-radius: 6px; background: none; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; text-align: left; cursor: pointer; }
.dsh-mc-picker-option[data-active='true'], .dsh-mc-picker-option:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsh-mc-picker-key { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-mc-picker-price { flex: none; color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; font-size: 11px; }
.dsh-mc-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 14px; border-top: .5px solid var(--dsw-alias-border-l1); flex-wrap: wrap; }
.dsh-mc-footer-note { color: var(--dsw-alias-label-tertiary); font-size: 11px; }
.dsh-mc-actions { display: flex; gap: 8px; }
.dsh-mc-spacer { flex: 1; }
@media (max-width: 760px) {
  .dsh-mc-page { padding: 16px 14px 24px; }
  .dsh-mc-mapping-row { grid-template-columns: 1fr; gap: 6px; }
  .dsh-mc-mapping-head { display: none; }
}
`

    /** Install the stylesheet once per page, and refresh it after a bundle reload. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      const existing = document.getElementById('dsh-model-cost-style')
      if (existing !== null) {
        // A hot-reloaded bundle keeps the element the previous bundle injected,
        // so an unchanged guard would leave the page on the old rules.
        if (existing.textContent !== CSS) existing.textContent = CSS
        return
      }
      const style = document.createElement('style')
      style.id = 'dsh-model-cost-style'
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /* ------------------------------------------------------------------ */
    /* Session feed: one observable per visible Session                    */
    /* ------------------------------------------------------------------ */

    /**
     * Poll one Session's cost from the host while at least one component
     * subscribes, and refresh when the Session's log appends a billed call.
     * @param {object} ctx - client plugin context.
     * @param {string} sessionId - Session id observed.
     * @returns {{source: object, refresh: () => void, release: () => void}} feed.
     */
    function createSessionFeed(ctx, sessionId) {
      let snapshot = { status: 'loading', value: null, error: null }
      const listeners = new Set()
      let inflight = null
      let timer = null
      let disposed = false
      // Today's off-peak spans are rendered in the viewer's own zone, so the
      // host is told which zone the request means.
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

      const publish = next => {
        snapshot = next
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch (error) {
            console.warn('[model-cost] snapshot listener failed', error)
          }
        }
      }

      const load = () => {
        if (disposed) return Promise.resolve()
        inflight ??= (async () => {
          const remote = ctx.get('remote.modelCost')
          if (remote === undefined) return
          try {
            const result = await remote.session(sessionId, timeZone)
            if (disposed) return
            if (result?.ok === true) publish({ status: 'ready', value: result.value, error: null })
            else publish({ status: 'error', value: snapshot.value, error: result?.error?.message ?? 'unknown failure' })
          } catch (error) {
            if (!disposed) publish({ status: 'error', value: snapshot.value, error: error instanceof Error ? error.message : String(error) })
          } finally {
            inflight = null
          }
        })()
        return inflight
      }

      const subscribe = listener => {
        listeners.add(listener)
        if (listeners.size === 1) {
          void load()
          timer = setInterval(() => { void load() }, 20000)
        }
        let released = false
        return () => {
          if (released) return
          released = true
          listeners.delete(listener)
          if (listeners.size === 0) {
            clearInterval(timer)
            timer = null
          }
        }
      }

      const source = {
        getSnapshot: () => snapshot,
        subscribe,
      }

      return {
        source,
        refresh: () => { void load() },
        release: () => {
          disposed = true
          listeners.clear()
          clearInterval(timer)
          timer = null
        },
      }
    }

    /* ------------------------------------------------------------------ */
    /* Hover + click popover                                               */
    /* ------------------------------------------------------------------ */

    /**
     * Anchor a portaled panel above a trigger and keep it open while hovered or
     * pinned by a click.
     * @returns {object} seat with refs, open state, and placement.
     */
    function useHoverPopover() {
      const [pinned, setPinned] = useState(false)
      const [hovered, setHovered] = useState(false)
      const open = pinned || hovered
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const timerRef = useRef(null)

      const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'top', gap: PANEL_GAP, margin: PANEL_MARGIN })
      useDismissOnOutsidePointer(rootRef, pinned, setPinned, panelRef)

      useEffect(() => {
        if (!open) return undefined
        const onKeyDown = event => { if (event.key === 'Escape') { setPinned(false); setHovered(false) } }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [open])

      useEffect(() => () => { clearTimeout(timerRef.current) }, [])

      const enter = useCallback(() => {
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => { setHovered(true) }, 140)
      }, [])

      const leave = useCallback(() => {
        clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => { setHovered(false) }, 160)
      }, [])

      return {
        open,
        pinned,
        rootRef,
        panelRef,
        pos,
        togglePin: () => { setPinned(current => !current) },
        triggerProps: {
          onPointerEnter: enter,
          onPointerLeave: leave,
          onFocus: () => { setHovered(true) },
          onBlur: () => { setHovered(false) },
        },
        panelProps: {
          onPointerEnter: () => { clearTimeout(timerRef.current); setHovered(true) },
          onPointerLeave: leave,
        },
      }
    }

    /* ------------------------------------------------------------------ */
    /* Session cost pill                                                   */
    /* ------------------------------------------------------------------ */

    /**
     * The composer-dock cost pill: amount, tariff tag, and a details popover.
     * @param {object} props - slot props plus the injected feed.
     * @returns {object|null} rendered pill.
     */
    function CostPill(props) {
      const { useCost, refresh, useProjection, t, openPage } = props
      const state = useCost(value => value)
      const usage = useProjection('tokenUsage')
      const popover = useHoverPopover()

      // Token totals move only when a call settles, so that is the moment to
      // reprice; the feed's own timer covers tariff boundaries. The projection
      // names the uncached bucket `uncachedInputTokens`.
      const usageSignature = usage === undefined
        ? ''
        : `${usage.uncachedInputTokens ?? usage.inputTokens ?? 0}:${usage.cacheReadTokens ?? 0}:${usage.cacheWriteTokens ?? 0}:${usage.outputTokens ?? 0}`
      useEffect(() => { refresh() }, [usageSignature, refresh])

      const summary = state?.value ?? null
      const phase = summary?.phase ?? null
      const totals = summary?.totals ?? null
      if (state.status === 'error' && summary === null) return null
      if (summary === null || totals === null) return null
      if (totals.requests === 0) return null

      const phaseState = phase?.state ?? 'unresolved'
      const tagClass = tagClassOf(phaseState)
      const phaseLabel = phaseState === 'unresolved' ? null : t(`phaseShort.${phaseState}`)
      const amount = formatCost(totals.cost)
      const label = phaseLabel === null
        ? amount
        : h(React.Fragment, null,
            amount,
            h('span', { className: 'dsh-mc-sep', 'aria-hidden': true }, '·'),
            phaseLabel,
          )
      const aria = `${t('dialogTitle')} ${amount}${phaseLabel === null ? '' : ` · ${t(`phase.${phaseState}`)}`}`

      return h('span', { ref: popover.rootRef, className: 'dsh-mc-anchor', 'data-composer-stat': PILL_ID },
        h('button', {
          type: 'button',
          className: 'dsh-mc-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': popover.open,
          'aria-label': aria,
          onClick: popover.togglePin,
          ...popover.panelProps,
          ...popover.triggerProps,
        },
          h(PriceTag, { size: 14, className: tagClass }),
          h('span', { className: 'dsh-mc-pill-label' }, label),
        ),
        popover.open && renderPillPanel(popover, summary, t, openPage),
      )
    }

    /**
     * Render the pill's details panel.
     * @param {object} popover - hover-popover seat.
     * @param {object} summary - host session summary.
     * @param {Function} t - translator.
     * @param {Function} openPage - navigate to the global page.
     * @returns {object} portal element.
     */
    function renderPillPanel(popover, summary, t, openPage) {
      const { totals, phase, models } = summary
      // A fork carries its parent's spend as context; show it beside the child's
      // own amount, but it is already billed under the parent.
      const inherited = summary.inherited ?? null
      const forkBefore = inherited !== null && inherited.requests > 0 ? inherited : null
      const now = Date.now()
      const rows = []
      if (phase !== null) {
        rows.push(h('dt', { key: 'model' }, t('dialogRoute')),
          h('dd', { key: 'model-v', className: 'dsh-mc-left' },
            `${phase.provider ?? '—'} / ${phase.model ?? '—'}`))
        rows.push(h('dt', { key: 'key' }, t('dialogKey')),
          h('dd', { key: 'key-v', className: 'dsh-mc-left' }, phase.key ?? t('mappingUnresolved')))
        rows.push(h('dt', { key: 'phase' }, t('dialogPhase')),
          h('dd', { key: 'phase-v' },
            h('span', { className: `dsh-mc-phase-value ${tagClassOf(phase.state)}` }, t(`phase.${phase.state}`)),
            phase.nextAt === null ? null : ` · ${formatNextChange(phase.nextAt, phase.nextState, now, t)}`))
        if (phase.rates !== null) {
          rows.push(h('dt', { key: 'rates' }, t('dialogRates')),
            h('dd', { key: 'rates-v', className: 'dsh-mc-left' },
              h('div', null, `${t('dialogRateInput')} ${formatRate(phase.rates.input)} · ${t('dialogRateOutput')} ${formatRate(phase.rates.output)}`),
              h('div', null, `${t('dialogRateCache')} ${formatRate(phase.rates.cacheRead)} · ${t('dialogRateWrite')} ${formatRate(phase.rates.cacheWrite)}`)))
        }
      }
      rows.push(h('dt', { key: 'requests' }, t('card.requests')), h('dd', { key: 'requests-v' }, String(totals.requests)))
      rows.push(h('dt', { key: 'tokens' }, t('dialogTokens')),
        h('dd', { key: 'tokens-v' },
          `${formatTokens(totals.inputTokens)} · ${formatTokens(totals.cacheReadTokens)} · ${formatTokens(totals.outputTokens)}`))
      if (totals.unpricedRequests > 0) {
        rows.push(h('dt', { key: 'unpriced' }, t('card.unpriced')),
          h('dd', { key: 'unpriced-v' }, t('dialogUnpriced', { count: totals.unpricedRequests })))
      }

      return ReactDOM.createPortal(
        h('div', {
          ref: popover.panelRef,
          className: 'dsh-mc-panel',
          role: 'dialog',
          'aria-label': t('dialogTitle'),
          style: popover.pos ?? MEASURE_STYLE,
          ...popover.panelProps,
        },
          h('div', { className: 'dsh-mc-panel-title' },
            h('span', { className: 'dsh-mc-panel-title-label' },
              h(PriceTag, { size: 14 }),
              t('dialogTitle')),
            h('span', null,
              formatCost(totals.cost),
              forkBefore === null
                ? null
                : h('span', { className: 'dsh-mc-panel-extra' }, t('dialogForkExtra', { cost: formatCost(forkBefore.cost) })))),
          h('div', { className: 'dsh-mc-panel-rule', 'aria-hidden': true }),
          h('dl', { className: 'dsh-mc-details' }, rows),
          phase !== null && phase.hasSchedule && (phase.timeline?.length ?? 0) > 0
            ? h('div', { className: 'dsh-mc-block' },
                h('div', { className: 'dsh-mc-block-caption' }, t('timelineCaption')),
                h(PhaseTimeline, { segments: phase.timeline, nowAt: now, t }))
            : null,
          totals.peakCost > 0 || totals.offpeakCost > 0
            ? h('div', { className: 'dsh-mc-note' },
                `${t('dialogPeakSplit')}: ${formatCost(totals.peakCost)} / ${formatCost(totals.offpeakCost)}`)
            : null,
          models.length > 1
            ? h('div', null,
                h('div', { className: 'dsh-mc-subhead' }, t('dialogModels')),
                models.slice(0, 6).map((row, index) => h('div', { className: 'dsh-mc-model-row', key: `${row.model}-${index}` },
                  h('span', { className: 'dsh-mc-model-key' }, row.key ?? row.model ?? '—'),
                  h('span', { className: 'dsh-mc-model-cost' }, formatCost(row.cost)))))
            : null,
          forkBefore === null
            ? null
            : h('p', { className: 'dsh-mc-note' }, t('dialogForkNote')),
          h('p', { className: 'dsh-mc-note' },
            h('button', {
              type: 'button',
              className: 'dsh-mc-link',
              onClick: () => { popover.togglePin(); openPage() },
            }, t('openPage')),
            h('span', { className: 'dsh-mc-sep', 'aria-hidden': true }, '·'),
            h('a', {
              className: 'dsh-mc-link',
              href: phase?.source ?? COST_MAP_BROWSE_URL,
              target: '_blank',
              rel: 'noreferrer noopener',
            }, t('priceSource'))),
        ),
        document.body,
      )
    }

    /* ------------------------------------------------------------------ */
    /* Key picker (mapping editor)                                         */
    /* ------------------------------------------------------------------ */

    /**
     * Searchable cost-map key picker anchored over its trigger.
     * @param {object} props - value, trigger label, search callback, and change callback.
     * @returns {object} trigger and portaled picker.
     */
    function KeyPicker({ value, label, placeholder, search, onChange, t, disabled }) {
      const [open, setOpen] = useState(false)
      const [text, setText] = useState('')
      const [items, setItems] = useState([])
      const [active, setActive] = useState(0)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const pos = useAnchoredPosition({ open, anchorRef: rootRef, panelRef, side: 'bottom', gap: 6, margin: PANEL_MARGIN })
      useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)

      useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        const timer = setTimeout(async () => {
          const result = await search(text)
          if (cancelled) return
          setItems(result?.items ?? [])
          setActive(0)
        }, 160)
        return () => { cancelled = true; clearTimeout(timer) }
      }, [open, text, search])

      const choose = item => {
        onChange(item.key)
        setOpen(false)
        setText('')
      }

      return h('span', { ref: rootRef, className: 'dsh-mc-keycell' },
        h('button', {
          type: 'button',
          className: `dsh-mc-keyvalue${value === null || value === undefined ? ' dsh-mc-keyvalue-missing' : ''}`,
          title: value ?? label,
          'aria-label': label,
          disabled,
          onClick: () => { setOpen(current => !current); setText('') },
        }, value ?? label),
        open && ReactDOM.createPortal(
          h('div', {
            ref: panelRef,
            className: 'dsh-mc-picker',
            role: 'listbox',
            'aria-label': label,
            style: pos ?? MEASURE_STYLE,
          },
            h('input', {
              className: 'dsh-mc-input',
              value: text,
              placeholder,
              autoFocus: true,
              onChange: event => { setText(event.target.value) },
              onKeyDown: event => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, items.length - 1)) }
                else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)) }
                else if (event.key === 'Enter' && items[active] !== undefined) { event.preventDefault(); choose(items[active]) }
                else if (event.key === 'Escape') { event.preventDefault(); setOpen(false) }
              },
            }),
            items.length === 0
              ? h('div', { className: 'dsh-mc-empty' }, t('mappingNoResults'))
              : items.map((item, index) => h('button', {
                  key: item.key,
                  type: 'button',
                  className: 'dsh-mc-picker-option',
                  role: 'option',
                  'aria-selected': index === active,
                  'data-active': index === active,
                  onPointerEnter: () => { setActive(index) },
                  onClick: () => { choose(item) },
                },
                  h('span', { className: 'dsh-mc-picker-key' }, item.key),
                  h('span', { className: 'dsh-mc-picker-price' },
                    `${formatRate(item.input * 1_000_000)} / ${formatRate(item.output * 1_000_000)}`))),
          ),
          document.body,
        ),
      )
    }

    /* ------------------------------------------------------------------ */
    /* Global statistics page                                              */
    /* ------------------------------------------------------------------ */

    /**
     * Sidebar panel body: range and grouping selectors, summary cards, the
     * grouped table, and the mapping editor.
     * @param {object} props - slot props plus the injected loader face.
     * @returns {object} page element.
     */
    function ModelCostPage(props) {
      const { loadReport, searchKeys, saveMapping, refreshMap, t } = props
      const [range, setRange] = useState('all')
      const [dimension, setDimension] = useState('model')
      const [hiddenSources, setHiddenSources] = useState(readHiddenSources)
      const [report, setReport] = useState(null)
      const [status, setStatus] = useState('loading')
      const [error, setError] = useState(null)
      const [revision, setRevision] = useState(0)
      const [draft, setDraft] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [mapBusy, setMapBusy] = useState(false)

      useEffect(() => {
        let cancelled = false
        setStatus(current => (report === null ? 'loading' : 'refreshing'))
        loadReport({ range, dimension, limit: 25, exclude: hiddenSources }).then(result => {
          if (cancelled) return
          if (result?.ok === true) {
            setReport(result.value)
            setError(null)
            setStatus('ready')
            setDraft(current => current === null ? (result.value.rules ?? []) : current)
          } else {
            setError(result?.error?.message ?? 'unknown failure')
            setStatus('error')
          }
        })
        return () => { cancelled = true }
        // `report` supplies only the initial loading flag; re-running on it would loop.
      }, [range, dimension, revision, hiddenSources, loadReport])

      const dirty = useMemo(() => {
        if (report === null || draft === null) return false
        return JSON.stringify(draft) !== JSON.stringify(report.rules ?? [])
      }, [draft, report])

      const upsertRule = (provider, model, key) => {
        setDraft(current => {
          const list = current === null ? [] : [...current]
          const index = list.findIndex(rule => (rule.provider ?? '') === (provider ?? '') && rule.model === model)
          const next = provider === undefined || provider === null || provider === ''
            ? { model, key }
            : { provider, model, key }
          if (index >= 0) list[index] = next
          else list.push(next)
          return list
        })
      }

      const updateRuleAt = (index, patch) => {
        setDraft(current => {
          const list = current === null ? [] : [...current]
          if (list[index] === undefined) return list
          list[index] = { ...list[index], ...patch }
          return list
        })
      }

      const removeRuleAt = index => {
        setDraft(current => (current === null ? [] : current.filter((_rule, at) => at !== index)))
      }

      const keyFor = (provider, model) => {
        const list = draft ?? []
        const hit = list.find(rule => (rule.provider ?? '') === (provider ?? '') && rule.model === model)
          ?? list.find(rule => rule.provider === undefined && rule.model === model)
        return hit?.key ?? null
      }

      const apply = async () => {
        setBusy(true)
        setNotice(null)
        try {
          const result = await saveMapping(draft ?? [])
          if (result?.ok === true) {
            setNotice({ kind: 'ok', text: t('mappingSavedRules', { count: result.value.rules.length }) })
            setDraft(null)
            setRevision(value => value + 1)
          } else {
            setNotice({ kind: 'error', text: t('mappingFailed', { message: result?.error?.message ?? 'unknown failure' }) })
          }
        } finally {
          setBusy(false)
        }
      }

      const updateMap = async () => {
        setMapBusy(true)
        setNotice(null)
        try {
          const result = await refreshMap()
          if (result?.ok === true) {
            setDraft(null)
            setRevision(value => value + 1)
            setNotice({ kind: 'ok', text: t('mapMetaNoDate', { entries: result.value.entries }) })
          } else {
            setNotice({ kind: 'error', text: t('mappingFailed', { message: result?.error?.message ?? 'unknown failure' }) })
          }
        } finally {
          setMapBusy(false)
        }
      }

      /**
       * Count or leave out one provider's calls on the next report.
       * @param {string} provider - provider id as the host reports it.
       * @returns {void}
       */
      const toggleSource = provider => {
        const next = hiddenSources.includes(provider)
          ? hiddenSources.filter(value => value !== provider)
          : [...hiddenSources, provider]
        setHiddenSources(next)
        writeHiddenSources(next)
      }

      const map = report?.map ?? null
      const totals = report?.totals ?? null
      const sources = report?.sources ?? []
      // One source needs no switch. A hidden one must stay reachable even when
      // it is the only source the current range recorded.
      const showSources = sources.length > 1 || (sources.length > 0 && hiddenSources.length > 0)
      const maxCost = report === null ? 0 : Math.max(0, ...report.groups.map(group => group.cost))

      return h('div', { className: 'dsh-mc-page' },
        h('header', { className: 'dsh-mc-head' },
          h('div', null,
            h('h1', { className: 'dsh-mc-h1' }, t('title')),
            h('p', { className: 'dsh-mc-sub' }, t('subtitle')),
            map === null
              ? null
              : h('p', { className: 'dsh-mc-sub' },
                  map.generatedAt === null
                    ? t('mapMetaNoDate', { entries: map.entries })
                    : t('mapMeta', { entries: map.entries, date: new Date(map.generatedAt).toLocaleDateString() }),
                  ` · ${map.origin === 'user' ? t('mapOriginUser') : t('mapOriginSnapshot')}`)),
          h('div', { className: 'dsh-mc-head-actions' },
            h('button', { type: 'button', className: 'dsh-mc-button', disabled: mapBusy, onClick: updateMap },
              mapBusy ? t('refreshingMap') : t('refreshMap')),
            h('button', {
              type: 'button',
              className: 'dsh-mc-button',
              disabled: status === 'loading' || status === 'refreshing',
              onClick: () => { setDraft(null); setRevision(value => value + 1) },
            }, t('refresh')))),
        error === null ? null : h('div', { className: 'dsh-mc-error' },
          h('span', null, t('error', { message: error })),
          h('button', { type: 'button', className: 'dsh-mc-button', onClick: () => { setRevision(value => value + 1) } }, t('retry'))),
        h('section', { className: 'dsh-mc-toolbar' },
          h('div', { className: 'dsh-mc-field' },
            h('span', { className: 'dsh-mc-field-label' }, t('rangeLabel')),
            h('div', { className: 'dsh-mc-segments', role: 'group', 'aria-label': t('rangeLabel') },
              ['all', 'today', '7d', '30d'].map(id => h('button', {
                key: id,
                type: 'button',
                className: 'dsh-mc-segment',
                'aria-pressed': range === id,
                onClick: () => { setRange(id) },
              }, t(`range.${id}`))))),
          h('div', { className: 'dsh-mc-field' },
            h('span', { className: 'dsh-mc-field-label' }, t('dimensionLabel')),
            h('div', { className: 'dsh-mc-segments', role: 'group', 'aria-label': t('dimensionLabel') },
              ['model', 'provider', 'session', 'day', 'phase'].map(id => h('button', {
                key: id,
                type: 'button',
                className: 'dsh-mc-segment',
                'aria-pressed': dimension === id,
                onClick: () => { setDimension(id) },
              }, t(`dimension.${id}`))))),
        ),
        showSources
          ? h('section', { className: 'dsh-mc-sources', 'aria-label': t('sourcesLabel') },
              h('span', { className: 'dsh-mc-sources-label' }, t('sourcesLabel')),
              h('div', { className: 'dsh-mc-chips' },
                sources.map(source => {
                  const shown = !hiddenSources.includes(source.provider)
                  return h('button', {
                    key: source.provider,
                    type: 'button',
                    className: 'dsh-mc-chip',
                    'aria-pressed': shown,
                    onClick: () => { toggleSource(source.provider) },
                  },
                    h('span', { className: 'dsh-mc-chip-mark', 'aria-hidden': true }, shown ? '✓' : ''),
                    h('span', { className: 'dsh-mc-chip-name' },
                      source.provider === '—' ? t('sourceUnknown') : source.provider),
                    h('span', { className: 'dsh-mc-chip-cost' }, formatCost(source.cost)))
                })))
          : null,
        totals === null
          ? (status === 'loading' ? h('div', { className: 'dsh-mc-loading' }, t('loading')) : null)
          : h('section', { className: 'dsh-mc-cards' },
              h(Card, { label: t('card.cost'), value: formatCost(totals.cost), note: t('sessionsWithUsage', { count: totals.sessionsWithUsage }) }),
              h(Card, { label: t('card.requests'), value: String(totals.requests), note: t('sessionsCount', { count: totals.sessions }) }),
              h(Card, {
                label: t('card.tokens'),
                value: formatTokens(totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens),
                note: `${t('items.input')} ${formatTokens(totals.inputTokens)} · ${t('items.output')} ${formatTokens(totals.outputTokens)}`,
              }),
              h(Card, { label: t('card.cacheHit'), value: formatPercent(totals.cacheHitRatio), note: `${t('items.cacheRead')} ${formatTokens(totals.cacheReadTokens)}` }),
              h(Card, {
                label: t('card.phase'),
                value: `${formatPercent(totals.cost === 0 ? null : totals.peakCost / totals.cost)} / ${formatPercent(totals.cost === 0 ? null : totals.offpeakCost / totals.cost)}`,
                note: `${t('phase.peak')} ${formatCost(totals.peakCost)} · ${t('phase.offpeak')} ${formatCost(totals.offpeakCost)}`,
              }),
              totals.unpricedRequests === 0 ? null : h(Card, { label: t('card.unpriced'), value: String(totals.unpricedRequests), note: t('mappingIntro') })),
        report === null || totals === null
          ? null
          : h(TrendChart, { series: report.series ?? [], hours: report.hours ?? null, filtered: hiddenSources.length > 0, t }),
        report === null || totals === null
          ? null
          : h('section', { className: 'dsh-mc-section' },
              h('div', { className: 'dsh-mc-section-head' },
                h('h2', { className: 'dsh-mc-section-title' }, t(`dimension.${report.dimension}`)),
                h('span', { className: 'dsh-mc-section-note' },
                  `${t('scanMeta', { scanned: report.scanned.sessions, available: report.scanned.available })}`
                  + `${report.scanned.cached > 0 ? ` · ${t('scanCached', { count: report.scanned.cached })}` : ''}`
                  + `${report.scanned.capped ? ` · ${t('scanCapped', { scanned: report.scanned.sessions })}` : ''}`)),
              report.groups.length === 0
                ? h('div', { className: 'dsh-mc-empty' }, hiddenSources.length > 0 ? t('sourcesEmpty') : t('empty'))
                : h('table', { className: 'dsh-mc-table' },
                    h('thead', null, h('tr', null,
                      h('th', null, t(`dimension.${report.dimension}`)),
                      h('th', { className: 'dsh-mc-num' }, t('costColumn')),
                      h('th', null, t('shareColumn')),
                      h('th', { className: 'dsh-mc-num' }, t('requestsColumn')),
                      h('th', { className: 'dsh-mc-num' }, t('inputColumn')),
                      h('th', { className: 'dsh-mc-num' }, t('cacheReadColumn')),
                      h('th', { className: 'dsh-mc-num' }, t('outputColumn')))),
                    h('tbody', null, report.groups.map(group => h('tr', { key: group.id },
                      h('td', { className: 'dsh-mc-name' }, group.label),
                      h('td', { className: 'dsh-mc-num' }, formatCost(group.cost)),
                      h('td', null, h('div', { className: 'dsh-mc-bar' },
                        h('span', { style: { width: `${maxCost === 0 ? 0 : Math.max(1, (group.cost / maxCost) * 100)}%` } }))),
                      h('td', { className: 'dsh-mc-num' }, String(group.requests)),
                      h('td', { className: 'dsh-mc-num' }, formatTokens(group.inputTokens)),
                      h('td', { className: 'dsh-mc-num' }, formatTokens(group.cacheReadTokens)),
                      h('td', { className: 'dsh-mc-num' }, formatTokens(group.outputTokens))))))),
        report === null
          ? null
          : h(MappingSection, {
              report,
              draft,
              dirty,
              busy,
              notice,
              t,
              searchKeys,
              keyFor,
              upsertRule,
              updateRuleAt,
              removeRuleAt,
              apply,
              discard: () => { setDraft(report.rules ?? []); setNotice(null) },
              onAdd: () => { setDraft(current => [...(current ?? []), { model: '', key: '' }]) },
            }),
      )
    }

    /**
     * One summary card.
     * @param {{label: string, value: string, note?: string}} props - card content.
     * @returns {object} card element.
     */
    function Card({ label, value, note }) {
      return h('div', { className: 'dsh-mc-card' },
        h('div', { className: 'dsh-mc-card-label' }, label),
        h('div', { className: 'dsh-mc-card-value' }, value),
        note === undefined ? null : h('div', { className: 'dsh-mc-card-note' }, note))
    }

    /* ------------------------------------------------------------------ */
    /* Trend chart                                                         */
    /* ------------------------------------------------------------------ */

    /**
     * Read a report count, tolerating a host that omits the newer fields.
     * @param {unknown} value - candidate.
     * @returns {number} a finite number.
     */
    function reportNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : 0
    }

    /**
     * Local `YYYY-MM-DD` of the Monday that starts one date's week.
     * @param {string} date - `YYYY-MM-DD`.
     * @returns {string} Monday date key.
     */
    function mondayOf(date) {
      const [year, month, day] = date.split('-').map(Number)
      const cursor = new Date(year, month - 1, day)
      cursor.setDate(cursor.getDate() - (cursor.getDay() + 6) % 7)
      const pad = value => String(value).padStart(2, '0')
      return `${cursor.getFullYear()}-${pad(cursor.getMonth() + 1)}-${pad(cursor.getDate())}`
    }

    /**
     * Bucket a daily series for the trend chart. Long ranges roll up to weeks
     * and then months, so the bar count stays legible.
     * @param {object[]} series - daily entries from the host report.
     * @returns {{unit: string, points: object[]}} bucketed points, oldest first.
     */
    function buildTrend(series) {
      const days = (Array.isArray(series) ? series : []).filter(day => typeof day?.date === 'string')
      if (days.length === 0) return { unit: 'day', points: [] }
      const unit = days.length <= 120 ? 'day' : days.length <= 540 ? 'week' : 'month'
      const buckets = new Map()
      for (const day of days) {
        const id = unit === 'day' ? day.date : unit === 'week' ? mondayOf(day.date) : day.date.slice(0, 7)
        let point = buckets.get(id)
        if (point === undefined) {
          point = { id, from: day.date, to: day.date, cost: 0, peakCost: 0, offpeakCost: 0, requests: 0, tokens: 0 }
          buckets.set(id, point)
        }
        if (day.date < point.from) point.from = day.date
        if (day.date > point.to) point.to = day.date
        point.cost += reportNumber(day.cost)
        point.peakCost += reportNumber(day.peakCost)
        point.offpeakCost += reportNumber(day.offpeakCost)
        point.requests += reportNumber(day.requests)
        point.tokens += reportNumber(day.inputTokens) + reportNumber(day.outputTokens)
          + reportNumber(day.cacheReadTokens) + reportNumber(day.cacheWriteTokens)
      }
      return { unit, points: [...buckets.values()].sort((left, right) => left.id.localeCompare(right.id)) }
    }

    /**
     * Turn the host's 24 hourly buckets into chart points for one day.
     * @param {{date:string, buckets:object[]}|null} hours - hourly report block.
     * @returns {{date:string, points:object[]}|null} points, or null when absent.
     */
    function buildHourly(hours) {
      if (hours === null || hours === undefined) return null
      const date = typeof hours.date === 'string' ? hours.date : ''
      const buckets = Array.isArray(hours.buckets) ? hours.buckets : []
      if (date === '' || buckets.length === 0) return null
      const points = buckets.map((bucket, index) => {
        const hour = typeof bucket?.hour === 'number' ? bucket.hour : index
        const clock = `${String(hour).padStart(2, '0')}:00`
        return {
          id: `${date}T${clock}`,
          hour,
          from: `${date} ${clock}`,
          to: `${date} ${clock}`,
          cost: reportNumber(bucket.cost),
          peakCost: reportNumber(bucket.peakCost),
          offpeakCost: reportNumber(bucket.offpeakCost),
          requests: reportNumber(bucket.requests),
          tokens: reportNumber(bucket.inputTokens) + reportNumber(bucket.outputTokens)
            + reportNumber(bucket.cacheReadTokens) + reportNumber(bucket.cacheWriteTokens),
        }
      })
      return { date, points: points.sort((left, right) => left.hour - right.hour) }
    }

    /**
     * Usage and spend over time: one bar per day (weeks or months on long
     * ranges), stacked by tariff when showing money, with a metric switch and
     * a pointer-following detail card.
     * @param {{series: object[], hours: object|null, filtered: boolean, t: Function}} props - the report series, whether a source filter is on, and the translator.
     * @returns {object} section element.
     */
    function TrendChart({ series, hours, filtered = false, t }) {
      const [metric, setMetric] = useState('cost')
      /** Bar under the pointer plus the corner the tooltip hangs from. */
      const [hover, setHover] = useState(null)
      const plotRef = useRef(null)
      /** Plot width in CSS pixels: the bar ceiling is a fraction of it. */
      const [plotWidth, setPlotWidth] = useState(0)
      const daily = useMemo(() => buildTrend(series), [series])
      const hourly = useMemo(() => buildHourly(hours), [hours])
      // One bar cannot describe a single day, so that day is read hour by hour.
      const view = useMemo(() => (hourly !== null && daily.points.length === 1
        ? { unit: 'hour', date: hourly.date, points: hourly.points }
        : daily), [daily, hourly])
      const total = useMemo(() => view.points.reduce((sum, point) => (
        sum + (metric === 'cost' ? point.cost : metric === 'requests' ? point.requests : point.tokens)
      ), 0), [view, metric])
      const max = useMemo(() => view.points.reduce((peak, point) => Math.max(peak,
        metric === 'cost' ? point.cost : metric === 'requests' ? point.requests : point.tokens), 0), [view, metric])
      const ticks = useMemo(() => {
        const shown = new Set()
        if (view.unit === 'hour') {
          // A full day is fixed width: label every four hours and the last one.
          for (let hour = 0; hour <= 20; hour += 4) shown.add(hour)
          shown.add(23)
          return shown
        }
        const step = Math.max(1, Math.ceil(view.points.length / 9))
        for (let index = view.points.length - 1; index >= 0; index -= step) shown.add(index)
        return shown
      }, [view])

      const valueOf = point => (metric === 'cost' ? point.cost : metric === 'requests' ? point.requests : point.tokens)
      const format = metric === 'cost' ? formatCost : metric === 'requests' ? count => String(Math.round(count)) : formatTokens
      // Flat-priced calls are neither peak nor off-peak; keep them visible by
      // giving the remainder of the cost its own segment.
      const flatOf = point => Math.max(0, point.cost - point.peakCost - point.offpeakCost)
      const hasFlat = metric === 'cost' && view.points.some(point => flatOf(point) > 0)
      const heightOf = point => {
        const amount = valueOf(point)
        if (max <= 0) return 0
        return Math.max(amount > 0 ? 2 : 0, amount / max * 100)
      }
      const labelOf = point => {
        if (view.unit === 'hour') return String(point.hour).padStart(2, '0')
        return view.unit === 'month' ? point.id.slice(2) : point.id.slice(5)
      }
      const unitText = t(view.unit === 'hour' ? 'trendHourly'
        : view.unit === 'day' ? 'trendDaily' : view.unit === 'week' ? 'trendWeekly' : 'trendMonthly')
      const spanText = view.unit === 'hour'
        ? view.date.slice(5)
        : t(view.unit === 'day' ? 'trendSpanDays' : view.unit === 'week' ? 'trendSpanWeeks' : 'trendSpanMonths',
          { count: view.points.length })
      const detailOf = point => {
        const when = point.from === point.to ? point.from : `${point.from} – ${point.to}`
        const parts = [
          when,
          formatCost(point.cost),
          `${t('requestsColumn')} ${point.requests}`,
          `${t('card.tokens')} ${formatTokens(point.tokens)}`,
        ]
        if (point.peakCost > 0 || point.offpeakCost > 0) {
          parts.push(`${t('phase.peak')} ${formatCost(point.peakCost)} · ${t('phase.offpeak')} ${formatCost(point.offpeakCost)}`)
        }
        return parts.join(' · ')
      }
      const hasUsage = view.points.some(point => point.requests > 0)
      const summary = `${unitText} · ${spanText} · ${t('trendTotal', { value: format(total) })}`
      // The bar keeps 70% of its column, so the gap survives any density. A
      // fixed pixel ceiling turned a handful of bars into hairlines on a wide
      // window, so the ceiling is a tenth of the plot instead: exactly what
      // seven bars get, and the only thing stopping two bars from becoming
      // blocks.
      useEffect(() => {
        const node = plotRef.current
        if (node === null || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(entries => {
          const width = Math.round(entries[0]?.contentRect?.width ?? 0)
          setPlotWidth(current => (current === width ? current : width))
        })
        observer.observe(node)
        return () => { observer.disconnect() }
      }, [hasUsage])
      const barCeiling = plotWidth > 0 ? Math.max(12, Math.round(plotWidth / 10)) : 96
      // What the CSS width resolves to: 70% of the column pitch, under the ceiling.
      const barWidth = plotWidth > 0
        ? Math.min(plotWidth * 0.7 / Math.max(1, view.points.length), barCeiling)
        : 0
      // Corners follow the bar: 3px keeps a hairline bar crisp, while a wide bar
      // gets a proportional sweep instead of a stamp-sized rounding.
      const barRadius = barWidth === 0 ? 3 : Math.min(18, Math.max(3, Math.round(barWidth * 0.14)))
      const tipWhen = point => {
        if (view.unit !== 'hour') return point.from === point.to ? point.from : `${point.from} – ${point.to}`
        const start = String(point.hour).padStart(2, '0')
        const end = String((point.hour + 1) % 24).padStart(2, '0')
        return `${start}:00 – ${end}:00`
      }
      // Columns are equal-width flex items, so one division maps the pointer to
      // a bar. Tracking on the plot (not on each column) keeps the tooltip
      // following the cursor across bar boundaries instead of blinking out.
      const trackPointer = event => {
        const node = plotRef.current
        if (node === null) return
        const rect = node.getBoundingClientRect()
        const count = view.points.length
        if (count === 0 || rect.width <= 0) return
        const x = event.clientX - rect.left
        const y = event.clientY - rect.top
        const index = Math.min(count - 1, Math.max(0, Math.floor(x / (rect.width / count))))
        const flipX = x > rect.width * 0.55
        const flipY = y > rect.height * 0.5
        setHover({ index, left: x + (flipX ? -12 : 12), top: y + (flipY ? -12 : 12), flipX, flipY })
      }
      const tip = (() => {
        if (hover === null) return null
        const point = view.points[hover.index]
        if (point === undefined) return null
        const rows = []
        if (metric === 'cost') {
          if (point.peakCost > 0) rows.push({ label: t('phase.peak'), value: formatCost(point.peakCost), tone: 'peak' })
          if (point.offpeakCost > 0) rows.push({ label: t('phase.offpeak'), value: formatCost(point.offpeakCost), tone: 'offpeak' })
          const flat = flatOf(point)
          if (flat > 0) rows.push({ label: t('phase.flat'), value: formatCost(flat), tone: 'solid' })
        } else {
          rows.push({ label: t('costColumn'), value: formatCost(point.cost) })
        }
        if (metric !== 'requests') rows.push({ label: t('requestsColumn'), value: String(point.requests) })
        if (metric !== 'tokens') rows.push({ label: t('card.tokens'), value: formatTokens(point.tokens) })
        return h('div', {
          className: 'dsh-mc-trend-tip',
          style: {
            left: `${hover.left}px`,
            top: `${hover.top}px`,
            transform: `translate(${hover.flipX ? '-100%' : '0'}, ${hover.flipY ? '-100%' : '0'})`,
          },
        },
          h('div', { className: 'dsh-mc-trend-tip-head' },
            h('span', { className: 'dsh-mc-trend-tip-when' }, tipWhen(point)),
            h('span', { className: 'dsh-mc-trend-tip-value' }, format(valueOf(point)))),
          rows.map(row => h('div', { key: row.label, className: 'dsh-mc-trend-tip-row' },
            h('span', { className: 'dsh-mc-trend-tip-label' },
              row.tone === undefined ? null : h('span', { className: `dsh-mc-trend-swatch dsh-mc-trend-${row.tone}` }),
              row.label),
            h('span', { className: 'dsh-mc-trend-tip-amount' }, row.value))))
      })()

      return h('section', { className: 'dsh-mc-section dsh-mc-trend-section' },
        h('div', { className: 'dsh-mc-section-head' },
          h('div', null,
            h('h2', { className: 'dsh-mc-section-title' }, t('trendTitle')),
            h('span', { className: 'dsh-mc-section-note' }, summary)),
          h('div', { className: 'dsh-mc-trend-controls' },
            metric !== 'cost'
              ? null
              : h('span', { className: 'dsh-mc-trend-legend' },
                  h('span', { className: 'dsh-mc-trend-swatch dsh-mc-trend-offpeak' }), t('phase.offpeak'),
                  h('span', { className: 'dsh-mc-trend-swatch dsh-mc-trend-peak' }), t('phase.peak'),
                  hasFlat
                    ? h('span', { className: 'dsh-mc-trend-legend-item' },
                        h('span', { className: 'dsh-mc-trend-swatch dsh-mc-trend-solid' }), t('phase.flat'))
                    : null),
            h('div', { className: 'dsh-mc-segments', role: 'group', 'aria-label': t('trendMetric') },
              ['cost', 'requests', 'tokens'].map(id => h('button', {
                key: id,
                type: 'button',
                className: 'dsh-mc-segment',
                'aria-pressed': metric === id,
                onClick: () => { setMetric(id) },
              }, t(`metric.${id}`)))))),
        hasUsage
          ? h('div', { className: 'dsh-mc-trend' },
              h('div', { className: 'dsh-mc-trend-frame' },
                h('div', { className: 'dsh-mc-trend-yaxis', 'aria-hidden': true },
                  h('span', { style: { top: '0%' } }, format(max)),
                  h('span', { style: { top: '50%' } }, format(max / 2)),
                  h('span', { style: { top: '100%' } }, format(0))),
                h('div', {
                  className: 'dsh-mc-trend-plot',
                  role: 'img',
                  'aria-label': `${t('trendAria')} · ${summary}`,
                  ref: plotRef,
                  style: { '--dsh-mc-bar-max': `${barCeiling}px`, '--dsh-mc-bar-radius': `${barRadius}px` },
                  onPointerMove: trackPointer,
                  onPointerLeave: () => { setHover(null) },
                },
                  h('div', { className: 'dsh-mc-trend-grid', 'aria-hidden': true },
                    h('span', { style: { top: '0%' } }),
                    h('span', { style: { top: '50%' } })),
                  h('div', { className: 'dsh-mc-trend-bars' },
                    view.points.map((point, index) => h('div', {
                      key: point.id,
                      className: 'dsh-mc-trend-col',
                    },
                      h('span', {
                        className: 'dsh-mc-trend-bar',
                        style: { height: `${heightOf(point)}%` },
                        'aria-hidden': true,
                      }, metric === 'cost'
                        ? [
                            h('span', { key: 'offpeak', className: 'dsh-mc-trend-seg dsh-mc-trend-offpeak', style: { flexGrow: point.offpeakCost } }),
                            h('span', { key: 'peak', className: 'dsh-mc-trend-seg dsh-mc-trend-peak', style: { flexGrow: point.peakCost } }),
                            h('span', { key: 'flat', className: 'dsh-mc-trend-seg dsh-mc-trend-solid', style: { flexGrow: flatOf(point) } }),
                          ]
                        : h('span', { key: 'solid', className: 'dsh-mc-trend-seg dsh-mc-trend-solid', style: { flexGrow: 1 } }))))),
                  tip)),
              h('div', { className: 'dsh-mc-trend-xaxis', 'aria-hidden': true },
                view.points.map((point, index) => h('span', { key: point.id, className: 'dsh-mc-trend-tick' },
                  ticks.has(index) ? labelOf(point) : ''))))
          : h('div', { className: 'dsh-mc-empty' }, filtered ? t('sourcesEmpty') : t('trendEmpty')),
        hasUsage
          ? h('div', { className: 'dsh-mc-footer dsh-mc-trend-footer' },
              h('span', { className: 'dsh-mc-footer-note' },
                hover !== null && view.points[hover.index] !== undefined ? detailOf(view.points[hover.index]) : t('trendHint')))
          : null,
      )
    }

    /**
     * The price-mapping editor: one row per observed route plus any draft rule
     * that no route uses yet.
     * @param {object} props - report, draft rules, and callbacks.
     * @returns {object} section element.
     */
    function MappingSection(props) {
      const { report, draft, t, dirty, busy, notice, searchKeys, keyFor, upsertRule, updateRuleAt, removeRuleAt, apply, discard, onAdd } = props
      const rules = draft ?? report.rules ?? []
      const observed = report.routes ?? []
      const seen = new Set(observed.map(route => `${route.provider ?? ''}\u0000${route.model ?? ''}`))
      const extra = rules
        .map((rule, index) => ({ rule, index }))
        .filter(entry => !seen.has(`${entry.rule.provider ?? ''}\u0000${entry.rule.model}`))
      const statusBadge = route => {
        const mapped = rules.some(rule => (rule.provider ?? '') === (route.provider ?? '') && rule.model === route.model)
        if (mapped) return h('span', { className: 'dsh-mc-badge dsh-mc-badge-ok' }, t('mappingStatusRule'))
        if (!route.resolved) return h('span', { className: 'dsh-mc-badge dsh-mc-badge-warn' }, t('mappingStatusMissing'))
        if (route.ambiguous) return h('span', { className: 'dsh-mc-badge dsh-mc-badge-warn' }, t('mappingStatusAmbiguous'))
        return h('span', { className: 'dsh-mc-badge' }, t('mappingStatusAuto'))
      }
      const viaText = via => t(via === 'rule' ? 'mappingViaRule' : via === 'exact' ? 'mappingViaExact' : 'mappingViaTail')

      return h('section', { className: 'dsh-mc-section' },
        h('div', { className: 'dsh-mc-section-head' },
          h('div', null,
            h('h2', { className: 'dsh-mc-section-title' }, t('mappingTitle')),
            h('span', { className: 'dsh-mc-section-note' }, t('mappingIntro'))),
          h('button', { type: 'button', className: 'dsh-mc-button', onClick: onAdd }, t('mappingAdd'))),
        observed.length === 0 && extra.length === 0
          ? h('div', { className: 'dsh-mc-empty' }, t('mappingEmpty'))
          : h('div', null,
              h('div', { className: 'dsh-mc-mapping-row dsh-mc-mapping-head' },
                h('span', null, t('mappingProvider')),
                h('span', null, t('mappingModel')),
                h('span', null, t('mappingKey')),
                h('span', null, t('costColumn'))),
              observed.map(route => h('div', { className: 'dsh-mc-mapping-row', key: `${route.provider}-${route.model}` },
                h('span', { className: 'dsh-mc-mono', title: route.provider ?? '' }, route.provider ?? '—'),
                h('span', null,
                  h('span', { className: 'dsh-mc-mono', title: route.model ?? '' }, route.model ?? '—'),
                  ' ',
                  statusBadge(route)),
                h('span', { className: 'dsh-mc-keycell' },
                  h(KeyPicker, {
                    value: keyFor(route.provider, route.model) ?? route.key,
                    label: t('mappingPick'),
                    placeholder: t('mappingSearch'),
                    search: searchKeys,
                    onChange: key => { upsertRule(route.provider, route.model, key) },
                    t,
                  }),
                  route.key === null ? null : h('span', { className: 'dsh-mc-card-note' }, viaText(route.via))),
                h('span', { className: 'dsh-mc-num dsh-mc-mono' }, formatCost(route.cost)))),
              extra.map(({ rule, index }) => h('div', { className: 'dsh-mc-mapping-row', key: `draft-${index}` },
                h('input', {
                  className: 'dsh-mc-input',
                  placeholder: t('mappingProvider'),
                  value: rule.provider ?? '',
                  onChange: event => { updateRuleAt(index, { provider: event.target.value }) },
                }),
                h('input', {
                  className: 'dsh-mc-input',
                  placeholder: t('mappingModel'),
                  value: rule.model,
                  onChange: event => { updateRuleAt(index, { model: event.target.value }) },
                }),
                h('span', { className: 'dsh-mc-keycell' },
                  h(KeyPicker, {
                    value: rule.key === '' ? null : rule.key,
                    label: t('mappingPick'),
                    placeholder: t('mappingSearch'),
                    search: searchKeys,
                    onChange: key => { updateRuleAt(index, { key }) },
                    t,
                    disabled: rule.model === '',
                  })),
                h('button', {
                  type: 'button',
                  className: 'dsh-mc-button',
                  'aria-label': t('mappingRemove', { model: rule.model }),
                  onClick: () => { removeRuleAt(index) },
                }, '×')))),
        h('div', { className: 'dsh-mc-footer' },
          h('span', { className: 'dsh-mc-footer-note' },
            notice === null
              ? (dirty ? t('mappingUnsaved') : t('mappingSaved'))
              : h('span', { style: notice.kind === 'error' ? { color: 'var(--dsw-alias-state-error-primary)' } : undefined }, notice.text)),
          h('div', { className: 'dsh-mc-actions' },
            dirty ? h('button', { type: 'button', className: 'dsh-mc-button', disabled: busy, onClick: discard }, t('mappingDiscard')) : null,
            h('button', { type: 'button', className: 'dsh-mc-button dsh-mc-button-primary', disabled: busy || !dirty, onClick: apply },
              busy ? '…' : t('mappingApply')))))
    }

    /* ------------------------------------------------------------------ */
    /* Plugin assembly                                                     */
    /* ------------------------------------------------------------------ */

    /**
     * Sidebar rail icon for the panel entry.
     * @param {{size?: number, active?: boolean}} props - slot owner props.
     * @returns {object} svg element.
     */
    function PanelIcon({ size = 16 }) {
      return h(PriceTag, { size })
    }

    return {
      inject: ['slots', 'locale', 'remote'],
      async apply(ctx) {
        ensureStyles()
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'model-cost: dictionaries')
        const t = ctx.locale.bind(NS)

        try {
          await ctx.remote.$mount(contribution)
        } catch (error) {
          console.error('[model-cost] remote contribution failed to mount', error)
          return
        }

        ctx.inject(['remote.modelCost'], scope => {
          const remote = () => scope.get('remote.modelCost')
          const feeds = new Map()

          const feedFor = sessionId => {
            let feed = feeds.get(sessionId)
            if (feed === undefined) {
              feed = createSessionFeed(scope, sessionId)
              feeds.set(sessionId, feed)
            }
            return feed
          }

          const face = {
            t,
            openPage: () => {
              const layout = scope.get('layout')
              if (layout !== undefined) layout.selectPanel(PANEL_ID)
            },
            loadReport: async query => {
              const client = remote()
              return client === undefined ? { ok: false, error: { message: 'Remote unavailable' } } : client.report(query)
            },
            searchKeys: async query => {
              const client = remote()
              if (client === undefined) return { items: [], total: 0 }
              const result = await client.searchKeys(query)
              return result?.ok === true ? result.value : { items: [], total: 0 }
            },
            saveMapping: async rules => {
              const client = remote()
              return client === undefined ? { ok: false, error: { message: 'Remote unavailable' } } : client.saveMapping(rules)
            },
            refreshMap: async () => {
              const client = remote()
              return client === undefined ? { ok: false, error: { message: 'Remote unavailable' } } : client.refreshMap()
            },
          }

          scope.slots.inject('conversation.composer.dock', () => scope.slots.register({
            name: 'conversation.composer.dock',
            id: PILL_ID,
            order: 2,
            locale: NS,
            inject: sessionId => {
              const feed = feedFor(sessionId)
              return { hooks: { cost: feed.source }, refresh: feed.refresh, openPage: face.openPage }
            },
          }, CostPill))

          scope.slots.inject('main', () => scope.slots.register({
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            inject: () => face,
          }, ModelCostPage))

          scope.slots.inject('sidebar.panellist', () => scope.slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 4,
            locale: NS,
            label: () => t('panel'),
          }, PanelIcon))

          scope.effect(() => () => {
            for (const feed of feeds.values()) feed.release()
            feeds.clear()
          }, 'model-cost: release session feeds')
        })
      },
    }
  },
})
