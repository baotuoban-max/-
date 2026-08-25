// 包托办V21·指纹备货中枢Pro v21.0.30 — AMBER PRO BUILD（与原版并存）
// 3账号 × 6平台 · 中转站+采购表+备份表 三表架构
// V21.0.0 推翻重做: 分区三列模型(账号/平台基名/分区独立列)· 中转站流水追加· 采购表指纹重建
// ============================================================

// V21.0.0: 推翻重做 — 一区二区独立列(彻底解决二区覆盖一区)、中转站只追加不猜、采购表指纹重建
// V20.29.0: 合并提速(blocking候选索引+预计算) + 防误合并(成员级严格校验)
//            + 日期时区修复(businessDateTimestamp 纯日期按本地时区解析)
// V20.16.1: scope修复+combobox筛选控件+复检函数保护
// V20.16.0: Removed old auto-mark code (was causing cross-account marking)

// ====== CONFIG ======
var FEISHU_URL = 'https://gcnyr00pkwqp.feishu.cn/base/DptPbPEluaupDjsp2XZcFK56nte';
var APP_ID = '__FEISHU_APPID__';
var APP_SECRET = '__FEISHU_SECRET__';
var AT = 'DptPbPEluaupDjsp2XZcFK56nte';
var TT = 'tblQy4Ugplc6n9E4';
// ====== TABLE ARCHITECTURE (v19.92.0) ======
// 中转站: 抓取数据写入这里，合并/回传/增量更新都在此表操作
// 采购表: 中转站数据同步到此表，正式采购用
// 备份表: 手动快照，用于恢复
var TRANSFER_TABLE = 'tblQy4Ugplc6n9E4';   // 中转站（主表）
var PROCURE_TABLE  = 'tblMXn13Mpkvf1ql';
var PENDING_TABLE = 'tbl4VTn2Fov9hpuV'; // 待确认_上午有下午无   // 采购表
var BACKUP_SNAPSHOT = 'tbly4JdzmdiWIWd7';   // 备份快照表

// Legacy aliases — all code should use TRANSFER_TABLE directly
var RAW_TABLE  = TRANSFER_TABLE;  // 中转站
var PROC_TABLE = TRANSFER_TABLE;  // 中转站

// ====== V21.0.0 三列分区模型（解决一区二区覆盖） ======
// 新增独立列，旧的“平台【文字】”保留兼容写入，不再作为唯一键
var V21_ZONE_FIELDS = {
  tail: ['店管家尾号', '尾号', '账号尾号'],           // 5820/7205/7207
  base: ['平台基名', '平台基名称', '基名'],           // 抖音/拼多多/京东...
  zone: ['分区', '区域', '一区二区', 'Zone'],         // 一区/二区/-
  qtyNum: ['需求数量_数字', '数量_数字', '数字数量'], // 从规格文本解析出的数字和
  fingerprint: ['SKU指纹', '商品指纹', '指纹']        // 归一标题|规格结构 MD5
};

var _token = null, _tokenExp = 0, _startTime = 0;

// ====== OPTIMIZATION CONSTANTS ======
var BATCH_SIZE = 100;       // Feishu API batch limit
var PAGE_SIZE = 500;        // Feishu API page size
var JW_THRESHOLD = 0.85;    // Jaro-Winkler fuzzy match threshold
var SPEC_TRIG_THRESHOLD = 0.65;  // Spec trigram threshold
var SPEC_OVERLAP_THRESHOLD = 0.70; // Spec overlap threshold
var RETRY_COUNT = 2;        // API retry attempts
var RETRY_DELAY = 1500;     // Retry delay ms

// ====== V21 HELPERS ======
function v21ParseQtyNumber(specText) {
  if (!specText) return 0;
  var sum = 0, m = String(specText).match(/;\s*(\d+)/g);
  if (m) { m.forEach(function(x){ var v=parseInt(x.replace(/[^0-9]/g,''),10); if(!isNaN(v)&&v>0&&v<100000) sum+=v; }); if(sum>0) return sum; }
  // 兜底：单行无分号时匹配末尾数字
  var tail = String(specText).match(/(\d+)\s*(?:\||$)/);
  if (tail) { var v=parseInt(tail[1],10); if(!isNaN(v)) return v; }
  return 0;
}
function v21BuildFingerprint(title, spec) {
  // 确定性指纹：归一标题 + 规格结构（去数量），避免向量误合
  var t = (typeof normTitle === 'function' ? normTitle(title||'') : String(title||'').trim().toLowerCase());
  var s = '';
  if (typeof parseSpecStructure === 'function') {
    try { var st = parseSpecStructure(spec||''); s = (st && st.normalized) || String(spec||'').trim(); } catch(e){ s = String(spec||'').trim(); }
  } else {
    s = String(spec||'').trim().replace(/\s+/g,'');
  }
  // 简单哈希（FNV-like），避免引入外部依赖
  var str = t + '|' + s;
  var h = 2166136261;
  for (var i=0;i<str.length;i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h>>>0).toString(16) + '_' + str.length;
}
function v21ResolveField(fieldMap, candidates) {
  for (var i=0;i<candidates.length;i++) if (fieldMap[candidates[i]]) return candidates[i];
  return null;
}
function v21SplitPlatformZone(confirmedPlatform) {
  // "抖音一区-【7207】" -> {base:"抖音", zone:"一区", tail:"7207"}; "抖音-【7207】" -> zone:"-"
  var tail = '', base = '', zone = '-';
  var m = String(confirmedPlatform||'').match(/-【(\d+)】/);
  if (m) tail = m[1];
  var withoutTail = String(confirmedPlatform||'').replace(/-【\d+】.*$/,'').trim();
  if (withoutTail.indexOf('一区')>=0) { zone='一区'; base=withoutTail.replace('一区','').trim(); }
  else if (withoutTail.indexOf('二区')>=0) { zone='二区'; base=withoutTail.replace('二区','').trim(); }
  else { base = withoutTail; }
  return {tail:tail, base:base, zone:zone};
}

// ====== DOM ======
var lg, statTotal, statImg, barTotal, barImg, statusBar, statusHint;
var progressWrap, progressFill, progressPct, progressTitle, progressDetail, progressTime;

function initDOM() {
  try{ chrome.storage.local.get(['pendingStale_v21'], function(st){ renderPendingStale(st.pendingStale_v21||[]); }); }catch(e){}
  var clr=document.getElementById('pendingStaleClear'); if(clr) clr.addEventListener('click', function(){ if(!confirm('确认已由采购核对完成？将清空待确认清单')) return; chrome.storage.local.set({pendingStale_v21:[]}, function(){ renderPendingStale([]); L('待确认已清空','i'); }); });
  var exp=document.getElementById('pendingStaleExport'); if(exp) exp.addEventListener('click', function(){ chrome.storage.local.get(['pendingStale_v21'], function(st){ var lst=st.pendingStale_v21||[]; if(!lst.length) return L('暂无待确认','w'); var txt='平台,分区,店管家,标题,PID,规格,数量,图片URL,附件URL,日期,记录ID\n'+lst.map(function(x){return '"'+x.platform+'","'+(x.zone||'')+'","'+(x.store||'')+'","'+x.title.replace(/"/g,'""')+'","'+x.pid.replace(/"/g,'""')+'","'+x.spec.replace(/"/g,'""').replace(/\n/g,' | ').slice(0,300)+'","'+(x.qty||'')+'","'+(x.img||'')+'","'+(x.attach||'')+'","'+x.date+'","'+(x.recId||'')+'"'}).join('\n'); var blob=new Blob([txt],{type:'text/csv'}); var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; a.download='待确认_上午有下午无_'+new Date().toISOString().slice(0,10)+'.csv'; a.click(); setTimeout(function(){URL.revokeObjectURL(url)},1000); }); });
  lg = document.getElementById('lg');
  statTotal = document.getElementById('statTotal');
  statImg = document.getElementById('statImg');
  barTotal = document.getElementById('barTotal');
  barImg = document.getElementById('barImg');
  statusBar = document.getElementById('statusBar');
  statusHint = document.getElementById('statusHint');
  progressWrap = document.getElementById('progressWrap');
  progressFill = document.getElementById('progressFill');
  progressPct = document.getElementById('progressPct');
  progressTitle = document.getElementById('progressTitle');
  progressDetail = document.getElementById('progressDetail');
  progressTime = document.getElementById('progressTime');
}
initDOM();
// ====== PLUGIN VERSION ======
function updatePluginVersion() {
  try {
    var manifest = chrome.runtime.getManifest();
    var version = manifest.version;
    window.pluginVersion = version;
    var el = document.getElementById('pluginVersion');
    if (el) el.textContent = 'v' + version;
    console.log('Plugin version:', version);
  } catch (e) {
    console.error('Failed to get plugin version:', e);
    window.pluginVersion = 'unknown';
    var el = document.getElementById('pluginVersion');
    if (el) el.textContent = 'v?';
  }
}
// 初始化时更新版本号
updatePluginVersion();

// ====== AI TASK EXPERIENCE ======
var _activeTaskId = '';
var _taskStartedAt = 0;
var _taskTimer = null;
var _taskProgressPct = null;
var TASK_META = {
  go:{title:'正在抓取备货单', idle:'抓取备货单', running:'正在抓取', success:'抓取完成', sub:'上午预估数据正在写入飞书'},
  returnBtn:{title:'正在执行下午回传', idle:'下午回传', running:'正在回传', success:'回传完成', sub:'已打印数据回传并实时同步采购表'},
  incrementalReturnBtn:{title:'正在执行增量回传', idle:'增量回传', running:'增量回传中', success:'增量回传完成', sub:'新增打单规格追加不覆盖'},
  syncBtn:{title:'正在同步采购表', idle:'同步采购表', running:'正在同步', success:'同步完成', sub:'核对来源、保护采购值并刷新需求'},
  dedupBtn:{title:'正在检查重复数据', idle:'重复检查', running:'正在检查', success:'检查完成', sub:'只读检查中转站，不跨店铺破坏来源明细'},
  diagScan:{title:'正在诊断页面', idle:'诊断扫描', running:'扫描中', success:'诊断完成', sub:'检查店管家页面结构与可抓取数据'},
  retryImages:{title:'正在修复失败附件', idle:'重试附件', running:'正在重试', success:'附件修复完成', sub:'只处理上次失败的图片，不重复抓取数据'}
  ,automationRunMorning:{title:'正在运行早晨自动化', idle:'立即执行14项', running:'自动化运行中', success:'早晨自动化完成', sub:'三个店管家、十四个平台顺序抓取并生成采购表'}
};

function taskLabelEl(el) {
  return el ? (el.querySelector('.act-label') || el.querySelector('.mini-title')) : null;
}
function taskStateEl(el) {
  return el ? el.querySelector('.task-state') : null;
}
function setTaskInteractionLock(locked, activeTaskId) {
  var selector = [
    '.act', '.mini-action', '.hdr-btn',
    '.card summary', '.card button', '.card input',
    '.card select', '.card textarea'
  ].join(',');
  document.querySelectorAll(selector).forEach(function(node) {
    if (node.closest && node.closest('.log-panel')) return;
    if (locked) {
      if (node.dataset.taskLockApplied === '1') return;
      node.dataset.taskLockApplied = '1';
      node.dataset.taskPrevDisabled = ('disabled' in node && node.disabled) ? '1' : '0';
      node.dataset.taskPrevTabindex = node.hasAttribute('tabindex')
        ? node.getAttribute('tabindex') : '__none__';
      node.classList.add('task-locked');
      if (node.id === activeTaskId) node.classList.add('task-lock-active');
      node.setAttribute('aria-disabled', 'true');
      node.setAttribute('tabindex', '-1');
      if ('disabled' in node) node.disabled = true;
      return;
    }
    if (node.dataset.taskLockApplied !== '1') return;
    if ('disabled' in node) node.disabled = node.dataset.taskPrevDisabled === '1';
    if (node.dataset.taskPrevTabindex === '__none__') node.removeAttribute('tabindex');
    else node.setAttribute('tabindex', node.dataset.taskPrevTabindex);
    node.removeAttribute('aria-disabled');
    node.classList.remove('task-locked', 'task-lock-active');
    delete node.dataset.taskLockApplied;
    delete node.dataset.taskPrevDisabled;
    delete node.dataset.taskPrevTabindex;
  });
}
document.addEventListener('click', function(event) {
  var lockedControl = event.target && event.target.closest
    ? event.target.closest('.task-locked') : null;
  if (!lockedControl) return;
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}, true);
function updateTaskTimer() {
  var timeEl = document.getElementById('taskFocusTime');
  if (!timeEl || !_taskStartedAt) return;
  var sec = Math.max(0, Math.floor((Date.now() - _taskStartedAt) / 1000));
  var mm = String(Math.floor(sec / 60)).padStart(2, '0');
  var ss = String(sec % 60).padStart(2, '0');
  timeEl.textContent = mm + ':' + ss;
}
function setTaskFocus(state, title, detail, step, pct) {
  var focus = document.getElementById('taskFocus');
  if (!focus) return;
  focus.className = 'task-focus ' + state;
  var titleEl = document.getElementById('taskFocusTitle');
  var detailEl = document.getElementById('taskFocusDetail');
  var stepEl = document.getElementById('taskFocusStep');
  var stateEl = document.getElementById('taskFocusState');
  var fillEl = document.getElementById('taskFocusFill');
  if (titleEl && title) titleEl.textContent = title;
  if (detailEl && detail) detailEl.textContent = detail;
  if (stepEl && step) stepEl.textContent = step;
  if (stateEl) stateEl.textContent = state === 'running' ? 'RUNNING' : state === 'success' ? 'DONE' : state === 'error' ? 'ERROR' : 'READY';
  if (fillEl) {
    if (pct !== undefined && pct !== null) _taskProgressPct = Math.max(0, Math.min(100, pct));
    var effectivePct = (pct === undefined || pct === null) ? _taskProgressPct : pct;
    var indeterminate = state === 'running' && (effectivePct === undefined || effectivePct === null);
    fillEl.classList.toggle('indeterminate', indeterminate);
    if (indeterminate) fillEl.style.width = '42%';
    else if (effectivePct !== undefined && effectivePct !== null) fillEl.style.width = Math.max(0, Math.min(100, effectivePct)) + '%';
    else if (state !== 'running') fillEl.style.width = state === 'success' ? '100%' : '0%';
  }
}
function beginTask(taskId, detail) {
  var meta = TASK_META[taskId] || {};
  var el = document.getElementById(taskId);
  if (!el || el.disabled) return false;
  if (_activeTaskId) {
    taskStep('请等待当前任务完成后再启动其他操作', '已有任务正在执行');
    return false;
  }
  _activeTaskId = taskId;
  _taskStartedAt = Date.now();
  _taskProgressPct = null;
  clearInterval(_taskTimer);
  _taskTimer = setInterval(updateTaskTimer, 1000);
  setTaskInteractionLock(true, taskId);
  el.setAttribute('aria-busy', 'true');
  el.classList.remove('task-success', 'task-error');
  el.classList.add('running');
  var appEl = document.querySelector('.app');
  if (appEl) appEl.classList.add('task-busy');
  document.body.classList.add('task-running');
  var label = taskLabelEl(el);
  if (label) label.textContent = meta.running || '执行中';
  var badge = taskStateEl(el);
  if (badge) badge.textContent = '执行中';
  var timeEl = document.getElementById('taskFocusTime');
  if (timeEl) timeEl.textContent = '00:00';
  setTaskFocus('running', meta.title || '正在执行任务', detail || meta.sub || '任务已启动', '任务已启动');
  return true;
}
function taskStep(detail, step, pct) {
  if (!_activeTaskId) return;
  var meta = TASK_META[_activeTaskId] || {};
  setTaskFocus('running', meta.title || '正在执行任务', detail || meta.sub, step || '处理中', pct);
}
function endTask(taskId, ok, detail) {
  var meta = TASK_META[taskId] || {};
  var el = document.getElementById(taskId);
  if (el) {
    el.removeAttribute('aria-busy');
    el.classList.remove('running');
    el.classList.add(ok ? 'task-success' : 'task-error');
    var label = taskLabelEl(el);
    if (label) label.textContent = meta.idle || '执行任务';
    var badge = taskStateEl(el);
    if (badge) badge.textContent = ok ? '已完成' : '需检查';
    setTimeout(function() {
      el.classList.remove('task-success', 'task-error');
      if (badge) badge.textContent = '待执行';
    }, 6500);
  }
  if (_activeTaskId === taskId) {
    clearInterval(_taskTimer);
    _taskTimer = null;
    updateTaskTimer();
    setTaskFocus(ok ? 'success' : 'error',
      ok ? (meta.success || '任务完成') : (meta.title || '任务执行失败'),
      detail || (ok ? '任务已经安全完成' : '请查看运行日志中的错误信息'),
      ok ? '全部步骤已完成' : '任务停止，请检查日志',
      ok ? 100 : 0);
    _taskProgressPct = ok ? 100 : 0;
    _activeTaskId = '';
    var appEl = document.querySelector('.app');
    if (appEl) appEl.classList.remove('task-busy');
    document.body.classList.remove('task-running');
    setTaskInteractionLock(false, '');
    try {
      document.dispatchEvent(new CustomEvent('dgj-task-end', {
        detail:{
          taskId:taskId,
          ok:!!ok,
          message:detail || '',
          result:taskId === 'returnBtn' ? _lastReturnWorkflowResult : null
        }
      }));
    } catch(eventError) {}
    if (taskId === 'returnBtn') {
      _forcedReturnTabId = 0;
      _forcedReturnExpectedPlatform = '';
    }
  }
}

// ====== LOG ======
function L(msg, c) {
  c = c || 'i';
  var t = new Date().toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit',second:'2-digit'});
  var d = document.createElement('div');
  d.className = c;
  d.textContent = '[' + t + '] ' + msg;
  lg.appendChild(d);
  lg.scrollTop = lg.scrollHeight;
  if (c === 'e') {
    var logPanel = document.querySelector('.log-panel');
    var logToggle = document.getElementById('logToggle');
    if (logPanel) logPanel.classList.add('expanded');
    if (logToggle) logToggle.textContent = '收起';
  }
  if (_activeTaskId) {
    var clean = String(msg || '').replace(/^=+\s*|\s*=+$/g, '').trim();
    if (clean) taskStep(clean, c === 'e' ? '发现错误' : c === 'w' ? '需要注意' : '实时处理中');
  }
}

// ====== STATS ======

function renderPendingStale(list){
  var c=document.getElementById('pendingStaleList'), cnt=document.getElementById('pendingStaleCount'), tot=document.getElementById('pendingStaleTotal');
  if(!c) return;
  list=list||[];
  if(tot) tot.textContent=list.length;
  if(cnt) cnt.textContent=list.length? list.length+' 条待确认' : '0 条';
  c.innerHTML='';
  if(!list.length){ c.innerHTML='<div style="padding:10px 12px;color:#64748b;font-size:11px">暂无 · 全部平台回传完后由采购确认</div>'; return; }
  var g={}; list.forEach(function(it){ (g[it.platform]=g[it.platform]||[]).push(it); });
  Object.keys(g).forEach(function(pl){
    var sec=document.createElement('div'); sec.style.cssText='margin:6px 0;padding:8px 10px;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.18);border-radius:10px';
    var h=document.createElement('div'); h.style.cssText='font-size:11px;font-weight:800;color:#92400e'; h.textContent=pl+' · '+g[pl].length+'条';
    sec.appendChild(h);
    g[pl].forEach(function(it){
      var row=document.createElement('div'); row.style.cssText='font-size:10px;color:#475569;margin:6px 0;padding:6px;background:#fff;border-radius:8px;border:1px solid #fde68a;display:flex;gap:8px;align-items:center';
      var img=document.createElement('img'); var src=it.attach||it.img||''; if(src){ img.src=src; img.style.cssText='width:48px;height:48px;object-fit:cover;border-radius:6px;border:1px solid #fde68a;flex-shrink:0'; img.onerror=function(){this.style.display='none'}; } else { img.style.display='none'; }
      var info=document.createElement('div'); info.style.cssText='flex:1;min-width:0;overflow:hidden';
      var line1=document.createElement('div'); line1.style.cssText='font-weight:700;color:#1e293b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'; line1.textContent=it.title;
      var line2=document.createElement('div'); line2.style.cssText='color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'; line2.textContent='PID:'+it.pid+(it.qty?'  ·  数量:'+it.qty:'')+(it.zone?'  ·  '+it.zone:'');
      var line3=document.createElement('div'); line3.style.cssText='color:#92400e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'; line3.textContent=it.spec.slice(0,120).replace(/\n/g,' | ');
      info.appendChild(line1); info.appendChild(line2); info.appendChild(line3);
      row.appendChild(img); row.appendChild(info);
      row.title=it.title+'\nPID:'+it.pid+'\n'+it.spec+'\n数量:'+(it.qty||'')+'\n图片:'+(it.img||'')+'\n记录:'+(it.recId||'');
      sec.appendChild(row);
    });
    c.appendChild(sec);
  });
}

function setStat(total, img) {
  if (total !== undefined) { statTotal.textContent = total; barTotal.style.width = Math.min(100, Math.round(total / Math.max(total,1) * 100)) + '%'; }
  if (img !== undefined) { statImg.textContent = img; barImg.style.width = Math.min(100, Math.round(img / Math.max(total||1,1) * 100)) + '%'; }
}

// ====== PROGRESS ======
function setProgress(pct, title, detail) {
  progressWrap.style.display = '';
  progressFill.style.width = pct + '%';
  progressPct.textContent = Math.round(pct) + '%';
  if (title) progressTitle.textContent = title;
  if (detail) progressDetail.textContent = detail;
  if (pct >= 100) progressTime.textContent = _startTime ? ((Date.now()-_startTime)/1000).toFixed(1)+'s' : '';
  if (_activeTaskId) taskStep(detail || title || '处理中', title || '实时进度', pct);
}
function hideProgress() { setTimeout(function(){ progressWrap.style.display='none'; }, 2000); }

// ====== STATUS ======
function setStatus(ok) {
  var dot = document.getElementById('dot');
  var stx = document.getElementById('stx');
  if (ok) {
    dot.className = 'dot on';
    statusBar.className = 'gl sts is-ok';
    stx.className = 'st on'; stx.textContent = '已连接';
    statusHint.textContent = '店管家备货单系统就绪';
  } else {
    dot.className = 'dot off';
    statusBar.className = 'gl sts is-err';
    stx.className = 'st off'; stx.textContent = '未连接';
    statusHint.textContent = '请打开店管家备货单页面';
  }
}

function doCheck() {
  chrome.tabs.query({active:true,currentWindow:true}, function(tabs) {
    var btn = document.getElementById('go');
    if (!tabs||!tabs.length||!tabs[0].url) { setStatus(false); btn.disabled=true; return; }
    var ok = /dgjapp\.com/.test(tabs[0].url);
    setStatus(ok);
    if (_activeTaskId !== 'go') btn.disabled = !ok;
  });
}
doCheck();
setInterval(doCheck, 3000);


// ====== TABLE SELECTOR ======
function loadTables() {
  var sel = document.getElementById('tableSelect');
  var sts = document.getElementById('tableStatus');
  if (!sel) return;
  sts.textContent = '加载中...';

  function _fail(msg) {
    sts.textContent = '加载失败';
    sel.innerHTML = '<option value="">加载失败</option>';
    L(msg, 'e');
  }

  getToken().then(function(t) {
    return feishuProxy(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables',
      'GET', {'Authorization': 'Bearer ' + t}
    );
  }).then(function(d) {
    if (!d || d.code !== 0 || !d.data || !d.data.items) {
      return _fail('表格列表API返回异常: ' + (d ? d.msg : 'null'));
    }
    var tables = d.data.items;
    sel.innerHTML = '';
    tables.forEach(function(tb) {
      var opt = document.createElement('option');
      opt.value = tb.table_id;
      opt.textContent = tb.name || tb.table_id;
      sel.appendChild(opt);
    });
    sts.textContent = tables.length + ' 个表格';
    chrome.storage.local.get('selectedTableId', function() {
      var idx = -1;
      for (var i = 0; i < sel.options.length; i++) {
        if (sel.options[i].value === TRANSFER_TABLE) { idx = i; break; }
      }
      if (idx < 0) {
        _fail('隔离中转站不存在，已停止所有业务写入: ' + TRANSFER_TABLE);
        return;
      }
      sel.selectedIndex = idx;
      TT = TRANSFER_TABLE;
      sel.disabled = true;
      sel.title = '业务写入已锁定到隔离中转站；正式采购表只能通过同步链路更新';
      chrome.storage.local.set({selectedTableId: TT});
      updateTableInfo(sel.options[idx].text, TT);
    });
  }).catch(function(e) {
    _fail('表格加载失败: ' + (e.message || e));
  });
}

function updateTableInfo(name, tid) {
  var info = document.getElementById('tableSelectedInfo');
  var cntEl = document.getElementById('tableRecordCount');
  if (info) info.textContent = name || tid;
  if (cntEl) {
    cntEl.textContent = '统计中...';
    getToken().then(function(t) {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + tid + '/records?page_size=1',
        'GET', {'Authorization': 'Bearer ' + t}
      );
    }).then(function(d) {
      if (d.code === 0 && d.data) {
        cntEl.textContent = (d.data.total || 0) + ' 条记录';
      } else {
        cntEl.textContent = '--';
      }
    }).catch(function(e) { cntEl.textContent = '统计失败'; L('表格统计失败: '+e.message,'w'); });
}
  }

var tableSelEl = document.getElementById('tableSelect');
if (tableSelEl) {
  tableSelEl.addEventListener('change', function() {
    this.value = TRANSFER_TABLE;
    TT = TRANSFER_TABLE;
    chrome.storage.local.set({selectedTableId: TRANSFER_TABLE});
    L('安全保护：业务写入目标固定为隔离中转站，不能切换到其他表', 'w');
  });
}

// Wake up background script early
try { chrome.runtime.sendMessage({type:'keepAlive', enable:true}); } catch(e) {}

setTimeout(function() {
  try { loadTables(); } catch(e) { 
    var sts = document.getElementById('tableStatus');
    if (sts) sts.textContent = '加载失败';
    console.error('[DGJ] loadTables error:', e);
  }
}, 500);
// Auto-retry after 8s if still stuck
setTimeout(function() {
  var sts = document.getElementById('tableStatus');
  if (sts && (sts.textContent === '检测中...' || sts.textContent === '加载中...')) {
    console.log('[DGJ] Table selector still stuck, retrying...');
    sts.textContent = '重试中...';
    loadTables();
  }
}, 8000);

// ====== TOKEN ======
// Direct fetch (extension pages bypass CORS via host_permissions)
function _directFetch(url, method, headers, body) {
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  var opts = { method: method || 'GET', headers: headers || {} };
  if (body && method !== 'GET') opts.body = body;
  if (ctrl) { opts.signal = ctrl.signal; }
  var timer = ctrl ? setTimeout(function() { ctrl.abort(); }, 30000) : null;
  return fetch(url, opts).then(function(r) {
    if (timer) clearTimeout(timer);
    if (!r.ok) return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ': ' + t.substring(0, 200)); });
    return r.json();
  }, function(e) {
    if (timer) clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('直连超时 (30s)');
    throw e;
  });
}

// Background script proxy (fallback)
function _bgProxy(url, method, headers, body) {
  return new Promise(function(resolve, reject) {
    var done = false;
    var timer = setTimeout(function() {
      if (!done) { done = true; reject(new Error('background超时 (30s)')); }
    }, 30000);
    try {
      chrome.runtime.sendMessage({
        type: 'feishuFetch', url: url, method: method || 'GET',
        headers: headers || {}, body: body || undefined
      }, function(resp) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (!resp) return reject(new Error('无响应 (background)'));
        if (!resp.ok) return reject(new Error(resp.error || 'API error'));
        resolve(resp.data);
      });
    } catch(e) {
      if (!done) { done = true; clearTimeout(timer); reject(new Error('消息发送失败: ' + e.message)); }
    }
  });
}

// Primary: direct fetch. Fallback: background proxy.
function feishuProxy(url, method, headers, body) {
  return _directFetch(url, method, headers, body).catch(function(err1) {
    console.warn('[DGJ] Direct fetch failed, trying background proxy:', err1.message);
    return _bgProxy(url, method, headers, body).catch(function(err2) {
      throw new Error('API请求失败: 直连=' + err1.message + ' | 代理=' + err2.message);
    });
  });
}
// V21.0.6: 带重试的飞书调用（429/5xx 指数退避，最多3次）
function feishuWithRetry(url, method, headers, body, retries){
  retries = retries==null?3:retries;
  return feishuProxy(url, method, headers, body).then(function(d){
    if(d && (d.code===429 || (d.code>=500 && d.code<600)) && retries>0){
      var delay = Math.pow(2, 3-retries)*400;
      return new Promise(function(r){ setTimeout(r, delay); }).then(function(){ return feishuWithRetry(url, method, headers, body, retries-1); });
    }
    return d;
  });
}

function getToken() {
  if (_token && Date.now() < _tokenExp) return Promise.resolve(_token);
  return feishuProxy(
    'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    'POST',
    {'Content-Type': 'application/json'},
    JSON.stringify({app_id:APP_ID, app_secret:APP_SECRET})
  ).then(function(d) {
    if (!d.tenant_access_token) throw new Error('Token获取失败: ' + (d.msg||d.code));
    _token = d.tenant_access_token;
    _tokenExp = Date.now() + (d.expire - 60) * 1000;
    return _token;
  });
}



// ====== RESOLVE WIKI TOKEN -> BITABLE APP TOKEN ======
var _bitableAppToken = null;
function getBitableAppToken() {
  if (_bitableAppToken) return Promise.resolve(_bitableAppToken);
  return getToken().then(function(t) {
    return feishuProxy(
      'https://open.feishu.cn/open-apis/wiki/v2/spaces/get_node?token=' + AT,
      'GET', {'Authorization': 'Bearer ' + t}
    );
  }).then(function(d) {
    if (d.code === 0 && d.data && d.data.node && d.data.node.obj_token) {
      _bitableAppToken = d.data.node.obj_token;
      console.log('[DGJ] Bitable app_token resolved:', _bitableAppToken);
      return _bitableAppToken;
    }
    // Fallback: try using AT directly (might already be bitable token)
    console.warn('[DGJ] Wiki resolve failed, using AT directly:', d.msg || d.code);
    _bitableAppToken = AT;
    return _bitableAppToken;
  }).catch(function(e) {
    console.warn('[DGJ] Wiki resolve error, using AT:', e.message);
    _bitableAppToken = AT;
    return _bitableAppToken;
  });
}

// ====== DETECT TABLE FIELDS ======
function detectTableFields(appToken, tableId) {
  return getToken().then(function(t) {
    return feishuProxy(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/fields?page_size=100',
      'GET', {'Authorization': 'Bearer ' + t}
    ).then(function(d) {
      if (d.code !== 0) throw new Error('字段检测失败: ' + d.msg);
      var fieldMap = {};
      (d.data.items || []).forEach(function(f) { fieldMap[f.field_name] = {id: f.field_id, type: f.type, name: f.field_name}; });
      return fieldMap;
    });
  });
}

// Smart field name resolver — finds the best match from available fields
function resolveField(fieldMap, candidates) {
  for (var i = 0; i < candidates.length; i++) {
    if (fieldMap[candidates[i]]) return candidates[i];
  }
  return null;
}
// Format value for field type — v19.92.0: type 1=text(plain string), type 15=URL({link,text})
function formatFieldValue(value, fieldType, fieldName) {
  if (typeof value !== 'string' || value.indexOf('http') !== 0) return value;
  if (fieldType === 15) {
    // URL field (type 15) needs {link, text} format
    return {link: value, text: value};
  }
  if (fieldType === 17) {
    // Attachment field — send as plain URL string
    return value;
  }
  // v19.92.0: Fallback heuristic — if field name contains URL/链接, treat as URL type
  if (fieldName && (/URL|url|链接|网址/i).test(fieldName)) {
    return {link: value, text: value};
  }
  // type 1 (text) or unknown — send as plain string, NOT {link, text}
  return value;
}


// ====== RETRY ======
function retryFetch(fn, retries, delay) {
  retries = retries || 2; delay = delay || 1000;
  return fn().catch(function(e) {
    if (retries <= 0) throw e;
    return new Promise(function(r){ setTimeout(function(){ r(retryFetch(fn, retries-1, delay*1.5)); }, delay); });
  });
}

// ====== ENSURE ATTACH FIELD ======
function ensureAttachField() {
  var ATTACH_FIELD = '📠 产品图';
  return getToken().then(function(t) {
    return feishuProxy(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + '/fields',
      'GET', {'Authorization':'Bearer '+t}
    );
  }).then(function(d) {
    if (d.code !== 0) throw new Error('获取字段失败: ' + (d.msg||d.code));
    var fields = d.data.items || [];
    var found = fields.find(function(f) { return f.field_name === ATTACH_FIELD; });
    if (found) return {ok:true, fieldId:found.field_id};
    // Create attachment field
    return getToken().then(function(t) {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + '/fields',
        'POST', {'Authorization':'Bearer '+t,'Content-Type':'application/json'},
        JSON.stringify({field_name:ATTACH_FIELD, type:17})
      );
    }).then(function(d2) {
      if (d2.code !== 0) throw new Error('创建附件字段失败: ' + (d2.msg||d2.code));
      return {ok:true, fieldId:d2.data.field.field_id};
    });
  });
}

// ====== SCRAPER v19.92.0 ======
function DGJ_SCRAPER(platformHint) {
  try {
    // === AUTO-DETECT PLATFORM + ACCOUNT (v19.92.0 — verified account identity) ===
    console.log('[DGJ] V20.16.0 SCRAPER START — platformHint=' + JSON.stringify(platformHint));
    var platformStr = '';
    var accountTail = '';
    var _platformHint = platformHint || '';
    var SUB_PLATFORMS = ['微信小店','快手小店','视频号','淘宝','快手'];  // sorted by length desc
    var MAIN_PLATFORMS = ['拼多多','京东','抖音','抖店'];  // no overlap issues

    // === POPUP DISMISSAL (v19.77.0) ===
    try {
      var dismissBtns = document.querySelectorAll('.el-message-box__btns button, .el-dialog__footer button, [class*="modal"] button, [class*="popup"] button');
      for (var di = 0; di < dismissBtns.length; di++) {
        var dt = dismissBtns[di].textContent.trim();
        if (dt === '知道了' || dt === '确定' || dt === '确认' || dt === '关闭' || dt === '我知道了') {
          dismissBtns[di].click();
        }
      }
      var closeBtns = document.querySelectorAll('.el-message-box__headerbtn, .el-dialog__headerbtn, [class*="close-btn"], [class*="close_icon"]');
      for (var ci = 0; ci < closeBtns.length; ci++) { closeBtns[ci].click(); }
    } catch(pe) { /* popup dismiss best-effort */ }

    try {
      // --- PLATFORM DETECTION ---
      // V20.16.0 Priority: URL token > select dropdown > active tab class > filter area > DOM scan

      // P0: URL token → account identity only (v20.12.16)
      // One account may have multiple platforms, so URL token cannot determine platform.
      // Platform is detected from DOM (P1-P4) where the UI already shows the selected platform.
      var URL_TOKEN_ACCOUNT_MAP = {
        '80ADDCEEADE51E1168049D66ECCCF2F9': '5820',
        'E9AD6D4CCE7DB911DC8FDE8A54EFF2C0': '7205',
        '382346A2BAB84AEA0060104B84DCD1DF': '7207'
      };
      try {
        var urlTokenMatch = window.location.href.match(/token=([A-Fa-f0-9]+)/i);
        if (urlTokenMatch) {
          var urlToken = urlTokenMatch[1].toUpperCase();
          var mappedAccount = URL_TOKEN_ACCOUNT_MAP[urlToken];
          if (mappedAccount) {
            accountTail = mappedAccount;
            console.log('[DGJ] P0 URL token → account=' + accountTail + ' (platform deferred to DOM)');
          }
        }
      } catch(urlErr) { /* fallback to DOM detection */ }

      // P1: <select> dropdown with selected option
      var selects = document.querySelectorAll('select');
      for (var si = 0; si < selects.length; si++) {
        var sel = selects[si];
        var opts = sel.querySelectorAll('option');
        for (var oi = 0; oi < opts.length; oi++) {
          if (opts[oi].selected) {
            var optText = opts[oi].textContent.trim();
            for (var pi = 0; pi < MAIN_PLATFORMS.length; pi++) {
              if (optText === MAIN_PLATFORMS[pi]) { platformStr = MAIN_PLATFORMS[pi]; break; }
            }
            for (var pi2 = 0; pi2 < SUB_PLATFORMS.length; pi2++) {
              if (optText === SUB_PLATFORMS[pi2]) { platformStr = SUB_PLATFORMS[pi2]; break; }
            }
            if (platformStr) break;
          }
        }
        if (platformStr) break;
      }

      // P2: Active tab with explicit class (is-active/active/aria-selected)
      if (!platformStr) {
        var tabEls = document.querySelectorAll('[class*="tab"],[role="tab"],.nav-item,.menu-item');
        for (var ti = 0; ti < tabEls.length; ti++) {
          var el = tabEls[ti];
          var isActive = el.classList.contains('is-active') || el.classList.contains('active') || el.getAttribute('aria-selected') === 'true';
          if (!isActive) continue;
          var tText = el.textContent.trim();
          if (tText.length > 30) continue;
          // Check main platforms
          for (var mp = 0; mp < MAIN_PLATFORMS.length; mp++) {
            if (tText === MAIN_PLATFORMS[mp] || tText.indexOf(MAIN_PLATFORMS[mp]) >= 0) {
              platformStr = MAIN_PLATFORMS[mp]; break;
            }
          }
          if (platformStr) break;
          // Check sub-platforms
          for (var sp = 0; sp < SUB_PLATFORMS.length; sp++) {
            if (tText === SUB_PLATFORMS[sp]) {
              platformStr = SUB_PLATFORMS[sp]; break;
            }
          }
          if (platformStr) break;
          // If active tab is "精选平台", find its active child
          if (tText.indexOf('精选平台') >= 0 || tText.indexOf('精选') >= 0) {
            var childTabs = el.parentElement ? el.parentElement.querySelectorAll('[class*="tab"],[role="tab"],span,a') : [];
            for (var ct = 0; ct < childTabs.length; ct++) {
              var ctActive = childTabs[ct].classList.contains('is-active') || childTabs[ct].classList.contains('active');
              if (!ctActive) continue;
              var ctText = childTabs[ct].textContent.trim();
              for (var sp2 = 0; sp2 < SUB_PLATFORMS.length; sp2++) {
                if (ctText === SUB_PLATFORMS[sp2]) {
                  platformStr = SUB_PLATFORMS[sp2]; break;
                }
              }
              if (platformStr) break;
            }
            if (platformStr) break;
          }
        }
      }

      // P3: Filter/dropdown area — find selected platform from filter row
      if (!platformStr) {
        // Look for dropdown/select elements in the filter area that show platform name
        var filterEls = document.querySelectorAll('.el-select,.el-dropdown,.filter-item,.search-item,[class*="filter"],[class*="search"]');
        for (var fi = 0; fi < filterEls.length; fi++) {
          var fText = filterEls[fi].textContent.trim();
          if (fText.length > 30) continue;
          for (var mp3 = 0; mp3 < MAIN_PLATFORMS.length; mp3++) {
            if (fText === MAIN_PLATFORMS[mp3]) { platformStr = MAIN_PLATFORMS[mp3]; break; }
          }
          for (var sp3 = 0; sp3 < SUB_PLATFORMS.length; sp3++) {
            if (fText === SUB_PLATFORMS[sp3]) { platformStr = SUB_PLATFORMS[sp3]; break; }
          }
          if (platformStr) break;
        }
      }

      // P4: Conservative DOM scan — only match exact platform names in small elements
      // with explicit active class (NOT just styling)
      if (!platformStr) {
        var scanEls = document.querySelectorAll('span,a,div,li,button');
        for (var si2 = 0; si2 < scanEls.length && si2 < 3000; si2++) {
          var sEl = scanEls[si2];
          // Must have explicit active class, not just styling
          var hasActiveClass = sEl.classList.contains('is-active') || sEl.classList.contains('active') || sEl.classList.contains('selected') || sEl.getAttribute('aria-selected') === 'true';
          if (!hasActiveClass) continue;
          var sText = sEl.textContent.trim();
          if (sText.length > 20 || sText.length < 2) continue;
          for (var mp4 = 0; mp4 < MAIN_PLATFORMS.length; mp4++) {
            if (sText === MAIN_PLATFORMS[mp4]) { platformStr = MAIN_PLATFORMS[mp4]; break; }
          }
          for (var sp4 = 0; sp4 < SUB_PLATFORMS.length; sp4++) {
            if (sText === SUB_PLATFORMS[sp4]) { platformStr = SUB_PLATFORMS[sp4]; break; }
          }
          if (platformStr) break;
        }
      }

      // Normalize
      if (platformStr === '抖店') platformStr = '抖音';
      if (platformStr.indexOf('微信小店') >= 0) platformStr = '微信小店';
      if (platformStr === '快手小店') platformStr = '快手小店'; // Keep as-is, it's a distinct platform

      // V20.16.0: Cross-frame platform detection
      // The platform selector lives in the parent frame; the data iframe can't see it.
      // Since allFrames uses world:"MAIN" (same-origin), iframe can access parent DOM.
      if (!platformStr && window !== window.top) {
        try {
          var parentDoc = window.parent.document;
          var MAIN_PF = ['拼多多','京东','抖音','抖店'];
          var SUB_PF = ['微信小店','快手小店','视频号','淘宝','快手'];
          
          // Check parent's active tabs
          var pTabs = parentDoc.querySelectorAll('[class*="tab"],[role="tab"],.nav-item,.menu-item');
          for (var pti = 0; pti < pTabs.length; pti++) {
            var pEl = pTabs[pti];
            var pActive = pEl.classList.contains('is-active') || pEl.classList.contains('active') || pEl.getAttribute('aria-selected') === 'true';
            if (!pActive) continue;
            var pText = pEl.textContent.trim();
            if (pText.length > 30) continue;
            for (var pmp = 0; pmp < MAIN_PF.length; pmp++) {
              if (pText === MAIN_PF[pmp] || pText.indexOf(MAIN_PF[pmp]) >= 0) { platformStr = MAIN_PF[pmp]; break; }
            }
            if (platformStr) break;
            for (var psp = 0; psp < SUB_PF.length; psp++) {
              if (pText === SUB_PF[psp]) { platformStr = SUB_PF[psp]; break; }
            }
            if (platformStr) break;
          }
          if (platformStr) console.log('[DGJ] Cross-frame parent DOM detected: ' + platformStr);
        } catch(parentErr) {
          console.log('[DGJ] Cross-frame parent access failed: ' + parentErr.message);
        }
      }
      
      // V20.16.1: localStorage 平台检测（调度器或其他实例可能已存储）
      if (!platformStr) {
        try {
          var _lsPlat = localStorage.getItem('dgj_lastPlatform');
          if (_lsPlat && _lsPlat !== '抖音') { // '抖音' alone is too ambiguous
            platformStr = _lsPlat;
            console.log('[DGJ] Platform from localStorage: ' + _lsPlat);
          }
          // Also check dgj_currentZone for 抖音 zone info
          if (!platformStr) {
            var _lsZone = localStorage.getItem('dgj_currentZone');
            var _lsZoneTime = parseInt(localStorage.getItem('dgj_zoneTime') || '0');
            if (_lsZone && (_lsZone === '一区' || _lsZone === '二区') && (Date.now() - _lsZoneTime) < 600000) {
              platformStr = '抖音' + _lsZone;
              console.log('[DGJ] Platform from localStorage zone: ' + platformStr);
            }
          }
          // Check dgj_lastDetect for combined platform+account
          if (!platformStr) {
            var _lsDetect = JSON.parse(localStorage.getItem('dgj_lastDetect') || '{}');
            if (_lsDetect.p && _lsDetect.p !== '抖音') {
              platformStr = _lsDetect.p;
              console.log('[DGJ] Platform from dgj_lastDetect: ' + _lsDetect.p);
            }
          }
        } catch(_lsPErr) {}
      }

      // V20.16.0: Final fallback — use platformHint when all DOM strategies fail
      if (!platformStr && _platformHint) {
        platformStr = _platformHint;
        console.log('[DGJ] DOM detection failed, using platformHint: ' + _platformHint);
      }

      // P4.5: Zone detection for 抖音 (7205/7207 accounts have 一区/二区)
      // V20.12.44: Enhanced zone detection with multiple fallback strategies
      if (platformStr === '抖音') {
        var zoneStr = '';
        
        // Strategy 1: Look for active zone elements with strict matching
        // V20.17.1: 优先检测活跃的zone元素，而不是记录第一个找到的
        var zoneCandidates = document.querySelectorAll('span, a, div, button, li, tab, [role="tab"]');
        var zoneFound = '';
        var zoneActiveFound = '';
        for (var zi = 0; zi < zoneCandidates.length; zi++) {
          var zEl = zoneCandidates[zi];
          var zText = zEl.textContent.trim();
          if (zText !== '一区' && zText !== '二区') continue;
          var zActive = zEl.classList.contains('is-active') || zEl.classList.contains('active') 
            || zEl.classList.contains('selected') || zEl.getAttribute('aria-selected') === 'true' 
            || zEl.classList.contains('is-checked') || zEl.classList.contains('checked')
            || zEl.classList.contains('current') || zEl.classList.contains('cur')
            || zEl.getAttribute('data-active') === 'true'
            || zEl.style.fontWeight === 'bold' || zEl.style.fontWeight >= 700
            || window.getComputedStyle(zEl).fontWeight >= 700;
          console.log('[DGJ] Zone candidate: text=' + zText + ' active=' + zActive + ' classes=' + zEl.className);
          if (zActive) { zoneActiveFound = zText; break; }
          if (!zoneFound) zoneFound = zText;
        }
        zoneStr = zoneActiveFound || zoneFound;
        
        // Strategy 1b: Look for zone in parent containers with active state
        if (!zoneStr) {
          var parentCandidates = document.querySelectorAll('.tab-item, .tab-pane, .menu-item, .nav-item, [class*="zone"], [class*="area"]');
          for (var pi = 0; pi < parentCandidates.length; pi++) {
            var pEl = parentCandidates[pi];
            var pText = pEl.textContent.trim();
            if (pText.indexOf('一区') < 0 && pText.indexOf('二区') < 0) continue;
            var pActive = pEl.classList.contains('is-active') || pEl.classList.contains('active') 
              || pEl.classList.contains('selected') || pEl.classList.contains('current')
              || pEl.getAttribute('aria-selected') === 'true';
            if (pActive) {
              zoneStr = pText.indexOf('一区') >= 0 ? '一区' : '二区';
              break;
            }
          }
        }
        
        // Strategy 1c: Check for zone indicator in iframe content
        if (!zoneStr) {
          try {
            var iframes = document.querySelectorAll('iframe');
            for (var ii = 0; ii < iframes.length; ii++) {
              try {
                var iframeDoc = iframes[ii].contentDocument || iframes[ii].contentWindow?.document;
                if (!iframeDoc) continue;
                var iframeZoneEls = iframeDoc.querySelectorAll('span, a, div, button, li');
                for (var iz = 0; iz < iframeZoneEls.length; iz++) {
                  var izText = iframeZoneEls[iz].textContent.trim();
                  if (izText !== '一区' && izText !== '二区') continue;
                  var izActive = iframeZoneEls[iz].classList.contains('is-active') || iframeZoneEls[iz].classList.contains('active')
                    || iframeZoneEls[iz].classList.contains('selected') || iframeZoneEls[iz].getAttribute('aria-selected') === 'true';
                  if (izActive) { zoneStr = izText; break; }
                }
                if (zoneStr) break;
              } catch(iframeErr) {}
            }
          } catch(iframeErr2) {}
        }
        // Strategy 2: Check URL parameters for zone hints
        if (!zoneStr) {
          try {
            var urlLower = window.location.href.toLowerCase();
            if (urlLower.indexOf('zone=1') >= 0 || urlLower.indexOf('area=1') >= 0 || urlLower.indexOf('district=1') >= 0) zoneStr = '一区';
            else if (urlLower.indexOf('zone=2') >= 0 || urlLower.indexOf('area=2') >= 0 || urlLower.indexOf('district=2') >= 0) zoneStr = '二区';
          } catch(ue) {}
        }
        // Strategy 3: Check breadcrumb or page header text
        if (!zoneStr) {
          try {
            var headerEls = document.querySelectorAll('h1, h2, h3, .breadcrumb, .page-header, .page-title, .title, .header');
            for (var hi = 0; hi < headerEls.length; hi++) {
              var hText = headerEls[hi].textContent;
              if (hText.indexOf('一区') >= 0) { zoneStr = '一区'; break; }
              if (hText.indexOf('二区') >= 0) { zoneStr = '二区'; break; }
            }
          } catch(he) {}
        }
        // Strategy 4: Check tab containers for zone indicators
        if (!zoneStr) {
          try {
            var tabContainers = document.querySelectorAll('.tab, .tabs, .tab-bar, .tab-nav, [role="tablist"], .ant-tabs, .el-tabs');
            for (var ti = 0; ti < tabContainers.length; ti++) {
              var tabText = tabContainers[ti].textContent;
              if (tabText.indexOf('一区') >= 0 || tabText.indexOf('二区') >= 0) {
                // Found zone tabs, check which is active
                var tabItems = tabContainers[ti].querySelectorAll('span, a, div, button, li');
                for (var tj = 0; tj < tabItems.length; tj++) {
                  var tItemText = tabItems[tj].textContent.trim();
                  if (tItemText !== '一区' && tItemText !== '二区') continue;
                  var tActive = tabItems[tj].classList.contains('is-active') || tabItems[tj].classList.contains('active') 
                    || tabItems[tj].classList.contains('selected') || tabItems[tj].getAttribute('aria-selected') === 'true'
                    || tabItems[tj].classList.contains('current') || tabItems[tj].classList.contains('cur');
                  if (tActive) { zoneStr = tItemText; break; }
                }
                if (zoneStr) break;
              }
            }
          } catch(te) {}
        }
        
        // Strategy 5: Check for zone-specific class names or data attributes
        if (!zoneStr) {
          try {
            var zoneIndicators = document.querySelectorAll('[class*="zone1"], [class*="zone2"], [class*="area1"], [class*="area2"], [data-zone], [data-area]');
            for (var zk = 0; zk < zoneIndicators.length; zk++) {
              var zClass = zoneIndicators[zk].className || '';
              var zData = zoneIndicators[zk].getAttribute('data-zone') || zoneIndicators[zk].getAttribute('data-area') || '';
              if (zClass.indexOf('zone1') >= 0 || zClass.indexOf('area1') >= 0 || zData === '1' || zData === '一区') {
                zoneStr = '一区'; break;
              }
              if (zClass.indexOf('zone2') >= 0 || zClass.indexOf('area2') >= 0 || zData === '2' || zData === '二区') {
                zoneStr = '二区'; break;
              }
            }
          } catch(ze) {}
        }
        
        // Strategy 6: Check page title or meta tags
        if (!zoneStr) {
          try {
            var pageTitle = document.title || '';
            if (pageTitle.indexOf('一区') >= 0) zoneStr = '一区';
            else if (pageTitle.indexOf('二区') >= 0) zoneStr = '二区';
            
            // Check meta tags
            if (!zoneStr) {
              var metas = document.querySelectorAll('meta');
              for (var mi = 0; mi < metas.length; mi++) {
                var metaContent = metas[mi].getAttribute('content') || '';
                if (metaContent.indexOf('一区') >= 0) { zoneStr = '一区'; break; }
                if (metaContent.indexOf('二区') >= 0) { zoneStr = '二区'; break; }
              }
            }
          } catch(me) {}
        }
        
        // Strategy 7: Check hidden inputs or form fields
        if (!zoneStr) {
          try {
            var inputs = document.querySelectorAll('input[type="hidden"], input[name*="zone"], input[name*="area"]');
            for (var ii = 0; ii < inputs.length; ii++) {
              var inputVal = inputs[ii].value || '';
              var inputName = inputs[ii].name || '';
              if (inputVal === '一区' || inputVal === '1' || inputName.indexOf('zone1') >= 0) {
                zoneStr = '一区'; break;
              }
              if (inputVal === '二区' || inputVal === '2' || inputName.indexOf('zone2') >= 0) {
                zoneStr = '二区'; break;
              }
            }
          } catch(ie) {}
        }
        
        // Strategy 8: Check for zone-specific URLs in links
        if (!zoneStr) {
          try {
            var links = document.querySelectorAll('a[href]');
            for (var li = 0; li < links.length; li++) {
              var href = links[li].href || '';
              var linkText = links[li].textContent.trim();
              if ((href.indexOf('zone=1') >= 0 || href.indexOf('area=1') >= 0) && linkText.indexOf('一区') >= 0) {
                zoneStr = '一区'; break;
              }
              if ((href.indexOf('zone=2') >= 0 || href.indexOf('area=2') >= 0) && linkText.indexOf('二区') >= 0) {
                zoneStr = '二区'; break;
              }
            }
          } catch(le) {}
        }
        
        // V20.12.62: Strategy 7 — Check PARENT FRAME for zone indicators
        // The zone tabs (一区/二区) are in the parent frame, not the data iframe
        if (!zoneStr && window !== window.top) {
          try {
            var parentDoc = window.parent.document;
            var parentAll = parentDoc.querySelectorAll('span, a, div, button, li, [role="tab"]');
            for (var pz = 0; pz < parentAll.length; pz++) {
              var pzText = parentAll[pz].textContent.trim();
              if (pzText !== '一区' && pzText !== '二区') continue;
              // Check element AND its parent for active state
              // Zone tab structure: <div class="is-active"><span>一区</span></div>
              var pzEl = parentAll[pz];
              var pzActive = pzEl.classList.contains('is-active') || pzEl.classList.contains('active')
                || pzEl.classList.contains('selected') || pzEl.getAttribute('aria-selected') === 'true'
                || pzEl.classList.contains('is-checked') || pzEl.classList.contains('checked')
                || pzEl.classList.contains('current') || pzEl.classList.contains('cur')
                || window.getComputedStyle(pzEl).fontWeight >= 700;
              // Also check parent container (2 levels up)
              if (!pzActive && pzEl.parentElement) {
                var pp = pzEl.parentElement;
                pzActive = pp.classList.contains('is-active') || pp.classList.contains('active')
                  || pp.classList.contains('selected') || pp.classList.contains('current');
              }
              if (!pzActive && pzEl.parentElement && pzEl.parentElement.parentElement) {
                var pp2 = pzEl.parentElement.parentElement;
                pzActive = pp2.classList.contains('is-active') || pp2.classList.contains('active')
                  || pp2.classList.contains('selected');
              }
              console.log('[DGJ] Parent frame zone check: text=' + pzText + ' active=' + pzActive + ' classes=' + pzEl.className);
              if (pzActive) { zoneStr = pzText; console.log('[DGJ] Parent frame zone detected (active): ' + pzText); break; }
              // V20.17.2: 记录所有候选，但优先使用活跃的
              if (!zoneStr) { zoneStr = pzText; console.log('[DGJ] Parent frame zone candidate (no active): ' + pzText); }
            }
          } catch(pzErr) {
            console.log('[DGJ] Parent frame zone detection failed: ' + pzErr.message);
          }
        }

        // Strategy 8: Full parent frame text scan — look for 一区/二区 anywhere
        if (!zoneStr && window !== window.top) {
          try {
            var parentText = window.parent.document.body ? window.parent.document.body.textContent : '';
            if (parentText.indexOf('一区') >= 0 && parentText.indexOf('二区') < 0) {
              zoneStr = '一区'; console.log('[DGJ] Parent text scan: only 一区 found');
            } else if (parentText.indexOf('二区') >= 0 && parentText.indexOf('一区') < 0) {
              zoneStr = '二区'; console.log('[DGJ] Parent text scan: only 二区 found');
            }
            // Both found — can't determine from text alone
          } catch(ptErr) {}
        }

        // V20.12.62: Strategy 9 — Read zone from localStorage (set by Phase 2 parent frame)
        if (!zoneStr) {
          try {
            var _lsZone = localStorage.getItem('dgj_currentZone');
            var _lsZoneTime = parseInt(localStorage.getItem('dgj_zoneTime') || '0');
            if (_lsZone && (_lsZone === '一区' || _lsZone === '二区') && (Date.now() - _lsZoneTime) < 300000) {
              zoneStr = _lsZone;
              console.log('[DGJ] Zone from Phase 2 localStorage: ' + _lsZone);
            }
          } catch(_lszErr) {}
        }

        if (zoneStr) platformStr = '抖音' + zoneStr;
        // V20.16.4: 改进zone fallback逻辑
        // 如果DOM zone检测失败，尝试从platformHint中提取zone
        if (!zoneStr && _platformHint && _platformHint.indexOf('抖音') >= 0) {
          // 如果platformHint包含zone信息（如"抖音一区"），直接使用
          if (_platformHint.indexOf('一区') >= 0 || _platformHint.indexOf('二区') >= 0) {
            platformStr = _platformHint;
            console.log('[DGJ] Zone detection failed, using platformHint with zone: ' + _platformHint);
          } else {
            // 如果platformHint没有zone信息，尝试从标签页标题中提取
            try {
              var _tabTitle = document.title || '';
              if (_tabTitle.indexOf('一区') >= 0) {
                platformStr = '抖音一区';
                console.log('[DGJ] Zone from page title: 一区');
              } else if (_tabTitle.indexOf('二区') >= 0) {
                platformStr = '抖音二区';
                console.log('[DGJ] Zone from page title: 二区');
              } else {
                platformStr = _platformHint;
                console.log('[DGJ] Zone detection failed, using platformHint: ' + _platformHint);
              }
            } catch(e) {
              platformStr = _platformHint;
              console.log('[DGJ] Zone detection failed, using platformHint: ' + _platformHint);
            }
          }
        }
        // V20.12.59: If DOM found just "抖音" (no zone) but hint has zone, prefer hint
        if (platformStr === '抖音' && _platformHint && _platformHint.length > 2 && _platformHint !== '抖音') {
          platformStr = _platformHint;
          console.log('[DGJ] DOM found bare platform, upgrading to hint: ' + _platformHint);
        }
        // V20.12.62: Read PAGE localStorage for last confirmed zone (most reliable fallback)
        // After every successful upload, we store the confirmed zone in dgjZoneHistory_<tail>.
        // On next scrape, if zone detection fails, use the last confirmed zone.
        if (!zoneStr && platformStr === '抖音' && accountTail) {
          try {
            var _zlKey = 'dgjZoneHistory_' + accountTail;
            var _zlHist = JSON.parse(localStorage.getItem(_zlKey) || '{}');
            var _zlBest = '', _zlBestTime = 0;
            Object.keys(_zlHist).forEach(function(z) {
              if (z.indexOf('抖音') !== 0 || z.length <= 2) return; // must start with 抖音 and have zone suffix
              if (_zlHist[z] > _zlBestTime) { _zlBestTime = _zlHist[z]; _zlBest = z; }
            });
            if (_zlBest && (Date.now() - _zlBestTime) < 3600000) { // within last hour
              platformStr = _zlBest;
              console.log('[DGJ] Zone from PAGE localStorage history: ' + _zlBest + ' (age: ' + Math.round((Date.now() - _zlBestTime) / 60000) + 'min)');
            }
          } catch(zlErr) {}
        }
        // V20.10.2: Record zone detection history for fallback inference
        if (zoneStr) {
          try {
            var _zhKey = 'dgjZoneHistory_' + (typeof accountTail !== 'undefined' ? accountTail : '');
            if (_zhKey.length > 20) {
              var _zh = JSON.parse(localStorage.getItem(_zhKey) || '{}');
              // v20.12.33: Store full platform+zone name for correct zone inference
              _zh[platformStr + (zoneStr || '')] = Date.now();
              localStorage.setItem(_zhKey, JSON.stringify(_zh));
            }
          } catch(zhe) {}
        }
      }


      // P5: URL token → reliable account tail detection (v19.77.0)
      // The URL token is stable and maps 1:1 to accounts, unlike UI elements
      if (!accountTail) {
        try {
          var currentUrl = window.location.href;
          var urlTokenMatch = currentUrl.match(/token=([A-Fa-f0-9]+)/i);
          if (urlTokenMatch) {
            var urlToken = urlTokenMatch[1].toUpperCase();
            var URL_TOKEN_TAIL_MAP = {
              'E9AD6D4CCE7DB911DC8FDE8A54EFF2C0': '7205',
              '382346A2BAB84AEA0060104B84DCD1DF': '7207',
              '80ADDCEEADE51E1168049D66ECCCF2F9': '5820'
            };
            if (URL_TOKEN_TAIL_MAP[urlToken]) {
              accountTail = URL_TOKEN_TAIL_MAP[urlToken];
              console.log('[DGJ] P5 URL token → accountTail=' + accountTail);
            }
          }
        } catch(ue) { /* URL parse best-effort */ }
      }

      // --- ACCOUNT TAIL DETECTION (v19.31.2) ---
      // Do not accept an arbitrary page number as the account.  The old broad DOM
      // scan could find an unrelated number (for example 8202) before the header,
      // causing every returned record to be assigned to the wrong platform account.
      // First resolve the three known 店管家 accounts from stable identity text.
      var ACCOUNT_PROFILES = [
        {tail: '7205', keys: ['13819927205', '豆子']},
        {tail: '7207', keys: ['15381777207', 'A售后', '多行全品爆款']},
        {tail: '5820', keys: ['17538525820', '主账号']}
      ];
      var headerIdentityEl = document.querySelector('header,.header,[class*="header"],[class*="navbar"]');
      var identityText = ((document.title || '') + '\n' + (headerIdentityEl ? headerIdentityEl.textContent : '')).replace(/\s+/g, ' ');
      for (var ai = 0; ai < ACCOUNT_PROFILES.length; ai++) {
        var profile = ACCOUNT_PROFILES[ai];
        for (var ak = 0; ak < profile.keys.length; ak++) {
          if (identityText.indexOf(profile.keys[ak]) >= 0) {
            accountTail = profile.tail;
            break;
          }
        }
        if (accountTail) break;
      }

      // For a future, unconfigured account, only trust an explicit phone-number
      // identity rendered in the actual header.  Never fall back to URL tokens or
      // a full-page number scan: those values are not account identifiers.
      // Known valid mobile prefixes for Chinese carriers
      var VALID_PREFIX = /^(13[0-9]|14[0-9]|15[0-9]|16[0-9]|17[0-9]|18[0-9]|19[0-9])/;
      var KNOWN_TAILS = {'7205':1,'7207':1,'5820':1};
      var PHONE_RE = /(1\d{10})\[([^\]]+)\]/g;
      var PHONE_ONLY = /(1\d{10})/g;
      if (!accountTail) {
        var headerEl = document.querySelector('header,.header,[class*="header"],[class*="navbar"],[class*="top-bar"]');
        var bodyText = headerEl ? headerEl.textContent : '';
        PHONE_RE.lastIndex = 0;
        var bm = PHONE_RE.exec(bodyText);
        if (bm && VALID_PREFIX.test(bm[1])) {
          var tail4 = bm[1].slice(-4);
          if (KNOWN_TAILS[tail4]) accountTail = tail4;
        }
        if (!accountTail) {
          PHONE_ONLY.lastIndex = 0;
          var bp = PHONE_ONLY.exec(bodyText);
          if (bp && VALID_PREFIX.test(bp[1])) {
            var tail4b = bp[1].slice(-4);
            if (KNOWN_TAILS[tail4b]) accountTail = tail4b;
          }
        }
      }

    } catch(e) { console.log('[DGJ] 检测异常: ' + e.message); }

    // Combine: "平台-【尾号】"
    var platformField = '';
    if (platformStr && accountTail) {
      platformField = platformStr + '-【' + accountTail + '】';
    }
    // V20.12.62: MERGE detected platform+account with existing localStorage
    // Multiple frames run independently — parent has platform+zone, data iframe has account.
    // Platform: always overwrite (zone changes when user switches tabs)
    // Account: fill if missing (URL-based, consistent across frames)
    try {
      var _existing = {};
      try { _existing = JSON.parse(localStorage.getItem('dgj_lastDetect') || '{}'); } catch(e) {}
      var _p = platformStr || _existing.p || '';
      var _a = accountTail || _existing.a || '';
      if (_p || _a) {
        localStorage.setItem('dgj_lastDetect', JSON.stringify({p:_p, a:_a, ts:Date.now()}));
        if (_p) localStorage.setItem('dgj_lastPlatform', _p);
        if (_a) localStorage.setItem('dgj_lastAccount', _a);
      }
    } catch(lsErr) {}
    
    // V20.12.60: If still no platform, try reading from localStorage (set by parent frame)
    if (!platformStr) {
      try {
        var lsPlatform = localStorage.getItem('dgj_lastPlatform');
        if (lsPlatform) {
          platformStr = lsPlatform;
          console.log('[DGJ] Cross-frame localStorage detected: ' + platformStr);
        }
      } catch(lsErr2) {}
    }
    
    // Rebuild platformField after all fallbacks
    if (platformStr && accountTail) {
      platformField = platformStr + '-【' + accountTail + '】';
    }
    
    console.log('[DGJ] V20.16.3 平台检测: platform=' + platformStr + ' account=' + accountTail + ' hint=' + _platformHint + ' -> ' + platformField);
    // V20.16.3: 详细平台检测日志
    console.log('[DGJ]   URL: ' + window.location.href.substring(0, 80));
    console.log('[DGJ]   frame: ' + (window === window.top ? 'top' : 'iframe'));
    console.log('[DGJ]   bodyLen: ' + (document.body ? document.body.textContent.length : 0));
    console.log('[DGJ]   tables: ' + document.querySelectorAll('table').length);
    console.log('[DGJ]   inputs: ' + document.querySelectorAll('input').length);
    // Find table
    var table = document.querySelector('.purchasesSet_table_content') || document.querySelector('.stockup_table_content');
    if (!table) {
      var tables = document.querySelectorAll('table');
      var best = 0;
      for (var i=0; i<tables.length; i++) {
        var rc = tables[i].querySelectorAll('tr').length;
        if (rc > best) { best = rc; table = tables[i]; }
      }
    }
    if (!table) return {items:[], debug:'no_table_found', platform: platformField, platformName: platformStr, accountTail: accountTail, tableVisible:false};
    var tableRect = table.getBoundingClientRect();
    var tableStyle = window.getComputedStyle(table);
    var tableVisible = tableRect.width > 0 && tableRect.height > 0
      && tableStyle.display !== 'none' && tableStyle.visibility !== 'hidden';

    var rows = table.querySelectorAll('tbody tr');
    if (!rows.length) rows = table.querySelectorAll('tr');
    var items = [];

    // v19.92.0: Detect column mapping from header row
    var COL_PID = -1, COL_IMG = -1, COL_TITLE = -1, COL_SPEC = -1;
    var headerRow = table.querySelector('thead tr, tr:first-child');
    if (headerRow) {
      var headerCells = headerRow.querySelectorAll('th, td');
      for (var hi = 0; hi < headerCells.length; hi++) {
        var hText = headerCells[hi].textContent.trim();
        if (hText.indexOf('商品ID') >= 0 || hText.indexOf('货号') >= 0 || hText.indexOf('商品编码') >= 0) COL_PID = hi;
        if (hText.indexOf('商品图片') >= 0 || hText.indexOf('主图') >= 0) COL_IMG = hi;
        if (hText.indexOf('商品标题') >= 0 || hText.indexOf('商品全称') >= 0 || hText.indexOf('标题') >= 0) COL_TITLE = hi;
        if (hText.indexOf('规格') >= 0 || hText.indexOf('颜色') >= 0 || hText.indexOf('属性') >= 0) COL_SPEC = hi;
      }
    }
    // Fallback: use fixed column mapping if header detection failed
    if (COL_PID < 0) COL_PID = 4;
    if (COL_IMG < 0) COL_IMG = 1;
    if (COL_TITLE < 0) COL_TITLE = 2;
    if (COL_SPEC < 0) COL_SPEC = 3;

    for (var ri=0; ri<rows.length; ri++) {
      var cells = rows[ri].querySelectorAll('td');
      if (cells.length < 5) continue;

      // PID: try detected column first, then scan all cells for a valid PID
      var pid = '';
      if (COL_PID >= 0 && cells[COL_PID]) {
        var pidCell = cells[COL_PID].textContent.trim();
        var pureDigits = pidCell.replace(/[^\d]/g, '');
        var pidMatch = pureDigits.match(/^(\d{10,20})/);
        pid = pidMatch ? pidMatch[1] : '';
      }
      // Fallback: scan all cells for a valid PID
      if (!pid) {
        for (var ci = 0; ci < cells.length; ci++) {
          var cellText = cells[ci].textContent.trim();
          var digits = cellText.replace(/[^\d]/g, '');
          var m = digits.match(/^(\d{10,20})/);
          if (m && m[1]) { pid = m[1]; break; }
        }
      }
      if (!pid) continue;

      // Image v19.97: prefer the already-rendered thumbnail. Large lazy-load
      // originals can be several MB and are much less stable on WeChat's CDN.
      function pickImageUrl(el) {
        if (!el) return '';
        var srcset = el.getAttribute('data-srcset') || el.getAttribute('srcset') || '';
        var srcsetDisplay = '';
        if (srcset) {
          var srcsetParts = srcset.split(',');
          srcsetDisplay = (srcsetParts[0] || '').trim().split(/\s+/)[0] || '';
        }
        var candidates = [
          el.currentSrc,
          el.getAttribute('src'),
          srcsetDisplay,
          el.getAttribute('data-src'),
          el.getAttribute('data-lazy-src'),
          el.getAttribute('data-url'),
          el.getAttribute('data-original'),
          el.getAttribute('data-origin'),
          el.src
        ];
        for (var pi = 0; pi < candidates.length; pi++) {
          var candidate = String(candidates[pi] || '').trim().replace(/&amp;/g, '&');
          if (!candidate || /^data:|^blob:/i.test(candidate)) continue;
          if (/placeholder|transparent|loading(?:[._-]|$)|blank(?:[._-]|$)|spacer(?:[._-]|$)/i.test(candidate)) continue;
          if (candidate.indexOf('//') === 0) candidate = location.protocol + candidate;
          try { candidate = new URL(candidate, location.href).href; } catch(e) {}
          if (/^https?:\/\//i.test(candidate)) return candidate;
        }
        return '';
      }

      // Image: try detected column, then scan for img tags
      var img = '';
      if (COL_IMG >= 0 && cells[COL_IMG]) {
        var imgEl = cells[COL_IMG].querySelector('img');
        if (imgEl) img = pickImageUrl(imgEl);
      }
      if (!img) {
        for (var ii = 0; ii < cells.length; ii++) {
          var ie = cells[ii].querySelector('img');
          if (ie) {
            img = pickImageUrl(ie);
            if (img) break;
          }
        }
      }

      // Title: try detected column, then look for longest text
      var title = '';
      if (COL_TITLE >= 0 && cells[COL_TITLE]) {
        title = cells[COL_TITLE].textContent.trim().replace(/\s+/g,' ');
      }
      if (!title || title.length < 3) {
        var maxLen = 0;
        for (var ti = 0; ti < cells.length; ti++) {
          var t = cells[ti].textContent.trim().replace(/\s+/g,' ');
          // Skip cells that are mostly digits or very short
          if (t.length > maxLen && t.length > 5 && !/^\d+$/.test(t)) {
            maxLen = t.length;
            title = t;
          }
        }
      }

      // Parse specs
      var specs = [];
      var specCell = cells[COL_SPEC] || cells[3];
      if (specCell) {
        var specDivs = specCell.querySelectorAll('div');
        for (var s=0; s<specDivs.length; s++) {
          var sd = specDivs[s];
          var cntSpan = sd.querySelector('.countNum') || sd.querySelector('[class*="count"]');
          var qty = cntSpan ? (Number(cntSpan.textContent.trim())||0) : 0;
          var specName = '';
          for (var n=0; n<sd.childNodes.length; n++) {
            if (sd.childNodes[n].nodeType===3) {
              var t = sd.childNodes[n].textContent.trim();
              if (t) { specName = t; break; }
            }
          }
          if (!specName) specName = sd.textContent.replace(cntSpan?cntSpan.textContent:'','').trim();
          specName = specName.replace(/^[;\s]+/,'').replace(/[;\s]+$/,'');
          if (specName||qty>0) specs.push({name:specName, qty:qty});
        }
        // Fallback text parse
        if (!specs.length) {
          var raw = cells[3].textContent.trim();
          var parts = raw.split(/[;\uff1b]/).filter(function(p){return p.trim();});
          if (parts.length >= 2) {
            var last = Number(parts[parts.length-1].trim());
            if (!isNaN(last) && last>=0 && last<=99999) {
              specs.push({name:parts.slice(0,-1).join(';').trim(), qty:last});
            } else {
              parts.forEach(function(p){ specs.push({name:p.trim(),qty:0}); });
            }
          } else if (raw) { specs.push({name:raw,qty:0}); }
        }
      }
      items.push({productId:pid, title:title, imgSrc:img, specs:specs, platform: platformField});
    }
    return {items:items, total:items.length, debug:'raw:'+items.length, platform: platformField, platformName: platformStr, accountTail: accountTail, tableVisible:tableVisible};
  } catch(e) { return {items:[], debug:'error:'+e.message}; }
}
// ====== MERGE v19.92.0 (PID + 标题合并) ======
function normTitle(t) {
  var n = (t || '').replace(/\s+/g, '').toLowerCase();
  // Strip trailing suffix variants: -x, -T, -a, -1, -2, etc. (single char after last dash)
  n = n.replace(/-([a-z0-9])$/i, '');
  // Strip trailing 【...】 spec hints for matching
  n = n.replace(/【[^】]*】/g, '');
  return n;
}

function mergeItems(items) {
  // Step 1: Merge by PID (same PID = same product, combine specs)
  var byPid = {}, pidOrder = [];
  items.forEach(function(it) {
    var pid = it.productId || '';
    if (!pid) return;
    var b = byPid[pid];
    if (!b) { b = {productId:pid,title:it.title,imgSrc:it.imgSrc,specs:{},specOrder:[],platform:it.platform||''}; byPid[pid]=b; pidOrder.push(pid); }
    if (!b.imgSrc && it.imgSrc) b.imgSrc = it.imgSrc;
    if (!b.title && it.title) b.title = it.title;
    if (!b.platform && it.platform) b.platform = it.platform;
    (it.specs||[]).forEach(function(sp) {
      if (!sp||!sp.name) return;
      if (!b.specs[sp.name]) { b.specs[sp.name]=0; b.specOrder.push(sp.name); }
      b.specs[sp.name] += (sp.qty||0);
    });
  });

  pidOrder.forEach(function(pid) {
    byPid[pid].specStr = byPid[pid].specOrder.map(function(n){return n+';'+byPid[pid].specs[n];}).join('\n');
  });

  // Step 2: Merge by title (same title = same product across different PIDs)
  var byTitle = {}, titleOrder = [];
  pidOrder.forEach(function(pid) {
    var x = byPid[pid];
    var tn = normTitle(x.title);
    if (!tn) { titleOrder.push(pid); return; }
    // Bracket contents may carry a real model/category even though title
    // normalization removes them. Keep those discriminators in the exact-title
    // key so [S24] and [S25], or phone/stove brackets, cannot collapse early.
    var modelKey = Object.keys(procurementModelTokens(x.title)).sort().join('|');
    var familyKey = Object.keys(procurementProductFamilies(x.title, x.specStr)).sort().join('|');
    var safeTitleKey = tn + '::M:' + modelKey + '::F:' + familyKey;
    if (!byTitle[safeTitleKey]) { byTitle[safeTitleKey] = []; titleOrder.push(safeTitleKey); }
    byTitle[safeTitleKey].push(x);
  });

  var merged = [];
  titleOrder.forEach(function(key) {
    if (byTitle[key]) {
      // Multiple PIDs with same title — merge into one record
      var group = byTitle[key];
      if (group.length === 1) {
        var g = group[0];
        merged.push({title:g.title, productId:g.productId, imgSrc:g.imgSrc, specStr:g.specStr, platform:(g.platform||'').split(/\n/)[0].trim()});
      } else {
        // Merge: combine PIDs, specs, images
        var pids = [], titles = [], img = '', allSpecs = {}, specOrder = [], platforms = {};
        group.forEach(function(g) {
          if (g.productId) pids.push(g.productId);
          if (g.title && titles.indexOf(g.title) < 0) titles.push(g.title);
          if (!img && g.imgSrc) img = g.imgSrc;
          if (g.platform) platforms[g.platform.split(/\n/)[0].trim()] = 1;
          (g.specOrder||[]).forEach(function(n) {
            if (!allSpecs[n]) { allSpecs[n]=0; specOrder.push(n); }
            allSpecs[n] += (g.specs[n]||0);
          });
        });
        var specStr = specOrder.map(function(n){return n+';'+allSpecs[n];}).join('\n');
        var plat = Object.keys(platforms).join('\n');
        merged.push({
          title: titles[0] || '',
          productId: pids.join('\n'),
          imgSrc: img,
          specStr: specStr,
          platform: plat.split(/\n/)[0].trim()
        });
      }
    } else {
      // No title — keep as-is (PID-only item)
      var x = byPid[key];
      if (x) merged.push({title:x.title, productId:x.productId, imgSrc:x.imgSrc, specStr:x.specStr, platform:(x.platform||'').split(/\n/)[0].trim()});
    }
  });
  return merged;
}

// ====== FEISHU BATCH CREATE ======
// Cached field map for batch create
var _fieldMapCache = null, _fieldMapTs = 0;
function getFieldMap() {
  if (_fieldMapCache && Date.now() - _fieldMapTs < 300000) return Promise.resolve(_fieldMapCache);
  return detectTableFields(AT, typeof TT !== "undefined" ? TT : RAW_TABLE).then(function(fm) {
    _fieldMapCache = fm; _fieldMapTs = Date.now();
    return fm;
  });
}
function feishuBatchCreate(records) {
  // v19.78.0: Direct upload - no pre-read (user uses fresh table daily)
  // Smart merge happens in returnToFeishu (afternoon return mode)
  return getFieldMap().then(function(fm) {
    var FT = resolveField(fm, ['\ud83d\udce1 商品全称', '商品全称', '商品标题']);
    var FP = resolveField(fm, ['\ud83d\udd17 商品ID', '商品 \ud83c\udd94', '商品ID', '商品 ID']);
    var FS = resolveField(fm, ['\ud83d\udea7 \u2757【时段】产品需求值', '\u2757【时段】产品需求值', '产品需求值', '规格需求']);
    var FI = resolveField(fm, ['\ud83d\uddec 产品图URL', '图片URL', '【图片URL】']);
    var FST = resolveField(fm, ['手动传输状态', '状态', '\ud83d\ude8c 状态\ud83c\udf05']);
    var FD = resolveField(fm, ['\ud83d\udcc5 抓取日期', '创建时间', '\ud83c\udfd7 【创建/绑定】日期', '创建时间引导']);
    var FP2 = resolveField(fm, ['平台所属账号', '平台【文字】', '平台', '平台文字']);
    L('上传字段: T='+(FT||'?')+' P='+(FP||'?')+' S='+(FS||'?')+' I='+(FI||'?')+' ST='+(FST||'?')+' D='+(FD||'?')+' PL='+(FP2||'?'), 'i');
    return getToken().then(function(t) {
      var recs = records.map(function(r) {
        var f = {};
        if (FT) f[FT] = r.title || '';
        if (FP) f[FP] = r.productId || '';
        if (FS) f[FS] = r.specStr || '';
        if (FI && r.imgSrc && r.imgSrc.indexOf('http') === 0) f[FI] = formatFieldValue(r.imgSrc, fm[FI] ? fm[FI].type : 1, FI);
        if (FST) f[FST] = '未打单';
        if (FD) { var fdType = fm[FD] ? fm[FD].type : 0; if (fdType === 5 || fdType === 23 || fdType === 24 || fdType === 0) f[FD] = Date.now(); else f[FD] = new Date().toISOString().split('T')[0]; }
        if (FP2 && r.platform) f[FP2] = dedupPlatform(r.platform);
        var F_PLAT_SEL = resolveField(fm, ['平台']);
        if (F_PLAT_SEL && F_PLAT_SEL !== FP2 && r.platform) {
          var _pt = fm[F_PLAT_SEL] ? fm[F_PLAT_SEL].type : 0;
          if (_pt !== 20 && _pt !== 1001) { var platName = r.platform.split('-【')[0].trim(); if (platName) f[F_PLAT_SEL] = platName; }
        }
        var F_DGJ = resolveField(fm, ['店管家']);
        if (F_DGJ && r.platform) {
          var _dt = fm[F_DGJ] ? fm[F_DGJ].type : 0;
          if (_dt !== 20 && _dt !== 1001) { var dgjMatch = r.platform.match(/【(\d{4})】/); if (dgjMatch) f[F_DGJ] = dgjMatch[1]; }
        }
        return {fields:f};
      });
      return retryFetch(function() {
        return feishuProxy(
          'https://open.feishu.cn/open-apis/bitable/v1/apps/'+AT+'/tables/'+(typeof TT !== 'undefined' ? TT : RAW_TABLE)+'/records/batch_create',
          'POST', {'Authorization':'Bearer '+t,'Content-Type':'application/json'},
          JSON.stringify({records:recs})
        );
      }, 2, 1500);
    });
  });
}

// ====== MORNING IDEMPOTENT UPSERT v20.3.1 ======
// A same-day rerun replaces the estimate for this exact platform account.
// Printed actual rows are protected from an accidental morning rerun.
function businessDateTimestamp(value) {
  if (typeof value === 'number' && isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    var s = value.trim();
    // 纯日期 "yyyy-MM-dd"：按本地时区解析为当天 00:00，
    // 避免 Date.parse 按 UTC 解析导致 UTC+8 地区偏前一天（日期乱选的根因）。
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) {
      var local = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      return isNaN(local.getTime()) ? 0 : local.getTime();
    }
    var parsed = Date.parse(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

function isTodayBusinessValue(value) {
  var ts = businessDateTimestamp(value);
  if (!ts) return false;
  var start = new Date();
  start.setHours(0, 0, 0, 0);
  return ts >= start.getTime() && ts < start.getTime() + 86400000;
}

function businessPidList(value) {
  var seen = {}, out = [];
  String(value || '').split(/[\n,]/).forEach(function(pid) {
    pid = pid.trim();
    if (pid && !seen[pid]) { seen[pid] = 1; out.push(pid); }
  });
  return out;
}

function selectStalePlatformSourceIds(existing, platformField, confirmedPlatform, seenRecords, dateField, statusField) {
  // v20.12.58: Built-in status protection — never mark "未打单" records as stale.
  // These are morning estimates that have not been printed yet. Deleting them
  // would prevent the procurement table from ever updating their status.
  var staleIds = [];
  var preservedCount = 0;
  (existing || []).forEach(function(rec) {
    var fields = rec.fields || {};
    // V20.10.2: Zone safety - if confirmedPlatform has no zone suffix but the
    // record has a zone-specific platform (e.g. "抖音一区-【7207】"), don't mark it
    // as stale. This prevents cross-zone deletion when zone detection fails.
    var _recPlat = sv(fields[platformField]) || '';
    var _isZoneSpecific = false;
    if (_recPlat && confirmedPlatform && _recPlat !== confirmedPlatform) {
      // V21.0.0: 三列模型精确判区，避免二区覆盖一区
      try {
        var _recParts = v21SplitPlatformZone(_recPlat);
        var _confParts = v21SplitPlatformZone(confirmedPlatform);
        if (_recParts.tail && _confParts.tail && _recParts.tail === _confParts.tail) {
          if (_recParts.base !== _confParts.base || _recParts.zone !== _confParts.zone) _isZoneSpecific = true;
        } else if (_recParts.base === _confParts.base && _recParts.zone !== _confParts.zone) {
          _isZoneSpecific = true;
        }
        if (!_isZoneSpecific) {
          var _recBase = _recPlat.split('-【')[0].trim();
          var _confBase = confirmedPlatform.split('-【')[0].trim();
          if (_recBase !== _confBase && _recBase.indexOf(_confBase) === 0 && _recBase.length > _confBase.length) _isZoneSpecific = true;
        }
      } catch(e) {}
    }
    if (_isZoneSpecific) {
      // Skip: this record belongs to a different zone, don't mark as stale
      return;
    }

    var matchesPlatform = sv(fields[platformField]) === confirmedPlatform;
    var matchesDate = !dateField || isTodayBusinessValue(fields[dateField]);
    var notSeen = !(seenRecords || {})[rec.record_id];
    
    if (matchesPlatform && matchesDate && notSeen) {
      // Check status: preserve "未打单" records
      var status = '';
      if (statusField) {
        status = sv(fields[statusField]) || '';
      }
      if (!status) {
        status = sv(fields['手动传输状态']) || sv(fields['状态']) || sv(fields['传输状态']) || '';
      }
      
      if (status !== '已打单') {
        // Preserve: this record not yet printed
        preservedCount++;
      } else {
        // This is a truly stale "已打单" record
        staleIds.push(rec.record_id);
      }
    }
  });
  
  if (preservedCount > 0 && typeof L === 'function') {
    L('[安全] selectStalePlatformSourceIds: 保留 ' + preservedCount + ' 条未打单记录（不标记为过期）', 'i');
  }
  
  return staleIds;
}
function feishuMorningUpsert(records, confirmedPlatform) {
  return getFieldMap().then(function(fm) {
    var FT = resolveField(fm, ['📡 商品全称', '商品全称', '商品标题']);
    var FP = resolveField(fm, ['🔗 商品ID', '商品 🆔', '商品ID', '商品 ID']);
    var FS = resolveField(fm, ['🚧 ❗【时段】产品需求值', '❗【时段】产品需求值', '产品需求值', '规格需求']);
    var FI = resolveField(fm, ['🖼 产品图URL', '图片URL', '【图片URL】']);
    var FST = resolveField(fm, ['手动传输状态', '状态', '🚃 状态🌅']);
    var FD = resolveField(fm, ['📅 抓取日期', '创建时间', '🏗 【创建/绑定】日期', '创建时间引导']);
    var FPL = resolveField(fm, ['平台所属账号', '平台【文字】', '平台文字']);
    var F_PLAT_SEL = resolveField(fm, ['平台']);
    var F_DGJ = resolveField(fm, ['店管家']);
    if (!FT || !FP || !FS || !FST || !FD || !FPL) {
      throw new Error('上午幂等写入缺少必需字段：标题、商品ID、规格、状态、日期、平台必须存在');
    }

    return fetchAllRecordsFromTable(AT, typeof TT !== 'undefined' ? TT : RAW_TABLE).then(function(allExisting) {
      var todayPlatform = allExisting.filter(function(rec) {
        var fields = rec.fields || {};
        return sv(fields[FPL]) === confirmedPlatform && isTodayBusinessValue(fields[FD]);
      });
      var byPid = {}, byTitle = {};
      todayPlatform.forEach(function(rec) {
        var fields = rec.fields || {};
        businessPidList(sv(fields[FP])).forEach(function(pid) {
          if (!byPid[pid]) byPid[pid] = [];
          byPid[pid].push(rec);
        });
        var titleKey = normTitle(sv(fields[FT]));
        if (titleKey) {
          if (!byTitle[titleKey]) byTitle[titleKey] = [];
          byTitle[titleKey].push(rec);
        }
      });

      var updates = [], creates = [], resultRefs = [];
      var protectedActual = 0, duplicateExisting = 0, claimed = {};
      records.forEach(function(item) {
        var candidates = [], candidateSeen = {};
        businessPidList(item.productId).forEach(function(pid) {
          (byPid[pid] || []).forEach(function(rec) {
            if (!candidateSeen[rec.record_id]) {
              candidateSeen[rec.record_id] = 1;
              candidates.push(rec);
            }
          });
        });
        if (!candidates.length) {
          // V21.0.2: 纯指纹兜底（同平台已不过滤跨平台），替代易误合的标题家族冲突
          var incomingFp = v21BuildFingerprint(item.title||'', item.specStr||'');
          todayPlatform.forEach(function(rec){
            if(candidateSeen[rec.record_id]) return;
            var f=rec.fields||{};
            var fp=v21BuildFingerprint(sv(f[FT])||'', sv(f[FS])||'');
            if(fp===incomingFp){ candidateSeen[rec.record_id]=1; candidates.push(rec); }
          });
        }
        candidates.sort(function(a, b) {
          var aPrinted = sv((a.fields || {})[FST]) === '已打单' ? 1 : 0;
          var bPrinted = sv((b.fields || {})[FST]) === '已打单' ? 1 : 0;
          return bPrinted - aPrinted;
        });
        var matched = candidates[0] || null;
        if (candidates.length > 1) duplicateExisting += candidates.length - 1;
        if (matched && claimed[matched.record_id]) matched = null;

        if (matched && sv((matched.fields || {})[FST]) === '已打单') {
          protectedActual++;
          claimed[matched.record_id] = 1;
          resultRefs.push({rid:matched.record_id, pid:item.productId, img:item.imgSrc});
          return;
        }

        var fields = {};
        fields[FT] = item.title || '';
        fields[FP] = item.productId || '';
        fields[FS] = item.specStr || '';
        fields[FST] = '未打单';
        var fdType = fm[FD] ? fm[FD].type : 0;
        fields[FD] = (fdType === 5 || fdType === 23 || fdType === 24 || fdType === 0)
          ? Date.now() : new Date().toISOString().split('T')[0];
        fields[FPL] = confirmedPlatform;
        if (FI && item.imgSrc && item.imgSrc.indexOf('http') === 0) {
          fields[FI] = formatFieldValue(item.imgSrc, fm[FI] ? fm[FI].type : 1, FI);
        }
        if (F_PLAT_SEL && F_PLAT_SEL !== FPL) {
          var platType = fm[F_PLAT_SEL] ? fm[F_PLAT_SEL].type : 0;
          if (platType !== 20 && platType !== 1001) fields[F_PLAT_SEL] = confirmedPlatform.split('-【')[0];
        }
        if (F_DGJ) {
          var dgjType = fm[F_DGJ] ? fm[F_DGJ].type : 0;
          var tailMatch = confirmedPlatform.match(/【(\d{4})】/);
          if (tailMatch && dgjType !== 20 && dgjType !== 1001) fields[F_DGJ] = tailMatch[1];
        }
        // V21.0.0: 写入三列分区 + 数字数量 + 指纹（不存在的列自动跳过，保持兼容）
        try {
          var v21Parts = v21SplitPlatformZone(confirmedPlatform);
          var v21TailField = v21ResolveField(fm, V21_ZONE_FIELDS.tail);
          var v21BaseField = v21ResolveField(fm, V21_ZONE_FIELDS.base);
          var v21ZoneField = v21ResolveField(fm, V21_ZONE_FIELDS.zone);
          var v21QtyField = v21ResolveField(fm, V21_ZONE_FIELDS.qtyNum);
          var v21FpField = v21ResolveField(fm, V21_ZONE_FIELDS.fingerprint);
          if (v21TailField && v21Parts.tail) fields[v21TailField] = v21Parts.tail;
          if (v21BaseField && v21Parts.base) fields[v21BaseField] = v21Parts.base;
          if (v21ZoneField) fields[v21ZoneField] = v21Parts.zone;
          if (v21QtyField) {
            var _qtyNum = v21ParseQtyNumber(item.specStr || '');
            if (_qtyNum) fields[v21QtyField] = _qtyNum;
          }
          if (v21FpField) fields[v21FpField] = v21BuildFingerprint(item.title || '', item.specStr || '');
        } catch(e) {}
        if (matched) {
          claimed[matched.record_id] = 1;
          updates.push({record_id:matched.record_id, fields:fields, item:item});
        } else {
          creates.push({fields:fields, item:item});
        }
      });
      var staleMorningIds = todayPlatform.filter(function(rec) {
        var fields = rec.fields || {};
        return !claimed[rec.record_id] && sv(fields[FST]) !== '已打单';
      }).map(function(rec) { return rec.record_id; });

      L('上午幂等匹配: 今日当前平台已有 ' + todayPlatform.length
        + ' 条；更新 ' + updates.length + '，新增 ' + creates.length
        + '，保护已打单 ' + protectedActual
        + '，清退过期预估 ' + staleMorningIds.length, 'i');
      // V21.0.30: 持久化“上午有下午无”待确认清单（跨平台累积，不随单平台日志覆盖）
      try {
        var _staleDate = (function(){ var d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })();
        var _stalePlats = staleMorningIds.map(function(id){ var r=(todayPlatform||[]).find(function(x){return x.record_id===id}); if(!r) return null; var f=r.fields||{}; return {platform: confirmedPlatform, title: (f['📡 商品全称']||'').slice(0,80), pid: (f['商品 🆔']||'').slice(0,64), spec: (f['🚧 ❗【时段】产品需求值']||'').slice(0,500), qty: f['需求数量_数字']||'', img: (f['图片URL']||f['【图片URL】']||''), attach: (Array.isArray(f['📠 产品图'])? f['📠 产品图'][0]?.url||'' : ''), fileToken: (Array.isArray(f['📠 产品图'])? f['📠 产品图'][0]?.file_token||'' : ''), zone: f['分区']||'', store: f['店管家尾号']||'', base: f['平台基名']||'', date:_staleDate, recId: r.record_id}; }).filter(Boolean);
        if(_stalePlats.length){
          chrome.storage.local.get(['pendingStale_v21'], function(st){
            var cur = Array.isArray(st.pendingStale_v21)? st.pendingStale_v21 : [];
            // dedup by pid+platform+date
            var keySet = new Set(cur.map(function(x){return x.platform+'|'+x.pid+'|'+x.date}));
            _stalePlats.forEach(function(it){ var k=it.platform+'|'+it.pid+'|'+it.date; if(!keySet.has(k)){ cur.push(it); keySet.add(k);} });
            chrome.storage.local.set({pendingStale_v21: cur}, function(){
              try{ renderPendingStale(cur); }catch(e){}
              L('待确认已累积: '+cur.length+' 条（本轮+'+_stalePlats.length+'）', 'w');
              // 同步到飞书待确认表（持久化，采购可见）
              try{
                getToken().then(function(tok){
                  var recs=_stalePlats.map(function(it){ var _u=it.img||it.attach||''; var _imgVal=undefined; if(_u){ if(typeof _u==='object' && (_u.link||_u.url)) _imgVal={link: _u.link||_u.url, text: (_u.text||_u.link||_u.url||'').slice(0,200)}; else if(typeof _u==='string' && _u) _imgVal={link: _u, text: _u.slice(0,200)}; } var _qty=Number(it.qty); if(!_qty){ var ms=(it.spec||'').match(/;\s*\d+/g); if(ms){ var s=0; ms.forEach(function(x){ var v=parseInt(x.replace(/[^0-9]/g,''),10); if(!isNaN(v)) s+=v; }); if(s) _qty=s; } } var _f={'平台':it.platform,'分区':it.zone||'-','店管家':it.store||'','商品全称':it.title,'商品ID':it.pid,'规格':it.spec.slice(0,2000),'数量': _qty||0,'日期': Date.now(),'中转记录ID':it.recId||'','状态':'待确认'}; if(_imgVal) _f['图片URL']=_imgVal; if(it.fileToken) _f['产品图']=[{file_token: it.fileToken}]; return {fields:_f}; });
                  // 去重已在飞书的 via 中转记录ID（简易：直接写入，飞书侧可手动去重）
                  var chunk=function(a,n){var r=[];for(var i=0;i<a.length;i+=n) r.push(a.slice(i,i+n)); return r;};
                  var groups=chunk(recs,100);
                  var p = groups.reduce ? groups.reduce(function(pr,g){ return pr.then(function(){ return feishuProxy('https://open.feishu.cn/open-apis/bitable/v1/apps/'+AT+'/tables/'+PENDING_TABLE+'/records/batch_create','POST',{'Authorization':'Bearer '+tok,'Content-Type':'application/json'}, JSON.stringify({records:g}) ).then(function(r){ if(r.code===0) L('待确认已同步飞书: +'+g.length,'i'); else L('待确认同步失败:'+r.code,'e'); }); }); }, Promise.resolve()) : Promise.resolve();
                });
              }catch(e){ L('待确认飞书同步异常:'+e.message,'e'); }
            });
          });
        } else {
          // still render existing
          try{ chrome.storage.local.get(['pendingStale_v21'], function(st){ renderPendingStale(st.pendingStale_v21||[]); }); }catch(e){}
        }
      } catch(e){ L('待确认累积失败: '+e.message,'e'); }
      if (duplicateExisting) {
        L('检测到历史重复候选 ' + duplicateExisting
          + ' 条，本次不继续制造重复；旧重复留给安全去重处理', 'w');
      }

      var updateCount = 0, createCount = 0, staleDeleteCount = 0;
      var chain = Promise.resolve();
      for (var ui = 0; ui < updates.length; ui += 100) {
        (function(batch) {
          chain = chain.then(function() {
            return getToken().then(function(token) {
              return feishuProxy(
                'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : RAW_TABLE) + '/records/batch_update',
                'POST', {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
                JSON.stringify({records:batch.map(function(op) {
                  return {record_id:op.record_id, fields:op.fields};
                })})
              ).then(function(response) {
                if (response.code !== 0) throw new Error('上午更新失败: ' + response.code + ' ' + response.msg);
                updateCount += batch.length;
                batch.forEach(function(op) {
                  resultRefs.push({rid:op.record_id, pid:op.item.productId, img:op.item.imgSrc});
                });
              });
            });
          });
        })(updates.slice(ui, ui + 100));
      }
      for (var ci = 0; ci < creates.length; ci += 100) {
        (function(batch) {
          chain = chain.then(function() {
            return getToken().then(function(token) {
              return feishuProxy(
                'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : RAW_TABLE) + '/records/batch_create',
                'POST', {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
                JSON.stringify({records:batch.map(function(op) { return {fields:op.fields}; })})
              ).then(function(response) {
                var created = response && response.data && response.data.records;
                if (response.code !== 0 || !Array.isArray(created) || created.length !== batch.length) {
                  throw new Error('上午新增失败或返回数量不一致: ' + (response ? response.code : 'NO_RESPONSE'));
                }
                createCount += batch.length;
                created.forEach(function(rec, index) {
                  resultRefs.push({
                    rid:rec.record_id,
                    pid:batch[index].item.productId,
                    img:batch[index].item.imgSrc
                  });
                });
              });
            });
          });
        })(creates.slice(ci, ci + 100));
      }
      // A morning rerun is a complete snapshot for this exact platform. Delete
      // stale unprinted estimates only after every update/create succeeded.
      chain = chain.then(function() {
        if (updateCount !== updates.length || createCount !== creates.length) {
          throw new Error('上午前置写入不完整，已取消清退旧预估');
        }
        var deleteChain = Promise.resolve();
        for (var di = 0; di < staleMorningIds.length; di += 100) {
          (function(batch) {
            deleteChain = deleteChain.then(function() {
              return getToken().then(function(token) {
                return feishuProxy(
                  'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : RAW_TABLE) + '/records/batch_delete',
                  'POST', {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
                  JSON.stringify({records:batch})
                ).then(function(response) {
                  if (response.code !== 0) {
                    throw new Error('上午清退旧预估失败: ' + response.code + ' ' + response.msg);
                  }
                  staleDeleteCount += batch.length;
                });
              });
            });
          })(staleMorningIds.slice(di, di + 100));
        }
        return deleteChain;
      });
      return chain.then(function() {
        if (updateCount !== updates.length || createCount !== creates.length
            || staleDeleteCount !== staleMorningIds.length) {
          throw new Error('上午幂等写入对账失败');
        }
        var res={ok:true, updated:updateCount, created:createCount, protectedActual:protectedActual, removedStale:staleDeleteCount, records:resultRefs};
        try{
          var _z={}, _p={}; todayPlatform.forEach(function(r){ var pp=v21SplitPlatformZone(String((r.fields||{})['平台所属账号']|| (r.fields||{})['平台【文字】']||'')); var z=pp.zone||'无区'; _z[z]=(_z[z]||0)+1; });
          var _pp2=v21SplitPlatformZone(confirmedPlatform||''); if(_pp2.base) _p[confirmedPlatform]=todayPlatform.length+creates.length;
          updateV21Health({transfer: todayPlatform.length + creates.length, groups: (todayPlatform.length + creates.length), updated:updateCount, created:createCount, deleted:staleDeleteCount, protected:protectedActual, zones:_z, plats:_p});
        }catch(e){}
        return res;
      });
    });
  });
}

// ====== GENERIC BATCH HELPER ======
// ====== COPY RAW → PROC (原料表 → 加工表) ======
// v19.92.0: 从原料表复制所有记录到加工表，确保数据安全
function copyRawToProc() {
  return new Promise(function(resolve) {
    L('=== 复制原料表 → 加工表 ===', 'i');
    // Safety check: don't copy if same table
    if (RAW_TABLE === PROC_TABLE) {
      L('⚠ 原料表和加工表相同，跳过复制（请配置独立的加工表TABLE_ID）', 'w');
      resolve({ok:true, copied:0, skipped:true});
      return;
    }
    L('读取原料表数据...', 'i');
    getToken().then(function(t) {
      return fetchAllRecordsFromTable(AT, typeof TT !== "undefined" ? TT : RAW_TABLE).then(function(rawRecords) {
        L('原料表: ' + rawRecords.length + ' 条记录', 'i');
        if (rawRecords.length === 0) { L('原料表为空，无需复制', 'w'); resolve({ok:true, copied:0}); return; }
        return fetchAllRecordsFromTable(AT, (typeof TT !== 'undefined' ? TT : PROC_TABLE)).then(function(procRecords) {
          if (procRecords.length > 0) {
            var delIds = procRecords.map(function(r) { return r.record_id; });
            L('清空加工表: ' + delIds.length + ' 条', 'i');
            var chain = Promise.resolve();
            for (var i = 0; i < delIds.length; i += BATCH_SIZE) {
              (function(batch) {
                chain = chain.then(function() {
                  return feishuProxy('https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + '/records/batch_delete', 'POST', {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'}, JSON.stringify({records: batch}));
                });
              })(delIds.slice(i, i + BATCH_SIZE));
            }
            return chain.then(function() { return copyBatch(rawRecords, t, resolve); });
          } else {
            return copyBatch(rawRecords, t, resolve);
          }
        });
      });
    }).catch(function(e) { L('复制失败: ' + e.message, 'e'); resolve({ok:false, error:e.message}); });
  });
}
function copyBatch(records, token, resolve) {
  L('复制 ' + records.length + ' 条到加工表...', 'i');
  // Fields to skip (complex types that can't be copied as text)
  // v19.92.0: Skip all complex-type fields and only copy safe text fields
  var SKIP_FIELDS = {'平台':1, '店管家':1, '📠 产品图':1, '创建时间引导':1,
    '平台【文字】':1, '图片URL':1, '【图片URL】':1, '平台所属账号':1,
    '🏪 店铺':1, '📋 传输状态':1, '【查单】':1, '【复购】':1};
  var chain = Promise.resolve(), copied = 0;
  var batches = [];
  for (var i = 0; i < records.length; i += BATCH_SIZE) batches.push(records.slice(i, i + BATCH_SIZE));
  batches.forEach(function(batch, idx) {
    chain = chain.then(function() {
      var recs = batch.map(function(r) {
        var cleanFields = {};
        var f = r.fields || {};
        for (var k in f) {
          if (SKIP_FIELDS[k]) continue;
          var v = f[k];
          if (v === null || v === undefined) continue;
          // v19.92.0: Convert complex types to safe text
          if (typeof v === 'object') {
            if (v.link) { cleanFields[k] = v.link; }
            else if (Array.isArray(v)) {
              var texts = v.map(function(x) { return (typeof x === 'object' && x.text) ? x.text : (typeof x === 'object' ? JSON.stringify(x) : String(x)); });
              cleanFields[k] = texts.join(', ');
            }
            else if (v.file_token) { /* skip attachment objects */ }
            else { cleanFields[k] = JSON.stringify(v); }
          } else if (typeof v === 'number') {
            // Timestamps and numbers: keep as-is for date fields
            cleanFields[k] = v;
          } else {
            cleanFields[k] = v;
          }
        }
        return {fields: cleanFields};
      });
      return feishuProxy('https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + '/records/batch_create', 'POST', {'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, JSON.stringify({records: recs})).then(function(d) {
        if (d.code === 0) { copied += batch.length; L('批次' + (idx+1) + '/' + batches.length + ' ✓', 'ok'); }
        else L('批次' + (idx+1) + ' 失败: ' + d.msg, 'e');
      });
    });
  });
  chain.then(function() { L('复制完成: ' + copied + '/' + records.length, 'ok'); resolve({ok:true, copied:copied}); });
}
function feishuBatchOp(records, opType) {
  return getToken().then(function(t) {
    var chain = Promise.resolve();
    for (var i = 0; i < records.length; i += BATCH_SIZE) {
      (function(batch) {
        chain = chain.then(function() {
          return feishuProxy(
            'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + '/records/' + opType,
            'POST', {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
            JSON.stringify(opType === 'batch_delete' ? {records: batch} : {records: batch})
          ).then(function(d) {
            if (d.code === 0) L(opType + ': ' + batch.length + ' 条', 'ok');
            else L(opType + '错误: ' + d.code + ' ' + d.msg, 'e');
            return d;
          });
        });
      })(records.slice(i, i + BATCH_SIZE));
    }
    return chain;
  });
}


// ====== IMAGE PIPELINE v19.97.0 ======
function downloadImages(imgItems, tableId) {
  return new Promise(function(resolve) {
    if (!imgItems.length) { resolve({ok:true, count:0, imgOk:0}); return; }
    var jobId = 'img_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    L('附件流水线: '+imgItems.length+'条记录（微信缩略图加速 + 智能缓存）', 'i');
    setProgress(65, '上传中...', '0/'+imgItems.length);

    var completed = false;
    var imgTotal = imgItems.length;
    var lastProgressLog = 0;
    function onBgMsg(msg) {
      if (!msg || completed || msg.jobId !== jobId) return;
      if (msg.type === 'uploadImagesProgress') {
        var done = msg.done || 0, ok = msg.ok || 0, fail = msg.fail || 0;
        var uniqueTotal = msg.uniqueTotal || imgTotal;
        var pct = uniqueTotal > 0 ? Math.round(done / uniqueTotal * 100) : 0;
        var detail = '缓存' + (msg.cacheHits || 0) + ' · 下载' + (msg.downloaded || 0)
          + ' · 上传' + (msg.uploaded || 0) + ' · 失败' + fail;
        if (msg.optimized) detail += ' · 缩略图' + msg.optimized;
        setProgress(65 + pct * 0.35, '附件处理中...', detail);
        if (Date.now() - lastProgressLog > 1500 || done >= uniqueTotal || fail > 0) {
          lastProgressLog = Date.now();
          L('[附件] ' + done + '/' + uniqueTotal + '：' + detail, fail > 0 ? 'w' : 'i');
        }
      } else if (msg.type === 'uploadImagesRecordProgress') {
        L('[后台] 附件字段写入: ' + (msg.done || 0) + '/' + (msg.total || 0)
          + '，当前失败 ' + (msg.failed || 0), (msg.failed || 0) > 0 ? 'w' : 'i');
      } else if (msg.type === 'uploadImagesComplete') {
        completed = true;
        clearTimeout(fallbackTimer);
        chrome.runtime.onMessage.removeListener(onBgMsg);
        var ok2 = msg.success || 0, fail2 = msg.failed || 0;
        var uploaded2 = msg.uploadSuccess === undefined ? ok2 : msg.uploadSuccess;
        var uploadFailed2 = msg.uploadFailed || 0;
        var recordFailed2 = msg.recordFailed || 0;
        L('[附件] 缓存复用 ' + (msg.cacheHits || 0) + ' 张；新上传 ' + uploaded2
          + ' 张；下载/上传失败 ' + uploadFailed2 + ' 张', uploadFailed2 === 0 ? 'ok' : 'w');
        L('[后台] 采购表附件写入: 成功' + ok2 + '条 失败' + recordFailed2 + '条',
          recordFailed2 === 0 ? 'ok' : 'w');
        if (fail2 > 0) L('仍有 ' + fail2 + ' 条附件未完成，可点击“重试附件”单独修复', 'w');
        setStat(undefined, ok2);
        setProgress(100, '上传完成', ok2 + '/' + imgTotal + ' 成功');
        setTimeout(hideProgress, 3000);
        refreshFailedImageBadge();
        resolve({ok:true, count:imgItems.length, imgOk:ok2, imgFailed:fail2});
      }
    }
    chrome.runtime.onMessage.addListener(onBgMsg);

    // This is only a UI watchdog. The service worker persists progress and
    // continues streaming successful attachments into Feishu.
    var fallbackTimer = setTimeout(function() {
      if (!completed) {
        completed = true;
        chrome.runtime.onMessage.removeListener(onBgMsg);
        L('[后台] 前台等待已结束，附件仍在后台继续；稍后可用“重试附件”补失败项', 'w');
        hideProgress();
        resolve({ok:true, count:imgItems.length, imgPending:imgItems.length});
      }
    }, 1200000);

    getToken().then(function(token) {
      getBitableAppToken().then(function(appToken) {
        var bgItems = imgItems.map(function(it, itemIndex) {
          return { url: it.img || it.url || '', rid: it.rid, idx: it.idx === undefined ? itemIndex : it.idx, pid: it.pid || '' };
        });

        chrome.tabs.query({active:true, currentWindow:true}, function(tabs) {
          var sourceTabId = tabs && tabs[0] && /dgjapp\.com/.test(tabs[0].url || '') ? tabs[0].id : null;
          try {
            chrome.runtime.sendMessage({
              type: 'uploadImagesPipeline',
              jobId: jobId,
              items: bgItems,
              token: token,
              appToken: appToken,
              tableId: tableId || PROC_TABLE,
              sourceTabId: sourceTabId
            }, function(response) {
              if (chrome.runtime.lastError) {
                console.log('[DGJ] Background msg error: ' + chrome.runtime.lastError.message);
              }
            });
          } catch(e) {
            console.log('[DGJ] sendMessage error: ' + e.message);
          }
        });
      });
    }).catch(function(e) {
      L('Token获取失败: '+e.message, 'e');
      if (!completed) {
        completed = true;
        clearTimeout(fallbackTimer);
        chrome.runtime.onMessage.removeListener(onBgMsg);
        hideProgress();
        resolve({ok:false, count:imgItems.length, imgOk:0});
      }
    });
  });
}

function refreshFailedImageBadge() {
  var badge = document.getElementById('retryImageCount');
  var button = document.getElementById('retryImages');
  if (!badge || !button) return;
  chrome.storage.local.get(['dgjLastImageFailures'], function(data) {
    var pack = data && data.dgjLastImageFailures;
    var count = pack && Array.isArray(pack.items) ? pack.items.length : 0;
    badge.textContent = count ? count + ' 条' : '无失败';
    button.classList.toggle('has-failures', count > 0);
  });
}
function batchUpdateRecords(results, tableId) {
  return new Promise(function(resolve, reject) {
    if (!results.length) { resolve(0); return; }
    var BATCH = 50;
    var updated = 0;
    var batches = [];
    for (var i = 0; i < results.length; i += BATCH) {
      batches.push(results.slice(i, i + BATCH));
    }
    var bi = 0;
    function nextBatch() {
      if (bi >= batches.length) { resolve(updated); return; }
      var chunk = batches[bi++];
      var records = chunk.map(function(r) {
        return { record_id: r.rid, fields: { '📠 产品图': [{ file_token: r.ft }] } };
      });
      getToken().then(function(t) {
        return feishuProxy(
          'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (tableId || PROC_TABLE) + '/records/batch_update',
          'POST',
          {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
          JSON.stringify({ records: records })
        );
      }).then(function(d) {
        if (d && d.code === 0) {
          updated += chunk.length;
        } else {
          L('批量更新记录失败: ' + (d ? d.msg : 'null') + ' (批次' + bi + ')', 'w');
          // Fallback: try individual updates for this batch
          return fallbackIndividualUpdate(chunk).then(function(ok) { updated += ok; });
        }
        if (bi % 3 === 0) setProgress(85 + Math.round(bi / batches.length * 15), '更新中...', updated + '条');
        nextBatch();
      }).catch(function(e) {
        L('批量更新异常: ' + e.message, 'w');
        nextBatch();
      });
    }
    nextBatch();
  });
}

// Fallback: individual record update (if batch fails)
function fallbackIndividualUpdate(chunk) {
  return new Promise(function(resolve) {
    var ok = 0, i = 0;
    function next() {
      if (i >= chunk.length) { resolve(ok); return; }
      var r = chunk[i++];
      updateRecImg(r.rid, r.ft).then(function(d) {
        if (d && d.code === 0) ok++;
        next();
      }).catch(function() { next(); });
    }
    next();
  });
}

function updateRecImg(rid, ft) {
  return getToken().then(function(t) {
    return retryFetch(function() {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + '/records/' + rid,
        'PUT', {'Authorization':'Bearer '+t,'Content-Type':'application/json'},
        JSON.stringify({fields:{'📠 产品图':[{file_token:ft}]}})
      );
    }, 2, 1500);
  });
}
function wait(ms) { return new Promise(function(r){setTimeout(r,ms);}); }
function stopKA() { chrome.runtime.sendMessage({type:'keepAlive', enable:false}); }


// ====== Module-level utilities (shared by merge + return) ======
function sv(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return v.map(function(x) { return (x && x.text) ? x.text : String(x); }).join('').trim();
  if (typeof v === 'object' && v.text) return v.text.trim();
  if (typeof v === 'object' && v.link) return v.link.trim();
  return '';
}

function isTrulyEmptyManualValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function hasPurchaserManualData(fields, fieldNames) {
  var source = fields || {};
  return (fieldNames || []).some(function(name) {
    return name && !isTrulyEmptyManualValue(source[name]);
  });
}

function norm(t) {
  t = t.trim();
  t = t.replace(/【[^】]{0,30}】/g, '');
  t = t.replace(/\[[^\]]{0,30}\]/g, '');
  t = t.replace(/[\(（][^\)）]{0,15}[\)）]/g, '');
  // Only strip an explicit, separated operator suffix. Never remove embedded
  // model numbers such as S24, X100 or iPhone15.
  t = t.replace(/[-_\s]+(?:[A-Za-z]{1,3}|运营\d{1,2}|店\d{1,2})$/, '');
  t = t.replace(/^[\d]+/, '');
  '清仓|热卖|惊爆价|限时|秒杀|爆款|特价|促销|厂家直销|厂家直发|工厂直发|抢|震爆价|正品保障|官方正品|正品|保障|爆款推荐|现货|包邮|同款|视频同款'.split('|').forEach(function(w) { t = t.replace(new RegExp(w, 'g'), ''); });
  t = t.replace(/[\s\-_+,./\\:：;；!！?？~～]+$/, '');
  t = t.toLowerCase();
  t = t.replace(/[^\u4e00-\u9fffa-z0-9]/g, '');
  return t;
}


function jaroWinkler(s1, s2) {
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  var l1 = s1.length, l2 = s2.length;
  if (l1 === 0 || l2 === 0) return 0;
  var matchDist = Math.floor(Math.max(l1, l2) / 2) - 1;
  if (matchDist < 0) matchDist = 0;
  var s1m = new Array(l1).fill(false), s2m = new Array(l2).fill(false);
  var m = 0, t = 0;
  for (var i = 0; i < l1; i++) {
    var lo = Math.max(0, i - matchDist), hi = Math.min(i + matchDist + 1, l2);
    for (var j = lo; j < hi; j++) {
      if (s2m[j] || s1[i] !== s2[j]) continue;
      s1m[i] = true; s2m[j] = true; m++; break;
    }
  }
  if (m === 0) return 0;
  var k = 0;
  for (var i = 0; i < l1; i++) {
    if (!s1m[i]) continue;
    while (!s2m[k]) k++;
    if (s1[i] !== s2[k]) t++;
    k++;
  }
  t /= 2;
  var jaro = (m / l1 + m / l2 + (m - t) / m) / 3;
  var prefix = 0;
  for (var i = 0; i < Math.min(4, l1, l2); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}



// Weighted composite scoring (based on product-matcher library approach)
// Combines title, spec, and product type signals into a single score
// ====== SIMILARITY FUNCTIONS (module-level) ======
function diceSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  var sa = {}, sb = {};
  for (var i = 0; i < a.length - 1; i++) sa[a.substr(i, 2)] = 1;
  for (var j = 0; j < b.length - 1; j++) sb[b.substr(j, 2)] = 1;
  var ix = 0;
  for (var k in sa) { if (sb[k]) ix++; }
  var totalA = Object.keys(sa).length, totalB = Object.keys(sb).length;
  return (totalA + totalB) > 0 ? (2 * ix) / (totalA + totalB) : 0;
}

function triSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  var sa = {}, sb = {};
  for (var i = 0; i < a.length - 2; i++) sa[a.substr(i, 3)] = 1;
  for (var j = 0; j < b.length - 2; j++) sb[b.substr(j, 3)] = 1;
  var ix = 0;
  for (var k in sa) { if (sb[k]) ix++; }
  var totalA = Object.keys(sa).length, totalB = Object.keys(sb).length;
  return (totalA + totalB) > 0 ? (2 * ix) / (totalA + totalB) : 0;
}

function cosineSim(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  var freqA = {}, freqB = {};
  for (var i = 0; i < a.length; i++) freqA[a[i]] = (freqA[a[i]] || 0) + 1;
  for (var i = 0; i < b.length; i++) freqB[b[i]] = (freqB[b[i]] || 0) + 1;
  var dot = 0, magA = 0, magB = 0;
  for (var ch in freqA) {
    magA += freqA[ch] * freqA[ch];
    if (freqB[ch]) dot += freqA[ch] * freqB[ch];
  }
  for (var ch in freqB) magB += freqB[ch] * freqB[ch];
  magA = Math.sqrt(magA); magB = Math.sqrt(magB);
  return (magA > 0 && magB > 0) ? dot / (magA * magB) : 0;
}

function cnTokenize(text) {
  var tokens = {};
  if (!text) return tokens;
  for (var len = 2; len <= 3; len++) {
    for (var i = 0; i <= text.length - len; i++) {
      var chunk = text.substring(i, i + len);
      if (/^[\u4e00-\u9fff]+$/.test(chunk)) tokens[chunk] = 1;
    }
  }
  return tokens;
}

function tokenJaccard(a, b) {
  var tA = cnTokenize(a), tB = cnTokenize(b);
  var kA = Object.keys(tA), kB = Object.keys(tB);
  if (!kA.length || !kB.length) return 0;
  var shared = 0;
  kA.forEach(function(k) { if (tB[k]) shared++; });
  var union = kA.length + kB.length - shared;
  return union > 0 ? shared / union : 0;
}

// ====== SHARED SPEC UTILITIES (module-level for compositeScore) ======
function extractSpecNames(specStr) {
  var names = {};
  if (!specStr) return names;
  specStr.split('\n').forEach(function(line) {
    line = line.trim();
    if (!line) return;
    var parts = line.split(';');
    var nm = (parts.length >= 2 ? parts.slice(0, -1).join(';') : line).trim();
    if (nm && nm.length >= 2) names[nm] = 1;
  });
  return names;
}

function specOverlap(a, b) {
  var na = extractSpecNames(a), nb = extractSpecNames(b);
  var ka = Object.keys(na), kb = Object.keys(nb);
  if (!ka.length || !kb.length) return 0;
  var ix = 0, u = {};
  ka.forEach(function(k) { u[k] = 1; if (nb[k]) ix++; });
  kb.forEach(function(k) { u[k] = 1; });
  var uc = Object.keys(u).length;
  return uc > 0 ? ix / uc : 0;
}

function specTokenOverlap(a, b) {
  var na = extractSpecNames(a), nb = extractSpecNames(b);
  var ka = Object.keys(na), kb = Object.keys(nb);
  if (!ka.length || !kb.length) return 0;
  var tokA = {}, tokB = {};
  function tokCn(text) {
    var t = {};
    for (var len = 2; len <= 4; len++) {
      for (var i = 0; i <= text.length - len; i++) {
        var chunk = text.substring(i, i + len);
        if (/^[\u4e00-\u9fff]+$/.test(chunk)) t[chunk] = 1;
      }
    }
    return t;
  }
  ka.forEach(function(n) { var t = tokCn(n); for(var k in t) tokA[k]=1; });
  kb.forEach(function(n) { var t = tokCn(n); for(var k in t) tokB[k]=1; });
  var ix = 0, u = {};
  for (var t in tokA) { u[t] = 1; if (tokB[t]) ix++; }
  for (var t in tokB) u[t] = 1;
  var uc = Object.keys(u).length;
  return uc > 0 ? ix / uc : 0;
}

function specAvgLen(specStr) {
  if (!specStr) return 0;
  var avgLen = 0, cnt = 0;
  specStr.split('\n').forEach(function(l) {
    var parts = l.split(';');
    var name = (parts.length >= 2 ? parts.slice(0, -1).join(';') : l).trim();
    if (name) { avgLen += name.length; cnt++; }
  });
  return cnt > 0 ? avgLen / cnt : 0;
}

function specTrigMax(a, b) {
  var na = extractSpecNames(a), nb = extractSpecNames(b);
  var ka = Object.keys(na), kb = Object.keys(nb);
  if (!ka.length || !kb.length) return 0;
  var maxSim = 0;
  ka.forEach(function(a_name) {
    kb.forEach(function(b_name) {
      var s = triSim(a_name, b_name);
      if (s > maxSim) maxSim = s;
    });
  });
  return maxSim;
}

function multiSim(titleA, titleB, specA, specB) {
  return jaroWinkler(titleA, titleB) * 0.30 + diceSim(titleA, titleB) * 0.25 + specOverlap(specA, specB) * 0.25 + cosineSim(titleA, titleB) * 0.20;
}

function compositeScore(t1, t2, s1, s2, ct1, ct2) {
  var titleScore = jaroWinkler(t1, t2);
  var specScore = specTokenOverlap(s1, s2);
  var typeScore = diceSim(ct1, ct2);
  var cosScore = cosineSim(t1, t2);
  // Weighted: title 35%, spec 35%, type 15%, cosine 15%
  return titleScore * 0.35 + specScore * 0.35 + typeScore * 0.15 + cosScore * 0.15;
}

// ====== DEDUP v19: 向量合并优化版 (Dice+核心类型+动态阈值) ======

// ====== FETCH ALL RECORDS FROM TABLE ======
function fetchAllRecordsFromTable(appToken, tableId) {
  return getToken().then(function(t) {
    var all = [], pt = '';
    function fetchPage() {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records?page_size=' + PAGE_SIZE + (pt ? '&page_token=' + pt : ''),
        'GET', {'Authorization': 'Bearer ' + t}
      ).then(function(d) {
        if (d.code !== 0) throw new Error('\u8bfb\u53d6\u5931\u8d25: ' + d.msg);
        all = all.concat(d.data.items || []);
        if (d.data.has_more && d.data.page_token) { pt = d.data.page_token; return fetchPage(); }
        return all;
      });
    }
    return fetchPage();
  });
}


// ====== V20.11.0: DATA CACHE LAYER ======
// Caches table reads to avoid redundant API calls within the same operation
var _dataCache = {};
var _dataCacheTs = {};
var CACHE_TTL = 120000; // 2 minutes — covers a full afternoon return cycle

function fetchAllRecordsCached(appToken, tableId, forceRefresh) {
  var cacheKey = appToken + '::' + tableId;
  if (!forceRefresh && _dataCache[cacheKey] && Date.now() - (_dataCacheTs[cacheKey] || 0) < CACHE_TTL) {
    L('[缓存] 命中 ' + tableId + ' (' + _dataCache[cacheKey].length + ' 条)', 'i');
    return Promise.resolve(_dataCache[cacheKey]);
  }
  return fetchAllRecordsFromTable(appToken, tableId).then(function(records) {
    _dataCache[cacheKey] = records;
    _dataCacheTs[cacheKey] = Date.now();
    return records;
  });
}

function invalidateDataCache(tableId) {
  if (tableId) {
    Object.keys(_dataCache).forEach(function(k) {
      if (k.indexOf(tableId) >= 0) { delete _dataCache[k]; delete _dataCacheTs[k]; }
    });
  } else {
    _dataCache = {}; _dataCacheTs = {};
  }
}

// === RESTORE FROM BACKUP (v19.34.0) ===
// Reads all records from backup table and restores to 中转站
// Uses BACKUP_SNAPSHOT from config above

function restoreFromBackup() {
  L('=== 开始从备份恢复 ===', 's');
  L('读取备份表: ' + BACKUP_SNAPSHOT, 'i');
  var restoreRecords = [], deleted = 0, created = 0;
  return fetchAllRecordsFromTable(AT, BACKUP_SNAPSHOT).then(function(backupRecords) {
    restoreRecords = backupRecords;
    if (!restoreRecords.length) throw new Error('备份表为空，已停止恢复，不会清空中转站');
    L('备份表共 ' + restoreRecords.length + ' 条记录', 'i');

    // Step 1: Delete all current 中转站 records. Any failed batch stops
    // immediately; never continue into create and produce a mixed dataset.
    L('清空中转站...', 'i');
    return getToken().then(function(t) {
      return fetchAllRecordsFromTable(AT, TRANSFER_TABLE).then(function(currentRecords) {
        L('中转站现有 ' + currentRecords.length + ' 条，准备清空', 'i');
        if (currentRecords.length === 0) return Promise.resolve();
        var deleteIds = currentRecords.map(function(r) { return r.record_id; });
        var chain = Promise.resolve();
        for (var i = 0; i < deleteIds.length; i += 100) {
          (function(batch) {
            chain = chain.then(function() {
              return feishuProxy(
                'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + TRANSFER_TABLE + '/records/batch_delete',
                'POST', {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
                JSON.stringify({records: batch})
              ).then(function(d) {
                if (d.code !== 0) throw new Error('恢复清空失败: ' + d.code + ' ' + d.msg);
                deleted += batch.length;
                L('删除批次✓ ' + batch.length + '条', 'i');
              });
            });
          })(deleteIds.slice(i, i + 100));
        }
        return chain;
      });
    });
  }).then(function() {
    // Step 2: Write backup records to 中转站
    L('写入备份数据到中转站...', 'i');
    return getToken().then(function(t) {
      var chain = Promise.resolve();
      for (var i = 0; i < restoreRecords.length; i += 100) {
        (function(batch) {
          chain = chain.then(function() {
            var recs = batch.map(function(r) {
              return {fields: r.fields};
            });
            return feishuProxy(
              'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + TRANSFER_TABLE + '/records/batch_create',
              'POST', {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
              JSON.stringify({records: recs})
            ).then(function(d) {
              if (d.code !== 0) throw new Error('恢复写入失败: ' + d.code + ' ' + d.msg);
              created += recs.length;
              L('写入批次✓ ' + recs.length + '条', 'i');
            });
          });
        })(restoreRecords.slice(i, i + 100));
      }
      return chain;
    });
  }).then(function() {
    if (created !== restoreRecords.length) throw new Error('恢复写入数量对账失败');
    return fetchAllRecordsFromTable(AT, TRANSFER_TABLE);
  }).then(function(restoredRows) {
    if (restoredRows.length !== restoreRecords.length) {
      throw new Error('恢复后复核失败：预期 ' + restoreRecords.length
        + ' 条，实际 ' + restoredRows.length + ' 条');
    }
    L('=== 恢复完成 ===', 's');
    L('已从备份恢复 ' + restoreRecords.length + ' 条记录到中转站', 'ok');
    return {restored:restoreRecords.length, deleted:deleted, created:created};
  });
}


// ====== READ-ONLY API HEALTH CHECK ======
function quickApiTest() {
  L('=== 飞书只读连通性检查 ===', 's');
  return getToken().then(function(t) {
    return feishuProxy(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + '/records?page_size=1',
      'GET', {'Authorization': 'Bearer ' + t}
    ).then(function(d) {
      if (d.code !== 0) throw new Error('读取失败: ' + d.msg + ' code=' + d.code);
      L('[CHECK] API、应用和中转站读取正常', 'ok');
      return {ok:true, sampleCount:(d.data && d.data.items ? d.data.items.length : 0)};
    });
  }).catch(function(e) {
    L('[CHECK] ❌ 连通性异常: ' + e.message, 'e');
    throw e;
  });
}


// v19.92.0: Status compatibility check for merge — don't merge 已打单 with 未打单
function statusCompat(itemA, itemB) {
  var sa = (itemA && itemA.status) || '';
  var sb = (itemB && itemB.status) || '';
  if (sa && sb && sa !== sb) return false;
  // 中转站必须保留“每个平台自己的事实”。跨平台汇总只允许在采购表发生，
  // 否则下午回传无法知道应替换哪一家店铺的上午预估规格。
  var pa = dedupPlatform((itemA && itemA.platform) || '');
  var pb = dedupPlatform((itemB && itemB.platform) || '');
  if (pa && pb && pa !== pb) return false;
  return true;
}

function dedupFeishu() {
  L('=== 开始合并中转站 (v19.92.0) ===', 'i');
  L('获取全部记录...', 'i');
  L('目标: ' + AT + ' / ' + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + ' (原料表/中转站)', 'i');


  function cleanPid(raw) {
    if (!raw) return '';
    var ids = {};
    raw.replace(/,/g, '\n').split('\n').forEach(function(segment) {
      segment = segment.trim(); if (!segment) return;
      if (/^\d{8,20}$/.test(segment)) {
        ids[segment] = 1;
        return;
      }
      if (/^\d{21,}$/.test(segment)) {
        var split = _splitConcatPids(segment);
        split.forEach(function(p) { ids[p] = 1; });
        return;
      }
      segment.split(/[\n,]/).forEach(function(p) {
        p = p.trim();
        if (/^\d{8,20}$/.test(p)) { ids[p] = 1; }
        else if (/^\d{21,}$/.test(p)) {
          _splitConcatPids(p).forEach(function(x) { ids[x] = 1; });
        }
      });
    });
    var clean = Object.keys(ids);
    clean.sort(function(a, b) { return a.length - b.length; });
    var deduped = [];
    clean.forEach(function(p) {
      var isDup = false;
      deduped.forEach(function(d) { if (d === p || d.startsWith(p) || p.startsWith(d)) isDup = true; });
      if (!isDup) deduped.push(p);
    });
    return deduped.join('\n');
  }

  // _splitConcatPids: see implementation below (v19.92.0: removed duplicate)

  function _splitConcatPids(s) {
    // Common PID lengths by platform (ordered by frequency)
    var COMMON_LENS = [13, 12, 19, 20, 18, 17, 16, 15, 14, 11, 10, 9, 8];
    var best = null;
    var bestCount = 0;

    function trySplit(str, lengths) {
      if (str.length === 0) return [];
      for (var i = 0; i < lengths.length; i++) {
        var len = lengths[i];
        if (len > str.length) continue;
        var seg = str.substring(0, len);
        if (/^\d{8,20}$/.test(seg)) {
          var rest = trySplit(str.substring(len), lengths);
          if (rest !== null) {
            return [seg].concat(rest);
          }
        }
      }
      // Check if remaining is a valid PID itself
      if (str.length >= 8 && str.length <= 20 && /^\d{8,20}$/.test(str)) {
        return [str];
      }
      return null;
    }

    // Try each common length as the starting point
    COMMON_LENS.forEach(function(firstLen) {
      if (firstLen > s.length) return;
      var seg = s.substring(0, firstLen);
      if (!/^\d{8,20}$/.test(seg)) return;
      var rest = trySplit(s.substring(firstLen), COMMON_LENS);
      if (rest !== null) {
        var result = [seg].concat(rest);
        if (result.length > bestCount) {
          bestCount = result.length;
          best = result;
        }
      }
    });

    // Fallback: try exact divisibility
    if (!best) {
      for (var len = 8; len <= 20; len++) {
        if (s.length % len === 0 && s.length / len >= 2) {
          var segs = s.length / len;
          var ok = true;
          for (var i = 0; i < segs; i++) {
            if (!/^\d{8,20}$/.test(s.substring(i * len, (i + 1) * len))) { ok = false; break; }
          }
          if (ok) {
            best = [];
            for (var i = 0; i < segs; i++) best.push(s.substring(i * len, (i + 1) * len));
            break;
          }
        }
      }
    }

    return best || [s];
  }

  function _splitPidRecursive(remaining, current, results) {
    // Not used anymore, kept for compatibility
    if (remaining.length === 0) {
      if (current.length >= 2) results.push(current.slice());
      return;
    }
    for (var len = 8; len <= 20 && len <= remaining.length; len++) {
      var seg = remaining.substring(0, len);
      if (/^\d{8,20}$/.test(seg)) {
        current.push(seg);
        _splitPidRecursive(remaining.substring(len), current, results);
        current.pop();
      }
    }
  }


  function coreType(title) {
    var t = norm(title);
    t = t.replace(/^(全新升级|升级加厚|新款|2026|2025|升级|加厚|加宽|加大|加长|超值|特惠|厂家|工厂|直销|爆款|热卖|热销|爆款推荐|网红|同款|视频同款|官方|正品|正品保障|抢|限时|秒杀|特价|清仓|震爆价|惊爆价|促销|【.*?】|\[.*?\])+/g, '');
    t = t.replace(/[a-z0-9]{1,6}$/g, '');
    '室内|家用|多功能|新款|升级|加厚|加宽|加大|超值|特惠|实惠|抢|爆款|热卖|网红|官方|正品'.split('|').forEach(function(w) {
      t = t.replace(new RegExp('^' + w, 'g'), '');
    });
    t = t.replace(/[^\u4e00-\u9fffa-z0-9]/g, '');
    return t;
  }

  function featureWords(title) {
    var t = norm(title);
    t = t.replace(/【[^】]*】/g, '');
    t = t.replace(/\d+[个件支条袋盒双片张包瓶罐箱只把根块张卷对]/g, '');
    t = t.replace(/^(全新升级|升级加厚|新款|2026|2025|升级|加厚|加宽|加大|超值|特惠|厂家|工厂|直销|爆款|热卖|热销|网红|同款|官方|正品|正品保障|抢|限时|秒杀|特价|清仓|震爆价|惊爆价|促销)+/g, '');
    t = t.replace(/[^\u4e00-\u9fffa-z0-9]/g, '');
    return t;
  }

  function extractProductCore(title, spec) {
    var combined = (title || '') + ' ' + (spec || '');
    var cores = {};
    var corePatterns = [
      /硅油纸|烘焙纸|油纸|空气炸锅纸/, /鞋垫|足弓/, /搓澡手套|沐浴手套|五指手套|防护手套/,
      /训练器|网球|篮球|投篮/, /理线器|绕线器|线夹/, /收纳盒|置物架|置物盒|收纳架/,
      /清洁刷|地刷|缝隙刷|卫生间刷/, /除臭|留香|芳香|防臭|除味|芳香剂/,
      /面罩|防护面罩|防晒面罩|护目镜/, /压缩袋|收纳袋|真空袋/, /过滤棉|棉袋|水龙头过滤/,
      /手机支架|磁吸支架|车载支架/, /食槽|喂鸡|喂食器/, /气球|刮刮卡/,
      /纹贴|额头贴|法令纹|川字纹/, /锅|碗|勺|铲|夹|刨|削|压泥|研磨/,
      /遮阳罩|保护罩|防雨罩|防晒罩/, /保鲜袋|铝箔袋|铝箔/, /逆变器|充电器/,
      /书包|书套|书夹|书本收纳/, /花边剪|压花器/, /刮泥勺|果泥勺|辅食/,
      /冰箱收纳/, /搓澡|沐浴/, /防水材料|五指/, /蝴蝶理线/,
      /桌椅脚垫|防滑脚垫/, /高清面罩/, /火箭气球|冲天/, /免打孔|壁挂/,
      /防返臭|疏通/, /驱虫|防虫/, /干发帽|浴帽/, /漱口杯|刷牙杯/,
      /阻门器/, /翻鱼铲|煎铲/, /鸡食槽|牛筋盆/, /毛巾|浴巾|干发/,
      /发箍|发夹|发卡/, /挂钩|粘钩|魔术贴/, /练字帖|描红/, /积木|拼装|拼插/,
      /跳跳球|蹦蹦球/, /投影灯|小夜灯/, /收纳箱|整理箱/, /防烫夹|取碗夹/,
      /剪刀|美工刀/, /驱蚊|蚊香/, /冰丝|防晒/, /棉签|牙签/,
      /马桶刷|厕所刷/, /保鲜膜|保鲜盖/, /量杯|量勺/, /垃圾袋|垃圾盒/,
      /拖鞋|凉鞋/, /枕头|靠垫/, /窗帘|门帘/, /围裙|手套/,
      /漏勺|漏网|滤网/, /削皮|刨丝|切菜/, /打蛋|搅拌/, /开瓶器|开罐器/,
      /封口夹|密封夹/, /沥水|水槽/, /拖把|扫把|簸箕/, /雨伞|雨衣/,
      /隔热手套/, /地垫|脚垫|门垫/, /收纳|整理/, /磁吸/,
    ];
    corePatterns.forEach(function(p) {
      var m = combined.match(p);
      if (m) cores[m[0]] = 1;
    });
    return Object.keys(cores);
  }

  function coreWordsCompat(coresA, coresB) {
    if (!coresA.length || !coresB.length) return true;
    for (var i = 0; i < coresA.length; i++) {
      for (var j = 0; j < coresB.length; j++) {
        if (coresA[i] === coresB[j]) return true;
        if (coresA[i].includes(coresB[j]) || coresB[j].includes(coresA[i])) return true;
      }
    }
    return false;
  }

  // diceSim: moved to module level

  // triSim: moved to module level


  // cosineSim: moved to module level

  // cnTokenize: moved to module level

  // tokenJaccard: moved to module level

  // extractSpecNames: moved to module level

  // specOverlap: moved to module level

  // specTokenOverlap: moved to module level

  // specAvgLen: moved to module level

  // specTrigMax: moved to module level

  // multiSim: moved to module level

  function isValidUrl(s) {
    return /^https?:\/\//.test(s);
  }

  function mergeSpecs(allSpecStrs) {
    var combined = {}, order = [];
    allSpecStrs.forEach(function(s) {
      if (!s) return;
      s.split('\n').forEach(function(l) {
        l = l.trim(); if (!l) return;
        var p = l.split(';');
        var nm = (p.length >= 2 ? p.slice(0, -1).join(';') : l).trim();
        var q = p.length >= 2 ? (Number(p[p.length - 1]) || 0) : 0;
        if (nm) { if (!combined[nm]) { combined[nm] = 0; order.push(nm); } combined[nm] += q; }
      });
    });
    return order.map(function(n) { return n + ';' + combined[n]; }).join('\n');
  }

  var TYPE_KW = {
    food: /鸡|鸭|鹅|猪|牛|羊|兔|喂食|食槽|饮水|料槽/,
    phone: /手机支架|手机座|车载支架|导航架/,
    inv: /逆变器|充电器|转换器|变压器|插座|插排|排插/,
    shoe: /鞋垫|足弓|鞋底/,
    cable: /理线器|绕线器|线夹|集线器/,
    clean: /清洁刷|地刷|缝隙刷|马桶刷|刷子/,
    bag: /收纳袋|压缩袋|真空袋|储物袋/,
    paper: /保鲜袋|铝箔|油纸|烘焙纸|硅油纸|过滤棉/,
    mask: /面罩|防护面罩|口罩|护目/,
    shelf: /置物架|收纳架|挂架|收纳盒|置物盒/,
    cover: /遮阳罩|防雨罩|保护罩|外机盖|遮阳网/,
    care: /除臭|留香|芳香|除菌|喷雾|除味/,
    toy: /气球|刮刮卡|手工|粘土|玩具|磁力|折纸/,
    kitchen: /锅|碗|勺|铲|夹|刨|削|压泥|研磨/,
    tool: /扳手|阀门|水龙头|角阀/,
    sports: /网球|训练器|球拍|篮球|投篮/,
    beauty: /纹贴|面膜|护肤|精华/,
    storage: /收纳|整理|挂架|置物/,
    insect: /驱虫|防虫|灭虫|杀虫/,
    auto: /车载|汽车|驾驶|摄像头/,
    baby: /婴儿|宝宝|辅食|童装/,
    clothing: /服装|衣物|内衣|外套/,
    digital: /数码|电子|充电|数据线/,
    sun: /防晒|遮阳|紫外线/,
    ac: /空调|冰箱|洗衣机/,
    camera: /摄像头|镜头|影像/,
    ball: /球|篮球|足球|排球|乒乓/,
    cleaning: /扫把|拖把|扫帚|魔术扫/,
    stationery: /书套|书本|文具|笔|本子/
  };
  function gType(x) { var t = {}; for (var k in TYPE_KW) { if (TYPE_KW[k].test(x)) t[k] = 1; } return t; }
  function tCompat(a, b) {
    var ka = Object.keys(a), kb = Object.keys(b);
    if (!ka.length && !kb.length) return true;
    if (!ka.length || !kb.length) return false;
    // Must share at least one type
    var hasCommon = false;
    for (var ki = 0; ki < ka.length; ki++) { if (b[ka[ki]]) { hasCommon = true; break; } }
    if (!hasCommon) return false;
    // Reject if types are in mutually exclusive categories
    var EXCLUDE_PAIRS = [
      ['phone','food'], ['phone','kitchen'], ['phone','care'],
      ['shoe','phone'], ['shoe','kitchen'], ['shoe','care'],
      ['food','phone'], ['food','shoe'], ['food','paper'],
      ['paper','phone'], ['paper','shoe'], ['paper','care'],
      ['care','phone'], ['care','shoe'], ['care','food'],
      ['sports','food'], ['sports','care'], ['sports','paper'],
      ['toy','phone'], ['toy','food'], ['toy','care'],
      ['baby','phone'], ['baby','food'],
      ['auto','food'], ['auto','care'], ['auto','baby'],
      ['insect','phone'], ['insect','care'],
      ['cleaning','phone'], ['cleaning','food']
    ];
    for (var ei = 0; ei < EXCLUDE_PAIRS.length; ei++) {
      if (a[EXCLUDE_PAIRS[ei][0]] && b[EXCLUDE_PAIRS[ei][1]]) return false;
      if (a[EXCLUDE_PAIRS[ei][1]] && b[EXCLUDE_PAIRS[ei][0]]) return false;
    }
    return true;
  }
  // Spec compatibility check — prevents merging different products
  // Extracts core product keywords from spec and checks overlap
  function specCompat(spec1, spec2, title1, title2) {
    if (!spec1 || !spec2) return true;
    var names1 = spec1.split('\n').map(function(l) { var p = l.split(';'); return (p[0]||'').trim(); }).filter(Boolean);
    var names2 = spec2.split('\n').map(function(l) { var p = l.split(';'); return (p[0]||'').trim(); }).filter(Boolean);
    if (!names1.length || !names2.length) return true;
    var SPECIFIC_THRESHOLD = 8;
    var specific1 = names1.filter(function(n) { return n.length >= SPECIFIC_THRESHOLD; });
    var specific2 = names2.filter(function(n) { return n.length >= SPECIFIC_THRESHOLD; });
    // Case 1: Both have specific specs → check if core product nouns overlap
    if (specific1.length > 0 && specific2.length > 0) {
      // Extract meaningful 2-char Chinese chunks (product nouns), skip common/generic ones
      var COMMON = {'大小':1,'通用':1,'升级':1,'新款':1,'超值':1,'热卖':1,'限定':1,'礼盒':1,'精装':1,'简装':1,'标准':1,'加强':1,'加厚':1,'加大':1,'加长':1,'加宽':1,'颜色':1,'随机':1,'随机发':1,'适合':1,'不限':1,'型号':1,'款式':1,'规格':1,'尺寸':1,'可吸':1,'调节':1,'角度':1,'款色':1,'时尚':1,'百搭':1,'经典':1,'简约':1,'ins':1,'白色':1,'黑色':1,'灰色':1,'红色':1,'蓝色':1,'绿色':1,'粉色':1,'紫色':1,'黄色':1,'棕色':1,'卡其':1,'宝蓝':1,'紫罗兰':1,'炫酷':1,'豪华':1,'旗舰':1,'入门':1,'基础':1,'高端':1,'中端':1,'低端':1,'装':1,'个装':1,'套装':1,'组合':1,'优惠':1,'超值装':1,'大容量':1,'小容量':1,'迷你':1,'大型':1,'中型':1,'小型':1,'双':1,'对':1,'条':1,'件':1,'包':1,'袋':1,'盒':1,'箱':1,'只':1,'支':1,'把':1,'块':1,'片':1,'张':1,'根':1,'卷':1,'瓶':1,'罐':1,'桶':1,'台':1,'架':1,'副':1,'顶':1,'份':1,'组':1,'色':1,'号':1,'均码':1,'大码':1,'中码':1,'小码':1};
      function extractNouns(arr) {
        var nouns = {};
        arr.forEach(function(n) {
          for (var len = 2; len <= 3; len++) {
            for (var i = 0; i <= n.length - len; i++) {
              var chunk = n.substring(i, i + len);
              if (/^[\u4e00-\u9fff]{2,3}$/.test(chunk) && !COMMON[chunk]) nouns[chunk] = 1;
            }
          }
        });
        return nouns;
      }
      var nA = extractNouns(specific1), nB = extractNouns(specific2);
      var kA = Object.keys(nA), kB = Object.keys(nB);
      if (kA.length === 0 || kB.length === 0) return true; // No nouns to compare
      var shared = 0;
      kA.forEach(function(k) { if (nB[k]) shared++; });
      var union = kA.length + kB.length - shared;
      var jaccard = union > 0 ? shared / union : 0;
      // Require at least 10% noun overlap (very conservative)
      // Also: if one side has many unique nouns and the other doesn't share → reject
      if (shared === 0) {
        // v19.92.0: If normalized titles match exactly, allow merge even with no shared nouns
        if (title1 && title2 && norm(title1) === norm(title2)) return true;
        return false; // No shared product nouns at all → different products
      }
      if (jaccard < 0.25 && Math.min(kA.length, kB.length) >= 2) {
        // v19.92.0: If normalized titles match exactly, lower threshold
        if (title1 && title2 && norm(title1) === norm(title2)) return true;
        return false;
      }
      return true;
    }
    // Case 2: One has specific specs, other only generic → reject
    if ((specific1.length > 0 && specific2.length === 0) ||
        (specific1.length === 0 && specific2.length > 0)) {
      return false;
    }
    // Case 3: Both only generic specs → require title similarity
    // Colors/sizes alone don't prove same product (phone stand vs glove both have white/black/gray)
    // Must also have similar titles to confirm same product
    if (title1 && title2) {
      var titleSim = jaroWinkler(norm(title1), norm(title2));
      if (titleSim >= 0.80) return true;  // Similar titles + generic specs = same product variants
      return false;  // Different titles + generic specs = different products
    }
    // No titles available → conservative: require high spec overlap
    var gSim = specOverlap(spec1, spec2);
    if (gSim >= 0.80) return true;
    return false;
  }


  function fetchAllRecords() {
    return fetchAllRecordsFromTable(AT, (typeof TT !== 'undefined' ? TT : PROC_TABLE));
  }

  return fetchAllRecords().then(function(allRecords) {
    // v19.92.0: Only merge today's records — don't mix with yesterday's data
    var dedupStart = new Date();
    dedupStart.setHours(0, 0, 0, 0);
    var dedupTodayMs = dedupStart.getTime();
    var dedupTomorrowMs = dedupTodayMs + 86400000;

    var records = allRecords.filter(function(rec) {
      var f = rec.fields || {};
      var dateVal = f['🏗 【创建/绑定】日期'] || f['创建时间引导'] || f['创建时间'] || f['📅 抓取日期'];
      if (!dateVal) return false;
      var ts = typeof dateVal === 'number' ? dateVal : 0;
      // v19.92.0: Also parse ISO string dates
      if (ts === 0 && typeof dateVal === 'string') {
        var parsed = Date.parse(dateVal);
        if (!isNaN(parsed)) ts = parsed;
      }
      if (ts === 0) return false;
      return ts >= dedupTodayMs && ts < dedupTomorrowMs;
    });

    L('获取到全部 ' + allRecords.length + ' 条 / 今日 ' + records.length + ' 条', 'i');
    if (!records || records.length <= 1) {
      L('无需合并: 今日仅 ' + (records ? records.length : 0) + ' 条记录', 'i');
      return Promise.resolve({merged:0, deleted:0, total: records ? records.length : 0, remaining: records ? records.length : 0});
    }
    L('开始多轮向量合并 (仅今日数据)...', 'i');

    var all = records.map(function(rec) {
      var f = rec.fields || {};
      return {
        rid: rec.record_id,
        platform: sv(f['平台所属账号']) || sv(f['平台【文字】']) || '',
        title: sv(f['\ud83d\udce1 商品全称']),
        pid: cleanPid(sv(f['商品 \ud83c\udd94'])),
        spec: sv(f['\ud83d\udea7 \u2757【时段】产品需求值']).replace(/[：；]/g, ';').replace(/;\s*;/g, ';'),
        img: sv(f['\ud83d\uddbc 产品图URL']) || sv(f['图片URL']) || '',
        normTitle: norm(sv(f['\ud83d\udce1 商品全称'])),
        coreType: coreType(sv(f['\ud83d\udce1 商品全称'])),
        feature: featureWords(sv(f['\ud83d\udce1 商品全称'])),
        platformSpecs: sv(f['平台规格明细']) || '',
        cores: extractProductCore(sv(f['\ud83d\udce1 商品全称']), sv(f['\ud83d\udea7 \u2757【时段】产品需求值'])),
        status: sv(f['手动传输状态']) || sv(f['状态']) || sv(f['🚃 状态🌅']) || ''
      };
    });

    // === CONVERGENCE LOOP (v19.92.0) ===
    var allItems = all;
    var totalMergedAll = 0, totalDeletedAll = 0, passNum = 0;
    var MAX_PASSES = 8;

    function findMerges(items) {
      var cur = items;  // current pass's items
      var matched = {}, mergeGroups = [], rs = {};
      // recompute derived properties for each pass
      items.forEach(function(r) {
        r.normTitle = norm(r.title);
        r.coreType = coreType(r.title);
        r.feature = featureWords(r.title);
        r.cores = extractProductCore(r.title, r.spec);
        r.normSfx = r.normTitle.replace(/[-\s]*[a-z0-9]{1,6}$/, '').trim();
      });

    // R1: 后缀精确
    var sg = {};
    cur.forEach(function(r, i) {
      var s = r.normTitle.replace(/[-\s]*[a-z0-9]{1,6}$/, '').trim();
      r.normSfx = s;
      if (!sg[s]) sg[s] = [];
      if (s.length >= 8) sg[s].push(i);
    });
    Object.keys(sg).forEach(function(k) {
      if (sg[k].length >= 2) {
        // Type + spec compatibility check
        var group = sg[k];
        var types = gType(cur[group[0]].title);
        var compatible = [group[0]];
        for (var gi = 1; gi < group.length; gi++) {
          var tj = gType(cur[group[gi]].title);
          var titleExact = (cur[group[0]].normTitle === cur[group[gi]].normTitle);
          if (statusCompat(cur[group[0]], cur[group[gi]]) && (titleExact || (tCompat(types, tj) && specCompat(cur[group[0]].spec, cur[group[gi]].spec, cur[group[0]].title, cur[group[gi]].title)))) compatible.push(group[gi]);
        }
        if (compatible.length >= 2) {
          mergeGroups.push(compatible);
          compatible.forEach(function(i) { matched[i] = 1; });
        }
      }
    });
    rs.R1 = mergeGroups.length;
    L('R1 后缀精确匹配: ' + rs.R1 + ' 组', 'i');

    // R2a: Jaro-Winkler 88%+
    var u1 = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u1.push(i); }
    var r2a = [], ua = {};
    u1.forEach(function(i) {
      if (ua[i]) return; var ni = cur[i].normTitle; if (ni.length < 4) return;
      var ti = gType(cur[i].title);
      var g = [i];
      for (var j = i + 1; j < cur.length; j++) {
        if (matched[j] || ua[j]) continue; var nj = cur[j].normTitle; if (nj.length < 4) continue;
        var lenRatio = Math.abs(ni.length - nj.length) / Math.max(ni.length, nj.length);
        if (jaroWinkler(ni, nj) >= 0.88 && lenRatio <= 0.12) {
          var tj = gType(cur[j].title);
          if (statusCompat(cur[i], cur[j]) && tCompat(ti, tj) && specCompat(cur[i].spec, cur[j].spec, cur[i].title, cur[j].title)) { g.push(j); ua[j] = 1; }
        }
      }
      if (g.length > 1) { ua[i] = 1; g.forEach(function(x) { matched[x] = 1; }); r2a.push(g); }
    });
    mergeGroups = mergeGroups.concat(r2a); rs.R2a = r2a.length;
    L('R2a Jaro-Winkler>=88%: ' + rs.R2a + ' 组', 'i');

    // R2b: 规格精确+标题
    var u2 = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u2.push(i); }
    var specMap = {};
    u2.forEach(function(i) {
      var sn = extractSpecNames(cur[i].spec);
      var keys = Object.keys(sn).sort();
      if (keys.length >= 1) {
        var key = keys.join('|');
        if (!specMap[key]) specMap[key] = [];
        specMap[key].push(i);
      }
    });
    var r2b = [];
    Object.keys(specMap).forEach(function(k) {
      var idx = specMap[k]; if (idx.length < 2) return;
      var f = [idx[0]];
      for (var jj = 1; jj < idx.length; jj++) {
        var j = idx[jj];
        var avgLen = Math.max(specAvgLen(cur[idx[0]].spec), specAvgLen(cur[j].spec));
        var thr = avgLen >= 12 ? 0.05 : avgLen >= 9 ? 0.10 : avgLen >= 6 ? 0.20 : avgLen >= 4 ? 0.30 : 0.40;
        if (diceSim(cur[idx[0]].normTitle, cur[j].normTitle) >= thr) f.push(j);
      }
      if (f.length >= 2) {
        var ok = true;
        for (var a = 0; a < f.length && ok; a++) {
          for (var b = a + 1; b < f.length && ok; b++) {
            var ti = gType(cur[f[a]].title);
            var tj = gType(cur[f[b]].title);
            if (Object.keys(ti).length && Object.keys(tj).length && !tCompat(ti, tj)) ok = false;
          }
        }
        if (ok) { f.forEach(function(i) { matched[i] = 1; }); r2b.push(f); }
      }
    });
    mergeGroups = mergeGroups.concat(r2b); rs.R2b = r2b.length;
    L('R2b 规格精确集+标题: ' + rs.R2b + ' 组', 'i');

    // R2i: 规格trigram+核心词(v19)
    var u2i = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u2i.push(i); }
    var r2i = [], u2i_map = {};
    u2i.forEach(function(i) {
      if (u2i_map[i]) return;
      var ni = cur[i].normTitle; if (ni.length < 4) return;
      var g = [i];
      for (var jj = 0; jj < u2i.length; jj++) {
        var j = u2i[jj]; if (j <= i || u2i_map[j]) continue;
        var nj = cur[j].normTitle; if (nj.length < 4) continue;
        if (!coreWordsCompat(cur[i].cores, cur[j].cores)) continue;
        var specTrig = specTrigMax(cur[i].spec, cur[j].spec);
        var avgSL = Math.max(specAvgLen(cur[i].spec), specAvgLen(cur[j].spec));
        if (specTrig >= 0.65 && avgSL >= 6) {
          var titleThr = avgSL >= 12 ? 0.20 : 0.30;
          var ti = gType(cur[i].title);
          var tj = gType(cur[j].title);
          if (statusCompat(cur[i], cur[j]) && jaroWinkler(ni, nj) >= titleThr && tCompat(ti, tj) && specCompat(cur[i].spec, cur[j].spec, cur[i].title, cur[j].title)) { g.push(j); u2i_map[j] = 1; }
        }
      }
      if (g.length > 1) { u2i_map[i] = 1; g.forEach(function(x) { matched[x] = 1; }); r2i.push(g); }
    });
    mergeGroups = mergeGroups.concat(r2i); rs.R2i = r2i.length;
    L('R2i 规格trigram+核心词: ' + rs.R2i + ' 组', 'i');

    // R2j: 规格overlap+核心词(v19)
    var u2j = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u2j.push(i); }
    var r2j = [], u2j_map = {};
    u2j.forEach(function(i) {
      if (u2j_map[i]) return;
      var ni = cur[i].normTitle; if (ni.length < 4) return;
      var g = [i];
      for (var jj = 0; jj < u2j.length; jj++) {
        var j = u2j[jj]; if (j <= i || u2j_map[j]) continue;
        var nj = cur[j].normTitle; if (nj.length < 4) continue;
        if (!coreWordsCompat(cur[i].cores, cur[j].cores)) continue;
        if (specOverlap(cur[i].spec, cur[j].spec) >= 0.70) {
          var titleScore = Math.max(jaroWinkler(ni, nj), diceSim(ni, nj));
          if (titleScore >= 0.20) { g.push(j); u2j_map[j] = 1; }
        }
      }
      if (g.length > 1) { u2j_map[i] = 1; g.forEach(function(x) { matched[x] = 1; }); r2j.push(g); }
    });
    mergeGroups = mergeGroups.concat(r2j); rs.R2j = r2j.length;
    L('R2j 规格overlap+核心词: ' + rs.R2j + ' 组', 'i');

    // R2c: 规格trigram+标题
    var u3 = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u3.push(i); }
    var r2c = [], uc = {};
    u3.forEach(function(i) {
      if (uc[i]) return;
      var si = extractSpecNames(cur[i].spec), ki = Object.keys(si);
      if (!ki.length) return;
      var g = [i];
      for (var jj = 0; jj < u3.length; jj++) {
        var j = u3[jj]; if (j <= i || uc[j]) continue;
        var sj = extractSpecNames(cur[j].spec), kj = Object.keys(sj);
        if (!kj.length) continue;
        var specTrig = 0;
        ki.forEach(function(a) { kj.forEach(function(b) {
          var s = triSim(a, b); if (s > specTrig) specTrig = s;
        }); });
        if (specTrig < 0.50) continue;
        var ti = gType(cur[i].title);
        var tj = gType(cur[j].title);
        if (statusCompat(cur[i], cur[j]) && jaroWinkler(cur[i].normTitle, cur[j].normTitle) >= 0.45 && tCompat(ti, tj) && specCompat(cur[i].spec, cur[j].spec, cur[i].title, cur[j].title)) { g.push(j); uc[j] = 1; }
      }
      if (g.length > 1) { uc[i] = 1; g.forEach(function(x) { matched[x] = 1; }); r2c.push(g); }
    });
    mergeGroups = mergeGroups.concat(r2c); rs.R2c = r2c.length;
    L('R2c 规格trigram+JW: ' + rs.R2c + ' 组', 'i');

    // R2d: Dice70%+规格token
    var u4 = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u4.push(i); }
    var r2d = [], ud = {};
    u4.forEach(function(i) {
      if (ud[i]) return; var ni = cur[i].normTitle; if (ni.length < 4) return;
      var g = [i];
      for (var jj = 0; jj < u4.length; jj++) {
        var j = u4[jj]; if (j <= i || ud[j]) continue; var nj = cur[j].normTitle; if (nj.length < 4) continue;
        if (diceSim(ni, nj) >= 0.60) {
          var sto = specTokenOverlap(cur[i].spec, cur[j].spec);
          if (sto >= 0.25) {
            var ti = gType(cur[i].title);
            var tj = gType(cur[j].title);
            if (statusCompat(cur[i], cur[j]) && tCompat(ti, tj) && specCompat(cur[i].spec, cur[j].spec, cur[i].title, cur[j].title)) { g.push(j); ud[j] = 1; }
          }
        }
      }
      if (g.length > 1) { ud[i] = 1; g.forEach(function(x) { matched[x] = 1; }); r2d.push(g); }
    });
    mergeGroups = mergeGroups.concat(r2d); rs.R2d = r2d.length;
    L('R2d Dice>=70%+规格token: ' + rs.R2d + ' 组', 'i');

    // R2e: 核心类型+规格
    var u5 = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u5.push(i); }
    var r2e = [], ue = {};
    u5.forEach(function(i) {
      if (ue[i]) return; var ci = cur[i].coreType; if (ci.length < 4) return;
      var g = [i];
      for (var jj = 0; jj < u5.length; jj++) {
        var j = u5[jj]; if (j <= i || ue[j]) continue; var cj = cur[j].coreType; if (cj.length < 4) continue;
        if (diceSim(ci, cj) >= 0.50 && specTokenOverlap(cur[i].spec, cur[j].spec) >= 0.30) {
          var ti = gType(cur[i].title);
          var tj = gType(cur[j].title);
          if (statusCompat(cur[i], cur[j]) && tCompat(ti, tj) && specCompat(cur[i].spec, cur[j].spec, cur[i].title, cur[j].title)) { g.push(j); ue[j] = 1; }
        }
      }
      if (g.length > 1) { ue[i] = 1; g.forEach(function(x) { matched[x] = 1; }); r2e.push(g); }
    });
    mergeGroups = mergeGroups.concat(r2e); rs.R2e = r2e.length;
    L('R2e 核心类型+规格token: ' + rs.R2e + ' 组', 'i');

    // R2f: 多信号加权
    var u6 = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u6.push(i); }
    var r2f = [], uf = {};
    u6.forEach(function(i) {
      if (uf[i]) return; var ni = cur[i].normTitle; if (ni.length < 4) return;
      var g = [i];
      for (var jj = 0; jj < u6.length; jj++) {
        var j = u6[jj]; if (j <= i || uf[j]) continue; var nj = cur[j].normTitle; if (nj.length < 4) continue;
        if (multiSim(ni, nj, cur[i].spec, cur[j].spec) >= 0.50) {
          var ti = gType(cur[i].title);
          var tj = gType(cur[j].title);
          if (statusCompat(cur[i], cur[j]) && tCompat(ti, tj) && specCompat(cur[i].spec, cur[j].spec, cur[i].title, cur[j].title)) { g.push(j); uf[j] = 1; }
        }
      }
      if (g.length > 1) { uf[i] = 1; g.forEach(function(x) { matched[x] = 1; }); r2f.push(g); }
    });
    mergeGroups = mergeGroups.concat(r2f); rs.R2f = r2f.length;
    L('R2f 多信号加权: ' + rs.R2f + ' 组', 'i');

    // R2g: Title JW >= 0.75 + Spec overlap >= 0.80 (combined match)
    // Catches: similar title + very similar spec = same product, different packaging
    var u7 = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u7.push(i); }
    var r2g = [], ug = {};
    u7.forEach(function(i) {
      if (ug[i]) return; var ni = cur[i].normTitle; if (ni.length < 4) return;
      var g = [i];
      for (var jj = 0; jj < u7.length; jj++) {
        var j = u7[jj]; if (j <= i || ug[j]) continue; var nj = cur[j].normTitle; if (nj.length < 4) continue;
        var comp = compositeScore(ni, nj, cur[i].spec, cur[j].spec, cur[i].coreType, cur[j].coreType);
        // Combined: composite score >= 0.72 (title 40% + spec 40% + type 20%)
        if (comp >= 0.72) {
          var ti = gType(cur[i].title);
          var tj = gType(cur[j].title);
          if (statusCompat(cur[i], cur[j]) && tCompat(ti, tj) && specCompat(cur[i].spec, cur[j].spec, cur[i].title, cur[j].title)) { g.push(j); ug[j] = 1; }
        }
      }
      if (g.length > 1) { ug[i] = 1; g.forEach(function(x) { matched[x] = 1; }); r2g.push(g); }
    });
    mergeGroups = mergeGroups.concat(r2g); rs.R2g = r2g.length;
    L('R2g 标题JW+规格联合: ' + rs.R2g + ' 组', 'i');

    // R2h: Cosine similarity + Spec token Jaccard (catches products with similar character distribution)
    var u8 = []; for (var i = 0; i < cur.length; i++) { if (!matched[i]) u8.push(i); }
    var r2h = [], uh = {};
    u8.forEach(function(i) {
      if (uh[i]) return; var ni = cur[i].normTitle; if (ni.length < 6) return;
      var g = [i];
      for (var jj = 0; jj < u8.length; jj++) {
        var j = u8[jj]; if (j <= i || uh[j]) continue; var nj = cur[j].normTitle; if (nj.length < 6) continue;
        var cosScore = cosineSim(ni, nj);
        var tokScore = tokenJaccard(ni, nj);
        var specTokScore = tokenJaccard(cur[i].spec, cur[j].spec);
        // Cosine >= 0.75 AND (title token overlap >= 0.30 OR spec token overlap >= 0.50)
        if (cosScore >= 0.75 && (tokScore >= 0.30 || specTokScore >= 0.50)) {
          var ti = gType(cur[i].title);
          var tj = gType(cur[j].title);
          if (statusCompat(cur[i], cur[j]) && tCompat(ti, tj) && specCompat(cur[i].spec, cur[j].spec, cur[i].title, cur[j].title)) { g.push(j); uh[j] = 1; }
        }
      }
      if (g.length > 1) { uh[i] = 1; g.forEach(function(x) { matched[x] = 1; }); r2h.push(g); }
    });
    mergeGroups = mergeGroups.concat(r2h); rs.R2h = r2h.length;
    L('R2h 余弦+Token: ' + rs.R2h + ' 组', 'i');

      return {mergeGroups: mergeGroups, matched: matched, rs: rs};
    } // end findMerges

    // === CONVERGENCE LOOP (v19.92.0) ===
    var origToFinal = {};
    var finalToOrig = {};
    allItems.forEach(function(item, idx) {
      origToFinal[idx] = item;
      finalToOrig[item.rid] = [idx];
    });

    function yieldMs(ms) {
      return new Promise(function(r) { setTimeout(r, ms || 20); });
    }

    function runOnePass(pn) {
      var t0 = Date.now();
      var res = findMerges(allItems);
      var mg = res.mergeGroups;
      var elapsed = Date.now() - t0;
      L('Pass ' + pn + ': ' + mg.length + ' 组 (' + elapsed + 'ms)', 'i');

      if (mg.length === 0) return Promise.resolve({done: true, groups: 0});

      totalMergedAll += mg.length;
      var deleteSet = {};
      mg.forEach(function(grp) {
        var vg = grp.filter(function(idx) { return idx >= 0 && idx < allItems.length && allItems[idx]; });
        if (vg.length < 2) return;
        if (vg.length > 1) L('[MERGE-GROUP] size=' + vg.length + ' platforms=' + vg.map(function(x){return allItems[x]?allItems[x].platform:'?'}).join(' | '), 'i');
        var keep = allItems[vg[0]];
        if (!keep) return;
        var pids = {}, specs = [], plats = {}, img = keep.img;
        var platformSpecs = keep.platformSpecs ? JSON.parse(keep.platformSpecs) : {};
        vg.forEach(function(idx) {
          var r = allItems[idx];
          if (r.pid) r.pid.split('\n').forEach(function(p) { p = p.trim(); if (p) pids[p] = 1; });
          if (r.spec) specs.push(r.spec);
          if (!img && r.img) img = r.img;
          if (r.platform) {
            plats[r.platform] = 1;
            // Track per-platform specs for procurement sync
            if (!platformSpecs[r.platform]) platformSpecs[r.platform] = r.spec || '';
            else platformSpecs[r.platform] = mergeSpecs([platformSpecs[r.platform], r.spec || '']);
          }
        });
        keep.pid = Object.keys(pids).join('\n');
        keep.spec = mergeSpecs(specs);
        keep.img = (img && isValidUrl(img)) ? img : keep.img;
        var pa = [];
        Object.keys(plats).forEach(function(p) { if (pa.indexOf(p) < 0) pa.push(p); });
        keep.platform = pa.join('\n');
        if (pa.length > 1) L('[MERGE-PLAT] rid=' + keep.rid + ' plats=' + JSON.stringify(pa) + ' joined=' + keep.platform, 'i');
        keep.platformSpecs = JSON.stringify(platformSpecs);
        vg.slice(1).forEach(function(idx) {
          deleteSet[idx] = 1;
          totalDeletedAll++;
          var dr = allItems[idx].rid;
          var oi = finalToOrig[dr] || [];
          oi.forEach(function(x) { origToFinal[x] = keep; });
          if (!finalToOrig[keep.rid]) finalToOrig[keep.rid] = [];
          finalToOrig[keep.rid] = finalToOrig[keep.rid].concat(oi);
          delete finalToOrig[dr];
        });
      });

      var ni = [];
      allItems.forEach(function(item, idx) { if (!deleteSet[idx]) ni.push(item); });
      allItems = ni;
      L('Pass ' + pn + ' 剩余: ' + allItems.length + ' 条', 'i');
      return Promise.resolve({done: false, groups: mg.length});
    }

    var MAX_MERGE_PASSES = 8;
    function runConvergence(pn) {
      if (pn > MAX_MERGE_PASSES) return Promise.resolve();
      return runOnePass(pn).then(function(r) {
        if (r.done) { passNum = pn; return Promise.resolve(); }
        return yieldMs(30).then(function() { passNum = pn; return runConvergence(pn + 1); });
      });
    }

    L('开始收敛合并...', 'i');
    return runConvergence(1).then(function finalStats() {
      all = allItems;

      mergeGroups = [];
      var deleteIds = [];
      allItems.forEach(function(fi) {
        var oi = finalToOrig[fi.rid] || [];
        if (oi.length > 1) mergeGroups.push(oi);
      });
      var fr = {};
      allItems.forEach(function(item) { fr[item.rid] = 1; });
      records.forEach(function(rec) {
        if (!fr[rec.record_id]) deleteIds.push(rec.record_id);
      });

      var deleted = deleteIds.length;
      var origTotal = records.length;
      L('--- 分析结果 (' + passNum + ' 轮收敛) ---', 'i');
      L('原始记录: ' + origTotal + ' 条', 'i');
      L('合并组数: ' + mergeGroups.length + ' 组', 'i');
      L('将删除冗余: ' + deleted + ' 条', 'i');
      L('预计剩余: ' + all.length + ' 条 (原 ' + origTotal + ' 条)', 'i');

      var totalGroups = mergeGroups.length;
      if (totalGroups === 0) {
        L('无需合并: 全部 ' + all.length + ' 条记录均为独立产品', 'i');
        return {merged:0, deleted:0, total:all.length, remaining:all.length};
      }

      // Detect actual field names in target table
      return detectTableFields(AT, (typeof TT !== 'undefined' ? TT : PROC_TABLE)).then(function(fieldMap) {
        var FM_TITLE = resolveField(fieldMap, ['\ud83d\udce1 \u5546\u54c1\u5168\u79f0', '\u5546\u54c1\u5168\u79f0', '\u5546\u54c1\u6807\u9898']);
        var FM_SPEC = resolveField(fieldMap, ['\ud83d\udea7 \u2757\u3010\u65f6\u6bb5\u3011\u4ea7\u54c1\u9700\u6c42\u503c', '\u2757\u3010\u65f6\u6bb5\u3011\u4ea7\u54c1\u9700\u6c42\u503c', '\u4ea7\u54c1\u9700\u6c42\u503c', '\u89c4\u683c\u9700\u6c42']);
        var FM_PLAT = resolveField(fieldMap, ['\u5e73\u53f0\u6240\u5c5e\u8d26\u53f7', '\u5e73\u53f0\u3010\u6587\u5b57\u3011', '\u5e73\u53f0', '\u5e73\u53f0\u6587\u5b57']);
        var FM_PSPEC = resolveField(fieldMap, ['\u5e73\u53f0\u89c4\u683c\u660e\u7ec6']);
        L('\u5408\u5e76\u5b57\u6bb5: T='+(FM_TITLE||'?')+' S='+(FM_SPEC||'?')+' P='+(FM_PLAT||'?')+' PS='+(FM_PSPEC||'?'), 'i');
        [FM_TITLE, FM_SPEC, FM_PLAT, FM_PSPEC].forEach(function(fn) {
          if (fn && fieldMap[fn]) L('[DIAG] 字段类型: ' + fn + ' type=' + fieldMap[fn].type, 'i');
        });

        var updatePlan = [];
        // v19.92.0: Resolve status field for merge
        var FM_STATUS = resolveField(fieldMap, ['手动传输状态', '状态', '🚃 状态🌅', '传输状态']);
        allItems.forEach(function(item) {
          var fields = {};
          if (FM_TITLE && item.title) fields[FM_TITLE] = item.title;
          if (FM_SPEC && item.spec) fields[FM_SPEC] = item.spec;
          if (FM_PLAT && item.platform) fields[FM_PLAT] = item.platform;
          if (FM_PSPEC && item.platformSpecs) fields[FM_PSPEC] = item.platformSpecs;
          // v19.92.0: Status-aware merge — if ANY merged record has "已打单", keep it
          if (FM_STATUS) {
            var origIds = finalToOrig[item.rid] || [item.rid];
            var hasPrinted = false;
            origIds.forEach(function(oid) {
              var origRec = records.find(function(r) { return r.record_id === oid; });
              if (origRec) {
                var st = sv(origRec.fields['手动传输状态']) || sv(origRec.fields['状态']) || sv(origRec.fields['🚃 状态🌅']) || sv(origRec.fields['传输状态']) || '';
                if (st === '已打单') hasPrinted = true;
              }
            });
            if (hasPrinted) fields[FM_STATUS] = '已打单';
          }
          updatePlan.push({ keep: item.rid, fields: fields });
        });

      // === DIAG v19.92.0: Log first record payload ===
      if (updatePlan.length > 0 && FM_PLAT) {
        var sample = updatePlan[0];
        var fnames = Object.keys(sample.fields);
        L('[DIAG] \u9996\u6761\u66f4\u65b0\u8f7d\u8377: rid=' + sample.keep + ' fields=[' + fnames.join(', ') + ']', 'i');
        fnames.forEach(function(fn) {
          var val = sample.fields[fn];
          var preview = typeof val === 'string' ? val.substring(0, 80) : JSON.stringify(val).substring(0, 80);
          L('[DIAG]   ' + fn + ' = ' + preview, 'i');
        });
        var multiPlat = 0;
        updatePlan.forEach(function(p) { if (p.fields[FM_PLAT] && p.fields[FM_PLAT].indexOf('\n') >= 0) multiPlat++; });
        L('[DIAG] \u591a\u5e73\u53f0\u8bb0\u5f55: ' + multiPlat + ' / ' + updatePlan.length, 'i');
      }

      L('执行飞书API合并...', 'i');
      L('更新保留记录: ' + updatePlan.length + ' 条', 'i');
      L('删除冗余记录: ' + deleteIds.length + ' 条', 'i');

      return getToken().then(function(t) {
        var chain = Promise.resolve();
        for (var i = 0; i < updatePlan.length; i += BATCH_SIZE) {
          (function(batch) {
            chain = chain.then(function() {
              var recs = batch.map(function(p) { return {record_id: p.keep, fields: p.fields}; });
              // Log first record payload for debugging
              if (recs.length > 0 && !window._mergePayloadLogged) {
                window._mergePayloadLogged = true;
                L('[REQ] batch#' + Math.floor(i/100) + ' recs=' + recs.length + ' first=' + JSON.stringify(recs[0]).substring(0,400), 'i');
              }
              return feishuProxy(
                'https://open.feishu.cn/open-apis/bitable/v1/apps/'+AT+'/tables/'+(typeof TT !== 'undefined' ? TT : PROC_TABLE)+'/records/batch_update',
                'POST', {'Authorization':'Bearer '+t,'Content-Type':'application/json'},
                JSON.stringify({records: recs})
              ).then(function(d) {
                if (d.code === 0) {
                  L('更新批次\u2713 ' + recs.length + '条', 'i');
                  if (d.data && d.data.records) {
                    // Feishu batch_update response: data.records has record_id + fields (no code/msg per record)
                    // Success means ALL records updated. Per-record errors would show in top-level code != 0.
                    L('[OK] batch ' + recs.length + ' records written successfully', 'i');
                  }
                } else {
                  L('更新错误: ' + d.code + ' ' + d.msg + ' detail=' + JSON.stringify(d).substring(0,300), 'e');
                  if (d.data && d.data.records) {
                    var ff = d.data.records.find(function(r) { return r.code !== 0; });
                    if (ff) L('[DEBUG] 失败记录: ' + JSON.stringify(ff).substring(0,300), 'e');
                  }
                  throw new Error('合并保留行更新失败: ' + d.code + ' ' + d.msg);
                }
              }).catch(function(e) {
                L('[STOP] 保留行未全部更新，已取消全部删除: ' + e.message, 'e');
                throw e;
              });
            });
          })(updatePlan.slice(i, i + 100));
        }
        for (var i = 0; i < deleteIds.length; i += BATCH_SIZE) {
          (function(batch) {
            chain = chain.then(function() {
              return feishuProxy(
                'https://open.feishu.cn/open-apis/bitable/v1/apps/'+AT+'/tables/'+(typeof TT !== 'undefined' ? TT : PROC_TABLE)+'/records/batch_delete',
                'POST', {'Authorization':'Bearer '+t,'Content-Type':'application/json'},
                JSON.stringify({records: batch})
              ).then(function(d) {
                if (d.code === 0) L('删除批次\u2713 ' + batch.length + '条', 'i');
                else {
                  L('删除错误: ' + d.code + ' ' + d.msg, 'e');
                  throw new Error('合并删除失败: ' + d.code + ' ' + d.msg);
                }
              });
            });
          })(deleteIds.slice(i, i + 100));
        }
        return chain.then(function() {
          var remaining = all.length;
          var origTotal = records.length;
          var mergeRate = origTotal > 0 ? (deleted / origTotal * 100).toFixed(1) : '0.0';
          L('--- 合并统计 ---', 'i');
          L('原始记录: ' + origTotal + ' 条', 'i');
          L('合并组数: ' + mergeGroups.length + ' 组', 'i');
          L('删除冗余: ' + deleted + ' 条', 'i');
          L('最终剩余: ' + remaining + ' 条', 's');
          L('合并率: ' + mergeRate + '%', 's');
          L('================', 'i');
          return {merged: mergeGroups.length, deleted: deleted, total: origTotal, remaining: remaining};
        });
      });
      }); // close detectTableFields.then
    });
  });
}


// ====== SYNC TO PROCUREMENT TABLE (v19.92.0) ======

// ====== LOOKUP & MATCH UTILITIES ======
function extractRecFields(rec) {
  var f = rec.fields || {};
  // Try multiple field name patterns for each field
  var pid = sv(f['商品 🆔']) || sv(f['🔗 商品ID']) || sv(f['商品ID']) || sv(f['商品 ID']) || sv(f['🔗ID']) || '';
  var title = sv(f['📡 商品全称']) || sv(f['商品全称']) || sv(f['商品标题']) || '';
  var spec = sv(f['🚧 ❗【时段】产品需求值']) || sv(f['❗【时段】产品需求值']) || sv(f['产品需求值']) || sv(f['规格需求']) || '';
  var img = '';
  var imgF = f['🖼 产品图URL'] || f['图片URL'] || f['【图片URL】'];
  if (imgF) {
    if (typeof imgF === 'string') img = imgF;
    else if (imgF.link) img = imgF.link;
    else if (imgF.text) img = imgF.text;
    else if (Array.isArray(imgF) && imgF[0]) img = imgF[0].link || imgF[0].text || '';
  }
  var platform = sv(f['平台所属账号']) || sv(f['平台【文字】']) || sv(f['平台']) || sv(f['平台文字']) || '';
  var platformSpecs = sv(f['平台规格明细']) || '';
  var status = sv(f['手动传输状态']) || sv(f['状态']) || sv(f['🚃 状态🌅']) || sv(f['传输状态']) || '';
  var totalQty = 0;
  if (spec) {
    spec.split('\n').forEach(function(line) {
      var parts = line.split(';');
      if (parts.length >= 2) totalQty += Number(parts[parts.length - 1]) || 0;
    });
  }
  return {pid: pid, title: title, spec: spec, img: img, platform: platform, platformSpecs: platformSpecs, status: status, totalQty: totalQty, rec: rec};
}

function buildLookupMaps(records) {
  var byPid = {}, byTitle = {};
  records.forEach(function(rec) {
    var src = extractRecFields(rec);
    if (src.pid) {
      src.pid.split(/[\n,]/).forEach(function(p) {
        p = p.trim();
        if (!p) return;
        if (!byPid[p]) byPid[p] = [];
        byPid[p].push(rec);
      });
    }
    if (src.title) {
      var tn = canonicalProcurementTitleKey(src.title);
      if (!byTitle[tn]) byTitle[tn] = [];
      byTitle[tn].push(rec);
    }
  });
  return {byPid: byPid, byTitle: byTitle};
}

function matchRecord(pid, title, lookup, platform, strictPlatform) {
  strictPlatform = strictPlatform === true;
  platform = String(platform || '').trim();
  if (strictPlatform && !platform) return null;
  function platformCandidateAllowed(rec) {
    if (!strictPlatform) return true;
    var existing = extractRecFields(rec);
    return procurementPlatformContains(existing.platform || '', platform);
  }
  function pidCandidateSafe(rec) {
    if (!rec || !title) return true;
    var existing = extractRecFields(rec);
    if (!existing.title) return true;
    // A PID is a candidate key, not proof that the product family is the
    // same. Store-side product groups can contain unrelated listings.
    if (procurementFamilyConflict(
      {title:title, spec:''},
      {title:existing.title, spec:existing.spec || ''}
    )) return false;
    if (procurementModelConflict({title:title}, {title:existing.title})) return false;
    return !coreProductConflict(
      title, '', existing.title, existing.spec || ''
    ).conflict;
  }

  // v19.77.1: Step 0 - PID + spec exact match (most precise)
  if (pid && lookup.byPidSpec && title) {
    var pids = pid.split(/[\n,]/);
    // Extract first spec from title (e.g. "【粉色】腰托支撑矫正坐姿")
    var specMatch = title.match(/【[^】]+】/);
    var specHint = specMatch ? specMatch[0] : '';
    if (specHint) {
      for (var si = 0; si < pids.length; si++) {
        var sp = pids[si].trim();
        if (!sp) continue;
        var specKey = sp + '::' + specHint;
        // Try exact spec match in byPidSpec
        if (lookup.byPidSpec[specKey]) {
          var rec = lookup.byPidSpec[specKey];
          var recPlat = sv((rec.fields||{})['平台所属账号']) || sv((rec.fields||{})['平台【文字】']) || sv((rec.fields||{})['平台']) || '';
          if ((strictPlatform ? platformCandidateAllowed(rec) : (!platform || recPlat === platform))
              && pidCandidateSafe(rec)) return {rec: rec, type: 'PID_SPEC'};
        }
        // Also try partial match (spec contains or is contained)
        var specKeys = Object.keys(lookup.byPidSpec);
        for (var ski = 0; ski < specKeys.length; ski++) {
          if (specKeys[ski].indexOf(sp + '::') !== 0) continue;
          var existingSpec = specKeys[ski].split('::')[1] || '';
          if (existingSpec.indexOf(specHint) >= 0 || specHint.indexOf(existingSpec) >= 0) {
            var rec2 = lookup.byPidSpec[specKeys[ski]];
            var recPlat2 = sv((rec2.fields||{})['平台所属账号']) || sv((rec2.fields||{})['平台【文字】']) || sv((rec2.fields||{})['平台']) || '';
            if ((strictPlatform ? platformCandidateAllowed(rec2) : (!platform || recPlat2 === platform))
                && pidCandidateSafe(rec2)) return {rec: rec2, type: 'PID_SPEC'};
          }
        }
      }
    }
  }

  // 1. PID exact match (prefer same platform, then best spec match)
  if (pid) {
    var pids = pid.split(/[\n,]/);
    // First try same-platform PID match
    if (platform) {
      var samePlatformPidCandidates = [];
      for (var i = 0; i < pids.length; i++) {
        var p = pids[i].trim();
        if (p && lookup.byPid[p]) {
          var recs = Array.isArray(lookup.byPid[p]) ? lookup.byPid[p] : [lookup.byPid[p]];
          for (var ri = 0; ri < recs.length; ri++) {
            var rec = recs[ri];
            var recPlat = sv((rec.fields||{})['平台所属账号']) || sv((rec.fields||{})['平台【文字】']) || sv((rec.fields||{})['平台']) || '';
            if ((strictPlatform ? platformCandidateAllowed(rec) : recPlat === platform)
                && pidCandidateSafe(rec)) samePlatformPidCandidates.push(rec);
          }
        }
      }
      var preferredSamePlatformPid = chooseProcurementTitleRecord(
        samePlatformPidCandidates, '📡 商品全称', '手动传输状态', title
      );
      if (preferredSamePlatformPid) return {rec: preferredSamePlatformPid, type: 'PID'};
    }
    // Then try any-platform PID match in legacy/full-repair mode only.
    if (!strictPlatform) {
      var anyPlatformPidCandidates = [];
      for (var i = 0; i < pids.length; i++) {
        var p = pids[i].trim();
        if (p && lookup.byPid[p]) {
          var recs2 = Array.isArray(lookup.byPid[p]) ? lookup.byPid[p] : [lookup.byPid[p]];
          for (var rj = 0; rj < recs2.length; rj++) {
            if (pidCandidateSafe(recs2[rj])) anyPlatformPidCandidates.push(recs2[rj]);
          }
        }
      }
      var preferredAnyPlatformPid = chooseProcurementTitleRecord(
        anyPlatformPidCandidates, '📡 商品全称', '手动传输状态', title
      );
      if (preferredAnyPlatformPid) return {rec: preferredAnyPlatformPid, type: 'PID'};
    }
  }
  // 2. Title exact match (prefer same platform)
  if (title) {
    var tn = canonicalProcurementTitleKey(title);
    if (lookup.byTitle[tn] && lookup.byTitle[tn].length > 0) {
      // Prefer same platform
      if (platform) {
        var samePlatformTitleRecords = [];
        for (var i = 0; i < lookup.byTitle[tn].length; i++) {
          var rec = lookup.byTitle[tn][i];
          var recPlat = sv((rec.fields||{})['平台所属账号']) || sv((rec.fields||{})['平台【文字】']) || sv((rec.fields||{})['平台']) || '';
          if ((strictPlatform ? platformCandidateAllowed(rec) : recPlat === platform)) {
            samePlatformTitleRecords.push(rec);
          }
        }
        var preferredTitleRecord = chooseProcurementTitleRecord(
          samePlatformTitleRecords, '📡 商品全称', '手动传输状态'
        );
        if (preferredTitleRecord) return {rec: preferredTitleRecord, type: 'TITLE'};
      }
      if (!strictPlatform) {
        var preferredAnyPlatformRecord = chooseProcurementTitleRecord(
          lookup.byTitle[tn], '📡 商品全称', '手动传输状态'
        );
        if (preferredAnyPlatformRecord) return {rec: preferredAnyPlatformRecord, type: 'TITLE'};
      }
    }
  }
  // 3. Title fuzzy match (Jaro-Winkler >= 0.88)
  if (title) {
    var tn2 = norm(title);
    var bestScore = 0, bestRec = null;
    var allTitles = Object.keys(lookup.byTitle);
    for (var i = 0; i < allTitles.length; i++) {
      var score = jaroWinkler(tn2, allTitles[i]);
      var fuzzyRecords = lookup.byTitle[allTitles[i]] || [];
      for (var fi = 0; fi < fuzzyRecords.length; fi++) {
        var fuzzyRec = fuzzyRecords[fi];
        if (strictPlatform && !platformCandidateAllowed(fuzzyRec)) continue;
        if (score > bestScore) {
          bestScore = score;
          bestRec = fuzzyRec;
        }
      }
    }
    if (bestScore >= 0.88 && bestRec) {
      return {rec: bestRec, type: 'FUZZY'};
    }
  }
  return null;
}

function mergeUniqueTextLines(a, b) {
  var seen = {}, out = [];
  String(a || '').split(/\n/).concat(String(b || '').split(/\n/)).forEach(function(line) {
    line = line.trim();
    if (line && !seen[line]) { seen[line] = 1; out.push(line); }
  });
  return out.join('\n');
}

function mergeProcurementSpecLines(a, b) {
  var qty = {}, order = [], passthrough = {};
  String(a || '').split(/\n/).concat(String(b || '').split(/\n/)).forEach(function(line) {
    line = line.trim();
    if (!line) return;
    var parts = line.replace(/；/g, ';').split(';');
    var last = parts.length > 1 ? parts[parts.length - 1].trim() : '';
    var name = parts.length > 1 ? parts.slice(0, -1).join(';').trim() : '';
    if (name && /^-?\d+(?:\.\d+)?$/.test(last)) {
      if (!Object.prototype.hasOwnProperty.call(qty, name)) {
        qty[name] = 0; order.push(name);
      }
      qty[name] += Number(last) || 0;
    } else if (!passthrough[line]) {
      passthrough[line] = 1; order.push('__RAW__' + line);
    }
  });
  return order.map(function(key) {
    return key.indexOf('__RAW__') === 0 ? key.slice(7) : key + ';' + qty[key];
  }).join('\n');
}

// ===== V20.29.3: 规格结构化解析 =====
// 把规格行解析为结构化维度（产品名/颜色/装数/尺寸/数量），
// 使合并从"文本相似"升级为"结构化产品身份匹配"。
var SPEC_ATTR_WORDS = /新款|升级|加厚|加大|特大|迷你|豪华|高端|精品|旗舰|经济|实惠|家用|车载|汽车|电动|智能|多功能|厨房|手工|缝纫|工具|神器|制作|适合|收纳|置物|材质|底盘|底座|置放|稳固|长度|宽度|高度|深度|直径|厚度|容量|承重|尺寸|规格|标准|水洗|无异味|干湿两用|贵在运费|聚划算|更划算|够用半年|不锈钢|食品级|高品质|大容量|便携|一次性|批发|热卖|爆款|包邮|超值|到手|赠|送|配|推荐|老师|红色|黄色|蓝色|绿色|黑色|白色|灰色|粉色|紫色|棕色|枪灰色|单色|双色|七彩|多彩|混色|变色|大号|中号|小号|均码|款|色|装|个|件|片|张|包|卷|套|条|只|把|块|米|厘米|cm|mm|升级版|新款|免打孔|免钉|免安装|可伸缩|折叠|防水|防滑|耐用|加厚|加大|常规|通用|特价|清仓|秒杀|抢购|热销|销量|好评|五星|旗舰店|直营|官方|正品|钜惠|屯货|囤货|优惠装|实惠装|超值优惠|特惠|新品体验|新品|体验装|体验款|客户选择|超值抢|限时|特卖|活动|促销|精选|必买|推荐款|人气|爆款|销量王|热卖款|到手价|到手片|到手个|大码|中码|小码|加肥|加大码|超码|超薄|加厚款|薄款|通用款|单件|单包|单片|双片|三片|四片|五片|六片|七片|八片|九片|十片|大号款|中号款|小号款/gi;

// V20.29.3: 提取规格行的主导产品名
// 策略：去掉属性词后，剩余的最长连续中文片段（3–10字）作为产品名；
// 纯属性行（只剩颜色/尺寸）返回空；家族表作为补充参照。
// V20.29.3: 提取规格行的主导产品名
// 策略：
// 1) 先去掉行尾配件尾巴（送X / +X / 赠X），避免"收纳盒"这类配件被当产品名
// 2) 家族表命中（核心名词）优先——最可靠
// 3) 家族未命中时，去属性词后取 3–6 字片段，优先含产品后缀词（梳/刀/刷/盒/袋/架/灯/夹/巾/垫/套/器/板/碗/勺/膜/贴/钩/扣/锁/帽/带/包/瓶/罐/盆/桶/铲/夹/夹子）的片段
function extractSpecLineProductName(line) {
  // 去掉行尾配件（送/赠/+收纳盒 等）
  var raw = String(line || '')
    .replace(/(?:送|赠|附送|附带|配|加送|含)[^;；]*$/, '')
    .replace(/\+\s*[^+]*$/, '')
    .replace(/[;；]\s*\d+(?:\.\d+)?\s*$/, '')
    .trim();
  var familyNoun = extractCoreProductNoun(raw);
  // 家族优先（家族词出现在原文）
  if (familyNoun && raw.indexOf(familyNoun) >= 0) return familyNoun;
  // 启发式：去属性词
  var cleaned = raw
    .replace(/[【】\[\]（）(){}]/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*[*×xX]\s*\d+(?:\.\d+)?\s*(?:cm|CM|厘米|mm|MM)?/g, ' ')
    .replace(/\d+(?:\.\d+)?\s*[*×xX]\s*\d+(?:\.\d+)?\s*[*×xX]\s*\d+(?:\.\d+)?\s*(?:cm|CM|厘米|mm|MM)?/g, ' ')
    .replace(SPEC_ATTR_WORDS, ' ')
    .replace(/[^\u4e00-\u9fff]+/g, ' ')
    .replace(/\s+/g, '')
    .trim();
  if (!cleaned) return '';
  // 优先含产品后缀词的 3-6 字片段
  var SUFFIX_RE = /(?:梳|刀|刷|盒|袋|架|灯|夹|巾|垫|套|器|板|碗|勺|膜|贴|钩|扣|锁|帽|带|包|瓶|罐|盆|桶|铲|梳子|刀片|挂钩|夹子|盒子|袋子|架子|灯珠|湿巾|纸巾|毛巾|浴巾|面罩|口罩|发卡|发箍|收纳|储物|置物|挂件|摆件|玩具|工具|套装|神器|喷枪|滤网|塞子|芯子|帘子|垫子|枕头|被子|床单|被套|鞋垫|袜子|手套|帽子|围巾|腰带|护膝|护腕)/;
  var best = '';
  for (var i = 0; i < cleaned.length; i++) {
    var maxLen = Math.min(6, cleaned.length - i);
    for (var len = maxLen; len >= 3; len--) {
      var sub = cleaned.substr(i, len);
      var hasSuffix = SUFFIX_RE.test(sub);
      if (hasSuffix && sub.length > best.length) {
        best = sub;
        break;
      }
    }
  }
  if (best.length >= 3) return best;
  // V20.29.3: 无后缀匹配：仅 ≥4 字片段返回（如"三孔眼睛嘴巴"=面罩描述），
  // 3 字内多为属性/材质/促销噪声（如"木浆棉""芭乐"），返回空避免误报。
  var bestNoSuffix = '';
  for (var j = 0; j < cleaned.length; j++) {
    var m2 = Math.min(6, cleaned.length - j);
    for (var len2 = m2; len2 >= 4; len2--) {
      var sub2 = cleaned.substr(j, len2);
      if (sub2.length > bestNoSuffix.length) { bestNoSuffix = sub2; break; }
    }
  }
  return bestNoSuffix.length >= 4 ? bestNoSuffix : '';
}

function parseSpecLine(line) {
  var raw = String(line || '').trim();
  var result = { qty: 0, color: '', size: '', packQty: '', productName: '', raw: raw, family: '' };
  if (!raw) return result;
  // 行尾数量: "名称;13"
  var qtyMatch = raw.match(/[;；]\s*(\d+(?:\.\d+)?)\s*$/);
  if (qtyMatch) {
    result.qty = Number(qtyMatch[1]);
    raw = raw.slice(0, qtyMatch.index);
  }
  // 颜色（常见颜色词 + 色）
  var colorMatch = raw.match(/(?:[粉黑灰白红蓝绿黄紫棕米橙青][^;；]*[色]|单色款|双色款|七彩款|多彩款|随机色)/);
  if (colorMatch) result.color = colorMatch[0];
  // 尺寸（数字×数字 + 单位，或 大号/中号/小号/特大号）
  var sizeMatch = raw.match(/\d+(?:\.\d+)?\s*[*×xX]\s*\d+(?:\.\d+)?\s*(?:cm|CM|厘米|mm|MM)?|\d+(?:\.\d+)?\s*[*×xX]\s*\d+(?:\.\d+)?\s*[*×xX]\s*\d+(?:\.\d+)?\s*(?:cm|CM|厘米|mm|MM)?|(?:特大号|大号|中号|小号|均码)/);
  if (sizeMatch) result.size = sizeMatch[0];
  // 装数: 【2个装】 / 【1包】 / 【10片】 / 2条装
  var packMatch = raw.match(/[【\[]\s*(\d+|[一二三四五六七八九十]+)\s*(个|件|片|张|包|卷|条|只|把|双|支|盒|袋|套|组|瓶|对)(?:装|入|片|个|张|条|只|把|双|支|盒|袋|套|组|瓶|对)?\s*[】\]]/);
  if (packMatch) result.packQty = packMatch[1] + packMatch[2] + '装';
  // 家族与产品名
  result.family = extractCoreProductNoun(raw);
  result.productName = extractSpecLineProductName(raw);
  return result;
}

function parseSpecStructure(spec) {
  return String(spec || '').split(/\n/).map(parseSpecLine).filter(function(l) { return l.raw; });
}

// 两组规格是否共享同一产品名（结构化身份比对）
function specStructuresShareProduct(structA, structB) {
  var namesA = {}, namesB = {};
  structA.forEach(function(s) {
    if (s.productName) namesA[s.productName] = 1;
    if (s.family) namesA['fam:' + s.family] = 1;
  });
  structB.forEach(function(s) {
    if (s.productName) namesB[s.productName] = 1;
    if (s.family) namesB['fam:' + s.family] = 1;
  });
  return Object.keys(namesA).some(function(k) { return namesB[k]; });
}

// 从规格中提取所有主导产品名（用于交叉污染检测）
function specStructuredProductNames(spec) {
  var names = {}, fams = {};
  parseSpecStructure(spec).forEach(function(s) {
    if (s.productName) names[s.productName] = (names[s.productName] || 0) + 1;
    if (s.family) fams[s.family] = (fams[s.family] || 0) + 1;
  });
  return { names: names, families: fams };
}

function procurementSpecQtyTotal(value) {
  return String(value || '').split(/\n/).reduce(function(sum, line) {
    var parts = line.replace(/；/g, ';').split(';');
    if (parts.length < 2) return sum;
    var qty = Number(parts[parts.length - 1].trim());
    return sum + (isFinite(qty) ? qty : 0);
  }, 0);
}

// Procurement-facing product clustering. Source rows remain separated by
// platform; only the purchaser view may cluster cross-account/cross-platform.
// A score must be high and clearly better than the runner-up to auto-merge.
function normalizeProcurementSpecName(value) {
  return String(value || '').toLowerCase()
    .replace(/[【】\[\]（）()]/g, '')
    .replace(/[;；]\s*-?\d+(?:\.\d+)?\s*$/, '')
    .replace(/[^\u4e00-\u9fffa-z0-9]/g, '');
}

function procurementSpecInformation(value) {
  var normalized = normalizeProcurementSpecName(value);
  var informative = normalized
    .replace(/\d+(?:个|件|支|条|袋|盒|双|片|张|包|瓶|罐|箱|只|把|根|块|卷|套|组)装?/g, '')
    .replace(/(?:一|二|两|三|四|五|六|七|八|九|十)+(?:个|件|支|条|袋|盒|双|片|张|包|瓶|罐|箱|只|把|根|块|卷|套|组)装?/g, '')
    .replace(/黑色|白色|红色|蓝色|绿色|粉色|紫色|黄色|灰色|棕色|透明|随机色|颜色随机|随机/g, '')
    .replace(/升级款|基础款|普通款|标准款|新款|热销|推荐|默认/g, '');
  return {normalized:normalized, informative:informative, length:informative.length};
}

// === 优化1: 规格结构分析 ===
// 提取规格中的结构化信息（颜色、尺寸、数量等）
function extractSpecStructure(spec) {
  var lines = String(spec || '').split('\n').filter(function(l) { return l.trim(); });
  var structure = {
    colors: {},      // 颜色
    sizes: {},       // 尺寸
    quantities: {},  // 数量模式
    materials: {},   // 材质
    patterns: {}     // 其他模式
  };
  
  var colorWords = ['红','橙','黄','绿','蓝','紫','粉','黑','白','灰','棕','米','金','银','青','浅','深','亮','暗','奶','杏','卡其','酒红','玫红','天蓝','墨绿','草绿','柠檬','橙色','粉色','蓝色','绿色','红色','黄色','黑色','白色','灰色','紫色','棕色','米色','金色','银色','青色'];
  var sizeWords = ['大','中','小','特大','加大','加厚','加宽','迷你','标准','升级','S','M','L','XL','XXL','均码'];
  var materialWords = ['不锈钢','金属','铝','铜','铁','塑料','硅胶','橡胶','棉','麻','丝','涤纶','尼龙','帆布','皮革','玻璃','陶瓷','木','竹','纸'];
  
  lines.forEach(function(line) {
    var text = line.replace(/【[^】]*】|\[[^\]]*\]/g, '').replace(/;.*$/g, '').trim();
    
    // 提取颜色
    colorWords.forEach(function(c) {
      if (text.indexOf(c) >= 0) structure.colors[c] = 1;
    });
    
    // 提取尺寸
    sizeWords.forEach(function(s) {
      if (text.indexOf(s) >= 0) structure.sizes[s] = 1;
    });
    
    // 提取材质
    materialWords.forEach(function(m) {
      if (text.indexOf(m) >= 0) structure.materials[m] = 1;
    });
    
    // 提取数量模式（如 "2个装", "3件套"）
    var qtyMatch = text.match(/(\d+)\s*(?:个|件|套|盒|包|张|片|支|只|瓶|组|位|对|双|条|把|袋|卷|箱)/);
    if (qtyMatch) structure.quantities[qtyMatch[1]] = 1;
  });
  
  return structure;
}

// 比较两个规格结构的相似度
function compareSpecStructure(specA, specB) {
  var structA = extractSpecStructure(specA);
  var structB = extractSpecStructure(specB);
  
  var scores = [];
  
  // 颜色重叠
  var colorsA = Object.keys(structA.colors);
  var colorsB = Object.keys(structB.colors);
  if (colorsA.length > 0 && colorsB.length > 0) {
    var colorOverlap = colorsA.filter(function(c) { return structB.colors[c]; }).length;
    scores.push(colorOverlap / Math.max(colorsA.length, colorsB.length));
  }
  
  // 尺寸重叠
  var sizesA = Object.keys(structA.sizes);
  var sizesB = Object.keys(structB.sizes);
  if (sizesA.length > 0 && sizesB.length > 0) {
    var sizeOverlap = sizesA.filter(function(s) { return structB.sizes[s]; }).length;
    scores.push(sizeOverlap / Math.max(sizesA.length, sizesB.length));
  }
  
  // 材质重叠
  var matsA = Object.keys(structA.materials);
  var matsB = Object.keys(structB.materials);
  if (matsA.length > 0 && matsB.length > 0) {
    var matOverlap = matsA.filter(function(m) { return structB.materials[m]; }).length;
    scores.push(matOverlap / Math.max(matsA.length, matsB.length));
  }
  
  // 数量模式重叠
  var qtysA = Object.keys(structA.quantities);
  var qtysB = Object.keys(structB.quantities);
  if (qtysA.length > 0 && qtysB.length > 0) {
    var qtyOverlap = qtysA.filter(function(q) { return structB.quantities[q]; }).length;
    scores.push(qtyOverlap / Math.max(qtysA.length, qtysB.length));
  }
  
  if (scores.length === 0) return 0;
  return scores.reduce(function(a, b) { return a + b; }, 0) / scores.length;
}

// === 优化2: 中文停用词和同义词 ===
var CHINESE_STOP_WORDS = [
  '的','了','在','是','我','有','和','就','不','人','都','一','一个','上','也','很','到','说','要','去','你','会','着','没有','看','好','自己','这',
  '他','她','它','们','那','被','从','把','让','用','为','因为','所以','但是','如果','虽然','可是','只是','而且','或者','虽然','然而','不过',
  '拍','发','个','件','套','盒','包','张','片','支','只','瓶','组','位','对','双','条','把','袋','卷','箱',
  '装','款','色','号','型','版','类','种','样','式','品','物','器','具','料','材','质','料',
  '新','旧','大','小','多','少','高','低','长','短','快','慢','好','坏','美','丑','强','弱',
  '男','女','老','少','公','母','雌','雄','正','反','左','右','前','后','上','下','里','外',
  '一','二','三','四','五','六','七','八','九','十','百','千','万','亿',
  '元','角','分','块','毛','钱','价','费','值',
  '年','月','日','时','分','秒','天','周','季','度',
  '米','厘米','毫米','千米','公里','里','丈','尺','寸',
  '斤','两','克','千克','公斤','吨','升','毫升',
  '个','只','条','把','张','片','块','根','支','本','台','架','辆','艘','座','栋','间','家','所','处',
  '等','等等','什么','怎么','如何','为什么','哪里','哪儿','哪个','哪些','多少','几','谁',
  '可以','能够','应该','必须','需要','想要','希望','愿意','喜欢','讨厌','害怕','担心',
  '知道','了解','认识','明白','理解','相信','认为','觉得','感觉','感到',
  '来','去','到','往','向','朝','从','在','于','以','为','把','被','让','给','对','跟','和','与','及',
  '而','但','却','虽然','尽管','即使','如果','只要','除非','无论','不管',
  '也','还','又','再','才','就','都','只','仅','仅仅','几乎','差不多','大约','大概','可能','也许','或许',
  '不','没','没有','别','勿','莫','休','毋',
  '这','那','这里','那里','这儿','那儿','这边','那边','这个','那个','这些','那些',
  '我','你','他','她','它','我们','你们','他们','她们','它们','自己','自个儿',
  '谁','什么','哪','哪里','哪儿','哪个','哪些','怎么','怎样','怎么样','多少','几',
  '就','才','也','都','只','仅','仅仅','几乎','差不多','大约','大概','可能','也许','或许',
  '非常','十分','特别','格外','极其','最','更','比较','相当','有点儿','稍微','略微',
  '已经','曾经','刚刚','刚才','正在','将要','就要','快要','马上','立刻','立即','顿时',
  '常常','经常','时常','往往','一向','一直','始终','从来','向来','素来',
  '终于','到底','究竟','毕竟','终究','终归','总归',
  '大概','大约','约莫','约摸','也许','或许','可能','恐怕','怕是',
  '难道','岂','哪里','哪儿','怎么','怎样','怎么样','多少','几',
  '吧','呢','啊','呀','哇','嘛','哦','噢','嗯','嘿','哼',
  '吗','么','啦','喽','嘞','咯','喔','唷','呦','唉','哎',
  '哈哈','嘻嘻','呵呵','嘿嘿','哎呀','哎哟','天哪','妈呀',
  '不是','不要','不行','不好','不对','没有','没用','没意思',
  '可以','能够','应该','必须','需要','想要','希望','愿意',
  '喜欢','讨厌','害怕','担心','知道','了解','认识','明白',
  '理解','相信','认为','觉得','感觉','感到','感到','感觉',
  '来','去','到','往','向','朝','从','在','于','以','为',
  '把','被','让','给','对','跟','和','与','及','而','但',
  '却','虽然','尽管','即使','如果','只要','除非','无论','不管'
];

// 去除停用词
function removeStopWords(text) {
  var result = text;
  CHINESE_STOP_WORDS.forEach(function(word) {
    result = result.replace(new RegExp(word, 'g'), '');
  });
  return result;
}

// === 优化3: 品类关键词Blocking ===
var CATEGORY_KEYWORDS = {
  '清洁': ['清洁','清洗','去污','除垢','消毒','漂白','洁厕','洗洁','去渍','拖把','扫帚','抹布','百洁布','海绵','钢丝球','刷子','刷'],
  '收纳': ['收纳','整理','储物','存放','置物','挂袋','收纳袋','收纳盒','收纳箱','收纳包','收纳筐','收纳篮'],
  '灯具': ['灯','夜灯','台灯','灯带','灯泡','灯串','灯饰','照明','灯光'],
  '杯壶': ['杯','杯子','水杯','保温杯','壶','水壶','茶壶','咖啡壶'],
  '袜子': ['袜','袜子','棉袜','丝袜','短袜','长袜','船袜','运动袜'],
  '鞋类': ['鞋','拖鞋','凉鞋','运动鞋','板鞋','皮鞋','布鞋','鞋垫','鞋套','鞋袋','鞋盒','鞋架'],
  '手套': ['手套','一次性手套','防护手套','劳保手套','橡胶手套','乳胶手套'],
  '玩具': ['玩具','益智','积木','拼图','玩偶','模型','公仔','毛绒'],
  '文具': ['文具','笔','本子','书','文具盒','尺','橡皮','铅笔','圆珠笔','签字笔'],
  '厨房': ['锅','碗','勺','铲','刀','砧板','菜刀','炒锅','汤锅','煎锅','蒸锅'],
  '浴室': ['浴','洗澡','沐浴','毛巾','浴巾','浴帽','浴球','沐浴露','洗发水'],
  '汽车': ['汽车','车载','车用','车','车载','车饰','车品','车配件'],
  '宠物': ['宠物','猫','狗','鸟','鱼','猫粮','狗粮','猫砂','宠物用品'],
  '手机': ['手机','手机壳','手机膜','手机支架','手机配件','充电器','充电宝','数据线'],
  '电脑': ['电脑','笔记本','键盘','鼠标','显示器','音箱','耳机','摄像头'],
  '家电': ['电视','冰箱','洗衣机','空调','微波炉','烤箱','电饭煲','电磁炉'],
  '服装': ['衣服','裤子','裙子','外套','内衣','袜子','帽子','围巾','手套'],
  '美妆': ['化妆品','护肤品','面膜','口红','眼影','粉底','腮红','睫毛膏'],
  '母婴': ['婴儿','宝宝','儿童','孕妇','产妇','奶粉','纸尿裤','婴儿车'],
  '运动': ['运动','健身','瑜伽','跑步','游泳','篮球','足球','羽毛球'],
  '户外': ['户外','露营','登山','徒步','野餐','帐篷','睡袋','登山杖'],
  '办公': ['办公','文具','打印','复印','扫描','办公用品','办公设备'],
  '五金': ['五金','工具','螺丝','螺母','扳手','钳子','电钻','电锯'],
  '建材': ['建材','瓷砖','地板','墙纸','涂料','油漆','水泥','沙子'],
  '园艺': ['园艺','花卉','花盆','花架','花肥','花土','花种','花苗']
};

// 提取品类
function extractCategory(text) {
  var categories = [];
  Object.keys(CATEGORY_KEYWORDS).forEach(function(cat) {
    CATEGORY_KEYWORDS[cat].forEach(function(kw) {
      if (text.indexOf(kw) >= 0 && categories.indexOf(cat) < 0) {
        categories.push(cat);
      }
    });
  });
  return categories;
}

// 检查品类冲突
function hasCategoryConflict(title, spec) {
  var titleCats = extractCategory(title);
  var specCats = extractCategory(spec);
  
  if (titleCats.length === 0 || specCats.length === 0) return false;
  
  // 检查是否有交集
  var hasIntersection = titleCats.some(function(cat) { return specCats.indexOf(cat) >= 0; });
  
  // 如果没有交集，可能是冲突
  return !hasIntersection;
}

// === 优化: 更精确的产品类型检测 ===
var PRODUCT_TYPE_KEYWORDS = {
  // 清洁工具细分
  '疏通器': ['疏通','疏通器','疏通刷','管道刷','下水道'],
  '清洁刷': ['清洁刷','刷子','扫帚','拖把','抹布'],
  '清洁剂': ['清洁剂','清洁液','去污剂','清洗剂','消毒液'],
  
  // 袜子细分
  '袜子': ['袜','袜子','棉袜','丝袜','短袜','长袜','船袜','运动袜','空调袜'],
  
  // 手套细分
  '手套': ['手套','一次性手套','防护手套','劳保手套','橡胶手套','乳胶手套'],
  
  // 鞋类细分
  '鞋子': ['鞋','拖鞋','凉鞋','运动鞋','板鞋','皮鞋','布鞋'],
  '鞋垫': ['鞋垫','鞋底','足弓'],
  '鞋套': ['鞋套','鞋袋','鞋包','鞋盒','鞋架'],
  
  // 杯子细分
  '杯子': ['杯','杯子','水杯','保温杯','漱口杯','茶杯','咖啡杯'],
  '壶': ['壶','水壶','茶壶','咖啡壶','保温壶'],
  
  // 灯具细分
  '夜灯': ['夜灯','小夜灯','感应灯','声控灯'],
  '台灯': ['台灯','阅读灯','护眼灯','学习灯'],
  '灯带': ['灯带','灯条','灯串','氛围灯'],
  
  // 手机配件细分
  '手机壳': ['手机壳','手机套','手机保护壳'],
  '手机膜': ['手机膜','屏幕膜','钢化膜','保护膜'],
  '手机支架': ['手机支架','手机架','手机座','车载支架'],
  '充电器': ['充电器','充电头','充电宝','充电线'],
  
  // 家电细分
  '空调': ['空调','空调外机','空调罩','空调扇'],
  '洗衣机': ['洗衣机','洗衣液','洗衣粉','洗衣凝珠'],
  '冰箱': ['冰箱','冰箱贴','冰箱除味'],
  
  // 厨房细分
  '锅': ['锅','炒锅','汤锅','煎锅','蒸锅','压力锅','奶锅'],
  '碗': ['碗','饭碗','汤碗','面碗'],
  '刀': ['刀','菜刀','水果刀','剪刀','美工刀'],
  
  // 文具细分
  '笔': ['笔','铅笔','圆珠笔','签字笔','马克笔','荧光笔'],
  '本子': ['本子','笔记本','作业本','练习本','日记本'],
  
  // 玩具细分
  '积木': ['积木','拼装','拼图','乐高'],
  '玩偶': ['玩偶','公仔','毛绒','布娃娃'],
  '陀螺': ['陀螺','指尖陀螺','旋转陀螺'],
  
  // 汽车细分
  '车载': ['车载','车用','车饰','车品','车载支架','车载充电'],
  '车配件': ['雨刮','轮胎','机油','滤芯','火花塞'],
  
  // 宠物细分
  '猫用品': ['猫','猫粮','猫砂','猫窝','猫玩具'],
  '狗用品': ['狗','狗粮','狗窝','狗玩具','狗链'],
  
  // 母婴细分
  '婴儿用品': ['婴儿','宝宝','奶瓶','纸尿裤','婴儿车'],
  '儿童玩具': ['儿童','小孩','益智','早教','玩具']
};

// 提取产品类型
function extractProductType(text) {
  var types = [];
  Object.keys(PRODUCT_TYPE_KEYWORDS).forEach(function(type) {
    PRODUCT_TYPE_KEYWORDS[type].forEach(function(kw) {
      if (text.indexOf(kw) >= 0 && types.indexOf(type) < 0) {
        types.push(type);
      }
    });
  });
  return types;
}

// 增强的品类冲突检测
function enhancedCategoryConflict(titleA, specA, titleB, specB) {
  var textA = (titleA || '') + ' ' + (specA || '');
  var textB = (titleB || '') + ' ' + (specB || '');
  
  var typesA = extractProductType(textA);
  var typesB = extractProductType(textB);
  
  // 如果都能提取到类型，检查是否有交集
  if (typesA.length > 0 && typesB.length > 0) {
    var hasIntersection = typesA.some(function(t) { return typesB.indexOf(t) >= 0; });
    if (!hasIntersection) {
      return true; // 冲突
    }
  }
  
  // 原有的品类检测
  return hasCategoryConflict(textA, textB);
}

// === 优化6: 核心产品名词提取与冲突检测 ===
// 核心问题：共享修饰词（如"空调""清洁""手机"）导致不同产品被错误合并
// 解决方案：提取标题中真正的产品名词（WHAT it IS），而非用途/材质/场景
var CORE_PRODUCT_FAMILIES = {
  '疏通器': ['疏通器', '疏通刷', '管道刷', '管道疏通', '排水管疏通', '下水道疏通', '疏通神器'],
  '清洁刷': ['清洁刷', '除尘刷', '缝隙刷', '凹槽刷', '纱窗刷', '风扇刷', '清洁掸', '除尘掸', '拖把', '扫帚', '毛刷'],
  '清洁剂': ['清洁剂', '清洁液', '去污剂', '清洗剂', '消毒液', '去油剂', '除垢剂', '洁厕剂', '泡泡粉', '清洁凝珠', '清洁泡泡', '抛光液', '除冰剂', '去油膜', '清洁湿巾'],
  '清洁球': ['清洁球', '钢丝球', '百洁布', '海绵擦', '魔力擦', '抹布', '洗碗布', '洗碗巾'],
  '牌贴': ['牌贴', '贴纸', '贴画', '贴花', '铝合金贴'],
  '过滤袋': ['过滤袋', '过滤网', '过滤芯', '滤网', '过滤棉袋', '滤水器', '滤水袋'],
  '吸尘器': ['吸尘器', '除螨仪', '扫地机', '洗地机'],
  '刮水器': ['刮水器', '雨刮', '刮水板', '玻璃刮'],
  '袜子': ['袜', '袜子', '棉袜', '丝袜', '短袜', '长袜', '船袜', '运动袜', '中筒袜', '空调袜'],
  '一次性手套': ['一次性手套', 'TPE手套', '食品级手套', '透明手套'],
  '防护手套': ['防护手套', '劳保手套', '橡胶手套', '乳胶手套', '家务手套'],
  '儿童手套': ['儿童手套', '小孩手套', '宝宝手套', '萌宠手套', '小狗手套'],
  '搓澡手套': ['搓澡手套', '沐浴手套', '搓澡巾', '儿童搓澡'],
  '鞋子': ['鞋', '拖鞋', '凉鞋', '运动鞋', '板鞋', '皮鞋', '布鞋', '洗鞋袋'],
  '鞋垫': ['鞋垫', '足弓鞋垫', '增高鞋垫'],
  '鞋套': ['鞋套', '鞋袋'],
  '帽子': ['帽子', '遮阳帽', '棒球帽', '渔夫帽', '鸭舌帽'],
  '腰带': ['腰带', '皮带', '腰封'],
  '袖套': ['袖套', '防晒袖套'],
  '护膝': ['护膝', '护腕', '护肘', '护踝'],
  '发箍': ['发箍', '发卡', '发夹', '头箍', '发圈', '发绳', '一字夹', '扭扭夹', '盘发器'],
  '干发帽': ['干发帽', '干发巾', '包头巾'],
  '收纳袋': ['收纳袋', '收纳包', '收纳盒', '收纳箱', '收纳筐', '收纳篮', '整理袋', '旅行收纳袋', '搬家袋'],
  '密封袋': ['密封袋', '自封袋', '保鲜袋', '分装袋'],
  '马桶垫': ['马桶垫', '马桶坐垫', '马桶套'],
  // V20.29.2: 洗脸巾从浴巾家族拆分（一次性洁面巾 ≠ 洗澡浴巾，业务上不同品类）
  '浴巾': ['浴巾', '压缩浴巾', '压缩毛巾', '毛巾'],
  '洗脸巾': ['洗脸巾', '洁面巾', '擦脸巾', '洗面巾', '卸妆巾'],
  '抹布架': ['抹布架', '毛巾架', '置物架', '收纳架'],
  '挂画': ['挂画', '装饰画', '壁画', '书法'],
  '窗帘': ['窗帘', '挡风帘', '空调挡风帘', '门帘'],
  '牙刷': ['牙刷', '电动牙刷', '牙膏', '牙线', '漱口水'],
  '梳子': ['梳子', '宠物梳', '去浮毛梳', '排梳'],
  '空调保护罩': ['空调保护罩', '空调罩', '空调防尘罩', '空调防晒罩', '空调外机罩', '空调遮阳', '铝膜保护罩', '铝箔保护罩', '铝膜罩', '空调外机铝箔罩'],
  '空调遥控器': ['空调遥控器', '空调伴侣', '空调遥控', '万能遥控器'],
  '空调胶带': ['空调胶带', '铝箔胶带', '纤铝箔', '密封胶带'],
  '空调过滤棉': ['过滤棉', '过滤网', '过滤袋', '滤芯', '滤水'],
  '空调挡风板': ['挡风板', '挡风帘', '空调挡风', '防直吹'],
  '手机壳': ['手机壳', '手机套', '手机保护壳', '手机保护套', '手机皮套'],
  '手机膜': ['手机膜', '屏幕膜', '钢化膜', '保护膜', '手机贴膜'],
  '手机支架': ['手机支架', '手机架', '手机座', '车载支架', '骑行支架', '自行车支架', '摩托支架', '壁挂支架', '手机收纳'],
  '充电器': ['充电器', '充电头', '充电宝', '充电线', '数据线', '充电线'],
  '手机防水袋': ['防水袋', '手机防水袋', '防水套'],
  '手机清洁刷': ['手机清洁', '充电口清洁', '清灰刷', '听筒清洁', '手机孔清洁'],
  '锅': ['锅', '炒锅', '汤锅', '煎锅', '蒸锅', '压力锅', '奶锅', '不粘锅'],
  '碗': ['碗', '饭碗', '汤碗', '面碗', '盘子', '碟子'],
  '砧板': ['砧板', '菜板', '切菜板'],
  '水槽过滤网': ['水槽过滤', '水槽滤网', '漏网', '过滤网垃圾', '厨房过滤'],
  '刀具': ['菜刀', '水果刀', '剪刀', '美工刀', '切菜刀'],
  '开瓶器': ['开瓶器', '罐头起子'],
  '洗衣机水管': ['洗衣机下水管', '洗衣机排水管', '下水管', '排水管', '地漏接头', '三通管', '防溢水'],
  '洗衣机止水阀': ['止水阀', '水阀', '自动止水阀'],
  '洗衣机过滤袋': ['洗衣机过滤袋', '过滤袋', '洗衣机过滤网'],
  '夜灯': ['夜灯', '小夜灯', '感应灯', '声控灯', '光控灯', '人体感应灯'],
  '台灯': ['台灯', '阅读灯', '护眼灯', '学习灯', 'LED灯'],
  '灯带': ['灯带', '灯条', '灯串', '氛围灯'],
  '灯笼': ['灯笼', '莲花灯', '蜡烛灯'],
  '跳绳': ['跳绳', '发光跳绳', '儿童跳绳'],
  '陀螺': ['陀螺', '指尖陀螺', '旋转陀螺'],
  '积木': ['积木', '拼装', '拼图', '乐高', '磁力片', '磁力方块'],
  '玩偶': ['玩偶', '公仔', '毛绒', '布娃娃', '变形机器人'],
  '魔方': ['魔方', '百变魔方', '琉璃魔方', '百变魔尺'],
  '沙盒': ['沙盒', '沙盘', '沙子', '沙模', '沙坑'],
  '刮画纸': ['刮画纸', '刮蜡纸', '刮画'],
  '汽车手机支架': ['车载手机支架', '汽车手机支架', '中控支架', '仪表台支架', '停车号码牌'],
  '汽车清洁': ['汽车清洁', '车内清洁', '内饰清洁', '擦车', '洗车拖把'],
  '扳手': ['扳手', '水泵钳', '管子钳', '万用扳手'],
  '气门灯': ['气门灯', '气嘴灯', '自行车灯', '夜骑灯'],
  '除尘掸': ['除尘掸', '除尘刷', '伸缩掸'],
  '卡包': ['卡包', '卡盒', '卡套', '证件包'],
  '抹布': ['抹布', '周抛抹布', '清洁布', '擦布', '洗碗布'],
  '口罩': ['口罩', '防尘口罩', '防晒口罩'],
  '挖耳勺': ['挖耳勺', '掏耳勺', '粘耳棒', '耳勺', '滴耳液'],
  '纹贴': ['纹贴', '川字纹贴', '额头纹贴', '法令纹贴', '皱纹贴'],
  '剃须刀': ['剃须刀', '理发器', '电推剪'],
  '黑头仪': ['黑头仪', '黑头吸', '毛孔清洁仪'],
  '笔袋': ['笔袋', '文具袋', '文具盒', '铅笔袋', '收纳笔袋'],
  '卡纸': ['卡纸', '彩纸', '手工纸', '折纸'],
  '遥控器收纳': ['遥控器收纳', '遥控收纳', '壁挂收纳', '遥控器盒'],
  '密封胶泥': ['密封胶泥', '堵洞', '空调孔密封'],
  '密码锁': ['密码锁', '挂锁', '行李箱锁'],
  '遮阳板': ['遮阳板', '防晒板', '隔热板', '挡雨板'],
  '垃圾袋': ['垃圾袋', '分类垃圾袋'],
  '粘毛器': ['粘毛器', '粘毛滚', '除尘滚'],
  '马桶刷': ['马桶刷', '浴室刷', '浴缸刷'],
  '蚊香盘': ['蚊香盘', '蚊香盒', '驱蚊'],
  '相框': ['相框', '照片框', '摆台'],
  '挂钩': ['挂钩', '粘钩', '免钉挂钩'],
  '眼罩': ['眼罩', '蒸汽眼罩', '睡眠眼罩'],
  '搓澡巾': ['搓澡巾', '搓澡', '沐浴球', '浴球', '搓澡手套'],
  '洗澡刷': ['洗澡刷', '沐浴刷', '搓背刷', '宠物洗澡刷', '搓澡刷', '长柄刷'],
  // V20.18.0: 补充产品家族（防止合并错误）
  '汽车用品': ['汽车', '车载', '车用', '车门', '车坐椅', '座椅缝隙', '缝隙塞条', '缝隙塞', '雨伞盒', '垃圾桶', '车载收纳', '遮阳板', '号码牌', '行车记录'],
  '清洁器': ['清洁器', '清洗器', '冲洗器', '冲洗头'],
  '美容工具': ['拨筋棒', '刮痧板', '刮痧', '美容仪', '按摩棒', '按摩器', '美容棒', '瘦脸'],
  '精油': ['精油', '香薰', '香氛', '按摩油', '护肤油'],
  '蒸盘': ['蒸盘', '蒸架', '蒸笼', '蒸格', '蒸锅架'],
  '猪油桶': ['猪油桶', '油桶', '储油罐', '不锈钢桶', '储油桶'],
  '垃圾桶': ['垃圾桶', '废纸篓', '收纳桶'],
  '防漏条': ['防漏', '防掉', '缝隙塞', '塞条', '防漏条'],
  // V20.24.2: 补充产品家族（防止跨品类误合并）
  '粉扑': ['粉扑', '棉花糖粉扑', '美妆粉扑', '散粉扑', '蜜粉扑'],
  // V20.26.10: Commonly confused tool/stationery/kitchen families. These
  // are identity nouns, not merge keywords; different families are blocked.
  '试卷夹': ['试卷夹', '拉杆夹', '抽杆夹', '文件夹'],
  '穿针器': ['穿针器', '穿针引线器', '引线器', '拆线器', '认针器'],
  '鼻毛修剪器': ['鼻毛修剪器', '鼻毛器'],
  '锅盖架': ['锅盖架', '锅铲架', '锅盖收纳架'],
  '挂钩': ['挂钩', '吸盘挂钩', '收纳挂钩'],
  '蒸盘': ['蒸盘', '蒸架', '蒸笼', '蒸格'],
  '锅铲': ['锅铲', '铲勺'],
  '肉丸勺': ['肉丸勺', '压丸器', '压肉丸勺'],
  '勺子': ['勺子', '汤勺', '饭勺'],
  '贴纸': ['贴纸', '拼音贴纸', '贴画'],
  '骰子': ['骰子', '色子'],
  '卡皮巴拉': ['卡皮巴拉', '水豚'],
  '磷虾软饵': ['磷虾', '软饵', '路亚', '仿生饵', '微物饵', '钓鱼饵'],
  '篮球': ['篮球', '静音篮球', '篮球框', '篮筐', '投篮'],
  '飞镖盘': ['飞镖', '标靶', '靶盘', '飞镖盘', '黏黏球', '粘粘球', '粘球'],
  '踩踩球': ['踩踩球', '踩球', '弹力球', '发光球'],
  '龙蛋': ['龙蛋', '恐龙蛋', '彩蛋', '扭蛋'],
  '泳镜': ['泳镜', '游泳镜', '泳帽', '游泳圈'],
  '眼贴': ['眼贴', '眼膜', '眼罩贴', '冰敷眼贴'],
  '牙线': ['牙线', '牙线棒', '牙签'],
  '垃圾袋': ['垃圾袋', '分类垃圾袋', '背心袋'],
  '挂钩': ['挂钩', '粘钩', '免钉挂钩', '无痕挂钩', '吸盘挂钩'],
  '花洒': ['花洒', '淋浴头', '淋浴喷头', '增压花洒'],
  '拖鞋': ['拖鞋', '凉拖', '居家拖鞋', '浴室拖鞋'],
  '泳衣': ['泳衣', '泳裤', '游泳衣', '比基尼'],
  '防晒': ['防晒', '遮阳', '防晒衣', '防晒帽', '冰袖'],
  '剪纸': ['剪纸', '手工剪纸', '儿童剪纸'],
  '不倒翁': ['不倒翁', '摇摆玩具'],
  '洗车管': ['洗车管', '水管', '浇花管', '高压管', '伸缩管'],
  '牵引枕': ['牵引枕', '颈椎枕', '护颈枕', '记忆枕'],
  '手套箱': ['手套箱', '车载收纳', '车用挂钩'],
  '叶黄素': ['叶黄素', '护眼', '眼贴', '眼部护理'],
  '陀螺': ['陀螺', '指尖陀螺', '旋转陀螺', '上链陀螺'],
};;

// 提取标题中的核心产品名词（最长匹配优先）
function extractCoreProductNoun(title) {
  if (!title) return null;
  var bestMatch = null;
  var bestLen = 0;
  Object.keys(CORE_PRODUCT_FAMILIES).forEach(function(family) {
    CORE_PRODUCT_FAMILIES[family].forEach(function(kw) {
      if (title.indexOf(kw) >= 0 && kw.length > bestLen) {
        bestMatch = family;
        bestLen = kw.length;
      }
    });
  });
  return bestMatch;
}

// 检查两个产品是否有核心产品名词冲突
function coreProductConflict(titleA, specA, titleB, specB) {
  var nounA = extractCoreProductNoun(titleA || '');
  var nounB = extractCoreProductNoun(titleB || '');
  
  // V20.29.1: 核心名词差异时共享词根判断（语义相关）
  function shareTwoCharRoot(a, b) {
    var seen = {};
    for (var i = 0; i < String(a || '').length - 1; i++) {
      var chunk = String(a || '').substr(i, 2);
      if (/^[\u4e00-\u9fff]{2}$/.test(chunk)) seen[chunk] = 1;
    }
    for (var j = 0; j < String(b || '').length - 1; j++) {
      var chunkB = String(b || '').substr(j, 2);
      if (/^[\u4e00-\u9fff]{2}$/.test(chunkB) && seen[chunkB]) return true;
    }
    return false;
  }
  
  // V20.29.1: 泛家族集合（正则大类匹配的家族，不够具体）
  // 只共享这些泛家族时，核心名词不同的产品不应被精细家族豁免。
  var GENERIC_FINE_FAMILIES = {
    storage:1, cleaning:1, auto:1, kitchen:1, textile:1, beauty:1, toy:1,
    paper:1, footwear:1, cable:1, lighting:1, animal:1, insect:1,
    stationery:1, hardware:1, phone:1, stove:1,
  };
  
  // V20.29.0: 精细家族一致性优先于粗家族冲突判断。
  // 粗家族关键词过于泛化（如"保护膜"被归入"手机膜"），会把同类的
  // 身份证保护套/隐私文件套误判为冲突。双方精细家族一致时不视为冲突。
  var fineA = procurementProductFamilies(titleA || '', specA || '');
  var fineB = procurementProductFamilies(titleB || '', specB || '');
  var fineKeysA = Object.keys(fineA), fineKeysB = Object.keys(fineB);
  var sharedFine = fineKeysA.length > 0 && fineKeysB.length > 0
    && fineKeysA.some(function(k) { return fineB[k]; });
  if (sharedFine) {
    // V20.29.1: 判断共享家族是否包含具体家族（如 privacyDocumentSleeve）。
    // 只有具体家族才可信；仅共享 storage/auto 等泛家族时，核心名词不同
    // 仍需语义相关（共享 2 字词根），防止"车窗储物盒"误并入"扶手箱增高垫"。
    var sharedKeys = fineKeysA.filter(function(k) { return fineB[k]; });
    var hasSpecificFamily = sharedKeys.some(function(k) { return !GENERIC_FINE_FAMILIES[k]; });
    if (!hasSpecificFamily && nounA && nounB && nounA !== nounB) {
      var shorterNoun = nounA.length <= nounB.length ? nounA : nounB;
      var longerNoun = nounA.length <= nounB.length ? nounB : nounA;
      var semanticallyRelated = longerNoun.indexOf(shorterNoun) >= 0
        || shareTwoCharRoot(nounA, nounB);
      if (!semanticallyRelated) {
        return { conflict: true, nounA: nounA, nounB: nounB, reason: 'FINE_FAMILY_UNRELATED' };
      }
    }
    return { conflict: false, sharedFine: true, nounA: nounA, nounB: nounB };
  }
  
  // 如果两个标题都能提取到核心名词，且不同，就是冲突
  if (nounA && nounB && nounA !== nounB) {
    return { conflict: true, nounA: nounA, nounB: nounB };
  }
  
  // V20.16.0: 如果一个能提取一个不能，检查规格中是否含有对方的核心名词
  // 这处理"标题A包含产品B规格"的情况
  if (nounA && !nounB && specB) {
    var specBNoun = extractCoreProductNoun(specB);
    if (specBNoun && specBNoun !== nounA) {
      return { conflict: true, nounA: nounA, nounB: specBNoun, viaSpec: true };
    }
  }
  if (nounB && !nounA && specA) {
    var specANoun = extractCoreProductNoun(specA);
    if (specANoun && specANoun !== nounB) {
      return { conflict: true, nounA: specANoun, nounB: nounB, viaSpec: true };
    }
  }
  
  // V20.16.0: 如果一个产品没有匹配到家族，不应该和任何其他产品合并
  // 这防止了"手机孔清洁神器"和"清洁刷"被错误合并的情况
  if (!nounA && nounB) {
    // 产品A没有家族，产品B有家族，不应该合并
    return { conflict: true, nounA: null, nounB: nounB, reason: 'no_family_match' };
  }
  if (nounA && !nounB) {
    // 产品A有家族，产品B没有家族，不应该合并
    return { conflict: true, nounA: nounA, nounB: null, reason: 'no_family_match' };
  }
  
  return { conflict: false };
}

// 规格-标题一致性检查：检测规格行是否与标题产品类型匹配
function specTitleConsistencyCheck(title, spec) {
  if (!title || !spec) return { consistent: true, mismatches: [] };
  var titleNoun = extractCoreProductNoun(title);
  if (!titleNoun) return { consistent: true, mismatches: [] };
  
  var specLines = String(spec).split('\n').filter(function(l) { return l.trim(); });
  var mismatches = [];
  
  specLines.forEach(function(line) {
    var lineNoun = extractCoreProductNoun(line);
    if (lineNoun && lineNoun !== titleNoun) {
      // 检查是否属于同一产品家族（允许的近义词）
      var allowed = false;
      // 空调保护罩 和 空调罩 是同一家族
      if ((titleNoun === '空调保护罩' && lineNoun === '空调保护罩') ||
          (titleNoun === '空调遥控器' && lineNoun === '空调遥控器')) {
        allowed = true;
      }
      if (!allowed) {
        mismatches.push({ line: line.substring(0, 60), lineNoun: lineNoun, titleNoun: titleNoun });
      }
    }
  });
  
  return { consistent: mismatches.length === 0, mismatches: mismatches };

}
// === 优化7: 合并后复检层 (Post-Merge Verification) ===
// 在合并结果写入前，验证合并后的数据是否合理
// 检查项：规格跨家族污染、规格行数异常、数量爆炸、标题-规格一致性

var POST_MERGE_CHECKS = {
  MAX_SPEC_LINES: 20,           // 规格行数上限
  MAX_QTY_MULTIPLIER: 5,        // 数量膨胀倍数上限（合并后/合并前）
  CROSS_FAMILY_BLOCK: true,     // 是否阻断跨家族污染
  WARN_SPEC_LINES: 12,          // 规格行数警告阈值
};

// 复检结果对象
function PostMergeResult(approved, issues, stats) {
  return {
    approved: approved,
    issues: issues || [],
    stats: stats || {},
    severity: issues.length ? issues.reduce(function(max, i) {
      return i.level === 'block' ? 'block' : (max === 'block' ? 'block' : 'warn');
    }, 'ok') : 'ok'
  };
}

// 从规格文本中提取所有产品家族
function specExtractFamilies(spec) {
  var families = {};
  var lines = String(spec || '').split('\n').filter(function(l) { return l.trim(); });
  lines.forEach(function(line) {
    var noun = extractCoreProductNoun(line);
    if (noun) {
      families[noun] = (families[noun] || 0) + 1;
    }
  });
  return families;
}

// 检查合并后规格是否跨家族污染
function checkSpecCrossContamination(title, mergedSpec) {
  var titleNoun = extractCoreProductNoun(title);
  var titleFamilies = extractCoreProductFamilies(title);
  var specLines = String(mergedSpec || '').split('\n').filter(function(l) { return l.trim(); });
  function bundleDeclaresFamily(family) {
    if (!/(?:(?:\d+|[一二三四五六七八九十]+)\s*件套|多件套|套装|组合|礼包)/.test(String(title || ''))) return false;
    var familyLines = specLines.filter(function(line) {
      return extractCoreProductNoun(line) === family;
    });
    if (!familyLines.length) return false;
    return familyLines.every(function(line) {
      if (!/(?:件套|套装|组合|礼包)/.test(line)) return false;
      var componentHits = 0;
      ['大号', '中号', '内衣袋', '睡衣袋', '鞋袋', '鞋套'].forEach(function(keyword) {
        if (line.indexOf(keyword) >= 0) componentHits++;
      });
      return componentHits >= 3;
    });
  }
  // V20.29.3: 配件/赠品/材质/套装组件豁免——这些不是独立产品混入，不判污染
  function isGiftLine(line) { return /送|赠|附送|附带|加送/.test(line); }
  function isMaterialLine(line) {
    return /木浆棉|不锈钢|硅胶|塑料|PP|PPSU|ABS|铝合金|纯棉|无纺布|亚克力|陶瓷|玻璃|海绵|布料|绒布|牛津布/.test(line);
  }
  function familyExempted(family) {
    var famLines = specLines.filter(function(line) { return extractCoreProductNoun(line) === family; });
    if (!famLines.length) return false;
    // 赠品行豁免
    if (famLines.some(isGiftLine)) return true;
    // 材质描述行豁免
    if (famLines.some(isMaterialLine)) return true;
    // 套装组件豁免
    if (bundleDeclaresFamily(family)) return true;
    return false;
  }
  var specFamilies = specExtractFamilies(mergedSpec);
  var foreignFamilies = [];
  var allowedPairs = {
    '洗澡刷': ['搓澡巾'], '搓澡巾': ['洗澡刷'],
    '收纳袋': ['密封袋'], '密封袋': ['收纳袋'],
    '鞋子': ['鞋套'], '鞋套': ['鞋子'],
    '拖鞋': ['鞋套'],
    '锅': ['蒸盘','猪油桶'], '蒸盘': ['锅','猪油桶'], '猪油桶': ['锅','蒸盘'],
    '精油': ['香薰'], '香薰': ['精油'],
  };
  
  // V20.29.2: 标题无家族时，用"规格行与标题的文本桥"检查
  // V20.29.3: 不提前 return——继续到统一的结构化检测（标题无家族也检测规格混入）
  var titleHasFamily = titleFamilies.length > 0;
  if (!titleHasFamily) {
    var titleClean = String(title || '').replace(/[【】\[\]（）()0-9\s]/g, '');
    Object.keys(specFamilies).forEach(function(family) {
      if (foreignFamilies.some(function(f) { return f.family === family; })) return;
      if (familyExempted(family)) return;
      var kwList = (CORE_PRODUCT_FAMILIES[family] || [family]);
      var related = kwList.some(function(kw) {
        return kw.length >= 2 && titleClean.indexOf(kw) >= 0;
      });
      if (!related) {
        foreignFamilies.push({ family: family, count: specFamilies[family], viaText: true });
      }
    });
  } else {
    Object.keys(specFamilies).forEach(function(family) {
      if (titleFamilies.indexOf(family) < 0) {
        if (familyExempted(family)) return;
                var allowed = titleFamilies.some(function(titleFamily) {
          return (allowedPairs[titleFamily] || []).indexOf(family) >= 0;
        });
        if (!allowed) {
          allowed = bundleDeclaresFamily(family);
        }
        if (!allowed) {
          foreignFamilies.push({ family: family, count: specFamilies[family] });
        }
      }
    });
  }
  
  // V20.29.3: 结构化产品名补充检测——规格行含标题没有的独立产品名
  // （标题有/无家族均执行）
  if (!foreignFamilies.length) {
    var titleStructKey = titleNoun
      ? 'fam:' + titleNoun
      : (extractSpecLineProductName(title) ? 'name:' + extractSpecLineProductName(title) : '');
    if (titleStructKey) {
      var structNames = {};
      specLines.forEach(function(line) {
        // 赠品行跳过；属性/材质行（无产品名）自然跳过
        if (isGiftLine(line)) return;
        var s = parseSpecLine(line);
        if (s.productName) {
          var k = s.family ? 'fam:' + s.family : 'name:' + s.productName;
          structNames[k] = (structNames[k] || 0) + 1;
        }
      });
      var foreignStruct = Object.keys(structNames).filter(function(k) { return k !== titleStructKey; });
      // V20.29.3: 规格中出现与标题无关的独立产品即判污染
      // （不要求 ≥2 个规格产品，刮刀行的"送收纳盒"被豁免后螺丝刀仍应触发）
      if (foreignStruct.length >= 1) {
        var titleText = String(title || '');
        var trulyForeign = foreignStruct.filter(function(k) {
          var nm = k.indexOf('name:') === 0 ? k.slice(5) : k.slice(4);
          if (!nm || nm.length < 2) return false;
          if (titleText.indexOf(nm) >= 0) return false;
          // V20.29.3: allowedPairs 豁免（如 鞋子↔鞋套、收纳袋↔密封袋）
          if (k.indexOf('fam:') === 0 && titleFamilies.length) {
            var famOnly = k.slice(4);
            var paired = titleFamilies.some(function(tf) {
              return (allowedPairs[tf] || []).indexOf(famOnly) >= 0;
            });
            if (paired) return false;
          }
          for (var ti = 0; ti <= titleText.length - 2; ti++) {
            var pair = titleText.substr(ti, 2);
            if (pair.length === 2 && nm.indexOf(pair) >= 0) return false;
          }
          return true;
        });
        // V20.29.3: 套装标题场景——规格组件（鞋袋/内衣袋等）属于套装，不判污染
        if (trulyForeign.length >= 1 && /(?:件套|套装|组合|礼包)/.test(String(title || ''))) {
          trulyForeign = [];
        }
        if (trulyForeign.length >= 1) {
          foreignFamilies.push({ family: 'SPEC_PRODUCT_MIX', count: Object.keys(structNames).length, viaStruct: true });
        }
      }
    }
  }
  
  return {
    contaminated: foreignFamilies.length > 0,
    titleNoun: titleNoun,
    foreignFamilies: foreignFamilies,
    totalSpecFamilies: Object.keys(specFamilies).length
  };
}

// 检查数量是否异常膨胀
function checkQuantityExplosion(originalSpecs, mergedSpec) {
  if (!originalSpecs || !originalSpecs.length) return { exploded: false };
  
  var originalTotal = 0;
  originalSpecs.forEach(function(spec) {
    originalTotal += procurementSpecQtyTotal(spec);
  });
  
  var mergedTotal = procurementSpecQtyTotal(mergedSpec);
  
  if (originalTotal === 0) return { exploded: false };
  
  var multiplier = mergedTotal / originalTotal;
  return {
    exploded: multiplier > POST_MERGE_CHECKS.MAX_QTY_MULTIPLIER,
    originalTotal: originalTotal,
    mergedTotal: mergedTotal,
    multiplier: multiplier
  };
}

// 检查规格行数是否异常
function checkSpecLineCount(mergedSpec) {
  var lines = String(mergedSpec || '').split('\n').filter(function(l) { return l.trim(); });
  return {
    excessive: lines.length > POST_MERGE_CHECKS.MAX_SPEC_LINES,
    warning: lines.length > POST_MERGE_CHECKS.WARN_SPEC_LINES,
    count: lines.length
  };
}

// 检查规格内是否有重复行
function checkDuplicateSpecLines(mergedSpec) {
  var lines = String(mergedSpec || '').split('\n').filter(function(l) { return l.trim(); });
  var seen = {};
  var duplicates = [];
  lines.forEach(function(line) {
    var norm = line.trim().replace(/\s+/g, '');
    if (seen[norm]) {
      duplicates.push(line.substring(0, 50));
    }
    seen[norm] = 1;
  });
  return {
    hasDuplicates: duplicates.length > 0,
    duplicateCount: duplicates.length,
    examples: duplicates.slice(0, 3)
  };
}

// 核心复检函数：对单条合并结果进行全面检查
function postMergeVerify(mergeGroup) {
  var issues = [];
  var stats = {};
  
  var title = mergeGroup.title || '';
  var mergedSpec = mergeGroup.mergedSpec || '';
  var originalSpecs = mergeGroup.originalSpecs || [];
  var sourcePlans = Array.isArray(mergeGroup.sourcePlans) ? mergeGroup.sourcePlans : [];
  var homogeneousSingleLineSources = false;
  if (sourcePlans.length) {
    var firstSource = sourcePlans[0] || {};
    var firstSourceTitle = String(firstSource.title || '').replace(/\s+/g, '').toLowerCase();
    var firstSourceSpec = String(firstSource.spec || '');
    var firstSourceLines = firstSourceSpec.split(/\n/).filter(function(line) {
      return line.trim();
    });
    var firstSourceFamilies = Object.keys(specExtractFamilies(firstSourceSpec)).sort().join('|');
    homogeneousSingleLineSources = firstSourceLines.length === 1 && !!firstSourceFamilies
      && sourcePlans.every(function(source) {
        source = source || {};
        var sourceSpec = String(source.spec || '');
        var sourceLines = sourceSpec.split(/\n/).filter(function(line) { return line.trim(); });
        return sourceLines.length === 1
          && String(source.title || '').replace(/\s+/g, '').toLowerCase() === firstSourceTitle
          && Object.keys(specExtractFamilies(sourceSpec)).sort().join('|') === firstSourceFamilies;
      });
  }
  
  // 检查1: 规格跨家族污染
  var contamination = checkSpecCrossContamination(title, mergedSpec);
  stats.contamination = contamination;
  if (contamination.contaminated) {
    // V20.29.3: SPEC_PRODUCT_MIX（启发式产品名判定）降级为 warn——仅提示，不阻断合并，
    // 避免真实数据中属性/描述片段的误报阻断合理合并。家族级污染仍 block。
    var onlyStructMix = contamination.foreignFamilies.every(function(f) { return f.family === 'SPEC_PRODUCT_MIX'; });
    if (homogeneousSingleLineSources) {
      issues.push({
        level: 'warn',
        type: 'SINGLE_LINE_SOURCE_FAMILY_MISMATCH',
        message: '来源行均为同一单行规格，按原始标题/规格保留，不作为跨商品合并阻断'
      });
    } else if (onlyStructMix) {
      issues.push({
        level: 'warn',
        type: 'SPEC_PRODUCT_MIX_WARNING',
        message: '规格中含疑似不同产品描述: ' + contamination.foreignFamilies.map(function(f) {
          return f.family;
        }).join(', '),
        titleNoun: contamination.titleNoun,
        foreignFamilies: contamination.foreignFamilies
      });
    } else {
      issues.push({
        level: 'block',
        type: 'CROSS_FAMILY_CONTAMINATION',
        message: '规格中含有不同产品家族: ' + contamination.foreignFamilies.map(function(f) {
          return f.family + '(' + f.count + '行)';
        }).join(', '),
        titleNoun: contamination.titleNoun,
        foreignFamilies: contamination.foreignFamilies
      });
    }
  }
  
  // 检查2: 规格行数
  var lineCheck = checkSpecLineCount(mergedSpec);
  stats.specLines = lineCheck.count;
  if (lineCheck.excessive) {
    issues.push({
      level: 'warn',
      type: 'EXCESSIVE_SPEC_LINES',
      message: '规格行数过多: ' + lineCheck.count + ' 行 (上限 ' + POST_MERGE_CHECKS.MAX_SPEC_LINES + ')'
    });
  }
  
  // 检查3: 数量膨胀
  var qtyCheck = checkQuantityExplosion(originalSpecs, mergedSpec);
  stats.quantity = qtyCheck;
  if (qtyCheck.exploded) {
    issues.push({
      level: 'warn',
      type: 'QUANTITY_EXPLOSION',
      message: '数量异常膨胀: ' + qtyCheck.originalTotal + ' → ' + qtyCheck.mergedTotal
        + ' (' + qtyCheck.multiplier.toFixed(1) + '倍)'
    });
  }
  
  // 检查4: 重复规格行
  var dupCheck = checkDuplicateSpecLines(mergedSpec);
  stats.duplicates = dupCheck;
  if (dupCheck.hasDuplicates) {
    issues.push({
      level: 'warn',
      type: 'DUPLICATE_SPEC_LINES',
      message: '规格中有 ' + dupCheck.duplicateCount + ' 行重复'
    });
  }
  
  // 检查5: 空规格
  if (!mergedSpec.trim()) {
    issues.push({
      level: 'warn',
      type: 'EMPTY_MERGED_SPEC',
      message: '合并后规格为空'
    });
  }
  
  // 判断是否通过
  var hasBlock = issues.some(function(i) { return i.level === 'block'; });
  var approved = !hasBlock;
  
  return PostMergeResult(approved, issues, stats);
}

// 批量复检：对所有合并组进行复检
function batchPostMergeVerify(mergeGroups) {
  var results = [];
  var blocked = 0;
  var warned = 0;
  var passed = 0;
  
  mergeGroups.forEach(function(group) {
    var result = postMergeVerify(group);
    results.push({ group: group, result: result });
    
    if (result.severity === 'block') blocked++;
    else if (result.severity === 'warn') warned++;
    else passed++;
  });
  
  return {
    results: results,
    summary: {
      total: mergeGroups.length,
      blocked: blocked,
      warned: warned,
      passed: passed
    }
  };
}




// === 优化4: 规格N-gram相似度 ===
function specNgramSimilarity(specA, specB) {
  if (!specA || !specB) return 0;
  
  var linesA = String(specA).split('\n').filter(function(l) { return l.trim(); });
  var linesB = String(specB).split('\n').filter(function(l) { return l.trim(); });
  
  if (linesA.length === 0 || linesB.length === 0) return 0;
  
  // 提取每行的核心词（去掉数量和修饰词）
  function extractCoreWords(line) {
    var text = line.replace(/【[^】]*】|\[[^\]]*\]/g, '')
      .replace(/;.*$/g, '')
      .replace(/\d+(?:个|件|套|盒|包|张|片|支|只|瓶|组|位|对|双|条|把|袋|卷|箱)装?/g, '')
      .replace(/[^\u4e00-\u9fff]/g, '')
      .trim();
    
    // 提取2-4字的词组
    var words = [];
    for (var len = 2; len <= 4; len++) {
      for (var i = 0; i <= text.length - len; i++) {
        var word = text.substring(i, i + len);
        if (/^[\u4e00-\u9fff]+$/.test(word)) {
          words.push(word);
        }
      }
    }
    return words;
  }
  
  // 计算N-gram Jaccard相似度
  var ngramsA = {};
  var ngramsB = {};
  
  linesA.forEach(function(line) {
    extractCoreWords(line).forEach(function(word) {
      ngramsA[word] = 1;
    });
  });
  
  linesB.forEach(function(line) {
    extractCoreWords(line).forEach(function(word) {
      ngramsB[word] = 1;
    });
  });
  
  var keysA = Object.keys(ngramsA);
  var keysB = Object.keys(ngramsB);
  
  if (keysA.length === 0 || keysB.length === 0) return 0;
  
  var intersection = keysA.filter(function(k) { return ngramsB[k]; }).length;
  var union = keysA.length + keysB.length - intersection;
  
  return union > 0 ? intersection / union : 0;
}

// === 优化5: 增强的规格证据 ===
function enhancedSpecEvidence(specA, specB) {
  var original = procurementSpecEvidence(specA, specB);
  var structureScore = compareSpecStructure(specA, specB);
  var ngramScore = specNgramSimilarity(specA, specB);
  
  // 综合评分
  var combinedScore = Math.max(
    original.score,
    structureScore * 0.8,
    ngramScore * 0.6
  );
  
  return {
    score: combinedScore,
    strongLong: original.strongLong || (structureScore >= 0.6 && ngramScore >= 0.4),
    genericOnly: original.genericOnly && structureScore < 0.3,
    maxInformativeLength: original.maxInformativeLength,
    structureScore: structureScore,
    ngramScore: ngramScore
  };
}
function procurementSpecEvidence(specA, specB) {
  var namesA = Object.keys(extractSpecNames(specA));
  var namesB = Object.keys(extractSpecNames(specB));
  if (!namesA.length || !namesB.length) {
    return {score:0, strongLong:false, genericOnly:false, maxInformativeLength:0};
  }
  var best = 0, strongLong = false, maxInformativeLength = 0;
  namesA.forEach(function(nameA) {
    var infoA = procurementSpecInformation(nameA);
    namesB.forEach(function(nameB) {
      var infoB = procurementSpecInformation(nameB);
      var minInfo = Math.min(infoA.length, infoB.length);
      maxInformativeLength = Math.max(maxInformativeLength, minInfo);
      if (!infoA.informative || !infoB.informative) return;
      if (infoA.normalized === infoB.normalized && minInfo >= 8) {
        strongLong = true;
        best = Math.max(best, 1);
        return;
      }
      var lengthWeight = Math.min(1, minInfo / 12);
      var pairScore = Math.max(
        jaroWinkler(infoA.informative, infoB.informative),
        diceSim(infoA.informative, infoB.informative),
        triSim(infoA.informative, infoB.informative)
      ) * lengthWeight;
      if (pairScore > best) best = pairScore;
    });
  });
  return {
    score:best,
    strongLong:strongLong,
    genericOnly:maxInformativeLength < 3,
    maxInformativeLength:maxInformativeLength
  };
}

// High-precision business concepts learned from confirmed purchaser examples.
// Every concept requires several independent anchors and explicit exclusions;
// a single broad word such as "卡套" or "保护罩" can never trigger a merge.
function procurementKeywordConcepts(profile) {
  var title = String((profile && profile.title) || '');
  var spec = String((profile && profile.spec) || '');
  var text = title + ' ' + spec;
  var concepts = {};

  var isAirconOutdoorCover = /空调/.test(text)
    && /(?:外机|室外|遮阳板|雨棚)/.test(text)
    && /(?:保护罩|防晒罩|挡雨罩|遮阳板|雨棚|罩盖|防雨|遮阳)/.test(text)
    && !/(?:内机罩|挂机罩|柜机罩|清洗罩|接水罩)/.test(text);
  if (isAirconOutdoorCover) concepts.airconOutdoorCover = 1;

  var isPrivacyDocumentSleeve = /(?:身份证|证件|银行卡|社保卡|校园卡|驾驶证)/.test(text)
    && /(?:防窥|隐私|防信息泄露|防泄漏|防偷窥|防消磁)/.test(text)
    && /(?:卡套|证件套|保护套|保护膜|护卡)/.test(text)
    && !/(?:不锈钢|金属卡包|金属卡盒|钱包|卡夹|十卡位|多卡位)/.test(text);
  if (isPrivacyDocumentSleeve) concepts.privacyDocumentSleeve = 1;

  return concepts;
}

function procurementSharedKeywordConcept(a, b) {
  var conceptsA = procurementKeywordConcepts(a || {});
  var conceptsB = procurementKeywordConcepts(b || {});
  var shared = Object.keys(conceptsA).filter(function(key) { return conceptsB[key]; });
  return shared.length === 1 ? shared[0] : '';
}

function procurementCoreTitleText(value) {
  var text = String(value || '').toLowerCase()
    .replace(/【[^】]*】|\[[^\]]*\]|[（(][^）)]*[）)]/g, '')
    .replace(/拍一发二|买一送一|好物推荐|厂家清仓|热销|官方正品|厂家直销|厂家直发|工厂直发|限时|秒杀|爆款|特价|促销|包邮|同款|视频同款/g, '')
    .replace(/家用|通用|新款|多功能|加厚|升级款?|推荐|便携|高颜值|超值|囤货必备|全家可用|抢/g, '')
    // V20.12.62: Remove category suffixes that cause false merges
    .replace(/(?:办公用品|五金工具|劳保用品|防护用品|日用百货|家居日用|其他\S{1,6}用品?)+$/g, '')
    .replace(/(?:办公用品|五金|劳保|防护|日用|百货|家居)+$/g, '')
    .replace(/\d+(?:个|件|套|盒|包|张|片|支|只|瓶|组|位)装?/g, '')
    .replace(/[-_\s]+(?:[a-z]{1,3}|运营\d{1,2}|店\d{1,2})$/i, '')
    .replace(/[^\u4e00-\u9fffa-z0-9]/g, '');
  return text;
}

function procurementCoreTitleNgrams(value) {
  var text = procurementCoreTitleText(value);
  var grams = {};
  for (var size = 4; size <= 6; size++) {
    for (var i = 0; i + size <= text.length; i++) {
      grams[text.slice(i, i + size)] = 1;
    }
  }
  return grams;
}

function procurementProfileCoreNgrams(profile) {
  if (!profile) return {};
  if (!profile._procCoreNgrams) {
    profile._procCoreNgrams = procurementCoreTitleNgrams(profile.title || '');
  }
  return profile._procCoreNgrams;
}

function buildProcurementCorpusStats(profiles) {
  var df = {}, total = 0;
  (profiles || []).forEach(function(profile) {
    var grams = procurementProfileCoreNgrams(profile);
    if (!Object.keys(grams).length) return;
    total++;
    Object.keys(grams).forEach(function(key) { df[key] = (df[key] || 0) + 1; });
  });
  return {df:df, total:Math.max(1, total)};
}


// V20.12.62: Product feature extraction for set-based matching
// Extracts product attributes as a set, handles reordering and variations
function procurementProductFeatures(title, spec) {
  var text = String(title || '') + ' ' + String(spec || '');
  // Remove promotional text
  text = text.replace(/【[^】]*】|\[[^\]]*\]|[(（][^)）]*[)）]/g, '')
    .replace(/拍一发\d+|买一送一|好物推荐|厂家清仓|热销|限时|秒杀|爆款|特价|促销|包邮|同款|抢!/g, '')
    .replace(/家用|通用|新款|多功能|加厚|升级款?|推荐|便携|高颜值|超值|囤货必备|加大|简易安装|夏天/g, '');
  
  var features = {};
  
  // Material patterns
  var materials = ['不锈钢','金属','铝箔','铝膜','双面铝箔','硅胶','塑料','木质','竹制','棉','涤纶','尼龙','帆布','皮革','玻璃','陶瓷','橡胶','TPU','ABS','PP'];
  materials.forEach(function(m) { if (text.indexOf(m) >= 0) features['m:'+m] = 1; });
  
  // Product type patterns (the noun)
  var types = [
    '空调外机罩','空调罩','防晒罩','保护罩','防尘罩','遮阳罩','隔热罩','防雨罩',
    '空调外机防晒罩','空调遮阳板','空调保护罩',
    '纱窗清洁刷','纱窗清洁剂','清洁刷','清洁剂','拖把','扫帚',
    '收纳袋','收纳盒','收纳箱','鞋套','鞋袋','鞋包',
    '手机支架','车载支架','数据线','充电线',
    '保鲜袋','保鲜膜','保鲜盒','垃圾袋',
    '枕套','毛巾','浴巾','围裙',
    '面膜','化妆棉','防晒霜',
    '锅','碗','勺','铲','砧板','菜板',
    '卡包','卡盒','钱包',
    '鼻塞','眼罩','耳塞',
    '开瓶器','扳手','螺丝刀',
    '蜡烛','香薰','香片',
    '纹身贴','贴纸',
    '毛刷','牙刷','梳子',
    '剪刀','美工刀','尺子',
    '杯子','水杯','保温杯',
    '垃圾桶','置物架','衣架',
    '鞋垫','鞋刷','鞋油',
    '雨伞','雨衣','雨鞋',
    '手套','口罩','帽子',
    '袜子','内裤','内衣',
    '枕头','被子','床单',
    '窗帘','桌布','地垫',
    '花盆','花瓶','花架',
    '宠物碗','猫砂','狗粮',
    '玩具','积木','拼图',
    '书包','笔袋','文具',
    '发卡','发圈','头绳',
    '耳环','项链','手链',
    '眼镜','墨镜','老花镜',
    '手表','表带','闹钟',
    '键盘','鼠标','鼠标垫',
    'U盘','硬盘','内存卡',
    '充电宝','充电器','数据线',
    '耳机','音箱','麦克风',
    '相机','镜头','三脚架',
    '无人机','遥控器','电池',
    '灯泡','台灯','灯带',
    '风扇','加湿器','净化器',
    '电饭煲','电磁炉','微波炉',
    '烤箱','空气炸锅','面包机',
    '洗衣机','冰箱','空调',
    '电视','显示器','投影仪',
    '路由器','交换机','网线',
    '门锁','门铃','监控',
    '灭火器','烟雾报警器','安全锤',
    '急救包','医药箱','体温计',
    '血压计','血糖仪','血氧仪',
    '轮椅','拐杖','助行器',
    '假牙','牙套','牙刷',
    '助听器','放大镜','老花镜',
    '尿不湿','纸尿裤','湿巾',
    '奶瓶','奶嘴','吸奶器',
    '婴儿车','婴儿床','婴儿座椅',
    '安全座椅','安全门','安全锁',
    '学步车','学步带','学步鞋',
    '滑板车','自行车','平衡车',
    '游泳圈','泳镜','泳帽',
    '瑜伽垫','瑜伽球','瑜伽带',
    '哑铃','杠铃','拉力器',
    '跑步机','健身车','椭圆机',
    '跳绳','毽子','飞盘',
    '篮球','足球','排球',
    '乒乓球','羽毛球','网球',
    '高尔夫','台球','保龄球',
    '钓鱼竿','鱼线','鱼钩',
    '帐篷','睡袋','登山杖',
    '望远镜','指南针','对讲机',
    '手电筒','头灯','营地灯',
    '烧烤架','烧烤炭','烧烤签',
    '野餐垫','保温箱','保温壶',
    '水壶','水袋','水杯',
    '防潮垫','充气垫','折叠椅',
    '折叠桌','折叠床','折叠梯',
    '工具箱','工具包','工具袋',
    '扳手','螺丝刀','钳子',
    '电钻','电锯','电刨',
    '油漆','涂料','壁纸',
    '瓷砖','地板','地毯',
    '窗帘','百叶窗','纱窗',
    '门垫','地垫','防滑垫',
    '衣架','裤架','领带架',
    '鞋架','鞋柜','鞋盒',
    '书架','书柜','书立',
    '文件夹','文件盒','文件柜',
    '名片夹','名片盒','名片册',
    '相框','相册','照片墙',
    '挂钟','座钟','闹钟',
    '花瓶','花盆','花架',
    '烛台','香炉','香薰',
    '烟灰缸','打火机','火柴',
    '酒杯','酒壶','酒架',
    '茶杯','茶壶','茶盘',
    '咖啡杯','咖啡壶','咖啡机',
    '开瓶器','开罐器','瓶塞',
    '量杯','量勺','厨房秤',
    '计时器','温度计','湿度计',
    '放大镜','显微镜','望远镜',
    '地球仪','地图','指南针',
    '沙漏','风铃','捕梦网',
    '风车','风向标','日晷',
    '风筝','气球','彩带',
    '礼花','鞭炮','烟花',
    '灯笼','对联','福字',
    '红包','利是封','贺卡',
    '包装纸','包装袋','礼品盒',
    '丝带','蝴蝶结','装饰花',
    '假花','干花','永生花',
    '圣诞树','圣诞灯','圣诞帽',
    '南瓜灯','面具','万圣节装饰',
    '彩蛋','兔子','复活节装饰',
    '国旗','气球','派对装饰',
    '蛋糕','蜡烛','生日帽',
  ];
  types.forEach(function(t) { if (text.indexOf(t) >= 0) features['t:'+t] = 1; });
  
  // Function patterns
  var functions = ['防晒','遮阳','隔热','防雨','防尘','防潮','防霉','防水','防滑','防摔','防撞','防撞','防盗','防消磁','防窥','防辐射','防蚊','防虫','驱蚊','驱虫','除尘','清洁','消毒','杀菌','除味','除湿','保暖','降温','保温','保冷','保鲜','收纳','储物','整理','挂晒','晾晒','照明','装饰','保护','防护','固定','支撑','支撑','按摩','美甲','化妆','护肤','减肥','健身','运动','游泳','钓鱼','露营','野餐','烧烤','烹饪','烘焙','煮饭','炒菜','煲汤','蒸煮','煎炸','烤制','搅拌','研磨','切割','削皮','开瓶','开罐','量取','称重','计时','测温','测湿','测距','测角','测水平','测垂直','测直线','测圆','测方','测角','测距','测深','测宽','测高','测长','测厚','测径','测周','测面积','测体积','测重量','测温度','测湿度','测气压','测风速','测光照','测噪音','测辐射','测电压','测电流','测电阻','测电容','测电感','测频率','测周期','测相位','测功率','测能量','测效率','测流量','测压力','测真空','测泄漏','测硬度','测粗糙度','测光泽度','测色差','测白度','测黄度','测红度','测绿度','测蓝度','测亮度','测暗度','测透明度','测浑浊度','测密度','测粘度','测张力','测弹性','测塑性','测韧性','测脆性','测疲劳','测蠕变','测松弛','测膨胀','测收缩','测翘曲','测扭曲','测弯曲','测拉伸','测压缩','测剪切','测扭转','测冲击','测振动','测噪声','测声强','测声压','测声速','测声频','测声波','测超声','测次声','测微波','测红外','测紫外','测可见光','测激光','测X射线','测γ射线','测α射线','测β射线','测中子','测质子','测电子','测离子','测原子','测分子','测纳米','测微米','测毫米','测厘米','测分米','测米','测千米','测英里','测英尺','测英寸','测码','测海里','测光年','测天文单位','测秒差距','测弧度','测角度','测立体角','测球面度','测百分度','测千分度','测万分度','测十万分度','测百万分度','测千万分度','测亿分度','测十亿分度','测百亿分度','测千亿分度','测万亿分度'];
  // Only keep function words that are actually in the text
  var funcPatterns = ['防晒','遮阳','隔热','防雨','防尘','防潮','防霉','防水','防滑','防摔','防盗','防消磁','防窥','防辐射','防蚊','防虫','除尘','清洁','消毒','杀菌','除味','除湿','保暖','降温','保温','保鲜','收纳','保护','固定','支撑','按摩'];
  funcPatterns.forEach(function(f) { if (text.indexOf(f) >= 0) features['f:'+f] = 1; });
  
  // Target object
  var targets = ['空调','空调外机','纱窗','厨房','卫生间','卧室','客厅','阳台','车内','车载','桌面','墙面','地面','窗户','门','衣柜','鞋柜','冰箱','洗衣机','电视','电脑','手机','平板','笔记本','充电宝','耳机','键盘','鼠标','书包','钱包','卡包','行李箱','旅行箱','拉杆箱','登机箱','托运箱','快递箱','纸箱','包装箱','收纳箱','储物箱','工具箱','急救箱','医药箱','化妆箱','首饰箱','保险箱','冰箱','冰柜','冷柜','冷藏柜','冷冻柜','展示柜','陈列柜','酒柜','书柜','鞋柜','衣柜','橱柜','吊柜','地柜','角柜','转柜','推拉柜','平开门柜','折叠柜','移动柜','固定柜','悬挂柜','落地柜','嵌入柜','独立柜','组合柜','模块柜','定制柜','成品柜','整体柜','拆装柜','组装柜','半成品柜','原材料柜','配件柜','五金柜','工具柜','文件柜','资料柜','档案柜','凭证柜','票据柜','合同柜','证书柜','奖杯柜','奖牌柜','奖状柜','锦旗柜','纪念柜','展示柜','陈列柜','样品柜','模型柜','沙盘柜','展台柜','展架柜','展板柜','展墙柜','展厅柜','展区柜','展位柜','展棚柜','帐篷柜','遮阳柜','防雨柜','防晒柜','隔热柜','保温柜','保冷柜','防尘柜','防潮柜','防霉柜','防水柜','防虫柜','防鼠柜','防鸟柜','防盗柜','防火柜','防爆柜','防腐柜','防锈柜','防磁柜','防静电柜','防辐射柜'];
  var targetPatterns = ['空调','空调外机','纱窗','厨房','卫生间','冰箱','洗衣机','衣柜','鞋柜','窗户','手机','充电宝','书包','行李箱','桌面','车载','车内'];
  targetPatterns.forEach(function(t) { if (text.indexOf(t) >= 0) features['o:'+t] = 1; });
  
  return features;
}

// V20.12.62: Feature-based product similarity
// Returns true if two products share enough features to be the same product
function procurementFeatureSimilarity(a, b) {
  var featA = procurementProductFeatures(a.title, a.spec);
  var featB = procurementProductFeatures(b.title, b.spec);
  var keysA = Object.keys(featA);
  var keysB = Object.keys(featB);
  if (!keysA.length || !keysB.length) return 0;
  
  // Count shared features
  var shared = 0;
  var sharedTypes = 0;
  var sharedFunctions = 0;
  var sharedTargets = 0;
  keysA.forEach(function(k) {
    if (featB[k]) {
      shared++;
      if (k.charAt(0) === 't') sharedTypes++;
      if (k.charAt(0) === 'f') sharedFunctions++;
      if (k.charAt(0) === 'o') sharedTargets++;
    }
  });
  
  // Must share at least 1 type OR (1 target AND 2 functions)
  var typeMatch = sharedTypes >= 1;
  var targetFuncMatch = sharedTargets >= 1 && sharedFunctions >= 2;
  if (!typeMatch && !targetFuncMatch) return 0;
  
  // Jaccard similarity on all features
  var union = keysA.length + keysB.length - shared;
  var jaccard = union > 0 ? shared / union : 0;
  
  // Bonus for type match
  if (typeMatch) jaccard = Math.max(jaccard, 0.3);
  
  return jaccard;
}

function procurementRareCoreEvidence(a, b, corpusStats) {
  var gramsA = procurementProfileCoreNgrams(a);
  var gramsB = procurementProfileCoreNgrams(b);
  var keysA = Object.keys(gramsA), keysB = Object.keys(gramsB);
  if (!keysA.length || !keysB.length) {
    return {score:0, longest:0, shared:0, minCoverage:0, distinctiveness:0};
  }
  var stats = corpusStats || {df:{}, total:2};
  function weight(key) {
    return Math.log((stats.total + 1) / ((stats.df[key] || 0) + 1)) + 1;
  }
  var totalA = 0, totalB = 0, sharedWeight = 0, shared = 0, longest = 0;
  keysA.forEach(function(key) { totalA += weight(key); });
  keysB.forEach(function(key) { totalB += weight(key); });
  keysA.forEach(function(key) {
    if (!gramsB[key]) return;
    var w = weight(key);
    sharedWeight += w;
    shared++;
    if (key.length > longest) longest = key.length;
  });
  var minCoverage = Math.min(
    sharedWeight / Math.max(1, totalA),
    sharedWeight / Math.max(1, totalB)
  );
  var distinctiveness = shared ? sharedWeight / shared : 0;
  return {
    score:minCoverage,
    longest:longest,
    shared:shared,
    minCoverage:minCoverage,
    distinctiveness:distinctiveness
  };
}

function procurementInformativeSpecKeys(value) {
  var keys = {};
  Object.keys(extractSpecNames(value)).forEach(function(name) {
    var info = procurementSpecInformation(name);
    // Only long, concrete specification text is eligible for corpus-frequency
    // checks. Counts, basic colors and short generic variants are excluded.
    if (info.informative && info.length >= 8) keys[info.informative] = 1;
  });
  return Object.keys(keys);
}

function procurementProductFamilies(title, spec) {
  var text = String(title || '') + ' ' + String(spec || '');
  var patterns = {
    phone:/手机支架|磁吸支架|车载支架|手机座|导航支架/,
    stove:/燃气灶|煤气灶|炉灶|灶台/,
    tattoo:/纹身贴|纹贴|刺青贴/,
    storage:/收纳袋|压缩袋|真空袋|整理袋|收纳盒|收纳箱|收纳包|收纳筐|收纳篮|储物袋|储物盒/,
    cleaning:/清洁剂|清洁刷|马桶刷|去污|湿巾/,
    beauty:/面膜|敷脸|化妆棉|护肤|美容/,
    toy:/玩具|益智|卡片游戏|积木|拼装/,
    paper:/硅油纸|烘焙纸|油纸|保鲜膜|铝箔/,
    footwear:/鞋垫|拖鞋|凉鞋|鞋底|鞋套|鞋袋|鞋包|鞋盒|鞋架|鞋撑/,
    cable:/数据线|充电线|理线器|绕线器/,
    lighting:/小夜灯|投影灯|灯带|台灯/,
    kitchen:/锅|碗|勺|铲|削皮|刨丝|切菜|打蛋器/,
    textile:/毛巾|浴巾|枕套|床单|围裙/,
    animal:/鸡食槽|喂鸡|喂食器|饮水器/,
    auto:/汽车摆件|车载|雨刮|遮阳罩/,
    insect:/驱蚊|驱虫|防虫|杀虫/,
    stationery:/练字帖|书套|文具|作业本/,
    hardware:/扳手|螺丝|阀门|水龙头|角阀/
  };
  var found = {};
  Object.keys(patterns).forEach(function(key) {
    if (patterns[key].test(text)) found[key] = 1;
  });
  var concepts = procurementKeywordConcepts({title:title, spec:spec});
  Object.keys(concepts).forEach(function(key) { found[key] = 1; });
  if (/(?:不锈钢|金属).*(?:卡包|卡盒)|(?:卡包|卡盒).*(?:不锈钢|金属)|十卡位/.test(text)) {
    found.metalCardHolder = 1;
  }
  if (/多卡位/.test(text)) found.multiSlotCardHolder = 1;
  return found;
}

function procurementModelTokens(title) {
  var text = String(title || '').toLowerCase();
  var tokens = {};
  var matches = text.match(/[a-z]{1,8}\s*-?\s*\d{1,5}[a-z]?|\d{2,5}[a-z]{1,4}/g) || [];
  matches.forEach(function(token) {
    token = token.replace(/[\s_-]/g, '');
    if (token.length >= 2) tokens[token] = 1;
  });
  return tokens;
}

function procurementModelConflict(a, b) {
  var modelsA = procurementModelTokens((a && a.title) || '');
  var modelsB = procurementModelTokens((b && b.title) || '');
  var keysA = Object.keys(modelsA), keysB = Object.keys(modelsB);
  if (!keysA.length || !keysB.length) return false;
  return !keysA.some(function(key) { return modelsB[key]; });
}

function procurementSubType(profile) {
  var text = String((profile && profile.title) || '') + ' ' + String((profile && profile.spec) || '');
  var sub = {};
  // Cleaning: tool vs agent vs target-specific
  if (/(?:拖把|扫帚|刮刀|抹布|百洁布|海绵擦|钢丝球)/.test(text)) sub.cleaningTool = 1;
  if (/(?:清洁剂|清洁液|清洁粉|去污剂|清洗剂|除垢剂|消毒液|漂白|洁厕|洗洁精|去渍)/.test(text)) sub.cleaningAgent = 1;
  // Cleaning brush by target object (prevent cross-target merges)
  if (/(?:手机|充电口|喇叭孔|听筒|清灰).{0,6}清洁刷|清洁刷.{0,6}(?:手机|充电口|清灰)/.test(text)) sub.phoneCleanBrush = 1;
  if (/(?:纱窗|窗户|玻璃).{0,6}清洁刷|清洁刷.{0,6}(?:纱窗|窗户|免拆洗)/.test(text)) sub.windowCleanBrush = 1;
  if (/(?:花洒|淋浴|喷头).{0,6}(?:刷|清洁)|清洁刷.{0,6}花洒/.test(text)) sub.showerCleanBrush = 1;
  if (/(?:瓶子|水瓶|奶瓶|保温杯).{0,6}(?:刷|清洁)|清洁刷.{0,6}(?:瓶|杯)/.test(text)) sub.bottleCleanBrush = 1;
  if (/(?:马桶|厕所|地漏|下水道).{0,6}(?:刷|清洁)/.test(text)) sub.toiletCleanBrush = 1;
  if (/(?:理发器|剃须刀|电推).{0,6}清洁刷/.test(text)) sub.barberCleanBrush = 1;
  // Phone accessories: car mount vs desktop stand vs fidget toy
  if (/(?:车载|汽车|中控|仪表台|出风口|吸盘式).{0,6}(?:支架|手机架|手机座)/.test(text) || /(?:支架|手机架).{0,6}(?:车载|汽车|中控|仪表台)/.test(text)) sub.carPhoneMount = 1;
  if (/(?:解压|旋转解压|指尖陀螺|减压|把玩|趣味).{0,6}(?:支架|手机)/.test(text) || /(?:支架|手机).{0,6}(?:解压|减压|趣味)/.test(text)) sub.fidgetStand = 1;
  if (/(?:桌面|床头|床边|懒人|追剧).{0,6}(?:支架|手机架)/.test(text)) sub.deskStand = 1;
  // Kitchen: cookware vs utensil vs storage
  if (/(?:锅|煲|炒锅|汤锅|煎锅|蒸锅|压力锅)/.test(text)) sub.cookware = 1;
  if (/(?:保鲜盒|保鲜袋|密封罐|储物罐|收纳盒)/.test(text)) sub.foodStorage = 1;
  // Personal care: skincare vs tool
  if (/(?:面膜|精华|乳液|面霜|爽肤水|化妆水|眼霜|防晒霜)/.test(text)) sub.skincare = 1;
  if (/(?:化妆棉|粉扑|美妆蛋|化妆刷|睫毛夹|修眉刀)/.test(text)) sub.beautyTool = 1;
  // Footwear: shoe vs insole vs sock
  if (/(?:拖鞋|凉鞋|运动鞋|板鞋|皮鞋|布鞋)/.test(text)) sub.shoe = 1;
  if (/(?:鞋垫|鞋底|足弓)/.test(text)) sub.insole = 1;
  if (/(?:袜|棉袜|丝袜|短袜|长袜|船袜)/.test(text)) sub.sock = 1;
  // Gloves: disposable vs bath vs fashion vs work
  if (/(?:一次性|TPE|PVC|乳胶|丁腈).{0,4}手套/.test(text) || /手套.{0,4}(?:一次性|TPE|PVC|乳胶|丁腈|食品级|防护)/.test(text)) sub.disposableGlove = 1;
  if (/(?:搓澡|沐浴|洗澡|浴巾).{0,4}手套/.test(text) || /手套.{0,4}(?:搓澡|沐浴|洗澡)/.test(text)) sub.bathGlove = 1;
  if (/(?:萌宠|卡通|可爱|时尚|保暖|触屏|皮手套|毛线手套)/.test(text)) sub.fashionGlove = 1;
  if (/(?:劳保|工作|防割|防滑|电焊|园艺).{0,4}手套/.test(text)) sub.workGlove = 1;
  // Toys: fidget vs building vs educational
  if (/(?:解压|指尖陀螺|减压|捏捏乐|磁力球)/.test(text)) sub.fidgetToy = 1;
  if (/(?:积木|拼装|拼图|乐高)/.test(text)) sub.buildingToy = 1;
  if (/(?:益智|早教|蒙氏|逻辑)/.test(text)) sub.eduToy = 1;
  // Candles: scented vs ritual vs emergency
  if (/(?:香薰|香氛|精油|无烟|蜡片)/.test(text)) sub.scentedCandle = 1;
  if (/(?:酥油|供佛|莲花|祭祀|供奉)/.test(text)) sub.ritualCandle = 1;
  if (/(?:停电|应急|照明|白蜡|红蜡)/.test(text)) sub.emergencyCandle = 1;
  return sub;
}

function procurementFamilyConflict(a, b) {
  if (procurementTitleFamilyConflict(a && a.title, b && b.title)) return true;
  var familiesA = procurementProductFamilies(a.title, a.spec);
  var familiesB = procurementProductFamilies(b.title, b.spec);
  var keysA = Object.keys(familiesA), keysB = Object.keys(familiesB);
  if (!keysA.length || !keysB.length) return false;
  // Check if they share any family
  var sharedFamily = keysA.some(function(key) { return familiesB[key]; });
  if (!sharedFamily) return true; // different families → conflict
  // V20.12.62: Within the same family, check sub-type conflict
  // e.g. cleaning TOOL vs cleaning AGENT should NOT merge
  var subA = procurementSubType(a);
  var subB = procurementSubType(b);
  var subKeysA = Object.keys(subA), subKeysB = Object.keys(subB);
  if (subKeysA.length && subKeysB.length) {
    var sharedSub = subKeysA.some(function(key) { return subB[key]; });
    if (!sharedSub) return true; // same family but different sub-type → conflict
  }
  return false; // same family, same (or unknown) sub-type → no conflict
}

function procurementTitleContainment(t1, t2) {
  if (!t1 || !t2) return 0;
  var shorter = t1.length <= t2.length ? t1 : t2;
  var longer = t1.length <= t2.length ? t2 : t1;
  if (shorter.length < 6) return 0;
  return longer.indexOf(shorter) >= 0 ? shorter.length / longer.length : 0;
}

// ===== V20.29.0: 向量候选阻断索引（提速合并，不改变合并结果） =====
// 原理：合并前用廉价的 token 索引召回候选子集，只对候选做完整向量评分。
// 保底：候选为空或覆盖过广时回退全量比较 ⇒ 结果与全量比较完全一致。
function procurementBlockTokens(text) {
  var tokens = {};
  var s = String(text || '').toLowerCase();
  // 中文 3-4 字滑动窗口：能通过向量匹配标题阻断的对（dice/包含 ≥0.24）
  // 必然共享至少一个窗口；规格 strongLong 场景同样共享规格窗口。
  for (var len = 4; len >= 3; len--) {
    for (var i = 0; i <= s.length - len; i++) {
      var chunk = s.substring(i, i + len);
      if (/^[\u4e00-\u9fff]+$/.test(chunk)) tokens[chunk] = 1;
    }
  }
  // 英文/数字 token（≥2 位）
  var latin = s.match(/[a-z0-9]{2,}/g) || [];
  latin.forEach(function(t) { tokens[t] = 1; });
  return Object.keys(tokens);
}

function buildVectorCandidateIndex(candidates) {
  var idx = {};
  function add(tokens, ci) {
    tokens.forEach(function(t) {
      if (!idx[t]) idx[t] = [];
      idx[t].push(ci);
    });
  }
  (candidates || []).forEach(function(c, ci) {
    add(procurementBlockTokens(c.title || ''), ci);
    add(procurementBlockTokens(c.spec || ''), ci);
  });
  return idx;
}

function selectVectorCandidatesByIndex(source, idx, allCandidates) {
  var hit = {};
  var tokens = procurementBlockTokens((source && source.title) || '')
    .concat(procurementBlockTokens((source && source.spec) || ''));
  tokens.forEach(function(t) {
    var list = idx[t];
    if (list) list.forEach(function(ci) { hit[ci] = 1; });
  });
  var keys = Object.keys(hit).map(Number);
  // 保底回退：无候选或覆盖过广 → 全量比较，保证不漏合并
  if (!keys.length || keys.length > (allCandidates || []).length * 0.85) return allCandidates || [];
  return keys.map(function(ci) { return allCandidates[ci]; });
}

// ===== V20.29.0: 合并组安全校验 =====
// 新记录加入组前，必须与组内每一个成员（而非仅锚点）通过严格证据校验，
// 防止传递链把不同产品逐步并入同一组。
// V21.0.41: 指纹优先 — 若双方指纹均存在且不同，直接拒合
function strictMergeEvidence(titleA, specA, titleB, specB) {
  if (!titleA || !titleB) return false;
  var ta = norm(titleA), tb = norm(titleB);
  if (ta === tb) return true;
  var probeA = {title: titleA, spec: specA || ''};
  var probeB = {title: titleB, spec: specB || ''};
  if (procurementFamilyConflict(probeA, probeB)) return false;
  if (procurementModelConflict(probeA, probeB)) return false;
  var core = coreProductConflict(titleA, specA || '', titleB, specB || '');
  if (core.conflict) return false;
  var cat = enhancedCategoryConflict(titleA, specA || '', titleB, specB || '');
  if (cat) {
    // V20.29.1: 核心名词一致时豁免品类冲突（与 procurementVectorScore 一致），
    // 避免 extractProductType 泛化误触（"儿童"→"儿童玩具"）拦截同产品。
    var cnA = extractCoreProductNoun(titleA || '');
    var cnB = extractCoreProductNoun(titleB || '');
    if (!(cnA && cnB && cnA === cnB)) return false;
  }
  var decision = procurementVectorScore(probeA, probeB, null);
  return !!decision.approved;
}

function canJoinMergeInPlaceGroup(src, group) {
  if (!src || !group) return false;
  var anchor = group.anchor || {};
  if (!strictMergeEvidence(src.title || '', src.spec || '', anchor.title || '', anchor.spec || '')) return false;
  // 与组内每个成员校验，防止传递链污染
  var members = group.records || [];
  for (var gi = 0; gi < members.length; gi++) {
    var member = extractRecFields(members[gi]);
    if (!strictMergeEvidence(src.title || '', src.spec || '', member.title || '', member.spec || '')) return false;
  }
  return true;
}


// V21.0.30: 反馈学习 — 载入人工拆分记录，动态收紧对应家族阈值
var FEEDBACK_THRESH_ADJ = {};
try {
  var _fb = localStorage.getItem('mergeFeedback_v21');
  if(_fb){ var fb=JSON.parse(_fb); (fb.corrections||[]).forEach(function(c){ var fam=c.family||'unknown'; FEEDBACK_THRESH_ADJ[fam]=(FEEDBACK_THRESH_ADJ[fam]||0)+0.015; }); }
} catch(e){}
function getFamilyAdj(fam){ var base=FEEDBACK_THRESH_ADJ[fam]||0; if(fam==='glove'||fam==='tape') base+=0.02; return base; }

function procurementVectorScore(a, b, corpusStats) {
  var t1 = norm((a && a.title) || ''), t2 = norm((b && b.title) || '');
  // === 细分产品类别检测（调整优先级） ===
  function detectProductCategory(title, spec) {
    var text = (title || '') + ' ' + (spec || '');
    if (/鞋套|鞋袋|鞋包|鞋盒|鞋架|鞋垫|鞋撑/.test(text)) return 'shoe_accessory';
    if (/鞋/.test(text) && /收纳/.test(text)) return 'shoe_storage';
    if (/收纳袋|收纳包|收纳盒|收纳箱/.test(text)) return 'storage_general';
    if (/行李箱|旅行箱|拉杆箱/.test(text)) return 'luggage';
    if (/手套|一次性.*手套|TPE手套|PVC手套/.test(text)) return 'glove';
    if (/双面胶|胶带|贴纸|封边|美缝/.test(text)) return 'tape';
    if (/刷|清洁刷|洗碗刷|油烟机刷/.test(text)) return 'brush';
    if (/扳手|钳子|螺丝刀|工具钳/.test(text)) return 'tool';
    if (/防堵|过滤网|地漏/.test(text)) return 'filter';
    if (/泡腾片|清洁片|除垢/.test(text)) return 'clean_tablet';
    if (/抹布|海绵|百洁布/.test(text)) return 'cloth';
    if (/香薰|香片|蜡片/.test(text)) return 'fragrance';
    if (/挂画|装饰画|书法/.test(text)) return 'painting';
    if (/水杯|茶杯|保温杯/.test(text)) return 'cup';
    return 'unknown';
  }
var FAMILY_THRESH_ADJ = {glove:0.02, tape:0.02, brush:0.015, tool:0.015, storage_general:0.01};
function familyThreshAdj(cat){ return FAMILY_THRESH_ADJ[cat]||0; }

  
  var catA = detectProductCategory(a && a.title, a && a.spec);
  var catB = detectProductCategory(b && b.title, b && b.spec);
  
  // 如果类别明确且不同，直接拒绝合并
  if (catA !== 'unknown' && catB !== 'unknown' && catA !== catB) {
    return {
      score: 0,
      approved: false,
      stage: 'CATEGORY_CONFLICT',
      titleScore: 0,
      specScore: 0,
      lengthRatio: 0,
      familyConflict: false,
      modelConflict: false
    };
  }
  
  // === 规格颜色变体检测 ===
  function specContainsColorVariant(specA, specB) {
    if (!specA || !specB) return false;
    var colorPattern = /[粉黑灰白红蓝绿黄紫棕米]/;
    
    // 提取颜色
    var colorA = (specA.match(colorPattern) || [])[0];
    var colorB = (specB.match(colorPattern) || [])[0];
    
    // 如果颜色不同，视为变体
    if (colorA && colorB && colorA !== colorB) return true;
    
    return false;
  }
  if (!t1 || !t2) return {score:0, approved:false};
  var familyConflict = procurementFamilyConflict(a || {}, b || {});
  var modelConflict = procurementModelConflict(a || {}, b || {});
  // 优化: 增强品类冲突检测
  var categoryConflict = enhancedCategoryConflict(
    (a && a.title) || '', (a && a.spec) || '',
    (b && b.title) || '', (b && b.spec) || ''
  );
  // V20.29.1: 核心名词一致时豁免品类冲突。
  // extractProductType 的泛化误触（"儿童"→"儿童玩具"、"自行车"→"车配件"）
  // 会把同产品（如自行车气门灯）误判为类型冲突；核心名词（气门灯）是
  // 更可靠的产品身份证据。
  var coreNounA = extractCoreProductNoun((a && a.title) || '');
  var coreNounB = extractCoreProductNoun((b && b.title) || '');
  if (categoryConflict && coreNounA && coreNounB && coreNounA === coreNounB) {
    categoryConflict = false;
  }
  // 优化6: 核心产品名词冲突检测（解决共享修饰词导致的错误合并）
  var coreConflict = coreProductConflict(
    (a && a.title) || '', (a && a.spec) || '',
    (b && b.title) || '', (b && b.spec) || ''
  );
  
  if (familyConflict || modelConflict || categoryConflict || coreConflict.conflict) {
    var conflictStage = familyConflict ? 'FAMILY_CONFLICT' : 
      (modelConflict ? 'MODEL_CONFLICT' : 
      (coreConflict.conflict ? 'CORE_PRODUCT_CONFLICT' : 'CATEGORY_CONFLICT'));
    return {
      score:0,
      approved:false,
      stage:conflictStage,
      titleScore:0,
      specScore:0,
      lengthRatio:0,
      familyConflict:familyConflict,
      modelConflict:modelConflict,
      categoryConflict:categoryConflict,
      coreConflict:coreConflict.conflict
    };
  }
  if (t1 === t2) {
    return {score:1, approved:true, stage:'TITLE_NORMALIZED', titleScore:1, specScore:1};
  }
  var jw = jaroWinkler(t1, t2);
  var dice = diceSim(t1, t2);
  var cosine = cosineSim(t1, t2);
  var containment = procurementTitleContainment(t1, t2);
  var titleScore = Math.max(
    jw * 0.40 + dice * 0.30 + cosine * 0.30,
    containment * 0.96
  );
  // V21.0.30: TF-IDF 加权 — 稀有词共享额外 +0.04
  try {
    if(corpusStats && corpusStats.df){
      var rt=(rareCore && rareCore.sharedTokens)||[];
      var w=0; rt.forEach(function(tok){ var df=corpusStats.df[tok]||1; var idf=Math.log((corpusStats.total||100)/(df+1)); if(idf>1.8) w+=0.015; });
      if(w) titleScore=Math.min(1, titleScore + Math.min(0.06, w));
    }
  } catch(e){}
  // 如果标题高度相似（≥0.95），但规格包含颜色变体，则拒绝合并
  if (titleScore >= 0.95 && specContainsColorVariant((a && a.spec) || '', (b && b.spec) || '')) {
    return {
      score: 0,
      approved: false,
      stage: 'COLOR_VARIANT',
      titleScore: titleScore,
      specScore: specScore,
      lengthRatio: lengthRatio,
      familyConflict: false,
      modelConflict: false
    };
  }
  // === 规格结构差异检测 ===
  // V20.29.1: 按换行分隔计算规格行数（分号是行内"名称;数量"分隔符，
  // 不是行分隔符）。原按分号分割会把"【今日特惠】;七彩轮胎灯【2个装】;13"
  // 这类带标签前缀的规格误判为多行，导致 titleScore 0.977 的同产品被拒。
  function specStructureDiff(specA, specB) {
    if (!specA || !specB) return false;
    var linesA = specA.split(/\n/).filter(function(line) { return line.trim().length > 0; }).length;
    var linesB = specB.split(/\n/).filter(function(line) { return line.trim().length > 0; }).length;
    // 行数差异≥2，且至少一方有多行
    return Math.abs(linesA - linesB) >= 2 && (linesA > 1 || linesB > 1);
  }
  
  // 如果标题相似度较高（0.90–0.96），且规格结构差异明显，则拒绝合并。
  // V20.29.1: titleScore ≥0.96 视为标题几乎一致（同一产品），规格结构差异
  // 只是不同平台的规格粒度不同（如"1个装"vs"单色/七彩各装数"），不再拦截。
  if (titleScore >= 0.9 && titleScore < 0.96 && specStructureDiff((a && a.spec) || '', (b && b.spec) || '')) {
    return {
      score: 0,
      approved: false,
      stage: 'SPEC_STRUCTURE_DIFF',
      titleScore: titleScore,
      specScore: specScore,
      lengthRatio: lengthRatio,
      familyConflict: false,
      modelConflict: false
    };
  }
  var specEvidence = enhancedSpecEvidence(
    (a && a.spec) || '', (b && b.spec) || ''
  );
  var specScore = specEvidence.score;
  var rareCore = procurementRareCoreEvidence(a || {}, b || {}, corpusStats);
  var hasBothSpecs = !!String((a && a.spec) || '').trim()
    && !!String((b && b.spec) || '').trim();
  // V21.0.30: Spec fingerprint overlap gate — require shared pack/size token when both have specs
  if (hasBothSpecs && titleScore < 0.94) {
    var sa=(a && a.spec)||'', sb=(b && b.spec)||'';
    var packRe=/(\d+\s*(?:个|只|支|卷|套|包|盒|箱|袋|片|张|米|cm|mm|寸|英寸)|\d+[*x×]\d+|[SsMLXL]{1,3})/g;
    var pa=(sa.match(packRe)||[]).map(function(s){return s.replace(/\s+/g,'')}), pb=(sb.match(packRe)||[]).map(function(s){return s.replace(/\s+/g,'')});
    var setA={}, setB={}; pa.forEach(function(x){setA[x]=1}); pb.forEach(function(x){setB[x]=1});
    var inter=0, uni=0; var keys={}; pa.forEach(function(x){keys[x]=1}); pb.forEach(function(x){keys[x]=1});
    Object.keys(keys).forEach(function(k){ var aHas=!!setA[k], bHas=!!setB[k]; if(aHas&&bHas) inter++; uni++; });
    var jacc=uni? inter/uni : 0;
    if (jacc < 0.25 && specScore < 0.40) {
      return {score:0, approved:false, stage:'SPEC_JACCARD_MISMATCH', titleScore:titleScore, specScore:specScore, lengthRatio:lengthRatio, familyConflict:false, modelConflict:false};
    }
  }
  // V21.0.41: 图片URL 域不一致时需更强标题证据
  if (a && b && a.title && b.title) {
    var imgA=(a.img||a.image||''), imgB=(b.img||b.image||'');
    if (imgA && imgB && String(imgA).slice(0,8)==='https://' && String(imgB).slice(0,8)==='https://') {
      var domA=String(imgA).split('/')[2]||'', domB=String(imgB).split('/')[2]||'';
      if (domA && domB && domA!==domB && titleScore < 0.96) {
        // 仅记录，不直接拒合，交后续阶段决定
      }
    }
  }
var lengthRatio = Math.min(t1.length, t2.length) / Math.max(t1.length, t2.length);
  var score = titleScore * 0.64 + specScore * 0.36;
  var stage = '';
  var approved = false;
  var rareEnough = !corpusStats || corpusStats.total < 20 || rareCore.distinctiveness >= 1.80;
  if (rareEnough && lengthRatio >= 0.38
      && ((rareCore.longest >= 4 && titleScore >= 0.44 && specScore >= 0.50)
        || (rareCore.longest >= 5 && rareCore.shared >= 6
          && rareCore.minCoverage >= 0.07 && titleScore >= 0.58))) {
    // Generic recall layer: a corpus-rare product core plus an independent
    // title/spec signal. This generalizes beyond a hand-maintained keyword list
    // without lowering the global fuzzy threshold.
    approved = true;
    stage = 'RARE_CORE';
    score = Math.max(score, 0.82 + titleScore * 0.12);
  } else if (lengthRatio >= 0.55 && specEvidence.strongLong && titleScore >= 0.68) {
    approved = true;
    stage = 'LONG_SPEC';
  } else if (lengthRatio >= 0.72 && titleScore >= 0.94
      && (!hasBothSpecs || specScore >= 0.18 || specEvidence.genericOnly)) {
    approved = true;
    stage = 'TITLE_HIGH';
  } else if (lengthRatio >= 0.60 && hasBothSpecs
      && !specEvidence.genericOnly && titleScore >= 0.82
      && specScore >= 0.38 && score >= 0.73) {
    approved = true;
    stage = 'TITLE_SPEC_VECTOR';
  }
  // V21.0.41: 边际区 0.88-0.94 不自动合，入待确认（宁可漏合不误合）
  if (!approved && titleScore >= 0.88 && titleScore < 0.94 && specScore >= 0.18 && lengthRatio >= 0.60) {
    return {score: (titleScore*0.64+specScore*0.36), approved:false, stage:'PENDING_REVIEW', titleScore:titleScore, specScore:specScore, lengthRatio:lengthRatio, pending:true};
  }
  // V20.12.62: FEATURE_MATCH — products with same type/function/target but different wording
  // Handles cases like "空调外机防晒罩" vs "空调遮阳板" where n-grams differ
  if (!approved) {
    var featSim = procurementFeatureSimilarity(a || {}, b || {});
    // V20.29.0: FEATURE_MATCH 需要最低标题证据门槛。
    // 修复误合并：游泳包(健身干湿分离袋) vs 真空压缩袋共享泛化核心名词"收纳袋"
    // 和泛规格"收纳包"，titleScore 仅 0.42 却通过 FEATURE_MATCH。
    // 标题证据不足的产品宁可保留独立行，也不冒险误合并。
    // V20.29.2: 中等标题分（0.50–0.58）需要规格证据支撑，
    // 防止"冰箱侧门收纳盒"(0.52) vs "磁吸置物架"（规格为纯颜色尺寸）误合并。
    if (featSim >= 0.45 && titleScore >= 0.50) {
      // Additional safety: check for family conflict (sub-type)
      var hasFamilyConflict = procurementFamilyConflict(a || {}, b || {});
      if (!hasFamilyConflict) {
        var titleEvidenceStrong = titleScore >= 0.58;
        var specEvidenceBridge = false;
        if (!titleEvidenceStrong) {
          var featSpecEv = enhancedSpecEvidence((a && a.spec) || '', (b && b.spec) || '');
          specEvidenceBridge = featSpecEv.score >= 0.30
            || specTokenOverlap((a && a.spec) || '', (b && b.spec) || '') > 0;
        }
        if (titleEvidenceStrong || specEvidenceBridge) {
          approved = true;
          stage = 'FEATURE_MATCH';
          score = Math.max(score, 0.75 + featSim * 0.2);
        }
      }
    }
  }
  // V20.12.62: Apply family conflict (sub-type) check to ALL stages
  var finalFamilyConflict = procurementFamilyConflict(a || {}, b || {});
  if (approved && finalFamilyConflict) {
    approved = false;
    stage = stage + '_BLOCKED_BY_SUBTYPE';
  }
  // V20.12.62: Multi-signal voting — require multiple signals to agree
  // Inspired by recordlinkage (1057⭐): single-signal merges are risky
  if (approved) {
    var votes = 0;
    var strongVotes = 0;
    // Signal 1: Title similarity
    if (titleScore >= 0.60) { votes++; strongVotes++; }
    else if (titleScore >= 0.45) { votes++; }
    // Signal 2: Spec similarity
    if (specScore >= 0.40) { votes++; strongVotes++; }
    else if (specScore >= 0.25) { votes++; }
    // Signal 3: Feature match (sub-type consistent)
    var featVote = procurementFeatureSimilarity(a || {}, b || {});
    if (featVote >= 0.30) { votes++; strongVotes++; }
    else if (featVote >= 0.15) { votes++; }
    // Signal 4: Rare core (already checked, count as 1 vote if stage is RARE_CORE)
    if (stage === 'RARE_CORE' || stage.indexOf('RARE_CORE') >= 0) { votes++; }
    // Voting rules:
    // - 2+ strong votes → approve
    // - 1 strong + 1 weak → approve
    // - 3+ weak votes → approve
    // - Otherwise → block (single weak signal is not enough)
    var needBlock = false;
    if (strongVotes >= 2) { /* OK */ }
    else if (strongVotes >= 1 && votes >= 2) { /* OK */ }
    else if (votes >= 3) { /* OK */ }
    else {
      needBlock = true;
    }
    if (needBlock) {
      approved = false;
      stage = stage + '_VETO_LOW_VOTES(' + votes + 'v/' + strongVotes + 's)';
    }
  }
  return {
    score:score,
    approved:approved,
    stage:stage,
    titleScore:titleScore,
    specScore:specScore,
    lengthRatio:lengthRatio,
    containment:containment,
    rareCore:rareCore,
    familyConflict:finalFamilyConflict,
    modelConflict:false,
    specEvidence:specEvidence
  };
}

function findSafeProcurementVectorMatch(source, candidates, corpusStats) {
  var ranked = [];
  var candidateList = candidates || [];
  var rareCorpusStats = corpusStats || buildProcurementCorpusStats(
    candidateList.concat([source])
  );
  var sourceLongSpecKeys = procurementInformativeSpecKeys((source && source.spec) || '');
  var repeatedLongSpec = false;
  if (sourceLongSpecKeys.length) {
    var longSpecCandidateCount = 0;
    candidateList.forEach(function(candidate) {
      var candidateKeys = procurementInformativeSpecKeys(candidate.spec || '');
      if (sourceLongSpecKeys.some(function(key) { return candidateKeys.indexOf(key) >= 0; })) {
        longSpecCandidateCount++;
      }
    });
    // This is a local term-frequency adjustment: a supposedly distinctive
    // long spec loses "strong evidence" status when it occurs in many product
    // candidates. Title evidence may still approve the pair independently.
    repeatedLongSpec = longSpecCandidateCount >= 3;
  }
  // V20.29.0: 预计算 source 规范化结果，避免每个候选重复计算
  var sourceTitleRaw = (source && source.title) || '';
  var sourceTitleNorm = norm(sourceTitleRaw);
  var sourceSpecNorm = (source && source.spec) || '';
  candidateList.forEach(function(candidate) {
    var sourceTitle = sourceTitleNorm;
    var candidateTitle = norm((candidate && candidate.title) || '');
    var cheapTitleOverlap = Math.max(
      diceSim(sourceTitle, candidateTitle),
      procurementTitleContainment(sourceTitle, candidateTitle)
    );
    var cheapSpec = enhancedSpecEvidence(
      sourceSpecNorm, (candidate && candidate.spec) || ''
    );
    // 优化: 增强品类冲突Blocking
    // V20.29.1: 核心名词一致时豁免（同 procurementVectorScore 逻辑），
    // 避免 extractProductType 泛化误触拦截同产品。
    var catConflict = enhancedCategoryConflict(
      sourceTitleRaw, sourceSpecNorm,
      (candidate && candidate.title) || '', (candidate && candidate.spec) || ''
    );
    if (catConflict) {
      var catNounA = extractCoreProductNoun(sourceTitleRaw);
      var catNounB = extractCoreProductNoun((candidate && candidate.title) || '');
      if (!(catNounA && catNounB && catNounA === catNounB)) return;
    }
    // 优化6: 核心产品名词冲突Blocking（更早拦截错误合并）
    var cheapCoreConflict = coreProductConflict(
      sourceTitleRaw, sourceSpecNorm,
      (candidate && candidate.title) || '', (candidate && candidate.spec) || ''
    );
    if (cheapCoreConflict.conflict) return;
    
    // 规格-标题一致性检查：防止不同产品的规格被混入
    var sourceConsistency = specTitleConsistencyCheck(
      sourceTitleRaw, sourceSpecNorm
    );
    var candidateConsistency = specTitleConsistencyCheck(
      (candidate && candidate.title) || '', (candidate && candidate.spec) || ''
    );
    // 如果候选者的规格中混入了与自己标题不同的产品类型，降低其优先级
    if (!candidateConsistency.consistent) {
      candidate._specMismatchPenalty = candidateConsistency.mismatches.length;
    }
    
    // Blocking avoids comparing unrelated products while retaining candidates
    // supported by either their title or an informative long specification.
    if (cheapTitleOverlap < 0.24 && !cheapSpec.strongLong && cheapSpec.score < 0.35) return;
    var comparison = procurementVectorScore(source, candidate, rareCorpusStats);
    if (comparison.approved && comparison.stage === 'LONG_SPEC' && repeatedLongSpec) {
      comparison.repeatedLongSpec = true;
      if (comparison.titleScore >= 0.92 && comparison.lengthRatio >= 0.72) {
        comparison.stage = 'TITLE_HIGH';
        comparison.score = Math.max(comparison.score, comparison.titleScore);
      } else {
        comparison.approved = false;
      }
    }
    if (comparison.approved) {
      ranked.push({candidate:candidate, comparison:comparison});
    }
  });
  ranked.sort(function(a, b) { return b.comparison.score - a.comparison.score; });
  if (!ranked.length) return null;
  var best = ranked[0];
  var runnerUp = ranked[1];
  // Ambiguous products stay separate. They can be reviewed later and converted
  // into a stable product mapping without risking the current purchase quantity.
  var requiredMargin = best.comparison.stage === 'LONG_SPEC' ? 0.03
      : (best.comparison.stage === 'TITLE_SPEC_VECTOR' ? 0.06
      : (best.comparison.stage === 'RARE_CORE' ? 0.08 : 0.04));
  if (runnerUp && best.comparison.score - runnerUp.comparison.score < requiredMargin) {
    return {ambiguous:true, best:best, runnerUp:runnerUp};
  }
  return {ambiguous:false, candidate:best.candidate, comparison:best.comparison};
}

// Architecture: 中转站 (source of truth) → 采购表 (purchasing workspace)
// Smart sync: detect 采购表 fields, only update system-managed fields, preserve purchaser data
function procurementPlatformContains(value, targetPlatform) {
  if (!targetPlatform) return true;
  return String(value || '').split(/[\n,]/).some(function(platform) {
    return platform.trim() === String(targetPlatform).trim();
  });
}

// ===== V20.29.0: 采购边界对账（移植自 V20.28.12 纯函数层，无 API 依赖） =====
// 评估结论：V20.28.x 的跨平台来源对账/fail-closed 是优化，匹配决策层是减弱。
// 这里只移植纯函数对账逻辑，不移植 V20.28.x 放宽的合并阈值。
function afternoonSpecText(value) {
  if (Array.isArray(value)) {
    return value.map(function(item) {
      return item && typeof item === 'object' ? (item.text || item.name || '') : item;
    }).join('');
  }
  if (value && typeof value === 'object') return String(value.text || value.name || '');
  return String(value || '');
}

function mergeProcurementPlatformSnapshot(existing, currentPlatform, currentSpec, fallbackPlatformSpecs) {
  existing = existing || {};
  currentPlatform = String(currentPlatform || '').trim();
  var platformSpecs = {};
  var rawPlatformSpecs = existing.platformSpecs;
  if (typeof rawPlatformSpecs === 'string' && rawPlatformSpecs.trim()) {
    try { rawPlatformSpecs = JSON.parse(rawPlatformSpecs); } catch (e) { rawPlatformSpecs = {}; }
  }
  if (rawPlatformSpecs && typeof rawPlatformSpecs === 'object'
      && !Array.isArray(rawPlatformSpecs)) {
    Object.keys(rawPlatformSpecs).forEach(function(platform) {
      var spec = String(rawPlatformSpecs[platform] || '').trim();
      if (platform && spec) platformSpecs[platform] = spec;
    });
  }

  var existingPlatforms = [], seenPlatforms = {};
  String(existing.platform || '').split(/[\n,]/).forEach(function(platform) {
    platform = platform.trim();
    if (platform && !seenPlatforms[platform]) {
      seenPlatforms[platform] = 1;
      existingPlatforms.push(platform);
    }
  });
  var actualPlatformKeys = function(map) {
    return Object.keys(map || {}).filter(function(platform) {
      return String(platform).indexOf('__') !== 0;
    });
  };
  var legacySpec = String(platformSpecs.__legacy__ || '').trim();
  var legacyPreserved = !!legacySpec;
  if (actualPlatformKeys(platformSpecs).length === 0 && existingPlatforms.length > 1
      && String(existing.spec || '').trim()) {
    var fallback = fallbackPlatformSpecs && typeof fallbackPlatformSpecs === 'object'
      ? fallbackPlatformSpecs : {};
    var fallbackComplete = existingPlatforms.every(function(platform) {
      return String(fallback[platform] || '').trim();
    });
    if (fallbackComplete) {
      existingPlatforms.forEach(function(platform) {
        platformSpecs[platform] = String(fallback[platform]).trim();
      });
    } else {
      // The old aggregate cannot be allocated to platforms without guessing.
      // Preserve it verbatim and allow the current platform branch to update.
      // This keeps purchaser-entered quantities intact and prevents one legacy
      // row from cancelling an otherwise valid afternoon snapshot.
      legacySpec = String(existing.spec || '').trim();
      platformSpecs.__legacy__ = legacySpec;
      legacyPreserved = true;
    }
  }
  if (actualPlatformKeys(platformSpecs).length === 0 && existingPlatforms.length === 1
      && String(existing.spec || '').trim()) {
    platformSpecs[existingPlatforms[0]] = String(existing.spec).trim();
  }

  if (currentPlatform) {
    var nextSpec = String(currentSpec || '').trim();
    if (nextSpec) platformSpecs[currentPlatform] = nextSpec;
    else delete platformSpecs[currentPlatform];
  }
  if (legacyPreserved && existingPlatforms.length > 0) {
    var availablePlatforms = actualPlatformKeys(platformSpecs);
    var allLegacyPlatformsAvailable = existingPlatforms.every(function(platform) {
      return availablePlatforms.indexOf(platform) >= 0
        && String(platformSpecs[platform] || '').trim();
    });
    if (allLegacyPlatformsAvailable) {
      delete platformSpecs.__legacy__;
      legacySpec = '';
      legacyPreserved = false;
    }
  }

  var orderedPlatforms = existingPlatforms.slice();
  Object.keys(platformSpecs).forEach(function(platform) {
    if (String(platform).indexOf('__') === 0) return;
    if (orderedPlatforms.indexOf(platform) < 0) orderedPlatforms.push(platform);
  });
  orderedPlatforms = orderedPlatforms.filter(function(platform) {
    return legacyPreserved || !!String(platformSpecs[platform] || '').trim();
  });

  var qtyByName = {}, order = [], rawLines = {};
  function appendSpecText(text) {
    String(text || '').split(/\n/).forEach(function(line) {
      line = line.replace(/；/g, ';').trim();
      if (!line) return;
      var parts = line.split(';');
      var last = parts.length > 1 ? parts[parts.length - 1].trim() : '';
      var name = parts.length > 1 ? parts.slice(0, -1).join(';').trim() : '';
      if (name && /^-?\d+(?:\.\d+)?$/.test(last)) {
        if (!Object.prototype.hasOwnProperty.call(qtyByName, name)) {
          qtyByName[name] = 0;
          order.push(name);
        }
        qtyByName[name] += Number(last) || 0;
      } else if (!rawLines[line]) {
        rawLines[line] = 1;
        order.push('__RAW__' + line);
      }
    });
  }
  if (legacyPreserved) {
    // Do not add the current branch to an opaque aggregate: its old quantity
    // may already include that platform. Keep the verified aggregate and the
    // precise branch separately instead of silently double-counting demand.
    appendSpecText(String(existing.spec || legacySpec).trim());
  } else {
    orderedPlatforms.forEach(function(platform) {
      appendSpecText(platformSpecs[platform]);
    });
  }
  var combinedSpec = order.map(function(key) {
    return key.indexOf('__RAW__') === 0 ? key.slice(7) : key + ';' + qtyByName[key];
  }).join('\n');
  var qty = order.reduce(function(sum, key) {
    return key.indexOf('__RAW__') === 0 ? sum : sum + (Number(qtyByName[key]) || 0);
  }, 0);
  return {
    unresolved:false,
    legacyPreserved:legacyPreserved,
    reason:legacyPreserved ? 'LEGACY_PLATFORM_SPECS_PARTIAL' : '',
    platform:orderedPlatforms.join('\n'),
    spec:combinedSpec,
    platformSpecs:platformSpecs,
    qty:qty
  };
}

function classifyCrossPlatformSource(platformValue, rawPlatformSpecs) {
  var platforms = String(platformValue || '').split(/[\n,]/).map(function(p) {
    return p.trim();
  }).filter(Boolean);
  if (platforms.length <= 1) {
    return {mixed:false, safelySplittable:true, platforms:platforms, platformSpecs:{}};
  }
  var allComplete = platforms.every(function(platform) {
    return /^[^\n,]+-【\d\d\d\d】$/.test(platform);
  });
  var parsedPlatformSpecs = null;
  try {
    parsedPlatformSpecs = typeof rawPlatformSpecs === 'object' && rawPlatformSpecs !== null
      ? rawPlatformSpecs
      : JSON.parse(afternoonSpecText(rawPlatformSpecs));
  } catch (e) {
    parsedPlatformSpecs = null;
  }
  var specKeys = parsedPlatformSpecs && typeof parsedPlatformSpecs === 'object'
    && !Array.isArray(parsedPlatformSpecs)
    ? Object.keys(parsedPlatformSpecs).filter(function(platform) {
        return String(platform).indexOf('__') !== 0;
      }) : [];
  var safelySplittable = allComplete
    && specKeys.length === platforms.length
    && platforms.every(function(platform) {
      return Object.prototype.hasOwnProperty.call(parsedPlatformSpecs, platform)
        && afternoonSpecText(parsedPlatformSpecs[platform]).trim();
    })
    && specKeys.every(function(platform) { return platforms.indexOf(platform) >= 0; });
  return {
    mixed:true,
    safelySplittable:safelySplittable,
    platforms:platforms,
    platformSpecs:safelySplittable ? parsedPlatformSpecs : {},
    reason:safelySplittable ? '' : 'LEGACY_CROSS_PLATFORM_UNSPLITTABLE'
  };
}

function buildProcurementPlatformGroupSnapshot(platformSpecs) {
  var result = {platform:'', spec:'', platformSpecs:{}};
  var source = platformSpecs && typeof platformSpecs === 'object' ? platformSpecs : {};
  Object.keys(source).forEach(function(platform) {
    var spec = String(source[platform] || '').trim();
    if (!platform || !spec) return;
    result = mergeProcurementPlatformSnapshot(result, platform, spec);
  });
  result.qty = procurementSpecQtyTotal(result.spec);
  return result;
}

// V20.29.0: 确保正式采购表存在"平台规格明细"字段（schema 同步，移植自 V20.28.12）
function ensureProcurementPlatformSpecsField(appToken, tableId, knownFields) {
  knownFields = knownFields || {};
  if (knownFields['平台规格明细']) return Promise.resolve(knownFields['平台规格明细']);
  return getToken().then(function(t) {
    return feishuProxy(
      'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken
        + '/tables/' + tableId + '/fields',
      'POST',
      {'Authorization':'Bearer '+t, 'Content-Type':'application/json'},
      JSON.stringify({field_name:'平台规格明细', type:1})
    );
  }).then(function(d) {
    if (d.code !== 0 || !d.data || !d.data.field) {
      throw new Error('创建平台规格明细字段失败: ' + ((d && d.msg) || (d && d.code) || 'unknown'));
    }
    return {id:d.data.field.field_id, type:1, name:'平台规格明细'};
  });
}

function reconcileProcurementSourcePlans(sourcePlans) {
  var plans = Array.isArray(sourcePlans) ? sourcePlans : [];
  var seenSources = {}, groups = {}, unmappedSourceIds = [], duplicateSourceIds = [];
  var qtyTotal = 0, mappedCount = 0;
  plans.forEach(function(plan, index) {
    plan = plan || {};
    var sourceId = String(plan.sourceId || plan.record_id || ('source-' + index)).trim();
    var targetId = String(plan.targetId || plan.procurementRecordId || '').trim();
    if (seenSources[sourceId]) duplicateSourceIds.push(sourceId);
    seenSources[sourceId] = 1;
    qtyTotal += Number(plan.qty || plan.quantity || 0) || 0;
    if (!targetId) {
      unmappedSourceIds.push(sourceId);
      return;
    }
    mappedCount++;
    groups[targetId] = (groups[targetId] || 0) + 1;
  });
  var sourceCount = plans.length;
  return {
    valid:unmappedSourceIds.length === 0 && duplicateSourceIds.length === 0,
    sourceCount:sourceCount,
    mappedCount:mappedCount,
    groupCount:Object.keys(groups).length,
    coalescedCount:Math.max(0, mappedCount - Object.keys(groups).length),
    unmappedSourceIds:unmappedSourceIds,
    duplicateSourceIds:duplicateSourceIds,
    qtyTotal:qtyTotal
  };
}

function selectIncrementalProcurementPlan(
  allUpdates, allCreates, unmatchedExisting, incrementalPlatform, platformField
) {
  if (!incrementalPlatform) {
    return {
      updates:(allUpdates || []).slice(),
      creates:(allCreates || []).slice(),
      unmatchedExisting:(unmatchedExisting || []).slice()
    };
  }
  return {
    updates:(allUpdates || []).filter(function(item) { return item.affected === true; }),
    creates:(allCreates || []).filter(function(item) { return item.affected === true; }),
    unmatchedExisting:(unmatchedExisting || []).filter(function(rec) {
      return procurementPlatformContains(
        ((rec && rec.fields) || {})[platformField], incrementalPlatform
      );
    })
  };
}

// === testMergeOnly: 中转站合并测试（只读，不写入采购表） ===
function testMergeOnly() {
  L('=== 中转站合并测试开始（只读模式） ===', 'i');
  L('⚠ 不会写入采购表，仅展示合并结果', 'i');
  
  // Step 1: 读取中转站全部数据
  L('读取中转站数据...', 'i');
  fetchAllRecordsForReturn().then(function(sourceRecords) {
    // 过滤今日数据
    var todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    var todayMs = todayStart.getTime();
    var tomorrowMs = todayMs + 86400000;
    var todayRecords = sourceRecords.filter(function(rec) {
      var f = rec.fields || {};
      var dateVal = f['🏗 【创建/绑定】日期'] || f['创建时间引导'] || f['创建时间'] || f['📅 抓取日期'];
      if (!dateVal) return false;
      var ts = typeof dateVal === 'number' ? dateVal : 0;
      if (ts === 0 && typeof dateVal === 'string') { var parsed = Date.parse(dateVal); if (!isNaN(parsed)) ts = parsed; }
      if (ts === 0) return false;
      return ts >= todayMs && ts < tomorrowMs;
    });
    
    L('中转站: 全部 ' + sourceRecords.length + ' 条 / 今日 ' + todayRecords.length + ' 条', 'i');
    
    if (todayRecords.length === 0) {
      L('今日无数据，测试结束', 'w');
      return;
    }
    
    // Step 2: 构建 corpus stats
    var sourceProfiles = todayRecords.map(function(rec) {
      var extracted = extractRecFields(rec);
      return {title: extracted.title, spec: extracted.spec};
    });
    var corpusStats = buildProcurementCorpusStats(sourceProfiles);
    
    // Step 3: 逐条匹配并分组
    var groups = []; // 每组是一个数组，包含 {rec, src, matchType, matchStage}
    var pidIndex = {}; // pid -> group index
    var titleIndex = {}; // normalized title -> group index
    // V20.29.0: 组级向量候选索引（与 mergeInPlace 一致，预览与实际合并结果相同）
    var groupCandidateIndex = {};
    function addGroupToCandidateIndex(gi, anchor) {
      var tokens = procurementBlockTokens((anchor && anchor.title) || '')
        .concat(procurementBlockTokens((anchor && anchor.spec) || ''));
      tokens.forEach(function(t) {
        if (!groupCandidateIndex[t]) groupCandidateIndex[t] = [];
        if (groupCandidateIndex[t].indexOf(gi) < 0) groupCandidateIndex[t].push(gi);
      });
    }
    
    var stats = {
      total: todayRecords.length,
      pidMatches: 0,
      titleExactMatches: 0,
      vectorMatches: 0,
      vectorBlocked: 0,
      newGroups: 0,
      ambiguousVectors: 0,
      vectorStages: {},
      suspiciousMerges: [] // 标记可能有问题的合并
    };
    
    todayRecords.forEach(function(rec, idx) {
      var src = extractRecFields(rec);
      var matchType = '';
      var matchStage = '';
      var targetGroupIdx = -1;
      
      // PID 匹配
      if (src.pid) {
        var pids = String(src.pid).split(/[,，\n]/).map(function(p) { return p.trim(); }).filter(Boolean);
        for (var i = 0; i < pids.length; i++) {
          if (pidIndex[pids[i]] !== undefined) {
            targetGroupIdx = pidIndex[pids[i]];
            matchType = 'PID';
            matchStage = 'PID_EXACT';
            stats.pidMatches++;
            break;
          }
        }
      }
      
      // 标题精确匹配
      if (targetGroupIdx < 0) {
        var titleKey = norm(src.title || '');
        if (titleKey && titleIndex[titleKey] !== undefined) {
          targetGroupIdx = titleIndex[titleKey];
          matchType = 'TITLE';
          matchStage = 'TITLE_EXACT';
          stats.titleExactMatches++;
        }
      }
      
      // 向量模糊匹配（V20.29.0: 阻断索引召回候选，结果与全量比较一致）
      if (targetGroupIdx < 0) {
        var allCandidates = groups.map(function(g, gi) {
          var anchor = g.anchor || {};
          return {
            title: anchor.title || '',
            spec: anchor.spec || '',
            _groupIdx: gi
          };
        });
        var candidates = selectVectorCandidatesByIndex(src, groupCandidateIndex, allCandidates);
        
        var vectorDecision = findSafeProcurementVectorMatch(src, candidates, corpusStats);
        if (vectorDecision && !vectorDecision.ambiguous) {
          targetGroupIdx = vectorDecision.candidate._groupIdx;
          matchType = 'VECTOR';
          matchStage = vectorDecision.comparison ? vectorDecision.comparison.stage : 'VECTOR';
          stats.vectorMatches++;
          stats.vectorStages[matchStage] = (stats.vectorStages[matchStage] || 0) + 1;
        } else if (vectorDecision && vectorDecision.ambiguous) {
          stats.ambiguousVectors++;
          matchType = 'AMBIGUOUS';
        } else {
          stats.vectorBlocked++;
        }
      }
      
      // 分配到组
      if (targetGroupIdx >= 0) {
        groups[targetGroupIdx].records.push({
          rec: rec,
          src: src,
          matchType: matchType,
          matchStage: matchStage
        });
        // 更新索引
        if (src.pid) {
          var pids2 = String(src.pid).split(/[,，\n]/).map(function(p) { return p.trim(); }).filter(Boolean);
          pids2.forEach(function(pid) { pidIndex[pid] = targetGroupIdx; });
        }
        var titleKey2 = norm(src.title || '');
        if (titleKey2) titleIndex[titleKey2] = targetGroupIdx;
        
        // 检查可疑合并
        var anchor = groups[targetGroupIdx].anchor || {};
        if (anchor.title && src.title) {
          var familyCheck = procurementFamilyConflict(anchor, src);
          var subTypeA = procurementSubType(anchor);
          var subTypeB = procurementSubType(src);
          if (familyCheck) {
            stats.suspiciousMerges.push({
              groupIdx: targetGroupIdx,
              anchorTitle: anchor.title,
              newTitle: src.title,
              anchorSpec: anchor.spec || '',
              newSpec: src.spec || '',
              reason: 'FAMILY_CONFLICT',
              subTypeA: Object.keys(subTypeA).join(','),
              subTypeB: Object.keys(subTypeB).join(',')
            });
          }
        }
      } else {
        // 新建组
        stats.newGroups++;
        var newGroup = {
          anchor: {title: src.title || '', spec: src.spec || ''},
          records: [{
            rec: rec,
            src: src,
            matchType: 'NEW',
            matchStage: 'NEW'
          }]
        };
        groups.push(newGroup);
        var gi = groups.length - 1;
        addGroupToCandidateIndex(gi, {title: src.title || '', spec: src.spec || ''});
        if (src.pid) {
          var pids3 = String(src.pid).split(/[,，\n]/).map(function(p) { return p.trim(); }).filter(Boolean);
          pids3.forEach(function(pid) { pidIndex[pid] = gi; });
        }
        var titleKey3 = norm(src.title || '');
        if (titleKey3) titleIndex[titleKey3] = gi;
      }
    });
    
    // Step 4: 输出报告
    var mergeRate = ((stats.total - stats.newGroups) / stats.total * 100).toFixed(1);
    L('=== 合并测试报告 ===', 'i');
    L('总记录数: ' + stats.total, 'i');
    L('合并后组数: ' + groups.length, 'i');
    L('合并率: ' + mergeRate + '%', 'i');
    L('PID精确匹配: ' + stats.pidMatches + ' 条', 'i');
    L('标题精确匹配: ' + stats.titleExactMatches + ' 条', 'i');
    L('向量模糊匹配: ' + stats.vectorMatches + ' 条', 'i');
    L('向量歧义保留: ' + stats.ambiguousVectors + ' 条', 'i');
    L('新建组: ' + stats.newGroups + ' 条', 'i');
    
    if (Object.keys(stats.vectorStages).length > 0) {
      L('向量匹配阶段分布:', 'i');
      Object.keys(stats.vectorStages).forEach(function(stage) {
        L('  ' + stage + ': ' + stats.vectorStages[stage], 'i');
      });
    }
    
    // 输出可疑合并
    if (stats.suspiciousMerges.length > 0) {
      L('⚠ 可疑合并: ' + stats.suspiciousMerges.length + ' 个', 'w');
      stats.suspiciousMerges.forEach(function(sm, idx) {
        L('  [' + (idx+1) + '] ' + sm.reason, 'w');
        L('    锚点: ' + sm.anchorTitle, 'w');
        L('    新增: ' + sm.newTitle, 'w');
        L('    子类型A: ' + (sm.subTypeA || '无'), 'w');
        L('    子类型B: ' + (sm.subTypeB || '无'), 'w');
      });
    } else {
      L('✓ 无可疑合并', 's');
    }
    
    // 输出每组详情
    L('=== 分组详情 ===', 'i');
    groups.forEach(function(g, gi) {
      var anchor = g.anchor || {};
      var platformDist = {};
      g.records.forEach(function(item) {
        var plat = item.src.platform || '未知';
        platformDist[plat] = (platformDist[plat] || 0) + 1;
      });
      var platStr = Object.keys(platformDist).map(function(p) { return p + ':' + platformDist[p]; }).join(', ');
      L('[' + (gi+1) + '] ' + anchor.title + ' (' + g.records.length + '条, ' + platStr + ')', 'i');
      // 显示前3条的规格
      g.records.slice(0, 3).forEach(function(item) {
        var specPreview = (item.src.spec || '').substring(0, 60);
        L('    ' + item.matchType + '|' + item.matchStage + ': ' + specPreview, 'i');
      });
      if (g.records.length > 3) {
        L('    ... 还有 ' + (g.records.length - 3) + ' 条', 'i');
      }
    });
    
    L('=== 合并测试完成（未写入采购表） ===', 's');
  }).catch(function(err) {
    L('合并测试失败: ' + (err.message || err), 'e');
  });
}
// === checkMergeResults: 检查合并后的中转站数据 ===
function checkMergeResults() {
  L('=== 合并结果检查 ===', 'i');
  
  fetchAllRecordsForReturn().then(function(sourceRecords) {
    var todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    var todayMs = todayStart.getTime();
    var tomorrowMs = todayMs + 86400000;
    var todayRecords = sourceRecords.filter(function(rec) {
      var f = rec.fields || {};
      var dateVal = f['🏗 【创建/绑定】日期'] || f['创建时间引导'] || f['创建时间'] || f['📅 抓取日期'];
      if (!dateVal) return false;
      var ts = typeof dateVal === 'number' ? dateVal : 0;
      if (ts === 0 && typeof dateVal === 'string') { var parsed = Date.parse(dateVal); if (!isNaN(parsed)) ts = parsed; }
      if (ts === 0) return false;
      return ts >= todayMs && ts < tomorrowMs;
    });
    
    L('今日记录: ' + todayRecords.length + ' 条', 'i');
    
    // 检查各项指标
    var stats = {
      total: todayRecords.length,
      withTitle: 0,
      withPid: 0,
      withSpec: 0,
      withImg: 0,
      withAttach: 0,
      withPlatform: 0,
      multiPlatform: 0,
      emptySpec: 0,
      singleLineSpec: 0,
      multiLineSpec: 0,
      platformDist: {}
    };
    
    todayRecords.forEach(function(rec) {
      var src = extractRecFields(rec);
      var f = rec.fields || {};
      
      if (src.title) stats.withTitle++;
      if (src.pid) stats.withPid++;
      if (src.spec && src.spec.trim()) {
        stats.withSpec++;
        var lines = src.spec.split('\n').filter(function(l) { return l.trim(); });
        if (lines.length === 1) stats.singleLineSpec++;
        else if (lines.length > 1) stats.multiLineSpec++;
      } else {
        stats.emptySpec++;
      }
      if (src.img) stats.withImg++;
      if (src.platform) {
        stats.withPlatform++;
        var platforms = src.platform.split('\n').filter(Boolean);
        if (platforms.length > 1) stats.multiPlatform++;
        platforms.forEach(function(p) {
          stats.platformDist[p] = (stats.platformDist[p] || 0) + 1;
        });
      }
      
      // 检查附件
      var attachField = f['📠 产品图'] || f['产品图'];
      if (Array.isArray(attachField) && attachField.length > 0) stats.withAttach++;
    });
    
    L('=== 数据质量报告 ===', 'i');
    L('总记录: ' + stats.total, 'i');
    L('有标题: ' + stats.withTitle + ' (' + (stats.withTitle/stats.total*100).toFixed(1) + '%)', 'i');
    L('有商品ID: ' + stats.withPid + ' (' + (stats.withPid/stats.total*100).toFixed(1) + '%)', 'i');
    L('有规格: ' + stats.withSpec + ' (' + (stats.withSpec/stats.total*100).toFixed(1) + '%)', 'i');
    L('  空规格: ' + stats.emptySpec, 'i');
    L('  单行规格: ' + stats.singleLineSpec, 'i');
    L('  多行规格: ' + stats.multiLineSpec, 'i');
    L('有图片URL: ' + stats.withImg + ' (' + (stats.withImg/stats.total*100).toFixed(1) + '%)', 'i');
    L('有附件: ' + stats.withAttach + ' (' + (stats.withAttach/stats.total*100).toFixed(1) + '%)', 'i');
    L('有平台: ' + stats.withPlatform + ' (' + (stats.withPlatform/stats.total*100).toFixed(1) + '%)', 'i');
    L('多平台合并: ' + stats.multiPlatform + ' 条', 'i');
    
    L('=== 平台分布 ===', 'i');
    Object.keys(stats.platformDist).sort().forEach(function(p) {
      L('  ' + p + ': ' + stats.platformDist[p], 'i');
    });
    
    // 检查可疑合并（同组内有不同平台但标题相同）
    L('=== 检查可疑合并 ===', 'i');
    var suspicious = [];
    todayRecords.forEach(function(rec) {
      var src = extractRecFields(rec);
      if (src.platform) {
        var platforms = src.platform.split('\n').filter(Boolean);
        if (platforms.length >= 2) {
          // 检查是否真的是同一产品
          suspicious.push({
            title: src.title,
            platforms: platforms,
            specLines: src.spec ? src.spec.split('\n').length : 0
          });
        }
      }
    });
    
    if (suspicious.length > 0) {
      L('多平台合并记录: ' + suspicious.length + ' 条', 'i');
      suspicious.slice(0, 5).forEach(function(s, idx) {
        L('  [' + (idx+1) + '] ' + s.title + ' (' + s.platforms.join(', ') + ')', 'i');
      });
      if (suspicious.length > 5) L('  ... 还有 ' + (suspicious.length - 5) + ' 条', 'i');
    } else {
      L('无多平台合并记录', 'i');
    }
    
    L('=== 检查完成 ===', 's');
  }).catch(function(err) {
    L('检查失败: ' + (err.message || err), 'e');
  });
}
// === mergeInPlace: 中转站原地合并覆盖 ===
// 读取今日中转站数据 → 分组合并 → 删除旧记录 → 写入合并后的新记录
function mergeInPlace() {
  L('=== 中转站原地合并覆盖 ===', 'i');
  L('⚠ 将删除今日旧记录并写入合并后的新记录', 'w');
  
  invalidateDataCache(typeof TT !== 'undefined' ? TT : RAW_TABLE);
  
  return new Promise(function(resolve) {
    fetchAllRecordsForReturn().then(function(sourceRecords) {
      // 过滤今日数据
      var todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      var todayMs = todayStart.getTime();
      var tomorrowMs = todayMs + 86400000;
      var todayRecords = sourceRecords.filter(function(rec) {
        var f = rec.fields || {};
        var dateVal = f['🏗 【创建/绑定】日期'] || f['创建时间引导'] || f['创建时间'] || f['📅 抓取日期'];
        if (!dateVal) return false;
        var ts = typeof dateVal === 'number' ? dateVal : 0;
        if (ts === 0 && typeof dateVal === 'string') { var parsed = Date.parse(dateVal); if (!isNaN(parsed)) ts = parsed; }
        if (ts === 0) return false;
        return ts >= todayMs && ts < tomorrowMs;
      });
      
      L('中转站: 全部 ' + sourceRecords.length + ' 条 / 今日 ' + todayRecords.length + ' 条', 'i');
      
      if (todayRecords.length === 0) {
        L('今日无数据，合并结束', 'w');
        resolve({ok:true, merged:0, created:0, deleted:0});
        return;
      }
      
      // Step 2: 构建 corpus stats
      var sourceProfiles = todayRecords.map(function(rec) {
        var extracted = extractRecFields(rec);
        return {title: extracted.title, spec: extracted.spec};
      });
      var corpusStats = buildProcurementCorpusStats(sourceProfiles);
      
      // Step 3: 逐条匹配并分组
      var groups = [];
      var pidIndex = {};
      var titleIndex = {};
      var stats = { total: todayRecords.length, pidMatches:0, titleExact:0, vectorMatches:0, newGroups:0, ambiguousVectors:0 };
      // V20.29.0: 组级向量候选索引（增量维护，仅用于召回候选，不改合并结果）
      var groupCandidateIndex = {};
      function addGroupToCandidateIndex(gi, anchor) {
        var tokens = procurementBlockTokens((anchor && anchor.title) || '')
          .concat(procurementBlockTokens((anchor && anchor.spec) || ''));
        tokens.forEach(function(t) {
          if (!groupCandidateIndex[t]) groupCandidateIndex[t] = [];
          if (groupCandidateIndex[t].indexOf(gi) < 0) groupCandidateIndex[t].push(gi);
        });
      }
      
      todayRecords.forEach(function(rec) {
        var src = extractRecFields(rec);
        var targetGroupIdx = -1;
        
        // PID 匹配
        if (src.pid) {
          var pids = String(src.pid).split(/[,，\n]/).map(function(p){return p.trim();}).filter(Boolean);
          for (var i = 0; i < pids.length; i++) {
            if (pidIndex[pids[i]] !== undefined) { targetGroupIdx = pidIndex[pids[i]]; stats.pidMatches++; break; }
          }
        }
        // 标题精确匹配
        if (targetGroupIdx < 0) {
          var titleKey = norm(src.title || '');
          if (titleKey && titleIndex[titleKey] !== undefined) { targetGroupIdx = titleIndex[titleKey]; stats.titleExact++; }
        }
        // V20.29.0: PID/标题命中但严格证据不足 → 保留独立记录（防误合并）
        if (targetGroupIdx >= 0 && !canJoinMergeInPlaceGroup(src, groups[targetGroupIdx])) {
          L('[合并阻断] PID/标题命中但规格联合证据不足，保留独立记录: ' + (src.title || '').substring(0, 30), 'w');
          targetGroupIdx = -1;
        }
        // 向量模糊匹配（V20.29.0: 阻断索引召回候选，结果与全量比较一致）
        if (targetGroupIdx < 0) {
          var allCandidates = groups.map(function(g, gi) {
            return { title: g.anchor.title, spec: g.anchor.spec, _groupIdx: gi };
          });
          var candidates = selectVectorCandidatesByIndex(src, groupCandidateIndex, allCandidates);
          var vectorDecision = findSafeProcurementVectorMatch(src, candidates, corpusStats);
          if (vectorDecision && !vectorDecision.ambiguous) {
            var vectorGroupIdx = vectorDecision.candidate._groupIdx;
            if (canJoinMergeInPlaceGroup(src, groups[vectorGroupIdx])) {
              targetGroupIdx = vectorGroupIdx;
              stats.vectorMatches++;
            } else {
              L('[合并阻断] 向量候选规格覆盖不足，保留独立记录: ' + (src.title || '').substring(0, 30), 'w');
            }
          } else if (vectorDecision && vectorDecision.ambiguous) {
            stats.ambiguousVectors++;
          }
        }
        
        if (targetGroupIdx >= 0) {
          groups[targetGroupIdx].records.push(rec);
          groups[targetGroupIdx].specs.push(src.spec || '');
          groups[targetGroupIdx].pids.push(src.pid || '');
          groups[targetGroupIdx].platformSpecs.push(src.platformSpecs || '');
          groups[targetGroupIdx].platforms.push(src.platform || '');
          groups[targetGroupIdx].statuses.push(src.status || '未打单');
          groups[targetGroupIdx].imgs.push(src.img || '');
          if (src.pid) {
            String(src.pid).split(/[,，\n]/).map(function(p){return p.trim();}).filter(Boolean).forEach(function(pid){ pidIndex[pid] = targetGroupIdx; });
          }
          var tk = norm(src.title || '');
          if (tk) titleIndex[tk] = targetGroupIdx;
        } else {
          stats.newGroups++;
          var newGroup = {
            anchor: {title: src.title || '', spec: src.spec || ''},
            records: [rec],
            platformSpecs: [src.platformSpecs || ''],
            specs: [src.spec || ''],
            pids: [src.pid || ''],
            platforms: [src.platform || ''],
            statuses: [src.status || '未打单'],
            imgs: [src.img || ''],
            recordIds: [rec.record_id]
          };
          groups.push(newGroup);
          var gi = groups.length - 1;
          addGroupToCandidateIndex(gi, {title: src.title || '', spec: src.spec || ''});
          if (src.pid) {
            String(src.pid).split(/[,，\n]/).map(function(p){return p.trim();}).filter(Boolean).forEach(function(pid){ pidIndex[pid] = gi; });
          }
          var tk2 = norm(src.title || '');
          if (tk2) titleIndex[tk2] = gi;
        }
      });
      
      // Step 4: 构建合并后的记录（在detectTableFields回调中处理）
      var mergedRecords = [];
      
      // 合并统计（在detectTableFields之前计算）
      var mergeRate = ((todayRecords.length - groups.length) / todayRecords.length * 100).toFixed(1);
      L('预估合并结果: ' + todayRecords.length + ' 条 → ' + groups.length + ' 组 (合并率 ' + mergeRate + '%)', 'i');
      L('PID匹配: ' + stats.pidMatches + ' | 标题精确: ' + stats.titleExact + ' | 向量匹配: ' + stats.vectorMatches + ' | 歧义保留: ' + stats.ambiguousVectors, 'i');
      
      // Step 4.5: 检测中转站字段类型，用于格式化写入
      var transferFieldMap = {};
      detectTableFields(typeof AT !== 'undefined' ? AT : 'DptPbPEluaupDjsp2XZcFK56nte', typeof TT !== 'undefined' ? TT : 'tblQy4Ugplc6n9E4').then(function(fm) {
        transferFieldMap = fm;
        L('中转站字段类型检测完成: ' + Object.keys(fm).length + ' 个字段', 'i');
        
        // 解析实际字段名
        var TITLE_FIELD = resolveField(transferFieldMap, ['📡 商品全称', '商品全称', '商品标题']);
        var PID_FIELD = resolveField(transferFieldMap, ['商品 🆔', '🔗 商品ID', '商品ID']);
        var SPEC_FIELD = resolveField(transferFieldMap, ['🚧 ❗【时段】产品需求值', '❗【时段】产品需求值', '产品需求值']);
        var PLAT_FIELD = resolveField(transferFieldMap, ['平台【文字】', '平台所属账号', '平台']);
        var STATUS_FIELD = resolveField(transferFieldMap, ['🚃 状态🌅', '手动传输状态', '状态']);
        var DATE_FIELD = resolveField(transferFieldMap, ['🏗 【创建/绑定】日期', '创建时间引导', '创建时间']);
        var IMG_FIELD = resolveField(transferFieldMap, ['🖼 产品图URL', '图片URL', '【图片URL】']);
        
        L('字段映射: T=' + (TITLE_FIELD||'?') + ' P=' + (PID_FIELD||'?') + ' S=' + (SPEC_FIELD||'?') + ' IMG=' + (IMG_FIELD||'?'), 'i');
        
        // 构建合并记录（使用检测到的字段名）
        // 检测附件字段
        var ATTACH_FIELD = resolveField(transferFieldMap, ['📠 产品图', '产品图', '产品图URL']);
        L('附件字段: ' + (ATTACH_FIELD || '未找到'), 'i');
        var PSPEC_FIELD = resolveField(transferFieldMap, ['平台规格明细']);
        L('平台规格明细字段: ' + (PSPEC_FIELD || '未找到'), 'i');
        
        groups.forEach(function(g) {
          // 合并规格：使用 mergeProcurementSpecLines 保留数量累加
          var mergedSpec = '';
          g.specs.forEach(function(s) {
            if (s && s.trim()) {
              mergedSpec = mergeProcurementSpecLines(mergedSpec, s);
            }
          });
          
          // 合并PID
          var allPids = [];
          g.pids.forEach(function(p) {
            if (p) String(p).split(/[,，\n]/).forEach(function(pid) {
              pid = pid.trim();
              if (pid && allPids.indexOf(pid) < 0) allPids.push(pid);
            });
          });
          var mergedPid = allPids.join(', ');
          
          // 合并平台
          var allPlatforms = [];
          g.platforms.forEach(function(p) {
            if (p && allPlatforms.indexOf(p) < 0) allPlatforms.push(p);
          });
          var mergedPlatform = allPlatforms.join('\n');
          
          
          // V20.16.0: 构建platformSpecs字段
          var mergedPlatformSpecs = {};
          g.platforms.forEach(function(p, pi) {
            if (p) {
              var specs = g.platformSpecs && g.platformSpecs[pi] ? g.platformSpecs[pi] : '';
              if (specs) {
                try {
                  var parsed = JSON.parse(specs);
                  Object.keys(parsed).forEach(function(k) {
                    if (!mergedPlatformSpecs[k]) mergedPlatformSpecs[k] = parsed[k];
                    else mergedPlatformSpecs[k] = mergeProcurementSpecLines(mergedPlatformSpecs[k], parsed[k]);
                  });
                } catch(e) {
                  // 非JSON格式，直接按平台存储
                  if (!mergedPlatformSpecs[p]) mergedPlatformSpecs[p] = specs;
                  else mergedPlatformSpecs[p] = mergeProcurementSpecLines(mergedPlatformSpecs[p], specs);
                }
              } else {
                // 没有platformSpecs，使用specs
                var spec = g.specs && g.specs[pi] ? g.specs[pi] : '';
                if (spec && !mergedPlatformSpecs[p]) mergedPlatformSpecs[p] = spec;
              }
            }
          });
          var mergedPlatformSpecsStr = Object.keys(mergedPlatformSpecs).length > 0 ? JSON.stringify(mergedPlatformSpecs) : '';
          // 状态
          var mergedStatus = '未打单';
          g.statuses.forEach(function(s) { if (s === '已打单') mergedStatus = '已打单'; });
          
          // 图片
          var mergedImg = '';
          g.imgs.forEach(function(img) { if (!mergedImg && img && img.indexOf('http') === 0) mergedImg = img; });
          
          // 日期
          var earliestDate = Date.now();
          g.records.forEach(function(rec) {
            var f = rec.fields || {};
            var dv = f['🏗 【创建/绑定】日期'] || f['创建时间引导'] || f['创建时间'];
            if (dv) {
              var ts = typeof dv === 'number' ? dv : (typeof dv === 'string' ? Date.parse(dv) : 0);
              if (ts > 0 && ts < earliestDate) earliestDate = ts;
            }
          });
          
          // 构建字段对象
          var recFields = {};
          if (TITLE_FIELD) recFields[TITLE_FIELD] = g.anchor.title;
          if (PID_FIELD) recFields[PID_FIELD] = mergedPid;
          if (SPEC_FIELD) recFields[SPEC_FIELD] = mergedSpec;
          if (PLAT_FIELD) recFields[PLAT_FIELD] = mergedPlatform;
          if (PSPEC_FIELD && mergedPlatformSpecsStr) recFields[PSPEC_FIELD] = mergedPlatformSpecsStr;
          if (STATUS_FIELD) recFields[STATUS_FIELD] = mergedStatus;
          if (IMG_FIELD && mergedImg) recFields[IMG_FIELD] = {link: mergedImg, text: mergedImg};
          if (DATE_FIELD) recFields[DATE_FIELD] = earliestDate;
          // 附件：取第一个有效的 file_token
          if (ATTACH_FIELD) {
            var attachVal = null;
            for (var ai = 0; ai < g.records.length; ai++) {
              var af = g.records[ai].fields || {};
              var av = af[ATTACH_FIELD];
              if (Array.isArray(av) && av.length > 0 && av[0] && av[0].file_token) {
                attachVal = av;
                break;
              }
            }
            if (attachVal) recFields[ATTACH_FIELD] = attachVal;
          }
          
          mergedRecords.push({
            fields: recFields,
            sourceCount: g.records.length,
            recordIds: g.records.map(function(r){return r.record_id;})
          });
        });
        
        // === 优化7: 合并后复检 (mergeInPlace) ===
        var mergeInPlaceGroups = mergedRecords.map(function(mr) {
          return {
            title: (mr.fields && mr.fields[TITLE_FIELD]) || '',
            mergedSpec: (mr.fields && mr.fields[SPEC_FIELD]) || '',
            originalSpecs: [],
            recordId: 'mergeInPlace',
            matchType: 'MERGE_IN_PLACE'
          };
        });
        var mergeInPlaceReport = null;
        var mipSummary = {total:0, blocked:0, warned:0, passed:0};
        if (typeof batchPostMergeVerify === 'function') {
          mergeInPlaceReport = batchPostMergeVerify(mergeInPlaceGroups);
          mipSummary = mergeInPlaceReport.summary;
        } else {
          L('[复检] mergeInPlace 跳过复检（函数未定义）', 'w');
        }
        
        if (mergeInPlaceReport && (mipSummary.blocked > 0 || mipSummary.warned > 0)) {
          L('[复检] 合并后复检: ' + mipSummary.total + ' 组', 'i');
          L('  ✓ 通过: ' + mipSummary.passed + ' | ⚠ 警告: ' + mipSummary.warned + ' | ✗ 阻断: ' + mipSummary.blocked,
            mipSummary.blocked > 0 ? 'w' : 'i');
          
          mergeInPlaceReport.results.forEach(function(r) {
            if (r.result.severity !== 'ok') {
              r.result.issues.forEach(function(issue) {
                L('  [' + issue.level.toUpperCase() + '] ' + r.group.title.substring(0, 30) + ': ' + issue.message,
                  issue.level === 'block' ? 'w' : 'i');
              });
            }
          });
          
          // 移除被阻断的记录
          if (mipSummary.blocked > 0) {
            var origLen = mergedRecords.length;
            var blockedTitles = {};
            mergeInPlaceReport.results.forEach(function(r) {
              if (r.result.severity === 'block') {
                blockedTitles[r.group.title] = true;
              }
            });
            mergedRecords = mergedRecords.filter(function(mr) {
              var t = (mr.fields && mr.fields[TITLE_FIELD]) || '';
              return !blockedTitles[t];
            });
            L('[复检] 移除阻断记录: ' + (origLen - mergedRecords.length) + ' 条', 'w');
          }
        } else {
          L('[复检] ✓ 全部通过 (' + mipSummary.total + ' 组)', 'i');
        }
        
        proceedWithDeleteAndWrite();
      }).catch(function(e) {
        L('字段类型检测失败，使用默认格式: ' + e.message, 'w');
        // Fallback: use hardcoded field names
        groups.forEach(function(g) {
          var mergedSpec = '';
          g.specs.forEach(function(s) {
            if (s && s.trim()) {
              mergedSpec = mergeProcurementSpecLines(mergedSpec, s);
            }
          });
          var allPids = [];
          g.pids.forEach(function(p) {
            if (p) String(p).split(/[,，\n]/).forEach(function(pid) {
              pid = pid.trim();
              if (pid && allPids.indexOf(pid) < 0) allPids.push(pid);
            });
          });
          var mergedPid = allPids.join(', ');
          var allPlatforms = [];
          g.platforms.forEach(function(p) {
            if (p && allPlatforms.indexOf(p) < 0) allPlatforms.push(p);
          });
          var mergedPlatform = allPlatforms.join('\n');
          var mergedStatus = '未打单';
          g.statuses.forEach(function(s) { if (s === '已打单') mergedStatus = '已打单'; });
          var mergedImg = '';
          g.imgs.forEach(function(img) { if (!mergedImg && img && img.indexOf('http') === 0) mergedImg = img; });
          var earliestDate = Date.now();
          g.records.forEach(function(rec) {
            var f = rec.fields || {};
            var dv = f['🏗 【创建/绑定】日期'] || f['创建时间引导'] || f['创建时间'];
            if (dv) {
              var ts = typeof dv === 'number' ? dv : (typeof dv === 'string' ? Date.parse(dv) : 0);
              if (ts > 0 && ts < earliestDate) earliestDate = ts;
            }
          });
          // V20.16.0: 构建platformSpecs字段(fallback)
          var mergedPlatformSpecs = {};
          g.platforms.forEach(function(p, pi) {
            if (p) {
              var specs = g.platformSpecs && g.platformSpecs[pi] ? g.platformSpecs[pi] : '';
              if (specs) {
                try {
                  var parsed = JSON.parse(specs);
                  Object.keys(parsed).forEach(function(k) {
                    if (!mergedPlatformSpecs[k]) mergedPlatformSpecs[k] = parsed[k];
                    else mergedPlatformSpecs[k] = mergeProcurementSpecLines(mergedPlatformSpecs[k], parsed[k]);
                  });
                } catch(e) {
                  if (!mergedPlatformSpecs[p]) mergedPlatformSpecs[p] = specs;
                  else mergedPlatformSpecs[p] = mergeProcurementSpecLines(mergedPlatformSpecs[p], specs);
                }
              } else {
                var spec = g.specs && g.specs[pi] ? g.specs[pi] : '';
                if (spec && !mergedPlatformSpecs[p]) mergedPlatformSpecs[p] = spec;
              }
            }
          });
          var mergedPlatformSpecsStr = Object.keys(mergedPlatformSpecs).length > 0 ? JSON.stringify(mergedPlatformSpecs) : '';
          var fallbackFields = {
              '📡 商品全称': g.anchor.title,
              '商品 🆔': mergedPid,
              '🚧 ❗【时段】产品需求值': mergedSpec,
              '平台【文字】': mergedPlatform,
              '平台规格明细': mergedPlatformSpecsStr,
              '🚃 状态🌅': mergedStatus,
              '图片URL': mergedImg ? {link: mergedImg, text: mergedImg} : '',
              '🏗 【创建/绑定】日期': earliestDate
          };
          // 附件：取第一个有效的 file_token
          for (var fi = 0; fi < g.records.length; fi++) {
            var ff = g.records[fi].fields || {};
            var fv = ff['📠 产品图'];
            if (Array.isArray(fv) && fv.length > 0 && fv[0] && fv[0].file_token) {
              fallbackFields['📠 产品图'] = fv;
              break;
            }
          }
          mergedRecords.push({
            fields: fallbackFields,
            sourceCount: g.records.length,
            recordIds: g.records.map(function(r){return r.record_id;})
          });
        });
        proceedWithDeleteAndWrite();
      });
      
      function proceedWithDeleteAndWrite() {
      // Step 5: 删除今日旧记录
      var allRecordIds = [];
      todayRecords.forEach(function(rec) { allRecordIds.push(rec.record_id); });
      
      L('开始删除 ' + allRecordIds.length + ' 条旧记录...', 'i');
      var deleteBatches = [];
      for (var di = 0; di < allRecordIds.length; di += 100) {
        deleteBatches.push(allRecordIds.slice(di, di + 100));
      }
      
      var deletedCount = 0;
      function deleteBatch(idx) {
        if (idx >= deleteBatches.length) {
          L('旧记录删除完成: ' + deletedCount + ' 条', 'i');
          // Step 6: 写入合并后的记录
          writeMergedRecords(mergedRecords, 0, function(written) {
            L('=== 中转站合并覆盖完成 ===', 's');
            L('删除旧记录: ' + deletedCount + ' 条 | 写入合并记录: ' + written + ' 条', 'ok');
            resolve({ok:true, merged: mergedRecords.length, created: written, deleted: deletedCount});
          });
          return;
        }
        var batch = deleteBatches[idx];
        getToken().then(function(t) {
          return feishuProxy(
            'https://open.feishu.cn/open-apis/bitable/v1/apps/' + (typeof AT !== 'undefined' ? AT : 'DptPbPEluaupDjsp2XZcFK56nte') + '/tables/' + (typeof TT !== 'undefined' ? TT : 'tblQy4Ugplc6n9E4') + '/records/batch_delete',
            'POST',
            {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
            JSON.stringify({records: batch})
          );
        }).then(function(d) {
          if (d.code === 0) { 
            deletedCount += batch.length; 
            L('删除批次 ' + (idx+1) + '/' + deleteBatches.length + ' ✓ ' + batch.length + '条', 'i'); 
            deleteBatch(idx + 1);
          } else { 
            L('删除批次 ' + (idx+1) + ' 失败: ' + d.msg + '，已停止删除', 'e'); 
            resolve({ok:false, reason:'DELETE_FAILED: ' + d.msg, deleted: deletedCount});
          }
        }).catch(function(e) {
          L('删除批次 ' + (idx+1) + ' 异常: ' + e.message + '，已停止删除', 'e');
          resolve({ok:false, reason:'DELETE_ERROR: ' + e.message, deleted: deletedCount});
        });
      }
      
      function writeMergedRecords(records, startIdx, callback) {
        if (startIdx >= records.length) { callback(startIdx); return; }
        var end = Math.min(startIdx + 100, records.length);
        var batch = records.slice(startIdx, end).map(function(r) { return {fields: r.fields}; });
        getToken().then(function(t) {
          return feishuProxy(
            'https://open.feishu.cn/open-apis/bitable/v1/apps/' + (typeof AT !== 'undefined' ? AT : 'DptPbPEluaupDjsp2XZcFK56nte') + '/tables/' + (typeof TT !== 'undefined' ? TT : 'tblQy4Ugplc6n9E4') + '/records/batch_create',
            'POST',
            {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
            JSON.stringify({records: batch})
          );
        }).then(function(d) {
          if (d.code === 0) { 
            L('写入批次 ✓ ' + batch.length + '条', 'i'); 
            writeMergedRecords(records, end, callback);
          } else { 
            L('写入批次 失败: ' + d.msg + '，已停止写入', 'e'); 
            callback(startIdx);
          }
        }).catch(function(e) {
          L('写入批次 异常: ' + e.message + '，已停止写入', 'e');
          callback(startIdx);
        });
      }
      
      deleteBatch(0);
      } // end proceedWithDeleteAndWrite
      
    }).catch(function(err) {
      L('合并失败: ' + (err.message || err), 'e');
      resolve({ok:false, reason: err.message});
    });
  });
}
function syncToProcurement(options) {
  options = options || {};
  var incrementalPlatform = String(options.incrementalPlatform || '').trim();
  var morningMode = !!options.morningMode;
  // V20.29.6: printedOnly —— 只同步中转站今日"已打单"记录（补同步用），走完整合并管线
  var printedOnly = !!options.printedOnly;
  // V21.0.0: v21Rebuild —— 指纹全量重建（推翻向量合并），优先级最高
  if (options.v21Rebuild || options.fingerprintRebuild) {
    return v21RebuildProcurementByFingerprint({printedOnly: printedOnly});
  }
  // V21.0.4: 自动探测——若中转站已建 5 列 V21 字段，默认走纯指纹（隔离表/新表自动纯净）
  if (!options._skipV21Auto && !incrementalPlatform && !morningMode) {
    return getFieldMap().then(function(fm){
      var hasV21 = !!v21ResolveField(fm, V21_ZONE_FIELDS.fingerprint) && !!v21ResolveField(fm, V21_ZONE_FIELDS.tail);
      if (hasV21) return v21RebuildProcurementByFingerprint({printedOnly: printedOnly});
      // 无 V21 列则回落旧向量链路（兼容老表）
      options = Object.assign({}, options, {_skipV21Auto:true});
      return syncToProcurement(options);
    });
  }
  // V20.11.0: Invalidate transfer table cache (returnToFeishu just wrote new data)
  // Keep procurement table cache (not changed yet)
  invalidateDataCache(typeof TT !== 'undefined' ? TT : RAW_TABLE);
  return new Promise(function(resolve) {
    chrome.storage.local.get(['procAppToken','procTableId'], function(cfg) {
      // v19.92.0: Hardcoded fallback — always works without config
      var PAT = cfg.procAppToken || 'DptPbPEluaupDjsp2XZcFK56nte'; if(PAT==='DptPbPEluaupDjsp2XZcFK56nte'||PAT==='DptPbPEluaupDjsp2XZcFK56nte') PAT='DptPbPEluaupDjsp2XZcFK56nte';
      var PTT = cfg.procTableId || 'tblMXn13Mpkvf1ql';
      chrome.storage.local.set({procAppToken: PAT, procTableId: PTT});

      L('=== 同步到采购表 ===', 'i');
      L('采购表: ' + PTT, 'i');
      if (incrementalPlatform) {
        L('增量同步范围: ' + incrementalPlatform + '（其他采购行不写入、不改动）', 'ok');
      }

      // Step 1: Read 中转站
      L('读取中转站数据...', 'i');
      fetchAllRecordsForReturn().then(function(sourceRecords) {
        // v19.92.0: Filter 中转站 by today's date — only sync today's records
        var todayStart2 = new Date();
        todayStart2.setHours(0, 0, 0, 0);
        var todayMs2 = todayStart2.getTime();
        var tomorrowMs2 = todayMs2 + 86400000;
        var todaySourceRecords = sourceRecords.filter(function(rec) {
          var f = rec.fields || {};
          var dateVal = f['🏗 【创建/绑定】日期'] || f['创建时间引导'] || f['创建时间'] || f['📅 抓取日期'];
          if (!dateVal) return false;
          var ts = typeof dateVal === 'number' ? dateVal : 0;
      // v19.92.0: Also parse ISO string dates
      if (ts === 0 && typeof dateVal === 'string') {
        var parsed = Date.parse(dateVal);
        if (!isNaN(parsed)) ts = parsed;
      }
          if (ts === 0) return false;
          return ts >= todayMs2 && ts < tomorrowMs2;
        });
        L('中转站: 全部 ' + sourceRecords.length + ' 条 / 今日 ' + todaySourceRecords.length + ' 条', 'i');
        sourceRecords = todaySourceRecords;

        // V20.29.6: printedOnly —— 补同步模式：只处理今日"已打单"记录，
        // 未打单/已匹配未打单 等状态一律不触碰（避免把未完成的备货单写进采购表）
        if (printedOnly) {
          var beforePrinted = sourceRecords.length;
          sourceRecords = sourceRecords.filter(function(rec) {
            var f = rec.fields || {};
            var st = f['手动传输状态'] || f['状态'] || f['🚃 状态🌅'] || f['传输状态'] || '';
            return String(st) === '已打单';
          });
          L('补同步(已打单)过滤: ' + beforePrinted + ' → ' + sourceRecords.length + ' 条', 'i');
          if (sourceRecords.length === 0) {
            L('今日中转站无已打单记录，补同步结束', 'warn');
            resolve({ok: true, skipped: true, reason: 'no-printed-today', count: 0});
            return;
          }
        }

        // Step 2: Detect 采购表 fields
        L('检测采购表字段...', 'i');
        detectTableFields(PAT, PTT).then(function(procFieldMap) {
          var pfNames = Object.keys(procFieldMap);
          L('采购表字段: ' + pfNames.length + ' 个', 'i');

          // Resolve 采购表 field names
          var P_TITLE = resolveField(procFieldMap, ['📡 商品全称', '商品全称', '商品标题']);
          var P_PID = resolveField(procFieldMap, ['🔗 商品ID', '商品 🆔', '商品ID', '商品 ID', '🔗ID']);
          var P_SPEC = resolveField(procFieldMap, ['🚧 ❗【时段】产品需求值', '❗【时段】产品需求值', '产品需求值', '规格需求']);
          var P_IMG = resolveField(procFieldMap, ['🖼 产品图URL', '图片URL', '【图片URL】']);
          var P_ATTACH = resolveField(procFieldMap, ['📠 产品图', '产品图']);
          var P_STATUS = resolveField(procFieldMap, ['手动传输状态', '状态', '🚃 状态🌅', '传输状态', '📋 传输状态']);
          var P_PLATFORM = resolveField(procFieldMap, ['⏲ 前置店铺', '平台所属账号', '平台【文字】', '平台', '平台文字', '📡 平台']);
          var P_DATE = resolveField(procFieldMap, ['🏗 【创建/绑定】日期', '创建时间引导', '创建时间', '📅 抓取日期']);
          var P_ACTUAL_QTY = resolveField(procFieldMap, ['🥫 🚚实际进货数量', '实际进货数量', '实际采购数量']);
          var P_OLD_STOCK = resolveField(procFieldMap, ['🤼‍♀️ ♻老旧库存数量', '老旧库存数量', '旧库存数量']);
          var P_DATE_WRITE = (P_DATE && procFieldMap[P_DATE] && procFieldMap[P_DATE].type === 5) ? P_DATE : null;
          var purchaserManualFields = pfNames.filter(function(name) {
            return /实际进货|实际采购|老旧库存|旧库存|订单号|采购单号|下单单号|预计.{0,6}(?:到货|到达)|到货时间|采购人|采购备注|供应商|采购链接|采购价|采购单价/.test(name);
          });
          [P_ACTUAL_QTY, P_OLD_STOCK].forEach(function(name) {
            if (name && purchaserManualFields.indexOf(name) < 0) purchaserManualFields.push(name);
          });

          L('采购表映射: T='+(P_TITLE||'?')+' P='+(P_PID||'?')+' S='+(P_SPEC||'?')
            +' D='+(P_DATE||'?')+' AQ='+(P_ACTUAL_QTY||'?')+' OS='+(P_OLD_STOCK||'?'), 'i');

          // Step 3: Read 采购表 records
          if (!P_DATE) {
            L('采购表没有可用日期字段，已停止同步：不会新增或更新任何记录', 'e');
            resolve({ok:false, reason:'NO_PROC_DATE_FIELD'});
            return;
          }
          if (!P_ACTUAL_QTY || !P_OLD_STOCK || !P_STATUS) {
            L('采购表缺少删除保护字段，已停止同步：必须同时存在“实际进货数量”“老旧库存数量”“状态”', 'e');
            L('本次不会新增、更新或删除任何记录', 'e');
            resolve({ok:false, reason:'MISSING_DELETE_PROTECTION_FIELDS'});
            return;
          }
          L('读取采购表今日数据（服务端筛选）...', 'i');
          getToken().then(function(t) {
            var allProc = [], pt = '';
            // Date fields configured with "show time" contain timestamps such
            // as 21:56 and do not equal TODAY() (midnight). Use a half-open
            // day range so both legacy midnight rows and newly created rows
            // are returned on the next idempotent sync.
            var todayFilter = 'CurrentValue.[' + P_DATE + '] >= TODAY()&&CurrentValue.[' + P_DATE + '] < TODAY()+1';
            var readFieldNames = [];
            [P_TITLE, P_PID, P_SPEC, P_PLATFORM, P_DATE, P_ATTACH, P_STATUS, P_ACTUAL_QTY, P_OLD_STOCK].forEach(function(name) {
              if (name && readFieldNames.indexOf(name) < 0) readFieldNames.push(name);
            });
            purchaserManualFields.forEach(function(name) {
              if (name && readFieldNames.indexOf(name) < 0) readFieldNames.push(name);
            });
            function fetchProcPage() {
              var query = '?page_size=500'
                + '&filter=' + encodeURIComponent(todayFilter)
                + '&field_names=' + encodeURIComponent(JSON.stringify(readFieldNames))
                + (pt ? '&page_token=' + encodeURIComponent(pt) : '');
              return feishuProxy(
                'https://open.feishu.cn/open-apis/bitable/v1/apps/' + PAT + '/tables/' + PTT + '/records' + query,
                'GET', {'Authorization': 'Bearer ' + t}
              ).then(function(d) {
                if (d.code !== 0) throw new Error('采购表今日筛选失败: ' + d.code + ' ' + d.msg);
                allProc = allProc.concat(d.data.items || []);
                if (d.data.has_more && d.data.page_token) { pt = d.data.page_token; return fetchProcPage(); }
                return allProc;
              });
            }
            return fetchProcPage();
          }).then(function(procRecords) {
            L('采购表: ' + procRecords.length + ' 条记录', 'i');

            // Step 4: Filter by today's date and build lookup
            var todayStart = new Date();
            todayStart.setHours(0, 0, 0, 0);
            var todayMs = todayStart.getTime();
            var tomorrowMs = todayMs + 86400000;
            var todayRecords = procRecords.filter(function(rec) {
              var f = rec.fields || {};
              var dateVal = f[P_DATE] || f['创建时间'] || f['创建时间引导'];
              if (!dateVal) return false;
              var ts = typeof dateVal === 'number' ? dateVal : 0;
              // v19.92.0: Also parse ISO string dates
              if (ts === 0 && typeof dateVal === 'string') {
                var parsed = Date.parse(dateVal);
                if (!isNaN(parsed)) ts = parsed;
              }
              if (ts === 0) return false;
              return ts >= todayMs && ts < tomorrowMs;
            });
            if (todayRecords.length !== procRecords.length) {
              L('采购表服务端日期筛选返回异常，已停止同步：不会写入任何记录', 'e');
              resolve({ok:false, reason:'PROC_DATE_FILTER_MISMATCH'});
              return;
            }
            L('今日记录: ' + todayRecords.length + ' 条 (过滤前 ' + procRecords.length + ')', 'i');

            // Step 5: Build lookup from 今日采购表
            var procLookup = buildLookupMaps(todayRecords);

            // Step 5: Match and UPSERT
            var updates = [], creates = [], fuzzyCount = 0;
            var vectorMatchCount = 0, vectorAmbiguousCount = 0;
            var plannedRows = 0, plannedQtyTotal = 0;
            var matchedProcIds = {}, coalescedSourceRows = 0;
            var sourceSplitErrors = [];
            var updateByRecordId = {}, createByPid = {}, createByTitle = {};
            var vectorStageCounts = {};
            var vectorAuditSamples = [];
            var procVectorCandidates = todayRecords.map(function(rec) {
              var extracted = extractRecFields(rec);
              return {title:extracted.title, spec:extracted.spec, rec:rec};
            });
            // V20.29.0: 采购表候选阻断索引（加速向量匹配，保底回退保证结果一致）
            var procVectorCandidateIndex = buildVectorCandidateIndex(procVectorCandidates);
            var procVectorCorpusStats = buildProcurementCorpusStats(procVectorCandidates);
            var sourceVectorCorpusStats = buildProcurementCorpusStats(sourceRecords.map(function(rec) {
              var extracted = extractRecFields(rec);
              return {title:extracted.title, spec:extracted.spec};
            }));
            function recordVectorDecision(decision, sourceProfile) {
              vectorMatchCount++;
              var stage = decision && decision.comparison
                ? (decision.comparison.stage || 'VECTOR') : 'VECTOR';
              vectorStageCounts[stage] = (vectorStageCounts[stage] || 0) + 1;
              if (vectorAuditSamples.length < 12 && decision && decision.candidate) {
                vectorAuditSamples.push({
                  stage:stage,
                  score:decision.comparison ? decision.comparison.score : 0,
                  source:(sourceProfile && sourceProfile.title) || '',
                  target:decision.candidate.title || ''
                });
              }
            }
            function procHasAttachment(rec) {
              if (!P_ATTACH || !rec || !rec.fields) return false;
              var value = rec.fields[P_ATTACH];
              return Array.isArray(value) && value.length > 0;
            }
            function mergeUniqueLines(a, b) {
              return mergeUniqueTextLines(a, b);
            }
            function mergeProcSpecsExact(a, b) {
              return mergeProcurementSpecLines(a, b);
            }
            function queueProcUpdate(op) {
              var existing = updateByRecordId[op.record_id];
              if (!existing) {
                op.sourceCount = 1;
                updateByRecordId[op.record_id] = op;
                updates.push(op);
                return;
              }
              coalescedSourceRows++;
              existing.sourceCount++;
              existing.affected = existing.affected || op.affected;
              if (P_PID) existing.fields[P_PID] = mergeUniqueLines(existing.fields[P_PID], op.fields[P_PID]);
              if (P_SPEC) existing.fields[P_SPEC] = mergeProcSpecsExact(existing.fields[P_SPEC], op.fields[P_SPEC]);
              if (P_PLATFORM) existing.fields[P_PLATFORM] = mergeUniqueLines(existing.fields[P_PLATFORM], op.fields[P_PLATFORM]);
              if (P_STATUS) {
                var oldStatus = existing.fields[P_STATUS] || '';
                var newStatus = op.fields[P_STATUS] || '';
                existing.fields[P_STATUS] = (oldStatus === '已打单' || newStatus === '已打单')
                  ? '已打单' : (oldStatus || newStatus || '未打单');
              }
              if (!existing.imageUrl && op.imageUrl) existing.imageUrl = op.imageUrl;
              existing.needsAttachment = existing.needsAttachment || op.needsAttachment;
            }
            function queueProcCreate(op) {
              var fields = op.fields || {};
              // Keep the original unmerged profile as the cluster anchor.
              // Accumulated specs are purchaser-facing output only and must
              // never broaden later matching into a transitive A-B-C bridge.
              var plannedSourceProfile = {
                title:P_TITLE ? fields[P_TITLE] : '',
                spec:P_SPEC ? fields[P_SPEC] : ''
              };
              // V20.29.4: 合并前必须通过严格证据校验（与 mergeInPlace 的 canJoin 一致）。
              // 防止"同步采购表"路径把标题相似但产品不同（或同 PID 不同 SKU）的记录
              // 误合并到同一采购组，导致规格交叉污染。
              function profileOf(opItem) {
                var anchor = (opItem && opItem.anchorProfile) || {};
                return {
                  title: anchor.title || ((opItem && opItem.fields && opItem.fields[P_TITLE]) || ''),
                  spec: anchor.spec || ((opItem && opItem.fields && opItem.fields[P_SPEC]) || '')
                };
              }
              function evidenceOk(opItem) {
                var target = profileOf(opItem);
                if (!target.title || !plannedSourceProfile.title) return false;
                return strictMergeEvidence(
                  plannedSourceProfile.title, plannedSourceProfile.spec,
                  target.title, target.spec
                );
              }
              var existing = null;
              if (P_PID) {
                String(fields[P_PID] || '').split(/\n/).some(function(pid) {
                  pid = pid.trim();
                  if (pid && createByPid[pid]) {
                    // V20.29.4: PID 命中也需严格证据（同 PID 可能对应不同 SKU/产品）
                    if (evidenceOk(createByPid[pid])) {
                      existing = createByPid[pid];
                      return true;
                    }
                    return false;
                  }
                  return false;
                });
              }
              var titleKey = P_TITLE ? norm(fields[P_TITLE] || '') : '';
              if (!existing && titleKey && createByTitle[titleKey]) {
                var titleCandidate = createByTitle[titleKey];
                var plannedExistingProfile = profileOf(titleCandidate);
                if (procurementFamilyConflict(plannedSourceProfile, plannedExistingProfile)
                    || procurementModelConflict(plannedSourceProfile, plannedExistingProfile)
                    || !evidenceOk(titleCandidate)) {
                  existing = null;
                } else {
                  existing = titleCandidate;
                }
              }
              if (!existing) {
                var plannedDecision = findSafeProcurementVectorMatch(
                  {
                    title:P_TITLE ? fields[P_TITLE] : '',
                    spec:P_SPEC ? fields[P_SPEC] : ''
                  },
                  creates.map(function(item) {
                    var anchor = item.anchorProfile || {};
                    return {
                      title:anchor.title || (P_TITLE ? item.fields[P_TITLE] : ''),
                      spec:anchor.spec || (P_SPEC ? item.fields[P_SPEC] : ''),
                      _procCoreNgrams:procurementProfileCoreNgrams(anchor),
                      op:item
                    };
                  }),
                  sourceVectorCorpusStats
                );
                if (plannedDecision && !plannedDecision.ambiguous) {
                  // V20.29.4: 向量命中也需严格证据（findSafe 是"最佳候选"，strictMergeEvidence 是"组内成员校验"）
                  if (evidenceOk(plannedDecision.candidate.op)) {
                    existing = plannedDecision.candidate.op;
                    recordVectorDecision(plannedDecision, plannedSourceProfile);
                  }
                } else if (plannedDecision && plannedDecision.ambiguous) {
                  vectorAmbiguousCount++;
                }
              }
              if (!existing) {
                op.sourceCount = 1;
                op.anchorProfile = plannedSourceProfile;
                creates.push(op);
                if (P_PID) {
                  String(fields[P_PID] || '').split(/\n/).forEach(function(pid) {
                    pid = pid.trim();
                    if (pid) createByPid[pid] = op;
                  });
                }
                if (titleKey) createByTitle[titleKey] = op;
                return;
              }
              coalescedSourceRows++;
              existing.sourceCount++;
              existing.affected = existing.affected || op.affected;
              if (P_PID) {
                existing.fields[P_PID] = mergeUniqueLines(existing.fields[P_PID], fields[P_PID]);
                String(existing.fields[P_PID] || '').split(/\n/).forEach(function(pid) {
                  pid = pid.trim();
                  if (pid) createByPid[pid] = existing;
                });
              }
              if (P_SPEC) existing.fields[P_SPEC] = mergeProcSpecsExact(existing.fields[P_SPEC], fields[P_SPEC]);
              if (P_PLATFORM) existing.fields[P_PLATFORM] = mergeUniqueLines(existing.fields[P_PLATFORM], fields[P_PLATFORM]);
              if (P_STATUS) {
                var oldStatus = existing.fields[P_STATUS] || '';
                var newStatus = fields[P_STATUS] || '';
                existing.fields[P_STATUS] = (oldStatus === '已打单' || newStatus === '已打单')
                  ? '已打单' : (oldStatus || newStatus || '未打单');
              }
              if (!existing.imageUrl && op.imageUrl) existing.imageUrl = op.imageUrl;
            }
                        sourceRecords.forEach(function(rec) {
              var src = extractRecFields(rec);
              var srcPlatforms = (src.platform || '').split('\n').filter(Boolean);
              var pSpecs = {};
              try { pSpecs = src.platformSpecs ? JSON.parse(src.platformSpecs) : {}; } catch(e) { pSpecs = {}; }

              if (srcPlatforms.length > 1) {
                // V20.16.0: 跨平台记录处理逻辑
                // 如果没有platformSpecs，说明是旧版合并记录，跳过
                if (!src.platformSpecs || !pSpecs || Object.keys(pSpecs).length === 0) {
                  // 旧版跨平台记录，没有platformSpecs，跳过
                  return;
                }
                // 有platformSpecs，检查当前平台是否缺失
                var missingPlatformSpecs = srcPlatforms.filter(function(plat) {
                  return !Object.prototype.hasOwnProperty.call(pSpecs, plat)
                    || !String(pSpecs[plat] || '').trim();
                });
                if (missingPlatformSpecs.length) {
                  if (incrementalPlatform) {
                    var currentPlatformMissing = missingPlatformSpecs.some(function(plat) {
                      return plat === incrementalPlatform;
                    });
                    if (currentPlatformMissing) {
                      sourceSplitErrors.push({
                        title:src.title || '',
                        platforms:[incrementalPlatform]
                      });
                    }
                    return;
                  } else {
                    sourceSplitErrors.push({
                      title:src.title || '',
                      platforms:missingPlatformSpecs
                    });
                    return;
                  }
                }
              }
              if (srcPlatforms.length <= 1) {
                plannedRows++;
                plannedQtyTotal += procurementSpecQtyTotal(src.spec);
                // === Single platform: normal match + update/create ===
                var result = matchRecord(src.pid, src.title, procLookup, src.platform || '');
                var matched = result ? result.rec : null;
                var matchType = result ? result.type : '';
                if (matched && matchType === 'TITLE') {
                  var exactTitleCandidate = extractRecFields(matched);
                  if (procurementFamilyConflict(src, exactTitleCandidate)
                      || procurementModelConflict(src, exactTitleCandidate)) {
                    matched = null;
                    matchType = '';
                  }
                }
                if (matchType === 'FUZZY' || !matched) {
                  if (matchType === 'FUZZY') fuzzyCount++;
                  var procVectorCandidatesScoped = selectVectorCandidatesByIndex(
                    src, procVectorCandidateIndex, procVectorCandidates
                  );
                  var vectorDecision = findSafeProcurementVectorMatch(
                    src, procVectorCandidatesScoped, procVectorCorpusStats
                  );
                  if (vectorDecision && !vectorDecision.ambiguous) {
                    matched = vectorDecision.candidate.rec;
                    matchType = 'VECTOR';
                    recordVectorDecision(vectorDecision, src);
                  } else {
                    if (vectorDecision && vectorDecision.ambiguous) vectorAmbiguousCount++;
                    matched = null;
                    matchType = '';
                  }
                }

                // v19.92.0: Safety - verify matched record is from today
                if (matched) {
                  matchedProcIds[matched.record_id] = 1;
                  var mf = matched.fields || {};
                  var mDateVal = mf[P_DATE] || mf['创建时间'] || mf['创建时间引导'];
                  if (mDateVal) {
                    var mTs = typeof mDateVal === 'number' ? mDateVal : 0;
                    if (mTs > 0 && (mTs < todayMs || mTs >= tomorrowMs)) {
                      matched = null; // Don't update records from other days
                    }
                  }
                }

                if (matched) {
                  // Update existing procurement record
                  var f = {};
                  if (P_TITLE) f[P_TITLE] = src.title || '';
                  if (P_PID) f[P_PID] = src.pid || '';
                  if (P_SPEC) {
                    // Write full spec string (spec field is text in procurement table)
                    f[P_SPEC] = src.spec || '';
                  }
                  if (P_IMG && src.img && src.img.indexOf('http') === 0) {
                    var imgFT = (procFieldMap[P_IMG] && procFieldMap[P_IMG].type !== undefined) ? procFieldMap[P_IMG].type : 1;
                    if (imgFT === 17) { f[P_IMG] = {link: src.img, text: src.img}; }
                    else { f[P_IMG] = formatFieldValue(src.img, imgFT, P_IMG); }
                  }
                  // v19.92.0: Skip Person fields (type 20) for platform
                  if (P_PLATFORM) {
                    var _pft = procFieldMap[P_PLATFORM] ? procFieldMap[P_PLATFORM].type : 0;
                    if (_pft !== 20 && _pft !== 1001) f[P_PLATFORM] = src.platform || '';
                  }
                  if (P_STATUS) f[P_STATUS] = src.status || '未打单';
                  queueProcUpdate({
                    record_id: matched.record_id,
                    fields: f,
                    matchType: matchType,
                    imageUrl: src.img || '',
                    needsAttachment: !procHasAttachment(matched),
                    affected:procurementPlatformContains(src.platform, incrementalPlatform)
                  });
                } else {
                  // Create new record
                  var cf = {};
                  if (P_TITLE) cf[P_TITLE] = src.title || '';
                  if (P_PID) cf[P_PID] = src.pid || '';
                  if (P_SPEC) cf[P_SPEC] = src.spec || '';
                  if (P_IMG && src.img && src.img.indexOf('http') === 0) {
                    var imgFT2 = (procFieldMap[P_IMG] && procFieldMap[P_IMG].type !== undefined) ? procFieldMap[P_IMG].type : 1;
                    if (imgFT2 === 17) { cf[P_IMG] = {link: src.img, text: src.img}; }
                    else { cf[P_IMG] = formatFieldValue(src.img, imgFT2, P_IMG); }
                  }
                  // v19.92.0: Skip Person fields (type 20) for platform
                  if (P_PLATFORM) {
                    var _pft2 = procFieldMap[P_PLATFORM] ? procFieldMap[P_PLATFORM].type : 0;
                    if (_pft2 !== 20 && _pft2 !== 1001) cf[P_PLATFORM] = src.platform || '';
                  }
                  if (P_STATUS) cf[P_STATUS] = src.status || '未打单';
                  if (P_DATE_WRITE) cf[P_DATE_WRITE] = Date.now();
                  queueProcCreate({
                    fields:cf,
                    imageUrl:src.img || '',
                    affected:procurementPlatformContains(src.platform, incrementalPlatform)
                  });
                }
              } else {
                // === Multi-platform: split into per-platform rows ===
                srcPlatforms.forEach(function(plat) {
                  plannedRows++;
                  var platSpec = pSpecs[plat] || '';
                  plannedQtyTotal += procurementSpecQtyTotal(platSpec || src.spec);
                  // Try to match existing procurement record for this platform
                  var result = matchRecord(src.pid, src.title, procLookup, plat);
                  var matched = result ? result.rec : null;
                  var matchType = result ? result.type : '';
                  if (matched && matchType === 'TITLE') {
                    var exactTitleCandidate2 = extractRecFields(matched);
                    var sourceProfile2 = {title:src.title, spec:platSpec || src.spec};
                    if (procurementFamilyConflict(sourceProfile2, exactTitleCandidate2)
                        || procurementModelConflict(sourceProfile2, exactTitleCandidate2)) {
                      matched = null;
                      matchType = '';
                    }
                  }
                  if (matchType === 'FUZZY' || !matched) {
                    if (matchType === 'FUZZY') fuzzyCount++;
                    var platVectorSource = {title:src.title, spec:platSpec || src.spec};
                    var platVectorCandidatesScoped = selectVectorCandidatesByIndex(
                      platVectorSource, procVectorCandidateIndex, procVectorCandidates
                    );
                    var vectorDecision2 = findSafeProcurementVectorMatch(
                      platVectorSource,
                      platVectorCandidatesScoped,
                      procVectorCorpusStats
                    );
                    if (vectorDecision2 && !vectorDecision2.ambiguous) {
                      matched = vectorDecision2.candidate.rec;
                      matchType = 'VECTOR';
                      recordVectorDecision(vectorDecision2, {title:src.title, spec:platSpec || src.spec});
                    } else {
                      if (vectorDecision2 && vectorDecision2.ambiguous) vectorAmbiguousCount++;
                      matched = null;
                      matchType = '';
                    }
                  }

                  if (matched) {
                    matchedProcIds[matched.record_id] = 1;
                    // Update existing record for this platform
                    var f = {};
                    if (P_TITLE) f[P_TITLE] = src.title || '';
                    if (P_PID) f[P_PID] = src.pid || '';
                    if (P_SPEC) {
                      f[P_SPEC] = platSpec || src.spec || '';
                    }
                    if (P_IMG && src.img && src.img.indexOf('http') === 0) {
                      var imgFT3 = (procFieldMap[P_IMG] && procFieldMap[P_IMG].type !== undefined) ? procFieldMap[P_IMG].type : 1;
                      if (imgFT3 === 17) { f[P_IMG] = {link: src.img, text: src.img}; }
                      else { f[P_IMG] = formatFieldValue(src.img, imgFT3, P_IMG); }
                    }
                    // v19.92.0: Skip Person fields (type 20) for platform
                    if (P_PLATFORM) {
                      var _pft3 = procFieldMap[P_PLATFORM] ? procFieldMap[P_PLATFORM].type : 0;
                      if (_pft3 !== 20 && _pft3 !== 1001) f[P_PLATFORM] = plat;
                    }
                    if (P_STATUS) f[P_STATUS] = src.status || '未打单';
                    queueProcUpdate({
                      record_id: matched.record_id,
                      fields: f,
                      matchType: matchType,
                      imageUrl: src.img || '',
                      needsAttachment: !procHasAttachment(matched),
                      affected:procurementPlatformContains(plat, incrementalPlatform)
                    });
                  } else {
                    // Create new row for this platform
                    var cf2 = {};
                    if (P_TITLE) cf2[P_TITLE] = src.title || '';
                    if (P_PID) cf2[P_PID] = src.pid || '';
                    if (P_SPEC) cf2[P_SPEC] = platSpec || src.spec || '';
                    if (P_IMG && src.img && src.img.indexOf('http') === 0) {
                      var imgFT4 = (procFieldMap[P_IMG] && procFieldMap[P_IMG].type !== undefined) ? procFieldMap[P_IMG].type : 1;
                      if (imgFT4 === 17) { cf2[P_IMG] = {link: src.img, text: src.img}; }
                      else { cf2[P_IMG] = formatFieldValue(src.img, imgFT4, P_IMG); }
                    }
                    // v19.92.0: Skip Person fields (type 20) for platform
                    if (P_PLATFORM) {
                      var _pft6 = procFieldMap[P_PLATFORM] ? procFieldMap[P_PLATFORM].type : 0;
                      if (_pft6 !== 20 && _pft6 !== 1001) cf2[P_PLATFORM] = plat;
                    }
                    if (P_STATUS) cf2[P_STATUS] = src.status || '未打单';
                    if (P_DATE_WRITE) cf2[P_DATE_WRITE] = Date.now();
                    queueProcCreate({
                      fields:cf2,
                      imageUrl:src.img || '',
                      affected:procurementPlatformContains(plat, incrementalPlatform)
                    });
                  }
                });
              }
            });
            if (sourceSplitErrors.length) {
              var firstSplitError = sourceSplitErrors[0];
              L('安全停止：检测到 ' + sourceSplitErrors.length
                + ' 条跨平台中转记录缺少“平台规格明细”', 'e');
              L('首条: ' + firstSplitError.title.substring(0, 40)
                + '；缺少 ' + firstSplitError.platforms.join('、'), 'e');
              L('本次不会写入采购表，避免把整组规格重复计算到缺失平台', 'e');
              resolve({ok:false, reason:'MISSING_PLATFORM_SPEC_SNAPSHOT'});
              return;
            }

            // Always calculate the complete daily grouping for reconciliation,
            // but an afternoon platform return may execute only the purchase
            // groups touched by that platform. This prevents a 32-product
            // return from rewriting 1,300+ purchaser rows.
            var allPlannedUpdates = updates.slice();
            var allPlannedCreates = creates.slice();
            var unmatchedExisting = todayRecords.filter(function(rec) {
              return !matchedProcIds[rec.record_id];
            });

            var assignedSourceRows = allPlannedCreates.reduce(function(sum, item) {
              return sum + (item.sourceCount || 1);
            }, 0) + allPlannedUpdates.reduce(function(sum, item) {
              return sum + (item.sourceCount || 1);
            }, 0);
            var assignedQtyTotal = allPlannedCreates.concat(allPlannedUpdates).reduce(function(sum, item) {
              return sum + procurementSpecQtyTotal(P_SPEC ? item.fields[P_SPEC] : '');
            }, 0);

            L('来源去向对账: ' + plannedRows + ' 条来源全部分配（全量分组计算，非最终写入数）', 'i');
            L('  分组计算: ' + allPlannedUpdates.length + ' 组匹配 + ' + allPlannedCreates.length + ' 组待新增（增量筛选前）', 'i');
            L('数量守恒对账: 来源 ' + plannedQtyTotal + ' = 写入计划 ' + assignedQtyTotal, 'i');
            if (coalescedSourceRows > 0) {
              L('同一采购组多来源合并: ' + coalescedSourceRows + ' 条来源（合成一次更新，避免覆盖）', 'i');
            }

            if (plannedRows !== assignedSourceRows) {
              L('安全停止：来源去向对账失败。未分配='
                + (plannedRows - assignedSourceRows) + '；不会写入任何记录', 'e');
              resolve({ok:false, reason:'SOURCE_DESTINATION_RECONCILIATION_FAILED'});
              return;
            }
            if (Math.abs(plannedQtyTotal - assignedQtyTotal) > 0.000001) {
              L('安全停止：采购数量守恒失败。来源=' + plannedQtyTotal
                + '，写入计划=' + assignedQtyTotal + '；不会写入任何记录', 'e');
              resolve({ok:false, reason:'SOURCE_QUANTITY_RECONCILIATION_FAILED'});
              return;
            }

            var massCreateLimit = Math.max(100, Math.floor(sourceRecords.length * 0.5));
            var massGuardMinExisting = 10; // Only guard when there are enough existing records to suspect duplication
            if (!morningMode && todayRecords.length >= massGuardMinExisting &&
                (allPlannedUpdates.length === 0 || allPlannedCreates.length > massCreateLimit)) {
              L('安全停止：采购表今天已有 ' + todayRecords.length + ' 条，但本次仅匹配 '
                + allPlannedUpdates.length + ' 条、准备新增 ' + allPlannedCreates.length
                + ' 条。疑似日期或匹配异常，不执行写入。', 'e');
              resolve({
                ok:false,
                reason:'MASS_CREATE_GUARD',
                matched:allPlannedUpdates.length,
                pendingCreates:allPlannedCreates.length
              });
              return;
            }
            if (todayRecords.length > 0 && todayRecords.length < massGuardMinExisting
                && allPlannedUpdates.length === 0 && allPlannedCreates.length > 0) {
              L('采购表今日仅 ' + todayRecords.length + ' 条旧记录且未匹配，视为首次全量同步，继续写入 ' + allPlannedCreates.length + ' 条', 'w');
            }

            var incrementalPlan = selectIncrementalProcurementPlan(
              allPlannedUpdates,
              allPlannedCreates,
              unmatchedExisting,
              incrementalPlatform,
              P_PLATFORM
            );
            updates = incrementalPlan.updates;
            creates = incrementalPlan.creates;
            unmatchedExisting = incrementalPlan.unmatchedExisting;

            L('增量筛选结果: ' + updates.length + ' 组将写入更新 + ' + creates.length + ' 组将写入新增', 'i');
            L('--- 实际写入范围 ---', 'i');
            if (incrementalPlatform) {
              L('仅处理 ' + incrementalPlatform
                + ' 影响的采购组；其余采购记录不会发送更新请求', 'ok');
            }
            L('写入更新: ' + updates.length + ' 组（采购行）', 'i');
            L('  PID: ' + updates.filter(function(u){return u.matchType==='PID'}).length, 'i');
            L('  标准标题/运营尾缀: '
              + updates.filter(function(u){return u.matchType==='TITLE'}).length, 'i');
            if (typeof pendingReviewQueue === 'undefined') var pendingReviewQueue=[];
            // V21.0.41: 收集 PENDING_REVIEW 入待确认
            try { if(best && best.decision && best.decision.pending){ pendingReviewQueue.push({a:a,b:b,score:best.decision.score}); } } catch(e){}
            L('  智能向量合并（全量分组计算）: ' + vectorMatchCount + ' 条', vectorMatchCount ? 'ok' : 'i');
            if (vectorMatchCount) {
              L('    超高标题相似: ' + (vectorStageCounts.TITLE_HIGH || 0)
                + ' | 长规格强证据: ' + (vectorStageCounts.LONG_SPEC || 0)
                + ' | 标题+规格向量: ' + (vectorStageCounts.TITLE_SPEC_VECTOR || 0)
                + ' | 动态稀有核心词: ' + (vectorStageCounts.RARE_CORE || 0), 'i');
              vectorAuditSamples.forEach(function(sample) {
                L('    [' + sample.stage + ' '
                  + sample.score.toFixed(3) + '] '
                  + sample.source.substring(0, 24) + ' → '
                  + sample.target.substring(0, 24), 'i');
              });
            }
            L('  计算阶段: 模糊候选 ' + fuzzyCount + ' 组；歧义保留 '
              + vectorAmbiguousCount + ' 组', vectorAmbiguousCount ? 'w' : 'i');
            L('写入新增: ' + creates.length + ' 组（采购行）', 'i');
            // Afternoon source is authoritative for whether a row is still
            // needed, but purchaser-entered quantities are never disposable.
            // Only a truly blank value is empty: numeric/string 0, objects,
            // booleans and any other populated value must be protected.
            var deleteCandidates = [];
            var protectedUnmatched = [];
            var protectedUpdates = [];
            unmatchedExisting.forEach(function(rec) {
              var fields = rec.fields || {};
              // V20.29.6: printedOnly 补同步模式绝不删除、绝不回写状态——
              // 未打单采购行只是"不在今日已打单来源中"，不代表失效，
              // 必须原样保留（不删、不改状态），否则补同步会误删未打单数据。
              if (!printedOnly && !hasPurchaserManualData(fields, purchaserManualFields)) {
                deleteCandidates.push(rec.record_id);
                return;
              }
              protectedUnmatched.push(rec);
              if (!printedOnly && sv(fields[P_STATUS]) !== '未打单') {
                var statusFields = {};
                statusFields[P_STATUS] = '未打单';
                protectedUpdates.push({record_id:rec.record_id, fields:statusFields});
              }
            });
            if (unmatchedExisting.length > 0) {
              L('今日旧记录未出现在本次来源: ' + unmatchedExisting.length + ' 条', 'w');
              L('允许删除: ' + deleteCandidates.length
                + ' 条（全部采购人工字段均为空）', 'w');
              L('强制保护: ' + protectedUnmatched.length
                + ' 条（任一采购人工字段有值；保留并标记未打单）', 'i');
            }

            if (updates.length === 0 && creates.length === 0 &&
                protectedUpdates.length === 0 && deleteCandidates.length === 0) {
              L('无需同步', 'i'); resolve({ok:true, updated:0, created:0, platform:confirmedPlatform}); return;
            }

            // === 优化7: 合并后复检层 (Post-Merge Verification) ===
            var postMergeGroups = [];
            updates.forEach(function(u) {
              var spec = (u.fields && u.fields[P_SPEC]) || '';
              var title = (u.fields && u.fields[P_TITLE]) || '';
              postMergeGroups.push({
                title: title,
                mergedSpec: typeof spec === 'string' ? spec : (spec.text || ''),
                originalSpecs: u._originalSpecs || [],
                recordId: u.record_id,
                matchType: u.matchType || 'unknown'
              });
            });
            creates.forEach(function(c) {
              var spec = (c.fields && c.fields[P_SPEC]) || '';
              var title = (c.fields && c.fields[P_TITLE]) || '';
              postMergeGroups.push({
                title: title,
                mergedSpec: typeof spec === 'string' ? spec : (spec.text || ''),
                originalSpecs: [],
                recordId: 'new',
                matchType: 'CREATE'
              });
            });
            
            var postMergeReport = null;
            var pmSummary = {total:0, blocked:0, warned:0, passed:0};
            if (typeof batchPostMergeVerify === 'function') {
              postMergeReport = batchPostMergeVerify(postMergeGroups);
              pmSummary = postMergeReport.summary;
            } else {
              L('[复检] 跳过复检（函数未定义）', 'w');
            }
            
            if (pmSummary.blocked > 0 || pmSummary.warned > 0) {
              L('[复检] 合并后复检: ' + pmSummary.total + ' 组', 'i');
              L('  ✓ 通过: ' + pmSummary.passed + ' | ⚠ 警告: ' + pmSummary.warned + ' | ✗ 阻断: ' + pmSummary.blocked, 
                pmSummary.blocked > 0 ? 'w' : 'i');
              
              // 输出阻断和警告详情
              postMergeReport.results.forEach(function(r) {
                if (r.result.severity !== 'ok') {
                  r.result.issues.forEach(function(issue) {
                    L('  [' + issue.level.toUpperCase() + '] ' + r.group.title.substring(0, 30) + ': ' + issue.message, 
                      issue.level === 'block' ? 'w' : 'i');
                  });
                }
              });
              
              // 移除被阻断的更新/新增
              if (pmSummary.blocked > 0) {
                var blockedIds = {};
                postMergeReport.results.forEach(function(r) {
                  if (r.result.severity === 'block' && r.group.recordId !== 'new') {
                    blockedIds[r.group.recordId] = true;
                  }
                });
                var blockedCreateTitles = {};
                postMergeReport.results.forEach(function(r) {
                  if (r.result.severity === 'block' && r.group.recordId === 'new') {
                    blockedCreateTitles[r.group.title] = true;
                  }
                });
                
                var origUpdateLen = updates.length;
                var origCreateLen = creates.length;
                updates = updates.filter(function(u) { return !blockedIds[u.record_id]; });
                creates = creates.filter(function(c) {
                  var title = (c.fields && c.fields[P_TITLE]) || '';
                  return !blockedCreateTitles[title];
                });
                L('[复检] 移除阻断: 更新 ' + (origUpdateLen - updates.length) + ' 条, 新增 ' + (origCreateLen - creates.length) + ' 条', 'w');
              }
            } else {
              L('[复检] ✓ 全部通过 (' + pmSummary.total + ' 组)', 'i');
            }

            // Step 6: Execute batch operations
            var chain = Promise.resolve();
            var updateCount = 0, createCount = 0, protectedUpdateCount = 0, deleteCount = 0;
            var imageQueue = [];

            // Batch UPDATE
            for (var i = 0; i < updates.length; i += 100) {
              (function(batch) {
                chain = chain.then(function() {
                  return getToken().then(function(t) {
                    var recs = batch.map(function(u) { return {record_id: u.record_id, fields: u.fields}; });
                    return feishuProxy(
                      'https://open.feishu.cn/open-apis/bitable/v1/apps/' + PAT + '/tables/' + PTT + '/records/batch_update',
                      'POST', {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
                      JSON.stringify({records: recs})
                    ).then(function(d) {
                      if (d.code === 0) {
                        updateCount += recs.length;
                        batch.forEach(function(item) {
                          if (item.needsAttachment && item.imageUrl && item.imageUrl.indexOf('http') === 0) {
                            imageQueue.push({rid:item.record_id, img:item.imageUrl, idx:imageQueue.length});
                          }
                        });
                        L('更新批次✓ ' + recs.length + '条', 'i');
                      }
                      else {
                        L('更新错误: ' + d.code + ' ' + d.msg, 'e');
                        if (d.data && d.data.records) {
                          d.data.records.forEach(function(r,i) {
                            if (r.code !== 0) L('  记录'+(i+1)+': '+r.code+' '+(r.msg||''),'e');
                          });
                        }
                      }
                    });
                  });
                });
              })(updates.slice(i, i + 100));
            }

            // Batch CREATE
            for (var i = 0; i < creates.length; i += 100) {
              (function(batch) {
                chain = chain.then(function() {
                  return getToken().then(function(t) {
                    return feishuProxy(
                      'https://open.feishu.cn/open-apis/bitable/v1/apps/' + PAT + '/tables/' + PTT + '/records/batch_create',
                      'POST', {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
                      JSON.stringify({records: batch.map(function(item) { return {fields:item.fields}; })})
                    ).then(function(d) {
                      if (d.code === 0) {
                        createCount += batch.length;
                        var createdRecords = (d.data && d.data.records) || [];
                        batch.forEach(function(item, idx) {
                          var created = createdRecords[idx];
                          if (created && created.record_id && item.imageUrl && item.imageUrl.indexOf('http') === 0) {
                            imageQueue.push({rid:created.record_id, img:item.imageUrl, idx:imageQueue.length});
                          }
                        });
                        L('新增批次✓ ' + batch.length + '条', 'i');
                      }
                      else {
                        L('新增错误: ' + d.code + ' ' + d.msg, 'e');
                        if (d.data && d.data.records) {
                          d.data.records.forEach(function(r,i) {
                            if (r.code !== 0) L('  记录'+(i+1)+': '+r.code+' '+(r.msg||''),'e');
                          });
                        }
                      }
                    });
                  });
                });
              })(creates.slice(i, i + 100));
            }

            // Mark unmatched rows with purchaser-entered quantities as 未打单.
            // Only the status field is touched; all purchaser fields stay intact.
            for (var i = 0; i < protectedUpdates.length; i += 100) {
              (function(batch) {
                chain = chain.then(function() {
                  return getToken().then(function(t) {
                    return feishuProxy(
                      'https://open.feishu.cn/open-apis/bitable/v1/apps/' + PAT + '/tables/' + PTT + '/records/batch_update',
                      'POST', {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
                      JSON.stringify({records:batch})
                    ).then(function(d) {
                      if (d.code === 0) {
                        protectedUpdateCount += batch.length;
                        L('保护行状态回写✓ ' + batch.length + '条', 'i');
                      } else {
                        L('保护行状态回写错误: ' + d.code + ' ' + d.msg, 'e');
                      }
                    });
                  });
                });
              })(protectedUpdates.slice(i, i + 100));
            }

            // Destructive phase is last and fail-closed. If any source update,
            // create, or protection-status write is incomplete, nothing is
            // deleted, so purchaser-entered data can never disappear due to a
            // partial synchronization.
            chain = chain.then(function() {
              var writesComplete = updateCount === updates.length
                && createCount === creates.length
                && protectedUpdateCount === protectedUpdates.length;
              if (!writesComplete) {
                L('安全保护：前置写入未全部成功，已取消删除 '
                  + deleteCandidates.length + ' 条旧未打单记录', 'e');
                return;
              }
              if (!deleteCandidates.length) return;
              L('前置写入全部成功，开始删除 ' + deleteCandidates.length
                + ' 条无采购值、无旧库存的旧未打单记录...', 'i');
              var deleteChain = Promise.resolve();
              for (var di = 0; di < deleteCandidates.length; di += 100) {
                (function(batch) {
                  deleteChain = deleteChain.then(function() {
                    return getToken().then(function(t) {
                      return feishuProxy(
                        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + PAT + '/tables/' + PTT + '/records/batch_delete',
                        'POST', {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'},
                        JSON.stringify({records:batch})
                      ).then(function(d) {
                        if (d.code === 0) {
                          deleteCount += batch.length;
                          L('条件删除批次✓ ' + batch.length + '条', 'i');
                        } else {
                          L('条件删除错误: ' + d.code + ' ' + d.msg, 'e');
                        }
                      });
                    });
                  });
                })(deleteCandidates.slice(di, di + 100));
              }
              return deleteChain;
            });

            chain.then(function() {
              if (!P_ATTACH) {
                L('采购表未找到附件字段“📠 产品图”，跳过附件回填', 'w');
                return {imgOk:0, imgFailed:imageQueue.length};
              }
              if (!imageQueue.length) {
                L('采购表附件已齐全，无需回填', 'i');
                return {imgOk:0, imgFailed:0};
              }
              L('采购表缺失附件: ' + imageQueue.length + ' 条，开始回填商品图...', 'i');
              return downloadImages(imageQueue, PTT);
            }).then(function(imgResult) {
              var syncComplete = updateCount === updates.length
                && createCount === creates.length
                && protectedUpdateCount === protectedUpdates.length
                && deleteCount === deleteCandidates.length;
              L(syncComplete ? '=== 同步完成 ===' : '=== 同步未完整完成，请按错误日志重试 ===',
                syncComplete ? 's' : 'e');
              L('更新: ' + updateCount + ' 条 | 新增: ' + createCount
                + ' 条 | 保护保留: ' + protectedUnmatched.length
                + ' 条 | 条件删除: ' + deleteCount
                + ' 条 | 附件回填: ' + ((imgResult && imgResult.imgOk) || 0) + ' 条',
                syncComplete ? 'ok' : 'e');
              resolve({
                ok:syncComplete,
                updated:updateCount,
                created:createCount,
                protected:protectedUnmatched.length,
                deleted:deleteCount,
                vectorMatched:vectorMatchCount,
                attachmentUpdated:(imgResult && imgResult.imgOk) || 0,
                attachmentFailed:(imgResult && imgResult.imgFailed) || 0,
                unmatchedExisting:unmatchedExisting.length
              });
            }).catch(function(e) { L('同步异常: ' + e.message, 'e'); resolve({ok:false}); });

          }).catch(function(e) { L('读取采购表异常: ' + e.message, 'e'); resolve({ok:false}); });
        }).catch(function(e) { L('采购表字段检测失败: ' + e.message, 'e'); resolve({ok:false}); });
      }).catch(function(e) { L('读取中转站异常: ' + e.message, 'e'); resolve({ok:false}); });
    });
  });
}

// ====== V20.8.5: Morning Upload with Vector Merge ======
function uploadMorningToProcurement() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(['procAppToken','procTableId'], function(cfg) {
      var PAT = cfg.procAppToken || 'DptPbPEluaupDjsp2XZcFK56nte'; if(PAT==='DptPbPEluaupDjsp2XZcFK56nte'||PAT==='DptPbPEluaupDjsp2XZcFK56nte') PAT='DptPbPEluaupDjsp2XZcFK56nte';
      var PTT = cfg.procTableId || 'tblMXn13Mpkvf1ql';
      chrome.storage.local.set({procAppToken: PAT, procTableId: PTT});

      L('=== 早上备货单 \u2192 采购\u8868\uff08\u5411\u91cf\u5408\u5e76\uff09 ===', 'i');
      L('\u91c7\u8d2d\u8868: ' + PTT, 'i');

      // Step 1: Clear today's procurement records
      L('\u6e05\u9664\u91c7\u8d2d\u8868\u4eca\u65e5\u65e7\u6570\u636e...', 'i');
      getToken().then(function(t) {
        detectTableFields(PAT, PTT).then(function(procFieldMap) {
          var P_DATE = resolveField(procFieldMap, ['\u{1F3D7}\uFE0F \u3010\u521b\u5efa/\u7ed1\u5b9a\u3011\u65e5\u671f', '\u521b\u5efa\u65f6\u95f4', '\u521b\u5efa\u65f6\u95f4\u5f15\u5bfc', '\u{1F4C5} \u6293\u53d6\u65e5\u671f']);
          if (!P_DATE) { doSync(); return; }
          var todayFilter = 'CurrentValue.[' + P_DATE + '] >= TODAY()&&CurrentValue.[' + P_DATE + '] < TODAY()+1';
          var allProc = [], pt = '';
          function fetchPage() {
            var q = '?page_size=500&filter=' + encodeURIComponent(todayFilter) + '&field_names=' + encodeURIComponent(JSON.stringify([P_DATE])) + (pt ? '&page_token=' + encodeURIComponent(pt) : '');
            return feishuProxy('https://open.feishu.cn/open-apis/bitable/v1/apps/' + PAT + '/tables/' + PTT + '/records' + q, 'GET', {'Authorization': 'Bearer ' + t}).then(function(d) {
              if (d.code !== 0) throw new Error('read fail: ' + d.msg);
              allProc = allProc.concat(d.data.items || []);
              if (d.data.has_more && d.data.page_token) { pt = d.data.page_token; return fetchPage(); }
              return allProc;
            });
          }
          fetchPage().then(function(existing) {
            if (!existing.length) { L('\u91c7\u8d2d\u8868\u4eca\u65e5\u65e0\u65e7\u6570\u636e', 'i'); doSync(); return; }
            L('\u6e05\u9664 ' + existing.length + ' \u6761\u65e7\u8bb0\u5f55...', 'i');
            var chain = Promise.resolve();
            for (var di = 0; di < existing.length; di += 100) {
              (function(batch) {
                chain = chain.then(function() {
                  return feishuProxy('https://open.feishu.cn/open-apis/bitable/v1/apps/' + PAT + '/tables/' + PTT + '/records/batch_delete', 'POST', {'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json'}, JSON.stringify({records: batch.map(function(r){return r.record_id;})})).then(function(d) {
                    if (d.code !== 0) throw new Error(d.msg);
                    L('\u6e05\u9664\u6279\u6b21\u2713 ' + batch.length + '\u6761', 'i');
                  });
                });
              })(existing.slice(di, di + 100));
            }
            chain.then(doSync).catch(function(e) { L('\u6e05\u9664\u5f02\u5e38: ' + e.message, 'e'); resolve({ok:false}); });
          }).catch(function(e) { L('\u8bfb\u53d6\u5f02\u5e38: ' + e.message, 'e'); resolve({ok:false}); });
        }).catch(function(e) { L('\u5b57\u6bb5\u68c0\u6d4b\u5931\u8d25: ' + e.message, 'e'); resolve({ok:false}); });
      }).catch(function(e) { L('Token\u5931\u8d25: ' + e.message, 'e'); resolve({ok:false}); });

      function doSync() {
        L('\u5f00\u59cb\u5411\u91cf\u5408\u5e76 + \u5199\u5165\u91c7\u8d2d\u8868...', 'i');
        syncToProcurement({morningMode: true}).then(function(r) {
          if (r && r.ok) {
            L('=== \u65e9\u4e0a\u5907\u8d27\u5355\u4e0a\u4f20\u5b8c\u6210 ===', 's');
            L('\u66f4\u65b0: ' + (r.updated||0) + ' | \u65b0\u589e: ' + (r.created||0) + ' | \u5411\u91cf\u5408\u5e76: ' + (r.vectorMatched||0) + ' \u6761', 'ok');
          }
          resolve(r);
        }).catch(function(e) { L('\u4e0a\u4f20\u5f02\u5e38: ' + e.message, 'e'); resolve({ok:false}); });
      }
    });
  });
}

// Incremental spec merge for afternoon return: only update printed specs, preserve others
function mergeSpecFieldsForReturn(oldSpecStr, newSpecStr, platform) {
  if (!oldSpecStr) return newSpecStr || '';
  if (!newSpecStr) return oldSpecStr || '';
  var oldLines = oldSpecStr.split('\n').filter(function(l){return l.trim();});
  var newLines = newSpecStr.split('\n').filter(function(l){return l.trim();});
  if (!newLines.length) return oldSpecStr;
  var oldSpecs = oldLines.map(function(l) {
    var p = l.split(';');
    var nm = (p.length >= 2 ? p.slice(0, -1).join(';') : l).trim();
    var q = p.length >= 2 ? (Number(p[p.length - 1]) || 0) : 0;
    return {name: nm, qty: q, raw: l};
  });
  var newSpecs = newLines.map(function(l) {
    var p = l.split(';');
    var nm = (p.length >= 2 ? p.slice(0, -1).join(';') : l).trim();
    var q = p.length >= 2 ? (Number(p[p.length - 1]) || 0) : 0;
    return {name: nm, qty: q};
  });
  var usedOld = {};
  var mergedResult = [];
  var matchedCount = 0, appendedCount = 0;
  newSpecs.forEach(function(ns) {
    var bestIdx = -1, bestScore = 0;
    var nn = norm(ns.name);
    for (var i = 0; i < oldSpecs.length; i++) {
      if (usedOld[i]) continue;
      var on = norm(oldSpecs[i].name);
      if (on === nn) { bestIdx = i; bestScore = 1; break; }
      var sc = jaroWinkler(on, nn);
      if (sc > bestScore) { bestScore = sc; bestIdx = i; }
    }
    if (bestIdx >= 0 && bestScore >= 0.80) {
      var on2 = norm(oldSpecs[bestIdx].name);
      var lenRatio = Math.min(nn.length, on2.length) / Math.max(nn.length, on2.length);
      if (bestScore < 1 && lenRatio < 0.5) {
        mergedResult.push(ns.name + ';' + ns.qty);
        appendedCount++;
      } else {
        usedOld[bestIdx] = 1;
        mergedResult.push(ns.name + ';' + ns.qty);
        matchedCount++;
      }
    } else {
      mergedResult.push(ns.name + ';' + ns.qty);
      appendedCount++;
    }
  });
  oldSpecs.forEach(function(os, i) {
    if (!usedOld[i]) {
      mergedResult.push(os.raw);
    }
  });
  return mergedResult.join('\n');
}

// Platform is an aggregated field after cross-platform deduplication.  Add the
// current platform without erasing the platforms already stored on the record.

// v19.92.0: Deduplicate platform string (remove repeated lines)
function dedupPlatform(str) {
  if (!str) return '';
  // V20.16.0: 返回所有去重后的平台（支持跨平台合并记录）
  var seen = {};
  var result = [];
  String(str).split(/[\n,]/).forEach(function(p) {
    p = p.trim();
    if (p && !seen[p]) { seen[p] = 1; result.push(p); }
  });
  return result.join('\n') || '';
}

function mergePlatformFieldsForReturn(oldPlatform, currentPlatform) {
  // V20.16.0: 合并平台字段，保留所有平台（支持跨平台记录）
  var values = [];
  var seen = {};
  function add(value) {
    String(value || '').split(/[\n,]/).forEach(function(part) {
      part = part.trim();
      if (part && !seen[part]) { seen[part] = 1; values.push(part); }
    });
  }
  // v19.92.0: Handle Feishu array format
  if (Array.isArray(oldPlatform)) {
    oldPlatform.forEach(function(value) { add(value && (value.text || value.name || value)); });
  } else if (oldPlatform && typeof oldPlatform === 'object') {
    add(oldPlatform.text || oldPlatform.name || String(oldPlatform));
  } else {
    add(oldPlatform);
  }
  add(currentPlatform);
  return values.join('\n');
}

// Chrome tab titles are owned by the top-level Store Manager page, unlike the
// child frames that contain the product rows.  Use this stable browser identity
// to resolve the account tail, then get only the platform name from the frame
// that actually renders the currently selected platform.
function resolveAccountTailFromTabTitle(tabTitle) {
  var title = String(tabTitle || '');
  if (title.indexOf('A售后') >= 0 || title.indexOf('多行全品爆款') >= 0) return '7207';
  if (title.indexOf('豆子') >= 0 || title.indexOf('13819927205') >= 0) return '7205';
  if (title.indexOf('主账号') >= 0 || title.indexOf('17538525820') >= 0) return '5820';
  return '';
}

function resolveConfirmedPlatform(tabTitle, frameResults, tabUrl, pageZoneInfo) {
  // V20.12.60 DEBUG: Log frame data for diagnosis
  console.log('[RESOLVE] V20.12.62 resolveConfirmedPlatform called');
  console.log('[RESOLVE] pageZoneInfo=' + JSON.stringify(pageZoneInfo));
  console.log('[RESOLVE] frameResults count:', (frameResults || []).length);
  (frameResults || []).forEach(function(f, i) {
    var r = f && f.result ? f.result : null;
    console.log('[RESOLVE] frame[' + i + ']: platformName=' + (r ? r.platformName : 'null') 
      + ' platform=' + (r ? r.platform : 'null') 
      + ' items=' + (r && r.items ? r.items.length : 0)
      + ' tableVisible=' + (r ? r.tableVisible : 'null'));
  });
  var tail = resolveAccountTailFromTabTitle(tabTitle);
  // v19.77.0: Fallback to URL token if tab title didn't match
  if (!tail && tabUrl) {
    try {
      var urlTokenMatch = String(tabUrl).match(/token=([A-Fa-f0-9]+)/i);
      if (urlTokenMatch) {
        var urlToken = urlTokenMatch[1].toUpperCase();
        var URL_TAIL_MAP = {
          'E9AD6D4CCE7DB911DC8FDE8A54EFF2C0': '7205',
          '382346A2BAB84AEA0060104B84DCD1DF': '7207',
          '80ADDCEEADE51E1168049D66ECCCF2F9': '5820'
        };
        if (URL_TAIL_MAP[urlToken]) tail = URL_TAIL_MAP[urlToken];
      }
    } catch(ue) {}
  }
  var platformName = '';
  var platformFrames = (frameResults || []).filter(function(frame) {
    var result = frame && frame.result ? frame.result : null;
    return result && result.tableVisible !== false && result.items && result.items.length;
  });
  if (!platformFrames.length) platformFrames = frameResults || [];
  platformFrames.some(function(frame) {
    var result = frame && frame.result ? frame.result : null;
    if (!result) return false;
    platformName = result.platformName || '';
    if (!platformName && result.platform) platformName = String(result.platform).split('-【')[0].trim();
    return !!platformName;
  });
  // V20.12.59: Cross-frame fallback — check ALL frames for platformName
  // The platform indicator may be in a parent frame without table data
  if (!platformName) {
    console.log('[RESOLVE] platformName empty after data-frame scan, trying cross-frame fallback...');
    (frameResults || []).some(function(frame) {
      var result = frame && frame.result ? frame.result : null;
      if (!result) return false;
      var pn = result.platformName || '';
      if (!pn && result.platform) pn = String(result.platform).split('-【')[0].trim();
      if (pn) { platformName = pn; console.log('[RESOLVE] Cross-frame found platformName=' + pn); return true; }
      return false;
    });
    if (!platformName) console.log('[RESOLVE] Cross-frame fallback also failed');
  }
  // V20.12.62: Cross-frame accountTail extraction
  // Priority: 1) accountTail from any frame result, 2) from platform field, 3) from platformName field
  if (!tail) {
    (frameResults || []).forEach(function(frame) {
      if (tail) return;
      var result = frame && frame.result ? frame.result : null;
      if (!result) return;
      // Direct accountTail field (V20.12.62+)
      if (result.accountTail) { tail = result.accountTail; console.log('[RESOLVE] Cross-frame found tail=' + tail + ' from accountTail field'); return; }
      // From platform field (e.g. "抖音-【7207】")
      var plat = String(result.platform || '');
      var m = plat.match(/【(\d+)】/);
      if (m && m[1]) { tail = m[1]; console.log('[RESOLVE] Cross-frame found tail=' + tail + ' from platform field'); return; }
      // From platformName field (e.g. "抖音-【7207】")
      var pn = String(result.platformName || '');
      var m2 = pn.match(/【(\d+)】/);
      if (m2 && m2[1]) { tail = m2[1]; console.log('[RESOLVE] Cross-frame found tail=' + tail + ' from platformName field'); }
    });
  }
  // V20.12.62: Last resort — try localStorage for platform AND account
  if (!platformName || !tail) {
    try {
      if (!platformName) {
        var lsPlat = localStorage.getItem('dgj_lastPlatform');
        if (lsPlat) { platformName = lsPlat; console.log('[RESOLVE] Found platform from localStorage: ' + lsPlat); }
      }
      if (!tail) {
        var lsAcct = localStorage.getItem('dgj_lastAccount');
        if (lsAcct) { tail = lsAcct; console.log('[RESOLVE] Found account from localStorage: ' + lsAcct); }
      }
      // Also try combined detection
      if (!platformName || !tail) {
        var lsDetect = JSON.parse(localStorage.getItem('dgj_lastDetect') || '{}');
        if (!platformName && lsDetect.p) { platformName = lsDetect.p; console.log('[RESOLVE] Found platform from dgj_lastDetect: ' + lsDetect.p); }
        if (!tail && lsDetect.a) { tail = lsDetect.a; console.log('[RESOLVE] Found account from dgj_lastDetect: ' + lsDetect.a); }
      }
    } catch(lsErr) {}
  }
  // V20.17.7: 使用V20.28.12的zone使用逻辑
  if (tail && platformName && typeof TK_ACCOUNTS !== 'undefined') {
    var _requiresSubZone = false;
    TK_ACCOUNTS.forEach(function(acct) {
      if (acct.tail !== tail) return;
      var baseName = String(platformName).replace(/(一区|二区)$/, '');
      if (acct.platforms.some(function(p) {
        return p === baseName + '一区' || p === baseName + '二区';
      })) _requiresSubZone = true;
    });
    if (_requiresSubZone) {
      var _freshZone = '';
      var _freshZoneTime = 0;
      if (pageZoneInfo && (pageZoneInfo.zone === '一区' || pageZoneInfo.zone === '二区')) {
        _freshZone = pageZoneInfo.zone;
        _freshZoneTime = Date.now();
      }
      try {
        if (!_freshZone) _freshZone = localStorage.getItem('dgj_currentZone') || '';
        if (!_freshZoneTime) _freshZoneTime = parseInt(localStorage.getItem('dgj_zoneTime') || '0', 10);
      } catch (_zoneReadErr) {}
      var _freshZoneOk = (_freshZone === '一区' || _freshZone === '二区')
        && _freshZoneTime > 0 && (Date.now() - _freshZoneTime) < 600000;
      if (_freshZoneOk) {
        var _baseName = String(platformName).replace(/(一区|二区)$/, '');
        platformName = _baseName + _freshZone;
        console.log('[RESOLVE] Zone confirmed: ' + platformName);
      }
    }
  }
  
  // V20.10.2: Zone inference fallback for accounts with sub-zones
  // When zone detection fails (e.g. platformName = '抖音'), check existing records
  // to infer which zone this scrape belongs to, preventing cross-zone data loss
  if (tail && platformName) {
    var _needsZone = false;
    TK_ACCOUNTS.forEach(function(acct) {
      if (acct.tail !== tail) return;
      var _subZones = acct.platforms.filter(function(p) {
        return p.indexOf(platformName) === 0 && p.length > platformName.length;
      });
      if (_subZones.length > 0) _needsZone = true;
    });
    if (_needsZone) {
      try {
        var _zoneKey = 'dgjZoneHistory_' + tail;
        var _zoneHist = JSON.parse(localStorage.getItem(_zoneKey) || '{}');
        // V20.12.42: Find the zone with suffix (一区/二区) first, then fallback to any
        var _bestZone = '', _bestTime = 0;
        var _bestZoneWithSuffix = '', _bestTimeWithSuffix = 0;
        Object.keys(_zoneHist).forEach(function(z) {
          // v20.12.32: Only consider zones that belong to the detected platform
          if (z.indexOf(platformName) !== 0) return;
          // Prefer zones with suffix (一区/二区) over plain platform name
          var hasSuffix = z.length > platformName.length;
          if (hasSuffix && _zoneHist[z] > _bestTimeWithSuffix) {
            _bestTimeWithSuffix = _zoneHist[z];
            _bestZoneWithSuffix = z;
          }
          if (_zoneHist[z] > _bestTime) { _bestTime = _zoneHist[z]; _bestZone = z; }
        });
        // Prefer zone with suffix if available
        if (_bestZoneWithSuffix) {
          _bestZone = _bestZoneWithSuffix;
          _bestTime = _bestTimeWithSuffix;
        }
        // Only use inferred zone if it was active within the last 30 minutes
        if (_bestZone && (Date.now() - _bestTime) < 1800000) {
          platformName = _bestZone;
          L('[分区推断] 从近期操作推断分区: ' + _bestZone, 'i');
        }
      } catch(e) {}
    }
  }

  var finalResult = tail && platformName ? platformName + '-【' + tail + '】' : '';
  console.log('[RESOLVE] Final: tail=' + tail + ' platformName=' + platformName + ' -> ' + (finalResult || 'EMPTY'));
  
  // V20.16.1: Save resolved platform to localStorage for future reference
  if (platformName) {
    try {
      localStorage.setItem('dgj_lastPlatform', platformName);
      localStorage.setItem('dgj_lastDetect', JSON.stringify({p:platformName, a:tail||'', ts:Date.now()}));
      if (tail) localStorage.setItem('dgj_lastAccount', tail);
      // Save zone history if platform has zone suffix
      if (platformName.indexOf('一区') >= 0 || platformName.indexOf('二区') >= 0) {
        var _zhKey = 'dgjZoneHistory_' + (tail || 'unknown');
        var _zh = JSON.parse(localStorage.getItem(_zhKey) || '{}');
        _zh[platformName] = Date.now();
        localStorage.setItem(_zhKey, JSON.stringify(_zh));
      }
    } catch(_saveErr) {}
  }
  
  return finalResult;
}

// Collect rows from the currently visible product frame(s). Exact copies from
// another frame are ignored; conflicting copies fail closed instead of silently
// taking whichever frame Chrome happened to return first.
function collectScrapedFrameItems(frameResults) {
  var candidates = (frameResults || []).filter(function(frame) {
    var result = frame && frame.result ? frame.result : null;
    return result && Array.isArray(result.items) && result.items.length > 0;
  });
  var visible = candidates.filter(function(frame) {
    return frame.result.tableVisible !== false;
  });
  var selected = visible.length ? visible : candidates;
  var output = [], firstByKey = {}, duplicateCount = 0, conflicts = [];

  selected.forEach(function(frame, frameIndex) {
    var frameId = frame && frame.frameId !== undefined ? frame.frameId : frameIndex;
    (frame.result.items || []).forEach(function(item) {
      var specs = (item.specs || []).map(function(spec) {
        return {name:String(spec.name || '').trim(), qty:Number(spec.qty) || 0};
      }).sort(function(a, b) { return a.name.localeCompare(b.name); });
      var identity = String(item.productId || '').trim()
        || ('TITLE:' + normTitle(item.title || ''));
      var specNames = specs.map(function(spec) { return spec.name; }).join('|');
      var key = identity + '::' + specNames;
      var fingerprint = normTitle(item.title || '') + '::'
        + specs.map(function(spec) { return spec.name + '=' + spec.qty; }).join('|');
      var prior = firstByKey[key];
      if (prior && prior.frameId !== frameId) {
        if (prior.fingerprint === fingerprint) {
          duplicateCount++;
          return;
        }
        conflicts.push({
          productId:item.productId || '',
          title:item.title || '',
          firstFrame:prior.frameId,
          secondFrame:frameId
        });
        return;
      }
      if (!prior) firstByKey[key] = {frameId:frameId, fingerprint:fingerprint};
      item._dgjFrameId = frameId;
      output.push(item);
    });
  });

  if (conflicts.length) {
    var first = conflicts[0];
    throw new Error('跨框架数据冲突：商品ID '
      + (first.productId || '未知') + ' 在框架 ' + first.firstFrame
      + ' 与 ' + first.secondFrame + ' 的标题、规格或数量不一致');
  }
  return {
    items:output,
    duplicateCount:duplicateCount,
    selectedFrames:selected.length,
    dataFrames:candidates.length
  };
}

// ====== AFTERNOON RETURN MODE ======
var _forcedReturnTabId = 0;
var _forcedReturnExpectedPlatform = '';
var _lastReturnWorkflowResult = null;
var _incrementalReturnMode = false;  // v20.7.5: append specs instead of replace
function returnToFeishu(hasAttach, options) {
  options = options || {};
  invalidateDataCache(); // V20.11.0: Fresh read for this operation
  return new Promise(function(resolve) {
    chrome.runtime.sendMessage({type:'keepAlive', enable:true});
    function receiveTabs(callback) {
      if (options.tabId) {
        chrome.tabs.get(options.tabId, function(tab) {
          if (chrome.runtime.lastError || !tab) callback([]);
          else callback([tab]);
        });
        return;
      }
      chrome.tabs.query({active:true,currentWindow:true}, callback);
    }
    receiveTabs(function(tabs) {
      if (!tabs||!tabs.length) { L('无标签页','e'); resolve({ok:false}); return; }
      var tabId = tabs[0].id;
      var activeUrl = String(tabs[0].url || '');
      if (!/^https:\/\/[^/]*dgjapp\.com\/Common\/Page\/Purchases-Index/i.test(activeUrl)) {
        L('手动下午回传已停止：请先切换到对应店管家的“备货单”页面，再点击下午回传','e');
        resolve({ok:false, reason:'manual_return_requires_active_dgj_purchase_page'});
        return;
      }
      L('=== 下午回传模式' + (_incrementalReturnMode ? '（增量）' : '') + ' ===', 'i');
      L('检测页面: '+(tabs[0].url||'').substring(0,80),'i');
      L('等待页面加载...','i');

      setTimeout(function() {
        L('抓取已打单数据...','i');
        // V20.16.4: 改进platformHint设置逻辑，优先匹配带zone的平台
        var _returnHint = '';
        var _retTabTitle = String(tabs[0].title || '');
        // 优先匹配带zone的平台（抖音一区、抖音二区）
        var _RET_HINT_ZONE = ['抖音一区','抖音二区'];
        var _RET_HINT_ALL = ['微信小店','快手小店','拼多多','京东','淘宝','抖音'];
        // 先尝试匹配带zone的平台
        for (var _rhi = 0; _rhi < _RET_HINT_ZONE.length; _rhi++) {
          if (_retTabTitle.indexOf(_RET_HINT_ZONE[_rhi]) >= 0) { _returnHint = _RET_HINT_ZONE[_rhi]; break; }
        }
        // 如果没有匹配到带zone的平台，再尝试匹配其他平台
        if (!_returnHint) {
          for (var _rhi2 = 0; _rhi2 < _RET_HINT_ALL.length; _rhi2++) {
            if (_retTabTitle.indexOf(_RET_HINT_ALL[_rhi2]) >= 0) { _returnHint = _RET_HINT_ALL[_rhi2]; break; }
          }
        }
        // V20.12.62: Detect zone from parent frame BEFORE running scraper
        // The zone tabs (一区/二区) are in the parent frame, not the data iframe
        chrome.scripting.executeScript({
          target:{tabId:tabId}, world:"MAIN",
          func: function() {
            var zone = '';
            try {
              var els = document.querySelectorAll('span, a, div, button, li, [role="tab"]');
              for (var i = 0; i < els.length; i++) {
                var t = els[i].textContent.trim();
                if (t !== '一区' && t !== '二区') continue;
                var el = els[i];
                var active = el.classList.contains('is-active') || el.classList.contains('active')
                  || el.classList.contains('selected') || el.getAttribute('aria-selected') === 'true'
                  || el.classList.contains('current') || el.classList.contains('cur')
                  || window.getComputedStyle(el).fontWeight >= 700;
                if (!active && el.parentElement) {
                  var p = el.parentElement;
                  active = p.classList.contains('is-active') || p.classList.contains('active') || p.classList.contains('selected');
                }
                if (!active && el.parentElement && el.parentElement.parentElement) {
                  var p2 = el.parentElement.parentElement;
                  active = p2.classList.contains('is-active') || p2.classList.contains('active');
                }
                if (active) { zone = t; break; }
                if (!zone) zone = t;
              }
            } catch(e) {}
            if (zone) {
              localStorage.setItem('dgj_currentZone', zone);
              localStorage.setItem('dgj_zoneTime', String(Date.now()));
            }
            return zone;
          }
        }).then(function(zoneResult) {
          var detectedZone = (zoneResult && zoneResult[0]) ? zoneResult[0].result : '';
          if (detectedZone) L('[分区] 父框架检测到: ' + detectedZone, 'i');
          else L('[分区] 父框架未检测到zone标识', 'w');
          
          // 然后在所有iframe中执行DGJ_SCRAPER
          return chrome.scripting.executeScript({
            target:{tabId:tabId, allFrames:true}, world:"MAIN",
            func:DGJ_SCRAPER, args:[_returnHint]
          }).then(function(results) {
            var confirmedPlatform = resolveConfirmedPlatform(tabs[0].title, results, tabs[0].url, {zone: detectedZone});
          if (!confirmedPlatform) {
            L('无法确认平台账号，已停止回传：不会创建平台为空的记录','e');
            resolve({ok:false});
            return;
          }
          if (options.expectedPlatform && confirmedPlatform !== options.expectedPlatform) {
            L('自动化安全停止：页面平台 ' + confirmedPlatform
              + ' 与任务平台 ' + options.expectedPlatform + ' 不一致', 'e');
            resolve({ok:false, reason:'platform_mismatch', platform:confirmedPlatform});
            return;
          }
          L('确认平台: '+confirmedPlatform, 'ok');
          // V20.10.2: Record confirmed platform zone for fallback inference
          try {
            var _crPlat = confirmedPlatform.split('-【')[0].trim();
            var _crTail = (confirmedPlatform.match(/【(\d+)】/) || [])[1] || '';
            if (_crPlat && _crTail) {
              var _crKey = 'dgjZoneHistory_' + _crTail;
              var _crHist = JSON.parse(localStorage.getItem(_crKey) || '{}');
              _crHist[_crPlat] = Date.now();
              localStorage.setItem(_crKey, JSON.stringify(_crHist));
            }
          } catch(cre) {}

          var collected = collectScrapedFrameItems(results);
          var allItems = collected.items;

          // A child frame cannot see the top account header.  The top-level value
          // is authoritative for every row in this one import/return operation.
          allItems.forEach(function(item) { item.platform = confirmedPlatform; });

          L('脚本执行完成, 扫描框架: '+(results?results.length:0)
            +' 个，采用数据框架: '+collected.selectedFrames+'/'+collected.dataFrames,'i');
          L('原始抓取: '+allItems.length+' 条记录','i');
          L('检测平台: '+confirmedPlatform, 'i');

          if (allItems.length === 0) { L('未检测到备货单数据','e'); resolve({ok:false}); return; }

          if (collected.duplicateCount) {
            L('跨帧去重: 去除 '+collected.duplicateCount+' 条完全一致的镜像记录','w');
          }

          var scraped = mergeItems(allItems);
          // v19.77.1: Count unique PIDs (same PID with different specs is expected)
          var uniquePids = {};
          scraped.forEach(function(m) {
            (m.productId||'').split(/[\n,]/).forEach(function(p) { p=p.trim(); if(p) uniquePids[p]=1; });
          });
          L('DOM内合并: '+allItems.length+' 条 -> '+scraped.length+' 条 ('+Object.keys(uniquePids).length+'个商品)','i');
          setStat(scraped.length, 0);

          L('获取中转站全部记录...','i');
          fetchAllRecordsForReturn().then(function(existing) {
            L('中转站现有: '+existing.length+' 条记录','i');

            // Detect target table fields
            L('检测目标表字段...','i');
            detectTableFields(AT, (typeof TT !== 'undefined' ? TT : PROC_TABLE)).then(function(fieldMap) {
              var fNames = Object.keys(fieldMap);
              L('目标表字段: '+fNames.length+' 个','i');

              // Resolve field names
              var F_TITLE = resolveField(fieldMap, ['📡 商品全称', '商品全称']);
              var F_PID = resolveField(fieldMap, ['🔗 商品ID', '商品 🆔', '商品ID', '商品 ID']);
              var F_SPEC = resolveField(fieldMap, ['🚧 ❗【时段】产品需求值', '❗【时段】产品需求值', '产品需求值']);
              var F_IMG = resolveField(fieldMap, ['🖼 产品图URL', '图片URL', '【图片URL】']);
              var F_STATUS = resolveField(fieldMap, ['手动传输状态', '状态', '🚃 状态🌅', '传输状态']);
              var F_DATE = resolveField(fieldMap, ['📅 抓取日期', '创建时间', '🏗 【创建/绑定】日期', '创建时间引导']);
              var F_QTY = resolveField(fieldMap, ['📊 实际打单数', '实际打单数']);
              var F_RETURN = resolveField(fieldMap, ['🕐 回传时间', '回传时间']);
              var F_PLATFORM = resolveField(fieldMap, ['平台所属账号', '平台【文字】', '平台', '平台文字']);

              L('字段映射: QTY='+(F_QTY||'MISS')+' RETURN='+(F_RETURN||'MISS')+' STATUS='+(F_STATUS||'MISS')+' IMG='+(F_IMG||'MISS')+' PLATFORM='+(F_PLATFORM||'MISS'),'i');
              L('可用字段: '+fNames.join(', '),'i');
              if (!F_TITLE || !F_PID || !F_SPEC || !F_STATUS || !F_DATE || !F_PLATFORM) {
                throw new Error('下午回传缺少必需字段：标题、商品ID、规格、状态、日期、平台必须存在');
              }

              // Afternoon actual is a same-day snapshot. Historical rows must
              // never enter the candidate index, even when they share a PID.
              var todayExisting = existing.filter(function(rec) {
                return isTodayBusinessValue((rec.fields || {})[F_DATE]);
              });
              L('中转站今日候选: ' + todayExisting.length + ' 条（历史记录不参与下午匹配）', 'i');

              // v19.77.1: Build lookup maps with spec-aware matching
              var byPid = {}, byPidSpec = {}, byTitle = {};
              todayExisting.forEach(function(rec) {
                var f = rec.fields || {};
                var pid = sv(f[F_PID]) || '';
                var title = sv(f[F_TITLE]) || '';
                var spec = F_SPEC ? (sv(f[F_SPEC]) || '') : '';
                if (pid) {
                  pid.split(/[\n,]/).forEach(function(p) {
                    p = p.trim();
                    if (p) {
                      // v19.92.0: Store ALL records per PID (not just first)
                      if (!byPid[p]) byPid[p] = [];
                      byPid[p].push(rec);
                      // Store by (PID + first spec line) for precise matching
                      if (spec) {
                        var firstSpec = spec.split('\n')[0].trim();
                        if (firstSpec) {
                          var specKey = p + '::' + firstSpec;
                          if (!byPidSpec[specKey]) byPidSpec[specKey] = [];
                          byPidSpec[specKey].push(rec);
                        }
                      }
                    }
                  });
                }
                if (title) {
                  var tn = norm(title);
                  if (!byTitle[tn]) byTitle[tn] = [];
                  byTitle[tn].push(rec);
                }
              });

              // Match — deduplicate by record_id (one update per existing record)
              var updates = [], creates = [], fuzzyMatches = 0;
              var seenRecords = {};  // v19.92.0: prevent duplicate updates for same record
              var mergedDuplicateQty = 0;  // v20.7.3: track qty absorbed by seenRecords dedup
              var appendedOldSpecQty = 0;  // v20.7.4: track old spec qty appended in re-returns
              scraped.forEach(function(item) {
                var result = matchRecord(item.productId, item.title, {byPid: byPid, byPidSpec: byPidSpec, byTitle: byTitle}, item.platform || "");
                var matched = result ? result.rec : null;
                var matchType = result ? result.type : '';
                if (matched && matchType === 'TITLE') {
                  var sourceExistingProfile = {
                    title:sv((matched.fields || {})[F_TITLE]),
                    spec:sv((matched.fields || {})[F_SPEC])
                  };
                  var sourceIncomingProfile = {title:item.title || '', spec:item.specStr || ''};
                  if (procurementFamilyConflict(sourceIncomingProfile, sourceExistingProfile)
                      || procurementModelConflict(sourceIncomingProfile, sourceExistingProfile)) {
                    matched = null;
                    matchType = '';
                  }
                }
                if (matchType === 'FUZZY') {
                  // 下午实际数据不能靠模糊标题覆盖旧记录；宁可新建待人工核对，
                  // 也不能把真实数量写进相似但不同的商品。
                  fuzzyMatches++;
                  matched = null;
                  matchType = '';
                }
                if (matched && item.platform) {
                  var matchedFields = matched.fields || {};
                  var matchedPlatform = sv(matchedFields[F_PLATFORM]) || '';
                  var matchedPlatforms = String(matchedPlatform).split(/[\n,]/).map(function(p){return p.trim();}).filter(Boolean);
                  // V20.16.0: 安全隔离 — 跨平台记录改为新建
                  // 原因：多平台连续回传时，合并会导致后回传的平台覆盖先回传的规格
                  // 采购表由 syncToProcurement 按平台独立更新，数据准确
                  if (matchedPlatforms.length !== 1 || matchedPlatforms[0] !== item.platform) {
                    L('安全隔离：命中跨平台/历史合并记录，处理当前平台：' + item.platform, 'w');
                    // 记录需要从跨平台记录中移除的平台
                    matched._removePlatform = item.platform;
                    // 尝试匹配同平台的单平台记录
                    var samePlatformResult = matchRecord(item.productId, item.title, {byPid: byPid, byPidSpec: byPidSpec, byTitle: byTitle}, item.platform);
                    var samePlatformMatched = samePlatformResult ? samePlatformResult.rec : null;
                    var samePlatformMatchType = samePlatformResult ? samePlatformResult.type : '';
                    // 检查匹配到的记录是否确实是当前平台
                    if (samePlatformMatched) {
                      var spFields = samePlatformMatched.fields || {};
                      var spPlatform = sv(spFields[F_PLATFORM]) || '';
                      var spPlatforms = String(spPlatform).split(/[\n,]/).map(function(p){return p.trim();}).filter(Boolean);
                      if (spPlatforms.length === 1 && spPlatforms[0] === item.platform) {
                        // 匹配到同平台单平台记录，使用它
                        matched = samePlatformMatched;
                        matchType = samePlatformMatchType;
                        L('安全隔离：匹配到同平台单平台记录，将更新', 'i');
                      } else {
                        // 匹配到的还是跨平台记录，新建
                        matched = null;
                        matchType = '';
                        L('安全隔离：未找到同平台单平台记录，新建', 'w');
                      }
                    } else {
                      // 没有匹配到，新建
                      matched = null;
                      matchType = '';
                      L('安全隔离：未找到同平台记录，新建', 'w');
                    }
                  }
                }
                if (matched) {
                  var rid = matched.record_id;
                  if (seenRecords[rid]) {
                    // Same record already matched — merge spec into first match's item
                    var first = updates.find(function(u) { return u.record_id === rid; });
                    if (first && item.specStr) {
                      first.item.specStr = (first.item.specStr || '') + '\n' + item.specStr;
                      first.item.productId = (first.item.productId || '') + '\n' + (item.productId || '');
                    }
                    // v20.7.3: Track qty of absorbed duplicate for conservancy check
                    mergedDuplicateQty += procurementSpecQtyTotal(item.specStr || '');
                    return;  // skip duplicate update
                  }
                  seenRecords[rid] = 1;
                  updates.push({record_id: rid, item: item, matchType: matchType, rec: matched});
                } else {
                  creates.push(item);
                }
              });

              // The afternoon page is the authoritative actual snapshot for
              // this one platform account. Morning rows from this platform that
              // are absent now must leave the transfer source; otherwise they
              // continue to inflate procurement demand. Other platforms are
              // never touched.
              var staleSourceIds = selectStalePlatformSourceIds(
                todayExisting, F_PLATFORM, confirmedPlatform, seenRecords, F_DATE
              , F_STATUS);
              // v20.12.58: Never delete 中转站 records that are still "未打单".
              // These are morning estimates that have not been printed yet. The
              // product may be printed later in the day or the next day. If we
              // delete them, the procurement table status can never be updated
              // from "未打单" to "已打单" because there's no 中转站 source left.
              if (staleSourceIds.length > 0) {
                var staleIdSet = {};
                staleSourceIds.forEach(function(id) { staleIdSet[id] = 1; });
                var statusLookup = {};
                todayExisting.forEach(function(rec) {
                  var rf = rec.fields || {};
                  statusLookup[rec.record_id] = sv(rf[F_STATUS]) || sv(rf['手动传输状态']) || sv(rf['状态']) || sv(rf['传输状态']) || '';
                });
                var beforeCount = staleSourceIds.length;
                staleSourceIds = staleSourceIds.filter(function(id) {
                  var st = statusLookup[id] || '';
                  if (st !== '已打单') {
                    // Keep: this record is still a morning estimate, not yet printed.
                    // It may be matched by a future afternoon return.
                    return false;
                  }
                  return true;
                });
                var preserved = beforeCount - staleSourceIds.length;
                if (preserved > 0) {
                  L('[安全] 保留 ' + preserved + ' 条未打单上午预估（等待后续回传更新状态）', 'i');
                }
              }
              // v20.7.5: Incremental mode only processes a subset — never delete
              // records that aren't in this scrape (they're from an earlier return).
              if (_incrementalReturnMode && staleSourceIds.length > 0) {
                L('[增量] 跳过移除未打印预估: ' + staleSourceIds.length + ' 条（增量模式不删除已有记录）', 'i');
                staleSourceIds = [];
              }

              L('--- 匹配结果 ---', 'i');
              L('匹配成功: '+updates.length+' 条', 'i');
              L('  PID精确: '+updates.filter(function(u){return u.matchType==='PID'}).length+' 条', 'i');
              L('  标题精确: '+updates.filter(function(u){return u.matchType==='TITLE'}).length+' 条', 'i');
                L('  标题模糊候选(不自动覆盖): '+fuzzyMatches+' 条', fuzzyMatches ? 'w' : 'i');
              L('未匹配新增: '+creates.length+' 条', 'i');
              L('当前平台上午预估未出现在已打印实际: ' + staleSourceIds.length
                + ' 条（前置写入成功后从中转站移除）', staleSourceIds.length ? 'w' : 'i');

              // Log spec merge details for matched records
              if (updates.length > 0) {
                var specChanges = 0, specSame = 0, specPreserved = 0;
                updates.forEach(function(u) {
                  var oldSpec = '';
                  var of = u.rec && u.rec.fields ? u.rec.fields : {};
                  if (F_SPEC) {
                    var specRawVal = of[F_SPEC];
                    oldSpec = typeof specRawVal === 'string' ? specRawVal : (Array.isArray(specRawVal) ? specRawVal.map(function(x){return x.text||x;}).join('') : String(specRawVal||''));
                  }
                  if (oldSpec && u.item.specStr && oldSpec !== u.item.specStr) specChanges++;
                  else specSame++;
                  // Count preserved specs (old specs not in new)
                  if (oldSpec) {
                    var oldCount = oldSpec.split('\n').filter(function(l){return l.trim();}).length;
                    var newCount = (u.item.specStr||'').split('\n').filter(function(l){return l.trim();}).length;
                    specPreserved += Math.max(0, oldCount - newCount);
                  }
                });
                L('规格合并: 变更'+specChanges+'条 不变'+specSame+'条', 'i');
                if (specPreserved > 0) L('  上午预估中未打印规格将从该平台实际需求中移除: '+specPreserved+'条', 'i');
              }

              var scrapedQtyTotal = scraped.reduce(function(sum, item) {
                return sum + procurementSpecQtyTotal(item.specStr || '');
              }, 0);
              var returnPlanQtyTotal = updates.reduce(function(sum, op) {
                return sum + procurementSpecQtyTotal((op.item && op.item.specStr) || '');
              }, 0) + creates.reduce(function(sum, item) {
                return sum + procurementSpecQtyTotal(item.specStr || '');
              }, 0);
              // v20.7.3: Adjust scraped total to exclude qty absorbed by seenRecords dedup.
              // Those items' specs are concatenated into existing updates, so their qty is
              // already counted in returnPlanQtyTotal via the merged spec string.
              var effectiveScrapedQty = scrapedQtyTotal - mergedDuplicateQty;
              var effectiveReturnPlanQty = returnPlanQtyTotal - appendedOldSpecQty;
              if (mergedDuplicateQty > 0) {
                L('重复匹配合并: ' + mergedDuplicateQty + ' 数量已并入匹配记录', 'i');
              }
              if (appendedOldSpecQty > 0) {
                L('旧规格追加: ' + appendedOldSpecQty + ' 数量已从守恒检查中扣除', 'i');
              }
              L('下午数量守恒: 页面 ' + effectiveScrapedQty + ' = 回传计划 ' + effectiveReturnPlanQty, 'i');
              if (Math.abs(effectiveScrapedQty - effectiveReturnPlanQty) > 0.000001) {
                throw new Error('下午回传数量守恒失败：页面=' + effectiveScrapedQty
                  + '，写入计划=' + effectiveReturnPlanQty + '；本次停止');
              }

              if (updates.length === 0 && creates.length === 0 && staleSourceIds.length === 0) {
                L('无需操作','i'); resolve({ok:true, updated:0, created:0, platform:confirmedPlatform}); return;
              }

              // Execute
              var chain = Promise.resolve();
              var now = Date.now();

              // PATCH updates
              for (var i = 0; i < updates.length; i += BATCH_SIZE) {
                (function(batch) {
                  chain = chain.then(function() {
                    var recs = batch.map(function(u) {
                      var f = {};
                      // v20.7.5: Toggle-based spec append. Incremental mode appends;
                      // default mode replaces (authoritative afternoon snapshot).
                      if (F_SPEC && u.item.specStr) {
                        if (_incrementalReturnMode) {
                          var oldSpec2 = '';
                          var _recf2 = u.rec && u.rec.fields ? u.rec.fields : {};
                          var _sv2 = _recf2[F_SPEC];
                          oldSpec2 = typeof _sv2 === 'string' ? _sv2 : (Array.isArray(_sv2) ? _sv2.map(function(x){return x.text||x;}).join('') : String(_sv2||''));
                          if (oldSpec2) {
                            f[F_SPEC] = oldSpec2 + '\n' + u.item.specStr;
                            appendedOldSpecQty += procurementSpecQtyTotal(oldSpec2);
                            L('[增量] ' + (u.item.title||'').substring(0,20) + ': 新规格已追加', 'i');
                          } else {
                            f[F_SPEC] = u.item.specStr;
                          }
                        } else {
                          f[F_SPEC] = u.item.specStr;
                        }
                      }
                      // Update status
                      if (F_STATUS) f[F_STATUS] = '已打单';
                      // Backfill this import's platform while preserving any
                      // platforms merged from earlier morning imports.
                      // v19.92.0: Skip Person fields (type 20) for platform
                      if (F_PLATFORM && u.item.platform) {
                        var _pft4 = fieldMap[F_PLATFORM] ? fieldMap[F_PLATFORM].type : 0;
                        if (_pft4 !== 20 && _pft4 !== 1001) {
                          var oldPlatform = u.rec && u.rec.fields ? u.rec.fields[F_PLATFORM] : '';
                          f[F_PLATFORM] = dedupPlatform(mergePlatformFieldsForReturn(oldPlatform, u.item.platform));
                        }
                      }
                      // v19.92.0: Also populate 平台 and 店管家 select fields (avoid collision with F_PLATFORM)
                      var F_PLAT_SEL3 = resolveField(fieldMap, ['平台']);
                      if (F_PLAT_SEL3 && F_PLAT_SEL3 !== F_PLATFORM && u.item.platform) {
                        var _pt3 = fieldMap[F_PLAT_SEL3] ? fieldMap[F_PLAT_SEL3].type : 0;
                        if (_pt3 !== 20 && _pt3 !== 1001) { var platName3 = u.item.platform.split('-【')[0].trim(); if (platName3) f[F_PLAT_SEL3] = platName3; }
                      }
                      var F_DGJ3 = resolveField(fieldMap, ['店管家']);
                      if (F_DGJ3 && u.item.platform) {
                        var _dt3 = fieldMap[F_DGJ3] ? fieldMap[F_DGJ3].type : 0;
                        if (_dt3 !== 20 && _dt3 !== 1001) { var dgjMatch3 = u.item.platform.match(/【(\d{4})】/); if (dgjMatch3) f[F_DGJ3] = dgjMatch3[1]; }
                      }
                      // Calculate total qty from merged spec (all platforms)
                      var mergedSpecStr = f[F_SPEC] || u.item.specStr || '';
                      var qty = mergedSpecStr.split('\n').reduce(function(sum, line) {
                        var parts = line.split(';');
                        return sum + (parts.length >= 2 ? Number(parts[parts.length-1]) || 0 : 0);
                      }, 0);
                      if (F_QTY) f[F_QTY] = qty;
                      if (F_RETURN) f[F_RETURN] = now;
                      return {record_id: u.record_id, fields: f, _qty: qty, _matchType: u.matchType};
                    });
                    return getToken().then(function(t) {
                      return feishuProxy(
                        'https://open.feishu.cn/open-apis/bitable/v1/apps/'+AT+'/tables/'+(typeof TT !== 'undefined' ? TT : PROC_TABLE)+'/records/batch_update',
                        'POST', {'Authorization':'Bearer '+t,'Content-Type':'application/json'},
                        JSON.stringify({records: recs})
                      ).then(function(d) {
                        if (d.code === 0) {
                          updateOk += recs.length;
                          L('更新批次: '+recs.length+' 条','ok');
                        } else {
                          L('更新错误: '+d.code+' '+d.msg,'e');
                          throw new Error('下午回传更新失败: '+d.code+' '+d.msg);
                        }
                      });
                    });
                  });
                })(updates.slice(i, i + 100));
              }
              
              // V20.16.0: 处理跨平台记录的平台移除
              var crossPlatformUpdates = [];
              updates.forEach(function(u) {
                if (u.rec && u.rec._removePlatform) {
                  var recFields = u.rec.fields || {};
                  var currentPlatform = sv(recFields[F_PLATFORM]) || '';
                  var platforms = String(currentPlatform).split(/[\n,]/).map(function(p){return p.trim();}).filter(Boolean);
                  var removePlatform = u.rec._removePlatform;
                  // 移除当前平台
                  var newPlatforms = platforms.filter(function(p) { return p !== removePlatform; });
                  if (newPlatforms.length < platforms.length) {
                    crossPlatformUpdates.push({
                      record_id: u.rec.record_id,
                      fields: {}
                    });
                    crossPlatformUpdates[crossPlatformUpdates.length - 1].fields[F_PLATFORM] = newPlatforms.join('\n');
                    L('跨平台记录移除平台: ' + removePlatform + '，剩余: ' + newPlatforms.join(', '), 'i');
                  }
                }
              });
              // 批量更新跨平台记录
              if (crossPlatformUpdates.length > 0) {
                for (var ci = 0; ci < crossPlatformUpdates.length; ci += 100) {
                  (function(batch) {
                    chain = chain.then(function() {
                      return getToken().then(function(t) {
                        return feishuProxy(
                          'https://open.feishu.cn/open-apis/bitable/v1/apps/'+AT+'/tables/'+(typeof TT !== 'undefined' ? TT : PROC_TABLE)+'/records/batch_update',
                          'POST', {'Authorization':'Bearer '+t,'Content-Type':'application/json'},
                          JSON.stringify({records: batch})
                        ).then(function(d) {
                          if (d.code === 0) {
                            L('跨平台记录平台移除: '+batch.length+' 条','ok');
                          } else {
                            L('跨平台记录更新警告: '+d.code+' '+d.msg,'w');
                          }
                        });
                      });
                    });
                  })(crossPlatformUpdates.slice(ci, ci + 100));
                }
              }

              var newImgItems = [];
              var sourceImageResult = {imgOk:0, imgFailed:0};
              // POST creates
              for (var i = 0; i < creates.length; i += BATCH_SIZE) {
                (function(batch) {
                  chain = chain.then(function() {
                    var recs = batch.map(function(item) {
                      var f = {};
                      if (F_TITLE) f[F_TITLE] = item.title || '';
                      if (F_PID) f[F_PID] = item.productId || '';
                      if (F_SPEC) f[F_SPEC] = item.specStr || '';
                      if (F_IMG && item.imgSrc && item.imgSrc.indexOf('http') === 0) f[F_IMG] = formatFieldValue(item.imgSrc, fieldMap[F_IMG] ? fieldMap[F_IMG].type : 1, F_IMG);
                      if (F_STATUS) f[F_STATUS] = '已打单';
                      // v19.92.0: Only write timestamp to actual date fields
                      if (F_DATE && F_DATE !== '创建时间引导') { var fdt = fieldMap[F_DATE] ? fieldMap[F_DATE].type : 0; if (fdt === 5 || fdt === 23 || fdt === 24 || fdt === 0) f[F_DATE] = now; else f[F_DATE] = new Date().toISOString().split('T')[0]; }
                      // v19.92.0: Skip Person fields (type 20) for platform
                      if (F_PLATFORM && item.platform) {
                        var _pft5 = fieldMap[F_PLATFORM] ? fieldMap[F_PLATFORM].type : 0;
                        if (_pft5 !== 20 && _pft5 !== 1001) f[F_PLATFORM] = dedupPlatform(item.platform);
                      }
                      // v19.92.0: Also populate 平台 and 店管家 select fields (avoid collision with F_PLATFORM)
                      var F_PLAT_SEL2 = resolveField(fieldMap, ['平台']);
                      if (F_PLAT_SEL2 && F_PLAT_SEL2 !== F_PLATFORM && item.platform) {
                        var _pt2 = fieldMap[F_PLAT_SEL2] ? fieldMap[F_PLAT_SEL2].type : 0;
                        if (_pt2 !== 20 && _pt2 !== 1001) { var platName2 = item.platform.split('-【')[0].trim(); if (platName2) f[F_PLAT_SEL2] = platName2; }
                      }
                      var F_DGJ2 = resolveField(fieldMap, ['店管家']);
                      if (F_DGJ2 && item.platform) {
                        var _dt2 = fieldMap[F_DGJ2] ? fieldMap[F_DGJ2].type : 0;
                        if (_dt2 !== 20 && _dt2 !== 1001) { var dgjMatch2 = item.platform.match(/【(\d{4})】/); if (dgjMatch2) f[F_DGJ2] = dgjMatch2[1]; }
                      }
                      return {fields: f};
                    });
                    return getToken().then(function(t) {
                      return feishuProxy(
                        'https://open.feishu.cn/open-apis/bitable/v1/apps/'+AT+'/tables/'+(typeof TT !== 'undefined' ? TT : PROC_TABLE)+'/records/batch_create',
                        'POST', {'Authorization':'Bearer '+t,'Content-Type':'application/json'},
                        JSON.stringify({records: recs})
                      ).then(function(d) {
                        if (d.code === 0) {
                          createOk += batch.length;
                          L('新增批次: '+batch.length+' 条','ok');
                          if (d.data && d.data.records) {
                            d.data.records.forEach(function(r, idx) {
                              if (batch[idx] && batch[idx].imgSrc && batch[idx].imgSrc.indexOf('http') === 0) {
                                newImgItems.push({rid: r.record_id, img: batch[idx].imgSrc, pid: batch[idx].productId || ''});
                              }
                            });
                          } else {
                            L('[WARN] 新增批次返回无records数组', 'w');
                          }
                        } else {
                          L('新增错误: '+d.code+' '+d.msg,'e');
                          if (d.data && d.data.records) {
                            d.data.records.forEach(function(r,i) {
                              if (r.code !== 0) L('  记录'+(i+1)+': '+r.code+' '+(r.msg||''),'e');
                            });
                          }
                          throw new Error('下午回传新增失败: '+d.code+' '+d.msg);
                        }
                      });
                    });
                  });
                })(creates.slice(i, i + 100));
              }

              var updateOk = 0, createOk = 0, staleDeleteOk = 0;

              // Destructive source cleanup is last and fail-closed. It only
              // runs after all actual updates and creates have succeeded.
              chain = chain.then(function() {
                if (updateOk !== updates.length || createOk !== creates.length) {
                  throw new Error('下午回传前置写入不完整，已取消移除未打印预估行');
                }
                var deleteChain = Promise.resolve();
                for (var di = 0; di < staleSourceIds.length; di += 100) {
                  (function(batch) {
                    deleteChain = deleteChain.then(function() {
                      return getToken().then(function(token) {
                        return feishuProxy(
                          'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/' + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + '/records/batch_delete',
                          'POST', {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
                          JSON.stringify({records:batch})
                        ).then(function(response) {
                          if (response.code !== 0) {
                            throw new Error('移除未打印预估行失败: ' + response.code + ' ' + response.msg);
                          }
                          staleDeleteOk += batch.length;
                          L('移除当前平台未打印预估: ' + batch.length + ' 条', 'i');
                        });
                      });
                    });
                  })(staleSourceIds.slice(di, di + 100));
                }
                return deleteChain;
              });

              // Download images for new records (chained into main flow)
              chain = chain.then(function() {
                if (newImgItems.length > 0) {
                  L('下载新增记录图片: '+newImgItems.length+'张...','i');
                  return downloadImages(newImgItems, (typeof TT !== 'undefined' ? TT : PROC_TABLE)).then(function(imgResult) {
                    sourceImageResult = imgResult || sourceImageResult;
                    L('图片上传: 成功'+imgResult.imgOk+'/'+imgResult.count,'ok');
                  }).catch(function(e) {
                    sourceImageResult = {imgOk:0, imgFailed:newImgItems.length};
                    L('图片下载异常: '+e.message,'w');
                  });
                }
              });
              chain.then(function() {
                if (updateOk !== updates.length || createOk !== creates.length
                    || staleDeleteOk !== staleSourceIds.length) {
                  throw new Error('下午回传写入对账失败：更新 '+updateOk+'/'+updates.length
                    +'，新增 '+createOk+'/'+creates.length
                    +'，移除未打印 '+staleDeleteOk+'/'+staleSourceIds.length);
                }
                L('=== 回传完成 ===', 's');
                L('更新已有: '+updateOk+' 条 | 新增记录: '+createOk
                  +' 条 | 移除未打印预估: '+staleDeleteOk+' 条', 'ok');
                L('中转站总计: '+(existing.length + createOk - staleDeleteOk)+' 条', 'i');
                L('(实际模式: 当前平台已打印规格覆盖上午预估)', 'i');
                resolve({
                  ok:true,
                  updated:updateOk,
                  created:createOk,
                  removedUnprinted:staleDeleteOk,
                  attachmentUpdated:sourceImageResult.imgOk || 0,
                  attachmentFailed:sourceImageResult.imgFailed || 0,
                  platform:confirmedPlatform
                });
              }).catch(function(e) { L('写入异常: '+e.message,'e'); resolve({ok:false}); });
            }).catch(function(e) { L('字段检测失败: '+e.message,'e'); resolve({ok:false}); });
          }).catch(function(e) { L('获取中转站失败: '+e.message,'e'); resolve({ok:false}); });
        }).catch(function(e) { L('抓取异常: '+e.message,'e'); resolve({ok:false}); });
        }); // end zone detection .then()
      }, 2000);
    });
  });
}

function fetchAllRecordsForReturn(forceRefresh) {
  // V20.11.0: Use cache to avoid redundant reads (returnToFeishu → syncToProcurement → verifyUpload)
  return fetchAllRecordsCached(AT, (typeof TT !== 'undefined' ? TT : PROC_TABLE), forceRefresh).then(function(records) {
    // Filter to today only — prevent matching records from other days
    var todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    var todayMs = todayStart.getTime();
    var tomorrowMs = todayMs + 86400000;
    // Never guess from arbitrary fields such as “回传时间”. Use an explicit
    // business-date priority list and fail closed when no valid date exists.
    var dateField = null;
    var dateCandidates = ['🏗 【创建/绑定】日期', '📅 抓取日期', '创建时间'];
    for (var c = 0; c < dateCandidates.length && !dateField; c++) {
      for (var s = 0; s < Math.min(records.length, 50); s++) {
        if (Object.prototype.hasOwnProperty.call(records[s].fields || {}, dateCandidates[c])) {
          dateField = dateCandidates[c];
          break;
        }
      }
    }
    if (!dateField) throw new Error('中转站缺少明确业务日期字段，已停止读取');
    return records.filter(function(rec) {
      var f = rec.fields || {};
      var dateVal = f[dateField];
      if (!dateVal) return false;
      var ts = typeof dateVal === 'number' ? dateVal : 0;
      // v19.92.0: Also parse ISO string dates
      if (ts === 0 && typeof dateVal === 'string') {
        var parsed = Date.parse(dateVal);
        if (!isNaN(parsed)) ts = parsed;
      }
      if (ts === 0) return false;
      return ts >= todayMs && ts < tomorrowMs;
    });
  });
}



// ====== V20.29.6: 已打单补同步 ======
// 下午回传后调用：把中转站今日所有"已打单"记录（含隔离/跨平台/其他平台）补齐到采购表，
// 保证采购员能看到全部已打单数据，零遗漏。
// V20.29.6 重构：不再逐条 upsert（那会绕过合并管线导致采购表巨量增长），
// 而是复用 syncToProcurement 的完整合并管线（PID/标题/智能向量 + 严格校验 +
// 平台归并），只把来源限定为"今日已打单"。合并、单平台、不遗漏、不暴涨 同时成立：
//   - 合并:   同产品跨平台 → 归并为一行（平台换行分隔），与已有采购组匹配则更新
//   - 不遗漏: 每条已打单记录都会进入合并管线，匹配到更新、缺失则新建
//   - 不暴涨: 新建前必经 strictMergeEvidence + 向量合并，未打单采购行不受影响
//   - 安全:   补同步模式（printedOnly）绝不删除、绝不回写状态（见 syncToProcurement）
function syncPrintedToProcurement() {
  L('=== 已打单补同步（复用完整合并管线） ===', 'i');
  return syncToProcurement({printedOnly: true}).then(function(res) {
    // 保持与旧调用点兼容的返回结构（调用点检查 ps.ok === false）
    return res && res.ok ? res : Object.assign({ok:false, reason:'printed_sync_failed'}, res || {});
  }).catch(function(e) {
    L('已打单补同步异常: ' + (e && e.message), 'e');
    return {ok:false, reason:'sync_error'};
  });
}

// ====== DATA VERIFICATION (v19.81.0) ======
// Post-upload verification: catches silent errors
function verifyUpload(scrapedCount, context, platformScope, options) {
  options = options || {};
  var excludedRecordIds = {};
  (options.skippedLegacyRecordIds || []).concat(options.excludedRecordIds || []).forEach(function(id) {
    if (id) excludedRecordIds[String(id)] = true;
  });
  var expectedSafeCount = options.expectedSafeCount !== undefined
    ? Number(options.expectedSafeCount) : Number(scrapedCount);
  if (!isFinite(expectedSafeCount) || expectedSafeCount < 0) expectedSafeCount = 0;
  L('=== 数据校验开始 (' + context + ') ===', 's');
  return getFieldMap().then(function(fm) {
    // Read every page. The old one-page check silently ignored rows after 500,
    // which could falsely report missing data on a large platform.
    return fetchAllRecordsForReturn().then(function(allItems) {
      var FD_SCOPE = resolveField(fm, ['🏗 【创建/绑定】日期', '创建时间引导', '创建时间', '📅 抓取日期']);
      var FPL_SCOPE = resolveField(fm, ['平台所属账号', '平台【文字】', '平台', '平台文字']);
      var items = allItems.filter(function(rec) {
        if (excludedRecordIds[rec.record_id]) return false;
        var fields = rec.fields || {};
        if (FD_SCOPE && !isTodayBusinessValue(fields[FD_SCOPE])) return false;
        if (platformScope && FPL_SCOPE && !matchPlatformAccount(sv(fields[FPL_SCOPE]), platformScope)) return false;
        return true;
      });
      var total = items.length;
      var issues = [];
      var warnings = [];

      // 1. Record count check
      L('校验1: 当前业务范围安全记录数 — 期望=' + expectedSafeCount + ' 飞书=' + total
        + (Object.keys(excludedRecordIds).length ? '（已隔离待清理/legacy=' + Object.keys(excludedRecordIds).length + '）' : ''), 'i');
      if (total < expectedSafeCount) {
        var lost = expectedSafeCount - total;
        issues.push('丢失 ' + lost + ' 条记录 (抓取' + scrapedCount + ' → 飞书' + total + ')');
        L('  ✗ 丢失 ' + lost + ' 条记录!', 'e');
      } else if (total > expectedSafeCount) {
        warnings.push('飞书多出 ' + (total - expectedSafeCount) + ' 条 (可能有残留数据)');
        L('  ⚠ 飞书多出 ' + (total - expectedSafeCount) + ' 条', 'w');
      } else {
        L('  ✓ 记录数一致: ' + total + ' 条', 'ok');
      }

      // 2. Field integrity check
      L('校验2: 字段完整性检查', 'i');
      var FT = resolveField(fm, ['📡 商品全称', '商品全称', '商品标题']);
      var FP = resolveField(fm, ['🔗 商品ID', '商品 🆔', '商品ID', '商品 ID']);
      var FS = resolveField(fm, ['🚧 ❗【时段】产品需求值', '❗【时段】产品需求值', '产品需求值', '规格需求']);
      var emptyTitle = 0, emptyPID = 0, emptySpec = 0, duplicatePID = {};
      for (var i = 0; i < items.length; i++) {
        var fields = items[i].fields || {};
        var title = FT ? (fields[FT] || '') : '';
        var pid = FP ? (fields[FP] || '') : '';
        var spec = FS ? (fields[FS] || '') : '';
        if (!title || title === 'undefined') emptyTitle++;
        if (!pid || pid === 'undefined') emptyPID++;
        if (!spec || spec === 'undefined') emptySpec++;
        if (pid && pid !== 'undefined') {
          if (!duplicatePID[pid]) duplicatePID[pid] = [];
          duplicatePID[pid].push({title: title, spec: spec, idx: i+1});
        }
      }
      if (emptyTitle > 0) { issues.push(emptyTitle + ' 条记录标题为空'); L('  ✗ ' + emptyTitle + ' 条标题为空', 'e'); }
      else L('  ✓ 标题完整: ' + (items.length - emptyTitle) + '/' + items.length, 'ok');
      if (emptyPID > 0) { issues.push(emptyPID + ' 条记录商品ID为空'); L('  ✗ ' + emptyPID + ' 条商品ID为空', 'e'); }
      else L('  ✓ 商品ID完整: ' + (items.length - emptyPID) + '/' + items.length, 'ok');
      if (emptySpec > 0) { warnings.push(emptySpec + ' 条记录规格为空'); L('  ⚠ ' + emptySpec + ' 条规格为空', 'w'); }
      else L('  ✓ 规格完整: ' + (items.length - emptySpec) + '/' + items.length, 'ok');

      // 3. Duplicate PID check (should be merged)
      L('校验3: PID重复检查 (应已合并)', 'i');
      var dupCount = 0;
      for (var pid in duplicatePID) {
        if (duplicatePID[pid].length > 1) {
          var entries = duplicatePID[pid];
          var needsMerge = typeof strictMergeEvidence !== 'function';
          for (var a = 0; !needsMerge && a < entries.length; a++) {
            for (var b = a + 1; b < entries.length; b++) {
              if (strictMergeEvidence(
                entries[a].title, entries[a].spec,
                entries[b].title, entries[b].spec
              )) {
                needsMerge = true;
                break;
              }
            }
          }
          if (needsMerge) {
            dupCount++;
            L('  ⚠ PID=' + pid + ' 有 ' + entries.length + ' 条可合并记录', 'w');
          } else {
            L('  ✓ PID=' + pid + ' 为不同商品身份，安全拆分 ' + entries.length + ' 条', 'ok');
          }
        }
      }
      if (dupCount === 0) L('  ✓ 无未合并的重复PID', 'ok');
      else warnings.push(dupCount + ' 组PID未合并');

      // 4. Image URL check (sample first 10)
      L('校验4: 图片URL检查 (抽样10条)', 'i');
      var FI = resolveField(fm, ['📠 产品图URL', '产品图URL', '图片URL', '【图片URL】']);
      var imgOk = 0, imgBad = 0, imgEmpty = 0;
      var sampleItems = items.slice(0, 10);
      for (var j = 0; j < sampleItems.length; j++) {
        var rawImg = FI ? sampleItems[j].fields[FI] : '';
        var imgVal = '';
        if (rawImg && typeof rawImg === 'object') {
          imgVal = rawImg.link || rawImg.text || rawImg.url || JSON.stringify(rawImg);
        } else {
          imgVal = String(rawImg || '');
        }
        if (!imgVal || imgVal === 'undefined' || imgVal === 'null') { imgEmpty++; continue; }
        if (imgVal.indexOf('http') === 0) imgOk++;
        else { imgBad++; L('  ⚠ 异常URL: ' + imgVal.substring(0, 60), 'w'); }
      }
      L('  有效=' + imgOk + ' 空=' + imgEmpty + ' 异常=' + imgBad, imgBad > 0 ? 'w' : 'ok');

      // 5. Platform check
      L('校验5: 平台字段检查', 'i');
      var FP2 = resolveField(fm, ['平台所属账号', '平台【文字】', '平台', '平台文字']);
      var platformSet = {};
      for (var k = 0; k < items.length; k++) {
        var plat = FP2 ? (items[k].fields[FP2] || '') : '';
        if (plat && plat !== 'undefined') platformSet[plat] = (platformSet[plat] || 0) + 1;
      }
      var platNames = Object.keys(platformSet);
      L('  平台分布: ' + platNames.map(function(p){ return p + '=' + platformSet[p] }).join(', '), 'i');

      // Summary
      L('=== 校验完成 ===', 's');
      if (issues.length === 0 && warnings.length === 0) {
        L('✓ 全部通过! 记录=' + total + ' 平台=' + platNames.length, 'ok');
        return {ok: true, total: total, issues: 0, warnings: 0};
      } else {
        if (issues.length > 0) L('✗ 严重问题 ' + issues.length + ' 个:', 'e');
        issues.forEach(function(is) { L('  → ' + is, 'e'); });
        if (warnings.length > 0) L('⚠ 警告 ' + warnings.length + ' 个:', 'w');
        warnings.forEach(function(w) { L('  → ' + w, 'w'); });
        return {ok: issues.length === 0, total: total, issues: issues.length, warnings: warnings.length, details: issues.concat(warnings)};
      }
    });
  }).catch(function(e) {
    L('校验异常: ' + e.message, 'e');
    return {ok: false, error: e.message};
  });
}


function scrapeAndUpload(hasAttach) {
  return new Promise(function(resolve) {
    chrome.runtime.sendMessage({type:'keepAlive', enable:true});
    chrome.tabs.query({active:true,currentWindow:true}, function(tabs) {
      if (!tabs||!tabs.length) { L('无标签页','e'); resolve({ok:false}); return; }
      var tabId = tabs[0].id;
      L('检测页面: '+(tabs[0].url||'').substring(0,80),'i');
      L('等待页面加载...','i');

      setTimeout(function() {
        L('抓取备货单数据...','i');
        // V20.12.59: Derive platformHint from tab title for fallback detection
        // Include zone suffix (一区/二区) for accounts with sub-zones
        var _scrapeHint = '';
        var _tabTitleStr = String(tabs[0].title || '');
        var _HINT_PLATS_LONG = ['微信小店','快手小店','抖音一区','抖音二区','拼多多','京东','淘宝','抖音'];
        for (var _hi = 0; _hi < _HINT_PLATS_LONG.length; _hi++) {
          if (_tabTitleStr.indexOf(_HINT_PLATS_LONG[_hi]) >= 0) { _scrapeHint = _HINT_PLATS_LONG[_hi]; break; }
        }
        // V20.16.7: Detect zone from parent frame BEFORE running scraper
        var detectedZone = '';
        chrome.scripting.executeScript({
          target:{tabId:tabId}, world:"MAIN",
          func: function() {
            var zone = '';
            try {
              var els = document.querySelectorAll('span, a, div, button, li, [role="tab"]');
              for (var i = 0; i < els.length; i++) {
                var t = els[i].textContent.trim();
                if (t !== '一区' && t !== '二区') continue;
                var el = els[i];
                var active = el.classList.contains('is-active') || el.classList.contains('active')
                  || el.classList.contains('selected') || el.getAttribute('aria-selected') === 'true'
                  || el.classList.contains('current') || el.classList.contains('cur')
                  || window.getComputedStyle(el).fontWeight >= 700;
                if (!active && el.parentElement) {
                  var p = el.parentElement;
                  active = p.classList.contains('is-active') || p.classList.contains('active') || p.classList.contains('selected');
                }
                if (!active && el.parentElement && el.parentElement.parentElement) {
                  var p2 = el.parentElement.parentElement;
                  active = p2.classList.contains('is-active') || p2.classList.contains('active');
                }
                if (active) { zone = t; break; }
                if (!zone) zone = t;
              }
            } catch(e) {}
            if (zone) {
              localStorage.setItem('dgj_currentZone', zone);
              localStorage.setItem('dgj_zoneTime', String(Date.now()));
            }
            return zone;
          }
        }).then(function(zoneResult) {
          detectedZone = (zoneResult && zoneResult[0]) ? zoneResult[0].result : '';
          if (detectedZone) L('[分区] 父框架检测到: ' + detectedZone, 'i');
          else L('[分区] 父框架未检测到zone标识', 'w');
          
          return chrome.scripting.executeScript({
            target:{tabId:tabId, allFrames:true}, world:"MAIN",
            func:DGJ_SCRAPER, args:[_scrapeHint]
          });
        }).then(function(results) {
          var confirmedPlatform = resolveConfirmedPlatform(tabs[0].title, results, tabs[0].url, {zone: detectedZone});
          if (!confirmedPlatform) {
            L('无法确认平台账号，已停止上传：不会创建平台为空的记录','e');
            resolve({ok:false});
            return;
          }
          L('确认平台: '+confirmedPlatform, 'ok');
          // V20.10.2: Record confirmed platform zone for fallback inference
          try {
            var _crPlat2 = confirmedPlatform.split('-【')[0].trim();
            var _crTail2 = (confirmedPlatform.match(/【(\d+)】/) || [])[1] || '';
            if (_crPlat2 && _crTail2) {
              var _crKey2 = 'dgjZoneHistory_' + _crTail2;
              var _crHist2 = JSON.parse(localStorage.getItem(_crKey2) || '{}');
              _crHist2[_crPlat2] = Date.now();
              localStorage.setItem(_crKey2, JSON.stringify(_crHist2));
            }
          } catch(cre2) {}

          var collected = collectScrapedFrameItems(results);
          var allItems = collected.items;
          allItems.forEach(function(item) { item.platform = confirmedPlatform; });

          L('脚本执行完成, 扫描框架: '+(results?results.length:0)
            +' 个，采用数据框架: '+collected.selectedFrames+'/'+collected.dataFrames,'i');
          L('检测平台: '+confirmedPlatform, 'i');
          L('原始抓取: '+allItems.length+' 条记录','i');

          if (allItems.length === 0) { L('未检测到备货单数据','e'); resolve({ok:false}); return; }

          if (collected.duplicateCount) {
            L('跨帧去重: 去除 '+collected.duplicateCount+' 条完全一致的镜像记录','w');
          }

          var merged = mergeItems(allItems);
          // v19.77.1: Count unique PIDs (same PID with different specs is expected)
          var uniquePids2 = {};
          merged.forEach(function(m) {
            (m.productId||'').split(/[\n,]/).forEach(function(p) { p=p.trim(); if(p) uniquePids2[p]=1; });
          });
          L('DOM内合并: '+allItems.length+' 条 -> '+merged.length+' 条 ('+Object.keys(uniquePids2).length+'个商品)','i');
          _estTotal = merged.length;
          setStat(merged.length, 0);

          var recs = [];

          function doImages() {
            var imgItems = [];
            recs.forEach(function(r) { if(r.img&&r.img.indexOf('http')===0) imgItems.push({rid:r.rid,img:r.img,pid:r.pid}); });
            if (!imgItems.length) { L('=== 完成 (无附件) ===','ok'); stopKA(); resolve({ok:true,count:recs.length,platform:confirmedPlatform}); return; }

            // v19.78.1: Fire-and-forget image upload - don't block user
            L('=== 数据上传完成 ===','ok');
            L('附件后台上传中: '+imgItems.length+'张 (可关闭页面)','i');
            verifyUpload(recs.length, '上午抓取', confirmedPlatform).then(function(vr) { if(vr && !vr.ok) L('⚠ 校验发现 '+vr.issues+' 个问题', 'e'); });
            setProgress(100, '数据完成', imgItems.length+'张附件后台上传中');
            hideProgress();
            resolve({ok:true,count:recs.length,imgOk:0,imgPending:imgItems.length,platform:confirmedPlatform});

            // Background image upload (non-blocking)
            downloadImages(imgItems, typeof TT !== "undefined" ? TT : RAW_TABLE).then(function(r) {
              if (r.imgPending) {
                L('[后台] 附件仍在后台处理中，不影响商品数据', 'i');
              } else {
                L('[后台] 附件上传完成: 成功'+(r.imgOk || 0)+'张', 'ok');
              }
            }).catch(function(e) {
              L('[后台] 附件上传异常: '+e.message, 'w');
            });
          }
          setProgress(35, '幂等核对中...', '检查今日当前平台记录');
          feishuMorningUpsert(merged, confirmedPlatform).then(function(result) {
            recs = result.records || [];
            L('数据写入飞书完成: 更新 ' + result.updated + ' 条，新增 '
              + result.created + ' 条，清退旧预估 ' + (result.removedStale || 0)
              + ' 条，保护已打单 ' + result.protectedActual + ' 条', 'ok');
            setStat(recs.length, 0);
            if (!hasAttach) {
              L('=== 完成 ===','ok');
              stopKA();
              resolve({ok:true,count:recs.length,updated:result.updated,created:result.created,platform:confirmedPlatform});
              return;
            }
            doImages();
          }).catch(function(error) {
            L('上午幂等写入异常: ' + error.message, 'e');
            L('安全停止：不会把部分结果显示为成功', 'e');
            stopKA();
            resolve({ok:false, count:recs.length, expected:merged.length});
          });
        }).catch(function(e) { L('执行异常: '+e.message,'e'); resolve({ok:false}); });
      }, 2000);
    });
  });
}
var _estTotal = 1;

// ====== MAIN BUTTON ======
document.getElementById('go').addEventListener('click', function() {
  var b = this;
  if (!beginTask('go')) return;
  lg.innerHTML = ''; setStat(0,0); _startTime = Date.now();
  progressWrap.style.display = 'none';

  // V20.8.0: Show floating tracker overlay
  _tkPhase = 'morning'; trackerShowBar();

  L('=== 开始抓取备货单 ===', 'i');
  L('检查飞书字段...', 'i');
  ensureAttachField().then(function(ch) {
    if (!ch.ok) L('附件字段跳过: '+(ch.msg||''),'w');
    else L('附件字段就绪: 图片上传已启用','ok');
    scrapeAndUpload(ch.ok).then(function(r) {
      // V20.8.0: Record manual morning extraction in tracker
      if (r && r.ok && r.platform) {
        var _gm = r.platform.match(/【(\d+)】/);
        var _gt = _gm ? _gm[1] : '';
        var _gn = r.platform.replace(/-【.*$/, '');
        if (_gt) trackerRecordMorning(_gt, _gn, 'done', '手动抓取 ' + (r.updated||0) + '+' + (r.created||0) + '条').catch(function(){});
      }
      endTask('go', !(r && r.ok === false),
        r && r.ok === false ? '抓取未完成，请查看运行日志' : '备货单抓取与飞书写入已完成');
    }).catch(function(e) {
      L('抓取异常: '+e.message, 'e');
      endTask('go', false, '抓取发生异常，请查看运行日志');
    });
  }).catch(function(e) {
    L('字段检测异常: '+e.message, 'e');
    endTask('go', false, '飞书字段检测失败');
  });
});

// ====== DIAGNOSTIC SCAN ======
document.getElementById('diagScan').addEventListener('click', function() {
  var b = this;
  if (!beginTask('diagScan')) return;
  lg.innerHTML = '';
  L('=== 诊断扫描开始 ===','i');

  chrome.tabs.query({active:true,currentWindow:true}, function(tabs) {
    if (!tabs||!tabs.length||!tabs[0].url) { L('无活动标签页','e'); endTask('diagScan', false, '没有检测到活动页面'); return; }
    L('当前页面: '+tabs[0].url.substring(0,80),'i');

    if (!/dgjapp\.com/.test(tabs[0].url)) { L('非店管家页面','w'); endTask('diagScan', false, '当前页面不是店管家备货单'); return; }

    // Scan main frame
    chrome.scripting.executeScript({
      target:{tabId:tabs[0].id, allFrames:true}, world:"MAIN",
      func: function() {
        var report = {filters:[], buttons:[], tables:[], inputs:[]};
        var all = document.querySelectorAll('span,label,div,a,button,input,select,th,td,p,li,.el-select,.el-input');
        for (var i=0; i<all.length; i++) {
          var el = all[i];
          if (el.offsetParent===null && el.tagName!=='HTML') continue;
          var txt = el.textContent.trim();
          if (txt.length>50||txt.length===0) continue;
          var info = {tag:el.tagName, text:txt.substring(0,40), cls:(el.className||'').toString().substring(0,50)};

          if (txt.includes('平台')||txt.includes('店铺')||txt.includes('渠道')) report.filters.push({type:'platform',...info});
          if (txt.includes('下单时间')||txt.includes('时间范围')) report.filters.push({type:'timeRange',...info});
          if (txt.includes('打印状态')||txt.includes('状态')) report.filters.push({type:'printStatus',...info});

          if ((el.tagName==='BUTTON'||el.tagName==='A'||el.getAttribute('role')==='button') && txt.length<20) report.buttons.push(info);
          if (el.tagName==='INPUT'||el.tagName==='SELECT'||el.classList.contains('el-select')) {
            report.inputs.push({tag:el.tagName,type:el.type||'',placeholder:el.placeholder||'',parent:el.parentElement?el.parentElement.textContent.trim().substring(0,30):''});
          }
        }
        var tables = document.querySelectorAll('table');
        for (var t=0; t<tables.length; t++) report.tables.push({rows:tables[t].querySelectorAll('tr').length,cls:(tables[t].className||'').substring(0,40)});
        return report;
      }, args:[]
    }).then(function(results) {
      (results||[]).forEach(function(r,i) {
        if (!r||!r.result) return;
        var rp = r.result;
        L('--- Frame'+i+' ---','i');
        if (rp.filters.length) { L('筛选控件: '+rp.filters.length+'个','ok'); rp.filters.forEach(function(f){ L('  ['+f.type+'] <'+f.tag+'> "'+f.text+'"','i'); }); }
        else L('筛选控件: 未检测到','w');
        if (rp.buttons.length) { L('按钮: '+rp.buttons.length+'个','i'); rp.buttons.forEach(function(b){ var m=b.text.includes('生成')?' <<<':''; L('  <'+b.tag+'> "'+b.text+'"'+m,'i'); }); }
        if (rp.tables.length) { L('表格: '+rp.tables.length+'个','ok'); rp.tables.forEach(function(t){ L('  rows='+t.rows,'i'); }); }
        if (rp.inputs.length) { L('交互元素: '+rp.inputs.length+'个','i'); rp.inputs.slice(0,8).forEach(function(el){ L('  <'+el.tag+'> placeholder="'+el.placeholder+'" parent="'+el.parent.substring(0,25)+'"','i'); }); }
      });
      L('=== 诊断完成 ===','ok');
      endTask('diagScan', true, '页面结构与抓取入口检查完成');
    }).catch(function(e) { L('扫描异常: '+e.message,'e'); endTask('diagScan', false, '诊断扫描发生异常'); });
  });
});

// ====== RETRY FAILED ATTACHMENTS ======
document.getElementById('retryImages').addEventListener('click', function() {
  if (!beginTask('retryImages')) return;
  lg.innerHTML = '';
  L('读取上次失败附件...', 'i');
  chrome.storage.local.get(['dgjLastImageFailures'], function(data) {
    var pack = data && data.dgjLastImageFailures;
    var failures = pack && Array.isArray(pack.items) ? pack.items : [];
    if (!failures.length) {
      L('没有需要重试的附件', 'ok');
      endTask('retryImages', true, '当前没有失败附件');
      refreshFailedImageBadge();
      return;
    }
    var retryItems = failures.filter(function(item) {
      return item && item.rid && /^https?:\/\//i.test(item.url || '');
    }).map(function(item, index) {
      return {rid:item.rid, img:item.url, pid:item.pid || '', idx:item.idx === undefined ? index : item.idx};
    });
    if (!retryItems.length) {
      L('失败清单中没有可重试的有效图片地址', 'w');
      endTask('retryImages', false, '图片源地址无效，需要重新抓取页面');
      return;
    }
    L('只重试失败附件: ' + retryItems.length + ' 条，不重新抓取商品数据', 'i');
    downloadImages(retryItems, pack.tableId || PROC_TABLE).then(function(result) {
      var ok = result && result.imgFailed === 0;
      endTask('retryImages', ok,
        ok ? '失败附件已经全部修复' : '仍有少量附件失败，可稍后再次重试');
    }).catch(function(error) {
      L('附件重试异常: ' + error.message, 'e');
      endTask('retryImages', false, '附件重试发生异常');
    });
  });
});
refreshFailedImageBadge();

// ====== V20.8.0 TRACKER INIT ======
trackerInit();

// ====== OPEN FEISHU ======
document.getElementById('openFeishu').addEventListener('click', function() { chrome.tabs.create({url:FEISHU_URL}); });
document.getElementById('clearLog').addEventListener('click', function() { lg.innerHTML=''; });
// V20.10.1: logToggle click handler for expand/collapse
document.getElementById('logToggle').addEventListener('click', function() {
  var logPanel = document.querySelector('.log-panel');
  if (!logPanel) return;
  var isExpanded = logPanel.classList.toggle('expanded');
  this.textContent = isExpanded ? '收起' : '展开';
});

// ====== RETURN BUTTON ======
document.getElementById('returnBtn').addEventListener('click', function() {
  var b = this;
  if (!beginTask('returnBtn')) return;
  _incrementalReturnMode = false;
  _lastReturnWorkflowResult = {ok:false, stage:'started'};
  lg.innerHTML = ''; setStat(0,0); _startTime = Date.now();
  progressWrap.style.display = 'none';

  // V20.8.0: Show floating tracker overlay
  _tkPhase = 'afternoon';
  trackerShowBar();

  L('检查飞书字段...', 'i');
  ensureAttachField().then(function(ch) {
    if (!ch.ok) L('附件字段跳过: '+(ch.msg||''),'w');
    else L('附件字段就绪: 图片上传已启用','ok');
    returnToFeishu(ch.ok, {
      tabId:_forcedReturnTabId || 0,
      expectedPlatform:_forcedReturnExpectedPlatform || ''
    }).then(function(r) {
      if (!r || r.ok === false) {
        L('安全停止：下午回传没有完整写入，中止采购表自动同步', 'e');
        _lastReturnWorkflowResult = Object.assign({ok:false, stage:'return'}, r || {});
        endTask('returnBtn', false, '下午回传未完整完成，采购表未同步');
        return;
      }
      if (r && r.updated !== undefined) {
        L('=== 回传统计 ===', 's');
        L('更新已有: '+r.updated+' 条 | 新增记录: '+r.created+' 条', 'ok');
      }
      // v19.79.0: Auto-sync to procurement table after return
      L('自动同步到采购表...', 'i');
      chrome.storage.local.set({
        dgjLastReturnPlatform:r.platform || '',
        dgjLastReturnAt:Date.now()
      });
      // V20.8.0: Record afternoon return in tracker
      if (r.platform) {
        var _atm = r.platform.match(/【(\d+)】/);
        var _atTail = _atm ? _atm[1] : '';
        var _atPlat = r.platform.replace(/-【.*$/, '');
        if (_atTail) trackerRecordAfternoon(_atTail, _atPlat, 'done', '更新' + (r.updated||0) + '条 新增' + (r.created||0) + '条').catch(function(){});
      }
      syncToProcurement({incrementalPlatform:r.platform || ''}).then(function(sr) {
        if (sr && sr.updated !== undefined) {
          L('=== 采购表同步完成 ===', 's');
          L('更新: '+sr.updated+' 条 | 新增: '+sr.created+' 条', 'ok');
        }
        // V20.29.6: 已打单补同步——复用完整合并管线，把隔离/跨平台/其他平台的
        // 已打单记录补齐到采购表（合并+零遗漏+不暴涨，未打单行不受影响）。
        return syncPrintedToProcurement().then(function(ps) {
          L(ps && ps.ok === false ? '⚠ 已打单补同步未完整完成' : '=== 已打单补同步完成 ===',
            ps && ps.ok === false ? 'w' : 'ok');
          return {sr: sr, ps: ps};
        });
      }).then(function(stages) {
        var sr = stages ? stages.sr : null;
        var ps = stages ? stages.ps : null;
        L(sr && sr.ok === false ? '=== 回传完成，但采购表同步未完整完成 ===' : '=== 全部完成 ===',
          sr && sr.ok === false ? 'e' : 's');
        _lastReturnWorkflowResult = {
          ok:!(sr && sr.ok === false),
          stage:'complete',
          platform:r.platform || '',
          updated:r.updated || 0,
          created:r.created || 0,
          removedUnprinted:r.removedUnprinted || 0,
          procurementUpdated:sr && sr.updated || 0,
          procurementCreated:sr && sr.created || 0,
          printedSyncUpdated:ps && ps.updated || 0,
          printedSyncCreated:ps && ps.created || 0,
          attachmentUpdated:(r.attachmentUpdated || 0) + (sr && sr.attachmentUpdated || 0),
          attachmentFailed:(r.attachmentFailed || 0) + (sr && sr.attachmentFailed || 0)
        };
        endTask('returnBtn', !(sr && sr.ok === false),
          sr && sr.ok === false ? '回传已完成，但采购表同步未完整完成' : '已打印数据回传及采购表同步全部完成');
        verifyUpload((r && r.updated ? r.updated : 0) + (r && r.created ? r.created : 0), '下午回传', r && r.platform).then(function(vr) { if(vr && !vr.ok) L('⚠ 回传校验发现 '+vr.issues+' 个问题', 'e'); });
      }).catch(function(e) {
        L('采购表同步异常: '+e.message, 'w');
        L('=== 回传完成(采购表同步失败) ===', 's');
        _lastReturnWorkflowResult = {
          ok:false, stage:'procurement', platform:r.platform || '',
          updated:r.updated || 0, created:r.created || 0, error:e.message
        };
        endTask('returnBtn', false, '回传完成，但采购表同步失败');
      });
    }).catch(function(e) {
      L('回传异常: '+e.message, 'e');
      _lastReturnWorkflowResult = {ok:false, stage:'return', error:e.message};
      if (_forcedReturnExpectedPlatform) {
        var _fm = _forcedReturnExpectedPlatform.match(/【(\d+)】/);
        var _ft = _fm ? _fm[1] : '';
        var _fn = _forcedReturnExpectedPlatform.replace(/-【.*$/, '');
        if (_ft) trackerRecordAfternoon(_ft, _fn, 'failed', e.message).catch(function(){});
      } else {
        // V20.10.0: Fallback - manual return failure without platform context
        trackerRecordAfternoon(_forcedReturnTabId || 'unknown', '手动回传', 'failed', e.message).catch(function(){});
      }
      endTask('returnBtn', false, '下午回传发生异常');
    });
  }).catch(function(e) {
    L('字段检测异常: '+e.message, 'e');
    _lastReturnWorkflowResult = {ok:false, stage:'fields', error:e.message};
    endTask('returnBtn', false, '飞书字段检测失败');
  });

});
// ====== INCREMENTAL RETURN BUTTON (v20.7.5) ======
document.getElementById('incrementalReturnBtn').addEventListener('click', function() {
  var b = this;
  if (!beginTask('incrementalReturnBtn')) return;
  _incrementalReturnMode = true;
  _lastReturnWorkflowResult = {ok:false, stage:'started'};
  lg.innerHTML = ''; setStat(0,0); _startTime = Date.now();
  progressWrap.style.display = 'none';

  // V20.8.0: Show floating tracker overlay
  _tkPhase = 'afternoon';
  trackerShowBar();

  L('检查飞书字段...', 'i');
  ensureAttachField().then(function(ch) {
    if (!ch.ok) L('附件字段跳过: '+(ch.msg||''),'w');
    else L('附件字段就绪: 图片上传已启用','ok');
    returnToFeishu(ch.ok, {
      tabId:_forcedReturnTabId || 0,
      expectedPlatform:_forcedReturnExpectedPlatform || ''
    }).then(function(r) {
      _incrementalReturnMode = false;
      if (!r || r.ok === false) {
        L('安全停止：增量回传没有完整写入，中止采购表自动同步', 'e');
        _lastReturnWorkflowResult = Object.assign({ok:false, stage:'return'}, r || {});
        endTask('incrementalReturnBtn', false, '增量回传未完整完成，采购表未同步');
        return;
      }
      if (r && r.updated !== undefined) {
        L('=== 回传统计 ===', 's');
        L('更新已有: '+r.updated+' 条 | 新增记录: '+r.created+' 条', 'ok');
      }
      L('自动同步到采购表...', 'i');
      chrome.storage.local.set({
        dgjLastReturnPlatform:r.platform || '',
        dgjLastReturnAt:Date.now()
      });
      // V20.8.0: Record afternoon return in tracker
      if (r.platform) {
        var _atm = r.platform.match(/【(\d+)】/);
        var _atTail = _atm ? _atm[1] : '';
        var _atPlat = r.platform.replace(/-【.*$/, '');
        if (_atTail) trackerRecordAfternoon(_atTail, _atPlat, 'done', '更新' + (r.updated||0) + '条 新增' + (r.created||0) + '条').catch(function(){});
      }
      syncToProcurement({incrementalPlatform:r.platform || ''}).then(function(sr) {
        _incrementalReturnMode = false;
        if (sr && sr.updated !== undefined) {
          L('=== 采购表同步完成 ===', 's');
          L('更新: '+sr.updated+' 条 | 新增: '+sr.created+' 条', 'ok');
        }
        // V20.29.6: 增量回传后同样补同步——其他平台/隔离数据的已打单记录
        // 复用完整合并管线补齐到采购表（零遗漏、不暴涨、未打单行不受影响）
        return syncPrintedToProcurement().then(function(ps) {
          L(ps && ps.ok === false ? '⚠ 已打单补同步未完整完成' : '=== 已打单补同步完成 ===',
            ps && ps.ok === false ? 'w' : 'ok');
          return {sr: sr, ps: ps};
        });
      }).then(function(stages) {
        var sr = stages ? stages.sr : null;
        var ps = stages ? stages.ps : null;
        L(sr && sr.ok === false ? '=== 回传完成，但采购表同步未完整完成 ===' : '=== 增量回传全部完成 ===',
          sr && sr.ok === false ? 'e' : 's');
        _lastReturnWorkflowResult = {
          ok:!(sr && sr.ok === false) && !(ps && ps.ok === false),
          stage:'complete',
          platform:r.platform || '',
          updated:r.updated || 0,
          created:r.created || 0,
          removedUnprinted:r.removedUnprinted || 0,
          procurementUpdated:sr && sr.updated || 0,
          procurementCreated:sr && sr.created || 0,
          attachmentUpdated:(r.attachmentUpdated || 0) + (sr && sr.attachmentUpdated || 0),
          attachmentFailed:(r.attachmentFailed || 0) + (sr && sr.attachmentFailed || 0)
        };
        endTask('incrementalReturnBtn', !(sr && sr.ok === false) && !(ps && ps.ok === false),
          (sr && sr.ok === false) || (ps && ps.ok === false) ? '回传已完成，但采购表同步未完整完成' : '增量回传及采购表同步全部完成');
      }).catch(function(e) {
        _incrementalReturnMode = false;
        L('采购表同步异常: '+e.message, 'w');
        endTask('incrementalReturnBtn', false, '增量回传完成，但采购表同步失败');
      });
    }).catch(function(e) {
      _incrementalReturnMode = false;
      L('回传异常: '+e.message, 'e');
      if (_forcedReturnExpectedPlatform) {
        var _ifm = _forcedReturnExpectedPlatform.match(/【(\d+)】/);
        var _ift = _ifm ? _ifm[1] : '';
        var _ifn = _forcedReturnExpectedPlatform.replace(/-【.*$/, '');
        if (_ift) trackerRecordAfternoon(_ift, _ifn, 'failed', e.message).catch(function(){});
      } else {
        // V20.10.0: Fallback - incremental return failure without platform context
        trackerRecordAfternoon(_forcedReturnTabId || 'unknown', '手动增量回传', 'failed', e.message).catch(function(){});
      }
      endTask('incrementalReturnBtn', false, '增量回传发生异常');
    });
  }).catch(function(e) {
    _incrementalReturnMode = false;
    L('字段检测异常: '+e.message, 'e');
    endTask('incrementalReturnBtn', false, '飞书字段检测失败');
  });
});

// ====== SYNC BUTTON (v19.92.0) ======
document.getElementById('syncBtn').addEventListener('click', function() {
  var b = this;
  if (!beginTask('syncBtn')) return;
  lg.innerHTML = ''; setStat(0,0); _startTime = Date.now();
  progressWrap.style.display = 'none';
  chrome.storage.local.get(['dgjLastReturnPlatform','dgjLastReturnAt'], function(scope) {
    var lastAt = Number(scope && scope.dgjLastReturnAt) || 0;
    var todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    var lastPlatform = lastAt >= todayStart.getTime()
      ? String((scope && scope.dgjLastReturnPlatform) || '').trim() : '';
    if (lastPlatform) {
      L('按最近回传平台执行增量补同步: ' + lastPlatform, 'i');
      syncToProcurement({incrementalPlatform:lastPlatform}).then(function(r) {
        if (r && r.updated !== undefined) {
          L('=== 同步完成 ===', 's');
          L('更新: ' + r.updated + ' | 新增: ' + r.created, 'ok');
        } else {
          L('同步返回: ' + JSON.stringify(r), 'i');
        }
        endTask('syncBtn', !(r && r.ok === false),
          r && r.ok === false ? '采购表同步未完整完成，请查看日志' : '采购需求、保护记录与状态同步完成');
      }).catch(function(e) {
        L('同步异常: ' + e.message, 'e');
        endTask('syncBtn', false, '采购表同步发生异常');
      });
    } else {
      L('早上备货单全量上传模式', 'i');
      uploadMorningToProcurement().then(function(r) {
        if (r && r.ok) {
          L('=== 上传完成 ===', 's');
          L('写入: ' + (r.created||0) + ' 条 | 清除旧记录: ' + (r.deleted||0) + ' 条', 'ok');
        } else {
          L('上传返回: ' + JSON.stringify(r), 'i');
        }
        endTask('syncBtn', !(r && r.ok === false),
          r && r.ok === false ? '备货单上传未完整完成，请查看日志' : '早上备货单已全量上传到采购表');
      }).catch(function(e) {
        L('上传异常: ' + e.message, 'e');
        endTask('syncBtn', false, '备货单上传发生异常');
      });
      return;
    }
  });
});

// ====== TEST MERGE BUTTON ======
document.getElementById('testMergeBtn').addEventListener('click', function() {
  var b = this;
  if (!beginTask('testMergeBtn')) return;
  lg.innerHTML = ''; setStat(0,0); _startTime = Date.now();
  progressWrap.style.display = 'none';
  L('=== 中转站原地合并覆盖 ===', 'i');
  L('将删除今日旧记录并写入合并后的新记录', 'w');
  try {
    mergeInPlace().then(function(r) {
      if (r && r.ok) {
        L('=== 合并覆盖完成 ===', 's');
        L('删除旧记录: ' + r.deleted + ' | 写入合并记录: ' + r.created, 'ok');
        endTask('testMergeBtn', true, '中转站合并覆盖完成，删除' + r.deleted + '条，写入' + r.created + '条');
      } else {
        L('合并覆盖返回: ' + JSON.stringify(r), 'i');
        endTask('testMergeBtn', false, '合并覆盖未完成');
      }
    }).catch(function(e) {
      L('合并覆盖异常: ' + e.message, 'e');
      endTask('testMergeBtn', false, '合并覆盖异常');
    });
  } catch(e) {
    L('合并覆盖异常: ' + e.message, 'e');
    endTask('testMergeBtn', false, '合并覆盖异常');
  }
});

// ====== SETTINGS HANDLERS ======
document.getElementById('closeSettings').addEventListener('click', function() {
  document.getElementById('syncSettings').style.display = 'none';
});

// Auto-parse URL to extract tokens
document.getElementById('procurementUrl').addEventListener('input', function() {
  var url = this.value;
  var appMatch = url.match(/wiki\/([A-Za-z0-9]+)/);
  var tableMatch = url.match(/table=([A-Za-z0-9]+)/);
  if (appMatch) document.getElementById('procAppToken').value = appMatch[1];
  if (tableMatch) document.getElementById('procTableId').value = tableMatch[1];
});

// Load saved config
chrome.storage.local.get(['procAppToken','procTableId'], function(cfg) {
  // Force correct TABLE_ID (v19.92.0 fix)
  var correctPAT = 'DptPbPEluaupDjsp2XZcFK56nte';
  var correctPTT = 'tblMXn13Mpkvf1ql';
  document.getElementById('procAppToken').value = correctPAT;
  document.getElementById('procTableId').value = correctPTT;
  // Also save to storage
  chrome.storage.local.set({procAppToken: correctPAT, procTableId: correctPTT});
});

// ====== CALC DEMAND (需求计算) ======
document.getElementById('calcDemand').addEventListener('click', function() {
  var b = this;
  b.disabled = true; b.textContent = '计算中...';
  lg.innerHTML = '';
  L('=== 需求计算 ===', 'i');

  fetchAllRecordsFromTable(AT, typeof TT !== 'undefined' ? TT : PROC_TABLE).then(function(records) {
    L('读取记录: ' + records.length + ' 条', 'i');
    var fieldMap = {};
    var F_SPEC = '', F_QTY = '', F_TITLE = '';

    return detectTableFields(AT, typeof TT !== 'undefined' ? TT : PROC_TABLE).then(function(fm) {
      F_SPEC = resolveField(fm, ['🚧 ❗【时段】产品需求值', '❗【时段】产品需求值', '产品需求值']);
      F_QTY = resolveField(fm, ['📊 实际打单数', '实际打单数']);
      F_TITLE = resolveField(fm, ['📡 商品全称', '商品全称']);

      if (!F_SPEC) { L('未找到需求值字段', 'e'); b.disabled=false; b.textContent='需求计算'; return; }

      var totalDemand = 0, totalQty = 0, count = 0;
      records.forEach(function(rec) {
        var f = rec.fields || {};
        var spec = sv(f[F_SPEC]) || '';
        if (!spec) return;
        // Calculate total demand from spec string (格式: 规格名;数量)
        var demand = 0;
        spec.split('\n').forEach(function(line) {
          var parts = line.split(';');
          if (parts.length >= 2) demand += Number(parts[parts.length - 1]) || 0;
        });
        totalDemand += demand;
        totalQty += Number(sv(f[F_QTY])) || 0;
        count++;
      });

      L('统计完成:', 'ok');
      L('  产品数: ' + count + ' 条', 'i');
      L('  总需求量: ' + totalDemand, 'i');
      L('  总进货量: ' + totalQty, 'i');
      L('  差额: ' + (totalDemand - totalQty), totalDemand > totalQty ? 'w' : 'ok');
      b.disabled = false; b.textContent = '需求计算';
    });
  }).catch(function(e) {
    L('计算异常: ' + e.message, 'e');
    b.disabled = false; b.textContent = '需求计算';
  });
});

// Save config + Sync (v19.92.0)
document.getElementById('saveSyncConfig').addEventListener('click', function() {
  console.log('[DGJ] saveSyncConfig clicked');
  var pat = document.getElementById('procAppToken').value.trim();
  var ptt = document.getElementById('procTableId').value.trim();
  console.log('[DGJ] PAT:', pat, 'PTT:', ptt);
  if (!pat || !ptt) { L('请填写APP_TOKEN和TABLE_ID', 'e'); return; }
  chrome.storage.local.set({procAppToken: pat, procTableId: ptt}, function() {
    L('采购表配置已保存', 'ok');
    document.getElementById('syncSettings').style.display = 'none';
    // Auto-run sync
    var b2 = document.getElementById('syncBtn');
    b2.disabled = true; b2.textContent = '同步中...';
    lg.innerHTML = ''; setStat(0,0); _startTime = Date.now();
    progressWrap.style.display = 'none';
    console.log('[DGJ] Starting sync...');
    syncToProcurement().then(function(r) {
      console.log('[DGJ] Sync result:', r);
      b2.disabled = false; b2.textContent = '同步到采购表';
      if (r && r.updated !== undefined) {
        L('=== 同步完成 ===', 's');
        L('更新: ' + r.updated + ' | 新增: ' + r.created, 'ok');
      }
    }).catch(function(e) {
      console.error('[DGJ] Sync error:', e);
      b2.disabled = false; b2.textContent = '同步到采购表';
      L('同步异常: ' + e.message, 'e');
    });
  });
});



// ====== MULTI-ACCOUNT SCHEDULER (v19.92.0) ======
// 3 accounts × platforms = 14 exports total (7207 抖音 split into 一区/二区)
// 5820(主账号): 微信小店 only
// 7205(豆子): 拼多多/京东/淘宝/抖音/快手/微信小店
// 7207(A售后): 拼多多/京东/淘宝/抖音一区/抖音二区/快手/微信小店

var SCHEDULE_CONFIG = {
  accounts: [
    {tail: '5820', name: '主账号', platforms: ['微信小店'], urlToken: '80ADDCEEADE51E1168049D66ECCCF2F9'},
    {tail: '7205', name: '豆子', platforms: ['拼多多','京东','淘宝','抖音','快手小店','微信小店'], urlToken: 'E9AD6D4CCE7DB911DC8FDE8A54EFF2C0'},
    {tail: '7207', name: 'A售后', platforms: ['拼多多','京东','淘宝','抖音一区','抖音二区','快手小店','微信小店'], urlToken: '382346A2BAB84AEA0060104B84DCD1DF'}
  ],
  delayBetweenTasks: 3000,    // 3s between platform switches
  delayBetweenAccounts: 5000, // 5s between account switches
  maxRetries: 1
};

function scheduleBusinessDateKey() {
  var now = new Date();
  return now.getFullYear() + '-'
    + String(now.getMonth() + 1).padStart(2, '0') + '-'
    + String(now.getDate()).padStart(2, '0');
}

// Build the full task queue
function buildScheduleQueue() {
  var queue = [];
  var businessDate = scheduleBusinessDateKey();
  SCHEDULE_CONFIG.accounts.forEach(function(acct) {
    acct.platforms.forEach(function(plat) {
      queue.push({
        jobId: businessDate + ':morning:' + acct.tail + ':' + plat,
        accountTail: acct.tail,
        accountName: acct.name,
        platform: plat,
        urlToken: acct.urlToken || '',
        businessDate: businessDate,
        status: 'pending', // pending | running | done | failed
        retries: 0,
        result: null,
        startedAt:0,
        finishedAt:0
      });
    });
  });
  return queue;
}

// Save queue to storage
function saveScheduleQueue(queue) {
  return new Promise(function(resolve) {
    chrome.storage.local.set({scheduleQueue: queue, scheduleRunning: true}, resolve);
  });
}

// Load queue from storage
function loadScheduleQueue() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(['scheduleQueue', 'scheduleRunning', 'scheduleProgress'], function(data) {
      resolve({
        queue: data.scheduleQueue || [],
        running: data.scheduleRunning || false,
        progress: data.scheduleProgress || {current: 0, total: 0, done: 0, failed: 0}
      });
    });
  });
}

// Execute a single task: navigate to account URL, select platform, scrape
function executeScheduleTask(task) {
  // v19.92.0: Self-contained scrape+upload (no sidepanel dependency)
  return new Promise(function(resolve) {
    L('[调度] 执行: ' + task.accountName + '-' + task.platform, 'i');

    // v19.92.0: Navigate to correct account URL for this task
    // v19.77.0: Use correct dbname per account (5820 uses different DB)
    var taskDbname = task.accountTail === '5820' ? 'wdJM8OZZiF4gKKxb82bFQh5Eh6iRqVN3' : 'wdJM8OZZiF4gKKxb82bFQsfKZqGJVdjh';
    var taskHost = task.accountTail === '7207' ? 'fxali3.dgjapp.com' : 'fxali.dgjapp.com';
    var taskUrl = 'https://' + taskHost + '/Common/Page/Purchases-Index?token='
      + (task.urlToken || '') + '&dbname=' + taskDbname;
    chrome.tabs.query({url: '*://*.dgjapp.com/*'}, function(tabs) {
      var targetTab = null;
      // Find existing tab for this account
      if (tabs && tabs.length > 0) {
        for (var ti = 0; ti < tabs.length; ti++) {
          if (tabs[ti].url && tabs[ti].url.indexOf(task.urlToken) >= 0) {
            targetTab = tabs[ti]; break;
          }
        }
      }

      if (!targetTab) {
        // V20.12.1: Use any dgjapp tab and navigate to correct URL
        if (tabs && tabs.length > 0) {
          targetTab = tabs[0]; // Use first available dgjapp tab
          L('[调度] 使用现有标签页导航到账号【' + task.accountTail + '】', 'i');
        } else {
          // No dgjapp tabs at all - this shouldn't happen in manual mode
          L('[调度] ✗ 未找到任何店管家页面，请先打开店管家', 'e');
          task.status = 'failed'; task.result = 'no_dgj_tab:' + task.accountTail;
          resolve(task); return;
        }
      }

      // Navigate to correct account URL if needed
      var needNav = targetTab.url.indexOf(task.urlToken) < 0;
      function doScrape() {
        // v19.92.0: Select the correct platform before scraping
        var targetPlatform = task.platform;
        L('[调度] 选择平台: ' + targetPlatform, 'i');
        // v20.12.6: Phase 1 - Click platform in parent page
        var PLAT_CLASS = {
          '精选平台':'cloud-platform-li-jingxuan','拼多多':'cloud-platform-li-pinduoduo',
          '京东':'cloud-platform-li-jingdong','淘宝':'cloud-platform-li-taobao',
          '抖音':'cloud-platform-li-toutiao','抖店':'cloud-platform-li-toutiao',
          '快手':'cloud-platform-li-kuaishou','快手电商':'cloud-platform-li-kuaishou',
          '快手小店':'cloud-platform-li-kuaishou','微信小店':'cloud-platform-li-wxvideo'
        };
        chrome.scripting.executeScript({
          target: {tabId: targetTab.id}, world: "MAIN",
          func: function(tp, cm) {
            function v(el){if(!el)return false;var r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}
            var c=cm[tp]; if(c){var b=document.querySelector('.'+c);if(b&&v(b)){b.click();return 'ok:class';}}
            var base=tp.replace(/一区|二区/,''); var al=base==='抖音'?['抖音','抖店']:[base];
            if(base==='快手小店'||base==='快手')al.push('快手电商','快手');
            for(var i=0;i<al.length;i++){var c2=cm[al[i]];if(c2){var e=document.querySelector('.'+c2);if(e&&v(e)){e.click();return 'ok:alias:'+al[i];}}}
            var sp=Array.from(document.querySelectorAll('.wu-platformWrap span'));
            for(var j=0;j<al.length;j++){var m=sp.find(function(s){return v(s)&&s.textContent.trim()===al[j];});if(m){(m.closest('li')||m).click();return 'ok:text:'+al[j];}}
            return 'not_found:'+tp;
          },
          args: [targetPlatform, PLAT_CLASS]
        }).then(function(parentRes) {
          var pR = (parentRes && parentRes[0]) ? parentRes[0].result : 'no_result';
          L('[调度] 父页面平台: ' + pR, 'i');
          if (/^not_found:/.test(pR)) { task.status='failed'; task.result=pR; resolve(task); return; }
          var zoneMatch = targetPlatform.match(/(一区|二区)/);
          var zoneName = zoneMatch ? zoneMatch[1] : '';
          var _phase2Attempt = 0;
          function doPhase2() {
            _phase2Attempt++;
            L('[调度] Phase2 尝试 #' + _phase2Attempt, 'i');
            chrome.scripting.executeScript({
              target: {tabId: targetTab.id, allFrames:true}, world: "MAIN",
              func: async function(plat) {
            function wait(ms) {
              return new Promise(function(resolve) { setTimeout(resolve, ms); });
            }
            function visible(el) {
              if (!el) return false;
              var rect = el.getBoundingClientRect();
              var style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0
                && style.display !== 'none' && style.visibility !== 'hidden';
            }
// === V20.16.1: selectCombobox — 专用于自定义 combobox 组件 ===
// 找到包含目标选项文本的 combobox，点击打开，等待选项渲染，选择目标
// 返回 true/false 表示是否成功
async function selectCombobox(targetTexts, openWaitMs, optionTexts) {
  openWaitMs = openWaitMs || 800;
  // Step 1: 找到包含目标选项的 combobox 元素
  var comboboxes = Array.from(document.querySelectorAll('[role="combobox"], .el-select, [class*="combobox"], [class*="Combobox"], [class*="select-box"], [class*="selectBox"]'));
  var targetCb = null;
  
  // 策略A: 通过已选中的值或选项文本来定位 combobox
  for (var i = 0; i < comboboxes.length; i++) {
    var cb = comboboxes[i];
    if (!visible(cb)) continue;
    var cbText = cb.textContent.trim();
    // 检查 combobox 当前文本是否包含目标文本
    for (var j = 0; j < targetTexts.length; j++) {
      if (cbText.indexOf(targetTexts[j]) >= 0) {
        targetCb = cb;
        break;
      }
    }
    if (targetCb) break;
    // 检查 combobox 子 option 是否包含目标文本
    var opts = cb.querySelectorAll('option, [role="option"], li');
    for (var k = 0; k < opts.length; k++) {
      var optText = opts[k].textContent.trim();
      for (var j2 = 0; j2 < targetTexts.length; j2++) {
        if (optText === targetTexts[j2] || optText.indexOf(targetTexts[j2]) >= 0) {
          targetCb = cb;
          break;
        }
      }
      if (targetCb) break;
    }
    if (targetCb) break;
  }
  
  // 策略B: 如果没找到，扫描所有 selectBox 相关元素
  if (!targetCb) {
    var allEls = Array.from(document.querySelectorAll('div, span'));
    for (var i2 = 0; i2 < allEls.length; i2++) {
      var el = allEls[i2];
      if (!visible(el)) continue;
      var cls = String(el.className || '');
      if (!/select|Select|combo|Combo|dropdown|filter|picker/i.test(cls)) continue;
      var elText = el.textContent.trim();
      for (var j3 = 0; j3 < targetTexts.length; j3++) {
        if (elText.indexOf(targetTexts[j3]) >= 0) {
          targetCb = el;
          break;
        }
      }
      if (targetCb) break;
    }
  }
  
  // 策略C: 通过 input placeholder 查找（自定义 select 通常有 input 显示当前值）
  if (!targetCb) {
    var allInputs = document.querySelectorAll('input[placeholder], input[type="text"]');
    for (var ic = 0; ic < allInputs.length; ic++) {
      var inp = allInputs[ic];
      if (!visible(inp)) continue;
      var ph = String(inp.getAttribute('placeholder') || '');
      var val = String(inp.value || '');
      for (var jc = 0; jc < targetTexts.length; jc++) {
        if (ph.indexOf(targetTexts[jc]) >= 0 || val.indexOf(targetTexts[jc]) >= 0) {
          targetCb = inp.closest('[class*="select"],[class*="combo"],[class*="filter"],div') || inp;
          break;
        }
      }
      if (targetCb) break;
    }
  }
  
  // 策略D: 通过 trigger/caret 图标定位（filter行中的下拉触发器）
  if (!targetCb) {
    var triggers = document.querySelectorAll('.el-input__inner, .el-select__caret, [class*="caret"], [class*="arrow"], [class*="trigger"]');
    for (var it = 0; it < triggers.length; it++) {
      var trg = triggers[it];
      if (!visible(trg)) continue;
      // 检查 trigger 的兄弟或父元素是否包含目标文本
      var parent = trg.closest('[class*="select"],[class*="filter"],[class*="combo"]') || trg.parentElement;
      if (!parent) continue;
      var parentText = parent.textContent.trim();
      for (var jt = 0; jt < targetTexts.length; jt++) {
        if (parentText.indexOf(targetTexts[jt]) >= 0) {
          targetCb = parent;
          break;
        }
      }
      if (targetCb) break;
    }
  }
  
  if (!targetCb) {
    // V20.16.3: 详细诊断日志
    var _diagInfo = {
      targetTexts: targetTexts,
      comboboxCount: comboboxes.length,
      comboboxDetails: comboboxes.slice(0, 5).map(function(cb) {
        return { tag: cb.tagName, cls: (cb.className||'').substring(0,40), text: cb.textContent.trim().substring(0,30), vis: cb.offsetWidth>0 };
      }),
      inputCount: document.querySelectorAll('input').length,
      inputDetails: Array.from(document.querySelectorAll('input')).slice(0, 5).map(function(i) {
        return { type: i.type, placeholder: i.getAttribute('placeholder'), value: i.value, vis: i.offsetWidth>0 };
      }),
      selectCount: document.querySelectorAll('select').length,
      roleCount: document.querySelectorAll('[role="combobox"]').length,
      bodyHasText: targetTexts.map(function(t) { return { text: t, found: (document.body.textContent||'').indexOf(t) >= 0 }; }),
      iframes: document.querySelectorAll('iframe').length,
      url: window.location.href
    };
    console.log('[DGJ] selectCombobox DIAG:', JSON.stringify(_diagInfo));
    return false;
  }
  
  // Step 2: 点击 combobox 打开下拉框（带重试）
  targetCb.click();
  await wait(openWaitMs);
  
  // Step 3: 在下拉框中查找目标选项并点击
  var texts = optionTexts || targetTexts;
  var _selectRetries = 0;
  // 搜索范围: combobox 的兄弟/父级中的 popup/dropdown 元素，或全局搜索
  var searchRoots = [document];
  // 也搜索可能的 popup 容器
  var popups = document.querySelectorAll('.el-select-dropdown, .el-popper, [class*="dropdown"], [class*="popup"], [class*="overlay"], [class*="popper"]');
  for (var p = 0; p < popups.length; p++) {
    if (visible(popups[p]) || popups[p].children.length > 0) {
      searchRoots.push(popups[p]);
    }
  }
  
  for (var si = 0; si < searchRoots.length; si++) {
    var root = searchRoots[si];
    var options = root.querySelectorAll('li, option, [role="option"], span, div');
    var bestMatch = null;
    var bestArea = Infinity;
    
    for (var oi = 0; oi < options.length; oi++) {
      var opt = options[oi];
      if (!visible(opt)) continue;
      var optTxt = opt.textContent.trim();
      // 跳过过长文本（不是选项）
      if (optTxt.length > 30) continue;
      
      for (var ti = 0; ti < texts.length; ti++) {
        if (optTxt === texts[ti] || optTxt.indexOf(texts[ti]) >= 0 || texts[ti].indexOf(optTxt) >= 0) {
          // 选择面积最小的匹配元素（最精确）
          var rect = opt.getBoundingClientRect();
          var area = rect.width * rect.height;
          if (area < bestArea && area > 0) {
            bestArea = area;
            bestMatch = opt;
          }
          break;
        }
      }
    }
    
    if (bestMatch) {
      bestMatch.click();
      console.log('[DGJ] selectCombobox: 成功选择', bestMatch.textContent.trim());
      return true;
    }
  }
  
  // Step 4: 如果在 popup 中没找到，直接在全局搜索可点击的选项
  var globalOpts = document.querySelectorAll('li, [role="option"]');
  for (var gi = 0; gi < globalOpts.length; gi++) {
    var gOpt = globalOpts[gi];
    if (!visible(gOpt)) continue;
    var gTxt = gOpt.textContent.trim();
    if (gTxt.length > 30) continue;
    for (var gt = 0; gt < texts.length; gt++) {
      if (gTxt === texts[gt]) {
        gOpt.click();
        console.log('[DGJ] selectCombobox: 全局匹配选择', gTxt);
        return true;
      }
    }
  }
  
  // Step 5: 重试 — 关闭再打开下拉框，等待更长时间
  if (_selectRetries < 2) {
    _selectRetries++;
    console.log('[DGJ] selectCombobox: 重试 #' + _selectRetries);
    // 点击空白区域关闭下拉框
    document.body.click();
    await wait(300);
    // 重新点击 combobox
    targetCb.click();
    await wait(1200);
    
    // 重新搜索选项
    var retryOpts = document.querySelectorAll('li, option, [role="option"], [class*="option"]');
    for (var ri = 0; ri < retryOpts.length; ri++) {
      var rOpt = retryOpts[ri];
      if (!visible(rOpt)) continue;
      var rTxt = rOpt.textContent.trim();
      if (rTxt.length > 30) continue;
      for (var rt = 0; rt < texts.length; rt++) {
        if (rTxt === texts[rt] || rTxt.indexOf(texts[rt]) >= 0 || texts[rt].indexOf(rTxt) >= 0) {
          rOpt.click();
          console.log('[DGJ] selectCombobox: 重试成功选择', rTxt);
          return true;
        }
      }
    }
  }
  
  console.log('[DGJ] selectCombobox: 打开后未找到选项', texts);
  return false;
}
            function exactCandidates(texts) {
              var allowed = {};
              texts.forEach(function(text) { allowed[text] = 1; });
              return Array.from(document.querySelectorAll('option,li,button,a,span,div'))
                .filter(function(el) {
                  return visible(el) && allowed[el.textContent.trim()];
                }).sort(function(a, b) {
                  var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
                  return (ar.width * ar.height) - (br.width * br.height);
                });
            }
            function clickExact(texts) {
              var candidates = exactCandidates(texts);
              if (!candidates.length) {
                // Debug: log what elements are visible
                var allVisible = Array.from(document.querySelectorAll('li,button,a,span,div'))
                  .filter(function(el) { return visible(el) && el.textContent.trim().length > 0 && el.textContent.trim().length < 20; })
                  .slice(0, 20)
                  .map(function(el) { return el.textContent.trim(); });
                console.log('[DGJ] clickExact: looking for', texts, 'found', candidates.length, 'candidates. Visible elements:', allVisible);
                return false;
              }
              var el = candidates[0];
              if (el.tagName === 'OPTION') {
                var select = el.closest('select');
                if (!select) return false;
                select.value = el.value;
                select.dispatchEvent(new Event('change', {bubbles:true}));
                return true;
              }
              var target = el.closest('li,button,a,[role="option"],[role="tab"]') || el;
              target.click();
              return true;
            }
            function openSelect(labels, placeholders) {
              // v20.12.62: Robust selectBox detection with multiple strategies + retries
              // Strategy 1: Native <input> with matching value/placeholder
              var inputs = Array.from(document.querySelectorAll('input'));
              var input = inputs.find(function(el) {
                var value = String(el.value || '').trim();
                var placeholder = String(el.getAttribute('placeholder') || '').trim();
                return visible(el) && (labels.indexOf(value) >= 0 || placeholders.indexOf(placeholder) >= 0);
              });
              if (input) {
                (input.closest('.el-select,.select,[class*="select"]') || input).click();
                return true;
              }
              // Strategy 2: Native <select> with matching label
              var selects = Array.from(document.querySelectorAll('select'));
              for (var si = 0; si < selects.length; si++) {
                var sel = selects[si];
                if (!visible(sel)) continue;
                var selLabel = (sel.previousElementSibling ? sel.previousElementSibling.textContent.trim() : '') || sel.getAttribute('aria-label') || '';
                for (var lj = 0; lj < labels.length; lj++) {
                  if (selLabel.indexOf(labels[lj]) >= 0) { sel.click(); sel.focus(); return true; }
                }
              }
              // Strategy 3: Exact text match in standard elements
              var labelsFound = exactCandidates(labels);
              if (labelsFound.length) {
                var labelTarget = labelsFound[0].closest('.el-select,.select,[class*="select"]') || labelsFound[0];
                labelTarget.click();
                return true;
              }
              // Strategy 4: Broad element scan — any element whose textContent contains the label
              var allEls = Array.from(document.querySelectorAll('div,span,a,button,label,li,td,th,p'));
              for (var i = 0; i < allEls.length; i++) {
                var el = allEls[i];
                if (!visible(el)) continue;
                var txt = el.textContent.trim();
                if (txt.length > 30 || txt.length < 2) continue;
                for (var j = 0; j < labels.length; j++) {
                  if (txt === labels[j] || txt.indexOf(labels[j]) >= 0) {
                    // Find the interactive container
                    var container = el.closest('[class*="select"],[class*="Select"],[class*="dropdown"],[class*="Dropdown"],[class*="picker"],[class*="Picker"],[class*="filter"],[class*="Filter"],[class*="combobox"],[class*="trigger"],[role="combobox"],[role="listbox"]') || el.closest('div[class]');
                    if (container && visible(container)) { container.click(); return true; }
                    el.click(); return true;
                  }
                }
              }
              // Strategy 5: Inner text search — label might be in a deeply nested child
              var spans = Array.from(document.querySelectorAll('span,div,a,button,label'));
              for (var i = 0; i < spans.length; i++) {
                var el = spans[i];
                if (!visible(el)) continue;
                var directText = Array.from(el.childNodes).filter(function(n){return n.nodeType===3;}).map(function(n){return n.textContent.trim();}).join('');
                for (var j = 0; j < labels.length; j++) {
                  if (directText.indexOf(labels[j]) >= 0) {
                    var container = el.closest('[class*="select"],[class*="Select"],[class*="dropdown"],[class*="filter"],[role="combobox"]') || el;
                    if (visible(container)) { container.click(); return true; }
                  }
                }
              }
              // Strategy 6: Scan ALL visible elements — buttons often have child spans
              var allNodes = document.querySelectorAll('button,a,div,span,li,label,[role="button"],[role="combobox"]');
              for (var i = 0; i < allNodes.length && i < 8000; i++) {
                var el = allNodes[i];
                if (!visible(el)) continue;
                var txt = el.textContent.trim();
                if (txt.length > 30) continue;
                for (var j = 0; j < labels.length; j++) {
                  if (txt === labels[j] || txt === labels[j] + ':' || txt === labels[j] + '：') {
                    // Found a match — click it directly
                    el.click();
                    console.log('[DGJ] openSelect S6 clicked:', el.tagName, el.className, 'text:', txt);
                    return true;
                  }
                }
              }
              // Strategy 7: Walk up from text nodes to find clickable parents
              var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
              var textNode;
              while (textNode = walker.nextNode()) {
                var t = textNode.textContent.trim();
                for (var j = 0; j < labels.length; j++) {
                  if (t === labels[j] || t.indexOf(labels[j]) >= 0) {
                    var p = textNode.parentElement;
                    for (var depth = 0; depth < 8 && p; depth++) {
                      var tag = p.tagName;
                      if (tag === 'BUTTON' || tag === 'A' || tag === 'LI' || p.getAttribute('role') === 'button' || p.getAttribute('role') === 'combobox') {
                        p.click();
                        console.log('[DGJ] openSelect S7 clicked:', p.tagName, p.className);
                        return true;
                      }
                      var cls = String(p.className || '');
                      if (/select|dropdown|filter|picker|trigger/i.test(cls)) { p.click(); return true; }
                      p = p.parentElement;
                    }
                    // Last resort: click the text node's parent
                    if (textNode.parentElement) { textNode.parentElement.click(); return true; }
                  }
                }
              }
              console.log('[DGJ] openSelect ALL strategies failed for labels:', labels, 'body text has label:', document.body && document.body.textContent.indexOf(labels[0]) >= 0);
              return false;
            }

            // v20.12.62: Smarter frame detection — check for actual filter labels, not just any "select" class
            // The parent frame has platform tabs but NO filter controls. The data iframe has filters + table.
            var _isTopFrame = (window === window.top) || !window.frameElement;
            var _hasDataTable = document.querySelectorAll('table').length > 0 || document.querySelectorAll('[class*="table"],[class*="grid"],[class*="el-table"]').length > 0;
            var _hasFilterLabel = document.body && /下单时间|发货时间|打印状态|生成备货单/.test(document.body.textContent || '');
            // Retry: wait for filter labels to appear (dynamic rendering)
            if (!_hasFilterLabel) {
              for (var _retry = 0; _retry < 8; _retry++) {
                await wait(1500);
                _hasFilterLabel = document.body && /下单时间|发货时间|打印状态|生成备货单/.test(document.body.textContent || '');
                if (_hasFilterLabel) break;
                _hasDataTable = document.querySelectorAll('table').length > 0 || document.querySelectorAll('[class*="table"],[class*="grid"],[class*="el-table"]').length > 0;
              }
            }
            // V20.12.62: In parent frame, detect zone BEFORE skipping
            // The parent frame has zone tabs (一区/二区) — detect and store for data iframe
            if (_isTopFrame && !_hasFilterLabel) {
              // Detect zone from parent frame DOM
              var _parentZone = '';
              try {
                var _zoneEls = document.querySelectorAll('span, a, div, button, li, [role="tab"]');
                for (var _zi = 0; _zi < _zoneEls.length; _zi++) {
                  var _zt = _zoneEls[_zi].textContent.trim();
                  if (_zt !== '一区' && _zt !== '二区') continue;
                  var _zEl = _zoneEls[_zi];
                  var _zActive = _zEl.classList.contains('is-active') || _zEl.classList.contains('active')
                    || _zEl.classList.contains('selected') || _zEl.getAttribute('aria-selected') === 'true'
                    || _zEl.classList.contains('current') || _zEl.classList.contains('cur')
                    || window.getComputedStyle(_zEl).fontWeight >= 700;
                  // Also check parent element
                  if (!_zActive && _zEl.parentElement) {
                    var _zp = _zEl.parentElement;
                    _zActive = _zp.classList.contains('is-active') || _zp.classList.contains('active') || _zp.classList.contains('selected');
                  }
                  if (_zActive) { _parentZone = _zt; break; }
                  if (!_parentZone) _parentZone = _zt;
                }
              } catch(_zErr) {}
              // Store zone in localStorage for data iframe to read
              if (_parentZone) {
                try {
                  localStorage.setItem('dgj_currentZone', _parentZone);
                  localStorage.setItem('dgj_zoneTime', String(Date.now()));
                  console.log('[调度] 父框架检测到 zone: ' + _parentZone);
                } catch(_lsErr) {}
              }
              return 'skip:parent_frame_no_filters';
            }
            if (!_hasFilterLabel && !_hasDataTable) {
              return 'skip:no_filter_no_table';
            }
            // V20.16.3: 全面诊断页面结构
            console.log('[DGJ] ===== 页面诊断开始 =====');
            console.log('[DGJ] URL: ' + window.location.href);
            console.log('[DGJ] iframes: ' + document.querySelectorAll('iframe').length);
            console.log('[DGJ] tables: ' + document.querySelectorAll('table').length);
            
            // 检查所有可能的筛选控件
            var _allInputs = document.querySelectorAll('input');
            console.log('[DGJ] inputs: ' + _allInputs.length);
            _allInputs.forEach(function(inp, idx) {
              if (inp.offsetWidth > 0) {
                console.log('[DGJ]   input[' + idx + ']: type=' + inp.type + ' ph=' + (inp.getAttribute('placeholder')||'').substring(0,20) + ' val=' + (inp.value||'').substring(0,20) + ' cls=' + (inp.className||'').substring(0,30));
              }
            });
            
            var _allSelects = document.querySelectorAll('select, [role="combobox"], .el-select, [class*="select"]');
            console.log('[DGJ] selects/comboboxes: ' + _allSelects.length);
            _allSelects.forEach(function(sel, idx) {
              if (sel.offsetWidth > 0) {
                console.log('[DGJ]   sel[' + idx + ']: tag=' + sel.tagName + ' cls=' + (sel.className||'').substring(0,40) + ' text=' + sel.textContent.trim().substring(0,30));
              }
            });
            
            var _allBtns = document.querySelectorAll('button, [role="button"], .btn');
            console.log('[DGJ] buttons: ' + _allBtns.length);
            _allBtns.forEach(function(btn, idx) {
              if (btn.offsetWidth > 0) {
                console.log('[DGJ]   btn[' + idx + ']: ' + btn.textContent.trim().substring(0,30));
              }
            });
            
            // 检查关键文本
            var _bodyText = document.body ? document.body.textContent : '';
            console.log('[DGJ] has 下单时间: ' + (_bodyText.indexOf('下单时间') >= 0));
            console.log('[DGJ] has 打印状态: ' + (_bodyText.indexOf('打印状态') >= 0));
            console.log('[DGJ] has 生成备货单: ' + (_bodyText.indexOf('生成备货单') >= 0));
            console.log('[DGJ] has 近3天: ' + (_bodyText.indexOf('近3天') >= 0));
            console.log('[DGJ] ===== 页面诊断结束 =====');
            
            // Step 1: 选择时间筛选类型（下单时间/发货时间/付款时间）
            await wait(1000);
            var timeFilterOk = await selectCombobox(
              ['下单时间','发货时间','付款时间'], 1000,
              ['下单时间','发货时间','付款时间']
            );
            if (!timeFilterOk) {
              // 备选: 使用传统 openSelect
              timeFilterOk = openSelect(['下单时间','发货时间'], ['下单时间','发货时间']);
              console.log('[DGJ] openSelect 时间筛选: ' + timeFilterOk);
            }
            await wait(800);
            
            // Step 2: 选择日期范围（近3天/最近3天）
            var dateRangeOk = await selectCombobox(['近3天','最近3天','近7天'], 800, ['近3天','最近3天','近7天']);
            if (!dateRangeOk) {
              dateRangeOk = clickExact(['近3天','最近3天','近7天']);
              console.log('[DGJ] clickExact 日期范围: ' + dateRangeOk);
            }
            await wait(800);
            
            // Step 3: 选择打印状态（均未打印）
            var printFilterOk = await selectCombobox(
              ['打印状态','全部打印状态','均未打印'], 1000,
              ['均未打印','全部未打印','未打印']
            );
            if (!printFilterOk) {
              // 备选: 使用传统 openSelect + clickExact
              if (openSelect(['打印状态','全部打印状态'], ['打印状态'])) {
                await wait(500);
                printFilterOk = clickExact(['均未打印','全部未打印','未打印']);
                console.log('[DGJ] openSelect+clickExact 打印状态: ' + printFilterOk);
              } else {
                console.log('[DGJ] 打印状态筛选控件未找到');
              }
            }
            await wait(800);
            
            // Step 4: 点击生成备货单按钮
            if (!clickExact(['生成备货单'])) return 'not_found:generate';
            return 'prepared:' + plat;
          },
          args: [targetPlatform]
        }).then(function(clickResult) {
          var preparedFrame = (clickResult || []).find(function(frame) {
            return frame && /^prepared:/.test(String(frame.result || ''));
          });
          var clickRes = preparedFrame ? preparedFrame.result
            : ((clickResult && clickResult[0]) ? clickResult[0].result : 'no_result');
          L('[调度] 平台选择: ' + clickRes, 'i');
          // V20.16.3: 记录所有 frame 的结果
          (clickResult || []).forEach(function(frame, idx) {
            var r = frame && frame.result ? String(frame.result).substring(0, 100) : 'null';
            L('[调度]   frame[' + idx + ']: ' + r, 'i');
          });
          if (!/^prepared:/.test(clickRes)) {
            task.status = 'failed';
            task.result = 'platform_not_found:' + targetPlatform;
            L('[调度] 未找到唯一可见的平台入口，已停止当前任务', 'e');
            resolve(task);
            return;
          }
          // Wait for table to update after platform switch
          setTimeout(function() {
            L('[调度] 注入爬虫脚本...', 'i');
            chrome.scripting.executeScript({
              target: {tabId: targetTab.id, allFrames: true}, world: "MAIN",
              func: DGJ_SCRAPER,
              args: [task.platform || '']
            }).then(function(results) {
              // v19.77.0: Use known platform from scheduler task (reliable)
              var confirmedPlatform = task.platform + '-【' + task.accountTail + '】';
              // Log if scraper detected a different platform (informational only)
              var scraperPlatform = '';
              // V20.16.3: 记录爬虫结果
              (results || []).forEach(function(frame, idx) {
                var r = frame && frame.result ? frame.result : null;
                if (r) {
                  L('[调度]   爬虫frame[' + idx + ']: items=' + (r.items ? r.items.length : 0) + ' plat=' + (r.platformName||'null') + ' table=' + (r.tableVisible !== false), 'i');
                }
                if (r && r.tableVisible !== false && r.items && r.items.length
                    && r.platformName && !scraperPlatform) scraperPlatform = r.platformName;
              });
              // v20.12.34: Retry on platform mismatch (re-click platform and re-scrape)
              if (scraperPlatform && scraperPlatform !== task.platform) {
                if (!task._platRetry) task._platRetry = 0;
                if (task._platRetry < 2) {
                  task._platRetry++;
                  L('[调度] 平台不匹配("' + scraperPlatform + '"≠"' + task.platform + '")，重新选择平台 #' + task._platRetry, 'w');
                  // Re-click platform and retry
                  chrome.scripting.executeScript({
                    target:{tabId:targetTab.id}, world:'MAIN',
                    func:function(tp,cm){
                      function v(el){if(!el)return false;var r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}
                      var c=cm[tp];if(c){var b=document.querySelector('.'+c);if(b&&v(b)){b.click();return 'ok:class';}}
                      return 'not_found:'+tp;
                    }, args:[targetPlatform, PLAT_CLASS]
                  }).then(function(){ setTimeout(doPhase2, 5000); });
                  return;
                }
                L('[调度] 安全停止: UI显示平台"' + scraperPlatform
                  + '"≠任务平台"' + task.platform + '"', 'e');
                task.status = 'failed';
                task.result = 'platform_mismatch:' + scraperPlatform;
                resolve(task);
                return;
              }
              L('[调度] 平台: ' + confirmedPlatform, 'ok');

              var collected = collectScrapedFrameItems(results);
              var allItems = collected.items;
              allItems.forEach(function(item) { item.platform = confirmedPlatform; });

              L('[调度] 抓取: ' + allItems.length + ' 条原始记录', 'i');
              if (allItems.length === 0) {
                task.status = 'done'; task.result = '0 items (page empty)';
                L('[调度] 页面无数据，跳过', 'i');
                resolve(task); return;
              }

              var merged = mergeItems(allItems);

              ensureAttachField().then(function(ch) {
                return feishuMorningUpsert(merged, confirmedPlatform);
              }).then(function(writeResult) {
                var refs = writeResult.records || [];
                var count = refs.length;
                L('[调度] 上传: ' + count + ' 条', 'ok');

                var imgItems = [];
                refs.forEach(function(ref) {
                  if (ref.img && ref.img.indexOf('http') === 0) {
                    imgItems.push({rid:ref.rid, img:ref.img, pid:ref.pid || ''});
                  }
                });
                if (imgItems.length > 0) {
                  L('[调度] 附件进入后台队列: ' + imgItems.length + ' 张，不阻塞下一平台', 'i');
                  downloadImages(imgItems, typeof TT !== "undefined" ? TT : RAW_TABLE).then(function(result) {
                    L('[调度附件] ' + confirmedPlatform + ' 完成: 成功 '
                      + (result.imgOk || 0) + '，失败 ' + (result.imgFailed || 0),
                      result.imgFailed ? 'w' : 'ok');
                  }).catch(function(error) {
                    L('[调度附件] ' + confirmedPlatform + ' 异常: ' + error.message, 'w');
                  });
                }
                return count;
              }).then(function(count) {
                task.status = 'done';
                task.result = count + ' records uploaded';
                L('[调度] ✓ 完成: ' + task.accountName + '-' + task.platform + ' (' + count + '条)', 'ok');
                resolve(task);
              }).catch(function(e) {
                L('[调度] ✗ 上传异常: ' + e.message, 'e');
                task.status = 'failed'; task.result = e.message;
                resolve(task);
              });

            }).catch(function(e) {
              L('[调度] ✗ 爬虫注入失败: ' + e.message, 'e');
              L('[调度] 请确认页面已完全加载', 'w');
              task.status = 'failed'; task.result = e.message;
              resolve(task);
            });
          }, 6000);
            }).catch(function(e) {
              // v20.12.30: Retry if iframe not loaded (up to 3 attempts)
              if (_phase2Attempt < 3 && /skip:not_iframe|not_found/.test(String(e.message || ''))) {
                L('[调度] Phase2 重试 #' + (_phase2Attempt + 1) + ': ' + e.message, 'w');
                setTimeout(doPhase2, 4000);
              } else {
                L('[调度] 筛选失败: ' + e.message, 'e');
                task.status = 'failed'; task.result = e.message; resolve(task);
              }
            });
          } // end doPhase2
          if (zoneName) {
            chrome.scripting.executeScript({
              target: {tabId: targetTab.id}, world: "MAIN",
              func: function(zn) {
                var spans = Array.from(document.querySelectorAll('.switch-platform-wrap span'));
                var m = spans.find(function(s) { return s.textContent.trim() === zn; });
                if (m) { m.click(); return 'ok:' + zn; }
                return 'not_found:' + zn;
              }, args: [zoneName]
            }).then(function(zr) {
              L('[调度] 区域: ' + ((zr&&zr[0])?zr[0].result:'no'), 'i');
              setTimeout(doPhase2, 2000);
            }).catch(function() { doPhase2(); });
          } else { setTimeout(doPhase2, 4000); }
        }).catch(function(e) {
          L('[调度] 平台选择异常: ' + e.message, 'e');
          task.status = 'failed'; task.result = 'platform_error:' + e.message; resolve(task);
        });
      }
      if (needNav) {
        L('[调度] 导航到: ' + task.accountName + '...', 'i');
        chrome.tabs.update(targetTab.id, {url: taskUrl}, function() {
          setTimeout(doScrape, 8000); // V20.12.2: wait longer for page load
        });
      } else {
        chrome.tabs.update(targetTab.id, {active: true}, doScrape);
      }
    });
  });
}


function runScheduleQueue(options) {
  options = options || {};
  // v19.92.0: Proper sequential execution with wait between tasks
  return loadScheduleQueue().then(function(state) {
    var queue = state.queue;
    var todayKey = scheduleBusinessDateKey();
    if (options.forceNew || !queue.length || queue[0].businessDate !== todayKey) {
      queue = buildScheduleQueue();
    }
    queue.forEach(function(task) {
      if (task.status === 'running') {
        task.status = 'pending';
        task.result = 'recovered_after_interruption';
      }
      if (options.retryFailed && task.status === 'failed') {
        task.status = 'pending';
        task.retries = 0;
        task.result = 'manual_retry_failed_only';
      }
    });

    var pending = queue.filter(function(t) { return t.status === 'pending'; });
    if (!pending.length) {
      var completedCount = queue.filter(function(task) { return task.status === 'done'; }).length;
      var failedCount = queue.filter(function(task) { return task.status === 'failed'; }).length;
      chrome.storage.local.set({
        scheduleQueue:queue,
        scheduleRunning:false,
        scheduleProgress:{
          current:completedCount + failedCount,
          total:queue.length,
          done:completedCount,
          failed:failedCount
        }
      });
      L('[调度] 今日 14 项没有待执行任务，不会重复抓取', 'i');
      return {total:0, started:false, completed:true, done:completedCount, failed:failedCount};
    }

    L('=== 开始调度执行 (' + pending.length + ' 个任务) ===', 's');
    L('[调度] 5820(主账号): 微信小店 ×1', 'i');
    L('[调度] 7205(豆子): 6个平台', 'i');
    L('[调度] 7207(A售后): 6个平台', 'i');

    var idx = 0;
    var done = queue.filter(function(task) { return task.status === 'done'; }).length;
    var failed = queue.filter(function(task) { return task.status === 'failed'; }).length;
    var logicalTotal = queue.length;
    chrome.storage.local.set({
      scheduleQueue:queue,
      scheduleRunning:true,
      scheduleProgress:{current:done + failed,total:logicalTotal,done:done,failed:failed}
    });

    function nextTask() {
      if (idx >= pending.length) {
        L('=== 调度完成 ===', 's');
        L('成功: ' + done + ' | 失败: ' + failed + ' | 总计: ' + logicalTotal, failed===0?'ok':'w');
        chrome.storage.local.set({
          scheduleQueue:queue,
          scheduleRunning:false,
          scheduleProgress:{current:logicalTotal,total:logicalTotal,done:done,failed:failed}
        });
        return;
      }

      // Check if schedule was stopped
      chrome.storage.local.get(['scheduleRunning'], function(data) {
        if (!data.scheduleRunning) {
          L('[调度] 已停止', 'w');
          return;
        }

        var task = pending[idx];
        task.status = 'running';
        task.startedAt = Date.now();
        idx++;

        // V20.8.0: Mark platform as running in tracker
        trackerRecordMorning(task.accountTail, task.platform, 'running', '开始处理');

        var progress = {current:done + failed, total:logicalTotal, done:done, failed:failed};
        chrome.storage.local.set({scheduleProgress: progress, scheduleQueue: queue});

        executeScheduleTask(task).then(function() {
          if (task.status === 'done') {
            done++;
            task.finishedAt = Date.now();
            L('[调度] ✓ ' + task.accountName + '-' + task.platform + ': ' + (task.result || 'done'), 'ok');
            trackerRecordMorning(task.accountTail, task.platform, 'done', task.result || 'done').catch(function(){});
          } else {
            if ((task.retries || 0) < SCHEDULE_CONFIG.maxRetries) {
              task.retries = (task.retries || 0) + 1;
              task.status = 'pending';
              pending.push(task);
              L('[调度] ↻ ' + task.accountName + '-' + task.platform
                + ' 将自动重试第 ' + task.retries + ' 次: '
                + (task.result || 'unknown error'), 'w');
            } else {
              failed++;
              task.finishedAt = Date.now();
              L('[调度] ✗ ' + task.accountName + '-' + task.platform + ': ' + (task.result || 'unknown error'), 'e');
              trackerRecordMorning(task.accountTail, task.platform, 'failed', task.result || 'failed').catch(function(){});
            }
          }

          var delay = (idx < pending.length && pending[idx].accountTail !== task.accountTail)
            ? SCHEDULE_CONFIG.delayBetweenAccounts
            : SCHEDULE_CONFIG.delayBetweenTasks;

          L('[调度] 进度: ' + (done + failed) + '/' + logicalTotal
            + ' (成功' + done + ' 失败' + failed + ')', 'i');
          chrome.storage.local.set({
            scheduleQueue:queue,
            scheduleProgress:{current:done + failed,total:logicalTotal,done:done,failed:failed}
          });
          setTimeout(nextTask, delay);
        });
      });
    }

    nextTask();
    return {total: pending.length, started: true};
  });
}

// Stop the schedule
function stopSchedule() {
  return new Promise(function(resolve) {
    chrome.storage.local.set({scheduleRunning: false}, function() {
      L('[调度] 已停止', 'w');
      resolve({stopped: true});
    });
  });
}

// Get schedule status
function getScheduleStatus() {
  return loadScheduleQueue().then(function(state) {
    return {
      running: state.running,
      progress: state.progress,
      queue: state.queue
    };
  });
}

// Legacy single alarm was replaced by automation.js. Configuration is saved
// atomically so the old autoScrape alarm and the new 14-task alarm cannot both run.

// ====== ENABLE BUTTON ON STARTUP ======
document.getElementById('go').disabled = false;
var _goEl=document.getElementById('go');var _gt=_goEl.querySelector('.act-label');if(_gt)_gt.textContent='抓取备货单';

// ====== DEDUP BUTTON ======
document.getElementById('restoreBtn').addEventListener('click', function() {
  var b = this;
  if (!confirm('确定要从备份恢复源数据吗？\n\n当前中转站的数据将被清空，\n替换为备份表中的数据。')) return;
  b.disabled = true; b.textContent = '恢复中...';
  lg.innerHTML = '';
  restoreFromBackup().then(function(r) {
    b.disabled = false; b.textContent = '从备份恢复源数据';
    if (r && r.restored !== undefined) {
      L('=== 恢复完成 ===', 's');
      L('已恢复 ' + r.restored + ' 条记录', 'ok');
    }
  }).catch(function(e) {
    b.disabled = false; b.textContent = '从备份恢复源数据';
    L('恢复异常: ' + e.message, 'e');
    L('堆栈: ' + (e.stack || '').substring(0, 200), 'e');
  });
});


// ====== COPY RAW → PROC BUTTON (v19.92.0) ======
document.getElementById('copyRawBtn').addEventListener('click', function() {
  var b = this; b.disabled = true; b.textContent = '复制中...'; lg.innerHTML = '';
  copyRawToProc().then(function(r) {
    b.disabled = false; b.textContent = '复制原料表→加工表';
    if (r && r.copied !== undefined) { L('=== 复制完成 ===', 's'); L('已复制 ' + r.copied + ' 条到加工表', 'ok'); }
  }).catch(function(e) { b.disabled = false; b.textContent = '复制原料表→加工表'; L('复制异常: ' + e.message, 'e'); });
});

function auditTransferDuplicates() {
  return Promise.all([getFieldMap(), fetchAllRecordsForReturn()]).then(function(results) {
    var fm = results[0], records = results[1];
    var FT = resolveField(fm, ['📡 商品全称', '商品全称', '商品标题']);
    var FP = resolveField(fm, ['🔗 商品ID', '商品 🆔', '商品ID', '商品 ID']);
    var FPL = resolveField(fm, ['平台所属账号', '平台【文字】', '平台文字']);
    if (!FT || !FP || !FPL) throw new Error('重复检查缺少标题、商品ID或平台字段');
    var groups = {};
    records.forEach(function(rec) {
      var fields = rec.fields || {};
      var platform = sv(fields[FPL]);
      var pids = businessPidList(sv(fields[FP])).sort();
      var identity = pids.length ? ('PID:' + pids.join('|'))
        : ('TITLE:' + normTitle(sv(fields[FT])));
      var key = platform + '::' + identity;
      if (!groups[key]) groups[key] = [];
      groups[key].push(rec.record_id);
    });
    var duplicates = Object.keys(groups).filter(function(key) {
      return groups[key].length > 1;
    });
    var extraRows = duplicates.reduce(function(sum, key) {
      return sum + groups[key].length - 1;
    }, 0);
    L('今日中转站: ' + records.length + ' 条', 'i');
    L('同店铺精确重复组: ' + duplicates.length + ' 组，多余 '
      + extraRows + ' 条', duplicates.length ? 'w' : 'ok');
    duplicates.slice(0, 20).forEach(function(key) {
      L('重复 ' + groups[key].length + ' 条: ' + key, 'w');
    });
    if (duplicates.length > 20) L('其余 ' + (duplicates.length - 20) + ' 组已省略', 'i');
    L('本检查不修改数据；重新抓取对应店铺会按快照自动收敛重复', 'i');
    return {ok:duplicates.length === 0, total:records.length, groups:duplicates.length, extraRows:extraRows};
  });
}

document.getElementById('dedupBtn').addEventListener('click', function() {
  var b = this;
  if (!beginTask('dedupBtn')) return;
  lg.innerHTML = ''; setStat(0,0); _startTime = Date.now();
  progressWrap.style.display = 'none';
  // Read-only health check first. Never mutate a sample record just to test.
  quickApiTest().then(function() {
    L('连通性检查通过，开始只读重复审计...', 'ok');
    auditTransferDuplicates().then(function(r) {
      L('=== 检查完成 ===', 's');
      endTask('dedupBtn', true, r.groups
        ? '发现重复，请按日志重抓对应店铺'
        : '今日中转站没有同店铺精确重复');
    }).catch(function(e) {
      L('重复检查异常: ' + e.message, 'e');
      L('堆栈: ' + (e.stack || '').substring(0, 200), 'e');
      endTask('dedupBtn', false, '重复检查发生异常');
    });
  }).catch(function(e) {
    L('API测试失败: ' + e.message, 'e');
    L('请检查飞书表格字段和权限后重试', 'e');
    endTask('dedupBtn', false, '飞书 API 测试未通过');
  });
});

// ====== SCHEDULE BUTTONS ======
document.getElementById('startSchedule').addEventListener('click', function() {
  var b = this;
  var stopBtn = document.getElementById('stopSchedule');
  var progressEl = document.getElementById('scheduleProgress');
  var statusEl = document.getElementById('scheduleStatus');

  b.disabled = true; b.textContent = '执行中...';
  stopBtn.style.display = '';
  progressEl.style.display = '';
  statusEl.textContent = '执行中';
  statusEl.style.color = 'var(--ac2)';
  statusEl.style.background = 'rgba(99,102,241,0.15)';

  lg.innerHTML = ''; setStat(0,0); _startTime = Date.now();

  runScheduleQueue({forceNew:true}).then(function(r) {
    if (r && r.started) {
      L('调度已启动: ' + r.total + ' 个任务', 'ok');
      L('[调度] 请确保已在Chrome中打开店管家页面并登录', 'i');
      // Update progress periodically
      var progressInterval = setInterval(function() {
        getScheduleStatus().then(function(s) {
          if (!s.running) {
            clearInterval(progressInterval);
            b.disabled = false; b.textContent = '开始批量';
            stopBtn.style.display = 'none';
            statusEl.textContent = '已完成';
            statusEl.style.color = 'var(--gn)';
            statusEl.style.background = 'rgba(34,197,94,0.15)';
            return;
          }
          var p = s.progress;
          var pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
          document.getElementById('scheduleBar').style.width = pct + '%';
          document.getElementById('scheduleCurrent').textContent = p.current + '/' + p.total;
          document.getElementById('scheduleResult').textContent = '成功' + p.done + ' 失败' + p.failed;
        });
      }, 2000);
    }
  }).catch(function(e) {
    b.disabled = false; b.textContent = '开始批量';
    stopBtn.style.display = 'none';
    statusEl.textContent = '异常';
    statusEl.style.color = 'var(--rd)';
    L('调度异常: ' + e.message, 'e');
  });
});

document.getElementById('stopSchedule').addEventListener('click', function() {
  stopSchedule().then(function() {
    document.getElementById('startSchedule').disabled = false;
    document.getElementById('startSchedule').textContent = '开始批量';
    document.getElementById('stopSchedule').style.display = 'none';
    var statusEl = document.getElementById('scheduleStatus');
    statusEl.textContent = '已停止';
    statusEl.style.color = 'var(--yw)';
    statusEl.style.background = 'rgba(234,179,8,0.15)';
  });
});

// ====== AUTOMATION RUN MORNING BUTTON ======
document.getElementById('automationRunMorning').addEventListener('click', function() {
  var b = this;
  if (!beginTask('automationRunMorning')) return;
  lg.innerHTML = ''; setStat(0,0); _startTime = Date.now();
  progressWrap.style.display = 'none';
  b.disabled = true; b.textContent = '执行中...';

  _tkPhase = 'morning'; trackerShowBar();

  L('=== 早晨自动化启动 ===', 'i');
  runScheduleQueue({retryFailed:true}).then(function(r) {
    if (r && r.started) {
      L('调度已启动: ' + r.total + ' 个任务', 'ok');
      // Poll progress
      var pollInterval = setInterval(function() {
        getScheduleStatus().then(function(s) {
          if (!s.running) {
            clearInterval(pollInterval);
            var ok = s.progress.failed === 0;
            b.disabled = false; b.textContent = '立即执行14项';
            endTask('automationRunMorning', ok,
              ok ? '早晨自动化完成' : '完成但有 ' + s.progress.failed + ' 个失败');
          }
        });
      }, 3000);
    } else {
      b.disabled = false; b.textContent = '立即执行14项';
      endTask('automationRunMorning', true, '没有待执行任务');
    }
  }).catch(function(e) {
    b.disabled = false; b.textContent = '立即执行14项';
    endTask('automationRunMorning', false, '调度异常: ' + e.message);
  });
});

// ====== ALARM FIRED HANDLER ======
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  if (msg.type === 'alarmFired') {
    L('=== 定时任务触发 ===', 's');
    L('自动开始 14 个上午备货单任务...', 'i');
    runScheduleQueue().then(function(result) {
      sendResponse({ok:true, started:true, total:result.total || 14});
    }).catch(function(error) {
      L('定时批量启动失败: ' + error.message, 'e');
      sendResponse({ok:false, reason:error.message});
    });
  }
  // Return true to keep the message channel open for async response
  return true;
});

// ====== NEURAL SAND UI · v20.5.0 ======
// Lightweight Particle Effect - Inspired by particles.js
// Floating particles with mouse attraction, no external dependencies
(function() {
  'use strict';
  
  var canvas = document.getElementById('particleCanvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d', {alpha: true});
  if (!ctx) return;
  
  // Configuration
  var CONFIG = {
    particleCount: 100,
    particleSize: {min: 1.2, max: 3},
    particleSpeed: {min: 0.3, max: 1.2},
    particleOpacity: {min: 0.3, max: 0.7},
    lineDistance: 120,
    lineOpacity: 0.15,
    lineWidth: 0.5,
    mouseRadius: 150,
    mouseForce: 0.04,
    colors: [
      '124,92,252',   // Purple (theme accent)
      '0,229,155',    // Green (theme accent)  
      '46,201,167',  // Teal
      '137,104,255', // Violet
      '100,200,255'  // Light blue
    ]
  };
  
  var particles = [];
  var mouse = {x: null, y: null, radius: CONFIG.mouseRadius};
  var width, height, dpr;
  var animationId;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  
  // Particle class
  function Particle() {
    this.reset();
  }
  
  Particle.prototype.reset = function() {
    this.x = Math.random() * width;
    this.y = Math.random() * height;
    this.size = randomBetween(CONFIG.particleSize.min, CONFIG.particleSize.max);
    this.speedX = randomBetween(-CONFIG.particleSpeed.max, CONFIG.particleSpeed.max);
    this.speedY = randomBetween(-CONFIG.particleSpeed.max, CONFIG.particleSpeed.max);
    this.opacity = randomBetween(CONFIG.particleOpacity.min, CONFIG.particleOpacity.max);
    this.color = CONFIG.colors[Math.floor(Math.random() * CONFIG.colors.length)];
    this.targetOpacity = this.opacity;
    this.fadeSpeed = 0.01 + Math.random() * 0.02;
  };
  
  Particle.prototype.update = function() {
    // Move
    this.x += this.speedX;
    this.y += this.speedY;
    
    // Bounce off edges
    if (this.x < 0 || this.x > width) this.speedX *= -1;
    if (this.y < 0 || this.y > height) this.speedY *= -1;
    
    // Keep in bounds
    this.x = Math.max(0, Math.min(width, this.x));
    this.y = Math.max(0, Math.min(height, this.y));
    
    // Mouse interaction
    if (mouse.x !== null && mouse.y !== null) {
      var dx = mouse.x - this.x;
      var dy = mouse.y - this.y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < mouse.radius) {
        var force = (mouse.radius - dist) / mouse.radius;
        var angle = Math.atan2(dy, dx);
        
        // Attract towards mouse
        this.speedX += Math.cos(angle) * force * CONFIG.mouseForce;
        this.speedY += Math.sin(angle) * force * CONFIG.mouseForce;
        
        // Increase opacity near mouse
        this.targetOpacity = Math.min(1, this.opacity + force * 0.5);
      } else {
        this.targetOpacity = this.opacity;
      }
    }
    
    // Fade opacity
    this.displayOpacity = this.displayOpacity || this.opacity;
    this.displayOpacity += (this.targetOpacity - this.displayOpacity) * 0.1;
    
    // Speed damping with max speed limit
    var maxSpeed = 2.5;
    var currentSpeed = Math.sqrt(this.speedX * this.speedX + this.speedY * this.speedY);
    if (currentSpeed > maxSpeed) {
      this.speedX = (this.speedX / currentSpeed) * maxSpeed;
      this.speedY = (this.speedY / currentSpeed) * maxSpeed;
    }
    this.speedX *= 0.95;
    this.speedY *= 0.95;
    
    // Minimum speed
    var speed = Math.sqrt(this.speedX * this.speedX + this.speedY * this.speedY);
    if (speed < CONFIG.particleSpeed.min) {
      this.speedX += (Math.random() - 0.5) * 0.15;
      this.speedY += (Math.random() - 0.5) * 0.15;
    }
  };
  
  Particle.prototype.draw = function() {
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(' + this.color + ',' + this.displayOpacity + ')';
    ctx.fill();
  };
  
  function randomBetween(min, max) {
    return min + Math.random() * (max - min);
  }
  
  function resizeCanvas() {
    var doc = document.documentElement;
    width = Math.max(1, doc.clientWidth || window.innerWidth || 400);
    height = Math.max(1, doc.clientHeight || window.innerHeight || 600);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    
    // Adjust particle count based on screen size
    var targetCount = Math.min(120, Math.max(50, Math.round(width * height / 7000)));
    
    while (particles.length < targetCount) {
      particles.push(new Particle());
    }
    while (particles.length > targetCount) {
      particles.pop();
    }
  }
  
  function drawLines() {
    for (var i = 0; i < particles.length; i++) {
      for (var j = i + 1; j < particles.length; j++) {
        var dx = particles[i].x - particles[j].x;
        var dy = particles[i].y - particles[j].y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        
        if (dist < CONFIG.lineDistance) {
          var opacity = (1 - dist / CONFIG.lineDistance) * CONFIG.lineOpacity;
          ctx.beginPath();
          ctx.strokeStyle = 'rgba(124,92,252,' + opacity + ')';
          ctx.lineWidth = CONFIG.lineWidth;
          ctx.moveTo(particles[i].x, particles[i].y);
          ctx.lineTo(particles[j].x, particles[j].y);
          ctx.stroke();
        }
      }
    }
  }
  
  function drawMouseLines() {
    if (mouse.x === null || mouse.y === null) return;
    
    for (var i = 0; i < particles.length; i++) {
      var dx = mouse.x - particles[i].x;
      var dy = mouse.y - particles[i].y;
      var dist = Math.sqrt(dx * dx + dy * dy);
      
      if (dist < mouse.radius) {
        var opacity = (1 - dist / mouse.radius) * 0.22;
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(124,92,252,' + opacity + ')';
        ctx.lineWidth = 0.6;
        ctx.moveTo(particles[i].x, particles[i].y);
        ctx.lineTo(mouse.x, mouse.y);
        ctx.stroke();
      }
    }
  }
  
  function animate() {
    if (reduceMotion) return;
    
    ctx.clearRect(0, 0, width, height);
    
    // Update and draw particles
    for (var i = 0; i < particles.length; i++) {
      particles[i].update();
      particles[i].draw();
    }
    
    // Draw connections
    drawLines();
    drawMouseLines();
    
    animationId = requestAnimationFrame(animate);
  }
  
  // Event listeners
  function onMouseMove(e) {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  }
  
  function onMouseLeave() {
    mouse.x = null;
    mouse.y = null;
  }
  
  window.addEventListener('resize', resizeCanvas, {passive: true});
  document.addEventListener('mousemove', onMouseMove, {passive: true});
  document.addEventListener('mouseleave', onMouseLeave, {passive: true});
  document.addEventListener('visibilitychange', function() {
    if (document.hidden) {
      if (animationId) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    } else {
      if (!animationId && !reduceMotion) {
        animationId = requestAnimationFrame(animate);
      }
    }
  });
  
  // Initialize
  resizeCanvas();
  if (!reduceMotion) {
    animationId = requestAnimationFrame(animate);
  }
  
  // Re-init after delay
  setTimeout(resizeCanvas, 200);
  
  console.log('[Particles] Initialized: ' + particles.length + ' particles');
})();





// ====== V20.8.0 · TRACKER CARD ======

// V20.12.46: Toast notification system (pure JS, no dependencies)
var Toast = {
  container: null,
  init: function() {
    this.container = document.getElementById('toastContainer');
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'toastContainer';
      this.container.className = 'toast-container';
      document.body.appendChild(this.container);
    }
  },
  show: function(options) {
    if (!this.container) this.init();
    
    var type = options.type || 'info';
    var title = options.title || '';
    var message = options.message || '';
    var duration = options.duration || 3000;
    
    // Icon SVGs
    var icons = {
      success: '<svg viewBox="0 0 24 24"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
      error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
      warning: '<svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
      info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };
    
    // Create toast element
    var toast = document.createElement('div');
    toast.className = 'toast ' + type;
    toast.innerHTML = 
      '<div class="toast-icon">' + (icons[type] || icons.info) + '</div>' +
      '<div class="toast-content">' +
        (title ? '<div class="toast-title">' + title + '</div>' : '') +
        (message ? '<div class="toast-message">' + message + '</div>' : '') +
      '</div>' +
      '<div class="toast-close" onclick="this.parentElement.remove()">' +
        '<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      '</div>';
    
    // Add to container
    this.container.appendChild(toast);
    
    // Trigger animation
    requestAnimationFrame(function() {
      toast.classList.add('show');
    });
    
    // Auto remove
    if (duration > 0) {
      setTimeout(function() {
        toast.classList.remove('show');
        toast.classList.add('hide');
        setTimeout(function() { toast.remove(); }, 300);
      }, duration);
    }
    
    return toast;
  },
  success: function(title, message) { return this.show({type:'success', title:title, message:message}); },
  error: function(title, message) { return this.show({type:'error', title:title, message:message}); },
  warning: function(title, message) { return this.show({type:'warning', title:title, message:message}); },
  info: function(title, message) { return this.show({type:'info', title:title, message:message}); }
};

// V20.12.46: Keyboard shortcuts (impeccable-lite: keyboard operation)
document.addEventListener('keydown', function(e) {
  // Don't handle shortcuts when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
    return;
  }
  
  // V20.29.0: 任务运行中阻止快捷键，防止干扰正在执行的抓取/回传/同步任务
  if (_activeTaskId) {
    e.preventDefault();
    return;
  }
  
  // Escape: Close any open panels
  if (e.key === 'Escape') {
    var detailPanel = document.getElementById('tkDetailPanel');
    if (detailPanel && detailPanel.classList.contains('open')) {
      detailPanel.classList.remove('open');
      e.preventDefault();
      return;
    }
  }
  
  // Ctrl/Cmd + 1: Switch to morning tab
  if ((e.ctrlKey || e.metaKey) && e.key === '1') {
    var tabM = document.getElementById('tkTabM');
    if (tabM) { tabM.click(); e.preventDefault(); }
  }
  
  // Ctrl/Cmd + 2: Switch to afternoon tab
  if ((e.ctrlKey || e.metaKey) && e.key === '2') {
    var tabA = document.getElementById('tkTabA');
    if (tabA) { tabA.click(); e.preventDefault(); }
  }
  
  // Ctrl/Cmd + 3: Toggle log panel
  if ((e.ctrlKey || e.metaKey) && e.key === '3') {
    var logTog = document.getElementById('tkLogToggle');
    if (logTog) { logTog.click(); e.preventDefault(); }
  
  // Ctrl/Cmd + 5: Test merge
  if ((e.ctrlKey || e.metaKey) && e.key === '5') {
    var testBtn = document.getElementById('testMergeBtn');
    if (testBtn) { testBtn.click(); e.preventDefault(); }
  }
  }
});

// Initialize toast system
Toast.init();


var TK_ACCOUNTS = [
  {tail:'5820', name:'主账号', platforms:['微信小店'], css:'g5820'},
  {tail:'7205', name:'豆子', platforms:['拼多多','京东','淘宝','抖音','快手小店','微信小店'], css:'g7205'},
  {tail:'7207', name:'A售后', platforms:['拼多多','京东','淘宝','抖音一区','抖音二区','快手小店','微信小店'], css:'g7207'}
];
var _tkData = {};
var _tkPhase = 'morning';
var _tkLogs = [];
var _tkShown = false;
// V20.16.0: 一次性迁移 — 清除旧版本硬编码的追踪数据
// 检测localStorage中是否有旧数据（由硬编码初始化生成）
try {
  var _migrationKey = 'dgj_v20_15_4_migration_done';
  // V20.16.1: 检查任何已知的迁移key，避免版本升级时重复运行
  var _anyMigrationDone = localStorage.getItem('dgj_v20_15_4_migration_done')
    || localStorage.getItem('dgj_v20_16_0_migration_done')
    || localStorage.getItem('dgj_v20_16_1_migration_done');
  if (!_anyMigrationDone) {
    var _oldBackup = JSON.parse(localStorage.getItem('dgj_trackerBackup') || '{}');
    if (_oldBackup.data && Object.keys(_oldBackup.data).length > 0) {
      // 检查是否有"用户确认已回传"标记（旧硬编码初始化的特征）
      var _hasHardcoded = false;
      Object.keys(_oldBackup.data).forEach(function(key) {
        var entry = _oldBackup.data[key];
        if (entry && entry.afternoon && entry.afternoon.detail === '用户确认已回传') {
          _hasHardcoded = true;
        }
      });
      if (_hasHardcoded) {
        localStorage.removeItem('dgj_trackerBackup');
        chrome.storage.local.remove('extractionTracker');
        console.log('[追踪] V20.16.0: 已清除硬编码初始化的追踪数据');
      }
    }
    // 标记迁移完成（设置所有已知key，避免版本升级时重复运行）
    localStorage.setItem('dgj_v20_15_4_migration_done', '1');
    localStorage.setItem('dgj_v20_16_0_migration_done', '1');
    localStorage.setItem('dgj_v20_16_1_migration_done', '1');
  }
} catch(_migErr) {}

try {
  var _preloadTracker = JSON.parse(localStorage.getItem('dgj_trackerBackup') || '{}');
  if (_preloadTracker.date === (function() {
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0');
  })()) {
    _tkData = _preloadTracker.data || {};
    _tkLogs = _preloadTracker.logs || [];
    if (Object.keys(_tkData).length > 0) {
      console.log('[追踪] 同步预加载: ' + Object.keys(_tkData).length + ' 条记录');
    }
  }
} catch(_preloadErr) {}

function tkKey(t, p) { return t + ':' + p; }
function tkTime(ts) {
  if (!ts) return '--:--';
  var d = new Date(ts);
  return String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
}
function tkDateKey() {
  var n = new Date();
  return n.getFullYear() + '-' + String(n.getMonth()+1).padStart(2,'0') + '-' + String(n.getDate()).padStart(2,'0');
}
function tkSave() {
  var _trackerPayload = {date:tkDateKey(),data:_tkData,logs:_tkLogs.slice(-80),savedAt:Date.now()};
  // V20.15.1: localStorage 优先（同步、可靠、跨重载持久）
  try { localStorage.setItem('dgj_trackerBackup', JSON.stringify(_trackerPayload)); } catch(e) {}
  // chrome.storage.local 作为辅助备份
  try { chrome.storage.local.set({extractionTracker:_trackerPayload}); } catch(e2) {}
}
function tkReset() { _tkData = {}; _tkLogs = []; tkSave(); tkRender(); }
// V20.16.0: 暴露到全局，方便控制台调用
window.tkReset = tkReset;

// V20.12.43: Manual zone selection for抖音 7207
window.tkSetZone = function(zone) {
  if (zone !== '一区' && zone !== '二区') {
    console.error('Invalid zone:', zone);
    return false;
  }
  
  // Record in zone history
  var _zhKey = 'dgjZoneHistory_7207';
  var _zh = JSON.parse(localStorage.getItem(_zhKey) || '{}');
  _zh['抖音' + zone] = Date.now();
  localStorage.setItem(_zhKey, JSON.stringify(_zh));
  
  // Update tracker data
  var oldKey = tkKey('7207', '抖音');
  var newKey = tkKey('7207', '抖音' + zone);
  
  if (_tkData[oldKey]) {
    _tkData[newKey] = _tkData[oldKey];
    delete _tkData[oldKey];
    tkSave();
    tkRender();
    L('[追踪] 已将 7207:抖音 更改为 7207:抖音' + zone, 'ok');
    return true;
  }
  
  L('[追踪] 未找到 7207:抖音 的记录', 'w');
  return false;
};

// V20.12.43: Also update zone history when user manually marks platforms
var _originalTkMark = window.tkMark;
window.tkMark = function(tail, platform, status, detail) {
  // Call original function
  if (_originalTkMark) _originalTkMark(tail, platform, status, detail);
  
  // Record zone if platform has zone suffix
  if (platform && (platform.indexOf('一区') >= 0 || platform.indexOf('二区') >= 0)) {
    var zoneMatch = platform.match(/(一区|二区)/);
    if (zoneMatch && tail) {
      var _zhKey = 'dgjZoneHistory_' + tail;
      var _zh = JSON.parse(localStorage.getItem(_zhKey) || '{}');
      _zh[platform] = Date.now();
      localStorage.setItem(_zhKey, JSON.stringify(_zh));
    }
  }
};

function tkLoad(cb) {
  // V20.15.1: localStorage 优先加载（同步预加载已完成，这里做二次确认）
  try {
    var lsData = JSON.parse(localStorage.getItem('dgj_trackerBackup') || '{}');
    if (lsData.date === tkDateKey() && lsData.data && Object.keys(lsData.data).length > 0) {
      // localStorage 有今日数据，直接使用（比 chrome.storage 更可靠）
      _tkData = lsData.data;
      _tkLogs = lsData.logs || [];
      console.log('[追踪] 从 localStorage 加载: ' + Object.keys(_tkData).length + ' 条');
      if (cb) cb();
      return;
    }
  } catch(lsErr) {}
  
  // Fallback: chrome.storage.local
  chrome.storage.local.get(['extractionTracker'], function(s) {
    var t = s.extractionTracker || {};
    if (t.date === tkDateKey()) {
      _tkData = t.data || {};
      _tkLogs = t.logs || [];
      // 同步到 localStorage 以便下次快速加载
      try { localStorage.setItem('dgj_trackerBackup', JSON.stringify(t)); } catch(e) {}
    } else {
      // 新的一天，清空数据
      _tkData = {}; _tkLogs = [];
    }
    // V20.15.1: 移除硬编码初始化 — 只保留实际操作记录
    // 用户手动标记通过 tkMark() 函数完成，不再自动标记
    if (cb) cb();
  });
}

function tkRecord(phase, tail, platform, status, detail) {
  // V20.10.3: Validate platform belongs to this account
  // Prevents cross-account platform contamination (e.g. 微信小店误标为快手小店)
  if (tail && platform) {
    var _acctMatch = false;
    TK_ACCOUNTS.forEach(function(acct) {
      if (acct.tail !== tail) return;
      // V20.10.4: Exact match only — no substring matching to avoid 微信小店↔快手小店 confusion
      acct.platforms.forEach(function(p) {
        if (p === platform) { _acctMatch = true; }
        // Zone prefix: "抖音" matches "抖音一区"/"抖音二区" (but NOT "抖音小店" etc.)
        if (p.indexOf(platform) === 0 && p.length > platform.length
            && (p.charAt(platform.length) === '一' || p.charAt(platform.length) === '二')) {
          _acctMatch = true;
        }
      });
    });
    if (!_acctMatch) {
      // Platform doesn't belong to this account — skip recording entirely
      L('[追踪跳过] 平台 "' + platform + '" 不属于账号 ' + tail + '，跳过记录', 'w');
      return;
    }
  }
  // V20.10.1: Platform zone mapping - when platform is base name (e.g. '抖音')
  // and account has sub-zones (e.g. '抖音一区','抖音二区'), map to all sub-zones
  var mappedPlatforms = [platform];
  if (tail && platform) {
    TK_ACCOUNTS.forEach(function(acct) {
      if (acct.tail !== tail) return;
      var subZones = acct.platforms.filter(function(p) {
        return p !== platform && p.indexOf(platform) === 0 && p.length > platform.length;
      });
      if (subZones.length > 0) mappedPlatforms = subZones;
    });
  }
  mappedPlatforms.forEach(function(plat) {
    var key = tkKey(tail, plat);
    _tkData[key] = _tkData[key] || {};
    _tkData[key][phase] = {status:status, ts:Date.now(), detail:detail||''};
  });
  var acctName = '';
  TK_ACCOUNTS.forEach(function(a){ if(a.tail===tail) acctName=a.name; });
  var now = new Date();
  var ts = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0') + ':' + String(now.getSeconds()).padStart(2,'0');
  var act = status==='done'?'✓ 完成':status==='failed'?'✗ 失败':status==='running'?'● 进行中':'○ 待处理';
  // V20.10.1: Log shows mapped platforms for clarity
  var logPlatform = mappedPlatforms.length > 1 ? mappedPlatforms.join('+') : platform;
  _tkLogs.push({time:ts,account:acctName,tail:tail,platform:logPlatform,phase:phase,action:act,detail:detail||''});
  tkSave();
  tkRender();
}
function trackerRecordMorning(t,p,s,d) { try { tkRecord('morning',t,p,s,d); } catch(e) {} return Promise.resolve(); }
function trackerRecordAfternoon(t,p,s,d) { try { tkRecord('afternoon',t,p,s,d); } catch(e) {} return Promise.resolve(); }
function trackerShowBar() { _tkShown = true; tkRender(); }

// V20.10.7: Debug helper — call from sidepanel console
// Usage: tkMark('7207', '快手小店', 'done', '手动标记')
window.tkMark = function(tail, platform, status, detail) {
  try {
    tkRecord('afternoon', tail, platform, status || 'done', detail || '手动标记');
    console.log('✅ 已标记 ' + tail + ' ' + platform + ' 为 ' + (status || 'done'));
  } catch(e) {
    console.error('标记失败:', e);
  }
};


function tkRender() {
  var phase = _tkPhase;
  var done=0, run=0, pend=0, fail=0, total=0;
  var dotsHtml = '';
  var bodyHtml = '';

  TK_ACCOUNTS.forEach(function(acct) {
    var aDone=0, aTotal=acct.platforms.length;
    var itemsHtml = '';
    // Account header for dots
    var colHtml = '';
    acct.platforms.forEach(function(plat) {
      total++;
      var key = tkKey(acct.tail, plat);
      var entry = (_tkData[key] && _tkData[key][phase]) || {status:'pending'};
      var s = entry.status || 'pending';
      if (s==='done') { aDone++; done++; }
      else if (s==='running') { run++; }
      else if (s==='failed') { fail++; aDone++; }
      else { pend++; }
      var dc = s==='done'?'ok':s==='running'?'run':s==='failed'?'fail':'wait';
      var tt = s==='done'?'✓':s==='failed'?'✗':s==='running'?'●':'○';
      var tp = entry.ts ? tkTime(entry.ts) : '';
      // Dot row (visible at a glance)
      colHtml += '<div class="tk-dot-item ' + dc + '"><span class="pip-dot"></span>' + plat + '</div>';
      // V20.11.5: Comprehensive expanded view — both phases + full details
      var detailText = entry.detail || '';
      var timeStr = tp || '--:--';
      
      // Get both phase entries
      var morningEntry = (_tkData[key] && _tkData[key]['morning']) || {};
      var afternoonEntry = (_tkData[key] && _tkData[key]['afternoon']) || {};
      var currentEntry = phase === 'morning' ? morningEntry : afternoonEntry;
      var otherEntry = phase === 'morning' ? afternoonEntry : morningEntry;
      
      // Parse stats for both phases
      function parseStats(e) {
        var m = (e.detail || '').match(/更新(\d+)\+?(\d*)条|更新(\d+)条.*新增(\d+)条|手动抓取\s*(\d+)\+(\d+)条/);
        if (!m) return {update:0, create:0, total:0};
        var u = parseInt(m[1]||m[3]||m[5]||'0');
        var c = parseInt(m[2]||m[4]||m[6]||'0');
        return {update:u, create:c, total:u+c};
      }
      var curStats = parseStats(currentEntry);
      var otherStats = parseStats(otherEntry);
      
      // Relative time
      function relTime(ts) {
        if (!ts) return '';
        var d = Date.now() - ts;
        var m = Math.floor(d/60000);
        if (m < 1) return '刚刚';
        if (m < 60) return m + '分钟前';
        return Math.floor(m/60) + '小时前';
      }
      
      // Status helpers
      function statusBadge(s, label) {
        var cls = s==='done'?'ok':s==='failed'?'err':s==='running'?'run':'wait';
        var icon = s==='done'?'✓':s==='failed'?'✗':s==='running'?'◉':'○';
        return '<span class="tk-exp-badge ' + cls + '">' + icon + ' ' + (label||s) + '</span>';
      }
      function statusDot(s) {
        var cls = s==='done'?'ok':s==='failed'?'err':s==='running'?'run':'wait';
        return '<div class="tk-exp-dot ' + cls + '"></div>';
      }
      function timeCell(ts, label) {
        if (!ts) return '';
        var t = new Date(ts);
        var timeStr2 = String(t.getHours()).padStart(2,'0') + ':' + String(t.getMinutes()).padStart(2,'0');
        return '<div class="tk-exp-cell"><div class="tk-exp-cell-label">' + label + '</div><div class="tk-exp-cell-val tk-exp-time">' + timeStr2 + '</div></div>';
      }
      
      var mStatus = morningEntry.status || 'pending';
      var aStatus = afternoonEntry.status || 'pending';
      var mainStatus = currentEntry.status || 'pending';
      
      // V20.12.37: Glass-morphism card with platform color band
      var platColorClass = plat.replace(/一区|二区/, '');
      itemsHtml += '<div class="tk-exp-card tk-exp-card-acct-' + acct.tail + ' tk-exp-card-plat-' + platColorClass + '">';
      itemsHtml += '<div class="tk-exp-plat-band"></div>';
      
      // Header: platform name + account + main status
      itemsHtml += '<div class="tk-exp-header">';
      itemsHtml += '<div class="tk-exp-dot-wrap ' + mainStatus + '-bg">' + statusDot(mainStatus) + '</div>';
      itemsHtml += '<div class="tk-exp-info">';
      itemsHtml += '<div class="tk-exp-platform">' + plat + '</div>';
      itemsHtml += '<div class="tk-exp-account">' + acct.tail + ' · ' + acct.name + '</div>';
      itemsHtml += '</div>';
      itemsHtml += statusBadge(mainStatus, mainStatus==='done'?'已完成':mainStatus==='failed'?'失败':'待处理');
      itemsHtml += '</div>';
      
      // V20.12.37: Status timeline — horizontal progress indicator
      var tlMorning = morningEntry.status || 'pending';
      var tlAfternoon = afternoonEntry.status || 'pending';
      var tlMClass = tlMorning==='done'?'done':tlMorning==='running'?'run':tlMorning==='failed'?'fail':'wait';
      var tlAClass = tlAfternoon==='done'?'done':tlAfternoon==='running'?'run':tlAfternoon==='failed'?'fail':'wait';
      itemsHtml += '<div class="tk-exp-timeline">';
      itemsHtml += '<div><div class="tk-exp-tl-step ' + tlMClass + '"></div><div class="tk-exp-tl-label">上午</div></div>';
      itemsHtml += '<div><div class="tk-exp-tl-step ' + tlAClass + '"></div><div class="tk-exp-tl-label">下午</div></div>';
      itemsHtml += '</div>';
      
      // Two-phase comparison section
      itemsHtml += '<div class="tk-exp-phases">';
      
      // Morning column
      itemsHtml += '<div class="tk-exp-phase-col">';
      itemsHtml += '<div class="tk-exp-phase-header">';
      itemsHtml += '<span class="tk-exp-phase-icon">☀</span>';
      itemsHtml += '<span class="tk-exp-phase-title">上午预估</span>';
      itemsHtml += statusBadge(mStatus, mStatus==='done'?'完成':mStatus==='failed'?'失败':'待处理');
      itemsHtml += '</div>';
      if (mStatus === 'done') {
        itemsHtml += '<div class="tk-exp-phase-stats">';
        itemsHtml += '<div class="tk-exp-mini-stat"><span class="tk-exp-mini-label">抓取</span><span class="tk-exp-mini-val">' + morningEntry.detail + '</span></div>';
        if (morningEntry.ts) itemsHtml += '<div class="tk-exp-mini-stat"><span class="tk-exp-mini-label">时间</span><span class="tk-exp-mini-val tk-exp-time">' + tkTime(morningEntry.ts) + '</span></div>';
        if (relTime(morningEntry.ts)) itemsHtml += '<div class="tk-exp-mini-stat"><span class="tk-exp-mini-label">距今</span><span class="tk-exp-mini-val">' + relTime(morningEntry.ts) + '</span></div>';
        itemsHtml += '</div>';
      } else if (mStatus === 'failed') {
        itemsHtml += '<div class="tk-exp-phase-stats"><div class="tk-exp-mini-stat tk-exp-err"><span class="tk-exp-mini-label">错误</span><span class="tk-exp-mini-val">' + (morningEntry.detail||'').substring(0,25) + '</span></div></div>';
      } else {
        itemsHtml += '<div class="tk-exp-phase-stats"><div class="tk-exp-mini-stat"><span class="tk-exp-mini-val">等待执行</span></div></div>';
      }
      itemsHtml += '</div>';
      
      // Afternoon column
      itemsHtml += '<div class="tk-exp-phase-col">';
      itemsHtml += '<div class="tk-exp-phase-header">';
      itemsHtml += '<span class="tk-exp-phase-icon">🌙</span>';
      itemsHtml += '<span class="tk-exp-phase-title">下午回传</span>';
      itemsHtml += statusBadge(aStatus, aStatus==='done'?'完成':aStatus==='failed'?'失败':'待处理');
      itemsHtml += '</div>';
      if (aStatus === 'done') {
        var aStats = parseStats(afternoonEntry);
        itemsHtml += '<div class="tk-exp-phase-stats">';
        itemsHtml += '<div class="tk-exp-mini-stat"><span class="tk-exp-mini-label">更新</span><span class="tk-exp-mini-val">' + aStats.update + '</span></div>';
        itemsHtml += '<div class="tk-exp-mini-stat"><span class="tk-exp-mini-label">新增</span><span class="tk-exp-mini-val">' + aStats.create + '</span></div>';
        itemsHtml += '<div class="tk-exp-mini-stat"><span class="tk-exp-mini-label">总量</span><span class="tk-exp-mini-val tk-exp-accent">' + aStats.total + '</span></div>';
        if (afternoonEntry.ts) itemsHtml += '<div class="tk-exp-mini-stat"><span class="tk-exp-mini-label">时间</span><span class="tk-exp-mini-val tk-exp-time">' + tkTime(afternoonEntry.ts) + '</span></div>';
        if (relTime(afternoonEntry.ts)) itemsHtml += '<div class="tk-exp-mini-stat"><span class="tk-exp-mini-label">距今</span><span class="tk-exp-mini-val">' + relTime(afternoonEntry.ts) + '</span></div>';
        itemsHtml += '</div>';
      } else if (aStatus === 'failed') {
        itemsHtml += '<div class="tk-exp-phase-stats"><div class="tk-exp-mini-stat tk-exp-err"><span class="tk-exp-mini-label">错误</span><span class="tk-exp-mini-val">' + (afternoonEntry.detail||'').substring(0,25) + '</span></div></div>';
      } else {
        itemsHtml += '<div class="tk-exp-phase-stats"><div class="tk-exp-mini-stat"><span class="tk-exp-mini-val">等待执行</span></div></div>';
      }
      itemsHtml += '</div>';
      
      itemsHtml += '</div>'; // end phases
      
      // Operation logs for this platform
      var platLogs = _tkLogs.filter(function(l) { return l.tail === acct.tail && l.platform === plat; }).slice(-3);
      if (platLogs.length > 0) {
        itemsHtml += '<div class="tk-exp-logs">';
        itemsHtml += '<div class="tk-exp-logs-title">操作记录</div>';
        platLogs.forEach(function(l) {
          var lcls = l.action.indexOf('✓')>=0?'lo':l.action.indexOf('✗')>=0?'le':'li';
          itemsHtml += '<div class="tk-exp-log-line"><span class="tk-exp-log-time">' + l.time + '</span><span class="' + lcls + '">' + l.action + '</span>';
          if (l.detail) itemsHtml += '<span class="tk-exp-log-detail">' + l.detail.substring(0,20) + '</span>';
          itemsHtml += '</div>';
        });
        itemsHtml += '</div>';
      }
      
      itemsHtml += '</div>'; // end card
    });
    var allDone = aDone === aTotal;
    var inProg = aDone > 0 && !allDone;
    var bc = allDone ? 'done' : inProg ? 'prog' : '';
    var bt = allDone ? '✓ 全部' : aDone + '/' + aTotal;
    var openCls = inProg || aDone === 0 ? ' open' : '';

    bodyHtml += '<div class="tk-group' + openCls + '">';
    bodyHtml += '<div class="tk-group-head" onclick="this.parentElement.classList.toggle(\'open\')">';
    bodyHtml += '<div class="tk-group-ico ' + acct.css + '">' + acct.tail.slice(-2) + '</div>';
    bodyHtml += '<div class="tk-group-name">' + acct.name + '</div>';
    bodyHtml += '<div class="tk-group-tail">【' + acct.tail + '】</div>';
    bodyHtml += '<div class="tk-group-badge ' + bc + '">' + bt + '</div>';
    bodyHtml += '<svg class="tk-group-chv" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';
    bodyHtml += '</div>';
    bodyHtml += '<div class="tk-items">' + (itemsHtml || '<div class="tk-empty">暂无数据</div>') + '</div>';
    bodyHtml += '</div>';
    dotsHtml += '<div class="tk-dot-col"><div class="tk-dot-col-label">' + acct.tail.slice(-2) + '·' + acct.name + '</div>' + colHtml + '</div>';
  });

  // Update inline dots (visible at a glance)
  var dotsEl = document.getElementById('tkDots');
  if (dotsEl) dotsEl.innerHTML = dotsHtml || '<div class="tk-empty">暂无数据</div>';

  // Update detail body
  var bodyEl = document.getElementById('tkBody');
  if (bodyEl) bodyEl.innerHTML = bodyHtml || '<div class="tk-empty">暂无数据</div>';
  
  // V20.11.3: Attach click handlers for group headers (more reliable than inline onclick)
  if (bodyEl) {
    var groupHeads = bodyEl.querySelectorAll('.tk-group-head');
    groupHeads.forEach(function(head) {
      head.addEventListener('click', function(e) {
        e.stopPropagation();
        var group = this.parentElement;
        group.classList.toggle('open');
      });
    });
  }

  // Update progress bar
  var fillEl = document.getElementById('tkProgressFill');
  if (fillEl) {
    var pct = total > 0 ? Math.round((done + fail) / total * 100) : 0;
    fillEl.style.width = pct + '%';
    if (done + fail >= total && total > 0) fillEl.classList.add('done');
    else fillEl.classList.remove('done');
  }

  // Update summary text
  var sumEl = document.getElementById('tkSummary');
  if (sumEl) {
    var phaseName = phase === 'morning' ? '上午备货单' : '下午回传';
    if (done >= total && total > 0) sumEl.textContent = phaseName + ' · ' + total + '/' + total + ' 全部完成';
    else if (run > 0) sumEl.textContent = phaseName + ' · ' + done + '/' + total + ' 进行中';
    else sumEl.textContent = phaseName + ' · ' + total + ' 平台 · 待开始';
  }

  // Update badge
  var stateEl = document.getElementById('tkCardState');
  if (stateEl) {
    if (done >= total && total > 0) { stateEl.textContent = '已完成'; stateEl.style.background = 'rgba(34,197,94,.1)'; stateEl.style.color = '#22c55e'; }
    else if (run > 0) { stateEl.textContent = done + '/' + total; stateEl.style.background = 'rgba(59,154,255,.1)'; stateEl.style.color = '#3b9aff'; }
    else if (done > 0) { stateEl.textContent = done + '/' + total; stateEl.style.background = 'rgba(59,154,255,.1)'; stateEl.style.color = '#3b9aff'; }
    else { stateEl.textContent = '待执行'; stateEl.style.background = 'rgba(255,255,255,.05)'; stateEl.style.color = 'var(--g3)'; }
  }

  // Update logs
  var logEl = document.getElementById('tkLog');
  if (logEl) {
    var logHtml = '';
    var phaseLogs = _tkLogs.filter(function(l){ return l.phase === phase; });
    var recent = phaseLogs.slice(-12);
    for (var i = recent.length - 1; i >= 0; i--) {
      var l = recent[i];
      var cls = l.action.indexOf('✓')>=0?'lo':l.action.indexOf('✗')>=0?'le':'li';
      logHtml += '<div class="tk-log-line">' + l.time + ' <span class="' + cls + '">' + l.account + '-' + l.platform + ' ' + l.action;
      if (l.detail) logHtml += ' ' + l.detail;
      logHtml += '</span></div>';
    }
    logEl.innerHTML = logHtml || '<div class="tk-empty">暂无日志</div>';
  }
}
  // V20.12.7: Force pending items to gray (override any cached blue)
  try {
    document.querySelectorAll(".tk-dot-item.wait, .tk-exp-dot.wait").forEach(function(el) {
      el.style.setProperty("color", "#9ca3af", "important");
    });
    document.querySelectorAll(".tk-exp-dot.wait").forEach(function(el) {
      el.style.setProperty("background", "#9ca3af", "important");
      el.style.setProperty("opacity", "0.5", "important");
    });
    document.querySelectorAll(".tk-dot-item.wait .pip-dot").forEach(function(el) {
      el.style.setProperty("background", "#9ca3af", "important");
      el.style.setProperty("opacity", "0.4", "important");
    });
    document.querySelectorAll(".tk-exp-badge.wait").forEach(function(el) {
      el.style.setProperty("color", "#9ca3af", "important");
      el.style.setProperty("background", "rgba(156,163,175,.1)", "important");
    });
    document.querySelectorAll(".tk-exp-dot-wrap.pending-bg").forEach(function(el) {
      el.style.setProperty("background", "rgba(156,163,175,.08)", "important");
    });
  } catch(e){}




// V20.10.8: Auto-fix — if background received tkMark message, reload tracker data
chrome.storage.onChanged.addListener(function(changes, area) {
  if (area === 'local' && changes.extractionTracker) {
    try {
      var t = changes.extractionTracker.newValue;
      if (t && t.date === tkDateKey()) {
        _tkData = t.data || {};
        _tkLogs = t.logs || [];
        tkRender();
      }
    } catch(e) {}
  }
});


// V20.11.1: Midnight reset timer — auto-clear tracker at 00:00
(function _midnightReset() {
  function scheduleMidnightReset() {
    var now = new Date();
    var midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0); // Next midnight
    var msUntilMidnight = midnight.getTime() - now.getTime();
    setTimeout(function() {
      // Clear tracker data
      _tkData = {};
      _tkLogs = [];
      tkSave();
      tkRender();
      L('[追踪] 已自动重置（每日0点清空）', 'i');
      // Schedule next midnight
      scheduleMidnightReset();
    }, msUntilMidnight);
    console.log('[Tracker] Midnight reset scheduled in ' + Math.round(msUntilMidnight / 60000) + ' minutes');
  }
  scheduleMidnightReset();
})();

function trackerInit() {
  tkLoad(function() {
    // V20.15.1: 定期自动保存 + 页面隐藏时保存
    setInterval(function() { tkSave(); }, 30000); // 每30秒自动保存
    document.addEventListener('visibilitychange', function() {
      if (document.hidden) tkSave(); // 切换标签时保存
    });
    window.addEventListener('beforeunload', function() { tkSave(); }); // 关闭前保存
    window.addEventListener('pagehide', function() { tkSave(); }); // V20.16.1: pagehide 保存
    // V20.10.8: Auto-mark sibling platforms when account has completed returns
    // If an account has any 'done' afternoon records, mark all pending platforms as done
    try {
      // V20.12.37: DISABLED auto-mark logic to prevent cross-account marking issues
      // Each platform must be explicitly marked by the user or by the actual return process
      // TK_ACCOUNTS.forEach(function(acct) {
      //   var hasDone = false;
      //   var pendingPlats = [];
      //   acct.platforms.forEach(function(plat) {
      //     var key = tkKey(acct.tail, plat);
      //     var entry = (_tkData[key] && _tkData[key]['afternoon']) || {};
      //     if (entry.status === 'done') hasDone = true;
      //     else if (!entry.status || entry.status === 'pending') pendingPlats.push(plat);
      //   });
      //   if (hasDone && pendingPlats.length > 0 && pendingPlats.length <= 2) {
      //     pendingPlats.forEach(function(plat) {
      //       var key = tkKey(acct.tail, plat);
      //       _tkData[key] = _tkData[key] || {};
      //       _tkData[key]['afternoon'] = {status:'done', ts:Date.now(), detail:'自动标记'};
      //     });
      //     tkSave();
      //   }
      // });
    } catch(amErr) {}


    var hasData = Object.keys(_tkData).length > 0;
    if (hasData) { _tkShown = true; }
    tkRender();
  });
  // Click card head to expand/collapse detail
  var cardHead = document.querySelector('.tk-card-head');
  var detailPanel = document.getElementById('tkDetailPanel');
  if (cardHead && detailPanel) {
    cardHead.addEventListener('click', function(e) {
      if (e.target.closest('.tk-card-tab')) return;
      detailPanel.classList.toggle('open');
    });
  }
  // Tab switching
  var tabM = document.getElementById('tkTabM');
  var tabA = document.getElementById('tkTabA');
  if (tabM) tabM.addEventListener('click', function(e) {
    e.stopPropagation();
    _tkPhase = 'morning';
    tabM.className = 'tk-card-tab active';
    if (tabA) tabA.className = 'tk-card-tab';
    tkRender();
  });
  if (tabA) tabA.addEventListener('click', function(e) {
    e.stopPropagation();
    _tkPhase = 'afternoon';
    tabA.className = 'tk-card-tab active-green';
    if (tabM) tabM.className = 'tk-card-tab';
    tkRender();
  });
  // Log toggle
  var logTog = document.getElementById('tkLogToggle');
  if (logTog) logTog.addEventListener('click', function() {
    logTog.classList.toggle('open');
    var logEl = document.getElementById('tkLog');
    if (logEl) logEl.classList.toggle('open');
  });
}

// Local-only visual QA hook. Never runs inside the installed extension.
if (location.protocol !== 'chrome-extension:'
    && new URLSearchParams(location.search).has('running-preview')) {
  setTimeout(function() {
    if (!beginTask('diagScan', '预览运行态：其他操作已锁定，日志仍可查看')) return;
    L('=== 运行态视觉预览 ===', 's');
    L('任务执行期间，仅日志查看、展开与清空保持可用', 'i');
  }, 180);
}

// ===== V20.29.0: 下午回传工作流（移植自 V20.28.12 模块化工作流层） =====
// 评估结论：V20.28.x 的工作流编排（sync→verify→fail-closed cleanup→tracker）是优化，
// 已移植；不移植其放宽的合并阈值（误合并根源）。
function afternoonWorkflowCanCleanup(procurementResult, verificationResult) {
  return !!(procurementResult && procurementResult.ok !== false
    && verificationResult && verificationResult.ok === true
    && Number(verificationResult.warnings || 0) === 0);
}

function canonicalProcurementTitleKey(title) {
  var raw = String(title || '').trim()
    .replace(/(?:\[\s*拆分\s*\]|【\s*拆分\s*】)\s*$/i, '')
    .trim();
  return normTitle(raw);
}

function chooseProcurementTitleRecord(records, titleField, statusField, targetTitle) {
  var list = (records || []).slice();
  function value(record, field, fallbacks) {
    var fields = record && record.fields ? record.fields : {};
    var names = [field].concat(fallbacks || []);
    for (var i = 0; i < names.length; i++) {
      if (names[i] && fields[names[i]] !== undefined && fields[names[i]] !== null) {
        var text = sv(fields[names[i]]);
        if (text) return text;
      }
    }
    return '';
  }
  list.sort(function(a, b) {
    var at = value(a, titleField, ['📡 商品全称', '商品全称', '商品标题']);
    var bt = value(b, titleField, ['📡 商品全称', '商品全称', '商品标题']);
    var aExact = targetTitle && procurementTitleIdentityExact(at, targetTitle) ? 1 : 0;
    var bExact = targetTitle && procurementTitleIdentityExact(bt, targetTitle) ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    var aSplit = procurementHasSplitTitleMarker(at) ? 1 : 0;
    var bSplit = procurementHasSplitTitleMarker(bt) ? 1 : 0;
    if (aSplit !== bSplit) return aSplit - bSplit;
    var aPrinted = value(a, statusField, ['手动传输状态', '状态', '🚃 状态🌅', '传输状态']) === '已打单' ? 1 : 0;
    var bPrinted = value(b, statusField, ['手动传输状态', '状态', '🚃 状态🌅', '传输状态']) === '已打单' ? 1 : 0;
    if (aPrinted !== bPrinted) return bPrinted - aPrinted;
    return String(a.record_id || '').localeCompare(String(b.record_id || ''));
  });
  return list[0] || null;
}

function collectExecutedStatusUpgradeRecordIds(batch, statusUpgradeRecordIds, statusField) {
  var executed = {};
  (batch || []).forEach(function(item) {
    var payloadStatus = item && item.fields && statusField
      ? String(item.fields[statusField] || '').trim() : '';
    if (item && item.record_id && statusUpgradeRecordIds[item.record_id]
        && payloadStatus === '已打单') {
      executed[item.record_id] = true;
    }
  });
  return executed;
}

function copyProcurementSourcePlan(plan, fieldNames) {
  var sourceFields = {};
  Object.keys((plan && plan.fields) || {}).forEach(function(key) {
    sourceFields[key] = plan.fields[key];
  });
  var title = plan && plan.title !== undefined
    ? plan.title : sourceFields[fieldNames.title];
  var spec = plan && plan.spec !== undefined
    ? plan.spec : sourceFields[fieldNames.spec];
  return {
    sourceId: plan && plan.sourceId ? plan.sourceId : '',
    record_id: plan && plan.record_id ? plan.record_id : '',
    targetId: plan && plan.targetId ? plan.targetId : '',
    title: title || '',
    spec: spec || '',
    platform: plan && plan.platform !== undefined
      ? plan.platform : sourceFields[fieldNames.platform],
    imageUrl: plan && plan.imageUrl !== undefined ? plan.imageUrl : '',
    imageFieldValue: plan && plan.imageFieldValue !== undefined
      ? plan.imageFieldValue : sourceFields[fieldNames.image],
    needsAttachment: !!(plan && plan.needsAttachment),
    attachmentValue: plan && plan.attachmentValue !== undefined
      ? plan.attachmentValue : sourceFields[fieldNames.attachment],
    fields: sourceFields,
    matchType: plan && plan.matchType ? plan.matchType : ''
  };
}

function delegateAutomationNotice(title, content, color, cardElements) {
  if (typeof window !== 'undefined'
      && typeof window.dgjNotifyCompletionSafely === 'function') {
    try {
      return Promise.resolve(window.dgjNotifyCompletionSafely(
        title,
        String(content || '').split('\n'),
        color || 'blue',
        cardElements || []
      )).catch(function() { return {ok:false}; });
    } catch (error) {
      return Promise.resolve({ok:false});
    }
  }
  return Promise.resolve({ok:false, skipped:true});
}

function describePostMergeUnresolved(item) {
  item = item || {};
  var issue = item.result && item.result.issues && item.result.issues[0];
  var reason = item.reason || (issue && (issue.type || issue.message)) || 'UNKNOWN';
  var source = item.sourcePlan || {};
  var sourceId = source.sourceId || source.record_id || '';
  var title = String(source.title || '').replace(/\s+/g, ' ').trim().substring(0, 80);
  var spec = String(source.spec || '').replace(/\s+/g, ' ').trim().substring(0, 120);
  var parts = [reason];
  if (sourceId) parts.push('source=' + sourceId);
  if (title) parts.push('title=' + title);
  if (spec) parts.push('spec=' + spec);
  return parts.join(' | ');
}

function extractCoreProductFamilies(title) {
  if (!title) return [];
  var families = [];
  Object.keys(CORE_PRODUCT_FAMILIES).forEach(function(family) {
    var matched = CORE_PRODUCT_FAMILIES[family].some(function(kw) {
      return title.indexOf(kw) >= 0;
    });
    if (matched) families.push(family);
  });
  return families;
}

function finalizeAfternoonSourceCleanup(ids) {
  var unique = [], seen = {};
  (ids || []).forEach(function(id) {
    id = String(id || '').trim();
    if (id && !seen[id]) { seen[id] = 1; unique.push(id); }
  });
  if (!unique.length) return Promise.resolve({ok:true, deleted:0, remaining:[]});
  // V20.25.1 emergency guard: no source deletion until the platform
  // classifier and the affected-record recovery review are complete.
  L('[紧急保护] 下午回传禁用中转站来源删除，待复核保留: ' + unique.length + ' 条', 'e');
  return Promise.resolve({ok:true, deleted:0, skipped:unique.length, remaining:unique});
  var deleted = 0;
  var chain = Promise.resolve();
  for (var i = 0; i < unique.length; i += 100) {
    (function(batch) {
      chain = chain.then(function() {
        return getToken().then(function(token) {
          return feishuProxy(
            'https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT + '/tables/'
              + (typeof TT !== 'undefined' ? TT : PROC_TABLE) + '/records/batch_delete',
            'POST',
            {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
            JSON.stringify({records:batch})
          );
        }).then(function(response) {
          if (!response || response.code !== 0) {
            var error = new Error('下午回传来源清理失败: ' + (response && response.code)
              + ' ' + ((response && response.msg) || 'unknown'));
            error.deleted = deleted;
            error.remaining = unique.slice(deleted);
            throw error;
          }
          deleted += batch.length;
          L('采购表校验成功，清理中转站过期来源: ' + batch.length + ' 条', 'i');
        });
      });
    })(unique.slice(i, i + 100));
  }
  return chain.then(function() {
    invalidateDataCache();
    return {ok:true, deleted:deleted, remaining:[]};
  });
}

function isUnsafePostMergeResult(result) {
  if (!result) return true;
  if (result.severity === 'block') return true;
  return (result.issues || []).some(function(issue) {
    return issue.type === 'EMPTY_MERGED_SPEC';
  });
}

function isolatedProcurementOperation(plan, baseOperation, fieldNames, recordId) {
  var sourcePlan = copyProcurementSourcePlan(plan, fieldNames);
  var fields = {};
  Object.keys(sourcePlan.fields || {}).forEach(function(key) {
    fields[key] = sourcePlan.fields[key];
  });
  if (fieldNames.title) fields[fieldNames.title] = sourcePlan.title;
  if (fieldNames.spec) fields[fieldNames.spec] = sourcePlan.spec;
  if (fieldNames.image && sourcePlan.imageFieldValue !== undefined) {
    fields[fieldNames.image] = sourcePlan.imageFieldValue;
  }
  if (fieldNames.attachment && sourcePlan.attachmentValue !== undefined) {
    fields[fieldNames.attachment] = sourcePlan.attachmentValue;
  }
  if (fieldNames.dateWrite) fields[fieldNames.dateWrite] = Date.now();
  var operation = {
    fields: fields,
    sourceCount: 1,
    sourcePlans: [sourcePlan],
    matchType: recordId
      ? ((baseOperation && baseOperation.matchType) || 'UPDATE_ISOLATED')
      : 'CREATE_ISOLATED',
    affected: !!(baseOperation && baseOperation.affected),
    imageUrl: sourcePlan.imageUrl || '',
    needsAttachment: sourcePlan.needsAttachment,
    attachmentValue: sourcePlan.attachmentValue
  };
  if (recordId) operation.record_id = recordId;
  return operation;
}

function matchPlatformAccount(recordPlat, targetPlatform) {
  if (!recordPlat || !targetPlatform) return false;
  // 精确匹配
  if (recordPlat === targetPlatform) return true;
  // V20.23.17: 支持多行平台字段（多平台合并记录）
  var recordPlatforms = String(recordPlat).split(/[\n,]/).map(function(p){return p.trim();}).filter(Boolean);
  for (var pi = 0; pi < recordPlatforms.length; pi++) {
    var rp = recordPlatforms[pi];
    if (rp === targetPlatform) return true;
    // 提取店管家账号
    var recAccount = (rp.match(/[【](\d{4})[】]/) || [])[1] || '';
    var tgtAccount = (targetPlatform.match(/[【](\d{4})[】]/) || [])[1] || '';
    // 提取平台名称（不含账号）
    var recBase = rp.split('-【')[0].trim();
    var tgtBase = targetPlatform.split('-【')[0].trim();
    // 店管家账号和平台名称都必须匹配
    if (recAccount && tgtAccount && recAccount === tgtAccount && recBase === tgtBase) {
      // 额外检查：如果有分区（一区/二区），也需要匹配
      var recZone = (rp.match(/(一区|二区)/) || [])[1] || '';
      var tgtZone = (targetPlatform.match(/(一区|二区)/) || [])[1] || '';
      // A missing zone is not a wildcard. Never match a zoned source to an
      // unzoned target, and never match 一区 to 二区.
      if (recZone !== tgtZone) continue;
      return true;
    }
  }
  return false;
}

function mergeSpecIdentityEvidence(specA, specB) {
  var a = mergeSpecIdentityLines(specA), b = mergeSpecIdentityLines(specB);
  if (!a.length || !b.length) return {
    genericOnly: !a.length && !b.length,
    oneSidedGeneric: !a.length !== !b.length,
    strong:false, medium:false, score:0
  };
  var best = 0, bestMinLen = 0, bestRatio = 0;
  var weightedA = 0, weightedB = 0, totalA = 0, totalB = 0;
  function lineBest(line, other) {
    var bestLine = 0;
    other.forEach(function(candidate) {
      bestLine = Math.max(bestLine, diceSim(line, candidate), triSim(line, candidate));
    });
    return bestLine;
  }
  a.forEach(function(x) { b.forEach(function(y) {
    var sim = Math.max(diceSim(x, y), triSim(x, y));
    var minLen = Math.min(x.length, y.length);
    var ratio = minLen / Math.max(x.length, y.length);
    if (sim > best) { best = sim; bestMinLen = minLen; bestRatio = ratio; }
  }); });
  a.forEach(function(x) {
    var score = lineBest(x, b), weight = Math.max(x.length, 1);
    totalA += weight; if (score >= 0.60) weightedA += weight * score;
  });
  b.forEach(function(y) {
    var score = lineBest(y, a), weight = Math.max(y.length, 1);
    totalB += weight; if (score >= 0.60) weightedB += weight * score;
  });
  var coverageA = totalA ? weightedA / totalA : 0;
  var coverageB = totalB ? weightedB / totalB : 0;
  var token = specTokenOverlap(a.join('\n'), b.join('\n'));
  var singlePair = a.length === 1 && b.length === 1;
  var coverageOk = singlePair || (coverageA >= 0.75 && coverageB >= 0.75);
  var strong = coverageOk && ((bestMinLen >= 8 && best >= 0.78 && bestRatio >= 0.60)
    || (bestMinLen >= 12 && token >= 0.68)
    || (bestMinLen >= 8 && token >= 0.78));
  var medium = coverageOk && ((bestMinLen >= 5 && best >= 0.60)
    || (bestMinLen >= 6 && token >= 0.55));
  return {genericOnly:false, strong:strong, medium:medium, score:Math.max(best, token), bestLen:bestMinLen,
    coverageA:coverageA, coverageB:coverageB};
}

function mergeSpecIdentityLines(specStr) {
  var names = extractSpecNames(specStr);
  var seen = {}, result = [];
  Object.keys(names).forEach(function(name) {
    var clean = String(name || '').toLowerCase()
      .replace(/限时特惠|厂家直销|厂家直发|家庭必备|批发|爆款|热卖|超值|优惠|体验款|尝鲜装|贵在运费|聚划算|更划算|够用半年/g, '')
      .replace(/颜色随机|款式随机|随机发货|新老包装随机发货/g, '')
      .replace(/\d+(?:个|件|套|包|袋|盒|卷|条|片|张|只|支|枚|颗|粒|双|组)(?:装)?/g, '')
      .replace(/(?:大号|中号|小号|均码|标准款|基础款|升级款|红色|橙色|黄色|绿色|蓝色|青色|紫色|粉色|黑色|白色|灰色|棕色|米色|卡其色|咖啡色)/g, '')
      .replace(/[\s,，;；:：|/\\()[\]【】「」“”]+/g, '')
      .trim();
    if (clean.length < 2 || seen[clean]) return;
    seen[clean] = 1;
    result.push(clean);
  });
  return result;
}

function notifyManualReturnCompletion(result, taskName) {
  var workflow = result || {};
  var automationReturn = typeof window !== 'undefined' && window._dgjAutomationReturn;
  if (automationReturn) {
    window._dgjAutomationReturn = false;
  }
  if (!result || workflow.ok === false) {
    return Promise.resolve({ok:false, skipped:'workflow_failed'});
  }
  if (automationReturn) {
    return Promise.resolve({ok:true, skipped:'automation'});
  }
  var r = workflow;
  var platform = String(r.platform || (r.returnResult && r.returnResult.platform) || '').trim();
  var tailMatch = platform.match(/【(\d+)】/);
  var tail = tailMatch ? tailMatch[1] : '';
  var basePlatform = platform.replace(/-【.*$/, '');
  var summary = typeof window !== 'undefined'
    && typeof window.dgjFormatAfternoonSummary === 'function'
    ? window.dgjFormatAfternoonSummary(r)
    : taskName + '完成';
  var cardElements = typeof window !== 'undefined'
    && typeof window.dgjFormatAfternoonCardElements === 'function'
    ? window.dgjFormatAfternoonCardElements(r)
    : [];
  return delegateAutomationNotice(
    '✅ ' + (basePlatform || taskName) + (tail ? '-【' + tail + '】' : '') + ' · 回传完成',
    summary,
    'green',
    cardElements
  );
}

function preparePostMergeProcurementPlan(
  updates, creates, report, fieldNames, incrementalPlatform, expectedStats
) {
  var operations = (updates || []).concat(creates || []);
  var stats = procurementPlanStats(operations, fieldNames || {});
  if (!stats.valid || (expectedStats && (
    stats.sourceCount !== expectedStats.sourceCount
    || Math.abs(stats.qtyTotal - expectedStats.qtyTotal) > 0.000001
  ))) {
    return {ok:false, updates:[], creates:[], reason:'post_merge_fallback'};
  }
  var unsafe = (report && report.results || []).some(function(entry) {
    return isUnsafePostMergeResult(entry.result);
  });
  if (!unsafe) {
    return {
      ok:true, updates:updates || [], creates:creates || [], recovered:0,
      unresolved:[], sourceCount:stats.sourceCount, qtyTotal:stats.qtyTotal
    };
  }
  var fallback = recoverBlockedProcurementPlans(
    updates, creates, report, fieldNames, incrementalPlatform, expectedStats
  );
  if (!fallback.ok) {
    return {
      ok:false, updates:[], creates:[], reason:'post_merge_fallback',
      unresolved:fallback.unresolved || []
    };
  }
  return fallback;
}

function procurementDistinctiveTitleConflict(titleA, titleB) {
  var generic = /^(?:新款|升级|加厚|加大|特大|迷你|豪华|高端|精品|旗舰|热卖|爆款|超值|到手|包邮|推荐|老师推荐|出行好物|收纳神器|限时特惠|大号|中号|小号|颜色随机|随机发货)$/;
  function marked(text) {
    var out = [], re = /【([^】]+)】|《([^》]+)》|「([^」]+)」|“([^”]+)”/g, match;
    while ((match = re.exec(String(text || '')))) {
      var value = String(match[1] || match[2] || match[3] || match[4] || '')
        .replace(/[0-9０-９.。之的款型型号]/g, '').trim();
      if (value.length >= 2 && !generic.test(value) && out.indexOf(value) < 0) out.push(value);
    }
    return out;
  }
  var a = marked(titleA), b = marked(titleB);
  if (!a.length || !b.length) return false;
  return !a.some(function(value) { return b.indexOf(value) >= 0; });
}

function procurementHasSplitTitleMarker(title) {
  return /(?:\[\s*拆分\s*\]|【\s*拆分\s*】)\s*$/i.test(String(title || '').trim());
}

function procurementPlanStats(operations, fieldNames) {
  var sourceCount = 0;
  var qtyTotal = 0;
  var valid = true;
  (operations || []).forEach(function(operation) {
    var plans = operation && operation.sourcePlans;
    if (!Array.isArray(plans) || !plans.length) {
      valid = false;
      return;
    }
    plans.forEach(function(plan) {
      sourceCount++;
      qtyTotal += procurementSpecQtyTotal(
        plan.spec !== undefined ? plan.spec : ((plan.fields || {})[fieldNames.spec] || '')
      );
    });
  });
  return {valid:valid, sourceCount:sourceCount, qtyTotal:qtyTotal};
}

function procurementProfileIdentitySafe(profile) {
  if (!profile) return false;
  return strictSpecTitleConsistency(profile.title || '', profile.spec || '');
}

function procurementSourcePlanInScope(plan, incrementalPlatform) {
  if (!incrementalPlatform) return true;
  var platforms = String((plan && plan.platform) || '').split(/[\n,]/)
    .map(function(platform) { return platform.trim(); })
    .filter(Boolean);
  return platforms.length > 0 && platforms.every(function(platform) {
    return platform === incrementalPlatform;
  });
}

function procurementTitleFamilyConflict(titleA, titleB) {
  function isShoeBagTitle(title) {
    var text = String(title || '');
    return /鞋袋|洗鞋袋|鞋套|鞋包|(?:鞋|拖鞋).{0,14}(?:分装袋|收纳袋|整理袋|压缩袋)/.test(text);
  }
  var shoeA = isShoeBagTitle(titleA);
  var shoeB = isShoeBagTitle(titleB);
  return shoeA !== shoeB;
}

function procurementTitleIdentityExact(titleA, titleB) {
  var a = canonicalProcurementTitleKey(titleA);
  var b = canonicalProcurementTitleKey(titleB);
  // Do not let an empty or generic title become a global merge key.
  return !!a && a.length >= 8 && a === b;
}

function recoverBlockedProcurementPlans(
  updates, creates, report, fieldNames, incrementalPlatform, expectedStats
) {
  fieldNames = fieldNames || {};
  incrementalPlatform = String(incrementalPlatform || '').trim();
  var blockedOperations = [];
  (report && report.results || []).forEach(function(entry) {
    if (!isUnsafePostMergeResult(entry.result)) return;
    var operation = entry.group && entry.group.operation;
    if (operation && blockedOperations.indexOf(operation) < 0) {
      blockedOperations.push(operation);
    }
  });

  var allOperations = (updates || []).concat(creates || []);
  var originalStats = procurementPlanStats(allOperations, fieldNames);
  if (!originalStats.valid) {
    return {
      ok:false, updates:[], creates:[], recovered:0,
      unresolved:[{reason:'MISSING_SOURCE_PLANS'}], sourceCount:0, qtyTotal:0
    };
  }
  if (expectedStats && (
    originalStats.sourceCount !== expectedStats.sourceCount
    || Math.abs(originalStats.qtyTotal - expectedStats.qtyTotal) > 0.000001
  )) {
    return {
      ok:false, updates:[], creates:[], recovered:0,
      unresolved:[{
        reason:'EXPECTED_INCREMENTAL_SCOPE_MISMATCH',
        expectedSourceCount:expectedStats.sourceCount,
        expectedQtyTotal:expectedStats.qtyTotal,
        actualSourceCount:originalStats.sourceCount,
        actualQtyTotal:originalStats.qtyTotal
      }], sourceCount:0, qtyTotal:0
    };
  }

  var recoveredUpdates = [];
  var recoveredCreates = [];
  var unresolved = [];
  var recovered = 0;
  allOperations.forEach(function(operation) {
    var isBlocked = blockedOperations.indexOf(operation) >= 0;
    if (!isBlocked) {
      if ((updates || []).indexOf(operation) >= 0) recoveredUpdates.push(operation);
      else recoveredCreates.push(operation);
      return;
    }
    var plans = operation.sourcePlans || [];
    if (incrementalPlatform && plans.some(function(plan) {
      return !procurementSourcePlanInScope(plan, incrementalPlatform);
    })) {
      unresolved.push({operation:operation, reason:'SOURCE_PLATFORM_SCOPE_MISMATCH'});
      return;
    }
    var safePlans = [];
    plans.forEach(function(plan) {
      var source = copyProcurementSourcePlan(plan, fieldNames);
      var result = postMergeVerify({
        title: source.title,
        mergedSpec: source.spec,
        originalSpecs: [source.spec],
        recordId: operation.record_id || 'new',
        matchType: source.matchType || operation.matchType || 'source'
      });
      if (isUnsafePostMergeResult(result)) {
        unresolved.push({operation:operation, sourcePlan:source, result:result});
      } else {
        safePlans.push(source);
      }
    });
    if (safePlans.length !== plans.length) return;
    if (!safePlans.length) return;
    safePlans.forEach(function(plan, index) {
      if ((updates || []).indexOf(operation) >= 0 && index === 0) {
        recoveredUpdates.push(isolatedProcurementOperation(
          plan, operation, fieldNames, operation.record_id
        ));
      } else {
        recoveredCreates.push(isolatedProcurementOperation(plan, operation, fieldNames));
      }
    });
    recovered++;
  });

  if (unresolved.length) {
    return {
      ok:false, updates:[], creates:[], recovered:recovered,
      unresolved:unresolved, sourceCount:0, qtyTotal:0
    };
  }
  var finalStats = procurementPlanStats(
    recoveredUpdates.concat(recoveredCreates), fieldNames
  );
  if (!finalStats.valid
      || finalStats.sourceCount !== originalStats.sourceCount
      || Math.abs(finalStats.qtyTotal - originalStats.qtyTotal) > 0.000001) {
    return {
      ok:false, updates:[], creates:[], recovered:recovered,
      unresolved:[{
        reason:'CONSERVATION_FAILED',
        plannedSourceCount:originalStats.sourceCount,
        plannedQtyTotal:originalStats.qtyTotal,
        finalSourceCount:finalStats.sourceCount,
        finalQtyTotal:finalStats.qtyTotal
      }], sourceCount:0, qtyTotal:0
    };
  }
  if (expectedStats && (
    finalStats.sourceCount !== expectedStats.sourceCount
    || Math.abs(finalStats.qtyTotal - expectedStats.qtyTotal) > 0.000001
  )) {
    return {
      ok:false, updates:[], creates:[], recovered:recovered,
      unresolved:[{
        reason:'FINAL_INCREMENTAL_SCOPE_MISMATCH',
        expectedSourceCount:expectedStats.sourceCount,
        expectedQtyTotal:expectedStats.qtyTotal,
        finalSourceCount:finalStats.sourceCount,
        finalQtyTotal:finalStats.qtyTotal
      }], sourceCount:0, qtyTotal:0
    };
  }
  return {
    ok:true,
    updates:recoveredUpdates,
    creates:recoveredCreates,
    recovered:recovered,
    unresolved:[],
    sourceCount:finalStats.sourceCount,
    qtyTotal:finalStats.qtyTotal
  };
}

function restoreMergeGroupSourceRecords(mergedGroup) {
  var sourceItems = mergedGroup && Array.isArray(mergedGroup.sourceItems)
    ? mergedGroup.sourceItems : [];
  if (sourceItems.length <= 1) return [];
  return sourceItems.map(function(item) {
    var specs = (item && item.specs || []).map(function(spec) {
      return (spec && spec.name ? spec.name : '') + ';' + (spec && spec.qty ? spec.qty : 0);
    }).filter(function(line) { return line !== ';0'; });
    return {
      title: item && item.title || '',
      productId: item && item.productId || '',
      imgSrc: item && item.imgSrc || '',
      specStr: specs.join('\n'),
      platform: item && item.platform ? String(item.platform).split(/\n/)[0].trim() : ''
    };
  });
}

function runAfternoonPostReturn(taskId, returnResult) {
  var r = returnResult || {};
  var platform = String(r.platform || '').trim();
  var pendingStaleIds = Array.isArray(r.pendingStaleIds) ? r.pendingStaleIds.slice() : [];
  var taskName = taskId === 'incrementalReturnBtn' ? '增量回传' : '下午回传';
  if (!platform) {
    var scopeError = '下午回传缺少精确平台范围，已安全停止';
    _lastReturnWorkflowResult = {
      ok:false,
      stage:'scope',
      platform:'',
      pendingStaleIds:pendingStaleIds,
      error:scopeError
    };
    L(scopeError, 'e');
    endTask(taskId, false, scopeError);
    return Promise.resolve({ok:false, stage:'scope', platform:'', error:scopeError});
  }
  L('自动同步到采购表（当前平台增量范围）...', 'i');
  return Promise.resolve().then(function() {
    return syncToProcurement({
      incrementalPlatform:platform,
      excludedSourceIds:pendingStaleIds
    });
  }).then(function(procurementResult) {
    if (!procurementResult || procurementResult.ok === false) {
      var procurementError = new Error('采购表同步未完整完成，暂不清理中转站来源');
      procurementError.stage = procurementResult && procurementResult.stage
        ? procurementResult.stage : 'procurement';
      procurementError.skipFailureTracker = true;
      throw procurementError;
    }
    L('采购表同步成功，开始回传结果校验...', 'i');
    return verifyUpload(
      r.snapshotProductCount !== undefined ? r.snapshotProductCount : (r.updated || 0) + (r.created || 0),
      taskName,
      platform,
      {
        expectedSafeCount:Math.max(0, r.safeSnapshotRecordCount
          ?? ((r.updated || 0) + (r.created || 0))),
        skippedLegacyRecordIds:r.skippedLegacyRecordIds || [],
        excludedRecordIds:pendingStaleIds
      }
    ).then(function(verificationResult) {
      if (!afternoonWorkflowCanCleanup(procurementResult, verificationResult)) {
        var verificationError = new Error('下午回传校验未通过，暂不清理中转站来源');
        verificationError.stage = 'verify';
        verificationError.verification = verificationResult || {};
        throw verificationError;
      }
      L('回传校验通过，执行中转站待清理来源...', 'i');
      return finalizeAfternoonSourceCleanup(pendingStaleIds).then(function(cleanupResult) {
        return {procurement:procurementResult, verification:verificationResult, cleanup:cleanupResult};
      });
    });
  }).then(function(stages) {
    return new Promise(function(resolve) {
      chrome.storage.local.set({
        dgjLastReturnPlatform:platform,
        dgjLastReturnAt:Date.now()
      }, resolve);
    }).then(function() {
      var tailMatch = platform.match(/【(\d+)】/);
      var tail = tailMatch ? tailMatch[1] : '';
      var basePlatform = platform.replace(/-【.*$/, '');
      var procurementPartial = !!(stages.procurement && stages.procurement.partialSafe);
      return trackerRecordAfternoon(
        tail,
        basePlatform,
        (r.partialSafe || procurementPartial) ? 'partial' : 'done',
        ((r.partialSafe || procurementPartial) ? '部分完成 ' : '')
          + '更新' + (r.updated || 0) + '条 新增' + (r.created || 0)
          + '条 清理' + ((stages.cleanup && stages.cleanup.deleted) || 0) + '条'
      ).catch(function() {}).then(function() {
        _lastReturnWorkflowResult = {
          ok:true,
          stage:'complete',
          platform:platform,
          updated:r.updated || 0,
          created:r.created || 0,
          splitUpdated:r.splitUpdated || 0,
          pendingStaleIds:pendingStaleIds,
          removedUnprinted:(stages.cleanup && stages.cleanup.deleted) || 0,
          procurementUpdated:(stages.procurement && stages.procurement.updated) || 0,
          procurementCreated:(stages.procurement && stages.procurement.created) || 0,
          partialSafe:!!(r.partialSafe || r.legacyMixedCount || r.skippedLegacyCount
            || procurementPartial),
          skippedLegacyCount:r.skippedLegacyCount || 0,
          skippedLegacyItemCount:r.skippedLegacyItemCount || 0,
          skippedLegacyQty:r.skippedLegacyQty || 0,
          legacyMixedCount:r.legacyMixedCount || 0,
          attachmentUpdated:(r.attachmentUpdated || 0) + ((stages.procurement && stages.procurement.attachmentUpdated) || 0),
          attachmentFailed:(r.attachmentFailed || 0) + ((stages.procurement && stages.procurement.attachmentFailed) || 0),
          snapshotQty:r.snapshotQty || 0,
          snapshotProductCount:r.snapshotProductCount || 0,
          snapshotRawCount:r.snapshotRawCount || 0,
          snapshotMergeRate:r.snapshotMergeRate || '0.0'
        };
        endTask(taskId, true, (procurementPartial
          ? taskName + '、安全数据同步及校验完成，异常来源待复核'
          : taskName + '、采购表同步、校验及来源清理全部完成'));
        return {ok:true, returnResult:r, procurement:stages.procurement, verification:stages.verification, cleanup:stages.cleanup,
          platform:platform,
          snapshotRawCount:r.snapshotRawCount || 0,
          snapshotProductCount:r.snapshotProductCount || 0,
          snapshotMergeRate:r.snapshotMergeRate || '0.0',
          snapshotQty:r.snapshotQty || 0,
          updated:r.updated || 0,
          created:r.created || 0,
          procurementUpdated:(stages.procurement && stages.procurement.updated) || 0,
          procurementCreated:(stages.procurement && stages.procurement.created) || 0,
          partialSafe:!!(r.partialSafe || procurementPartial)};
      });
    });
  }).catch(function(error) {
    var stage = error && error.stage ? error.stage : 'cleanup';
    var message = error && error.message ? error.message : String(error || '下午回传失败');
    _lastReturnWorkflowResult = {
      ok:false,
      stage:stage,
      platform:platform,
      updated:r.updated || 0,
      created:r.created || 0,
      pendingStaleIds:pendingStaleIds,
      snapshotRawCount:r.snapshotRawCount || 0,
      snapshotProductCount:r.snapshotProductCount || 0,
      snapshotMergeRate:r.snapshotMergeRate || '0.0',
      snapshotQty:r.snapshotQty || 0,
      error:message
    };
    L('下午回传工作流失败（' + stage + '）：' + message + '；可重跑，未执行后置清理', 'e');
    var tailMatch = platform.match(/【(\d+)】/);
    var tail = tailMatch ? tailMatch[1] : '';
    var basePlatform = platform.replace(/-【.*$/, '');
    if (error && error.skipFailureTracker) {
      endTask(taskId, false, message);
      return {ok:false, stage:stage, platform:platform, error:message};
    }
    return trackerRecordAfternoon(tail, basePlatform, 'failed', message).catch(function() {}).then(function() {
      endTask(taskId, false, message);
      return {ok:false, stage:stage, platform:platform, error:message};
    });
  });
}

function scopeProcurementVectorCandidates(candidates, platform, strictPlatform) {
  var list = candidates || [];
  if (!strictPlatform) return list.slice();
  var targetPlatform = String(platform || '').trim();
  if (!targetPlatform) return [];
  return list.filter(function(candidate) {
    var candidatePlatform = candidate && candidate.platform;
    if (candidatePlatform === undefined && candidate && candidate.rec) {
      var fields = candidate.rec.fields || {};
      candidatePlatform = fields['平台所属账号'] || fields['平台【文字】'] || fields['平台'] || '';
    }
    return procurementPlatformContains(candidatePlatform || '', targetPlatform);
  });
}

function strictSpecTitleConsistency(title, spec) {
  if (!title || !spec) return true;
  // Generic words are packaging/marketing context, not product identity.
  // They must never be the only bridge between a title and a spec line.
  var generic = /颜色|随机|款式|新款|升级|加厚|加大|特大|迷你|豪华|高端|精品|旗舰|经济|实惠|家用|车载|汽车|电动|智能|多功能|厨房|手工|缝纫|工具|神器|制作|适合|收纳|置物|材质|底盘|底座|置放|稳固|长度|宽度|高度|深度|直径|厚度|容量|承重|尺寸|规格|标准|水洗|无异味|干湿两用|贵在运费|聚划算|更划算|够用半年|不锈钢|食品级|高品质|大容量|便携|一次性|批发|热卖|爆款|包邮|超值|到手|赠|送|配|推荐|老师|红色|黄色|蓝色|绿色|黑色|白色|灰色|粉色|紫色|棕色|枪灰色|单色|双色|七彩|多彩|混色|变色|大号|中号|小号|均码|装|个|件|片|张|包|卷|套|条|只|把|块|米|厘米|cm|mm/gi;
  function clean(text) {
    return String(text || '').replace(/\d+(?:\.\d+)?/g, '').replace(generic, '')
      .replace(/[^\u4e00-\u9fff]/g, '');
  }
  var titleClean = clean(title);
  if (titleClean.length < 3) return true;
  var titleGrams = {};
  for (var i = 0; i < titleClean.length - 1; i++) {
    titleGrams[titleClean.substr(i, 2)] = 1;
    if (i < titleClean.length - 2) titleGrams[titleClean.substr(i, 3)] = 1;
  }
  var titleNoun = extractCoreProductNoun(title);
  var lines = String(spec).split('\n').filter(function(line) { return line.trim(); });
  for (var li = 0; li < lines.length; li++) {
    var lineClean = clean(lines[li]);
    if (lineClean.length < 3) continue;
    var lineNoun = extractCoreProductNoun(lines[li]);
    var familyMismatch = titleNoun && lineNoun && titleNoun !== lineNoun;
    // A title with no dictionary family still needs a textual identity
    // bridge. This catches newly listed products without maintaining an
    // ever-growing keyword dictionary.
    var shared = false;
    for (var gi = 0; gi < lineClean.length - 1; gi++) {
      if (titleGrams[lineClean.substr(gi, 2)] ||
          (gi < lineClean.length - 2 && titleGrams[lineClean.substr(gi, 3)])) {
        shared = true; break;
      }
    }
    // A foreign product noun is a hard conflict unless the same line also
    // contains a real title anchor (for example a valid gift/accessory
    // phrase such as "双拉杆+送科目贴纸").
    if (!shared && familyMismatch) return false;
    if (!shared && !titleNoun && lineNoun) return false;
    // Unclassified short attribute-only lines (material/base/size/colour)
    // are allowed; long unanchored text remains unsafe.
    if (!shared && lineClean.length >= 3) return false;
  }
  return true;
}

function titleContentOverlap(titleA, titleB) {
  if (!titleA || !titleB) return 0;
  // 通用品类词（不应作为产品匹配依据）
  var _generic = {'玩具':1,'儿童':1,'创意':1,'礼物':1,'男孩':1,'女孩':1,'宝宝':1,'婴儿':1,
    '新款':1,'升级':1,'加厚':1,'加大':1,'特大':1,'迷你':1,'豪华':1,'高端':1,'精品':1,'旗舰':1,
    '经济':1,'实惠':1,'家用':1,'车载':1,'汽车':1,'电动':1,'智能':1,'多功能':1,'不锈钢':1,
    '食品级':1,'高品质':1,'大容量':1,'便携':1,'一次性':1,'批发':1,'热卖':1,'爆款':1,'包邮':1,
    '超值':1,'到手':1,'颜色':1,'随机':1,'款式':1,'套装':1,'组合':1,'网红':1,'节日':1,
    '炫酷':1,'可爱':1,'好看':1,'实用':1,'好用':1,'新款':1,'早教':1,'益智':1,'启蒙':1,
    '声光':1,'动手':1,'训练':1,'互动':1,'亲子':1,'宝宝':1,'男孩':1,'女孩':1,'幼儿':1,
    '仿真':1,'模拟':1,'驾驶':1,'副驾驶':1};

  function _words(t) {
    var matches = t.match(/[\u4e00-\u9fff]{2,8}/g) || [];
    var set = {};
    for (var i = 0; i < matches.length; i++) {
      var w = matches[i];
      for (var len = Math.min(6, w.length); len >= 3; len--) {
        for (var s = 0; s <= w.length - len; s++) {
          var sub = w.substr(s, len);
          if (!_generic[sub]) set[sub] = 1;
        }
      }
    }
    return Object.keys(set);
  }
  var wordsA = _words(titleA);
  var wordsB = _words(titleB);
  if (!wordsA.length || !wordsB.length) return 0;
  var overlap = 0;
  for (var i = 0; i < wordsA.length; i++) {
    for (var j = 0; j < wordsB.length; j++) {
      if (wordsA[i] === wordsB[j] || wordsA[i].indexOf(wordsB[j]) >= 0 || wordsB[j].indexOf(wordsA[i]) >= 0) {
        overlap++;
        break;
      }
    }
  }
  return overlap / Math.max(wordsA.length, wordsB.length);
}

// ====== V21.0.0 采购表指纹重建（推翻向量合并） ======
// 按 SKU指纹确定性分组，数量求和，平台去重，全量重建当日采购表
function v21RebuildProcurementByFingerprint(options) {
  options = options || {};
  var printedOnly = !!options.printedOnly;
  var dryRun = !!options.dryRun;
  L('=== V21 指纹重建采购表' + (printedOnly ? '(仅已打单)' : '') + (dryRun ? ' [比对模式]' : '') + ' ===', 'i');
  return fetchAllRecordsForReturn(printedOnly ? true : false).then(function(sourceRecords) {
    var todayStart = new Date(); todayStart.setHours(0,0,0,0);
    var todayMs = todayStart.getTime(), tomorrowMs = todayMs + 86400000;
    var todaySource = sourceRecords.filter(function(rec){
      var f=rec.fields||{}; var v=f['🏗 【创建/绑定】日期']||f['创建时间引导']||f['创建时间']||f['📅 抓取日期']; var ts=typeof v==='number'?v:0;
      if(ts===0&&typeof v==='string'){ var p=Date.parse(v); if(!isNaN(p)) ts=p; }
      return ts>=todayMs && ts<tomorrowMs;
    });
    if (printedOnly) {
      todaySource = todaySource.filter(function(rec){
        var s = String((rec.fields||{})['手动传输状态']||(rec.fields||{})['状态']||'');
        return s==='已打单';
      });
    }
    L('V21 指纹重建: 中转站今日 ' + todaySource.length + ' 条', 'i');
    if (!todaySource.length) { L('无今日数据，重建结束', 'w'); return {ok:true, groups:0}; }
    // 按指纹分组（确定性，不走向量）
    var groups = {};
    todaySource.forEach(function(rec){
      var f=rec.fields||{};
      var title=String(f['📡 商品全称']||f['商品全称']||'');
      var spec=String(f['🚧 ❗【时段】产品需求值']||f['产品需求值']||'');
      var fp = v21BuildFingerprint(title, spec);
      var pid = String(f['🔗 商品ID']||'');
      var key = fp; // V21.0.1: 纯指纹合并，PID仅收集不作key（已验证1697→1697零合并的根因）
      if (!groups[key]) groups[key] = {title:title, pids:{}, specs:[], plats:{}, qty:0, recs:[], fp:fp};
      groups[key].recs.push(rec);
      if (pid) groups[key].pids[pid]=1;
      if (spec) groups[key].specs.push(spec);
      var plat = String(f['平台所属账号']||'');
      if (plat) groups[key].plats[plat]=1;
      // 优先用数字列，否则解析文本
      var q = v21ParseQtyNumber(spec);
      groups[key].qty += q || 1;
    });
    var groupList = Object.keys(groups).map(function(k){ return {key:k, g:groups[k]}; });
    L('V21 分组完成: ' + groupList.length + ' 组（' + todaySource.length + '→' + groupList.length + '）', 'ok');
    // 读取采购表今日数据，准备重建
    return getFieldMap().then(function(fm){
      return new Promise(function(resolve){
        chrome.storage.local.get(['procAppToken','procTableId'], function(cfg){
          var PAT=cfg.procAppToken||'DptPbPEluaupDjsp2XZcFK56nte'; if(PAT==='DptPbPEluaupDjsp2XZcFK56nte'||PAT==='DptPbPEluaupDjsp2XZcFK56nte') PAT='DptPbPEluaupDjsp2XZcFK56nte';
          var PTT=cfg.procTableId||'tblMXn13Mpkvf1ql'; if(PTT==='tblMXn13Mpkvf1ql'||PTT==='tbl2Og3goEYBN0PQ') PTT='tblMXn13Mpkvf1ql';
          resolve({PAT:PAT, PTT:PTT, fm:fm});
        });
      });
    }).then(function(ctx){
      var _PAT=ctx.PAT, _PTT=ctx.PTT, fm=ctx.fm; if(_PAT==='DptPbPEluaupDjsp2XZcFK56nte'||_PAT==='DptPbPEluaupDjsp2XZcFK56nte') _PAT='DptPbPEluaupDjsp2XZcFK56nte'; if(_PTT==='tblMXn13Mpkvf1ql'||_PTT==='tbl2Og3goEYBN0PQ') _PTT='tblMXn13Mpkvf1ql';
      var P_TITLE=v21ResolveField(fm, ['📡 商品全称','商品全称'])||'📡 商品全称';
      var P_PID=v21ResolveField(fm, ['🔗 商品ID','商品ID'])||'🔗 商品ID';
      var P_SPEC=v21ResolveField(fm, ['🚧 ❗【时段】产品需求值','产品需求值'])||'🚧 ❗【时段】产品需求值';
      var P_PLAT=v21ResolveField(fm, ['平台所属账号','平台【文字】'])||'平台所属账号';
      var P_DATE=v21ResolveField(fm, ['🏗 【创建/绑定】日期','创建时间'])||'🏗 【创建/绑定】日期';
      var P_STATUS=v21ResolveField(fm, ['手动传输状态','状态'])||'手动传输状态';
      var P_QTY=v21ResolveField(fm, V21_ZONE_FIELDS.qtyNum);
      var P_FP=v21ResolveField(fm, V21_ZONE_FIELDS.fingerprint);
      var P_TAIL=v21ResolveField(fm, V21_ZONE_FIELDS.tail);
      var P_BASE=v21ResolveField(fm, V21_ZONE_FIELDS.base);
      var P_ZONE=v21ResolveField(fm, V21_ZONE_FIELDS.zone);
      return getToken().then(function(token){
        // 读采购表今日
        var allProc=[], pt='';
        var todayFilter='CurrentValue.['+P_DATE+'] >= TODAY()&&CurrentValue.['+P_DATE+'] < TODAY()+1';
        function fetchProcPage(){
          var q='?page_size=500&filter='+encodeURIComponent(todayFilter)+(pt?'&page_token='+pt:'');
          return feishuWithRetry('https://open.feishu.cn/open-apis/bitable/v1/apps/'+_PAT+'/tables/'+_PTT+'/records'+q,'GET',{'Authorization':'Bearer '+token}).then(function(d){
            if(d.code!==0) throw new Error('读采购表失败 '+d.code);
            allProc=allProc.concat(d.data.items||[]);
            if(d.data.has_more&&d.data.page_token){ pt=d.data.page_token; return fetchProcPage(); }
            return allProc;
          });
        }
        return fetchProcPage().then(function(procRows){
          // 按指纹建索引
          var procByFp={};
          procRows.forEach(function(r){
            var f=r.fields||{};
            var t=String(f[P_TITLE]||''); var s=String(f[P_SPEC]||'');
            var fp=v21BuildFingerprint(t,s);
            var key=fp;
            if(!procByFp[key]) procByFp[key]=[];
            procByFp[key].push(r);
          });
          // 保护：有人工字段的行不删
          var purchaserFields=(function(){ try{ return purchaserManualFields||[];}catch(e){return [];}})();
          var toUpdate=[], toCreate=[], toDelete=[];
          var protectedIds={};
          procRows.forEach(function(r){
            var f=r.fields||{}; var hasManual=false;
            for(var i=0;i<purchaserFields.length;i++){ var v=f[purchaserFields[i]]; if(v!==undefined&&v!==null&&String(v).trim()!==''){ hasManual=true; break; }}
            if(hasManual) protectedIds[r.record_id]=1;
          });
          groupList.forEach(function(item){
            var key=item.key, g=item.g;
            var existingArr=procByFp[key]||[];
            var existing=existingArr[0]||null;
            if(existing && existingArr.length>1){
              // 多行重复，同指纹多行，保留一行，其余删（未保护的）
              for(var i=1;i<existingArr.length;i++){ if(!protectedIds[existingArr[i].record_id]) toDelete.push(existingArr[i].record_id); }
            }
            // 合并规格和平台
            var mergedSpec=g.specs.join('\n');
            var plats=Object.keys(g.plats).join('\n');
            var title=g.title;
            var fields={};
            fields[P_TITLE]=title;
            fields[P_PID]=Object.keys(g.pids).join('\n');
            fields[P_SPEC]=mergedSpec;
            fields[P_PLAT]=plats;
            fields[P_DATE]=Date.now();
            fields[P_STATUS]='未打单';
            if(P_QTY) fields[P_QTY]=g.qty;
            if(P_FP) fields[P_FP]=key;
            if(P_TAIL||P_BASE||P_ZONE){
              var firstPlat=Object.keys(g.plats)[0]||'';
              var parts=v21SplitPlatformZone(firstPlat);
              if(P_TAIL&&parts.tail) fields[P_TAIL]=parts.tail;
              if(P_BASE&&parts.base) fields[P_BASE]=parts.base;
              if(P_ZONE) fields[P_ZONE]=parts.zone;
            }
            if(existing) toUpdate.push({record_id:existing.record_id, fields:fields});
            else toCreate.push({fields:fields});
          });
          // 采购表中存在但中转站分组里没有的，标为待删（仅无人工字段的）
          var groupKeys={}; groupList.forEach(function(it){ groupKeys[it.key]=1; });
          procRows.forEach(function(r){
            var f=r.fields||{}; var t=String(f[P_TITLE]||''); var s=String(f[P_SPEC]||'');
            var fp=v21BuildFingerprint(t,s); var key=fp;
            if(!groupKeys[key] && !protectedIds[r.record_id]) toDelete.push(r.record_id);
          });
          // 去重
          toDelete=[...new Set(toDelete)];
          L('V21 重建计划: 更新 '+toUpdate.length+' 新增 '+toCreate.length+' 删除 '+toDelete.length+' 保护 '+Object.keys(protectedIds).length, 'i');
          if (dryRun) { L('V21 比对模式：不写入，仅返回计划', 'i'); return {ok:true, dryRun:true, groups:groupList.length, updated:toUpdate.length, created:toCreate.length, deleted:toDelete.length, protected:Object.keys(protectedIds).length}; }
          // 执行
          var chain=Promise.resolve();
          for(var ui=0;ui<toUpdate.length;ui+=100){ (function(batch){ chain=chain.then(function(){ return getToken().then(function(tk){ return feishuWithRetry('https://open.feishu.cn/open-apis/bitable/v1/apps/'+_PAT+'/tables/'+_PTT+'/records/batch_update','POST',{'Authorization':'Bearer '+tk,'Content-Type':'application/json'}, JSON.stringify({records:batch})); }).then(function(d){ if(d.code!==0) throw new Error('V21 更新失败 '+d.code); }); }); })(toUpdate.slice(ui,ui+100)); }
          for(var ci=0;ci<toCreate.length;ci+=100){ (function(batch){ chain=chain.then(function(){ return getToken().then(function(tk){ return feishuWithRetry('https://open.feishu.cn/open-apis/bitable/v1/apps/'+_PAT+'/tables/'+_PTT+'/records/batch_create','POST',{'Authorization':'Bearer '+tk,'Content-Type':'application/json'}, JSON.stringify({records:batch})); }).then(function(d){ if(d.code!==0) throw new Error('V21 新建失败 '+d.code); }); }); })(toCreate.slice(ci,ci+100)); }
          for(var di=0;di<toDelete.length;di+=100){ (function(batch){ chain=chain.then(function(){ return getToken().then(function(tk){ return feishuWithRetry('https://open.feishu.cn/open-apis/bitable/v1/apps/'+_PAT+'/tables/'+_PTT+'/records/batch_delete','POST',{'Authorization':'Bearer '+tk,'Content-Type':'application/json'}, JSON.stringify({records:batch})); }).then(function(d){ if(d.code!==0) throw new Error('V21 删除失败 '+d.code); }); }); })(toDelete.slice(di,di+100)); }
          return chain.then(function(){ L('V21 指纹重建完成 ✓', 'ok'); try{
            var _zones={}, _plats={}; todaySource.forEach(function(r){ var pp=v21SplitPlatformZone(String((r.fields||{})['平台所属账号']||'')); var z=pp.zone||'无区'; _zones[z]=(_zones[z]||0)+1; var p=String((r.fields||{})['平台所属账号']||''); if(p) _plats[p]=(_plats[p]||0)+1; });
            updateV21Health({transfer:todaySource.length, groups:groupList.length, updated:toUpdate.length, created:toCreate.length, deleted:toDelete.length, protected:Object.keys(protectedIds).length, zones:_zones, plats:_plats});
          }catch(e){} return {ok:true, groups:groupList.length, updated:toUpdate.length, created:toCreate.length, deleted:toDelete.length}; });
        });
      });
    });
  });
}
// V21.0.7 历史回填 + 列自检
function v21CheckColumns(){
  return getFieldMap().then(function(fm){
    var missing=[]; ['店管家尾号','平台基名','分区','需求数量_数字','SKU指纹'].forEach(function(n){
      if(!v21ResolveField(fm, [n])) missing.push(n);
    });
    return {ok:missing.length===0, missing:missing, has:5-missing.length};
  });
}
function v21BackfillExisting(opts){
  opts=opts||{}; var dry=!!opts.dryRun;
  return getFieldMap().then(function(fm){
    var P_TITLE=v21ResolveField(fm, ['📡 商品全称'])||'📡 商品全称';
    var P_SPEC=v21ResolveField(fm, ['🚧 ❗【时段】产品需求值'])||'🚧 ❗【时段】产品需求值';
    var P_PLAT=v21ResolveField(fm, ['平台【文字】'])||'平台【文字】';
    return fetchAllRecordsFromTable(AT, TT).then(function(all){
      var need=[]; all.forEach(function(rec){
        var f=rec.fields||{}; var plat=String(f[P_PLAT]||'');
        var fpF=v21ResolveField(fm, V21_ZONE_FIELDS.fingerprint);
        if(!f[fpF] && plat) need.push(rec);
      });
      if(dry) return {dryRun:true, total:all.length, need:need.length};
      var batches=[]; for(var i=0;i<need.length;i+=100) batches.push(need.slice(i,i+100));
      var chain=Promise.resolve(); batches.forEach(function(batch){
        chain=chain.then(function(){ return getToken().then(function(tk){
          var records=batch.map(function(rec){
            var f=rec.fields||{}; var t=String(f[P_TITLE]||''); var s=String(f[P_SPEC]||''); var p=String(f[P_PLAT]||'');
            var parts=v21SplitPlatformZone(p); var fields={};
            var tf=v21ResolveField(fm, V21_ZONE_FIELDS.tail); if(tf&&parts.tail) fields[tf]=parts.tail;
            var bf=v21ResolveField(fm, V21_ZONE_FIELDS.base); if(bf&&parts.base) fields[bf]=parts.base;
            var zf=v21ResolveField(fm, V21_ZONE_FIELDS.zone); if(zf) fields[zf]=parts.zone;
            var qf=v21ResolveField(fm, V21_ZONE_FIELDS.qtyNum); if(qf) { var q=v21ParseQtyNumber(s); if(q) fields[qf]=q; }
            var ff=v21ResolveField(fm, V21_ZONE_FIELDS.fingerprint); if(ff) fields[ff]=v21BuildFingerprint(t,s);
            return {record_id:rec.record_id, fields:fields};
          });
          return feishuWithRetry('https://open.feishu.cn/open-apis/bitable/v1/apps/'+AT+'/tables/'+TT+'/records/batch_update','POST',{'Authorization':'Bearer '+tk,'Content-Type':'application/json'}, JSON.stringify({records:records}));
        });});
      });
      return chain.then(function(){ return {ok:true, total:all.length, filled:need.length}; });
    });
  });
}
// V21.0.5 健康看板：常驻 13平台/分区 诊断 + V21.0.8 诊断导出
var _lastV21Health=null;
function updateV21Health(info){ _lastV21Health=info;
  try{
    var el=document.getElementById('v21HealthBody'); var tm=document.getElementById('v21HealthTime');
    if(!el) return; var now=new Date().toLocaleTimeString();
    if(tm) tm.textContent=now;
    var txt='';
    if(info.transfer!==undefined) txt+='中转 '+info.transfer+' → 采购 '+info.groups+'组';
    if(info.updated!==undefined) txt+=' ｜ 更新'+info.updated+' 新增'+info.created+' 删除'+info.deleted+(info.protected!==undefined?' 保护'+info.protected:'');
    if(info.zones) txt+='<br>分区 一区'+(info.zones['一区']||0)+' 二区'+(info.zones['二区']||0)+' 无区'+(info.zones['无区']||0);
    if(info.plats) txt+='<br><span style="font-size:10px;color:#94a3b8">'+Object.keys(info.plats).slice(0,6).join(' · ')+(Object.keys(info.plats).length>6?' … +'+(Object.keys(info.plats).length-6):'')+'</span>';
    txt+='<br><span style="color:#64748b">判区已收敛为三列确定式（tail/base/zone），8策略仅作探查，落库以 v21SplitPlatformZone 为准</span>';
    txt+=' <a href="#" onclick="v21ExportDiagnostics();return false;" style="color:#7c5cfc;text-decoration:none;font-size:10px;margin-left:6px">导出诊断</a>';
    el.innerHTML=txt;
  }catch(e){}
}
function v21ExportDiagnostics(){
  try{
    var data={time:new Date().toISOString(), version:'21.0.12', note:'13平台/分区/指纹 诊断', lastHealth:_lastV21Health};
    var blob=new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
    var url=URL.createObjectURL(blob); var a=document.createElement('a'); a.href=url; a.download='v21-diagnostics-'+Date.now()+'.json'; a.click(); URL.revokeObjectURL(url);
    L('诊断已导出', 'ok');
  }catch(e){ L('导出失败:'+e.message,'e'); }
}

