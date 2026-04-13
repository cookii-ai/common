/**
 * immersive-ractive.js — 通用 AI 请求 + 响应解析 + Ractive data 赋值引擎
 *
 * 职责（仅此，不含任何 UI / Ractive 实例化代码）：
 *   - parseAIResponse(app, raw)   解析 AI 响应并写入 Ractive data
 *   - runAction(app, payload)     发请求 → 解析 → 写入（一步到位）
 *   - DEFAULT_CONFIG              默认解析配置（可直接修改以调整全局行为）
 *
 * 在 Ractive 的 on.sendAction 里直接调用：
 *   ImmersiveRactive.runAction(this, buildPrompt(action, this))
 *     .then(() => this.set('isLoading', false));
 *
 * app 参数只需满足鸭子类型：{ get(keypath), set(keypath, val), push(keypath, val) }
 * ——Ractive 实例天然满足，也可传自定义 adapter。
 */
(function (global) {
  'use strict';

  // ─── 默认解析配置 ──────────────────────────────────────────────────────────
  var DEFAULT_CONFIG = {
    /**
     * 匹配 update_status 指令的正则。
     * 支持两种写法（兼容旧格式）：
     *   - 旧： "{{addvar::update_status.hp::1}}"
     *   - 新： "addvar::update_status.hp::1"
     *
     * 捕获组：1=操作类型(setvar|addvar)  2=路径  3=值
     */
    statusVarRegex: /^\s*(?:\{\{)?\s*(addvar|setvar)::([^:]+)::([\s\S]*?)(?:\}\})?\s*$/
  };

  // ─── parseAIResponse ───────────────────────────────────────────────────────
  /**
   * 解析 AI 响应并写入 Ractive（或鸭子类型 adapter）。
   *
   * ══ 两套更新机制，职责明确分离 ══════════════════════════════════════════════
   *
   * ══ 两种写入机制 ═════════════════════════════════════════════════════════════
   *
   * ① update_status —— 标量字段精确读写（数值、字符串状态变量）
   *   ─────────────────────────────────────────────────────────────────────────
   *   适用于：数值（好感度、血量、金钱等）、字符串（位置、时间、装备名等）
   *   所有非追加类的业务参数都通过此机制更新，而非直接放在 JSON 顶层。
   *
   *   "update_status": [
   *     "{{addvar::update_status.affection::3}}",      // 数值累加
   *     "{{setvar::update_status.world_location::新地点}}", // 字段赋值
   *     "{{setvar::update_status.world_time::14:30}}"
   *   ]
   *
   *   keypath = gameData 中的点路径；标量字段统一放在 gameData.update_status 对象下，
   *   因此 keypath 固定以 update_status. 开头，如 update_status.hp、update_status.sword
   *   setvar → 直接赋值；纯数字字符串自动转 number。
   *   addvar → 目标是 number/不存在 → 累加；目标是数组 → append item；其他 → 字符串拼接。
   *
   * ② 追加类字段 —— 值为数组时逐项 push（聊天消息、故事叙述等历史记录）
   *   ─────────────────────────────────────────────────────────────────────────
   *   适用于：需要在前端 UI 持续追加渲染的字段（消息列表、叙事记录等）
   *   gameData 中定义为 array，AI 每轮输出新条目追加到末尾，不覆盖历史。
   *
   *   "keypath": [{ ...条目字段... }]   // 每个条目 push 到对应数组末尾
   *
   * ════════════════════════════════════════════════════════════════════════════
   *
   * @param {object} app         - Ractive 实例（或实现了 get/set/push 的 adapter）
   * @param {string|object} raw  - AI 原始响应
   */
  function parseAIResponse(app, raw) {
    var statusVarRe = DEFAULT_CONFIG.statusVarRegex;

    // ── 反序列化 ────────────────────────────────────────────────────────────
    var obj = raw;
    if (typeof raw === 'string') {
      try {
        // 预处理：剥离 AI 常见的包装格式，提取其中的 JSON 对象字符串
        // 处理：```json...```、<JSON>...</JSON> 等标签包裹、以及前后的多余文本
        var stripped = raw.trim();
        // 1. Markdown 代码块（```json ... ``` 或 ``` ... ```）
        var mdMatch = stripped.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (mdMatch) {
          stripped = mdMatch[1].trim();
        } else {
          // 2. 截取第一个 { 到最后一个 }，跳过 <JSON> 等标签前缀和后缀
          var start = stripped.indexOf('{');
          var end = stripped.lastIndexOf('}');
          if (start !== -1 && end > start) stripped = stripped.slice(start, end + 1);
        }

        // 优先使用 jsonrepair 修复残缺/非标准 JSON（如 AI 流式截断、单引号、末尾逗号等）
        var repairFn = typeof JSONRepair !== 'undefined' ? JSONRepair.jsonrepair : null;
        obj = JSON.parse(repairFn ? repairFn(stripped) : stripped);
        console.log('[ImmersiveRactive] JSON parsed:', obj);
      }
      catch (e) {
        console.error('[ImmersiveRactive] JSON parse error:', e.message, '\nRaw:', raw);
        return;
      }
    }
    if (!obj || typeof obj !== 'object') return;

    // ── 降级兼容：将顶层 "update_status.xxx" key 归并到 update_status 数组 ────
    // AI 有时将标量更新展开为顶层 key（如 "update_status.affection.julian": "addvar::..."）
    // 这里统一收集后拼入 update_status，按正常流程处理
    Object.keys(obj).forEach(function (key) {
      if (key !== 'update_status' && key.indexOf('update_status.') === 0) {
        var raw_val = obj[key];
        var cmd = typeof raw_val === 'string' ? raw_val.trim() : '';
        // 如果值已经是 addvar/setvar 指令（无论是否包裹 {{ }}），直接收入；否则按 setvar 包装
        var line;
        if (/^(?:\{\{)?\s*(addvar|setvar)::/.test(cmd)) {
          line = cmd;
        } else {
          // 值不是指令字符串，当作 setvar 处理（使用不带 {{ }} 的新语法）
          line = 'setvar::' + key + '::' + cmd;
        }
        if (!Array.isArray(obj.update_status)) obj.update_status = [];
        obj.update_status.push(line);
        delete obj[key];
      }
    });

    // ── 1. update_status：精确字段操作（setvar / addvar）────────────────────
    var updates = obj.update_status;
    if (Array.isArray(updates)) {
      updates.forEach(function (line) {
        if (!line || typeof line !== 'string') return;
        var m = line.trim().match(statusVarRe);
        if (!m) return;

        var type    = m[1];
        var path    = m[2].trim();
        var value   = m[3].trim();
        var keypath = path.replace(/\[(\d+)\]/g, '.$1');

        if (type === 'addvar') {
          var current = app.get(keypath);
          console.log('[ImmersiveRactive] addvar:', keypath, current, value);
          if (Array.isArray(current)) {
            // ① 目标是数组 → append
            var el;
            try { el = JSON.parse(value); }
            catch (e) {
              var n0 = parseFloat(value);
              el = (!isNaN(n0) && value.trim() === String(n0)) ? n0 : value;
            }
            if (typeof app.push === 'function') {
              app.push(keypath, el);
            } else {
              app.set(keypath + '.' + current.length, el);
            }
            console.log('[ImmersiveRactive] addvar appended:', keypath, app.get(keypath));
          } else {
            // ② 数值累加 / ③ 字符串拼接
            var num = parseFloat(value);
            if (!isNaN(num) && (current == null || typeof current === 'number')) {
              app.set(keypath, (typeof current === 'number' ? current : 0) + num);
            } else {
              app.set(keypath, current == null ? value : String(current) + value);
            }
          }

        } else {
          // setvar：纯数字字符串 → number，其余保持字符串
          var num2   = parseFloat(value);
          var isPure = !isNaN(num2) && value.trim() === String(num2);
          app.set(keypath, isPure ? num2 : value);
        }
      });
    }

    // ── 2. 追加类字段：值为数组 → 逐项 push；非数组 → setDeep ──────────────
    //
    //   规则：凡不在 update_status 中的字段：
    //     - 值为数组 → 每项 push 到对应 keypath 末尾（追加，不覆盖历史）
    //     - 值为非数组 → setDeep（对象递归合并 / 原始值直接覆盖）

    /**
     * 按 update_type 将单个 item 写入 keypath 对应的 Ractive 字段。
     *
     * append（默认）: 去掉 update_type 后 push 到目标数组末尾；目标不存在则创建。
     * add           : item.value 累加到目标数值；目标不存在时从 0 计算。
     * set           : item.value 直接覆盖目标字段。
     */
    function applyItem(keypath, item) {
      var updateType = (item && item.update_type) || 'append';

      if (updateType === 'set') {
        app.set(keypath, item.value);
        console.log('[ImmersiveRactive] set:', keypath, item.value);

      } else if (updateType === 'add') {
        var current = app.get(keypath);
        var delta   = parseFloat(item.value);
        if (!isNaN(delta)) {
          app.set(keypath, (typeof current === 'number' ? current : 0) + delta);
          console.log('[ImmersiveRactive] add:', keypath, delta, '→', app.get(keypath));
        }

      } else {
        // 'append' or unknown — strip update_type field before pushing
        var clean = {};
        Object.keys(item).forEach(function (k) {
          if (k !== 'update_type') clean[k] = item[k];
        });
        var existing = app.get(keypath);
        if (Array.isArray(existing)) {
          if (typeof app.push === 'function') {
            app.push(keypath, clean);
          } else {
            app.set(keypath + '.' + existing.length, clean);
          }
        } else {
          app.set(keypath, [clean]);
        }
        console.log('[ImmersiveRactive] append:', keypath, clean);
      }
    }

    // setDeep：非数组根级值的 fallback（对象递归合并 / 原始值直接覆盖）
    function setDeep(keypath, value) {
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        Object.keys(value).forEach(function (k) {
          setDeep(keypath + '.' + k, value[k]);
        });
      } else {
        app.set(keypath, value);
      }
    }

    Object.keys(obj).forEach(function (key) {
      if (key === 'update_status') return;
      var value = obj[key];
      if (Array.isArray(value)) {
        value.forEach(function (item) {
          if (item !== null && typeof item === 'object') {
            applyItem(key, item);
          } else {
            // 数组中的原始值：直接 push
            var existing = app.get(key);
            if (Array.isArray(existing)) {
              if (typeof app.push === 'function') {
                app.push(key, item);
              } else {
                app.set(key + '.' + existing.length, item);
              }
            }
          }
        });
      } else {
        // 非数组值：若目标字段已是数组，则把该对象作为单条 push（兼容 AI 将 keypath 合并输出的情况）
        var targetArr = app.get(key);
        if (Array.isArray(targetArr) && value !== null && typeof value === 'object') {
          if (typeof app.push === 'function') {
            app.push(key, value);
          } else {
            app.set(key + '.' + targetArr.length, value);
          }
          console.log('[ImmersiveRactive] push (single obj):', key, value);
        } else {
          setDeep(key, value);
        }
      }
    });
  }

  // ─── mockSendRequest ──────────────────────────────────────────────────────
  /**
   * 开发阶段 mock：模拟后端 1.5s 后返回固定 JSON 响应。
   * 真实环境中全局 TavernHelper.generate 会自动优先被使用，无需修改任何代码。
   */
  function mockSendRequest(prompt) {
    console.log('[ImmersiveRactive.mock] prompt:', prompt);
    return new Promise(function (resolve) {
      setTimeout(function () {
        resolve(JSON.stringify({
          // ① channels.*：聊天 / 故事内容追加，update_type 默认 'append' 可省略
          'channels.story': [{
            type: 'narrative',
            content: '<p>You nod, accepting his offer. A flicker of something unreadable crosses Julian\'s face before it settles back into its usual stoicism. <span class="narrative-highlight">"Be there tomorrow at 9 AM sharp. Do not be late."</span></p>'
          }],
          'dm.julian': [{
            type: 'message', sender: 'julian',
            content: "I've forwarded the project outline and safety protocols. Review them tonight."
          }],
          'channels.group': [{
            type: 'message', sender: 'cain',
            content: 'Julian, I expect a full report on this new arrangement. <span class="mention">@Julian</span>'
          }],
          // ② update_status：状态栏 / 数值系统专用，addvar 累加，setvar 赋值
          update_status: [
            '{{addvar::status.affection_julian::3}}',
            '{{addvar::status.whitmore_favor::5}}',
            '{{setvar::status.world_location::Sterling Science Hall}}',
            '{{setvar::status.world_time::09:00 AM}}'
          ],
          // ③ 下一轮行动选项
          action_options: ['接受这份工作', '委婉拒绝', '询问工作内容']
        }));
      }, 1500);
    });
  }

  // ─── runAction ────────────────────────────────────────────────────────────
  /**
   * 发送请求 → 解析响应 → 写入 Ractive data。
   *
   * 发送函数优先级：
   *   1. opts.sendRequest（调用方显式传入）
   *   2. 全局 TavernHelper.generate（SillyTavern / 真实环境，自动使用）
   *   3. 内置 mockSendRequest（本地开发 fallback）
   *
   * 典型用法（Ractive on.sendAction 内部，无需关心发送层）：
   *   ImmersiveRactive.runAction(this, buildPrompt(action, this))
   *     .then(() => this.set('isLoading', false));
   *
   * @param {object} app      - Ractive 实例
   * @param {any}    payload  - prompt 字符串或任意 payload
   * @param {object} [opts]
   *   opts.sendRequest(payload) → Promise   可选，覆盖默认发送函数
   *   opts.responseParser(app, raw)         可选，自定义解析器替代 parseAIResponse
   *
   * @returns Promise<raw>
   */
  function runAction(app, payload, opts) {
    opts = opts || {};
    var parser = opts.responseParser || parseAIResponse;

    var send = function (p) { return TavernHelper.generate(p); }

    return send(payload).then(function (raw) {
      parser(app, raw);
      return raw;
    });
  }

  // ─── stopAction ───────────────────────────────────────────────────────────
  /**
   * 中止当前正在进行的 AI 生成请求。
   * 封装 TavernHelper.stopAllGeneration()，统一通过 ImmersiveRactive 调用。
   *
   * 典型用法（终止按钮 on-click 处理器）：
   *   stopGeneration() { ImmersiveRactive.stopAction(); this.set('isLoading', false); }
   */
  function stopAction() {
    if (typeof TavernHelper !== 'undefined' && typeof TavernHelper.stopAllGeneration === 'function') {
      TavernHelper.stopAllGeneration();
    }
  }

  // ─── 内部工具：生成 storageKey ────────────────────────────────────────────
  /**
   * 按优先级生成 localStorage 键名：
   *   1. 调用方显式传入的 override 字符串
   *   2. SillyTavern.getCurrentChatId() + '_ractive'（框架注入的会话 ID）
   *   3. fallback：
   *      - 预览页：'immersive_ractive::' + window.location.pathname + '::v_版本ID'
   *      - 其他：'immersive_ractive::' + window.location.pathname
   */
  function resolveStorageKey() {
    try {
      var chatId =
        (typeof SillyTavern !== 'undefined' && typeof SillyTavern.getCurrentChatId === 'function')
          ? SillyTavern.getCurrentChatId()
          : null;
      if (chatId) return chatId + '_ractive';
    } catch (e) {
      console.error('[ImmersiveRactive] resolveStorageKey error:', e.message);
    }
    var returnKey = 'immersive_ractive::' + (window.location.pathname || 'default');

    // 预览页（/kitchen）下，尝试附加版本 ID，避免不同版本共用同一个缓存 key
    try {
      // 允许 React 侧通过全局变量补充版本 ID（例如在切换版本时设置）
      if (window.__immersiveCharacterVersionId) {
        returnKey += '::v_' + String(window.__immersiveCharacterVersionId);
      }
    } catch (e2) {
      console.error('[ImmersiveRactive] resolveStorageKey fallback error:', e2.message);
    }
    console.log('[ImmersiveRactive] resolveStorageKey: ', returnKey);
    return returnKey;
  }

  // ─── saveState ────────────────────────────────────────────────────────────
  /**
   * 将当前 Ractive app 的全部 data 持久化到 localStorage。
   * runAction 每次 AI 响应写入后自动调用，也可手动调用。
   *
   * @param {object} app          - Ractive 实例
   */
  function saveState(app) {
    var key = resolveStorageKey();
    console.log('[ImmersiveRactive] saveState: ', key);
    try {
      var state = app.get();
      localStorage.setItem(key, JSON.stringify(state));
    } catch (e) {
      console.error('[ImmersiveRactive] saveState error:', e.message);
    }
  }

  // ─── loadState ────────────────────────────────────────────────────────────
  /**
   * 从 localStorage 读取上次持久化的 data，并通过 app.set() 覆盖当前 data。
   * 在 Ractive init() 中调用，会覆盖 data:{} 中定义的初始值。
   * 若无缓存或解析失败，直接返回 false，data:{} 初始值保持不变。
   *
   * 典型用法（Ractive init() 内）：
   *   init() {
   *     ImmersiveRactive.loadState(this);  // 有缓存则恢复，无缓存则使用 data:{} 默认值
   *   }
   *
   * @param {object} app          - Ractive 实例
   * @returns {boolean} true=成功恢复缓存  false=无缓存或失败
   */
  function loadState(app) {
    var key = resolveStorageKey();
    try {
      var raw = localStorage.getItem(key);
      console.log('[ImmersiveRactive] loadState: ', key, raw);
      if (!raw) return false;
      var state = JSON.parse(raw);
      app.set(state);
      return true;
    } catch (e) {
      console.error('[ImmersiveRactive] loadState error:', e.message);
      return false;
    }
  }

  // ─── clearState ───────────────────────────────────────────────────────────
  /**
   * 清除 localStorage 的本地缓存（重置存档时使用）。
   */
  function clearState() {
    var key = resolveStorageKey();
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }

  // ─── 导出 ─────────────────────────────────────────────────────────────────
  global.ImmersiveRactive = {
    runAction       : runAction,
    stopAction      : stopAction,
    saveState       : saveState,
    loadState       : loadState,
    clearState      : clearState,
    DEFAULT_CONFIG  : DEFAULT_CONFIG
  };

})(typeof window !== 'undefined' ? window : this);
