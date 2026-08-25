// dgj-simple v20.7.3 — Background Service Worker
// Attachment pipeline: persistent token cache + bounded concurrency + abortable retry.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.runtime.onInstalled.addListener(function(details) {
  if (details.reason === 'install' || details.reason === 'update') {
    console.log('[DGJ] v20.7.2 ' + details.reason);
    chrome.storage.local.get(['dgjAutomationConfigV1'], function(existing) {
      var existingConfig = existing.dgjAutomationConfigV1 || {};
      var config;
      if (details.reason === 'install') {
        // 全新安装：使用默认配置
        config = {
          morningEnabled:false,
          morningTime:'08:10',
          commandPollingEnabled:false,
          queueTableId:'tblLpoliA366EPmS',
          webhookUrl:'',
          notifyMorning:true,
          notifyAfternoon:true
        };
        console.log('[DGJ] 全新安装，使用默认配置');
      } else {
        // 更新：保留用户配置，只添加缺失字段
        config = Object.assign({
          morningEnabled:false,
          morningTime:'08:10',
          commandPollingEnabled:false,
          queueTableId:'tblLpoliA366EPmS',
          webhookUrl:'',
          notifyMorning:true,
          notifyAfternoon:true
        }, existingConfig);
        console.log('[DGJ] 插件更新，保留用户配置:', JSON.stringify(config, null, 2));
      }
      chrome.storage.local.set({
        alarmHour:8,
        alarmMinute:10,
        alarmEnabled:true,
        alarmTabs:[],
        dgjAutomationConfigV1:config
      }, function() {
        scheduleAutomationAlarms(config);
      });
    });
  }
});

function ensureDailyConsoleAlarm() {
  chrome.alarms.get('dgj-automation-daily-console', function(existing) {
    if (existing) return;
    var next = new Date();
    next.setHours(0, 5, 0, 0);
    if (next <= new Date()) next.setDate(next.getDate() + 1);
    chrome.alarms.create('dgj-automation-daily-console', {
      when:next.getTime(),
      periodInMinutes:24 * 60
    });
  });
}
function scheduleAutomationAlarms(automationConfig, done) {
  automationConfig = automationConfig || {};
  chrome.alarms.clear('autoScrape', function() {
    chrome.alarms.clear('dgj-automation-morning', function() {
      if (automationConfig.morningEnabled) {
        var parts = String(automationConfig.morningTime || '08:10').split(':');
        var nowAuto = new Date();
        var nextAuto = new Date();
        nextAuto.setHours(Number(parts[0]) || 8, Number(parts[1]) || 10, 0, 0);
        if (nextAuto <= nowAuto) nextAuto.setDate(nextAuto.getDate() + 1);
        chrome.alarms.create('dgj-automation-morning', {
          when:nextAuto.getTime(),
          periodInMinutes:24 * 60
        });
      }
      chrome.alarms.clear('dgj-automation-poll', function() {
        if (automationConfig.commandPollingEnabled) {
          chrome.alarms.create('dgj-automation-poll', {
            delayInMinutes:1,
            periodInMinutes:1
          });
        }
        ensureDailyConsoleAlarm();
        if (done) done();
      });
    });
  });
}
ensureDailyConsoleAlarm();
chrome.runtime.onStartup.addListener(ensureDailyConsoleAlarm);

// ====== KEEP-ALIVE ======
var _keepAliveInterval = null;
var _automationLease = null;
var _automationLeaseOperation = Promise.resolve();
var AUTOMATION_LEASE_KEY = 'dgjAutomationLeaseV1';
function startKeepAlive() {
  if (_keepAliveInterval) return;
  _keepAliveInterval = setInterval(function() {
    chrome.runtime.getPlatformInfo(function(){});
  }, 25000);
}
function stopKeepAlive() {
  if (_keepAliveInterval) { clearInterval(_keepAliveInterval); _keepAliveInterval = null; }
}

// Alarm handler
chrome.alarms.onAlarm.addListener(function(alarm) {
  if (alarm.name === 'autoScrape') {
    console.log('[DGJ] Auto-scrape alarm fired at ' + new Date().toLocaleTimeString());
    chrome.storage.local.get(['alarmEnabled', 'alarmTabs'], function(data) {
      if (!data.alarmEnabled) { console.log('[DGJ] Alarm disabled, skipping'); return; }
      launchAlarmScheduler(data.alarmTabs || []);
    });
    return;
  }
  if (alarm.name === 'dgj-automation-morning') {
    launchAutomationPanel({type:'automationMorningFired'}, true);
    return;
  }
  if (alarm.name === 'dgj-automation-poll') {
    launchAutomationPanel({type:'automationPoll'}, false);
    return;
  }
  if (alarm.name === 'dgj-automation-daily-console') {
    launchAutomationPanel({type:'automationBootstrap'}, false);
  }
});

function launchAutomationPanel(message, requireDgjTabs) {
  function openPanel() {
    var schedulerUrl = chrome.runtime.getURL('panel.html') + '?automation=1';
    chrome.tabs.query({url:chrome.runtime.getURL('panel.html') + '*'}, function(panelTabs) {
      function trigger() {
        setTimeout(function() {
          chrome.runtime.sendMessage(message, function(response) {
            if (chrome.runtime.lastError) {
              console.log('[DGJ-AUTO] message delivery failed: ' + chrome.runtime.lastError.message);
            } else {
              console.log('[DGJ-AUTO] ' + message.type + ': ' + JSON.stringify(response || {}));
            }
          });
        }, 1200);
      }
      if (panelTabs && panelTabs.length) {
        // Never reload the durable worker page while a long-running scrape or
        // return is active. The existing automation context receives the event.
        trigger();
        return;
      }
      chrome.tabs.create({url:schedulerUrl, active:false}, trigger);
    });
  }
  if (!requireDgjTabs) {
    openPanel();
    return;
  }
  chrome.tabs.query({url:'*://*.dgjapp.com/*'}, function(tabs) {
    var requiredTokens = [
      'C9CED9ECE5319982EF6A25E412919330',
      '2BB62FFA68258DB18D7BCC265594E2D2',
      '27573C9283A1C5E68C9E70198634930A'
    ];
    var missing = requiredTokens.filter(function(token) {
      return !(tabs || []).some(function(tab) {
        return tab.url && tab.url.indexOf(token) >= 0;
      });
    });
    if (missing.length) {
      showAlarmNotification('上午自动化未启动：三个指定店管家账号页面没有全部打开');
      return;
    }
    openPanel();
  });
}

// An alarm is not a user gesture, so Chrome may reject sidePanel.open(). A
// normal extension page is allowed to stay alive for the complete 13-task
// sequence and uses the same tested sidepanel code.
function launchAlarmScheduler(alarmTabs) {
  chrome.tabs.query({url: '*://*.dgjapp.com/*'}, function(dgjTabs) {
    if (!dgjTabs || !dgjTabs.length) {
      console.log('[DGJ] No logged-in dgjapp tab found, alarm skipped');
      showAlarmNotification('定时任务未执行：请保持三个店管家账号登录并打开页面');
      return;
    }
    var schedulerUrl = chrome.runtime.getURL('panel.html') + '?scheduled=1';
    chrome.tabs.query({url:chrome.runtime.getURL('panel.html') + '*'}, function(panelTabs) {
      function trigger() {
        setTimeout(function() {
          chrome.runtime.sendMessage({type:'alarmFired', tabs:alarmTabs || []}, function(response) {
            if (chrome.runtime.lastError || !response || response.ok === false) {
              console.log('[DGJ] Alarm scheduler start failed');
              showAlarmNotification('定时批量启动失败，请打开插件查看运行日志');
            }
          });
        }, 1200);
      }
      if (panelTabs && panelTabs.length) {
        chrome.tabs.reload(panelTabs[0].id, {}, trigger);
        return;
      }
      chrome.tabs.create({url:schedulerUrl, active:false}, trigger);
    });
  });
}

// Direct scrape execution from background (fallback when sidepanel is closed)
function executeAlarmScrape(tabId, alarmTabs) {
  // v19.76.0: Actually run the scraper from background, not just detect platform
  console.log('[DGJ] v19.92.0: Executing full scrape from background for tab ' + tabId);

  // First try to open sidepanel and let it handle the scrape
  chrome.tabs.update(tabId, {active: true}, function() {
    try {
      if (chrome.sidePanel && chrome.sidePanel.open) {
        chrome.sidePanel.open({tabId: tabId}).then(function() {
          console.log('[DGJ] Sidepanel opened, sending alarmFired');
          setTimeout(function() {
            chrome.runtime.sendMessage({ type: 'alarmFired', tabs: alarmTabs || [] });
          }, 2000);
        }).catch(function(e) {
          console.log('[DGJ] sidePanel.open failed: ' + e.message);
          runBackgroundScrape(tabId, alarmTabs);
        });
      } else {
        runBackgroundScrape(tabId, alarmTabs);
      }
    } catch(e) {
      console.log('[DGJ] Sidepanel open error: ' + e.message);
      runBackgroundScrape(tabId);
    }
  });
}

function runBackgroundScrape(tabId, alarmTabs) {
  // v19.76.0: Full scraper execution from background
  console.log('[DGJ] Running full scraper from background for tab ' + tabId);
  chrome.scripting.executeScript({
    target: {tabId: tabId, allFrames: true},
    func: function() {
      // Detect platform
      var platformStr = '';
      var selects = document.querySelectorAll('select');
      for (var si = 0; si < selects.length; si++) {
        var opts = selects[si].querySelectorAll('option');
        for (var oi = 0; oi < opts.length; oi++) {
          if (opts[oi].selected) {
            var t = opts[oi].textContent.trim();
            if (['拼多多','京东','抖音','抖店','淘宝','快手','快手小店','微信小店','视频号'].indexOf(t) >= 0) { platformStr = t; break; }
          }
        }
        if (platformStr) break;
      }
      return {platform: platformStr, url: location.href, title: document.title, hasTable: !!document.querySelector('table')};
    }
  }).then(function(results) {
    var info = (results && results[0] && results[0].result) || {};
    console.log('[DGJ] Background scrape detect:', JSON.stringify(info));

    if (!info.hasTable) {
      console.log('[DGJ] No table found, showing notification');
      showAlarmNotification('未检测到备货单表格，请打开店管家页面');
      return;
    }

    // Show notification that scrape is running
    showAlarmNotification('定时抓取已触发，正在执行: ' + (info.platform || '未知平台'));

    // Send alarmFired to sidepanel (if open, it will handle the full scrape+upload)
    chrome.runtime.sendMessage({ type: 'alarmFired', tabs: alarmTabs || [] });
  }).catch(function(e) {
    console.log('[DGJ] Background scrape error: ' + e.message);
    showAlarmNotification('定时任务触发异常: ' + e.message);
  });
}

function showAlarmNotification(message) {
  try {
    chrome.notifications.create('dgj-alarm-' + Date.now(), {
      type: 'basic', iconUrl: 'icons/btb-128.png',
      title: '店管家备货单抓取 - 定时任务', message: message,
      priority: 2
    });
  } catch(ne) { console.log('[DGJ] Notification failed: ' + ne.message); }
}

// ====== ATTACHMENT PIPELINE v19.97.0 ======
var IMAGE_CACHE_KEY = 'dgjImageTokenCacheV1';
var IMAGE_FAILURE_KEY = 'dgjLastImageFailures';
var IMAGE_CACHE_LIMIT = 3500;
var _imagePipelineTail = Promise.resolve();

function imageWait(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function imageJitter(attempt, base, cap) {
  var ceiling = Math.min(cap || 8000, (base || 500) * Math.pow(2, attempt));
  return Math.round(ceiling * (.65 + Math.random() * .7));
}

function imageStorageGet(keys) {
  return new Promise(function(resolve) {
    chrome.storage.local.get(keys, function(data) { resolve(data || {}); });
  });
}

function imageStorageSet(data) {
  return new Promise(function(resolve) {
    chrome.storage.local.set(data, function() { resolve(); });
  });
}

function normalizeImageUrl(raw) {
  var value = String(raw || '').trim().replace(/&amp;/g, '&');
  if (!value || !/^https?:\/\//i.test(value)) return '';
  try {
    var parsed = new URL(value);
    parsed.hash = '';
    [
      '_', 't', 'time', 'timestamp', 'ts', 'Expires', 'OSSAccessKeyId', 'Signature',
      'x-oss-signature', 'x-oss-expires', 'x-oss-credential', 'x-oss-date',
      'x-oss-security-token', 'x-cos-signature', 'x-cos-security-token'
    ].forEach(function(name) { parsed.searchParams.delete(name); });
    parsed.hostname = parsed.hostname.toLowerCase();
    return parsed.href;
  } catch(e) {
    return value;
  }
}

// mmecimage.cn serves multi-megabyte originals unreliably under parallel load.
// Its native thumbnail command keeps product images readable for procurement
// while cutting the typical payload from ~2.5 MB to ~0.4 MB.
function optimizeImageDeliveryUrl(raw) {
  var value = String(raw || '').trim().replace(/&amp;/g, '&');
  if (!value || !/^https?:\/\//i.test(value)) return {url:value, optimized:false};
  try {
    var parsed = new URL(value);
    if (/(^|\.)mmecimage\.cn$/i.test(parsed.hostname)) {
      var base = parsed.origin + parsed.pathname;
      return {url:base + '?imageMogr2/thumbnail/600x600', optimized:true};
    }
  } catch(e) {}
  return {url:value, optimized:false};
}

function isGoodImageBlob(blob) {
  if (!blob || blob.size < 200) return false;
  var type = String(blob.type || '').toLowerCase();
  return !type || type.indexOf('image/') === 0 || type === 'application/octet-stream';
}

function dataUrlToBlob(dataUrl) {
  try {
    var parts = String(dataUrl || '').split(',');
    if (parts.length < 2) return null;
    var mimeMatch = parts[0].match(/:(.*?);/);
    var raw = atob(parts[1]);
    var bytes = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return new Blob([bytes], {type:mimeMatch ? mimeMatch[1] : 'image/jpeg'});
  } catch(e) {
    return null;
  }
}

function resolveDgjImageTab(preferredTabId) {
  return new Promise(function(resolve) {
    chrome.tabs.query({url:'*://*.dgjapp.com/*'}, function(tabs) {
      tabs = tabs || [];
      var preferred = tabs.find(function(tab) { return tab.id === preferredTabId; });
      var active = tabs.find(function(tab) { return tab.active; });
      resolve(preferred || active || tabs[0] || null);
    });
  });
}

function sendImagePipelineEvent(jobId, type, payload) {
  var msg = Object.assign({jobId:jobId, type:type}, payload || {});
  try { chrome.runtime.sendMessage(msg); } catch(e) {}
}

async function fetchImageDirectV1996(url) {
  var lastReason = 'network_error';
  var isWechatCdn = /(^|\.)mmecimage\.cn(?:[/:]|$)/i.test(String(url || '').replace(/^https?:\/\//i, ''));
  var maxAttempts = isWechatCdn ? 1 : 2;
  for (var attempt = 0; attempt < maxAttempts; attempt++) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, isWechatCdn ? 10000 : 12000);
    try {
      var response = await fetch(url, {
        redirect:'follow',
        credentials:'omit',
        cache:attempt === 0 ? 'default' : 'no-store',
        signal:controller.signal
      });
      clearTimeout(timer);
      if (response.ok) {
        var blob = await response.blob();
        if (isGoodImageBlob(blob)) return {blob:blob, via:'direct'};
        lastReason = 'invalid_image_response';
        break;
      }
      lastReason = 'http_' + response.status;
      if (response.status !== 408 && response.status !== 429 && response.status < 500) break;
    } catch(e) {
      clearTimeout(timer);
      lastReason = e && e.name === 'AbortError' ? 'direct_timeout' : 'direct_network';
    }
    if (attempt + 1 < maxAttempts) await imageWait(imageJitter(attempt, 450, 1800));
  }
  return {blob:null, reason:lastReason};
}

async function fetchImageViaPageV1996(url, tabId) {
  if (!tabId) return {blob:null, reason:'no_source_tab'};
  try {
    var results = await chrome.scripting.executeScript({
      target:{tabId:tabId},
      world:'MAIN',
      func:async function(imageUrl) {
        var controller = new AbortController();
        var timer = setTimeout(function() { controller.abort(); }, 8000);
        try {
          var response = await fetch(imageUrl, {
            mode:'cors', credentials:'omit', redirect:'follow', signal:controller.signal
          });
          if (!response.ok) return {ok:false, reason:'http_' + response.status};
          var blob = await response.blob();
          if (!blob || blob.size < 200 || (blob.type && blob.type.indexOf('image/') !== 0)) {
            return {ok:false, reason:'invalid_image_response'};
          }
          var data = await new Promise(function(resolve) {
            var reader = new FileReader();
            reader.onload = function() { resolve(reader.result); };
            reader.onerror = function() { resolve(null); };
            reader.readAsDataURL(blob);
          });
          return data ? {ok:true, data:data} : {ok:false, reason:'reader_error'};
        } catch(e) {
          return {ok:false, reason:e && e.name === 'AbortError' ? 'page_timeout' : 'page_fetch_error'};
        } finally {
          clearTimeout(timer);
        }
      },
      args:[url]
    });
    var result = results && results[0] && results[0].result;
    if (result && result.ok) {
      var blob = dataUrlToBlob(result.data);
      if (isGoodImageBlob(blob)) return {blob:blob, via:'page'};
    }
    return {blob:null, reason:(result && result.reason) || 'page_no_result'};
  } catch(e) {
    return {blob:null, reason:'page_injection_error'};
  }
}

function fetchImageViaContentV1996(url, tabId) {
  return new Promise(function(resolve) {
    if (!tabId) { resolve({blob:null, reason:'no_source_tab'}); return; }
    var settled = false;
    var timer = setTimeout(function() {
      if (!settled) {
        settled = true;
        resolve({blob:null, reason:'content_timeout'});
      }
    }, 10000);
    chrome.tabs.sendMessage(tabId, {type:'fetchImage', url:url}, function(resp) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError || !resp || !resp.ok) {
        resolve({blob:null, reason:resp && resp.error ? resp.error : 'content_no_response'});
        return;
      }
      var blob = dataUrlToBlob(resp.data);
      resolve(isGoodImageBlob(blob) ? {blob:blob, via:'content'} : {blob:null, reason:'content_invalid'});
    });
  });
}

async function fetchImageBlobV1996(url, tabId) {
  var direct = await fetchImageDirectV1996(url);
  if (direct.blob) return direct;
  var page = await fetchImageViaPageV1996(url, tabId);
  if (page.blob) return page;
  var content = await fetchImageViaContentV1996(url, tabId);
  if (content.blob) return content;
  return {
    blob:null,
    reason:[direct.reason, page.reason, content.reason].filter(Boolean).join(' > ') || 'download_failed'
  };
}

function imageExtension(blob, url) {
  var type = String(blob && blob.type || '').toLowerCase();
  if (type.indexOf('png') >= 0) return '.png';
  if (type.indexOf('webp') >= 0) return '.webp';
  if (type.indexOf('gif') >= 0) return '.gif';
  if (type.indexOf('avif') >= 0) return '.avif';
  var clean = String(url || '').split('?')[0].toLowerCase();
  var match = clean.match(/\.(png|webp|gif|avif|jpe?g)$/);
  return match ? '.' + match[1].replace('jpeg', 'jpg') : '.jpg';
}

async function uploadImageToFeishuV1996(blob, filename, token, appToken) {
  var lastReason = 'upload_failed';
  for (var attempt = 0; attempt < 3; attempt++) {
    var controller = new AbortController();
    var timer = setTimeout(function() { controller.abort(); }, 30000);
    var form = new FormData();
    form.append('file', blob, filename);
    form.append('file_name', filename);
    form.append('parent_type', 'bitable_file');
    form.append('parent_node', appToken);
    form.append('size', String(blob.size));
    try {
      var response = await fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
        method:'POST',
        headers:{'Authorization':'Bearer ' + token},
        body:form,
        signal:controller.signal
      });
      clearTimeout(timer);
      var body = await response.json().catch(function() { return {}; });
      if (response.ok && body.code === 0 && body.data && body.data.file_token) {
        return {fileToken:body.data.file_token};
      }
      lastReason = 'feishu_' + (body.code || response.status);
      if (response.status !== 408 && response.status !== 429 && response.status < 500
          && body.code !== 99991400 && body.code !== 1061002) break;
      var retryAfter = Number(response.headers.get('Retry-After') || 0) * 1000;
      await imageWait(retryAfter || imageJitter(attempt, 800, 7000));
    } catch(e) {
      clearTimeout(timer);
      lastReason = e && e.name === 'AbortError' ? 'upload_timeout' : 'upload_network';
      if (attempt < 2) await imageWait(imageJitter(attempt, 800, 7000));
    }
  }
  return {fileToken:null, reason:lastReason};
}

function createImageSemaphore(limit) {
  var active = 0;
  var queue = [];
  function release() {
    active--;
    if (queue.length) queue.shift()();
  }
  return function(task) {
    return new Promise(function(resolve, reject) {
      function run() {
        active++;
        Promise.resolve().then(task).then(function(value) {
          release();
          resolve(value);
        }, function(error) {
          release();
          reject(error);
        });
      }
      if (active < limit) run();
      else queue.push(run);
    });
  };
}

async function runImagePool(items, concurrency, worker) {
  var cursor = 0;
  async function runner() {
    while (true) {
      var index = cursor++;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  }
  var workers = [];
  for (var i = 0; i < Math.min(concurrency, items.length); i++) workers.push(runner());
  await Promise.all(workers);
}

async function updateAttachmentRecordsV1996(rows, token, appToken, tableId, jobId) {
  var batchSize = 50;
  var updated = 0;
  var failures = [];
  for (var offset = 0; offset < rows.length; offset += batchSize) {
    var chunk = rows.slice(offset, offset + batchSize);
    var written = false;
    var lastReason = '';
    for (var attempt = 0; attempt < 5; attempt++) {
      try {
        var response = await fetch(
          'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken + '/tables/' + tableId + '/records/batch_update',
          {
            method:'POST',
            headers:{'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
            body:JSON.stringify({records:chunk.map(function(row) {
              return {record_id:row.rid, fields:{'📠 产品图':[{file_token:row.fileToken}]}};
            })})
          }
        );
        var body = await response.json().catch(function() { return {}; });
        if (response.ok && body.code === 0) {
          written = true;
          updated += chunk.length;
          break;
        }
        lastReason = 'record_' + (body.code || response.status);
        if (response.status !== 408 && response.status !== 429 && response.status < 500
            && body.code !== 99991400 && body.code !== 1061002) break;
        var retryAfter = Number(response.headers.get('Retry-After') || 0) * 1000;
        await imageWait(retryAfter || imageJitter(attempt, 650, 9000));
      } catch(e) {
        lastReason = 'record_network';
        if (attempt < 4) await imageWait(imageJitter(attempt, 650, 9000));
      }
    }
    if (!written) {
      chunk.forEach(function(row) {
        failures.push({
          rid:row.rid, url:row.url, pid:row.pid, idx:row.idx, cacheKey:row.cacheKey,
          stage:'record', reason:lastReason || 'record_failed'
        });
      });
    }
    sendImagePipelineEvent(jobId, 'uploadImagesRecordProgress', {
      done:updated,
      total:rows.length,
      failed:failures.length
    });
    if (offset + batchSize < rows.length) await imageWait(250);
  }
  return {updated:updated, failures:failures};
}

async function runImagePipelineV1996(msg) {
  var jobId = msg.jobId || ('img_' + Date.now());
  var rawItems = Array.isArray(msg.items) ? msg.items : [];
  var appToken = msg.appToken;
  var tableId = msg.tableId;
  var token = msg.token;
  startKeepAlive();
  try {
    var tab = await resolveDgjImageTab(msg.sourceTabId);
    var storage = await imageStorageGet([IMAGE_CACHE_KEY]);
    var cache = storage[IMAGE_CACHE_KEY] || {};
    var grouped = {};
    var order = [];
    var invalidFailures = [];
    var optimizedCount = 0;

    rawItems.forEach(function(item, index) {
      var url = String(item.url || '').trim().replace(/&amp;/g, '&');
      var key = normalizeImageUrl(url);
      var ref = {rid:item.rid, url:url, pid:item.pid || '', idx:item.idx === undefined ? index : item.idx};
      if (!key || !item.rid) {
        invalidFailures.push(Object.assign({stage:'extract', reason:!key ? 'invalid_or_empty_url' : 'missing_record_id'}, ref));
        return;
      }
      var delivery = optimizeImageDeliveryUrl(url);
      var cacheKey = appToken + '::' + key;
      if (!grouped[cacheKey]) {
        grouped[cacheKey] = {
          cacheKey:cacheKey, key:key, url:delivery.url, refs:[],
          optimized:delivery.optimized
        };
        if (delivery.optimized) optimizedCount++;
        order.push(cacheKey);
      }
      grouped[cacheKey].refs.push(ref);
    });

    var unique = order.map(function(key) { return grouped[key]; });
    var tokenByKey = {};
    var cacheHits = 0;
    var pending = [];
    unique.forEach(function(entry) {
      var cached = cache[entry.cacheKey];
      if (cached && cached.fileToken) {
        tokenByKey[entry.cacheKey] = cached.fileToken;
        cached.ts = Date.now();
        cacheHits++;
      } else {
        pending.push(entry);
      }
    });

    var downloadFailures = {};
    var downloaded = 0;
    var uploaded = 0;
    var processed = cacheHits;
    var withUploadSlot = createImageSemaphore(4);
    var streamBuffer = [];
    var streamWriteChain = Promise.resolve();
    var streamUpdated = 0;
    var streamWriteFailures = [];
    var cacheWriteChain = Promise.resolve();

    function entryRows(entry, fileToken) {
      return entry.refs.map(function(ref) {
        return Object.assign({fileToken:fileToken, cacheKey:entry.cacheKey}, ref);
      });
    }

    function queueWriteBatch(batch) {
      if (!batch.length) return;
      streamWriteChain = streamWriteChain.then(function() {
        return updateAttachmentRecordsV1996(batch, token, appToken, tableId, jobId);
      }).then(function(result) {
        streamUpdated += result.updated;
        streamWriteFailures = streamWriteFailures.concat(result.failures);
      });
    }

    function stageRows(rows) {
      streamBuffer.push.apply(streamBuffer, rows);
      while (streamBuffer.length >= 20) queueWriteBatch(streamBuffer.splice(0, 20));
    }

    function flushRows() {
      if (streamBuffer.length) queueWriteBatch(streamBuffer.splice(0, streamBuffer.length));
      return streamWriteChain;
    }

    function persistPartialCache(force) {
      if (!force && (uploaded === 0 || uploaded % 10 !== 0)) return;
      var partialData = {};
      partialData[IMAGE_CACHE_KEY] = Object.assign({}, cache);
      cacheWriteChain = cacheWriteChain.then(function() {
        return imageStorageSet(partialData);
      });
    }

    // Cached media tokens can be written immediately; new uploads join the
    // same 20-row streaming batches below.
    unique.forEach(function(entry) {
      var cachedToken = tokenByKey[entry.cacheKey];
      if (cachedToken) stageRows(entryRows(entry, cachedToken));
    });

    function progress() {
      sendImagePipelineEvent(jobId, 'uploadImagesProgress', {
        done:processed,
        uniqueTotal:unique.length,
        ok:Object.keys(tokenByKey).length,
        fail:Object.keys(downloadFailures).length + invalidFailures.length,
        cacheHits:cacheHits,
        downloaded:downloaded,
        uploaded:uploaded,
        optimized:optimizedCount
      });
    }
    progress();

    await runImagePool(pending, 4, async function(entry, index) {
      var fetched = await fetchImageBlobV1996(entry.url, tab && tab.id);
      if (!fetched.blob) {
        downloadFailures[entry.cacheKey] = {stage:'download', reason:fetched.reason || 'download_failed'};
        processed++;
        progress();
        return;
      }
      downloaded++;
      var upload = await withUploadSlot(function() {
        return uploadImageToFeishuV1996(
          fetched.blob,
          'dgj_' + Date.now() + '_' + index + imageExtension(fetched.blob, entry.url),
          token,
          appToken
        );
      });
      if (upload.fileToken) {
        tokenByKey[entry.cacheKey] = upload.fileToken;
        cache[entry.cacheKey] = {fileToken:upload.fileToken, ts:Date.now()};
        uploaded++;
        stageRows(entryRows(entry, upload.fileToken));
        persistPartialCache(false);
      } else {
        downloadFailures[entry.cacheKey] = {stage:'upload', reason:upload.reason || 'upload_failed'};
      }
      processed++;
      progress();
    });

    var failedRows = invalidFailures.slice();
    unique.forEach(function(entry) {
      if (!tokenByKey[entry.cacheKey]) {
        var failure = downloadFailures[entry.cacheKey] || {stage:'download', reason:'unknown'};
        entry.refs.forEach(function(ref) {
          failedRows.push(Object.assign({stage:failure.stage, reason:failure.reason}, ref));
        });
      }
    });
    await flushRows();
    persistPartialCache(true);
    await cacheWriteChain;
    failedRows = failedRows.concat(streamWriteFailures);
    // A cached token that cannot be written must not poison later retries.
    streamWriteFailures.forEach(function(item) {
      if (item.cacheKey) delete cache[item.cacheKey];
    });

    var cacheEntries = Object.keys(cache).map(function(key) {
      return {key:key, value:cache[key]};
    }).sort(function(a, b) { return (b.value.ts || 0) - (a.value.ts || 0); });
    var trimmedCache = {};
    cacheEntries.slice(0, IMAGE_CACHE_LIMIT).forEach(function(entry) { trimmedCache[entry.key] = entry.value; });
    var failurePack = {
      timestamp:Date.now(),
      tableId:tableId,
      appToken:appToken,
      items:failedRows.slice(0, 1200)
    };
    var saveData = {};
    saveData[IMAGE_CACHE_KEY] = trimmedCache;
    saveData[IMAGE_FAILURE_KEY] = failurePack;
    await imageStorageSet(saveData);

    var result = {
      success:streamUpdated,
      failed:failedRows.length,
      uploadSuccess:uploaded,
      uploadFailed:Object.keys(downloadFailures).length,
      recordFailed:streamWriteFailures.length,
      cacheHits:cacheHits,
      downloaded:downloaded,
      results:[]
    };
    sendImagePipelineEvent(jobId, 'uploadImagesComplete', result);
    return result;
  } finally {
    stopKeepAlive();
  }
}

// ====== MESSAGE HANDLER ======
chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
  // V20.10.8: Handle tkMark from content scripts
  if (msg.type === 'tkMark') {
    chrome.storage.local.get(['extractionTracker'], function(s) {
      var today = new Date();
      var dateKey = today.getFullYear() + '-' + String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
      var t = s.extractionTracker || {};
      if (t.date !== dateKey) { t = {date:dateKey, data:{}, logs:[]}; }
      var d = t.data || {};
      var key = msg.tail + ':' + msg.platform;
      d[key] = d[key] || {};
      d[key]['afternoon'] = {status: msg.status || 'done', ts: Date.now(), detail: msg.detail || '手动标记'};
      var now = new Date();
      var ts = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0') + ':' + String(now.getSeconds()).padStart(2,'0');
      (t.logs || []).push({time:ts, account:'', tail:msg.tail, platform:msg.platform, phase:'afternoon', action:'✓ 完成', detail: msg.detail || '手动标记'});
      t.data = d;
      chrome.storage.local.set({extractionTracker: t}, function() {
        sendResponse({ok: true});
      });
    });
    return true; // async response
  }


  // ---- Feishu API Proxy ----
  if (msg.type === 'feishuFetch') {
    var _timeout = setTimeout(function() {
      try { sendResponse({ ok: false, error: 'Request timeout (60s)' }); } catch(e) {}
    }, 60000);
    fetch(msg.url, {
      method: msg.method || 'GET',
      headers: msg.headers || {},
      body: msg.body || undefined
    }).then(function(r) {
      if (!r.ok) return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ': ' + t.substring(0, 200)); });
      return r.json();
    }).then(function(data) {
      clearTimeout(_timeout);
      sendResponse({ ok: true, data: data });
    }).catch(function(err) {
      clearTimeout(_timeout);
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  // ---- Upload Images Pipeline v19.97.0 ----
  if (msg.type === 'uploadImagesPipeline') {
    var queuedJobId = msg.jobId || ('img_' + Date.now());
    _imagePipelineTail = _imagePipelineTail.catch(function() {}).then(function() {
      return runImagePipelineV1996(msg);
    });
    _imagePipelineTail.then(function(result) {
      try { sendResponse({ok:true, data:result}); } catch(e) {}
    }).catch(function(error) {
      var failedCount = Array.isArray(msg.items) ? msg.items.length : 0;
      console.log('[DGJ-BG] attachment pipeline fatal:', error && error.message);
      sendImagePipelineEvent(queuedJobId, 'uploadImagesComplete', {
        success:0,
        failed:failedCount,
        uploadSuccess:0,
        uploadFailed:failedCount,
        recordFailed:0,
        cacheHits:0,
        error:error && error.message || 'pipeline_failed'
      });
      try { sendResponse({ok:false, error:error && error.message || 'pipeline_failed'}); } catch(e2) {}
    });
    return true;
  }

  // Legacy implementation retained temporarily for rollback comparison only.
  if (msg.type === 'uploadImagesPipelineLegacyDisabled') {
    // v19.79.0: Self-contained pipeline — fetch+upload+record update, no sidepanel dependency
    startKeepAlive();
    var items = msg.items || [];
    var token = msg.token;
    var AT_local = msg.appToken;
    var tableId = msg.tableId;
    var WORKERS = 15;
    var MAX_RETRIES = 3;

    console.log('[DGJ-BG] v19.79.0 uploadImagesPipeline:', items.length, 'items');
    if (!items.length) {
      stopKeepAlive();
      try { sendResponse({ ok: true, data: { success: 0, failed: 0, results: [] } }); } catch(e) {}
      return true;
    }

    // STEP 1: Dedup by URL
    var urlMap = {};
    var uniqueUrls = [];
    items.forEach(function(item) {
      var u = item.url || '';
      if (!urlMap[u]) { urlMap[u] = []; uniqueUrls.push(u); }
      urlMap[u].push({ rid: item.rid, idx: item.idx, pid: item.pid });
    });
    var urlResults = {};
    var urlFailed = {};
    var processed = 0;
    console.log('[DGJ-BG] dedup: ' + items.length + ' -> ' + uniqueUrls.length + ' unique images');

    // STEP 2: Fetch image blob — page-context via executeScript, then content script, then direct fetch
    var _dgjTabId = null;
    function findDgjTab() {
      return new Promise(function(resolve) {
        chrome.tabs.query({url: '*://*.dgjapp.com/*'}, function(tabs) {
          resolve(tabs && tabs.length ? tabs[0] : null);
        });
      });
    }

    function fetchBlob(url, attempt) {
      attempt = attempt || 0;
      return new Promise(function(resolve) {
        // Strategy 1: Execute in DGJ page context (bypasses CORS)
        fetchViaPageContext(url).then(function(blob) {
          if (blob && blob.size > 100) { console.log('[DGJ-BG] page-context OK:', url.substring(0, 50), 'size=' + blob.size); resolve(blob); return; }
          // Strategy 2: Content script message
          fetchViaContentScript(url).then(function(blob2) {
            if (blob2 && blob2.size > 100) { console.log('[DGJ-BG] content-script OK:', url.substring(0, 50)); resolve(blob2); return; }
            fetchDirect(url, attempt).then(resolve);
          }).catch(function() { fetchDirect(url, attempt).then(resolve); });
        }).catch(function(e) {
          console.log('[DGJ-BG] page-context failed:', e.message);
          fetchViaContentScript(url).then(function(blob2) {
            if (blob2 && blob2.size > 100) { resolve(blob2); return; }
            fetchDirect(url, attempt).then(resolve);
          }).catch(function() { fetchDirect(url, attempt).then(resolve); });
        });
      });
    }

    // Strategy 1: Execute fetch in the DGJ page's main world context
    function fetchViaPageContext(url) {
      return new Promise(function(resolve, reject) {
        findDgjTab().then(function(tab) {
          if (!tab) { reject(new Error('No DGJ tab found')); return; }
          _dgjTabId = tab.id;
          // Inject fetch function into page context
          chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: function(imgUrl) {
              return new Promise(function(res) {
                var timer = setTimeout(function() { res(null); }, 25000);
                fetch(imgUrl, {mode: 'cors', credentials: 'omit'}).then(function(r) {
                  clearTimeout(timer);
                  if (!r.ok) { res(null); return; }
                  return r.blob();
                }).then(function(blob) {
                  if (blob && blob.size > 100) {
                    var reader = new FileReader();
                    reader.onload = function() { res(reader.result); };
                    reader.onerror = function() { res(null); };
                    reader.readAsDataURL(blob);
                  } else { res(null); }
                }).catch(function() { clearTimeout(timer); res(null); });
              });
            },
            args: [url]
          }).then(function(results) {
            if (results && results[0] && results[0].result) {
              var dataUrl = results[0].result;
              // Convert data URL to blob
              try {
                var parts = dataUrl.split(',');
                var mime = parts[0].match(/:(.*?);/)[1];
                var b64 = parts[1];
                var raw = atob(b64);
                var arr = new Uint8Array(raw.length);
                for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
                resolve(new Blob([arr], {type: mime}));
              } catch(e) { reject(e); }
            } else { reject(new Error('No result from page context')); }
          }).catch(reject);
        });
      });
    }

    // Strategy 2: Message content script (dgj-image-fetcher.js)
    function fetchViaContentScript(url) {
      return new Promise(function(resolve, reject) {
        findDgjTab().then(function(tab) {
          if (!tab) { reject(new Error('No DGJ tab')); return; }
          var timer = setTimeout(function() { reject(new Error('CS timeout')); }, 25000);
          chrome.tabs.sendMessage(tab.id, {type: 'fetchImage', url: url}, function(resp) {
            clearTimeout(timer);
            if (chrome.runtime.lastError || !resp || !resp.ok) {
              reject(new Error(chrome.runtime.lastError ? chrome.runtime.lastError.message : (resp ? resp.error : 'No response')));
              return;
            }
            try {
              var parts = resp.data.split(',');
              var mime = parts[0].match(/:(.*?);/)[1];
              var b64 = parts[1];
              var raw = atob(b64);
              var arr = new Uint8Array(raw.length);
              for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
              resolve(new Blob([arr], {type: mime}));
            } catch(e) { reject(e); }
          });
        });
      });
    }

    // Strategy 3: Direct fetch with extension permissions
    function fetchDirect(url, attempt) {
      attempt = attempt || 0;
      return new Promise(function(resolve) {
        var timer = setTimeout(function() {
          console.log('[DGJ-BG] fetchDirect timeout:', url.substring(0, 60));
          if (attempt < MAX_RETRIES - 1) setTimeout(function() { fetchDirect(url, attempt + 1).then(resolve); }, 2000);
          else resolve(null);
        }, 30000);
        var fetchOpts = { redirect: 'follow', credentials: 'omit' };
        try {
          var urlHost = new URL(url).hostname;
          fetchOpts.headers = new Headers({ 'Referer': 'https://' + urlHost + '/' });
        } catch(e) {}
        fetch(url, fetchOpts).then(function(resp) {
          clearTimeout(timer);
          if (!resp.ok) {
            console.log('[DGJ-BG] fetchDirect HTTP ' + resp.status + ':', url.substring(0, 60));
            if ((resp.status === 403 || resp.status === 429 || resp.status >= 500) && attempt < MAX_RETRIES - 1) {
              setTimeout(function() { fetchDirect(url, attempt + 1).then(resolve); }, (attempt + 1) * 2000);
              return;
            }
            resolve(null); return;
          }
          return resp.blob();
        }).then(function(blob) {
          if (blob && blob.size > 100) resolve(blob);
          else {
            console.log('[DGJ-BG] fetchDirect bad blob:', blob ? blob.size : 'null', url.substring(0, 60));
            if (attempt < MAX_RETRIES - 1) setTimeout(function() { fetchDirect(url, attempt + 1).then(resolve); }, 1000);
            else resolve(null);
          }
        }).catch(function(e) {
          clearTimeout(timer);
          console.log('[DGJ-BG] fetchDirect error:', e.message, url.substring(0, 60));
          if (attempt < MAX_RETRIES - 1) setTimeout(function() { fetchDirect(url, attempt + 1).then(resolve); }, (attempt + 1) * 2000);
          else resolve(null);
        });
      });
    }

    // STEP 3: Upload to Feishu drive
    function uploadToFeishu(blob, filename, attempt) {
      attempt = attempt || 0;
      return new Promise(function(resolve) {
        console.log('[DGJ-BG] uploading blob:', filename, 'size=' + blob.size + ' type=' + blob.type);
        var fd = new FormData();
        fd.append('file', blob, filename);
        fd.append('file_name', filename);
        fd.append('parent_type', 'bitable_file');
        fd.append('parent_node', AT_local);
        fd.append('size', blob.size.toString());
        var timer = setTimeout(function() { resolve(null); }, 45000);
        fetch('https://open.feishu.cn/open-apis/drive/v1/medias/upload_all', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token },
          body: fd
        }).then(function(r) {
          clearTimeout(timer);
          if (!r.ok) {
            console.log('[DGJ-BG] uploadToFeishu HTTP ' + r.status + ' for ' + filename);
            return r.text().then(function(t) { console.log('[DGJ-BG] upload response:', t.substring(0, 200)); throw new Error('HTTP ' + r.status); });
          }
          return r.json();
        }).then(function(d) {
          if (d.code === 0 && d.data && d.data.file_token) {
            resolve(d.data.file_token);
          } else if ((d.code === 99991400 || d.code === 1061002) && attempt < MAX_RETRIES - 1) {
            var delay = (attempt + 1) * 3000;
            setTimeout(function() { resolve(uploadToFeishu(blob, filename, attempt + 1)); }, delay);
          } else {
            console.log('[DGJ-BG] upload error: ' + d.code + ' ' + (d.msg || ''));
            resolve(null);
          }
        }).catch(function() {
          clearTimeout(timer);
          if (attempt < MAX_RETRIES - 1) setTimeout(function() { resolve(uploadToFeishu(blob, filename, attempt + 1)); }, (attempt + 1) * 3000);
          else resolve(null);
        });
      });
    }

    // STEP 4: Record update — update records with file_tokens
    function updateRecords(results) {
      if (!results.length) return Promise.resolve(0);
      // The procurement table is large and Feishu serializes writes for the
      // same document. Smaller batches + pacing + retry prevent the tail
      // batches from being silently dropped after the main 1k+ row sync.
      var BATCH = 25;
      var MAX_WRITE_RETRIES = 5;
      var batches = [];
      for (var bi = 0; bi < results.length; bi += BATCH) batches.push(results.slice(bi, bi + BATCH));
      var updated = 0, bi = 0;
      function waitWrite(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
      }
      function writeBatch(chunk, attempt) {
        var recs = chunk.map(function(r) {
          return { record_id: r.rid, fields: { '📠 产品图': [{ file_token: r.ft }] } };
        });
        return fetch('https://open.feishu.cn/open-apis/bitable/v1/apps/' + AT_local + '/tables/' + tableId + '/records/batch_update', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ records: recs })
        }).then(function(r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        }).then(function(d) {
          if (d.code === 0) return chunk.length;
          throw new Error('Feishu ' + d.code + ' ' + (d.msg || ''));
        }).catch(function(e) {
          if (attempt < MAX_WRITE_RETRIES) {
            var delay = Math.min(12000, 1500 * Math.pow(2, attempt));
            console.log('[DGJ-BG] attachment batch retry ' + (attempt + 1)
              + '/' + MAX_WRITE_RETRIES + ' after ' + delay + 'ms: ' + e.message);
            return waitWrite(delay).then(function() { return writeBatch(chunk, attempt + 1); });
          }
          console.log('[DGJ-BG] attachment batch permanently failed: '
            + chunk.length + ' rows, ' + e.message);
          return 0;
        });
      }
      function nextBatch() {
        if (bi >= batches.length) return Promise.resolve(updated);
        var chunk = batches[bi++];
        return writeBatch(chunk, 0).then(function(count) {
          updated += count;
          try {
            chrome.runtime.sendMessage({
              type: 'uploadImagesRecordProgress',
              done: updated,
              total: results.length,
              failed: Math.max(0, (bi * BATCH > results.length ? results.length : bi * BATCH) - updated)
            });
          } catch(e) {}
          return waitWrite(800).then(nextBatch);
        });
      }
      return nextBatch();
    }

    // STEP 5: Worker — fetch+upload pipeline per URL
    var nextIdx = 0;
    function runWorker() {
      if (nextIdx >= uniqueUrls.length) return;
      var idx = nextIdx++;
      var url = uniqueUrls[idx];
      var ext = '.jpg';
      var ul = url.toLowerCase();
      if (ul.indexOf('.png') > -1) ext = '.png';
      else if (ul.indexOf('.gif') > -1) ext = '.gif';
      else if (ul.indexOf('.webp') > -1) ext = '.webp';

      fetchBlob(url).then(function(blob) {
        if (!blob) { urlFailed[url] = true; processed++; sendProgress(); console.log('[DGJ-BG] FETCH_FAILED:', url ? url.substring(0, 100) : 'empty'); checkDone(); return; }
        uploadToFeishu(blob, 'img_' + idx + ext).then(function(ft) {
          if (ft) urlResults[url] = ft; else { urlFailed[url] = true; console.log('[DGJ-BG] UPLOAD_FAILED:', url ? url.substring(0, 80) : 'empty'); }
          processed++;
          sendProgress();
          if (processed % 20 === 0 || processed === uniqueUrls.length) {
            console.log('[DGJ-BG] progress: ' + processed + '/' + uniqueUrls.length + ' ok=' + Object.keys(urlResults).length + ' fail=' + Object.keys(urlFailed).length);
          }
          checkDone();
          runWorker();
        });
      });
    }

    function sendProgress() {
      var ok = Object.keys(urlResults).length;
      var fail = Object.keys(urlFailed).length;
      try { chrome.runtime.sendMessage({ type: 'uploadImagesProgress', done: processed, total: uniqueUrls.length, ok: ok, fail: fail }); } catch(e) {}
    }

    function checkDone() {
      if (processed >= uniqueUrls.length) {
        var allResults = [];
        var allFailed = [];
        items.forEach(function(item) {
          var u = item.url || '';
          if (urlResults[u]) allResults.push({ rid: item.rid, ft: urlResults[u], idx: item.idx });
          else { allFailed.push({ rid: item.rid, idx: item.idx }); console.log('[DGJ-BG] FAILED url:', u ? u.substring(0, 80) : 'empty'); }
        });
        allResults.sort(function(a, b) { return a.idx - b.idx; });
        console.log('[DGJ-BG] DONE: ' + allResults.length + '/' + items.length + ' uploaded, failed: ' + allFailed.length);

        // v19.92.0: Record update THEN notify sidepanel via sendMessage
        updateRecords(allResults).then(function(count) {
          var recordFailed = Math.max(0, allResults.length - count);
          console.log('[DGJ-BG] Records updated: ' + count + '/' + allResults.length);
          stopKeepAlive();
          // Notify sidepanel of completion
          try {
            chrome.runtime.sendMessage({
              type: 'uploadImagesComplete',
              success: count,
              failed: allFailed.length + recordFailed,
              uploadSuccess: allResults.length,
              uploadFailed: allFailed.length,
              recordFailed: recordFailed
            });
          } catch(e) {}
          try {
            sendResponse({
              ok: true,
              data: {
                success: count,
                failed: allFailed.length + recordFailed,
                uploadSuccess: allResults.length,
                uploadFailed: allFailed.length,
                recordFailed: recordFailed,
                results: allResults
              }
            });
          } catch(e2) {}
        }).catch(function(e) {
          console.log('[DGJ-BG] Record update failed: ' + e.message);
          stopKeepAlive();
          try { chrome.runtime.sendMessage({ type: 'uploadImagesComplete', success: 0, failed: allFailed.length, error: e.message }); } catch(e) {}
          try { sendResponse({ ok: true, data: { success: 0, failed: allFailed.length, results: [], error: e.message } }); } catch(e2) {}
        });
      }
    }

    // Launch workers
    for (var w = 0; w < Math.min(WORKERS, uniqueUrls.length); w++) runWorker();
    return true;
  }

  // ---- Set Alarm ----
  if (msg.type === 'setAlarm') {
    chrome.storage.local.set({
      alarmEnabled: msg.enabled,
      alarmHour: msg.hour,
      alarmMinute: msg.minute,
      alarmTabs: msg.tabs || []
    }, function() {
      chrome.alarms.clear('autoScrape', function() {
        if (msg.enabled) {
          var now = new Date();
          var alarmTime = new Date();
          alarmTime.setHours(msg.hour, msg.minute, 0, 0);
          if (alarmTime <= now) alarmTime.setDate(alarmTime.getDate() + 1);
          chrome.alarms.create('autoScrape', { when: alarmTime.getTime(), periodInMinutes: 24 * 60 });
        }
        sendResponse({ ok: true });
      });
    });
    return true;
  }

  // ---- Get Alarm Status ----
  if (msg.type === 'getAlarmStatus') {
    chrome.storage.local.get(['alarmEnabled', 'alarmHour', 'alarmMinute'], function(data) {
      sendResponse({
        enabled: data.alarmEnabled || false,
        hour: data.alarmHour || 8,
        minute: data.alarmMinute || 30
      });
    });
    return true;
  }

  // ---- Durable automation configuration ----
  if (msg.type === 'acquireAutomationLease') {
    _automationLeaseOperation = _automationLeaseOperation.then(function() {
      return new Promise(function(resolve) {
        chrome.storage.local.get([AUTOMATION_LEASE_KEY], function(data) {
          var nowLease = Date.now();
          var persisted = data[AUTOMATION_LEASE_KEY] || null;
          _automationLease = persisted && persisted.expiresAt > nowLease ? persisted : null;
          if (_automationLease) {
            sendResponse({ok:false, busy:true, owner:_automationLease.owner || ''});
            resolve();
            return;
          }
          _automationLease = {
            token:String(msg.token || ''),
            owner:String(msg.owner || 'automation'),
            expiresAt:nowLease + 4 * 60 * 60 * 1000
          };
          var update = {};
          update[AUTOMATION_LEASE_KEY] = _automationLease;
          chrome.storage.local.set(update, function() {
            sendResponse({ok:true, token:_automationLease.token});
            resolve();
          });
        });
      });
    });
    return true;
  }
  if (msg.type === 'releaseAutomationLease') {
    _automationLeaseOperation = _automationLeaseOperation.then(function() {
      return new Promise(function(resolve) {
        chrome.storage.local.get([AUTOMATION_LEASE_KEY], function(data) {
          var persisted = data[AUTOMATION_LEASE_KEY] || _automationLease;
          if (persisted && persisted.token === String(msg.token || '')) {
            _automationLease = null;
            chrome.storage.local.remove(AUTOMATION_LEASE_KEY, function() {
              sendResponse({ok:true});
              resolve();
            });
            return;
          }
          sendResponse({ok:true});
          resolve();
        });
      });
    });
    return true;
  }

  if (msg.type === 'setAutomationConfig') {
    var automationConfig = msg.config || {};
    chrome.storage.local.set({dgjAutomationConfigV1:automationConfig}, function() {
      scheduleAutomationAlarms(automationConfig, function() {
        sendResponse({ok:true});
      });
    });
    return true;
  }

  if (msg.type === 'getAutomationStatus') {
    chrome.storage.local.get(['dgjAutomationConfigV1'], function(data) {
      chrome.alarms.get('dgj-automation-morning', function(morningAlarm) {
        chrome.alarms.get('dgj-automation-poll', function(pollAlarm) {
          sendResponse({
            ok:true,
            config:data.dgjAutomationConfigV1 || {},
            nextMorningAt:morningAlarm && morningAlarm.scheduledTime || 0,
            polling:!!pollAlarm
          });
        });
      });
    });
    return true;
  }
});
