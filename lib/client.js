/**
 * dev-workflow 插件 — browser half(设置里的总开关卡片)。
 *
 * 在设置左侧导航里注册一个一级分区「dev-workflow 预设」(排在皮肤分区之后),
 * 卡片样式照抄皮肤中心那一套:标题 + 说明 + 一行开关 + 提示 + 状态行。
 *
 * 开关值不住在这里:它住在 `lib/index.js`(本包入口/门卫)注册的 `dev-workflow`
 * 设置命名空间里(settings.yaml 的一节),本半侧只做两件事 —— 读它、写它。
 * 真正的"加载/不加载"由入口根据同一次写入落地:挂载或卸下 `lib/feature.js`,
 * 外加把预设目录在 `.agent-presets/` 与 `.agent-presets/.disabled/` 之间改名搬迁。
 *
 * 本文件是**手写的 lazy-CJS bundle**,格式与 `dsh-client-modules` 期望的一致:
 * `window.__ModuleLoader__.load({ id: <包名>, factory: (require) => exports })`。
 * 包名必须与 package.json 的 name 完全相同,否则插件表里那一行找不到这份 bundle。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-dev-workflow',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** 本插件的 UI 文案命名空间(locale 注册键)。 */
    const NS = 'devWorkflow'
    /** 与 host 半侧共用的设置命名空间(settings.yaml 的键)。 */
    const SETTINGS_NS = 'dev-workflow'
    /** 一级设置分区的顺序:皮肤中心用 120,开关排在它下面。 */
    const SECTION_ORDER = 130

    //#region 样式(与皮肤中心同一套设计变量,类名前缀 dwsw_ 避免撞名)
    const cssText = `
.dwsw_sectionList{margin:0;padding:0;list-style:none}
.dwsw_pluginCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;list-style:none;transition:border-color .16s,background .16s}
.dwsw_pluginCard:hover{border-color:var(--dsw-alias-label-dimmed)}
.dwsw_cardHeaderStatic{align-items:center;gap:12px;width:100%;padding:14px 16px;display:flex}
.dwsw_headText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dwsw_pluginName{color:var(--dsw-alias-label-primary);align-items:baseline;gap:8px;font-size:15px;font-weight:600;line-height:1.4;display:flex}
.dwsw_titleBadge{color:var(--dsw-alias-label-secondary,#6b7280);font-size:11px;font-weight:500}
.dwsw_cardDescription{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.dwsw_cardBody{border-top:1px solid var(--dsw-alias-border-l2);flex-direction:column;gap:12px;margin:0 16px;padding:12px 0 8px;display:flex}
.dwsw_enableRow{flex-wrap:wrap;align-items:center;gap:8px;padding:8px 0;display:flex}
.dwsw_enableLabel{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500}
.dwsw_enableHint{min-width:100%;color:var(--dsw-alias-label-secondary,#6b7280);flex:1;margin:0;font-size:12px;line-height:1.5}
.dwsw_switch{border:1px solid var(--dsw-alias-border-l3,#cbd5e1);background:var(--dsw-alias-bg-layer-3,#e2e8f0);cursor:pointer;border-radius:999px;flex:none;align-items:center;width:40px;height:22px;padding:2px;transition:background .12s,border-color .12s;display:inline-flex;position:relative}
.dwsw_switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,#2b7cd9);outline-offset:2px}
.dwsw_switch:disabled{cursor:not-allowed;opacity:.55}
.dwsw_switchOn{border-color:var(--dsw-alias-brand-primary,#2b7cd9);background:var(--dsw-alias-brand-primary,#2b7cd9)}
.dwsw_switchThumb{background:var(--dsw-alias-label-primary-foreground,#fff);width:18px;height:18px;box-shadow:0 0 0 1px var(--dsw-alias-border-l4,#0f172a1f);border-radius:50%;transition:transform .12s;display:block;transform:translate(0)}
.dwsw_switchOn .dwsw_switchThumb{transform:translate(18px)}
.dwsw_offNote{color:var(--dsw-alias-label-secondary,#6b7280);margin:0;font-size:12.5px;line-height:1.5}
.dwsw_statusList{margin:0;padding-left:18px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:1.7}
.dwsw_statusList code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--dsw-alias-label-primary)}
.dwsw_pending{color:var(--dsw-alias-state-warning-primary,#b06000);margin:0;font-size:12px}
.dwsw_error{color:var(--dsw-alias-state-error-primary,#b42318);margin:0;font-size:12px}
.dwsw_intro{color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.5}
@media (prefers-reduced-motion:reduce){.dwsw_pluginCard,.dwsw_switch,.dwsw_switchThumb{transition:none}}
`
    const cssTagId = 'dsh-plugin-dev-workflow/lib/client.js'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(cssTagId) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-dev-workflow'
      tag.dataset.pluginCss = cssTagId
      tag.textContent = cssText
      document.head.appendChild(tag)
    }
    const css = {
      sectionList: 'dwsw_sectionList',
      pluginCard: 'dwsw_pluginCard',
      cardHeaderStatic: 'dwsw_cardHeaderStatic',
      headText: 'dwsw_headText',
      pluginName: 'dwsw_pluginName',
      titleBadge: 'dwsw_titleBadge',
      cardDescription: 'dwsw_cardDescription',
      cardBody: 'dwsw_cardBody',
      enableRow: 'dwsw_enableRow',
      enableLabel: 'dwsw_enableLabel',
      enableHint: 'dwsw_enableHint',
      switch: 'dwsw_switch',
      switchOn: 'dwsw_switchOn',
      switchThumb: 'dwsw_switchThumb',
      offNote: 'dwsw_offNote',
      statusList: 'dwsw_statusList',
      pending: 'dwsw_pending',
      error: 'dwsw_error',
      intro: 'dwsw_intro',
    }
    //#endregion

    //#region 文案
    const zh = {
      title: 'dev-workflow 预设',
      nav: 'dev-workflow 预设',
      cardDescription: '一步开关 dev-workflow 预设:打开即显示预设并加载插件功能;关闭即隐藏预设、停用功能 —— 只是把运行中的功能从进程里卸下来,不删任何文件。',
      enabled: '启用 dev-workflow 预设',
      enabledHint: '关闭后停用 dev-workflow 的功能:7 个工具(relay / relay_spawn / workflow_state_status|load|save|use / api_contract)与随包技能当场注销,预设移出 Agent 预设名册。插件包、预设文件与状态文件都原样留在磁盘上,重新打开即恢复。开关值写入设置文件,重启后保持。',
      onNote: 'dev-workflow 预设已启用。',
      offNote: 'dev-workflow 预设已关闭(插件已停用,未删任何文件)。',
      badgeOn: '已启用',
      badgeOff: '已关闭',
      onPreset: '预设:「工作流模式」(dev-workflow)显示在 Agent 预设分区与新会话的选择里。',
      onPlugin: '插件:功能已挂载,7 个工具与 24 份随包技能可用。',
      onPersist: '开关值写在设置文件里(settings.yaml 的 dev-workflow 节),重启后保持。',
      offPreset: '预设已从名册移出(目录改名搬到 .agent-presets/.disabled/ 下,内容一个字节没动),Agent 预设分区与新会话都不再显示它。',
      offPlugin: '插件已停用:功能已从进程里卸下,7 个工具与随包技能都已注销,功能模块也不会被 import;插件包、预设文件与状态文件仍在磁盘上。',
      offPersist: '关闭状态写在设置文件里 —— 重启时功能模块不会被加载(开机就没有"先挂载再卸下"的窗口)。',
      pending: '正在写入…',
      notReady: '设置通道尚未就绪:主机半侧加载后即可切换。',
      readOnly: '当前连接只读,无法写入开关值。',
      writeFailed: '写入失败:',
      footnote: '开关随 dev-workflow 插件发布(设置 → dev-workflow 预设);这里的「停用」只卸载运行中的功能,不删文件。',
    }
    const en = {
      title: 'dev-workflow preset',
      nav: 'dev-workflow preset',
      cardDescription: 'One switch for the dev-workflow preset: on shows the preset and loads the plugin; off hides the preset and stops it — the feature is unloaded from the running process only, and nothing is deleted from disk.',
      enabled: 'Enable the dev-workflow preset',
      enabledHint: 'Turning it off stops the dev-workflow host plugin: its seven tools and bundled skills unregister immediately, and the preset leaves the Agent-preset roster. The package, the preset files, and the plugin state stay on disk, so turning it back on restores everything. The value is persisted in the settings file and survives a restart.',
      onNote: 'dev-workflow preset enabled.',
      offNote: 'dev-workflow preset off (plugin stopped, no files deleted).',
      badgeOn: 'on',
      badgeOff: 'off',
      onPreset: 'Preset: “工作流模式” (dev-workflow) appears in Agent presets and in the new-session picker.',
      onPlugin: 'Plugin: the feature is mounted — seven tools and 24 bundled skills are available.',
      onPersist: 'The value lives in the settings file (the dev-workflow section of settings.yaml) and survives a restart.',
      offPreset: 'Preset removed from the roster (the directory is renamed under .agent-presets/.disabled/; not one byte changed); neither Agent presets nor the new-session picker lists it.',
      offPlugin: 'Plugin stopped: the feature is unmounted, the seven tools and every bundled skill are unregistered, and the feature module is never imported; the package, the preset files, and the state files remain on disk.',
      offPersist: 'The off state lives in the settings file — a restart never imports the feature module (no mount-then-unmount window at boot).',
      pending: 'Saving…',
      notReady: 'The settings channel is not ready yet: it becomes switchable once the host half is loaded.',
      readOnly: 'This connection is read-only; the switch value cannot be written.',
      writeFailed: 'Write failed: ',
      footnote: 'Shipped inside the dev-workflow plugin (Settings → dev-workflow preset); “stopped” unloads the running feature without deleting files.',
    }
    //#endregion

    //#region 开关状态
    /**
     * 开关的小 store:`useSyncExternalStore` 要求 getSnapshot 返回稳定引用,
     * 所以状态变了才换新对象。写入是乐观的 —— 先按用户点的值渲染,再由设置镜像纠正。
     * @returns {{subscribe: Function, getSnapshot: Function, update: Function, current: Function}} store。
     */
    function createStore() {
      let listeners = new Set()
      let state = { enabled: true, pending: false, writable: false, status: 'loading', mode: 'host', error: null }
      let snapshot = { ...state }
      const emit = () => {
        snapshot = { ...state }
        for (const listener of [...listeners]) listener()
      }
      return {
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        getSnapshot() { return snapshot },
        update(patch) {
          state = { ...state, ...patch }
          emit()
        },
        current() { return state },
      }
    }
    //#endregion

    /**
     * 注册文案、皮肤式卡片分区。
     * @param {object} ctx - 客户端根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en })
        } catch {
          return () => {}
        }
      }, 'dev-workflow: dictionaries')

      const store = createStore()
      // rc.1 起设置面就是 ctx.settingsScope;旧 rc 的兼容绑定还在时优先用它。
      const binder = ctx.get('webUiSettings') ?? ctx.get('settingsScope')
      let scope
      ctx.effect(() => {
        if (binder === undefined) {
          store.update({ status: 'unavailable' })
          return () => {}
        }
        scope = binder.bind({ namespace: SETTINGS_NS })
        const pull = () => {
          const snapshot = scope.getSnapshot()
          store.update({
            enabled: snapshot.value?.enabled !== false,
            writable: snapshot.writable === true,
            status: snapshot.status,
            mode: snapshot.mode,
          })
        }
        pull()
        return scope.subscribe(pull)
      }, 'dev-workflow: settings scope')

      const setEnabled = async (next) => {
        if (scope === undefined) return
        store.update({ pending: true, error: null })
        try {
          // 乐观更新:先按用户点的那个值渲染,写入被拒时再由 scope 的镜像纠正。
          store.update({ enabled: next })
          await scope.set('enabled', next)
        } catch (error) {
          store.update({ error: error instanceof Error ? error.message : String(error) })
        } finally {
          store.update({ pending: false })
        }
      }

      ctx.slots.inject('settings.section', () => {
        try {
          return ctx.slots.register({
            name: 'settings.section',
            id: 'dev-workflow',
            order: SECTION_ORDER,
            label: () => ctx.locale.bind(NS)('nav'),
            locale: NS,
            inject: () => ({ store, setEnabled }),
          }, DevWorkflowSwitchSection)
        } catch {
          return () => {}
        }
      })
    }

    /**
     * 设置分区本体。
     * @param {object} props - 槽位 props:`t` 来自 locale 座位,inject 提供 store/setEnabled。
     * @returns {object} React 元素树。
     */
    function DevWorkflowSwitchSection(props) {
      const t = props.t
      const store = props.store
      const setEnabled = props.setEnabled
      const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
      const ready = state.writable && state.status === 'ready'
      const lines = state.enabled
        ? [t('onPreset'), t('onPlugin'), t('onPersist')]
        : [t('offPreset'), t('offPlugin'), t('offPersist')]
      const notes = []
      if (state.status !== 'ready') notes.push(React.createElement('p', { key: 'notReady', className: css.offNote, role: 'status' }, t('notReady')))
      else if (!state.writable) notes.push(React.createElement('p', { key: 'readOnly', className: css.offNote, role: 'status' }, t('readOnly')))
      if (state.pending) notes.push(React.createElement('p', { key: 'pending', className: css.pending, role: 'status' }, t('pending')))
      if (state.error !== null && state.error !== undefined) {
        notes.push(React.createElement('p', { key: 'error', className: css.error, role: 'alert' }, `${t('writeFailed')}${state.error}`))
      }

      return React.createElement('ul', { className: css.sectionList },
        React.createElement('li', { className: css.pluginCard },
          React.createElement('div', { className: css.cardHeaderStatic },
            React.createElement('span', { className: css.headText },
              React.createElement('span', { className: css.pluginName },
                t('title'),
                React.createElement('span', { className: css.titleBadge }, state.enabled ? t('badgeOn') : t('badgeOff'))),
              React.createElement('span', { className: css.cardDescription, title: t('cardDescription') }, t('cardDescription')))),
          React.createElement('div', { className: css.cardBody },
            React.createElement('div', { className: css.enableRow },
              React.createElement('span', { className: css.enableLabel, title: t('enabled') }, t('enabled')),
              React.createElement('button', {
                type: 'button',
                role: 'switch',
                'aria-checked': state.enabled,
                'aria-label': t('enabled'),
                disabled: state.pending || !ready,
                className: state.enabled ? `${css.switch} ${css.switchOn}` : css.switch,
                onClick: () => { void setEnabled(!state.enabled) },
              }, React.createElement('span', { className: css.switchThumb })),
              React.createElement('p', { className: css.enableHint }, t('enabledHint'))),
            React.createElement('p', { className: css.intro, role: 'status' }, state.enabled ? t('onNote') : t('offNote')),
            React.createElement('ul', { className: css.statusList },
              lines.map((line, index) => React.createElement('li', { key: `line-${index}` }, line))),
            ...notes,
            React.createElement('p', { className: css.offNote }, t('footnote')))))
    }

    exports.NS = NS
    exports.SETTINGS_NS = SETTINGS_NS
    exports.SECTION_ORDER = SECTION_ORDER
    exports.DevWorkflowSwitchSection = DevWorkflowSwitchSection
    exports.apply = apply
    exports.inject = ['slots', 'locale', 'settingsScope']
    return module.exports
  },
})
