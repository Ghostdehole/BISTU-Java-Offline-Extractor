// ==UserScript==
// @name         BISTU Java 离线题库提取工具
// @namespace    http://tampermonkey.net/
// @version      7.11.0
// @description  练习题干、选项与图片离线导出，支持断点恢复和可选 AI 解答
// @match        http://10.148.168.66/Manage/Practice/index*
// @match        https://10.148.168.66/Manage/Practice/index*
// @updateURL    https://raw.githubusercontent.com/Ghostdehole/BISTU-Java-Offline-Extractor/main/BISTU_Java_Extractor.user.js
// @downloadURL  https://raw.githubusercontent.com/Ghostdehole/BISTU-Java-Offline-Extractor/main/BISTU_Java_Extractor.user.js
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const SCRIPT_VERSION = '7.11.0'; // Keep in sync with userscript @version.

    if (window.top !== window.self) return;

    // ==========================================
    // 0. 平台抽象层
    // ==========================================
    const PLATFORM_CONFIG = {
        API: {
            GET_LIST: "/Manage/Practice/GetTopicData",
            GET_DETAIL: (type, guid) => `/Manage/Practice/JumpToPracticeTopic?QuestionType=${type}&Guid=${guid}`,
            SUBMIT_ANSWER: (type) => `/Manage/Practice/Practice${type}`
        },
        SELECTORS: {
            LANG: "#select_LanguageType",
            DEGREE: "#select_DegreeLevel",
            CHAPTER_TREE: "ul_Tree",
            KNO: "#select_KnoGuid",
            SEARCH: "#input_Search"
        },
        TYPES: [
            {id: 1, name: "单选题", type: "Single"},
            {id: 2, name: "多选题", type: "Multiple"},
            {id: 3, name: "判断题", type: "TrueOrFalse"},
            {id: 4, name: "填空题", type: "Blank"},
            {id: 5, name: "程序题", type: "Program"}
        ]
    };

    // ==========================================
    // 1. 全局状态机与核心变量
    // ==========================================
    let globalState = {
        version: SCRIPT_VERSION,
        stage: 1,
        isPaused: true,
        outOfKeys: false,
        elapsedSeconds: 0,
        listProgress: { typeIndex: 0, pageIndex: 1, totalPages: 0 }
    };

    let allData = [];
    let imageQueue = new Map();
    let imgCounter = 1;
    let engineRunning = false;
    let ocrWorkerPromise = null;
    let dependencyPromise = null;
    let ocrWorker = null;
    const parser = new DOMParser();

    let currentLang, currentDegree, currentKno, currentSearch, origin, currentChapter;

    class ApiKeyManager {
        constructor() { this.keys = []; this.index = 0; }
        updateKeys(keyStr) {
            this.keys = keyStr.split(/[,，;\n]/).map(k => k.trim()).filter(k => k);
            this.index = 0;
            globalState.outOfKeys = false;
        }
        getKey() {
            if (this.keys.length === 0) return null;
            let k = this.keys[this.index];
            this.index = (this.index + 1) % this.keys.length;
            return k;
        }
        getCount() { return this.keys.length; }
    }
    const keyManager = new ApiKeyManager();

    // ==========================================
    // 2. 构建响应式可视化操作面板
    // ==========================================
    const panelId = "bistu-extractor-panel";
    if(document.getElementById(panelId)) document.getElementById(panelId).remove();

    const panelHTML = `
        <div id="${panelId}" style="position:fixed; top:20px; right:20px; width:560px; min-width:400px; min-height:500px; height:720px; background:rgba(25, 25, 25, 0.95); backdrop-filter:blur(10px); border-radius:12px; box-shadow:0 12px 36px rgba(0,0,0,0.6); z-index:2147483647; display:flex; flex-direction:column; font-family:'Microsoft YaHei', Consolas, sans-serif; border: 1px solid #444; overflow: visible;">

            <div class="panel-resizer n" style="position:absolute; top:-5px; left:10px; right:10px; height:10px; cursor:n-resize; z-index:10;"></div>
            <div class="panel-resizer s" style="position:absolute; bottom:-5px; left:10px; right:10px; height:10px; cursor:s-resize; z-index:10;"></div>
            <div class="panel-resizer e" style="position:absolute; top:10px; bottom:10px; right:-5px; width:10px; cursor:e-resize; z-index:10;"></div>
            <div class="panel-resizer w" style="position:absolute; top:10px; bottom:10px; left:-5px; width:10px; cursor:w-resize; z-index:10;"></div>
            <div class="panel-resizer nw" style="position:absolute; top:-5px; left:-5px; width:15px; height:15px; cursor:nw-resize; z-index:11;"></div>
            <div class="panel-resizer ne" style="position:absolute; top:-5px; right:-5px; width:15px; height:15px; cursor:ne-resize; z-index:11;"></div>
            <div class="panel-resizer sw" style="position:absolute; bottom:-5px; left:-5px; width:15px; height:15px; cursor:sw-resize; z-index:11;"></div>
            <div class="panel-resizer se" style="position:absolute; bottom:-5px; right:-5px; width:15px; height:15px; cursor:se-resize; z-index:11;"></div>

            <div id="${panelId}-header" style="padding:15px; background:linear-gradient(90deg, #087f68, #055a49); color:white; border-radius:11px 11px 0 0; cursor:move; display:flex; justify-content:space-between; align-items:center; user-select:none; flex-shrink: 0;">
                <span style="font-weight:bold; font-size:16px;">🎓 BISTU题库提取 <small style="font-size:11px; opacity:.8;">v${SCRIPT_VERSION}</small></span>
                <button id="bistu-fullscreen-btn" class="bistu-fs-btn">🔲 铺满窗口</button>
            </div>

            <div style="padding: 12px 15px; background: rgba(0,0,0,0.4); flex-shrink: 0;">
                <div style="display:flex; justify-content:space-between; font-size:12px; margin-bottom:6px; color:#ddd;">
                    <span id="bistu-global-status" style="font-weight:bold;">💤 准备就绪</span>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <span id="bistu-global-timer" style="color:#ffb74d; font-family:Consolas, monospace;">⏱️ 00:00</span>
                        <span id="bistu-global-percent" style="font-weight:bold; color:#4db6ac;">0.0%</span>
                    </div>
                </div>
                <div style="width:100%; background:#111; border-radius:6px; height:12px; overflow:hidden; border: 1px solid #333; box-shadow: inset 0 1px 3px rgba(0,0,0,0.5);">
                    <div id="bistu-global-progress" style="width:0%; height:100%; background:linear-gradient(90deg, #4db6ac, #087f68); transition:width 0.4s ease-out; position:relative;">
                        <div style="position:absolute; top:0; left:0; right:0; bottom:0; background:linear-gradient(45deg, rgba(255,255,255,0.15) 25%, transparent 25%, transparent 50%, rgba(255,255,255,0.15) 50%, rgba(255,255,255,0.15) 75%, transparent 75%, transparent); background-size:20px 20px; animation:progress-stripes 1s linear infinite;"></div>
                    </div>
                </div>
            </div>

            <div id="bistu-apikey-container" style="padding:15px; background:rgba(0,0,0,0.3); border-bottom:1px solid #333; flex-shrink: 0;">
                <textarea id="bistu-apikey" placeholder="🔑 填入 DeepSeek API Key (多个用逗号隔开)。留空则跳过 AI 解答阶段。" style="width:100%; height:45px; padding:8px; border-radius:4px; border:1px solid #444; background:#1e1e1e; color:#fff; font-size:13px; margin-bottom:10px; box-sizing:border-box; resize:none;"></textarea>
                <div id="bistu-init-actions" style="display:flex; gap:10px;">
                    <button id="bistu-start-btn" style="flex:1; padding:8px; background:#087f68; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold; transition:0.2s;">▶️ 全新开始提取</button>
                    <button id="bistu-import-btn" style="flex:1; padding:8px; background:#f57c00; color:white; border:none; border-radius:4px; cursor:pointer; font-weight:bold; transition:0.2s;">📂 导入断点 ZIP 继续</button>
                    <input type="file" id="bistu-file-input" style="display:none" accept=".zip">
                </div>
            </div>

            <div style="padding:12px 15px; color:#ccc; font-size:13px; border-bottom:1px solid #333; flex-shrink: 0; background:rgba(0,0,0,0.2);">
                <div id="bistu-step-1" style="margin-bottom:6px;">⏳ 1. 扫描云端题库: <span id="bistu-val-1" style="color:#4db6ac; font-weight:bold;">等待</span></div>
                <div id="bistu-step-2" style="margin-bottom:6px;">⏳ 2. 题目、选项与答案验证: <span id="bistu-val-2" style="color:#4db6ac; font-weight:bold;">等待</span></div>
                <div id="bistu-step-3" style="margin-bottom:6px;">⏳ 3. AI 视觉清洗 & 解答: <span id="bistu-val-3" style="color:#4db6ac; font-weight:bold;">等待</span></div>
                <div id="bistu-step-4" style="margin-bottom:2px;">⏳ 4. 图片并发兜底下载: <span id="bistu-val-4" style="color:#4db6ac; font-weight:bold;">等待</span></div>
            </div>

            <div style="flex-grow:1; background:#0a0a0a; margin:10px; border-radius:6px; padding:12px; overflow-y:auto; border:1px inset #222;" id="${panelId}-log">
                <div style="color:#4db6ac; font-size:12px; margin-bottom:5px;">[System] 引擎注入成功，日志系统已就绪...</div>
            </div>

            <div id="bistu-run-actions" style="padding:15px; display:none; gap:10px; background:#111; border-radius:0 0 11px 11px; flex-shrink: 0;">
                <button id="bistu-pause-btn" style="flex:1; padding:10px; background:#ef5350; color:white; border:none; border-radius:6px; font-size:14px; font-weight:bold; cursor:pointer; transition:0.3s;">
                    ⏸️ 暂停并生成防丢 ZIP
                </button>
                <button id="bistu-download-btn" style="flex:1; padding:10px; background:#444; color:#999; border:none; border-radius:6px; font-size:14px; font-weight:bold; cursor:not-allowed;" disabled>
                    🚧 处理中...
                </button>
            </div>
            <style>
                @keyframes progress-stripes { from { background-position: 40px 0; } to { background-position: 0 0; } }
                .bistu-fs-btn { background:rgba(255,255,255,0.2); border:none; color:white; padding:4px 10px; border-radius:12px; cursor:pointer; font-size:12px; transition:0.2s; outline:none; }
                .bistu-fs-btn:hover { background:rgba(255,255,255,0.4); }
            </style>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', panelHTML);

    const panel = document.getElementById(panelId);
    const header = document.getElementById(`${panelId}-header`);
    const logBox = document.getElementById(`${panelId}-log`);
    const apiKeyContainer = document.getElementById('bistu-apikey-container');
    const initActions = document.getElementById('bistu-init-actions');
    const runActions = document.getElementById('bistu-run-actions');
    const startBtn = document.getElementById('bistu-start-btn');
    const importBtn = document.getElementById('bistu-import-btn');
    const fileInput = document.getElementById('bistu-file-input');
    const pauseBtn = document.getElementById('bistu-pause-btn');
    const apiKeyInput = document.getElementById('bistu-apikey');
    const fullscreenBtn = document.getElementById('bistu-fullscreen-btn');

    // ==========================================
    // 3. UI 交互功能扩展 (计时器、全屏、拖拽)
    // ==========================================

    function updateTimerDisplay() {
        let s = globalState.elapsedSeconds || 0;
        let h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
        let pad = v => v.toString().padStart(2, '0');
        let timeStr = h > 0 ? `${pad(h)}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
        let timerEl = document.getElementById('bistu-global-timer');
        if(timerEl) timerEl.innerText = `⏱️ ${timeStr}`;
    }

    setInterval(() => {
        if (!globalState.isPaused && globalState.stage < 5 && !globalState.outOfKeys) {
            globalState.elapsedSeconds++;
            updateTimerDisplay();
        }
    }, 1000);

    let isMaximized = false;
    let preMaxStyles = {};
    fullscreenBtn.addEventListener('click', () => {
        if (!isMaximized) {
            preMaxStyles = { left: panel.style.left, top: panel.style.top, right: panel.style.right, bottom: panel.style.bottom, width: panel.style.width, height: panel.style.height, borderRadius: panel.style.borderRadius };
            panel.style.transition = 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
            panel.style.left = '0px'; panel.style.top = '0px'; panel.style.width = window.innerWidth + 'px'; panel.style.height = window.innerHeight + 'px'; panel.style.borderRadius = '0px';
            fullscreenBtn.innerText = '🗗 还原窗口'; isMaximized = true;
            setTimeout(() => panel.style.transition = 'none', 300);
        } else {
            panel.style.transition = 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
            panel.style.left = preMaxStyles.left; panel.style.top = preMaxStyles.top; panel.style.width = preMaxStyles.width; panel.style.height = preMaxStyles.height; panel.style.borderRadius = preMaxStyles.borderRadius;
            fullscreenBtn.innerText = '🔲 铺满窗口'; isMaximized = false;
            setTimeout(() => panel.style.transition = 'none', 300);
        }
    });

    window.addEventListener('resize', () => {
        if (isMaximized) { panel.style.width = window.innerWidth + 'px'; panel.style.height = window.innerHeight + 'px'; }
    });

    let isDragging = false, offsetX, offsetY;
    header.addEventListener('mousedown', (e) => {
        if (isMaximized || e.target.closest('#bistu-fullscreen-btn')) return;
        isDragging = true; const rect = panel.getBoundingClientRect(); offsetX = e.clientX - rect.left; offsetY = e.clientY - rect.top;
        panel.style.transition = 'none'; panel.style.right = 'auto'; panel.style.bottom = 'auto';
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        let left = e.clientX - offsetX; let top = e.clientY - offsetY;
        left = Math.max(0, Math.min(left, window.innerWidth - panel.offsetWidth)); top = Math.max(0, Math.min(top, window.innerHeight - panel.offsetHeight));
        panel.style.left = left + 'px'; panel.style.top = top + 'px';
    });
    document.addEventListener('mouseup', () => { isDragging = false; });

    const resizers = document.querySelectorAll('.panel-resizer');
    let currentResizer = null;
    let original_width = 0, original_height = 0, original_x = 0, original_y = 0, original_mouse_x = 0, original_mouse_y = 0;

    resizers.forEach(resizer => {
        resizer.addEventListener('mousedown', function(e) {
            if (isMaximized) return;
            e.preventDefault();
            const rect = panel.getBoundingClientRect();
            original_width = rect.width; original_height = rect.height; original_x = rect.left; original_y = rect.top;
            original_mouse_x = e.clientX; original_mouse_y = e.clientY;
            currentResizer = resizer;
            panel.style.right = 'auto'; panel.style.bottom = 'auto'; panel.style.left = original_x + 'px'; panel.style.top = original_y + 'px';
            window.addEventListener('mousemove', resizePanel); window.addEventListener('mouseup', stopResizePanel);
        });
    });

    function resizePanel(e) {
        if (!currentResizer) return;
        const dir = currentResizer.className.split(' ')[1];
        const dx = e.clientX - original_mouse_x; const dy = e.clientY - original_mouse_y;
        let newW = original_width, newH = original_height, newL = original_x, newT = original_y;
        if (dir.includes('e')) newW = original_width + dx;
        if (dir.includes('s')) newH = original_height + dy;
        if (dir.includes('w')) { newW = original_width - dx; newL = original_x + dx; }
        if (dir.includes('n')) { newH = original_height - dy; newT = original_y + dy; }
        if (newW >= 400) { panel.style.width = newW + 'px'; if(dir.includes('w')) panel.style.left = newL + 'px'; }
        if (newH >= 500) { panel.style.height = newH + 'px'; if(dir.includes('n')) panel.style.top = newT + 'px'; }
    }
    function stopResizePanel() { currentResizer = null; window.removeEventListener('mousemove', resizePanel); window.removeEventListener('mouseup', stopResizePanel); }

    let logQueue = [];
    let isFlushingLog = false;
    function addLog(msg, type = "info") {
        logQueue.push({msg, type});
        if (!isFlushingLog) {
            isFlushingLog = true;
            requestAnimationFrame(flushLogs);
        }
    }
    function flushLogs() {
        const fragment = document.createDocumentFragment();
        // ✅ 修复：放宽阈值至 150，解决快速刷新导致吸附判定丢失的问题
        const isScrolledToBottom = logBox.scrollHeight - logBox.clientHeight <= logBox.scrollTop + 150;

        while(logQueue.length > 0) {
            const {msg, type} = logQueue.shift();
            const p = document.createElement('div');
            p.style.fontSize = "12px"; p.style.marginBottom = "4px"; p.style.lineHeight = "1.4"; p.style.wordBreak = "break-all"; p.style.whiteSpace = "pre-wrap";
            p.style.fontFamily = "Consolas, monospace";
            let color = "#bbb";
            if(type === "error") color = "#ff5252";
            else if(type === "success") color = "#69f0ae";
            else if(type === "warning") color = "#ffb74d";
            else if(type === "scan") color = "#4fc3f7";
            else if(type === "ai") color = "#ce93d8";
            else if(type === "image") color = "#ffd54f";

            p.style.color = color;
            let timeStr = new Date().toLocaleTimeString('en-US', {hour12:false, hour:'2-digit', minute:'2-digit', second:'2-digit'});
            p.innerText = `[${timeStr}] ${msg}`;
            fragment.appendChild(p);
        }
        logBox.appendChild(fragment);
        // ✅ 修复：使用瞬间跳底 behavior: 'auto'，彻底解决平滑动画追不上的 BUG
        if (isScrolledToBottom) logBox.scrollTo({ top: logBox.scrollHeight, behavior: 'auto' });
        isFlushingLog = false;
    }

    function updateUI(step, text, isDone = false) {
        let el = document.getElementById(`bistu-val-${step}`);
        if(el) el.innerText = text;
        if(isDone) {
            let st = document.getElementById(`bistu-step-${step}`);
            st.style.color = '#81c784'; st.innerHTML = st.innerHTML.replace('⏳', '✅').replace('▶️', '✅');
        } else {
            let st = document.getElementById(`bistu-step-${step}`);
            st.style.color = '#ddd'; st.innerHTML = st.innerHTML.replace('✅', '▶️').replace('⏳', '▶️');
        }
        updateGlobalProgress();
    }

    function updateGlobalProgress() {
        let percent = 0; let status = "处理中";
        if (globalState.stage === 1) { percent = (globalState.listProgress.typeIndex / (globalState.scope?.typeDefinitions?.length || PLATFORM_CONFIG.TYPES.length)) * 5; status = "📡 扫描题库中..."; }
        else if (globalState.stage === 2) { let done = allData.filter(i => i.s2_done).length; percent = 5 + (allData.length > 0 ? (done / allData.length) * 45 : 0); status = "📚 提取题目并验证答案..."; }
        else if (globalState.stage === 3) { let aiItems = allData.filter(i => i.NeedsAI); let done = aiItems.filter(i => i.s3_done).length; percent = 50 + (aiItems.length > 0 ? (done / aiItems.length) * 40 : 40); status = "🧠 AI 大模型作答中..."; }
        else if (globalState.stage === 4) { let imgItems = Array.from(imageQueue.values()); let done = imgItems.filter(i => i.downloaded || i.failed || i.sourceUnavailable).length; percent = 90 + (imgItems.length > 0 ? (done / imgItems.length) * 10 : 10); status = "🖼️ 并发下载图片中..."; }
        else if (globalState.stage >= 5) {
            percent = 100;
            const warnings = allData.filter(item => item.ExtractionWarning).length;
            status = `✅ 已提取 ${allData.length} 题${warnings ? `（${warnings} 题含平台内容提示）` : ''}`;
        }

        if (globalState.isPaused) status = globalState.stage > 4 ? "⚠️ ZIP 尚未生成，请重试打包" : "⏸️ 任务已暂停 (支持续传)";
        if (globalState.outOfKeys) status = "🛑 API Key耗尽，已挂起！";

        document.getElementById('bistu-global-percent').innerText = `${percent.toFixed(1)}%`;
        document.getElementById('bistu-global-progress').style.width = `${percent}%`;
        document.getElementById('bistu-global-status').innerText = status;
    }

    const yieldThread = () => new Promise(r => setTimeout(r, 0));
    function getFormattedTime() { let d = new Date(); let pad = n => n.toString().padStart(2, '0'); return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }

    function semanticQuestionType(value) {
        const normalized = String(value || '').trim().toLowerCase().replace(/[\s_\-\/()（）]/g, '');
        const aliases = {
            Single: ['single', 'singlechoice', '单选', '单选题', '单项选择题'],
            Multiple: ['multiple', 'multiplechoice', '多选', '多选题', '多项选择题'],
            TrueOrFalse: ['trueorfalse', 'truefalse', '判断', '判断题'],
            Blank: ['blank', 'fillintheblank', 'fillintheblanks', '填空', '填空题'],
            Program: ['program', 'programming', '程序题', '编程题', '程序设计题']
        };
        return Object.keys(aliases).find(type => aliases[type].includes(normalized)) || null;
    }

    function validateTypeDefinitions(definitions) {
        if (!Array.isArray(definitions) || !definitions.length || definitions.length > PLATFORM_CONFIG.TYPES.length) {
            throw new Error('题型配置为空或数量超出支持范围，请检查平台题型菜单。');
        }
        const values = new Set(); const semantics = new Set();
        return definitions.map(definition => {
            const supported = definition && PLATFORM_CONFIG.TYPES.find(type => type.type === definition.type);
            const rawId = definition && String(definition.id ?? '').trim();
            const id = /^\d+$/.test(rawId) ? Number(rawId) : rawId;
            const validId = typeof id === 'number' ? Number.isSafeInteger(id) && id >= 0 : semanticQuestionType(id) === definition?.type;
            if (!supported || !validId || values.has(String(id)) || semantics.has(definition.type)) {
                throw new Error('题型编号无效、重复或存在未支持题型，请检查平台题型菜单。');
            }
            values.add(String(id)); semantics.add(definition.type);
            return { id, name: supported.name, type: supported.type };
        });
    }

    function readPlatformTypeDefinitions() {
        const select = document.querySelector('#select_QuestionType');
        if (!select || select.tagName !== 'SELECT') throw new Error('未找到平台题型菜单 #select_QuestionType。请进入在线练习页；若平台改版，需要更新适配。');
        const definitions = [];
        for (const option of Array.from(select.options)) {
            const value = option.value.trim();
            if (!value) continue; // Empty prompt options do not represent a question type.
            const labelType = semanticQuestionType(option.textContent);
            const valueType = semanticQuestionType(value);
            if (!labelType && !valueType) throw new Error(`平台出现未支持题型“${option.textContent.trim()}”（编号 ${value}），已停止以避免遗漏。`);
            if (labelType && valueType && labelType !== valueType) throw new Error('题型菜单的名称与枚举值不一致，请检查平台适配。');
            definitions.push({ id: value, type: labelType || valueType });
        }
        return validateTypeDefinitions(definitions);
    }

    function restorePlatformVariables(scope, stage = globalState.stage) {
        if (!scope || scope.origin !== window.location.origin) throw new Error("断点来源与当前平台不一致，不能继续扫描。");
        for (const field of ['language', 'degree', 'chapter', 'knowledge', 'search']) {
            if (typeof scope[field] !== 'string') throw new Error("断点筛选条件无效，请重新开始提取。");
        }
        const hasStoredTypes = scope.typeDefinitions !== undefined && scope.typeDefinitions !== null;
        const definitions = hasStoredTypes ? validateTypeDefinitions(scope.typeDefinitions) : readPlatformTypeDefinitions();
        if (stage === 1) {
            const currentDefinitions = readPlatformTypeDefinitions();
            if (!hasStoredTypes && (currentDefinitions.length !== PLATFORM_CONFIG.TYPES.length || currentDefinitions.some((type, index) => type.id !== PLATFORM_CONFIG.TYPES[index].id || type.type !== PLATFORM_CONFIG.TYPES[index].type))) {
                throw new Error('旧版扫描断点未保存题型编号与顺序，当前菜单已改变。请重新开始提取，避免错过题目。');
            }
            const sameTypes = definitions.length === currentDefinitions.length && definitions.every(saved => currentDefinitions.some(current => current.type === saved.type && current.id === saved.id));
            if (!sameTypes) throw new Error('平台题型或编号已改变，不能沿用扫描断点。请刷新页面并重新开始提取。');
        }
        scope.typeDefinitions = definitions;
        currentLang = scope.language; currentDegree = scope.degree; currentChapter = scope.chapter;
        currentKno = scope.knowledge; currentSearch = scope.search; origin = scope.origin;
    }

    function initializePlatformVariables() {
        const typeDefinitions = readPlatformTypeDefinitions();
        for (const [selector, tags] of [[PLATFORM_CONFIG.SELECTORS.DEGREE, ['SELECT']], [PLATFORM_CONFIG.SELECTORS.KNO, ['SELECT']], [PLATFORM_CONFIG.SELECTORS.SEARCH, ['INPUT', 'TEXTAREA']]]) {
            const control = document.querySelector(selector);
            if (!control || !tags.includes(control.tagName)) throw new Error(`无法读取平台筛选控件 ${selector}，已停止以避免扩大提取范围。请检查是否仍在在线练习页或平台是否改版。`);
        }
        if (!document.getElementById(PLATFORM_CONFIG.SELECTORS.CHAPTER_TREE)) throw new Error('未找到平台章节树，已停止以避免扩大提取范围。');
        let selectedChapters;
        try {
            const tree = $.fn?.zTree?.getZTreeObj(PLATFORM_CONFIG.SELECTORS.CHAPTER_TREE);
            if (!tree || typeof tree.getSelectedNodes !== 'function') throw new Error('章节树尚未初始化');
            selectedChapters = tree.getSelectedNodes();
            if (!Array.isArray(selectedChapters) || selectedChapters.some(node => !node || node.id === undefined || node.id === null || String(node.id).trim() === '')) throw new Error('章节选择数据无效');
        } catch (_) { throw new Error('无法读取章节选择，已停止以避免扩大提取范围。请等待章节加载完成后重试；若仍失败，需要检查平台适配。'); }
        const selectedValues = value => Array.isArray(value) ? value.join(',') : String(value || '');
        currentLang = String($(PLATFORM_CONFIG.SELECTORS.LANG).val() || "Java");
        currentDegree = selectedValues($(PLATFORM_CONFIG.SELECTORS.DEGREE).val());
        currentChapter = selectedChapters.map(node => node.id).join(',');
        currentKno = selectedValues($(PLATFORM_CONFIG.SELECTORS.KNO).val());
        currentSearch = String($(PLATFORM_CONFIG.SELECTORS.SEARCH).val() || '');
        origin = window.location.origin;
        globalState.scope = { language: currentLang, degree: currentDegree, chapter: currentChapter, knowledge: currentKno, search: currentSearch, origin, typeDefinitions };
        globalState.sourceMetadata = { version: SCRIPT_VERSION, origin, path: window.location.pathname, capturedAt: new Date().toISOString() };
        keyManager.updateKeys(apiKeyInput.value.trim());
        if (keyManager.getCount()) addLog(`加载了 ${keyManager.getCount()} 个 API Key。`, "success");
        else addLog("未提供 API Key：保留全部题目，跳过 AI 解答。", "warning");
    }

    const fetchSafe = async (url, method, data = null, dataType = "json", timeout = 12000) => {
        const requestUrl = new URL(url, window.location.origin);
        const retryableRead = requestUrl.origin === window.location.origin && [PLATFORM_CONFIG.API.GET_LIST, '/Manage/Practice/JumpToPracticeTopic'].includes(requestUrl.pathname);
        const attempts = retryableRead ? 3 : 1;
        for (let attempt = 0; attempt < attempts; attempt++) {
            try {
                return await new Promise((resolve, reject) => {
                    $.ajax({ url, type: method, data, dataType, timeout, success: resolve,
                        error: (xhr, status) => reject(new Error(`平台请求失败 (${xhr && xhr.status || status || '网络错误'}): ${url.split('?')[0]}`)) });
                });
            } catch (error) {
                if (globalState.isPaused || attempt + 1 === attempts) throw error;
                await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
            }
        }
    };

    async function fetchWithTimeout(url, options = {}, timeout = 60000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const response = await fetch(url, { ...options, signal: controller.signal });
            const buffer = await response.arrayBuffer();
            return { ok: response.ok, status: response.status, headers: response.headers,
                arrayBuffer: async () => buffer,
                json: async () => JSON.parse(new TextDecoder().decode(buffer)) };
        } finally { clearTimeout(timer); }
    }

    function validateImageBuffer(buffer, contentType = '', timeout = 10000) {
        const bytes = buffer instanceof ArrayBuffer ? new Uint8Array(buffer) :
            ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) : null;
        if (!bytes || !bytes.byteLength) return Promise.reject(new Error('图片响应为空或格式无效'));
        // Imported snapshots do not retain Content-Type. SVG needs its MIME type
        // to decode from a Blob; raster image formats can be sniffed by the browser.
        let mime = String(contentType).split(';')[0].trim();
        const prefix = new TextDecoder().decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '').trimStart()
            .replace(/^(?:(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)\s*)+/i, '');
        if (/^<svg(?:\s|>)/i.test(prefix)) mime = 'image/svg+xml';
        return new Promise((resolve, reject) => {
            const image = new Image();
            let objectUrl = null;
            let settled = false;
            const timer = setTimeout(() => finish(new Error('图片解码超时')), Math.max(1, Math.min(Number(timeout) || 10000, 30000)));
            function finish(error) {
                if (settled) return;
                settled = true; clearTimeout(timer);
                image.onload = null; image.onerror = null;
                image.removeAttribute('src');
                if (objectUrl) URL.revokeObjectURL(objectUrl);
                if (error) reject(error); else resolve(buffer);
            }
            image.onerror = () => finish(new Error('图片数据无法解码，未标记为已下载'));
            image.onload = async () => {
                try {
                    if (typeof image.decode === 'function') await image.decode();
                    if (!image.naturalWidth || !image.naturalHeight) throw new Error('图片尺寸无效');
                    finish();
                } catch (_) { finish(new Error('图片数据无法解码，未标记为已下载')); }
            };
            try {
                objectUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
                image.src = objectUrl;
            } catch (_) { finish(new Error('无法创建图片解码资源')); }
        });
    }

    async function fetchImageBuffer(url) {
        const response = await fetchWithTimeout(url, {}, 30000);
        if (!response.ok) { const error = new Error('HTTP ' + response.status); error.status = response.status; throw error; }
        const type = response.headers && response.headers.get('content-type') || '';
        if (/text\/html|application\/json/i.test(type)) throw new Error('图片地址返回了网页或错误响应');
        const buffer = await response.arrayBuffer();
        try { return await validateImageBuffer(buffer, type); }
        catch (error) { error.status = response.status; throw error; }
    }

    function loadExternalScript(url, globalName, timeout = 20000) {
        if (window[globalName]) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            const timer = setTimeout(() => finish(new Error(`${globalName} 加载超时，请检查网络后重试。`)), timeout);
            function finish(error) {
                clearTimeout(timer); script.onload = null; script.onerror = null;
                if (error) { script.remove(); reject(error); } else resolve();
            }
            script.src = url;
            script.onload = () => finish(window[globalName] ? null : new Error(`${globalName} 未正确初始化。`));
            script.onerror = () => finish(new Error(`${globalName} 下载失败，请检查网络后重试。`));
            document.head.appendChild(script);
        });
    }

    async function ensureDependencies() {
        if (!dependencyPromise) dependencyPromise = loadExternalScript('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', 'JSZip').catch(error => { dependencyPromise = null; throw error; });
        await dependencyPromise;
    }

    async function runWithConcurrency(items, concurrency, task) {
        let index = 0;
        async function worker(workerId) {
            while (index < items.length && !globalState.isPaused) {
                const currentIndex = index++;
                try { await task(items[currentIndex], currentIndex, workerId); }
                catch (error) {
                    globalState.isPaused = true; globalState.lastError = error.message;
                    if (error.message === "ALL_KEYS_EXHAUSTED") {
                        globalState.outOfKeys = true;
                        addLog("API Key 不可用或持续限流。请更新 Key 后恢复。", "error");
                    } else if (error.message !== 'PAUSED') addLog(`Worker[${workerId}] 失败，已暂停以保留未完成任务：${error.message}`, "error");
                    updateGlobalProgress();
                }
            }
        }
        await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i + 1)));
    }

    function shuffleArray(array) { let arr = [...array]; for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; }
    function bufferToBase64(buffer) { let binary = ''; let bytes = new Uint8Array(buffer); for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]); return window.btoa(binary); }

    // 🌟 AI 纠错与解答核心引擎
    async function requestDeepSeek(systemPrompt, userPrompt, isThinking = false) {
        const maxAttempts = Math.min(Math.max(keyManager.getCount() * 2, 2), 10);
        let lastError;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (globalState.isPaused) throw new Error('PAUSED');
            const key = keyManager.getKey();
            if (!key) throw new Error("ALL_KEYS_EXHAUSTED");
            const payload = { model: isThinking ? "deepseek-v4-pro" : "deepseek-flash", thinking: { type: isThinking ? 'enabled' : 'disabled' }, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }], stream: false };
            if (isThinking) payload.reasoning_effort = "high";
            try {
                const response = await fetchWithTimeout("https://api.deepseek.com/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` }, body: JSON.stringify(payload) }, 120000);
                if (response.ok) {
                    const json = await response.json();
                    const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
                    if (typeof content !== 'string' || !content.trim()) throw new Error('AI 返回了空答案或无效响应。');
                    return content.replace(/^```[a-zA-Z]*\n?|\n?```$/g, "").trim();
                }
                if ([401, 402, 429].includes(response.status)) lastError = new Error('ALL_KEYS_EXHAUSTED');
                else if (response.status >= 500) lastError = new Error(`AI 服务暂时不可用 (HTTP ${response.status})。`);
                else throw new Error(`AI 请求被拒绝 (HTTP ${response.status})，请检查模型与请求配置。`);
            } catch (error) {
                if (/请求被拒绝|空答案|无效响应/.test(error.message)) throw error;
                lastError = error;
            }
            if (attempt + 1 < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw lastError || new Error('AI 请求失败。');
    }

    async function correctOcrText(rawText) {
        if (!rawText.trim() || keyManager.getCount() === 0) return rawText;
        let sys = `You are an OCR text correction engine. The following text was extracted from an image via Tesseract OCR and may contain typos, noise, or broken formatting.
Your task is to fix the errors and restore the original programming context and meaning.
STRICT RULES:
1. Output ONLY the corrected text.
2. NO markdown formatting.
3. You MUST prepend the following exact phrase at the very beginning of your output: "[Context: The following text is derived from OCR and has been cleaned, but may still contain minor inaccuracies. Please use it at your discretion.]\n"`;
        try { return await requestDeepSeek(sys, `Raw OCR Text:\n${rawText}`, false); }
        catch(e) { return rawText; }
    }

    async function askDeepSeekQA(text, questionType) {
        let isProgram = (questionType === "Program");
        // ✅ 优化：增加 Rule 6 拦截题干中伪造的“代码运行成功”执行提示
        let sys = `You are an expert Java programming system. Provide ONLY the final code or answer for the given question.
STRICT RULES:
1. Provide ONLY the raw text/code. DO NOT use Markdown formatting.
2. DO NOT include any code comments (no //, no /* */).
3. DO NOT use System.out.print() or System.out.println() for user input prompts. Read input silently.
4. Output MUST EXACTLY match the example output provided.
5. For fill-in-the-blank questions, carefully analyze exactly how many blanks need to be filled. Provide the correct answers in exact sequential order, separated ONLY by a single space. Do NOT include any extra words, decorations, bullet points, or numbering.
6. IGNORE execution hints in the problem description. DO NOT include fake success messages. Exclude statements like \`System.out.println("代码运行成功");\` or \`System.out.print("代码运行成功");\`.`;
        return await requestDeepSeek(sys, `Question:\n${text}`, isProgram);
    }

    async function ensureOcrWorker() {
        if (ocrWorker) return;
        if (!ocrWorkerPromise) ocrWorkerPromise = (async () => {
            try {
                await loadExternalScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js', 'Tesseract');
                let timer;
                try {
                    ocrWorker = await Promise.race([
                        Tesseract.createWorker('eng+chi_sim'),
                        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OCR 初始化超时')), 45000); })
                    ]);
                } finally { clearTimeout(timer); }
                addLog("OCR 识别引擎准备就绪。", "success");
            } catch (error) { addLog(`OCR 不可用：${error.message}。图片仍会保留。`, "warning"); }
        })();
        await ocrWorkerPromise;
    }

    // ==========================================
    // 4. UI 按钮绑定
    // ==========================================


    startBtn.addEventListener('click', async () => {
        if (engineRunning || startBtn.disabled) return;
        startBtn.disabled = true; pauseBtn.disabled = true;
        initActions.style.display = 'none'; apiKeyContainer.style.display = 'none'; runActions.style.display = 'flex';
        globalState.isPaused = false;
        try {
            initializePlatformVariables();
            addLog("加载 ZIP 引擎...", "info");
            await ensureDependencies();
            pauseBtn.disabled = false;
            await runEngine();
        } catch (error) {
            globalState.isPaused = true;
            addLog(`启动失败：${error.message}`, 'error');
            initActions.style.display = 'flex'; apiKeyContainer.style.display = 'block'; runActions.style.display = 'none';
        } finally { startBtn.disabled = false; pauseBtn.disabled = false; }
    });

    importBtn.addEventListener('click', () => { fileInput.click(); });

    fileInput.addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        if (engineRunning || startBtn.disabled || importBtn.disabled) { e.target.value = ""; return; }
        const previous = { state: {...globalState, listProgress: {...globalState.listProgress}}, allData, imageQueue, imgCounter,
            currentLang, currentDegree, currentChapter, currentKno, currentSearch, origin };
        startBtn.disabled = true; importBtn.disabled = true; pauseBtn.disabled = true;
        try {
            initializePlatformVariables(); initActions.style.display = 'none'; apiKeyContainer.style.display = 'none'; runActions.style.display = 'flex';
            addLog(`📂 正在解包断点记忆文件 [${file.name}]...`, "warning");
            await ensureDependencies();
            let loadedZip = await JSZip.loadAsync(file); let stateFile = loadedZip.file("state.json");
            if (!stateFile) throw new Error("压缩包内未找到 state.json，无法恢复");
            let stateText = await stateFile.async("string"); let stateObj = JSON.parse(stateText);
            validateSnapshot(stateObj);
            let restoredState = stateObj.globalState;
            if (!restoredState.scope && restoredState.stage === 1) throw new Error("旧版扫描断点未记录筛选条件，请重新开始提取，避免混入不同章节");
            restoredState.scope = restoredState.scope || globalState.scope;
            let restoredImages = new Map();
            for (let [url, data] of stateObj.imageQueueList) {
                let buffer = null;
                let imgFile = loadedZip.file("images/" + data.filename);
                if (imgFile) buffer = await imgFile.async("arraybuffer");
                if (buffer) {
                    try { await validateImageBuffer(buffer, /\.svg$/i.test(data.filename) ? 'image/svg+xml' : ''); }
                    catch (_) { buffer = null; addLog(`断点图片 ${data.filename} 无法解码，将重新下载。`, 'warning'); }
                }
                restoredImages.set(url, { filename: data.filename, downloaded: !!buffer, buffer, failed: false,
                    sourceUnavailable: !buffer && data.sourceUnavailable === true && [404, 410].includes(data.status),
                    status: buffer ? null : Number.isInteger(data.status) ? data.status : null,
                    originalUrl: url, alt: typeof data.alt === 'string' ? data.alt : '', error: buffer ? null : data.error || null });
                if (!buffer) restoredState.stage = Math.min(restoredState.stage, 4);
            }
            restorePlatformVariables(restoredState.scope, restoredState.stage);
            globalState = restoredState; globalState.isPaused = false; globalState.outOfKeys = false;
            globalState.elapsedSeconds = Number.isFinite(globalState.elapsedSeconds) ? globalState.elapsedSeconds : 0;
            allData = stateObj.allData; imgCounter = stateObj.imgCounter;
            imageQueue = restoredImages;
            for (const data of imageQueue.values()) imgCounter = Math.max(imgCounter, Number(data.filename.match(/^img_(\d+)/i)[1]) + 1);
            allData.forEach(item => {
                if (['Single', 'Multiple', 'TrueOrFalse'].includes(item.QuestionType) && item.s2_done) {
                    const detail = parser.parseFromString(String(item.DetailHtml || ''), 'text/html');
                    const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
                    const title = normalize(parser.parseFromString(String(item.Title || ''), 'text/html').body.textContent);
                    const panel = detail.querySelector('.panel');
                    const body = panel && panel.querySelector('.panel-body');
                    const choices = panel && panel.querySelector('ul.list-group');
                    const expectedHeading = `${PLATFORM_CONFIG.TYPES.find(type => type.type === item.QuestionType).name}练习`;
                    const retainedPlaceholder = globalState.scope.origin === window.location.origin &&
                        item.s2_done === true && typeof item.ExtractionWarning === 'string' && item.ExtractionWarning.trim() &&
                        item.NeedsAI === false && item.IsAIAnswer === false && item.AnswerSource === null && item.SniffedAnswer === '' &&
                        title && body && choices && !choices.children.length && !normalize(choices.textContent) &&
                        normalize(panel.querySelector('.panel-heading')?.textContent) === expectedHeading && normalize(body.textContent) === title;
                    const options = detail.querySelectorAll('input[type="radio"], input[type="checkbox"]');
                    if (item.s2_done !== true || detail.querySelector('input[type="password"]') || (!options.length && !retainedPlaceholder)) {
                        // Legacy versions marked login/error HTML as completed. Re-fetch official details instead of trusting that bit.
                        item.s2_done = false; item.s3_done = false; item.imgUrls = [];
                        for (const field of ['DetailHtml', 'SniffedAnswer', 'AnswerSource', 'IsAIAnswer', 'NeedsAI', 'ExtractionWarning']) delete item[field];
                        addLog(`断点题目 ${item.GlobalUID} 的客观题详情不可核验，将重新提取。`, 'warning');
                    }
                }
                if (item.QuestionType === 'Program' && item.s2_done && typeof item.PlainExample === 'string' && item.PlainExample.trim() && !item.AnswerSource) {
                    item.s2_done = false; item.s3_done = false;
                }
            });
            if (allData.some(item => !item.s2_done)) globalState.stage = Math.min(globalState.stage, 2);
            if (keyManager.getCount() > 0) {
                let unanswered = allData.filter(item => item.NeedsAI && !item.SniffedAnswer);
                unanswered.forEach(item => { item.s3_done = false; });
                if (unanswered.length) globalState.stage = Math.min(globalState.stage, 3);
            }
            updateTimerDisplay();

            addLog(`✅ 成功找回系统记忆！当前位于阶段：${globalState.stage}`, "success");
            addLog(`📊 统计数据：总题目 ${allData.length} | 已提取 ${allData.filter(i=>i.s2_done).length} | AI 已解答 ${allData.filter(i=>i.s3_done).length} | 图片记录 ${imageQueue.size}`, "scan");

            updateUI(1, `已恢复: ${allData.length} 题`, globalState.stage > 1);
            updateUI(2, `已恢复提取: ${allData.filter(i=>i.s2_done).length} 题`, globalState.stage > 2);
            updateUI(3, `已恢复解答: ${allData.filter(i=>i.s3_done).length} 题`, globalState.stage > 3);

            pauseBtn.disabled = false;
            await runEngine();
        } catch (err) {
            globalState = previous.state; allData = previous.allData; imageQueue = previous.imageQueue; imgCounter = previous.imgCounter;
            currentLang = previous.currentLang; currentDegree = previous.currentDegree; currentChapter = previous.currentChapter;
            currentKno = previous.currentKno; currentSearch = previous.currentSearch; origin = previous.origin;
            addLog(`❌ 解析 ZIP 异常: ${err.message}`, "error"); initActions.style.display = 'flex'; apiKeyContainer.style.display = 'block'; runActions.style.display = 'none';
        } finally {
            startBtn.disabled = false; importBtn.disabled = false; pauseBtn.disabled = false;
            e.target.value = "";
        }
    });

    function setPauseUI() {
        const button = document.getElementById('bistu-pause-btn');
        button.innerText = globalState.stage > 4 ? "▶️ 重试生成 ZIP" : "▶️ 恢复提取进度"; button.style.background = "#4db6ac";
        button.disabled = engineRunning; apiKeyContainer.style.display = 'block';
    }

    pauseBtn.addEventListener('click', () => {
        if (engineRunning) {
            if (!globalState.isPaused) {
                globalState.isPaused = true; pauseBtn.disabled = true;
                pauseBtn.innerText = "⚠️ 正在安全停止..."; pauseBtn.style.background = "#555";
                addLog("正在等待已发出的请求结束，然后保存断点。", "warning");
            }
            return;
        }
        if (!globalState.isPaused) return;
        const wasOutOfKeys = globalState.outOfKeys;
        keyManager.updateKeys(apiKeyInput.value.trim());
        if (wasOutOfKeys && !keyManager.getCount()) { globalState.outOfKeys = true; addLog("请填入可用的 API Key 后恢复。", 'warning'); return; }
        globalState.isPaused = false; globalState.lastError = null;
        pauseBtn.innerText = "⏸️ 暂停并生成防丢 ZIP"; pauseBtn.style.background = "#ef5350"; apiKeyContainer.style.display = 'none';
        const downloadButton = document.getElementById('bistu-download-btn');
        downloadButton.disabled = true; downloadButton.innerText = "🚧 处理中..."; downloadButton.style.background = "#444";
        runEngine();
    });

    // ==========================================
    // 5. 核心流程状态机 (支持断点)
    // ==========================================

    async function runStage1() {
        restorePlatformVariables(globalState.scope, 1);
        const taskTypes = globalState.scope.typeDefinitions;
        if (!globalState.sourceTotals || typeof globalState.sourceTotals !== 'object' || Array.isArray(globalState.sourceTotals)) globalState.sourceTotals = {};
        updateUI(1, "请求数据中...", false);
        const progress = globalState.listProgress;
        const seen = new Set(allData.map(item => `${item.QuestionType}:${item.TopicGuid}`));
        for (; progress.typeIndex < taskTypes.length; progress.typeIndex++) {
            if (globalState.isPaused) return;
            const type = taskTypes[progress.typeIndex];
            const getParam = pageIndex => ({ languageType: currentLang, strDegreeLevel: currentDegree, strChapter: currentChapter, strKnowledge: currentKno, questionType: type.id, search: currentSearch, pageIndex, pageSize: 10 });
            while (true) {
                if (globalState.isPaused) return;
                const pageIndex = progress.pageIndex;
                const response = await fetchSafe(PLATFORM_CONFIG.API.GET_LIST, 'post', getParam(pageIndex), 'json');
                const rawTotal = response && response.Total;
                const total = (typeof rawTotal === 'number' || (typeof rawTotal === 'string' && /^\d+$/.test(rawTotal))) ? Number(rawTotal) : NaN;
                // Some platform versions serialize an empty list as null.
                if (response && total === 0 && response.DataList === null) response.DataList = [];
                if (!response || !Array.isArray(response.DataList) || !Number.isInteger(total) || total < 0) throw new Error(`${type.name}第 ${pageIndex} 页响应无效；可能已退出登录。`);
                if (pageIndex === 1) {
                    progress.expectedTotal = total;
                    progress.totalPages = Math.ceil(total / 10);
                } else if (total !== progress.expectedTotal) throw new Error(`${type.name}题目总数在扫描期间改变，请重新开始以避免遗漏。`);
                const expectedLength = Math.max(0, Math.min(10, total - (pageIndex - 1) * 10));
                if (response.DataList.length !== expectedLength) throw new Error(`${type.name}第 ${pageIndex} 页不完整：应有 ${expectedLength} 题，实际 ${response.DataList.length} 题。`);
                const pageKeys = new Set();
                for (const item of response.DataList) {
                    const key = `${item.QuestionType}:${item.TopicGuid}`;
                    if (!item.TopicGuid || item.QuestionType !== type.type || seen.has(key) || pageKeys.has(key)) throw new Error(`${type.name}第 ${pageIndex} 页包含重复或无效题目，扫描已暂停。`);
                    pageKeys.add(key);
                }
                for (const item of response.DataList) {
                    item.GlobalUID = allData.length; item.s2_done = false; item.s3_done = false; item.imgUrls = [];
                    allData.push(item); seen.add(`${item.QuestionType}:${item.TopicGuid}`);
                }
                globalState.sourceTotals[type.type] = total;
                progress.pageIndex = pageIndex + 1;
                addLog(`[扫描] ${type.name}第 ${pageIndex}/${Math.max(progress.totalPages, 1)} 页，新增 ${response.DataList.length} 题。`, 'scan');
                updateUI(1, `已拉取: ${allData.length} 题`);
                if (progress.pageIndex > progress.totalPages) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            progress.pageIndex = 1; progress.totalPages = 0; progress.expectedTotal = null;
        }
        if (!globalState.isPaused) { globalState.stage = 2; updateUI(1, `共计 ${allData.length} 题`, true); }
    }

    function optionHtml(input, container) {
        const label = input.id && Array.from(container.querySelectorAll('label')).find(el => el.htmlFor === input.id);
        const node = (label || input.closest('label') || input.parentElement).cloneNode(true);
        node.querySelectorAll('input, button, script').forEach(el => el.remove());
        return node.innerHTML.trim();
    }

    function selectSrcsetImage(srcset) {
        const candidates = [];
        let position = 0;
        // Tokenize URL and descriptor separately: data URLs and URL query strings may contain commas.
        while (position < srcset.length) {
            while (position < srcset.length && /[\s,]/.test(srcset[position])) position++;
            if (position === srcset.length) break;
            const start = position;
            while (position < srcset.length && !/\s/.test(srcset[position])) position++;
            let url = srcset.slice(start, position);
            let descriptor = '';
            if (/,$/.test(url)) url = url.replace(/,+$/, '');
            else {
                const descriptorStart = position;
                while (position < srcset.length && srcset[position] !== ',') position++;
                descriptor = srcset.slice(descriptorStart, position).trim();
                if (position < srcset.length) position++;
            }
            const match = descriptor.match(/^(?:(\d+(?:\.\d+)?)(x)|(\d+)(w))$/);
            if (!url || (descriptor && !match)) throw new Error('图片 srcset 含无法可靠解析的候选，已停止以避免丢图。');
            const kind = match ? (match[2] || match[4]) : 'x';
            const size = match ? Number(match[1] || match[3]) : 1;
            if (!Number.isFinite(size) || size <= 0 || candidates.some(candidate => candidate.kind !== kind || candidate.size === size)) throw new Error('图片 srcset 的尺寸标记冲突，已停止以避免选错图片。');
            candidates.push({ url, kind, size });
        }
        if (!candidates.length) throw new Error('图片 srcset 为空，无法可靠选择图片。');
        return candidates.reduce((largest, candidate) => candidate.size > largest.size ? candidate : largest).url;
    }

    function assertSupportedRichResources(content, baseUrl) {
        const visible = node => {
            for (let current = node; current && current !== content; current = current.parentElement) {
                if (current.hasAttribute('hidden') || current.style?.display === 'none' || current.style?.visibility === 'hidden') return false;
            }
            return true;
        };
        const unsupported = kind => { throw new Error(`题目包含尚不支持完整离线保存的${kind}，已暂停；请先适配该资源，不能将此包视为完整题库。`); };
        for (const node of content.querySelectorAll('svg, math')) if (visible(node) && (node.children.length || node.textContent.trim())) unsupported(node.tagName.toLowerCase() === 'svg' ? '内嵌 SVG 图形' : 'MathML 公式');
        for (const node of content.querySelectorAll('video, audio')) {
            if (visible(node) && (node.getAttribute('src')?.trim() || Array.from(node.querySelectorAll('source[src]')).some(source => source.getAttribute('src').trim()) || node.getAttribute('poster')?.trim())) unsupported('音视频资源');
        }
        for (const node of content.querySelectorAll('iframe, object, embed')) {
            const resource = node.getAttribute('src') || node.getAttribute('data') || node.getAttribute('srcdoc');
            if (visible(node) && resource && resource.trim() && resource.trim() !== 'about:blank') unsupported('嵌入资源');
        }
        for (const node of content.querySelectorAll('[style], [background]')) {
            if (visible(node) && (/url\s*\(/i.test(node.style.backgroundImage || node.style.background || '') || node.getAttribute('background')?.trim())) unsupported('CSS/HTML 背景图片');
        }
        for (const node of content.querySelectorAll('a[href]')) {
            if (!visible(node)) continue;
            const href = node.getAttribute('href');
            if (!href || !href.trim() || href.trim().startsWith('#')) continue;
            let url;
            try { url = new URL(href, baseUrl); } catch (_) { continue; }
            const attachment = /\.(?:pdf|docx?|xlsx?|pptx?|odt|ods|odp|zip|rar|7z|tar|gz|txt|csv|java|py|cpp|jar|mp4|webm|mp3|wav)$/i.test(url.pathname);
            if (node.hasAttribute('download') || (['http:', 'https:'].includes(url.protocol) && attachment)) unsupported('附件链接');
        }
    }

    function localizeImages(html, item, baseUrl) {
        const content = parser.parseFromString(String(html || ''), 'text/html').body;
        assertSupportedRichResources(content, baseUrl);
        const firstValue = (...values) => values.map(value => String(value || '').trim()).find(Boolean) || '';
        for (const img of content.querySelectorAll('img')) {
            let rawSrc;
            const picture = img.parentElement?.tagName === 'PICTURE' ? img.parentElement : null;
            if (picture) {
                for (const source of picture.children) {
                    if (source === img) break;
                    if (source.tagName !== 'SOURCE') continue;
                    const media = source.getAttribute('media');
                    if (media && !window.matchMedia(media).matches) continue;
                    const type = (source.getAttribute('type') || '').toLowerCase();
                    if (type && !/^image\/(?:png|jpeg|gif|webp|bmp|avif|svg\+xml)$/.test(type)) continue;
                    const sourceSet = firstValue(source.getAttribute('data-srcset'), source.getAttribute('srcset'));
                    if (sourceSet && sourceSet.trim()) { rawSrc = selectSrcsetImage(sourceSet); break; }
                }
            }
            const srcset = firstValue(img.getAttribute('data-srcset'), img.getAttribute('srcset'));
            if (!rawSrc && srcset && srcset.trim()) rawSrc = selectSrcsetImage(srcset);
            if (!rawSrc) rawSrc = firstValue(img.getAttribute('data-src'), img.getAttribute('src'));
            for (const attribute of ['srcset', 'data-srcset', 'data-src', 'onerror', 'onload']) img.removeAttribute(attribute);
            if (!rawSrc || !rawSrc.trim()) continue;
            rawSrc = rawSrc.trim();
            if (/^data:/i.test(rawSrc)) {
                if (!/^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i.test(rawSrc)) throw new Error('题目包含尚不支持的内嵌图片格式，已暂停以避免离线丢图。');
                img.setAttribute('src', rawSrc);
                continue;
            }
            const url = new URL(rawSrc, baseUrl);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('题目图片地址协议不支持离线下载，已暂停以避免丢图。');
            const absoluteUrl = url.href;
            if (!item.imgUrls.includes(absoluteUrl)) item.imgUrls.push(absoluteUrl);
            if (!imageQueue.has(absoluteUrl)) {
                const ext = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.exec(url.pathname)?.[1].toLowerCase() || 'png';
                imageQueue.set(absoluteUrl, { filename: `img_${imgCounter++}.${ext}`, buffer: null, downloaded: false, failed: false,
                    sourceUnavailable: false, status: null, originalUrl: absoluteUrl, alt: img.getAttribute('alt') || '' });
            }
            if (!imageQueue.get(absoluteUrl).alt && img.getAttribute('alt')) imageQueue.get(absoluteUrl).alt = img.getAttribute('alt');
            img.setAttribute('src', `images/${imageQueue.get(absoluteUrl).filename}`);
            img.setAttribute('data-original', absoluteUrl);
        }
        // A retained <source> could override the localized <img> when the output is opened.
        content.querySelectorAll('picture > source').forEach(source => source.remove());
        return content.innerHTML;
    }

    function isKnownEmptyChoiceQuestion(doc, item) {
        const typeName = PLATFORM_CONFIG.TYPES.find(type => type.type === item.QuestionType)?.name;
        const normalize = value => String(value || '').replace(/\s+/g, ' ').trim();
        const title = normalize(parser.parseFromString(String(item.Title || ''), 'text/html').body.textContent);
        const body = doc.querySelector('.panel-body');
        const list = doc.querySelector('ul.list-group');
        const guid = doc.querySelector('#hidden_TopicGuid');
        return !!(title && body && list && guid && !list.children.length && !normalize(list.textContent) &&
            normalize(doc.title) === `${typeName}练习` && normalize(doc.querySelector('.panel-heading')?.textContent) === `${typeName}练习` &&
            normalize(body.textContent) === title && (!guid.value || guid.value.toLowerCase() === String(item.TopicGuid).toLowerCase()) &&
            !doc.querySelector('input[type="password"]'));
    }

    async function runStage2() {
        const itemsToProcess = allData.filter(item => !item.s2_done);
        if (!itemsToProcess.length) {
            updateUI(2, '提取完成', true);
            if (!globalState.isPaused) globalState.stage = 3;
            return;
        }
        updateUI(2, '处理中...');
        addLog('[提取] 启动 3 个并发任务；客观题答案验证会向平台提交练习答案。', 'info');
        await runWithConcurrency(itemsToProcess, 3, async (item, _, workerId) => {
            let htmlContent = '';
            delete item.ExtractionWarning;
            const detailUrl = new URL(PLATFORM_CONFIG.API.GET_DETAIL(item.QuestionType, encodeURIComponent(item.TopicGuid)), origin).href;
            if (item.QuestionType === 'Program' || item.QuestionType === 'Blank') {
                htmlContent = `<div style="font-size:16px; font-weight:bold;">${item.Title || ''}</div>`;
                if (item.Requirement) htmlContent += `<div class="requirement-box"><b>要求:</b><br>${item.Requirement}</div>`;
                if (!item.Title && !item.Requirement) throw new Error(`题目 ${item.GlobalUID} 的题干为空，已停止以便重试。`);
                if (item.QuestionType === 'Program' && typeof item.PlainExample === 'string' && item.PlainExample.trim()) {
                    item.SniffedAnswer = item.PlainExample;
                    item.AnswerSource = 'platform-reference';
                    item.IsAIAnswer = false;
                    item.NeedsAI = false;
                } else item.NeedsAI = true;
            } else {
                const htmlRaw = await fetchSafe(detailUrl, 'get', null, 'html');
                const doc = parser.parseFromString(htmlRaw || '', 'text/html');
                const container = doc.querySelector('form') || doc.querySelector('.container') || doc.body;
                const inputs = Array.from(container.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
                const placeholder = !inputs.length && isKnownEmptyChoiceQuestion(doc, item);
                if ((!inputs.length && !placeholder) || doc.querySelector('input[type="password"]')) {
                    throw new Error(`题目 ${item.GlobalUID} 详情缺少选项，可能登录已过期或页面结构改变。`);
                }
                const guidInput = container.querySelector('input[name="Guid"]');
                if (guidInput && guidInput.value.toLowerCase() !== String(item.TopicGuid).toLowerCase()) {
                    throw new Error(`题目 ${item.GlobalUID} 详情标识不匹配。`);
                }
                const endpoint = PLATFORM_CONFIG.API.SUBMIT_ANSWER(item.QuestionType);
                let candidates;
                if (item.QuestionType === 'Multiple') {
                    if (inputs.length > 8) {
                        candidates = [];
                        addLog(`[Worker ${workerId}] 多选题超过 8 个选项，跳过指数级枚举，保留题目供后续解答。`, 'warning');
                    } else {
                        candidates = shuffleArray(inputs.reduce((sets, input) => sets.concat(sets.map(set => [...set, input])), [[]]).filter(set => set.length));
                    }
                } else {
                    candidates = shuffleArray(inputs).map(input => [input]);
                }
                let answer = '';
                for (const choices of candidates) {
                    if (globalState.isPaused) return;
                    // An array of name/value entries preserves repeated UserSelect fields and encodes special characters.
                    const payload = [{ name: 'Guid', value: item.TopicGuid }, ...choices.map(input => ({ name: 'UserSelect', value: input.value }))];
                    const result = await fetchSafe(endpoint, 'post', payload, 'json');
                    if (!result || typeof result.Result !== 'boolean') throw new Error(`题目 ${item.GlobalUID} 答案验证响应无效。`);
                    if (result.Result) { answer = choices.map(input => optionHtml(input, container)).join(' <b>|</b> '); break; }
                }
                item.SniffedAnswer = answer;
                item.IsAIAnswer = false;
                item.AnswerSource = answer ? 'platform-verified' : null;
                item.NeedsAI = !answer && !placeholder;
                if (placeholder) {
                    item.ExtractionWarning = '平台本题未提供选项，已保留原文；无可验证的答案。';
                    addLog(`[Worker ${workerId}] 题目 ${item.GlobalUID} 在平台上无选项，保留原文并继续。`, 'warning');
                } else if (!answer) {
                    item.ExtractionWarning = candidates.length
                        ? '平台未将任何现有选项判为正确；已保留题目与全部选项，未取得平台验证答案。'
                        : '本题超过组合验证的选项数量上限；已保留全部选项，未验证答案。';
                    addLog(`[Worker ${workerId}] 题目 ${item.GlobalUID}：${item.ExtractionWarning}`, 'warning');
                }
                container.querySelectorAll('script, button, input[type="hidden"], input[type="button"], input[type="submit"], a.btn').forEach(el => el.remove());
                htmlContent = container.innerHTML;
            }
            if (globalState.isPaused) return;
            item.imgUrls = [];
            item.DetailHtml = localizeImages(htmlContent, item, detailUrl);
            if (item.SniffedAnswer && !item.IsAIAnswer && item.AnswerSource !== 'platform-reference') item.SniffedAnswer = localizeImages(item.SniffedAnswer, item, detailUrl);
            item.s2_done = true;
            updateUI(2, `已处理: ${allData.filter(row => row.s2_done).length} 题`);
            await yieldThread();
        });
        if (!globalState.isPaused) {
            if (allData.some(item => !item.s2_done)) throw new Error('仍有题目未成功提取，请恢复重试。');
            updateUI(2, '题干与选项提取完成', true);
            globalState.stage = 3;
            addLog(`✅ 阶段二完毕：共 ${allData.length} 道题，${imageQueue.size} 张待下载图片。`, 'success');
        }
    }


    async function runStage3() {
        let aiItems = allData.filter(i => i.NeedsAI && !i.s3_done);
        if (aiItems.length === 0 || keyManager.getCount() === 0) {
            updateUI(3, keyManager.getCount() > 0 ? `解答完成` : `无 Key，保留题目并跳过 AI`, true);
            if(!globalState.isPaused) { globalState.stage = 4; if(keyManager.getCount() === 0) addLog("⚠️ 未配置 API Key，已跳过阶段三 (AI大模型推导)。", "warning"); }
            return;
        }

        if (aiItems.some(item => item.imgUrls && item.imgUrls.length)) await ensureOcrWorker();
        if (globalState.isPaused) return;
        let aiConcurrency = Math.min(Math.max(keyManager.getCount() * 2, 1), 4);
        addLog(`[AI总控] 启动图文多模态推理阵列，并发线程: ${aiConcurrency}，等待推导: ${aiItems.length} 题...`, "ai"); updateUI(3, `AI 并发答题中...`);

        await runWithConcurrency(aiItems, aiConcurrency, async (item, _, workerId) => {
            let tempDoc = parser.parseFromString(item.DetailHtml || '', 'text/html').body; let pureText = tempDoc.textContent || tempDoc.innerText || "";
            let combinedOcr = "";
            for (let url of (item.imgUrls || [])) {
                if (globalState.isPaused) return; let qData = imageQueue.get(url);
                if (qData && !qData.buffer) qData.buffer = await fetchImageBuffer(url);
                if (qData && qData.buffer && ocrWorker) {
                    addLog(`[Worker ${workerId}] OCR 正在剥离图片内容...`, "image");
                    try { let base64 = "data:image/png;base64," + bufferToBase64(qData.buffer); const ret = await ocrWorker.recognize(base64); if (ret && ret.data && ret.data.text) { let textClean = ret.data.text.trim(); if(textClean) combinedOcr += "\n" + textClean; addLog(`[Worker ${workerId}] OCR 初步识别到: ${textClean.substring(0,30)}...`, "info"); } } catch (e) { addLog(`[Worker ${workerId}] OCR 识别崩溃跳过`, "error"); }
                }
            }

            if (combinedOcr.trim()) { addLog(`[Worker ${workerId}] 🧠 触发 AI 视觉清洗：尝试修正 OCR 中的字符乱码和格式...`, "ai"); let cleanOcr = await correctOcrText(combinedOcr); pureText += `\n\n${cleanOcr}`; }
            if (globalState.isPaused) return; let displayTitle = item.Title ? item.Title.replace(/\n/g,"").substring(0, 15) : "Unknown Topic"; addLog(`[Worker ${workerId}] 🚀 呼叫 DeepSeek: 《${displayTitle}...》 (推导中...)`, "ai");
            let startTime = Date.now(); item.SniffedAnswer = await askDeepSeekQA(pureText, item.QuestionType); let timeCost = ((Date.now() - startTime)/1000).toFixed(1);
            item.IsAIAnswer = true; item.s3_done = true; addLog(`[Worker ${workerId}] ✅ AI 返回结果 (耗时 ${timeCost}s): 成功攻克！`, "success");
            updateUI(3, `已解答: ${allData.filter(i => i.NeedsAI && i.s3_done).length} 题`); await yieldThread();
        });

        if (!globalState.isPaused) { updateUI(3, `解答完成`, true); globalState.stage = 4; addLog("==================================", "success"); addLog(`✅ 阶段三完毕：所有待解题目的 AI 辅助推理完成。`, "success"); addLog("==================================", "success"); }
    }

    async function runStage4() {
        const images = Array.from(imageQueue.entries()).filter(([, data]) => !data.downloaded || !data.buffer);
        if (!images.length) { if (!globalState.isPaused) { globalState.stage = 5; updateUI(4, '下载完毕', true); } return; }
        updateUI(4, `待下载: ${images.length} 张`);
        await runWithConcurrency(images, 3, async ([url, data], _, workerId) => {
            data.originalUrl = url;
            if (data.buffer) { data.downloaded = true; data.failed = false; data.sourceUnavailable = false; data.status = null; data.error = null; return; }
            let lastError;
            const statuses = [];
            for (let attempt = 0; attempt < 3; attempt++) {
                if (globalState.isPaused) return;
                try {
                    const buffer = await fetchImageBuffer(url);
                    data.buffer = buffer; data.downloaded = true; data.failed = false;
                    data.sourceUnavailable = false; data.status = null; data.error = null;
                    addLog(`[Worker ${workerId}] 图片已保存: ${data.filename}`, 'success');
                    updateUI(4, `待处理: ${Array.from(imageQueue.values()).filter(image => !image.downloaded && !image.sourceUnavailable && !image.failed).length} 张`);
                    return;
                } catch (error) {
                    lastError = error;
                    statuses.push(Number.isInteger(error.status) ? error.status : null);
                    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            if (globalState.isPaused) return;
            data.downloaded = false; data.buffer = null;
            data.status = statuses[statuses.length - 1]; data.error = lastError.message;
            data.sourceUnavailable = statuses.length === 3 && statuses.every(status => status === 404 || status === 410);
            data.failed = !data.sourceUnavailable;
            addLog(data.sourceUnavailable ? `源站图片 ${data.filename} 连续返回 HTTP ${data.status}，保留原链接与缺图记录。` :
                `图片 ${data.filename} 暂未获取 (${lastError.message})；继续处理其它图片，结束后可恢复重试。`, 'warning');
            updateUI(4, `待处理: ${Array.from(imageQueue.values()).filter(image => !image.downloaded && !image.sourceUnavailable && !image.failed).length} 张`);
        });
        if (globalState.isPaused) return;
        const temporaryFailures = Array.from(imageQueue.values()).filter(image => !image.buffer && image.failed && !image.sourceUnavailable);
        if (temporaryFailures.length) {
            globalState.isPaused = true;
            globalState.lastError = `${temporaryFailures.length} 张图片遇到临时网络或解码错误。其余图片已处理；恢复后重试未保存图片。`;
            addLog(globalState.lastError, 'error'); updateUI(4, `临时失败: ${temporaryFailures.length} 张，等待重试`);
            return;
        }
        const unavailable = Array.from(imageQueue.values()).filter(image => image.sourceUnavailable && !image.buffer).length;
        globalState.stage = 5;
        updateUI(4, unavailable ? `图片核对结束；源站不可用 ${unavailable} 张（见提取报告）` : '图片下载完毕', true);
    }

    // ==========================================
    // 6. 动态生成 ZIP (包含图片防破兜底)
    // ==========================================

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[char]));
    }

    function validateSnapshot(snapshot) {
        const state = snapshot && snapshot.globalState;
        const progress = state && state.listProgress;
        if (!state || !Number.isInteger(state.stage) || state.stage < 1 || state.stage > 5 ||
            !progress || !Number.isInteger(progress.typeIndex) || progress.typeIndex < 0 || progress.typeIndex > PLATFORM_CONFIG.TYPES.length ||
            !Number.isInteger(progress.pageIndex) || progress.pageIndex < 1 ||
            !Number.isInteger(progress.totalPages) || progress.totalPages < 0 ||
            !Array.isArray(snapshot.allData) || !Array.isArray(snapshot.imageQueueList) ||
            !Number.isInteger(snapshot.imgCounter) || snapshot.imgCounter < 1 ||
            (snapshot.schemaVersion !== undefined && snapshot.schemaVersion !== 1)) {
            throw new Error('断点数据结构或版本无效');
        }
        const knownTypes = new Set(PLATFORM_CONFIG.TYPES.map(type => type.type));
        const ids = new Set();
        for (const item of snapshot.allData) {
            if (!item || !knownTypes.has(item.QuestionType) || !Number.isInteger(item.GlobalUID) || item.GlobalUID < 0 || item.GlobalUID >= snapshot.allData.length || ids.has(item.GlobalUID)) {
                throw new Error('断点题目数据无效或编号重复');
            }
            ids.add(item.GlobalUID);
        }
        const filenames = new Set();
        const urls = new Set();
        for (const entry of snapshot.imageQueueList) {
            if (!Array.isArray(entry) || entry.length !== 2) throw new Error('断点图片队列无效');
            const [url, data] = entry;
            let parsedUrl;
            try { parsedUrl = new URL(url, state.scope?.origin || origin); } catch (_) { throw new Error('断点图片地址无效'); }
            if (typeof url !== 'string' || !['http:', 'https:'].includes(parsedUrl.protocol) || !data ||
                typeof data.filename !== 'string' || !/^img_\d+\.[a-z0-9]{1,8}$/i.test(data.filename) ||
                filenames.has(data.filename) || urls.has(url)) throw new Error('断点图片记录无效');
            filenames.add(data.filename); urls.add(url);
        }
    }

    // Course HTML and imported snapshots are data, never executable page code.
    function sanitizeOfflineHtml(rawHtml, baseUrl = origin) {
        const doc = parser.parseFromString(String(rawHtml || ''), 'text/html');
        doc.querySelectorAll('script,style,iframe,frame,object,embed,link,meta,base,svg,math,template,noscript').forEach(node => node.remove());
        const tags = new Set('DIV SPAN P BR B STRONG EM I U S SUB SUP PRE CODE BLOCKQUOTE UL OL LI TABLE THEAD TBODY TFOOT TR TD TH CAPTION H1 H2 H3 H4 H5 H6 HR IMG A LABEL INPUT'.split(' '));
        const attrs = new Set(['title', 'alt', 'colspan', 'rowspan', 'width', 'height']);
        const safeUrl = value => {
            try { const url = new URL(value, baseUrl); return ['http:', 'https:'].includes(url.protocol) ? url.href : ''; } catch (_) { return ''; }
        };
        for (const node of Array.from(doc.body.querySelectorAll('*'))) {
            if (!tags.has(node.tagName)) { node.replaceWith(...node.childNodes); continue; }
            const src = node.getAttribute('src') || '';
            const original = node.getAttribute('data-original') || src;
            const href = node.getAttribute('href');
            const type = node.getAttribute('type');
            const checked = node.hasAttribute('checked');
            const safeClasses = Array.from(node.classList).filter(value => ['requirement-box', 'img-failed'].includes(value));
            const style = node.style;
            const safeStyles = [];
            for (let index = 0; index < style.length; index++) {
                const property = style[index]; const value = style.getPropertyValue(property);
                if (/^(color|background-color|font-(size|family|weight|style)|text-(align|decoration)|white-space|vertical-align|border(-[a-z-]+)?|margin(-[a-z]+)?|padding(-[a-z]+)?|width|height|max-width|min-width|list-style-type)$/.test(property) &&
                    !/url|expression|var\(|\\/i.test(value) && /^[\w\s#(),.%+\-/"']+$/.test(value)) safeStyles.push(`${property}:${value}`);
            }
            for (const attr of Array.from(node.attributes)) if (!attrs.has(attr.name)) node.removeAttribute(attr.name);
            if (safeClasses.length) node.className = safeClasses.join(' ');
            if (safeStyles.length) node.setAttribute('style', safeStyles.join(';'));
            if (node.tagName === 'INPUT') {
                if (type !== 'radio' && type !== 'checkbox') { node.remove(); continue; }
                node.setAttribute('type', type); node.setAttribute('disabled', '');
                if (checked) node.setAttribute('checked', '');
            }
            if (node.tagName === 'A') {
                const link = href && safeUrl(href);
                if (link) { node.setAttribute('href', link); node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
            }
            if (node.tagName === 'IMG') {
                const originalUrl = safeUrl(original);
                const knownImage = imageQueue.has(originalUrl) ? [originalUrl, imageQueue.get(originalUrl)] : Array.from(imageQueue.entries()).find(([, data]) => src === `images/${data.filename}`);
                if (knownImage && knownImage[1].sourceUnavailable) {
                    const data = knownImage[1];
                    const placeholder = doc.createElement('div');
                    placeholder.className = 'img-failed source-image-unavailable';
                    placeholder.setAttribute('data-source-unavailable', 'true');
                    const status = Number(data.status);
                    if (Number.isInteger(status)) placeholder.setAttribute('data-source-status', String(status));
                    const heading = doc.createElement('strong');
                    heading.textContent = `平台原图不可用${status === 404 || status === 410 ? `（HTTP ${status}）` : ''}`;
                    placeholder.append(heading);
                    const explanation = doc.createElement('div');
                    explanation.textContent = '提取时原地址已无法提供图片，离线包无法恢复这部分图像内容。';
                    placeholder.append(explanation);
                    const alt = node.getAttribute('alt') || data.alt;
                    const title = node.getAttribute('title');
                    if (alt) { const description = doc.createElement('div'); description.textContent = `图片说明：${alt}`; placeholder.append(description); }
                    if (title && title !== alt) { const description = doc.createElement('div'); description.textContent = `图片标题：${title}`; placeholder.append(description); }
                    const sourceUrl = safeUrl(data.originalUrl || knownImage[0]);
                    if (sourceUrl) { const anchor = doc.createElement('a'); anchor.href = sourceUrl; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.textContent = '联网查看原图'; placeholder.append(anchor); }
                    node.replaceWith(placeholder);
                    continue;
                }
                if (/^images\/img_\d+\.[a-z0-9]{1,8}$/i.test(src) || /^data:image\/(png|jpe?g|gif|webp|bmp|avif);base64,[a-z0-9+/=\s]+$/i.test(src)) {
                    node.setAttribute('src', src);
                    const originalUrl = safeUrl(original);
                    if (originalUrl) node.setAttribute('data-original', originalUrl);
                } else {
                    const placeholder = doc.createElement('div'); placeholder.className = 'img-failed';
                    placeholder.textContent = '⚠️ 此图片尚未保存到离线包。';
                    const link = safeUrl(original);
                    if (link) {
                        const anchor = doc.createElement('a'); anchor.href = link; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
                        anchor.textContent = '联网查看原图'; placeholder.append(' ', anchor);
                    }
                    node.replaceWith(placeholder);
                }
            }
        }
        return doc.body.innerHTML;
    }

    function generateExtractionReport(isFinal) {
        const types = globalState.scope?.typeDefinitions || PLATFORM_CONFIG.TYPES;
        const byType = types.map(type => {
            const rows = allData.filter(item => item.QuestionType === type.type);
            const expected = globalState.sourceTotals?.[type.type];
            return { type: type.type, name: type.name, expected: Number.isInteger(expected) ? expected : null,
                collected: rows.length, details: rows.filter(item => item.s2_done).length,
                verifiedAnswers: rows.filter(item => item.SniffedAnswer && !item.IsAIAnswer && item.AnswerSource !== 'platform-reference' && ['Single','Multiple','TrueOrFalse'].includes(item.QuestionType)).length,
                referencePrograms: rows.filter(item => item.AnswerSource === 'platform-reference' && item.SniffedAnswer).length,
                aiAnswers: rows.filter(item => item.IsAIAnswer && item.SniffedAnswer).length,
                platformContentNotices: rows.filter(item => item.ExtractionWarning).length };
        });
        const images = Array.from(imageQueue.values());
        const included = images.filter(item => item.buffer && item.buffer.byteLength).length;
        const missingAtSource = Array.from(imageQueue.entries()).filter(([, item]) => item.sourceUnavailable && !item.buffer)
            .map(([url, item]) => ({ filename: item.filename, originalUrl: url, status: item.status, alt: item.alt || '' }));
        const duplicateIds = allData.length - new Set(allData.map(item => `${item.QuestionType}:${item.TopicGuid}`)).size;
        return { schemaVersion: 1, exporterVersion: SCRIPT_VERSION, generatedAt: new Date().toISOString(),
            complete: !!isFinal, imagesComplete: included === images.length, source: globalState.sourceMetadata || null, scope: globalState.scope || null,
            byType, totalQuestions: allData.length, duplicateIds,
            images: { expected: images.length, included, failed: images.filter(item => item.failed && !item.sourceUnavailable).length,
                sourceUnavailable: missingAtSource.length,
                pending: images.filter(item => !item.buffer && !item.failed && !item.sourceUnavailable).length, missingAtSource },
            notes: ['题型总数来自本次平台列表响应；未知旧断点数量记为 null。', '平台参考程序未执行验证；平台未提供选项的条目保留原文。',
                'complete 表示采集流程结束；imagesComplete 才表示全部原图已保存。源站连续返回 404/410 的图片保留缺失记录，不视作下载成功。'] };
    }

    async function buildZipAndDownload(isFinal = false) {
        addLog(isFinal ? "⚙️ 全流程结束，正在封装最终离线网页和二进制图片..." : "⚙️ 正在生成【安全状态快照断点包】...", "warning");
        let zipArch = new JSZip(); let iFolder = zipArch.folder("images");
        for (let imgData of imageQueue.values()) { if (imgData.filename && imgData.buffer) iFolder.file(imgData.filename, imgData.buffer); }

        let stateObj = { schemaVersion: 1, globalState: globalState, allData: allData, imgCounter: imgCounter, imageQueueList: Array.from(imageQueue.entries()).map(([url, data]) => [url, {
            filename: data.filename, downloaded: !!data.buffer, failed: !!data.failed, sourceUnavailable: !!data.sourceUnavailable,
            status: data.status ?? null, originalUrl: url, alt: data.alt || '', error: data.error || null }]) };
        zipArch.file("state.json", JSON.stringify(stateObj));
        zipArch.file("extraction-report.json", JSON.stringify(generateExtractionReport(isFinal), null, 2));

        let html = generateOfflineHtml(isFinal);
        zipArch.file("index.html", html);
        let finalZipBlob = await zipArch.generateAsync({type:"blob"});

        setPauseUI();
        let pBtn = document.getElementById('bistu-pause-btn'); if (isFinal) pBtn.style.display = "none";

        let currentDownloadBtn = document.getElementById('bistu-download-btn'); let newDownloadBtn = currentDownloadBtn.cloneNode(true); currentDownloadBtn.replaceWith(newDownloadBtn);
        newDownloadBtn.innerText = "💾 点击保存提取产物 (ZIP)"; newDownloadBtn.style.background = "#087f68"; newDownloadBtn.style.color = "white"; newDownloadBtn.style.cursor = "pointer"; newDownloadBtn.disabled = false;

        newDownloadBtn.addEventListener('click', () => {
            let a = document.createElement("a"); a.href = URL.createObjectURL(finalZipBlob); let timeStr = getFormattedTime();
            a.download = isFinal ? `[已完成]Java离线题库_${timeStr}.zip` : `[未完成_断点${allData.length}题]Java离线题库_${timeStr}.zip`;
            a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); addLog(`🎊 下载指令已触发！文件名: ${a.download}`, "success");
            if (!isFinal) { newDownloadBtn.disabled = true; newDownloadBtn.innerText = "🚧 待续传..."; newDownloadBtn.style.background = "#444"; newDownloadBtn.style.cursor = "not-allowed"; }
            else { newDownloadBtn.innerText = "✅ 继续下载产物"; addLog("✨ 所有工作已圆满完成！面板将永久驻留，随时可点击上方按钮再次下载。", "info"); }
        });
        addLog("🔔 ZIP 文件数据块流生成完毕，请点击上方的绿色按钮保存到本地！", "success");
    }

    function generateOfflineHtml(isFinal) {
        const chapters = [...new Set(allData.map(item => item.ChapterName || '未分类'))].sort();
        const difficulties = [...new Set(allData.map(item => item.DegreeLevel || '无'))].sort();
        const warningCount = allData.filter(item => item.ExtractionWarning).length;
        const referenceCount = allData.filter(item => item.QuestionType === 'Program' && item.AnswerSource === 'platform-reference' && item.SniffedAnswer).length;
        const validatedCount = allData.filter(item => ['Single', 'Multiple', 'TrueOrFalse'].includes(item.QuestionType) && item.SniffedAnswer && !item.IsAIAnswer && item.AnswerSource !== 'platform-reference').length;
        const aiCount = allData.filter(item => item.IsAIAnswer && item.SniffedAnswer).length;
        const imageRecords = Array.from(imageQueue.values());
        const unavailableImages = imageRecords.filter(image => image.sourceUnavailable).length;
        const savedImages = imageRecords.filter(image => image.buffer).length;
        const pendingImages = imageRecords.filter(image => !image.buffer && !image.sourceUnavailable).length;
        const typeNames = {Single:'单选题', Multiple:'多选题', TrueOrFalse:'判断题', Blank:'填空题', Program:'程序题'};
        const optionList = values => values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('');
        const cards = [...allData].sort((a, b) => a.GlobalUID - b.GlobalUID).map((item, index) => {
            const typeName = typeNames[item.QuestionType] || '未知题型';
            const chapter = item.ChapterName || '未分类';
            const difficulty = item.DegreeLevel || '无';
            const reference = item.QuestionType === 'Program' && item.AnswerSource === 'platform-reference' && !!item.SniffedAnswer;
            const hasAnswer = !!item.SniffedAnswer;
            const missingQuestionImages = (item.imgUrls || []).filter(url => imageQueue.get(url)?.sourceUnavailable).length;
            const sourceLabel = reference ? '平台参考程序' : item.IsAIAnswer && hasAnswer ? 'AI 解答' : hasAnswer ? '平台校验答案' : item.ExtractionWarning ? '提取提醒' : '尚无答案';
            const sourceClass = item.ExtractionWarning ? 'source-warning' : reference ? 'source-reference' : item.IsAIAnswer && hasAnswer ? 'source-ai' : hasAnswer ? 'source-verified' : 'source-pending';
            let displayHtml = item.DetailHtml;
            if (!displayHtml || displayHtml.length < 10) displayHtml = `<div>${item.Title || '尚未加载详情即被中断'}</div>`;
            let answer = '';
            if (hasAnswer) {
                const heading = reference ? '平台返回的参考程序（未运行验证）' : item.IsAIAnswer ? 'AI 辅助解答（请自行核对）' : '平台校验的选项答案';
                const content = item.QuestionType === 'Program'
                    ? `<div class="code-container"><span class="code-language" aria-hidden="true">JAVA</span><pre class="code-box answer-content" tabindex="0"><code>${escapeHtml(item.SniffedAnswer).replace(/\r/g, '&#13;')}</code></pre><button type="button" class="copy-btn" aria-label="复制第 ${index + 1} 题的程序">一键复制</button></div>`
                    : `<div class="answer-content${item.IsAIAnswer ? ' plain-answer' : ''}">${item.IsAIAnswer ? escapeHtml(item.SniffedAnswer) : sanitizeOfflineHtml(item.SniffedAnswer)}</div>`;
                answer = `<div class="answer-section"><div class="answer-actions"><span class="answer-caption">答案与参考</span><button type="button" class="answer-toggle" aria-expanded="true" aria-controls="answer-${index}">隐藏答案</button></div><div id="answer-${index}" class="answer-box answer-area${reference ? ' reference-answer' : item.IsAIAnswer ? ' ai-answer' : ''}"><div class="answer-heading">${heading}</div>${content}</div></div>`;
            } else if (!item.ExtractionWarning) {
                answer = `<div class="answer-status">题目已保留，尚无参考答案。</div>`;
            }
            return `<article class="topic topic-item" data-source="${escapeHtml(chapter)}" data-type="${escapeHtml(item.QuestionType)}" data-diff="${escapeHtml(difficulty)}" aria-label="第 ${index + 1} 题，${typeName}"><div class="question-head"><div class="question-ident"><span class="question-number">${String(index + 1).padStart(3, '0')}</span><span class="type-pill">${typeName}</span><span class="difficulty meta">${escapeHtml(difficulty)}</span></div><span class="answer-source ${sourceClass}">${sourceLabel}</span></div><div class="question-meta"><span class="meta-label">章节</span> <span class="meta">${escapeHtml(chapter)}</span></div><div class="detail-box topic-body">${sanitizeOfflineHtml(displayHtml)}</div>${item.ExtractionWarning ? `<div class="extraction-warning" role="note"><strong>提取提醒</strong><span>${escapeHtml(item.ExtractionWarning)}</span></div>` : ''}${missingQuestionImages ? `<div class="question-image-warning" role="note">本题有 ${missingQuestionImages} 张平台原图不可用，图像内容不完整；隐藏答案不会隐藏此提醒。</div>` : ''}${answer}</article>`;
        }).join('');
        return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'"><title>Java 离线题库</title><style>${offlineViewerStyles()}</style></head>
<body><a class="skip-link" href="#keywordFilter">跳到搜索</a><header class="site-header"><div class="brand"><span class="brand-mark" aria-hidden="true">J</span><div><p class="eyebrow">离线学习空间</p><h1>Java 题库</h1></div></div><div class="header-tools"><span class="offline-status">已保存到本地</span><label class="theme-label"><span class="sr-only">显示主题</span><select id="themeToggle"><option value="auto">跟随系统</option><option value="light">浅色模式</option><option value="dark">深色模式</option></select></label></div></header>
<div class="app-layout"><aside class="sidebar" aria-label="题目筛选"><details id="filterDetails" class="filter-panel" open><summary><span>筛选题目</span><span class="filter-summary-hint">章节 · 题型 · 难度</span></summary><div class="filter-body"><div class="filter-intro"><h2>筛选题目</h2><p>缩小范围，找到正在复习的内容。</p></div><div class="filter-field"><label for="sourceFilter">章节</label><select id="sourceFilter"><option value="all">全部章节</option>${optionList(chapters)}</select></div><div class="filter-field"><label for="typeFilter">题型</label><select id="typeFilter"><option value="all">全部题型</option>${Object.entries(typeNames).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></div><div class="filter-field"><label for="diffFilter">难度</label><select id="diffFilter"><option value="all">全部难度</option>${optionList(difficulties)}</select></div><button type="button" id="resetFilters" class="reset-button">重置筛选与搜索</button><div class="sidebar-guide"><h3>检索小提示</h3><p>输入多个关键词时，用空格分隔；题目需同时包含这些词。</p><p>选择“仅题目”，可排除答案内容，方便自测。</p></div></div></details></aside>
<main id="mainContent" class="workspace"><section id="control-panel" class="search-panel" aria-label="搜索题目"><div class="search-title-row"><h2>查找题目</h2><span class="shortcut-hint"><kbd>/</kbd> 或 <kbd>Ctrl K</kbd> 搜索</span></div><div class="search-row"><label class="sr-only" for="keywordFilter">搜索关键词</label><input id="keywordFilter" type="search" autocomplete="off" spellcheck="false" placeholder="搜索题干、选项或参考程序…"><button type="button" id="clearSearch" class="clear-button" aria-label="清空搜索">清空</button></div><div class="search-options"><label class="scope-label" for="searchScope">搜索范围 <select id="searchScope"><option value="full">全文（含答案）</option><option value="prompt">仅题目与选项</option></select></label><span class="search-help">空格分词，同时匹配</span></div></section>
<section id="extraction-summary" class="content-summary" aria-label="全库内容来源与提取情况" data-warning-count="${warningCount}" data-platform-reference-count="${referenceCount}" data-validated-answer-count="${validatedCount}" data-ai-answer-count="${aiCount}" data-source-unavailable-count="${unavailableImages}" data-image-saved-count="${savedImages}" data-image-total-count="${imageRecords.length}" data-image-pending-count="${pendingImages}"><div class="summary-cell"><span class="summary-count">${validatedCount}</span><span>平台校验答案</span></div><div class="summary-cell"><span class="summary-count">${referenceCount}</span><span>平台参考程序<small>未运行验证</small></span></div><div class="summary-cell"><span class="summary-count">${aiCount}</span><span>AI 解答<small>需自行核对</small></span></div><div class="summary-cell${warningCount ? ' has-warning' : ''}"><span class="summary-count">${warningCount}</span><span>提取提醒<small>${warningCount ? '详见对应题目' : '无提取提醒'}</small></span></div></section>
${imageRecords.length ? `<div class="image-integrity${unavailableImages || pendingImages ? ' integrity-warning' : ''}" role="note">全库图片：已保存 ${savedImages} / ${imageRecords.length} 张。${unavailableImages ? ` ${unavailableImages} 张平台原图不可用（HTTP 404/410），对应题目的图像内容不完整；原图提示和手动访问链接已保留。` : ''}${pendingImages ? ` 还有 ${pendingImages} 张未保存，当前文件不是图片完整的离线副本。` : ''}</div>` : ''}
${isFinal ? '' : '<div class="snapshot-notice" role="note">这是尚未完成的断点包，部分题目、答案或图片可能仍待提取。</div>'}
<div class="results-toolbar"><p id="resultStatus" role="status" aria-live="polite" aria-atomic="true">显示 <strong id="visibleCount">${allData.length}</strong><span class="result-total"> / ${allData.length} 道题</span></p><button type="button" id="toggleAnsBtn" class="global-answer-button" data-hidden="false">隐藏全部答案</button></div><div id="emptyState" class="empty-state" hidden><p class="empty-title">没有找到匹配的题目</p><p>试试更短的关键词，或调整章节、题型与难度。</p><button type="button" class="empty-reset">清空筛选，查看全部题目</button></div><div id="questions-container">${cards}</div><footer class="viewer-footer">全部检索与阅读均在本地完成。参考程序和 AI 解答需自行核对。</footer></main></div><button type="button" id="back-to-top" aria-label="回到页面顶部" hidden>回到顶部</button><script>${offlineViewerRuntime.toString()}
offlineViewerRuntime();</script></body></html>`;
    }

    function offlineViewerRuntime() {
        'use strict';
        const byId = id => document.getElementById(id);
        const search = byId('keywordFilter');
        const scope = byId('searchScope');
        const source = byId('sourceFilter');
        const type = byId('typeFilter');
        const difficulty = byId('diffFilter');
        const clear = byId('clearSearch');
        const count = byId('visibleCount');
        const empty = byId('emptyState');
        const globalToggle = byId('toggleAnsBtn');
        const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
        const topics = Array.from(document.querySelectorAll('.topic')).map(element => {
            const prompt = normalize([element.querySelector('.question-meta')?.textContent, element.querySelector('.type-pill')?.textContent, element.querySelector('.difficulty')?.textContent, element.querySelector('.detail-box')?.textContent].join(' '));
            const answer = Array.from(element.querySelectorAll('.answer-content')).map(node => node.textContent).join(' ');
            return { element, prompt, full: normalize(prompt + ' ' + answer + ' ' + (element.querySelector('.extraction-warning')?.textContent || '')), source: element.dataset.source, type: element.dataset.type, diff: element.dataset.diff, visible: true };
        });
        let searchTimer;
        let composing = false;
        function filterTopics() {
            clearTimeout(searchTimer);
            if (composing) return;
            const tokens = [...new Set(normalize(search.value).split(' ').filter(Boolean))];
            const usePrompt = scope.value === 'prompt';
            let shown = 0;
            for (const item of topics) {
                const text = usePrompt ? item.prompt : item.full;
                const visible = (source.value === 'all' || item.source === source.value) && (type.value === 'all' || item.type === type.value) && (difficulty.value === 'all' || item.diff === difficulty.value) && tokens.every(token => text.includes(token));
                if (visible !== item.visible) { item.element.classList.toggle('hidden', !visible); item.visible = visible; }
                if (visible) shown++;
            }
            count.textContent = String(shown);
            empty.hidden = shown !== 0;
            clear.disabled = search.value.length === 0;
        }
        function scheduleFilter() { clearTimeout(searchTimer); if (!composing) searchTimer = setTimeout(filterTopics, 150); }
        function clearQuery() { search.value = ''; composing = false; filterTopics(); }
        function resetFilters() { search.value = ''; scope.value = 'full'; source.value = type.value = difficulty.value = 'all'; composing = false; filterTopics(); }
        search.addEventListener('input', scheduleFilter);
        search.addEventListener('compositionstart', () => { composing = true; clearTimeout(searchTimer); });
        search.addEventListener('compositionend', () => { composing = false; filterTopics(); });
        search.addEventListener('search', filterTopics);
        for (const control of [scope, source, type, difficulty]) control.addEventListener('change', filterTopics);
        clear.addEventListener('click', () => { clearQuery(); search.focus(); });
        byId('resetFilters').addEventListener('click', resetFilters);
        document.querySelector('.empty-reset').addEventListener('click', resetFilters);
        document.addEventListener('keydown', event => {
            if (event.defaultPrevented || event.isComposing || composing) return;
            const editable = event.target instanceof Element && !!event.target.closest('input,textarea,select,[contenteditable="true"],[contenteditable=""]');
            const focusShortcut = ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') || (!editable && !event.ctrlKey && !event.metaKey && !event.altKey && event.key === '/');
            if (focusShortcut) { event.preventDefault(); search.focus(); search.select(); }
            else if (event.key === 'Escape' && (!editable || event.target === search) && search.value) { event.preventDefault(); clearQuery(); }
        });
        const answers = Array.from(document.querySelectorAll('.answer-toggle')).map(button => ({ button, box: byId(button.getAttribute('aria-controls')) }));
        function setAnswer(item, visible) {
            item.box.hidden = !visible;
            item.button.setAttribute('aria-expanded', String(visible));
            item.button.textContent = visible ? '隐藏答案' : '查看答案';
        }
        function updateGlobalToggle() {
            const anyVisible = answers.some(item => !item.box.hidden);
            globalToggle.disabled = answers.length === 0;
            globalToggle.dataset.hidden = String(!anyVisible);
            globalToggle.textContent = answers.length === 0 ? '暂无可显示的答案' : anyVisible ? '隐藏全部答案' : '显示全部答案';
        }
        for (const item of answers) item.button.addEventListener('click', () => { setAnswer(item, item.box.hidden); updateGlobalToggle(); });
        globalToggle.addEventListener('click', () => { const show = !answers.some(item => !item.box.hidden); answers.forEach(item => setAnswer(item, show)); updateGlobalToggle(); });
        document.querySelectorAll('.copy-btn').forEach(button => button.addEventListener('click', async () => {
            const code = button.closest('.code-container').querySelector('.code-box').textContent;
            let copied = false;
            try { if (navigator.clipboard) { await navigator.clipboard.writeText(code); copied = true; } } catch (_) {}
            if (!copied) {
                const textarea = document.createElement('textarea'); textarea.value = code;
                textarea.style.position = 'fixed'; textarea.style.top = '0'; textarea.style.left = '0';
                document.body.appendChild(textarea); textarea.select();
                const copyExactText = event => { if (event.clipboardData) { event.clipboardData.setData('text/plain', code); event.preventDefault(); } };
                document.addEventListener('copy', copyExactText);
                try { copied = document.execCommand('copy'); } catch (_) {}
                finally { document.removeEventListener('copy', copyExactText); }
                textarea.remove(); button.focus({preventScroll:true});
            }
            const old = button.textContent; button.textContent = copied ? '复制成功' : '复制失败，请手动选择';
            button.setAttribute('aria-live', 'polite');
            setTimeout(() => { button.textContent = old; }, 1800);
        }));
        const theme = byId('themeToggle');
        const systemTheme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
        function toggleTheme() { document.body.classList.toggle('dark-mode', theme.value === 'dark' || (theme.value === 'auto' && !!systemTheme?.matches)); }
        theme.addEventListener('change', toggleTheme);
        if (systemTheme?.addEventListener) systemTheme.addEventListener('change', toggleTheme);
        else if (systemTheme?.addListener) systemTheme.addListener(toggleTheme);
        toggleTheme();
        const narrow = window.matchMedia && window.matchMedia('(max-width: 900px)');
        const filterDetails = byId('filterDetails');
        function setFilterLayout() { filterDetails.open = !narrow?.matches; }
        if (narrow?.addEventListener) narrow.addEventListener('change', setFilterLayout);
        else if (narrow?.addListener) narrow.addListener(setFilterLayout);
        setFilterLayout();
        document.querySelectorAll('.detail-box img, .answer-content img').forEach(img => {
            const showMissing = () => {
                const message = document.createElement('div'); message.className = 'img-failed';
                message.textContent = '离线图片缺失或无法解码。';
                const original = img.getAttribute('data-original');
                if (original) { const link = document.createElement('a'); link.href = original; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '联网查看原图'; message.append(' ', link); }
                img.replaceWith(message);
            };
            img.addEventListener('error', showMissing, {once:true});
            if (img.complete && img.naturalWidth === 0) showMissing();
        });
        const topButton = byId('back-to-top');
        topButton.addEventListener('click', () => window.scrollTo({top:0, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'}));
        window.addEventListener('scroll', () => { topButton.hidden = window.scrollY <= 500; }, {passive:true});
        updateGlobalToggle();
        filterTopics();
    }

    function offlineViewerStyles() {
        return `
        :root{color-scheme:light;--bg:#f2f5f4;--surface:#fff;--surface-soft:#f6f8f7;--ink:#1e3333;--muted:#526a68;--faint:#657a78;--line:#dce5e2;--accent:#087d73;--accent-hover:#06665f;--accent-soft:#e5f3ef;--warning:#855b0d;--warning-bg:#fff7e6;--warning-line:#e9cc89;--shadow:0 4px 18px rgba(25,55,49,.035);--code:#f3f7f5;--focus:#0a8d80}
        .dark-mode{color-scheme:dark;--bg:#121c1d;--surface:#1b2829;--surface-soft:#213032;--ink:#e2eeeb;--muted:#b1c4bf;--faint:#93aaa4;--line:#344747;--accent:#7ad4bd;--accent-hover:#a2e5d3;--accent-soft:#1d403a;--warning:#efd28d;--warning-bg:#352e1d;--warning-line:#68572d;--shadow:none;--code:#142123;--focus:#7ad4bd}
        *{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:205px}body{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.6}button,input,select{font:inherit}button,select{cursor:pointer}button{color:inherit}button:disabled{cursor:default;opacity:.55}a{color:var(--accent);text-underline-offset:3px}button,input,select,a,summary,pre[tabindex]{outline-offset:4px}button:focus-visible,input:focus-visible,select:focus-visible,a:focus-visible,summary:focus-visible,pre[tabindex]:focus-visible{outline:2px solid var(--focus)}button{touch-action:manipulation}h1,h2,h3,p{margin:0}select,input{color:var(--ink);background:var(--surface);border:1px solid var(--line);border-radius:8px;min-width:0}select{padding:10px 30px 10px 12px;max-width:100%}input::-webkit-search-cancel-button{display:none}.hidden,[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.skip-link{position:fixed;top:-100px;left:20px;background:var(--surface);padding:12px 20px;z-index:100}.skip-link:focus{top:12px}
        .site-header{max-width:1440px;margin:0 auto;padding:32px 48px 27px;display:flex;align-items:center;justify-content:space-between;gap:20px;border-bottom:1px solid var(--line)}.brand{display:flex;gap:14px;align-items:center}.brand-mark{display:grid;place-items:center;width:46px;height:46px;border:1px solid var(--accent);border-radius:13px;background:var(--accent);color:var(--surface);font-size:28px;line-height:1;font-weight:700;font-family:Georgia,serif}.dark-mode .brand-mark{color:#122923}.eyebrow{font-size:11px;font-weight:650;letter-spacing:.16em;color:var(--muted);margin-bottom:3px}h1{font-size:24px;line-height:1.3;letter-spacing:-.03em;font-weight:680}.header-tools{display:flex;align-items:center;gap:22px}.offline-status{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:7px}.offline-status:before{content:"";width:6px;height:6px;background:var(--accent);border-radius:50%}.theme-label select{font-size:12px;padding:8px 28px 8px 10px;background:transparent}
        .app-layout{display:grid;grid-template-columns:222px minmax(0,1fr);gap:36px;max-width:1440px;margin:0 auto;padding:30px 48px 64px}.sidebar{min-width:0}.filter-panel{position:sticky;top:24px}.filter-panel>summary{display:none}.filter-intro{padding:5px 0 24px}.filter-intro h2{font-size:15px;font-weight:700}.filter-intro p{margin-top:6px;font-size:12px;color:var(--faint)}.filter-field{display:flex;flex-direction:column;gap:8px;margin-bottom:20px}.filter-field label{font-size:12px;font-weight:650;color:var(--muted)}.filter-field select{width:100%;font-size:13px;min-height:43px;background:var(--surface)}.reset-button{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;font-size:12px;color:var(--muted)}.reset-button:hover{background:var(--surface);color:var(--ink)}.sidebar-guide{margin-top:28px;padding-top:23px;border-top:1px solid var(--line);color:var(--faint);font-size:12px;line-height:1.9}.sidebar-guide h3{font-size:12px;font-weight:650;color:var(--muted);margin-bottom:8px}.sidebar-guide p+p{margin-top:10px}.workspace{min-width:0}.search-panel{position:sticky;top:16px;z-index:10;background:var(--surface);padding:20px 24px 15px;border:1px solid var(--line);border-radius:13px;box-shadow:var(--shadow)}.search-title-row{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:13px}.search-title-row h2{font-size:15px;letter-spacing:-.01em}.shortcut-hint{font-size:11px;color:var(--faint);display:flex;align-items:center;gap:5px}kbd{border:1px solid var(--line);border-radius:4px;padding:0 5px;background:var(--surface-soft);font-size:11px;line-height:1.7}.search-row{display:flex;align-items:center;gap:10px;position:relative}.search-row input{flex:1;width:100%;height:47px;padding:10px 66px 10px 14px;background:var(--surface-soft);font-size:15px;border-color:var(--line)}.search-row input::placeholder{color:var(--faint)}.search-row input:focus{border-color:var(--accent);background:var(--surface)}.clear-button{position:absolute;right:10px;top:9px;height:29px;padding:2px 8px;border:0;border-radius:5px;background:transparent;font-size:12px;color:var(--muted)}.clear-button:not(:disabled):hover{background:var(--accent-soft);color:var(--accent)}.search-options{display:flex;justify-content:space-between;align-items:center;gap:16px;margin-top:11px;font-size:11px;color:var(--faint)}.scope-label{display:flex;align-items:center;gap:8px;white-space:nowrap}.scope-label select{padding:3px 22px 3px 6px;font-size:11px;border:0;background:var(--surface);color:var(--muted)}.search-help{white-space:nowrap}
        .content-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:20px 0 22px;padding:0 3px}.summary-cell{display:flex;align-items:center;gap:11px;font-size:11px;color:var(--muted);border-right:1px solid var(--line);padding-right:10px;min-width:0}.summary-cell:last-child{border-right:0}.summary-count{font-size:22px;font-variant-numeric:tabular-nums;font-weight:600;line-height:1.3;letter-spacing:-.04em;color:var(--ink)}.summary-cell small{display:block;color:var(--faint);font-size:10px;line-height:1.5}.summary-cell.has-warning .summary-count{color:var(--warning)}.snapshot-notice{padding:13px 16px;background:var(--warning-bg);border:1px solid var(--warning-line);border-radius:8px;color:var(--warning);font-size:12px;margin-bottom:20px}.results-toolbar{display:flex;justify-content:space-between;align-items:center;gap:20px;margin:0 2px 14px}.results-toolbar p{font-size:13px;color:var(--muted)}#visibleCount{color:var(--ink);font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}.result-total{font-size:12px;color:var(--faint)}.global-answer-button{padding:5px 0 5px 12px;border:0;background:transparent;color:var(--accent);font-size:12px;font-weight:600}.global-answer-button:not(:disabled):hover{text-decoration:underline;text-underline-offset:3px}
        .topic{background:var(--surface);border:1px solid var(--line);border-radius:13px;padding:25px 28px 22px;margin-bottom:18px;box-shadow:var(--shadow);scroll-margin-top:205px}.question-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px}.question-ident{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.question-number{font:12px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--faint);margin-right:2px;font-variant-numeric:tabular-nums}.type-pill{font-size:11px;padding:3px 8px;border-radius:5px;color:var(--accent);background:var(--accent-soft);font-weight:600}.difficulty{font-size:11px;color:var(--faint)}.answer-source{font-size:10px;white-space:nowrap;color:var(--faint);padding:2px 0}.source-verified,.source-reference{color:var(--accent)}.source-ai{color:var(--muted)}.source-warning{color:var(--warning)}.question-meta{font-size:11px;color:var(--muted);margin-bottom:19px;overflow-wrap:anywhere}.meta-label{color:var(--faint);margin-right:7px}.detail-box{font-size:15px;line-height:1.85;overflow-wrap:anywhere;overflow-x:auto}.detail-box p{margin:0 0 12px}.detail-box p:last-child{margin-bottom:0}.detail-box h1,.detail-box h2,.detail-box h3{font-size:16px;margin:12px 0 8px;line-height:1.6}.detail-box pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--surface-soft);padding:13px 16px;border-radius:7px;font:13px/1.75 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace}.detail-box code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:.92em}.detail-box ul,.detail-box ol{padding-left:22px;margin:10px 0}.detail-box li{margin:6px 0}.detail-box label{display:block;margin:9px 0}.detail-box input[type=radio],.detail-box input[type=checkbox]{margin:0 8px 0 0;accent-color:var(--accent)}.detail-box table{max-width:100%;border-collapse:collapse;font-size:13px}.detail-box td,.detail-box th{padding:8px 12px;border:1px solid var(--line);text-align:left}.requirement-box{padding:12px 15px;margin-top:14px;background:var(--surface-soft);border-left:3px solid var(--line);border-radius:0 6px 6px 0}img{max-width:100%;height:auto;vertical-align:middle}.detail-box img,.answer-content img{display:block;margin:10px 0;border-radius:5px}.extraction-warning{display:flex;gap:10px;align-items:flex-start;margin-top:18px;padding:12px 15px;border:1px solid var(--warning-line);border-radius:8px;background:var(--warning-bg);color:var(--warning);font-size:12px;line-height:1.7;overflow-wrap:anywhere}.extraction-warning strong{white-space:nowrap;font-size:11px;margin-top:1px}.answer-section{margin-top:21px;padding-top:14px;border-top:1px solid var(--line)}.answer-actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.answer-caption{font-size:11px;font-weight:600;color:var(--faint)}.answer-toggle{background:transparent;color:var(--accent);border:0;padding:3px 0 3px 12px;font-size:12px;font-weight:600}.answer-toggle:hover{text-decoration:underline;text-underline-offset:3px}.answer-box{margin-top:12px}.answer-heading{font-size:11px;color:var(--muted);margin-bottom:10px}.answer-content{font-size:14px;line-height:1.8;overflow-wrap:anywhere}.plain-answer{white-space:pre-wrap}.answer-status{margin-top:20px;border-top:1px solid var(--line);padding-top:13px;color:var(--faint);font-size:11px}.code-container{position:relative}.code-language{position:absolute;top:12px;left:17px;font-size:10px;letter-spacing:.12em;color:var(--faint);font-weight:650;pointer-events:none}.code-box{margin:0;background:var(--code);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:43px 17px 17px;white-space:pre-wrap;overflow-wrap:anywhere;overflow-y:auto;max-height:560px;max-height:60vh;font:13px/1.8 ui-monospace,SFMono-Regular,Consolas,"Liberation Mono",monospace;tab-size:4}.copy-btn{position:absolute;top:8px;right:10px;padding:4px 9px;background:var(--surface);border:1px solid var(--line);border-radius:5px;color:var(--muted);font-size:10px}.copy-btn:hover{border-color:var(--accent);color:var(--accent)}.img-failed{margin:12px 0;padding:15px;border:1px dashed var(--warning-line);border-radius:7px;background:var(--warning-bg);color:var(--warning);font-size:12px;overflow-wrap:anywhere}.img-failed a{color:inherit}
        .empty-state{background:var(--surface);border:1px dashed var(--line);border-radius:13px;text-align:center;padding:55px 20px 58px;color:var(--muted)}.empty-title{font-size:18px;font-weight:650;color:var(--ink);margin-bottom:8px}.empty-state>p:not(.empty-title){font-size:13px}.empty-reset{margin-top:24px;border:1px solid var(--accent);border-radius:7px;padding:10px 16px;color:var(--accent);background:var(--accent-soft);font-size:12px}.empty-reset:hover{background:var(--surface)}.viewer-footer{padding:18px 0 5px;font-size:11px;line-height:1.8;color:var(--faint);text-align:center}#back-to-top{position:fixed;bottom:24px;right:24px;z-index:12;background:var(--surface);color:var(--muted);border:1px solid var(--line);border-radius:8px;padding:10px 13px;font-size:11px;box-shadow:var(--shadow)}
        @media(min-width:1600px){.app-layout{grid-template-columns:230px minmax(0,1fr);gap:44px}}@media(max-width:1100px){.site-header{padding:26px 28px 24px}.app-layout{padding:26px 28px 50px;grid-template-columns:195px minmax(0,1fr);gap:24px}.search-panel{padding:18px}.topic{padding:22px}.content-summary{gap:9px}.summary-cell{gap:7px;font-size:10px}.summary-count{font-size:20px}}
        @media(max-width:900px){html{scroll-padding-top:20px}.site-header{padding:24px}.app-layout{display:block;padding:20px 24px 45px}.sidebar{margin-bottom:16px}.filter-panel{position:static;background:var(--surface);border:1px solid var(--line);border-radius:10px}.filter-panel>summary{display:flex;align-items:center;justify-content:space-between;padding:13px 17px;cursor:pointer;list-style:none;font-size:13px;font-weight:600;gap:15px}.filter-panel>summary::-webkit-details-marker{display:none}.filter-panel>summary:after{content:"+";font-size:18px;font-weight:400;color:var(--accent)}.filter-panel[open]>summary:after{content:"−"}.filter-summary-hint{margin-left:auto;font-size:10px;font-weight:400;color:var(--faint)}.filter-body{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;padding:3px 17px 17px}.filter-intro,.sidebar-guide{display:none}.filter-field{margin:0;gap:6px}.filter-field select{font-size:12px}.reset-button{grid-column:1/-1;margin-top:0}.search-panel{position:static}.topic{scroll-margin-top:20px}.content-summary{gap:14px;margin-top:19px}.summary-cell{font-size:11px;gap:10px}.summary-count{font-size:22px}}
        @media(max-width:540px){body{font-size:14px}.site-header{padding:21px 16px 20px;gap:10px}.brand{gap:10px}.brand-mark{width:39px;height:39px;border-radius:10px;font-size:25px}.eyebrow{font-size:9px}h1{font-size:21px}.header-tools{gap:8px}.offline-status{display:none}.theme-label select{font-size:10px;padding:7px 22px 7px 8px;max-width:110px}.app-layout{padding:17px 14px 35px}.filter-summary-hint{font-size:9px}.filter-body{grid-template-columns:1fr;padding:3px 16px 16px;gap:12px}.filter-field{display:grid;grid-template-columns:40px minmax(0,1fr);align-items:center}.filter-field select{font-size:13px;min-height:42px}.filter-field label{font-size:11px}.search-panel{padding:16px;border-radius:11px}.search-title-row{margin-bottom:12px}.search-title-row h2{font-size:14px}.shortcut-hint{display:none}.search-row input{height:47px;font-size:16px;padding-left:11px}.search-options{margin-top:10px;gap:5px}.scope-label{font-size:10px;gap:4px}.scope-label select{font-size:10px;padding-right:17px}.search-help{font-size:9px}.content-summary{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 20px;padding:0 4px;margin:18px 0 20px}.summary-cell{gap:10px;border-right:0}.summary-cell:nth-child(odd){border-right:1px solid var(--line)}.summary-count{min-width:34px;font-size:22px}.summary-cell small{font-size:9px}.results-toolbar{margin-bottom:12px;gap:10px}.global-answer-button{font-size:11px}.topic{padding:19px 17px 17px;border-radius:11px;margin-bottom:14px}.question-head{gap:8px;align-items:flex-start}.question-ident{gap:7px}.answer-source{font-size:9px;max-width:90px;text-align:right;white-space:normal;line-height:1.8}.question-number{font-size:11px}.type-pill{font-size:10px}.difficulty{font-size:10px}.question-meta{font-size:10px;margin-bottom:16px}.detail-box{font-size:14px;line-height:1.9}.detail-box pre{font-size:12px;padding:11px 12px}.extraction-warning{flex-direction:column;gap:3px;padding:11px 12px;font-size:11px}.answer-content{font-size:13px}.code-box{font-size:12px;padding:42px 13px 14px;max-height:55vh}.answer-heading{font-size:10px}.code-language{left:14px}.copy-btn{font-size:10px}.answer-section{margin-top:18px}.answer-caption,.answer-toggle{font-size:11px}.empty-state{padding:40px 17px}.empty-title{font-size:17px}.empty-state>p:not(.empty-title){font-size:12px}.viewer-footer{font-size:10px;padding:14px 10px}#back-to-top{bottom:15px;right:14px;font-size:10px;padding:8px 10px}}
        .image-integrity{margin:-6px 0 20px;padding:10px 13px;border:1px solid var(--line);border-radius:7px;color:var(--muted);background:var(--surface);font-size:11px;line-height:1.8}.image-integrity.integrity-warning,.question-image-warning{color:var(--warning);background:var(--warning-bg);border:1px solid var(--warning-line)}.question-image-warning{margin-top:15px;padding:10px 13px;border-radius:7px;font-size:11px;line-height:1.8}.code-box code{font:inherit}.source-image-unavailable strong{display:block;margin-bottom:5px}.source-image-unavailable a{display:inline-block;margin-top:7px}
        @media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
        @media print{body{background:white;color:black}.site-header{padding:0 0 15px}.sidebar,.search-panel,.results-toolbar,.header-tools,.answer-toggle,.copy-btn,#back-to-top,.skip-link{display:none!important}.app-layout{display:block;padding:15px 0}.content-summary{margin:0 0 20px}.topic{box-shadow:none;break-inside:avoid;border-color:#aaa}.code-box{max-height:none;overflow:visible}.viewer-footer{color:#333}}
        `;
    }

    async function runEngine() {
        if (engineRunning) return;
        engineRunning = true;
        try {
            while (globalState.stage <= 4 && !globalState.isPaused) {
                if (globalState.stage === 1) await runStage1();
                else if (globalState.stage === 2) await runStage2();
                else if (globalState.stage === 3) await runStage3();
                else if (globalState.stage === 4) await runStage4();
                else throw new Error('断点阶段无效。');
            }
        } catch (error) {
            globalState.isPaused = true; globalState.lastError = error.message;
            addLog(`提取已暂停，未标记完成：${error.message}`, 'error');
        }
        pauseBtn.disabled = true;
        try {
            await buildZipAndDownload(!globalState.isPaused && globalState.stage > 4);
        } catch (error) {
            globalState.isPaused = true;
            addLog(`ZIP 打包失败，数据仍保留在当前页面：${error.message}`, 'error');
        } finally {
            engineRunning = false; pauseBtn.disabled = false;
            if (globalState.isPaused) setPauseUI();
            updateGlobalProgress();
        }
    }

})();
