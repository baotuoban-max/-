// dgj-simple v20.7.7 — incremental mode toggle
(function initDgjAutomationCenter() {
  'use strict';

  var AUTO_CONFIG_KEY = 'dgjAutomationConfigV1';
  var AUTO_COMPLETED_KEY = 'dgjAutomationCompletedV1';
  var AUTO_QUEUE_TABLE_NAME = '自动化任务队列';
  var AUTO_MAX_COMMAND_RETRIES = 2;
  var AUTO_CONSOLE_FIELDS = [
    {field_name:'打单已完成', type:7},
    {field_name:'仅演练不回传', type:7},
    {field_name:'执行状态', type:3, property:{options:[
      {name:'未打单'}, {name:'已打单·待回传'}, {name:'回传中'},
      {name:'已回传·同步采购中'}, {name:'已完成'}, {name:'失败·待重试'},
      {name:'重复忽略'}
    ]}},
    {field_name:'上午预估状态', type:3, property:{options:[
      {name:'待抓取'}, {name:'抓取中'}, {name:'已完成'}, {name:'失败'}
    ]}},
    {field_name:'重试请求', type:7},
    {field_name:'页面商品数', type:2},
    {field_name:'回传更新数', type:2},
    {field_name:'回传新增数', type:2},
    {field_name:'采购更新数', type:2},
    {field_name:'采购新增数', type:2},
    {field_name:'附件状态', type:3, property:{options:[
      {name:'未处理'}, {name:'已完成'}, {name:'待补图片'}
    ]}},
    {field_name:'附件失败数', type:2},
    {field_name:'操作说明', type:1}
  ];
  var DEFAULT_AUTO_CONFIG = {
    morningEnabled:false,
    morningTime:'08:10',
    commandPollingEnabled:false,
    queueTableId:'tblLpoliA366EPmS',
    webhookUrl:'',
    notifyMorning:true,
    notifyAfternoon:true
  };
  var PLATFORM_NAMES = ['拼多多','京东','淘宝','抖音','抖音一区','抖音二区','快手','快手小店','快手小店二区','微信小店','微信小店二区'];

  function autoGet(keys) {
    return new Promise(function(resolve) {
      chrome.storage.local.get(keys, resolve);
    });
  }
  function autoSet(values) {
    return new Promise(function(resolve) {
      chrome.storage.local.set(values, resolve);
    });
  }
  function autoMessage(message) {
    return new Promise(function(resolve) {
      chrome.runtime.sendMessage(message, function(response) {
        resolve(response || {ok:false, reason:'no_response'});
      });
    });
  }
  function autoLeaseToken(owner) {
    return String(owner || 'automation') + ':' + Date.now() + ':'
      + Math.random().toString(36).slice(2);
  }
  function autoWithAutomationLease(owner, work) {
    var token = autoLeaseToken(owner);
    return autoMessage({type:'acquireAutomationLease', owner:owner, token:token}).then(function(result) {
      if (!result || !result.ok) return {ok:true, skipped:'busy', owner:result && result.owner || ''};
      return Promise.resolve().then(work).finally(function() {
        return autoMessage({type:'releaseAutomationLease', token:token});
      });
    });
  }
  function autoToday() {
    return scheduleBusinessDateKey();
  }
  function autoNowText() {
    return new Date().toLocaleString('zh-CN', {hour12:false});
  }
  function autoEscapeMarkdown(value) {
    return String(value || '').replace(/[\\`*_{}[\]()#+.!|>-]/g, '\\$&');
  }
  function autoValidWebhook(value) {
    return /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/(?:v2\/)?hook\/[A-Za-z0-9_-]+$/i
      .test(String(value || '').trim());
  }
  function autoLoadConfig() {
    return autoGet([AUTO_CONFIG_KEY]).then(function(data) {
      var loaded = data[AUTO_CONFIG_KEY];
      console.log('[DGJ-CONFIG] autoLoadConfig raw:', JSON.stringify(loaded));
      var merged = Object.assign({}, DEFAULT_AUTO_CONFIG, loaded || {});
      console.log('[DGJ-CONFIG] autoLoadConfig merged:', JSON.stringify(merged));
      return merged;
    });
  }
  function autoSaveConfig(config) {
    console.log('[DGJ-CONFIG] autoSaveConfig called with:', JSON.stringify(config));
    var value = Object.assign({}, DEFAULT_AUTO_CONFIG, config || {});
    console.log('[DGJ-CONFIG] Merged config:', JSON.stringify(value));
    return autoSet((function() {
      var output = {};
      output[AUTO_CONFIG_KEY] = value;
      return output;
    })()).then(function() {
      console.log('[DGJ-CONFIG] chrome.storage.local.set OK');
      var parts = String(value.morningTime || '08:10').split(':');
      return autoMessage({
        type:'setAutomationConfig',
        config:value,
        hour:Number(parts[0]) || 8,
        minute:Number(parts[1]) || 10
      });
    }).then(function(bgResp) {
      console.log('[DGJ-CONFIG] Background setAutomationConfig response:', JSON.stringify(bgResp));
      return value;
    }).catch(function(err) {
      console.error('[DGJ-CONFIG] autoSaveConfig FAILED:', err);
      throw err;
    });
  }

  function autoNotify(title, lines, color, cardElements) {
    return autoLoadConfig().then(function(config) {
      if (!autoValidWebhook(config.webhookUrl)) return {ok:false, skipped:true};
      var content = (lines || []).map(function(line) {
        return '• ' + autoEscapeMarkdown(line);
      }).join('\n');
      var elements = cardElements && cardElements.length
        ? cardElements.slice()
        : [{tag:'div', text:{tag:'lark_md', content:content || '任务状态已更新'}}];
      elements.push(
        {tag:'hr'},
        {tag:'note', elements:[{tag:'plain_text', content:'AI 采购中枢 · ' + autoNowText()}]}
      );
      return fetch(config.webhookUrl, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          msg_type:'interactive',
          card:{
            config:{wide_screen_mode:true},
            header:{
              template:color || 'blue',
              title:{tag:'plain_text', content:title}
            },
            elements:elements
          }
        })
      }).then(function(response) {
        return response.json().catch(function() { return {}; }).then(function(body) {
          if (!response.ok || (body.code !== undefined && body.code !== 0)) {
            throw new Error('飞书群通知失败: ' + (body.msg || response.status));
          }
          return {ok:true};
        });
      });
    });
  }

  function formatAfternoonSummary(result) {
    result = result || {};
    return '页面 ' + (result.snapshotRawCount || 0) + ' 条 → '
      + (result.snapshotProductCount || 0) + ' 个商品，合并率 '
      + (result.snapshotMergeRate || '0.0') + '%，数量 ' + (result.snapshotQty || 0)
      + '；中转站更新 ' + (result.updated || 0) + '，新增 ' + (result.created || 0)
      + '；采购表更新 ' + (result.procurementUpdated || 0) + '，新增 '
      + (result.procurementCreated || 0);
  }

  function formatAfternoonCardElements(result) {
    result = result || {};
    
    // 创建多列布局的概览区域
    var overviewElements = [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "**📊 数据概览**"
        }
      },
      {
        tag: "column_set",
        flex_mode: "none",
        background_style: "grey",
        columns: [
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "top",
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: "**📄 原始数据**\n" + (result.snapshotRawCount || 0) + " 条"
                }
              }
            ]
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "top",
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: "**📦 合并商品**\n" + (result.snapshotProductCount || 0) + " 个"
                }
              }
            ]
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "top",
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: "**🔢 商品数量**\n" + (result.snapshotQty || 0)
                }
              }
            ]
          },
          {
            tag: "column",
            width: "weighted",
            weight: 1,
            vertical_align: "top",
            elements: [
              {
                tag: "div",
                text: {
                  tag: "lark_md",
                  content: "**📈 合并率**\n" + (result.snapshotMergeRate || '0.0') + "%"
                }
              }
            ]
          }
        ]
      }
    ];
    
    // 创建表格形式的写入结果
    var tableElements = [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "**📥 写入结果**"
        }
      },
      {
        tag: "table",
        columns: [
          {
            name: "target",
            display_name: "目标表",
            data_type: "text",
            width: "auto"
          },
          {
            name: "updated",
            display_name: "更新数量",
            data_type: "number",
            width: "auto"
          },
          {
            name: "created",
            display_name: "新增数量",
            data_type: "number",
            width: "auto"
          }
        ],
        rows: [
          {
            target: "中转站",
            updated: result.updated || 0,
            created: result.created || 0
          },
          {
            target: "采购表",
            updated: result.procurementUpdated || 0,
            created: result.procurementCreated || 0
          }
        ]
      }
    ];
    
    // 创建状态信息
    var statusElements = [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: "**🔍 状态信息**"
        }
      }
    ];
    
    // 根据状态添加不同的信息
    if (result.attachmentFailed) {
      statusElements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: "⚠️ **图片待补**\n仍有 " + result.attachmentFailed + " 张图片需要重试"
        }
      });
    } else if (result.partialSafe) {
      statusElements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: "⚠️ **部分完成**\n采购表同步未完整完成，暂不清理中转站来源"
        }
      });
    } else {
      statusElements.push({
        tag: "div",
        text: {
          tag: "lark_md",
          content: "✅ **数据校验通过**\n当前平台增量同步完成"
        }
      });
    }
    
    // 创建按钮区域
    var buttonElements = [
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: "📊 查看详情"
            },
            type: "primary",
            url: "https://feishu.cn/wiki/DptPbPEluaupDjsp2XZcFK56nte"
          },
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: "🔄 重新运行"
            },
            type: "default",
            url: "https://fxali.dgjapp.com/Common/Page/Purchases-Index"
          },
          {
            tag: "button",
            text: {
              tag: "plain_text",
              content: "📋 检查数据"
            },
            type: "default",
            url: "https://feishu.cn/wiki/DptPbPEluaupDjsp2XZcFK56nte"
          }
        ]
      }
    ];
    
    // 创建底部信息
    var footerElements = [
      {
        tag: "hr"
      },
      {
        tag: "note",
        elements: [
          {
            tag: "plain_text",
            content: new Date().toLocaleString('zh-CN') + " · 自动化完成"
          }
        ]
      }
    ];
    
    // 组合所有元素
    return [
      ...overviewElements,
      {tag: "hr"},
      ...tableElements,
      {tag: "hr"},
      ...statusElements,
      {tag: "hr"},
      ...buttonElements,
      ...footerElements
    ];
  }

  function notifyCompletionSafely(title, lines, color, cardElements) {
    return autoNotify(title, lines, color, cardElements).then(function(result) {
      return result && result.ok ? result : {ok:false};
    }).catch(function(error) {
      L('完成通知失败（不影响数据任务）: ' + error.message, 'w');
      return {ok:false};
    });
  }

  if (typeof window !== 'undefined') {
    window.dgjFormatAfternoonSummary = formatAfternoonSummary;
    window.dgjFormatAfternoonCardElements = formatAfternoonCardElements;
    window.dgjNotifyCompletionSafely = notifyCompletionSafely;
  }

  function autoListTables(appToken) {
    return getToken().then(function(token) {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken + '/tables?page_size=100',
        'GET', {'Authorization':'Bearer ' + token}
      );
    }).then(function(response) {
      if (response.code !== 0) throw new Error('读取自动化数据表失败: ' + response.msg);
      return response.data && response.data.items || [];
    });
  }
  function autoCreateQueueTable(appToken) {
    var fields = [
      {field_name:'任务ID', type:1},
      {field_name:'业务日期', type:1},
      {field_name:'任务类型', type:1},
      {field_name:'店管家尾号', type:1},
      {field_name:'平台', type:1},
      {field_name:'状态', type:1},
      {field_name:'通知时间', type:1},
      {field_name:'执行时间', type:1},
      {field_name:'完成时间', type:1},
      {field_name:'结果摘要', type:1},
      {field_name:'错误详情', type:1},
      {field_name:'尝试次数', type:2},
      {field_name:'来源人', type:1}
    ].concat(AUTO_CONSOLE_FIELDS);
    return getToken().then(function(token) {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken + '/tables',
        'POST',
        {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
        JSON.stringify({
          table:{
            name:AUTO_QUEUE_TABLE_NAME,
            default_view_name:'待执行任务',
            fields:fields
          }
        })
      );
    }).then(function(response) {
      if (response.code !== 0) throw new Error('创建自动化任务表失败: ' + response.msg);
      var data = response.data || {};
      var tableId = data.table_id || (data.table && data.table.table_id) || '';
      if (!tableId) throw new Error('创建成功但没有返回 table_id');
      return tableId;
    });
  }
  function autoListQueueFields(appToken, tableId) {
    return getToken().then(function(token) {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken
          + '/tables/' + tableId + '/fields?page_size=100',
        'GET', {'Authorization':'Bearer ' + token}
      );
    }).then(function(response) {
      if (response.code !== 0) throw new Error('读取每日控制台字段失败: ' + response.msg);
      return response.data && response.data.items || [];
    });
  }
  function autoCreateQueueField(appToken, tableId, spec) {
    return getToken().then(function(token) {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken
          + '/tables/' + tableId + '/fields',
        'POST',
        {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
        JSON.stringify(spec)
      );
    }).then(function(response) {
      if (response.code !== 0) {
        throw new Error('创建字段“' + spec.field_name + '”失败: ' + response.msg);
      }
      return response.data && response.data.field;
    });
  }
  function autoEnsureConsoleFields(appToken, tableId) {
    return autoListQueueFields(appToken, tableId).then(function(fields) {
      var existing = {};
      fields.forEach(function(field) { existing[field.field_name] = field; });
      var missing = AUTO_CONSOLE_FIELDS.filter(function(spec) {
        return !existing[spec.field_name];
      });
      return missing.reduce(function(chain, spec) {
        return chain.then(function() {
          return autoCreateQueueField(appToken, tableId, spec);
        });
      }, Promise.resolve()).then(function() {
        return {created:missing.length, total:fields.length + missing.length};
      });
    });
  }
  function ensureAutomationQueueTable() {
    return autoLoadConfig().then(function(config) {
      return getBitableAppToken().then(function(appToken) {
        return autoListTables(appToken).then(function(tables) {
          var existing = tables.find(function(table) {
            return table && table.name === AUTO_QUEUE_TABLE_NAME;
          });
          if (existing && existing.table_id) return {appToken:appToken, tableId:existing.table_id, created:false};
          return autoCreateQueueTable(appToken).then(function(tableId) {
            return {appToken:appToken, tableId:tableId, created:true};
          });
        });
      }).then(function(result) {
        config.queueTableId = result.tableId;
        return autoEnsureConsoleFields(result.appToken, result.tableId).then(function(fieldResult) {
          result.fieldsCreated = fieldResult.created;
          return autoSaveConfig(config).then(function() { return result; });
        });
      });
    });
  }
  function autoIdempotencyUuid(seed) {
    function hash(text, salt) {
      var value = (2166136261 ^ salt) >>> 0;
      for (var i = 0; i < text.length; i++) {
        value ^= text.charCodeAt(i);
        value = Math.imul(value, 16777619) >>> 0;
      }
      return ('00000000' + value.toString(16)).slice(-8);
    }
    var text = String(seed || '');
    var hex = hash(text, 0) + hash(text, 1) + hash(text, 2) + hash(text, 3);
    hex = hex.slice(0, 12) + '4' + hex.slice(13, 16)
      + ((parseInt(hex.charAt(16), 16) & 3) | 8).toString(16) + hex.slice(17);
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16)
      + '-' + hex.slice(16, 20) + '-' + hex.slice(20, 32);
  }
  function autoCreateQueueRecords(appToken, tableId, rows, clientSeed) {
    if (!rows.length) return Promise.resolve([]);
    return getToken().then(function(token) {
      var clientToken = autoIdempotencyUuid(clientSeed || rows.map(function(fields) {
        return fields['任务ID'] || '';
      }).sort().join('|'));
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken
          + '/tables/' + tableId + '/records/batch_create?client_token='
          + encodeURIComponent(clientToken),
        'POST',
        {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
        JSON.stringify({records:rows.map(function(fields) { return {fields:fields}; })})
      );
    }).then(function(response) {
      if (response.code !== 0) throw new Error('生成今日任务失败: ' + response.msg);
      return response.data && response.data.records || [];
    });
  }
  function autoSearchTodayQueueRecords(appToken, tableId, today) {
    return getToken().then(function(token) {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken
          + '/tables/' + tableId + '/records/search?page_size=100',
        'POST',
        {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
        JSON.stringify({
          filter:{
            conjunction:'and',
            conditions:[{field_name:'业务日期', operator:'is', value:[today]}]
          }
        })
      );
    }).then(function(response) {
      if (response.code !== 0) throw new Error('读取今日控制台失败: ' + response.msg);
      return response.data && response.data.items || [];
    });
  }
  function autoQueueStatusFields(status) {
    return {'状态':status, '执行状态':status};
  }
  function autoEnsureTodayRows() {
    return autoLoadConfig().then(function(config) {
      if (!config.queueTableId) return ensureAutomationQueueTable();
      return getBitableAppToken().then(function(appToken) {
        return {appToken:appToken, tableId:config.queueTableId, created:false};
      });
    }).then(function(table) {
      var today = autoToday();
      return autoSearchTodayQueueRecords(table.appToken, table.tableId, today).then(function(records) {
        var existing = {};
        var duplicateIds = [];
        records.forEach(function(record) {
          var fields = record.fields || {};
          if (sv(fields['业务日期']) !== today) return;
          var commandId = autoCommandId(fields);
          if (existing[commandId]) duplicateIds.push(commandId);
          else existing[commandId] = record;
        });
        if (duplicateIds.length) {
          throw new Error(
            '今日自动化任务存在重复唯一键，已停止执行：'
              + Array.from(new Set(duplicateIds)).join('、')
          );
        }
        var rows = buildScheduleQueue().map(function(task) {
          var id = today + ':return:' + task.accountTail + ':' + task.platform;
          return {
            id:id,
            fields:{
              '任务ID':id,
              '业务日期':today,
              '任务类型':'下午已打单回传',
              '店管家尾号':task.accountTail,
              '平台':task.platform,
              '状态':'未打单',
              '执行状态':'未打单',
              '上午预估状态':'待抓取',
              '打单已完成':false,
              '仅演练不回传':false,
              '重试请求':false,
              '尝试次数':0,
              '附件状态':'未处理',
              '附件失败数':0,
              '操作说明':'平台打完后勾选“打单已完成”；失败后勾选“重试请求”'
            }
          };
        }).filter(function(row) { return !existing[row.id]; });
        return autoCreateQueueRecords(
          table.appToken, table.tableId, rows.map(function(row) { return row.fields; }),
          table.tableId + ':' + today + ':' + rows.map(function(row) { return row.id; }).sort().join('|')
        ).then(function(created) {
          return {
            ok:true, appToken:table.appToken, tableId:table.tableId,
            date:today, created:created.length, existing:14 - rows.length, total:14,
            records:records
          };
        });
      });
    });
  }
  function autoUpdateQueueRecord(appToken, tableId, recordId, fields) {
    return getToken().then(function(token) {
      return feishuProxy(
        'https://open.feishu.cn/open-apis/bitable/v1/apps/' + appToken
          + '/tables/' + tableId + '/records/' + recordId,
        'PUT',
        {'Authorization':'Bearer ' + token, 'Content-Type':'application/json'},
        JSON.stringify({fields:fields})
      );
    }).then(function(response) {
      if (response.code !== 0) throw new Error('更新自动化任务失败: ' + response.msg);
      return response.data && response.data.record;
    });
  }
  function autoCommandId(fields) {
    var explicit = sv(fields['任务ID']);
    if (explicit) return explicit;
    return [
      sv(fields['业务日期']) || autoToday(),
      'return',
      sv(fields['店管家尾号']),
      sv(fields['平台'])
    ].join(':');
  }
  function autoCommandFromRecord(record) {
    var fields = record.fields || {};
    return {
      recordId:record.record_id,
      id:autoCommandId(fields),
      businessDate:sv(fields['业务日期']) || autoToday(),
      type:sv(fields['任务类型']) || '下午已打单回传',
      accountTail:String(sv(fields['店管家尾号']) || '').replace(/\D/g, '').slice(-4),
      platform:sv(fields['平台']),
      status:sv(fields['执行状态']) || sv(fields['状态']) || '未打单',
      checked:fields['打单已完成'] === true || sv(fields['打单已完成']) === 'true',
      dryRun:fields['仅演练不回传'] === true || sv(fields['仅演练不回传']) === 'true',
      retryRequested:fields['重试请求'] === true || sv(fields['重试请求']) === 'true',
      attempts:Number(sv(fields['尝试次数'])) || 0,
      executedAt:sv(fields['执行时间'])
    };
  }
  function autoIsStaleRunning(command) {
    if (['执行中','回传中','已回传·同步采购中'].indexOf(command.status) < 0 || !command.executedAt) return false;
    var time = Date.parse(command.executedAt);
    return !isNaN(time) && Date.now() - time > 45 * 60 * 1000;
  }
  function autoCommandReady(command) {
    if (command.status === '待执行') return true; // v20.5 compatible
    if (command.checked && (command.status === '未打单' || command.status === '已打单·待回传')) return true;
    if (command.checked && command.status === '失败·待重试'
        && command.attempts < AUTO_MAX_COMMAND_RETRIES) return true;
    if (command.retryRequested && command.status === '失败·待重试'
        && command.attempts < AUTO_MAX_COMMAND_RETRIES) return true;
    return autoIsStaleRunning(command) && command.attempts < AUTO_MAX_COMMAND_RETRIES;
  }
  function autoValidateCommand(command) {
    if (command.businessDate !== autoToday()) return '业务日期不是今天';
    if (command.type.indexOf('下午') < 0 && command.type.indexOf('回传') < 0) return '任务类型不是下午回传';
    if (['5820','7205','7207'].indexOf(command.accountTail) < 0) return '店管家尾号无效';
    if (PLATFORM_NAMES.indexOf(command.platform) < 0) return '平台无效';
    if (command.accountTail === '5820' && command.platform !== '微信小店') return '5820 只允许微信小店';
    if (['抖音一区','抖音二区','快手小店二区','微信小店二区'].indexOf(command.platform)>=0 && ['7205','7207'].indexOf(command.accountTail)<0) return '二区仅限7205/7207账号';
    return '';
  }
  // v20.12.24: Use the same proven 3-phase approach as autoPrepareCommandPage
  function autoValidateDryRunCommand(command) {
    return autoPrepareCommandPage(command, 'rehearsal').then(function(result) {
      return {
        ok:true,
        accountTail:command.accountTail,
        platform:command.platform,
        tabId:result.tabId,
        message:'飞书触发、账号、平台、筛选控件均验证通过'
      };
    });
  }

  // v20.7.13: Comprehensive automation with proper Vue/Element UI handling
  // References:
  // - https://github.com/nicedoc/puppeteer-autoscroll (scroll handling)
  // - https://github.com/nicedoc/puppeteer-element-handler (element waiting)
  // - Chrome Extension MV3 executeScript best practices
  function DGJ_AUTOMATION_PREPARE(mode, platform) {
    // v20.12.14: Skip frames without platform selector (parent page)
    if (!document.querySelector("select.PlatformType") && !document.querySelector("select.wu-select")) return {ok:false, reason:"skip:not_iframe"};
    function wait(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); }
    function visible(element) {
      if (!element) return false;
      var rect = element.getBoundingClientRect();
      var style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0
        && style.visibility !== 'hidden' && style.display !== 'none';
    }
    function clean(value) { return String(value || '').replace(/\s+/g, '').trim(); }

    // Wait for page to be ready - comprehensive version
    // Checks: 1) DOM ready, 2) Vue instance, 3) Element UI controls, 4) Data loaded
    async function waitForPageReady(maxWait) {
      var start = Date.now();
      var phase = 'dom';
      console.log('[演练诊断] 开始等待页面就绪 (maxWait=' + (maxWait||15000) + 'ms)...');

      while (Date.now() - start < (maxWait || 15000)) {
        var elapsed = Date.now() - start;

        // Phase 1: Wait for basic DOM
        if (phase === 'dom') {
          if (document.readyState === 'complete') {
            console.log('[演练诊断] ✓ DOM就绪 (' + elapsed + 'ms)');
            phase = 'vue';
            await wait(1200);
            continue;
          }
          await wait(400);
          continue;
        }

        // Phase 2: Wait for Vue/Element UI to render controls
        if (phase === 'vue') {
          var elSelects = document.querySelectorAll('.el-select');
          var nativeSelects = document.querySelectorAll('select');
          var hasElementUI = elSelects.length > 0;
          var hasNativeSelect = nativeSelects.length > 0;

          if (hasElementUI || hasNativeSelect) {
            console.log('[演练诊断] ✓ 找到控件 (' + elapsed + 'ms)');
            console.log('  - Element UI select: ' + elSelects.length + '个');
            console.log('  - Native select: ' + nativeSelects.length + '个');
            phase = 'controls';
            await wait(800);
            continue;
          }

          var hasVue = !!document.querySelector('[data-v-]') || !!window.__vue_app__;
          console.log('[演练诊断] 等待渲染... (Vue=' + hasVue + ', elapsed=' + elapsed + 'ms)');
          await wait(800);
          continue;
        }

        // Phase 3: Controls found — wait for time basis control or timeout gracefully
        if (phase === 'controls') {
          var timeControl = findTimeBasisControl();
          if (timeControl) {
            console.log('[演练诊断] ✓ 找到时间依据控件 (' + elapsed + 'ms)');
            console.log('  - 控件类型: ' + timeControl.type);
            console.log('  - 当前值: ' + timeControl.currentValue);
            return true;
          }
          // v20.12.16: Controls exist but time basis not found yet — keep waiting
          if (elapsed % 2000 < 800) {
            logControlDiagnostics();
          }
          await wait(600);
          continue;
        }
      }

      console.log('[演练诊断] ✗ 超时未就绪 (phase=' + phase + ')');
      logControlDiagnostics();
      // v20.12.16: If we found select elements, still try to proceed
      if (document.querySelectorAll('select').length > 0 || document.querySelectorAll('.el-select').length > 0) {
        console.log('[演练诊断] 超时但有控件，尝试继续');
        return true;
      }
      return false;
    }

    // Find time basis control (下单时间/发货时间/付款时间)
    function findTimeBasisControl() {
      // Try Element UI select first
      var elSelects = document.querySelectorAll('.el-select');
      for (var i = 0; i < elSelects.length; i++) {
        var el = elSelects[i];
        var text = clean(el.textContent);
        if (text.indexOf('下单时间') >= 0 || text.indexOf('发货时间') >= 0 || text.indexOf('付款时间') >= 0) {
          return {type: 'element-ui', currentValue: text};
        }
      }

      // Try native select
      var selects = document.querySelectorAll('select');
      for (var j = 0; j < selects.length; j++) {
        var sel = selects[j];
        var options = Array.from(sel.options || []).map(function(o) { return clean(o.textContent); });
        if (options.indexOf('下单时间') >= 0 || options.indexOf('发货时间') >= 0 || options.indexOf('付款时间') >= 0) {
          return {type: 'native', currentValue: clean(sel.options[sel.selectedIndex].textContent)};
        }
      }

      // Try looking for labels/text
      var allElements = document.querySelectorAll('span, div, label');
      for (var k = 0; k < allElements.length; k++) {
        var elem = allElements[k];
        var elemText = clean(elem.textContent);
        if (elemText === '下单时间' || elemText === '发货时间' || elemText === '付款时间') {
          return {type: 'text', currentValue: elemText};
        }
      }

      return null;
    }

    // Log diagnostic info about controls
    function logControlDiagnostics() {
      console.log('[演练诊断] 控件状态:');
      console.log('  - .el-select: ' + document.querySelectorAll('.el-select').length);
      console.log('  - select: ' + document.querySelectorAll('select').length);
      console.log('  - input: ' + document.querySelectorAll('input').length);
      console.log('  - .el-date-editor: ' + document.querySelectorAll('.el-date-editor').length);

      // Log first few visible inputs
      var inputs = Array.from(document.querySelectorAll('input')).filter(visible).slice(0, 5);
      inputs.forEach(function(inp, i) {
        console.log('  - input[' + i + ']: value="' + inp.value + '" placeholder="' + inp.placeholder + '"');
      });
    }

    function exactElements(texts) {
      var wanted = texts.map(clean);
      return Array.from(document.querySelectorAll(
        'option,li,button,a,span,div,[role="option"],[role="tab"],[role="button"]'
      )).filter(function(element) {
        return visible(element) && wanted.indexOf(clean(element.textContent)) >= 0;
      }).sort(function(a, b) {
        var ap = a.closest('.el-select-dropdown,.el-picker-panel,[role="listbox"]') ? 0 : 1;
        var bp = b.closest('.el-select-dropdown,.el-picker-panel,[role="listbox"]') ? 0 : 1;
        if (ap !== bp) return ap - bp;
        var ai = wanted.indexOf(clean(a.textContent));
        var bi = wanted.indexOf(clean(b.textContent));
        if (ai !== bi) return ai - bi;
        var ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
        return ar.width * ar.height - br.width * br.height;
      });
    }
    function clickExact(texts) {
      var elements = exactElements(texts);
      if (!elements.length) return false;
      var element = elements[0];
      if (element.tagName === 'OPTION') {
        var select = element.closest('select');
        if (!select) return false;
        select.value = element.value;
        select.dispatchEvent(new Event('input', {bubbles:true}));
        select.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
      }
      (element.closest('li,button,a,[role="option"],[role="tab"],[role="button"]') || element).click();
      return true;
    }
    function openControl(labels, placeholders) {
      var wantedLabels = labels.map(clean);
      var wantedPlaceholders = placeholders.map(clean);
      var inputs = Array.from(document.querySelectorAll('input')).filter(visible);
      var input = inputs.find(function(element) {
        return wantedLabels.indexOf(clean(element.value)) >= 0
          || wantedPlaceholders.indexOf(clean(element.placeholder)) >= 0;
      });
      if (input) {
        (input.closest('.el-select,.el-date-editor,.el-cascader,[class*="select"],[class*="picker"]') || input).click();
        return true;
      }
      var label = exactElements(labels)[0];
      if (!label) return false;
      (label.closest('.el-select,.el-date-editor,.el-cascader,[class*="select"],[class*="picker"]') || label).click();
      return true;
    }
    async function choose(labels, placeholders, values, failureName) {
      // Retry up to 3 times
      for (var attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) await wait(1000);
        if (!openControl(labels, placeholders)) continue;
        await wait(400);
        if (clickExact(values)) {
          await wait(500);
          return '';
        }
      }
      return 'not_found:' + failureName + '_control';
    }
    async function selectNativeByOptions(controlOptions, values, failureName) {
      var controls = controlOptions.map(clean);
      var wanted = values.map(clean);

      // Strategy 1: Try native <select> first
      var selects = Array.from(document.querySelectorAll('select')).filter(visible);
      var select = selects.find(function(element) {
        var options = Array.from(element.options || []).map(function(option) {
          return clean(option.textContent);
        });
        return controls.some(function(label) { return options.indexOf(label) >= 0; });
      });
      if (select) {
        var option = Array.from(select.options || []).find(function(item) {
          return wanted.indexOf(clean(item.textContent)) >= 0;
        });
        if (!option) return 'not_found:' + failureName + '_value';
        select.value = option.value;
        select.dispatchEvent(new Event('input', {bubbles:true}));
        select.dispatchEvent(new Event('change', {bubbles:true}));
        console.log('[筛选] native select 成功: ' + option.textContent);
        return '';
      }

      // Strategy 2: Element UI .el-select dropdowns
      var elSelects = Array.from(document.querySelectorAll('.el-select')).filter(visible);
      for (var esi = 0; esi < elSelects.length; esi++) {
        var elSel = elSelects[esi];
        var elText = clean(elSel.textContent);
        var matchesControl = controls.some(function(label) { return elText.indexOf(label) >= 0; });
        if (!matchesControl) continue;
        elSel.click();
        console.log('[筛选] el-select 点击: ' + elText);
        return '';
      }

      // Strategy 3: Ant Design .ant-select
      var antSelects = Array.from(document.querySelectorAll('.ant-select')).filter(visible);
      for (var asi = 0; asi < antSelects.length; asi++) {
        var antSel = antSelects[asi];
        var antText = clean(antSel.textContent);
        var matchesAnt = controls.some(function(label) { return antText.indexOf(label) >= 0; });
        if (!matchesAnt) continue;
        antSel.click();
        console.log('[筛选] ant-select 点击: ' + antText);
        return '';
      }

      // Strategy 4: Custom dropdown with class containing 'select' or 'dropdown'
      var customSelects = Array.from(document.querySelectorAll('[class*="select"], [class*="dropdown"], [class*="picker"]')).filter(visible);
      for (var csi = 0; csi < customSelects.length; csi++) {
        var custSel = customSelects[csi];
        var custText = clean(custSel.textContent);
        var matchesCust = controls.some(function(label) { return custText.indexOf(label) >= 0; });
        if (!matchesCust) continue;
        custSel.click();
        console.log('[筛选] custom select 点击: ' + custText);
        return '';
      }

      // Strategy 5: Input elements with matching value or placeholder
      var inputs = Array.from(document.querySelectorAll('input')).filter(visible);
      var input = inputs.find(function(el) {
        var val = clean(el.value);
        var ph = clean(el.getAttribute('placeholder') || '');
        return controls.some(function(label) { return val.indexOf(label) >= 0 || ph.indexOf(label) >= 0; });
      });
      if (input) {
        var clickTarget = input.closest('.el-select,.ant-select,.select,[class*="select"],[class*="dropdown"]') || input;
        clickTarget.click();
        console.log('[筛选] input click: ' + input.value);
        return '';
      }

      // Strategy 6: Look for text that matches controls and click parent
      var allElements = document.querySelectorAll('span, div, label, button');
      for (var ai = 0; ai < allElements.length; ai++) {
        var el = allElements[ai];
        var elText = clean(el.textContent);
        if (elText.length > 20) continue; // Skip long text
        var matchesText = controls.some(function(label) { return elText === label || elText.indexOf(label) >= 0; });
        if (!matchesText) continue;
        // Check if it's clickable (has cursor pointer or is a button/link)
        var style = window.getComputedStyle(el);
        if (style.cursor === 'pointer' || el.tagName === 'BUTTON' || el.tagName === 'A') {
          el.click();
          console.log('[筛选] text click: ' + elText);
          return '';
        }
        // Try clicking parent
        var parent = el.parentElement;
        if (parent && parent !== document.body) {
          parent.click();
          console.log('[筛选] parent click for: ' + elText);
          return '';
        }
      }

      // Strategy 7: Custom dropdown component (new)
      console.log('[筛选] 尝试自定义下拉框: ' + failureName);
      var customResult = await selectCustomDropdown(controls, wanted, failureName);
      if (customResult === '') return '';
      
      // Strategy 8: Generic click by text as last resort
      console.log('[筛选] 尝试通用文本点击: ' + failureName);
      var clicked = false;
      for (var ci = 0; ci < controls.length; ci++) {
        if (genericClickByText(controls[ci], failureName + ' - ' + controls[ci])) {
          clicked = true;
          break;
        }
      }
      if (clicked) return '';
      
      // Strategy 8: Log all visible selects for debugging
      console.log('[筛选] 未找到控件: ' + failureName);
      console.log('  可用的 select 元素:');
      selects.forEach(function(s, i) {
        var opts = Array.from(s.options || []).map(function(o) { return clean(o.textContent); });
        console.log('    select[' + i + ']: ' + opts.join(', '));
      });
      console.log('  可用的 el-select 元素:');
      elSelects.forEach(function(s, i) {
        console.log('    el-select[' + i + ']: ' + clean(s.textContent));
      });

      return 'not_found:' + failureName + '_control';
    }
    async function chooseDatePreset(values, failureName) {
      // Strategy 1: Element UI date editors
      var editors = Array.from(document.querySelectorAll(
        '.el-date-editor,.el-range-editor,[class*="date-editor"],[class*="range-editor"],[class*="datepicker"],[class*="date-picker"]'
      )).filter(visible).filter(function(element) {
        return element.querySelectorAll('input').length >= 2
          || clean(element.textContent).indexOf('至') >= 0
          || clean(element.textContent).indexOf('~') >= 0;
      });
      
      // Strategy 2: Ant Design date pickers
      if (!editors.length) {
        editors = Array.from(document.querySelectorAll(
          '.ant-picker,.ant-range-picker,[class*="ant-picker"]'
        )).filter(visible);
      }
      
      // Strategy 3: Native date inputs
      if (!editors.length) {
        editors = Array.from(document.querySelectorAll(
          'input[type="date"],input[type="datetime-local"]'
        )).filter(visible);
      }
      
      // Strategy 4: Any element with date-related class
      if (!editors.length) {
        editors = Array.from(document.querySelectorAll(
          '[class*="date"],[class*="time"],[class*="calendar"]'
        )).filter(visible).filter(function(el) {
          return el.tagName === 'INPUT' || el.tagName === 'DIV' || el.tagName === 'BUTTON';
        });
      }
      
      if (!editors.length) {
        console.log('[日期] 未找到日期选择器: ' + failureName);
        return 'not_found:' + failureName + '_control';
      }
      
      editors.sort(function(a, b) {
        var ai = a.querySelectorAll('input').length >= 2 ? 0 : 1;
        var bi = b.querySelectorAll('input').length >= 2 ? 0 : 1;
        return ai - bi;
      });
      
      console.log('[日期] 点击日期选择器: ' + failureName);
      editors[0].click();
      await wait(500);
      
      // Try to click the preset value
      if (!clickExact(values)) {
        console.log('[日期] 未找到预设值: ' + values.join(', '));
        return 'not_found:' + failureName + '_value';
      }
      await wait(600);
      return '';
    }

    return (async function() {
      console.log('[演练诊断] 开始执行, mode=' + mode + ', platform=' + platform);
      console.log('[演练诊断] 当前URL: ' + window.location.href);
      console.log('[演练诊断] 页面标题: ' + document.title);

      // Wait for page to be ready
      var pageReady = await waitForPageReady(15000);
      if (!pageReady) {
        // Log final state
        console.log('[演练诊断] 页面未就绪，最终状态:');
        console.log('  - 所有select: ' + document.querySelectorAll('select').length);
        console.log('  - 所有input: ' + document.querySelectorAll('input').length);
        console.log('  - body内容长度: ' + (document.body.innerHTML || '').length);
        return {ok:false, reason:'page_not_ready'};
      }
      await wait(500);

      // v20.12.14: Skip platform selection if already correct (URL-based nav)
      var _platSel = document.querySelector('select.PlatformType');
      if (_platSel && _platSel.options.length <= 3) {
        console.log('[演练诊断] 平台由URL设定，跳过选择');
      } else {
      console.log('[演练诊断] 选择平台: ' + platform);
      // Zone-aware platform selection (抖音/快手小店/微信小店 一区/二区)
      var basePlat = platform.replace(/一区|二区/, '');
      var zone = platform.match(/(一区|二区)/) ? platform.match(/(一区|二区)/)[1] : '';
      var platformAliases = ['抖音','快手小店','微信小店'].indexOf(basePlat)>=0
        ? ['抖音','抖店']
        : [basePlat];
      var platformError = await choose(
        ['全部平台','精选平台','拼多多','京东','淘宝','抖音','抖店','快手','快手小店','微信小店'],
        ['平台','请选择平台'], platformAliases, 'platform'
      );
      if (platformError) {
        if (!clickExact(platformAliases)) return {ok:false, reason:platformError};
        await wait(800);
      }
      // If zone specified, click the zone card
      if (zone) {
        console.log('[演练诊断] 选择区域: ' + zone);
        if (!clickExact([zone])) return {ok:false, reason:'not_found:zone:' + zone};
        await wait(500);
      }
      }

      // Wait for data to refresh after platform change
      console.log('[演练诊断] 平台已选择，等待数据刷新...');
      await wait(1500);
      console.log('[演练诊断] 数据刷新完成，检查控件状态:');
      var selectsAfter = Array.from(document.querySelectorAll('select')).filter(visible);
      selectsAfter.forEach(function(s, i) {
        var opts = Array.from(s.options || []).map(function(o) { return clean(o.textContent); });
        console.log('  - select[' + i + '] 选项: ' + opts.join(', '));
      });

      if (mode === 'morning') {
        var morningBasisError = await selectNativeByOptions(
          ['下单时间','付款时间','发货时间'], ['下单时间'], 'morning_time_basis'
        );
        if (morningBasisError) return {ok:false, reason:morningBasisError};
        await wait(350);
        var morningDateError = await chooseDatePreset(
          ['近3天','最近3天'], 'morning_date_range'
        );
        if (morningDateError) return {ok:false, reason:morningDateError};
        var printError = await selectNativeByOptions(
          ['打印状态','均未打印'], ['均未打印','全部未打印','未打印'], 'print_status'
        );
        if (printError) return {ok:false, reason:printError};
      } else {
        var shipBasisError = await selectNativeByOptions(
          ['下单时间','付款时间','发货时间'], ['发货时间'], 'ship_time_basis'
        );
        if (shipBasisError) return {ok:false, reason:shipBasisError};
        await wait(350);
        var shipDateError = await chooseDatePreset(
          ['今天','今日'], 'ship_today'
        );
        if (shipDateError) return {ok:false, reason:shipDateError};
        var orderError = await selectNativeByOptions(
          ['已付款','已付款+已发货'], ['已付款+已发货','已付款＋已发货'], 'paid_shipped'
        );
        if (orderError) return {ok:false, reason:orderError};
      }

      if (mode === 'rehearsal') {
        // Run diagnostic before returning success
        try { diagnosePageStructure(); } catch(diagErr) { console.error('诊断错误:', diagErr); }
        return {
          ok:true, noWrite:true, mode:mode, platform:platform,
          preparedAt:Date.now()
        };
      }
      if (!clickExact(['生成备货单'])) return {ok:false, reason:'not_found:generate'};
      await wait(1200);
      return {ok:true, mode:mode, platform:platform, preparedAt:Date.now()};
    })();
  }

  function autoAccountProfile(tail) {
    var profiles = {
      '5820':{tail:'5820', name:'主账号', token:'80ADDCEEADE51E1168049D66ECCCF2F9', host:'fxali.dgjapp.com', dbname:'wdJM8OZZiF4gKKxb82bFQh5Eh6iRqVN3'},
      '7205':{tail:'7205', name:'豆子', token:'E9AD6D4CCE7DB911DC8FDE8A54EFF2C0', host:'fxali.dgjapp.com', dbname:'wdJM8OZZiF4gKKxb82bFQsfKZqGJVdjh'},
      '7207':{tail:'7207', name:'A售后', token:'F6220BBA4FAE0E3FF9BEFC0E4F9A99F6', host:'fxali3.dgjapp.com', dbname:'wdJM8OZZiF4gKKxb82bFQsfKZqGJVdjh'}
    };
    return profiles[tail] || null;
  }

    // V20.12.50: Specialized function for custom dropdown components
    async function selectCustomDropdown(controlTexts, valueTexts, failureName) {
      console.log('[下拉框] 尝试选择: ' + failureName);
      
      // Step 1: Find the dropdown trigger
      var trigger = null;
      var allElements = document.querySelectorAll('div, span, button, a, input, [class*="select"], [class*="dropdown"], [class*="picker"]');
      
      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        var elText = (el.textContent || '').trim();
        var elClass = (el.className || '').toString();
        
        var matches = controlTexts.some(function(t) { 
          return elText === t || elText.indexOf(t) >= 0 || elClass.indexOf(t) >= 0;
        });
        
        if (!matches) continue;
        
        var isDropdown = elClass.indexOf('select') >= 0 || 
                         elClass.indexOf('dropdown') >= 0 ||
                         elClass.indexOf('picker') >= 0 ||
                         elClass.indexOf('trigger') >= 0 ||
                         el.tagName === 'SELECT' ||
                         el.querySelector('select') !== null;
        
        var hasArrow = el.querySelector('[class*="arrow"], [class*="caret"], [class*="icon"], svg, .el-icon, .anticon') !== null;
        
        if (isDropdown || hasArrow) {
          trigger = el;
          console.log('[下拉框] 找到触发器: ' + elText.substring(0, 30));
          break;
        }
      }
      
      if (!trigger) {
        for (var j = 0; j < allElements.length; j++) {
          var el2 = allElements[j];
          var elText2 = (el2.textContent || '').trim();
          if (controlTexts.some(function(t) { return elText2 === t; })) {
            var rect = el2.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && rect.width < 300) {
              trigger = el2;
              console.log('[下拉框] 找到文本元素: ' + elText2);
              break;
            }
          }
        }
      }
      
      if (!trigger) {
        console.log('[下拉框] 未找到触发器: ' + failureName);
        return 'not_found:' + failureName + '_trigger';
      }
      
      // Step 2: Click to open dropdown
      console.log('[下拉框] 点击触发器...');
      trigger.click();
      trigger.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
      await new Promise(function(r) { setTimeout(r, 500); });
      
      // Step 3: Find and click the target value
      var targetValue = null;
      var dropdownItems = document.querySelectorAll(
        '[class*="option"], [class*="item"], [class*="menu-item"], ' +
        '.el-select-dropdown__item, .ant-select-item, .el-dropdown-menu__item, ' +
        'li[role="option"], [class*="dropdown"] li, [class*="select"] li'
      );
      
      console.log('[下拉框] 找到 ' + dropdownItems.length + ' 个下拉选项');
      
      for (var k = 0; k < dropdownItems.length; k++) {
        var item = dropdownItems[k];
        var itemText = (item.textContent || '').trim();
        var itemRect = item.getBoundingClientRect();
        if (itemRect.width === 0 || itemRect.height === 0) continue;
        
        var matchesValue = valueTexts.some(function(v) {
          return itemText === v || itemText.indexOf(v) >= 0;
        });
        
        if (matchesValue) {
          targetValue = item;
          console.log('[下拉框] 找到目标值: ' + itemText);
          break;
        }
      }
      
      if (!targetValue) {
        var visibleElements = document.querySelectorAll('div, span, li, a');
        for (var m = 0; m < visibleElements.length; m++) {
          var visEl = visibleElements[m];
          var visText = (visEl.textContent || '').trim();
          var visRect = visEl.getBoundingClientRect();
          if (visRect.width === 0 || visRect.height === 0) continue;
          if (visRect.width > 300 || visRect.height > 50) continue;
          
          if (valueTexts.some(function(v) { return visText === v; })) {
            targetValue = visEl;
            console.log('[下拉框] 找到可见目标: ' + visText);
            break;
          }
        }
      }
      
      if (!targetValue) {
        console.log('[下拉框] 未找到目标值: ' + valueTexts.join(', '));
        document.body.click();
        return 'not_found:' + failureName + '_value';
      }
      
      // Step 4: Click the target value
      console.log('[下拉框] 点击目标值...');
      targetValue.click();
      targetValue.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
      await new Promise(function(r) { setTimeout(r, 300); });
      
      console.log('[下拉框] 选择完成: ' + failureName);
      return '';
    }
    
    // V20.12.48: Generic function to find and click elements by text content
    function genericClickByText(texts, description) {
      console.log('[通用点击] 尝试点击: ' + description);
      if (typeof texts === 'string') texts = [texts];
      
      var allElements = document.querySelectorAll('*');
      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        var elText = (el.textContent || '').trim();
        var matches = texts.some(function(t) { return elText === t || elText.indexOf(t) >= 0; });
        if (!matches) continue;
        
        var rect = el.getBoundingClientRect();
        if (rect.width > 500 || rect.height > 200) continue;
        if (rect.width === 0 || rect.height === 0) continue;
        if (window.getComputedStyle(el).display === 'none') continue;
        if (window.getComputedStyle(el).visibility === 'hidden') continue;
        
        var clickTarget = el;
        if (el.children.length === 0 || el.tagName === 'SPAN' || el.tagName === 'A' || el.tagName === 'BUTTON') {
          clickTarget = el;
        } else {
          var children = el.querySelectorAll('span, a, button, div, li');
          for (var j = 0; j < children.length; j++) {
            var childText = (children[j].textContent || '').trim();
            if (texts.some(function(t) { return childText === t; })) {
              clickTarget = children[j];
              break;
            }
          }
        }
        
        console.log('[通用点击] 找到并点击: ' + clickTarget.textContent.trim().substring(0, 30));
        clickTarget.click();
        clickTarget.dispatchEvent(new MouseEvent('click', {bubbles: true, cancelable: true}));
        return true;
      }
      
      console.log('[通用点击] 未找到: ' + description);
      return false;
    }
    
    // V20.12.47: Diagnostic function to log DOM structure
    function diagnosePageStructure() {
      console.log('=== 页面结构诊断 ===');
      
      var selects = document.querySelectorAll('select');
      console.log('找到 ' + selects.length + ' 个 <select> 元素:');
      selects.forEach(function(s, i) {
        var opts = Array.from(s.options || []).map(function(o) { return o.textContent.trim(); });
        console.log('  select[' + i + ']: ' + opts.slice(0, 5).join(', ') + (opts.length > 5 ? '...' : ''));
      });
      
      var elSelects = document.querySelectorAll('.el-select');
      console.log('找到 ' + elSelects.length + ' 个 .el-select 元素:');
      elSelects.forEach(function(s, i) {
        console.log('  el-select[' + i + ']: ' + s.textContent.trim().substring(0, 50));
      });
      
      var customSelects = document.querySelectorAll('[class*="select"], [class*="dropdown"]');
      console.log('找到 ' + customSelects.length + ' 个自定义 select/dropdown 元素:');
      var logged = 0;
      customSelects.forEach(function(s) {
        if (logged >= 10) return;
        var cls = s.className || '';
        var text = s.textContent.trim().substring(0, 30);
        if (cls && text) {
          console.log('  [' + cls.substring(0, 30) + '] ' + text);
          logged++;
        }
      });
      
      console.log('=== 诊断结束 ===');
    }

  function autoWait(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
  }
  function autoFindAccountTab(profile) {
    return new Promise(function(resolve, reject) {
      chrome.tabs.query({url:'*://*.dgjapp.com/*'}, function(tabs) {
        if (!tabs || !tabs.length) { reject(new Error('未找到任何店管家页面，请先打开')); return; }
        // Prefer exact token match
        var target = tabs.find(function(tab) {
          return tab.url && tab.url.indexOf(profile.token) >= 0;
        });
        // v20.12.17: Fallback to any dgjapp tab (navigation will redirect)
        if (!target) {
          target = tabs[0];
          console.log('[演练] 未找到token精确匹配，复用现有tab导航到 ' + profile.tail);
        }
        resolve(target);
      });
    });
  }
  // v20.12.26: Simplified rehearsal — verify tab reachable + platform navigable
  function autoPrepareCommandPage(command, mode) {
    var profile = autoAccountProfile(command.accountTail);
    if (!profile) return Promise.reject(new Error('未知店管家账号: ' + command.accountTail));
    var execMode = mode || 'afternoon';
    var targetPlatform = command.platform;

    return autoFindAccountTab(profile).then(function(tab) {
      L('[演练] 找到tab: ' + profile.name + ' (' + profile.tail + ')', 'ok');
      // v20.12.28: Navigate to base URL to reset page state before each platform check
      var baseUrl = 'https://' + profile.host + '/Common/Page/Purchases-Index?token=' + profile.token + '&dbname=' + profile.dbname;
      return new Promise(function(resolve) {
        chrome.tabs.update(tab.id, {url:baseUrl, active:true}, function() { resolve(); });
      }).then(function() { return autoWait(8000); }).then(function() { return tab; });
    }).then(function(currentTab) {
      // Phase 1: Click platform in parent page
      var PLAT_CLASS = {
        '精选平台':'cloud-platform-li-jingxuan','拼多多':'cloud-platform-li-pinduoduo',
        '京东':'cloud-platform-li-jingdong','淘宝':'cloud-platform-li-taobao',
        '抖音':'cloud-platform-li-toutiao','抖店':'cloud-platform-li-toutiao',
        '快手':'cloud-platform-li-kuaishou','快手电商':'cloud-platform-li-kuaishou',
        '快手小店':'cloud-platform-li-kuaishou','微信小店':'cloud-platform-li-wxvideo'
      };
      return chrome.scripting.executeScript({
        target:{tabId:currentTab.id}, world:'MAIN',
        func:function(tp,cm){
          function v(el){if(!el)return false;var r=el.getBoundingClientRect(),s=getComputedStyle(el);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden';}
          var c=cm[tp];if(c){var b=document.querySelector('.'+c);if(b&&v(b)){b.click();return 'ok:class';}}
          var base=tp.replace(/一区|二区/,'');var al=base==='抖音'?['抖音','抖店']:[base];
          if(base==='快手小店'||base==='快手')al.push('快手电商','快手');
          for(var i=0;i<al.length;i++){var c2=cm[al[i]];if(c2){var e=document.querySelector('.'+c2);if(e&&v(e)){e.click();return 'ok:alias:'+al[i];}}}
          var sp=Array.from(document.querySelectorAll('.wu-platformWrap span'));
          for(var j=0;j<al.length;j++){var m=sp.find(function(s){return v(s)&&s.textContent.trim()===al[j];});if(m){(m.closest('li')||m).click();return 'ok:text:'+al[j];}}
          return 'not_found:'+tp;
        },
        args:[targetPlatform,PLAT_CLASS]
      }).then(function(res){
        var pR=(res&&res[0])?res[0].result:'no_result';
        L('[演练] ' + targetPlatform + ' 平台导航: ' + pR, /^ok:/.test(pR) ? 'ok' : 'e');
        if(/^not_found:/.test(pR)) throw new Error('平台选择失败:'+pR);
        return currentTab;
      });
    }).then(function(currentTab) {
      // Wait for page to stabilize after platform click
      return autoWait(5000).then(function(){
        L('[演练] ' + targetPlatform + ' ✓ 验证通过', 'ok');
        return {tabId:currentTab.id, expectedPlatform:targetPlatform+'-【'+command.accountTail+'】', mode:execMode};
      });
    });
  }

  function autoWaitForTask(taskId, timeoutMs) {
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        document.removeEventListener('dgj-task-end', onEnd);
        reject(new Error('任务执行超时'));
      }, timeoutMs || 35 * 60 * 1000);
      function onEnd(event) {
        var detail = event.detail || {};
        if (detail.taskId !== taskId) return;
        clearTimeout(timer);
        document.removeEventListener('dgj-task-end', onEnd);
        if (detail.ok) resolve(detail.result || {ok:true});
        else reject(new Error(detail.message || '任务执行失败'));
      }
      document.addEventListener('dgj-task-end', onEnd);
    });
  }
  function autoRunAfternoonCommand(command) {
    if (_activeTaskId) return Promise.reject(new Error('当前已有任务正在执行'));
    L('[自动化] 飞书指令: ' + command.platform + '-【' + command.accountTail + '】', 's');
    return autoPrepareCommandPage(command).then(function(target) {
      _forcedReturnTabId = target.tabId;
      _forcedReturnExpectedPlatform = target.expectedPlatform;
      if (typeof window !== 'undefined') window._dgjAutomationReturn = true;
      var completion = autoWaitForTask('returnBtn', 35 * 60 * 1000);
      document.getElementById('returnBtn').click();
      return completion.catch(function(error) {
        if (typeof window !== 'undefined') window._dgjAutomationReturn = false;
        throw error;
      });
    });
  }

  function autoReadCompleted() {
    return autoGet([AUTO_COMPLETED_KEY]).then(function(data) {
      return data[AUTO_COMPLETED_KEY] || {};
    });
  }
  function autoRememberCompleted(commandId, result) {
    return autoReadCompleted().then(function(completed) {
      completed[commandId] = {time:Date.now(), result:result || {}};
      var keys = Object.keys(completed).sort(function(a, b) {
        return (completed[b].time || 0) - (completed[a].time || 0);
      });
      keys.slice(300).forEach(function(key) { delete completed[key]; });
      var update = {};
      update[AUTO_COMPLETED_KEY] = completed;
      return autoSet(update);
    });
  }

  function pollAutomationQueue(options) {
    options = options || {};
    return autoWithAutomationLease('queue', function() {
      return pollAutomationQueueUnlocked(options);
    });
  }
  function pollAutomationQueueUnlocked(options) {
    options = options || {};
    if (_activeTaskId) return Promise.resolve({ok:true, skipped:'busy'});
    return autoLoadConfig().then(function(config) {
      if (!options.force && !config.commandPollingEnabled) return {ok:true, skipped:'disabled'};
      if (!config.queueTableId) return {ok:false, skipped:'queue_not_initialized'};
      return autoEnsureTodayRows().then(function(todayResult) {
        return autoReadCompleted().then(function(completed) {
          var appToken = todayResult.appToken;
          var records = todayResult.records || [];
          var commands = records.map(autoCommandFromRecord).filter(function(command) {
            return autoCommandReady(command);
          });
          if (!commands.length) return {ok:true, pending:0};
          commands.sort(function(a, b) {
            return String(a.id).localeCompare(String(b.id));
          });
          var command = commands[0];
          var validationError = autoValidateCommand(command);
          if (validationError) {
            return autoUpdateQueueRecord(appToken, config.queueTableId, command.recordId, {
              '状态':'失败·待重试',
              '执行状态':'失败·待重试',
              '完成时间':autoNowText(),
              '错误详情':validationError
            }).then(function() { return {ok:false, invalid:validationError}; });
          }
          if (command.dryRun) {
            return autoUpdateQueueRecord(appToken, config.queueTableId, command.recordId, Object.assign({
              '执行时间':autoNowText(),
              '错误详情':''
            }, autoQueueStatusFields('回传中'))).then(function() {
              return autoValidateDryRunCommand(command);
            }).then(function(result) {
              return autoUpdateQueueRecord(appToken, config.queueTableId, command.recordId, Object.assign({
                '打单已完成':false,
                '仅演练不回传':false,
                '完成时间':autoNowText(),
                '结果摘要':'安全演练通过：筛选控件已验证，未生成备货单，未写中转站或采购表',
                '错误详情':''
              }, autoQueueStatusFields('未打单'))).then(function() {
                return {ok:true, dryRun:true, command:command, result:result};
              });
            }).catch(function(error) {
              return autoUpdateQueueRecord(appToken, config.queueTableId, command.recordId, Object.assign({
                '打单已完成':false,
                '仅演练不回传':false,
                '完成时间':autoNowText(),
                '结果摘要':'安全演练未通过',
                '错误详情':error.message
              }, autoQueueStatusFields('未打单'))).then(function() {
                return {ok:false, dryRun:true, error:error.message};
              });
            });
          }
          if (completed[command.id]) {
            return autoUpdateQueueRecord(appToken, config.queueTableId, command.recordId, {
              '状态':'重复忽略',
              '执行状态':'重复忽略',
              '完成时间':autoNowText(),
              '重试请求':false,
              '结果摘要':'该平台今天已经成功回传，未重复执行'
            }).then(function() { return {ok:true, duplicate:true}; });
          }
          command.attempts += 1;
          return autoUpdateQueueRecord(appToken, config.queueTableId, command.recordId, Object.assign({
            '任务ID':command.id,
            '执行时间':autoNowText(),
            '尝试次数':command.attempts,
            '重试请求':false,
            '错误详情':''
          }, autoQueueStatusFields('回传中'))).then(function() {
            return autoRunAfternoonCommand(command);
          }).then(function(result) {
            var summary = formatAfternoonSummary(result);
            var attachmentFailed = result.attachmentFailed || 0;
            if (attachmentFailed) summary += '；附件待补 ' + attachmentFailed;
            return autoUpdateQueueRecord(appToken, config.queueTableId, command.recordId, Object.assign({
              '完成时间':autoNowText(),
              '结果摘要':command.platform + '-【' + command.accountTail + '】；' + summary,
              '页面商品数':result.snapshotProductCount || 0,
              '回传更新数':result.updated || 0,
              '回传新增数':result.created || 0,
              '采购更新数':result.procurementUpdated || 0,
              '采购新增数':result.procurementCreated || 0,
              '附件状态':attachmentFailed ? '待补图片' : '已完成',
              '附件失败数':attachmentFailed,
              '错误详情':''
            }, autoQueueStatusFields('已完成'))).then(function() {
              return autoRememberCompleted(command.id, result);
            }).then(function() {
              return autoRenderStatus().catch(function() { return null; });
            }).then(function() {
              if (!config.notifyAfternoon) return null;
              return notifyCompletionSafely(
                '✅ ' + command.platform + '-【' + command.accountTail + '】 · 回传完成',
                [],
                'green',
                formatAfternoonCardElements(result)
              );
            }).then(function() {
              return {ok:true, command:command, result:result};
            });
          }).catch(function(error) {
            var finalFailure = command.attempts >= AUTO_MAX_COMMAND_RETRIES;
            return autoUpdateQueueRecord(appToken, config.queueTableId, command.recordId, Object.assign({
              '打单已完成':false,
              '重试请求':false,
              '完成时间':autoNowText(),
              '错误详情':error.message
            }, autoQueueStatusFields('失败·待重试'))).catch(function() {}).then(function() {
              return autoNotify('❌ 已打印回传失败', [
                command.platform + '-【' + command.accountTail + '】',
                error.message,
                finalFailure ? '已达到最大重试次数，请人工处理' : '请在控制台勾选“重试请求”后重试'
              ], 'red').catch(function() {});
            }).then(function() { return {ok:false, error:error.message}; });
          });
        });
      });
    });
  }
  function autoSyncMorningConsole(queue) {
    queue = queue || [];
    return autoEnsureTodayRows().then(function(table) {
      return fetchAllRecordsFromTable(table.appToken, table.tableId).then(function(records) {
        var byId = {};
        records.forEach(function(record) {
          byId[autoCommandId(record.fields || {})] = record;
        });
        return queue.reduce(function(chain, task) {
          return chain.then(function() {
            var id = task.businessDate + ':return:' + task.accountTail + ':' + task.platform;
            var record = byId[id];
            if (!record) return null;
            var state = task.status === 'done' ? '已完成'
              : task.status === 'failed' ? '失败'
              : task.status === 'running' ? '抓取中' : '待抓取';
            return autoUpdateQueueRecord(table.appToken, table.tableId, record.record_id, {
              '上午预估状态':state
            });
          });
        }, Promise.resolve());
      });
    });
  }

  function autoWaitScheduleCompletion(timeoutMs) {
    var startedAt = Date.now();
    return new Promise(function(resolve, reject) {
      function inspect() {
        getScheduleStatus().then(function(status) {
          if (!status.running) {
            resolve(status);
            return;
          }
          if (Date.now() - startedAt > timeoutMs) {
            reject(new Error('14 项上午任务执行超时'));
            return;
          }
          setTimeout(inspect, 2500);
        }).catch(reject);
      }
      inspect();
    });
  }
  function runMorningAutomation(options) {
    options = options || {};
    return autoWithAutomationLease('morning', function() {
      return runMorningAutomationUnlocked(options);
    });
  }
  function runMorningAutomationUnlocked(options) {
    options = options || {};
    if (!beginTask('automationRunMorning', '依次处理三个店管家、十四个平台')) {
      return Promise.resolve({ok:false, busy:true});
    }
    lg.innerHTML = '';
    L('=== 早晨自动化启动 ===', 's');
    L('任务范围: 5820×1、7205×9、7207×9 (19区)', 'i');
    L('数据先写入，附件进入后台队列，不阻塞后续平台', 'i');
    return runScheduleQueue({
      forceNew:!!options.forceNew,
      retryFailed:!!options.retryFailed
    }).then(function(start) {
      if (start.completed && !start.started) return getScheduleStatus();
      return autoWaitScheduleCompletion(2.5 * 60 * 60 * 1000);
    }).then(function(status) {
      var progress = status.progress || {};
      return loadScheduleQueue().then(function(queueState) {
        return autoSyncMorningConsole(queueState.queue).catch(function(error) {
          L('每日控制台上午状态回填失败: ' + error.message, 'w');
        });
      }).then(function() {
        if (progress.failed) throw new Error('上午任务仍有 ' + progress.failed + ' 项失败');
        L('14 项来源写入完成，生成/核对正式采购表...', 'i');
        return syncToProcurement({incrementalPlatform:''});
      }).then(function(procurement) {
        if (procurement && procurement.ok === false) throw new Error('采购表同步未完整完成');
        return {status:status, procurement:procurement || {}};
      });
    }).then(function(result) {
      return autoLoadConfig().then(function(config) {
        if (!config.notifyMorning) return null;
        return autoNotify('✅ 上午 14 项备货单完成', [
          '成功 ' + ((result.status.progress && result.status.progress.done) || 14) + '/14',
          '正式采购表新增 ' + (result.procurement.created || 0)
            + '，更新 ' + (result.procurement.updated || 0),
          '附件继续在后台队列补齐'
        ], 'green');
      }).catch(function(error) {
        L('群通知失败: ' + error.message, 'w');
      }).then(function() {
        endTask('automationRunMorning', true, '14 个平台已抓取并同步采购表');
        return {ok:true, result:result};
      });
    }).catch(function(error) {
      L('早晨自动化失败: ' + error.message, 'e');
      autoNotify('❌ 上午自动化失败', [
        error.message,
        '请打开插件查看失败平台后重试'
      ], 'red').catch(function() {});
      endTask('automationRunMorning', false, error.message);
      return {ok:false, error:error.message};
    });
  }

  function autoDryRun() {
    L('=== 自动化只读演练（完整版） ===', 's');
    try { var _mv = chrome.runtime.getManifest(); L('插件版本: ' + (_mv ? _mv.version : '未知'), 'i'); } catch(e) {}
    L('验证筛选控件可操作，不生成备货单，不写入飞书', 'i');
    if (_activeTaskId) {
      L('当前有任务正在执行，无法演练', 'e');
      return Promise.resolve({ok:false, busy:true});
    }
    var planned = buildScheduleQueue();
    var uniqueIds = {};
    planned.forEach(function(task) {
      uniqueIds[task.businessDate + ':morning:' + task.accountTail + ':' + task.platform] = 1;
    });
    L('计划任务: ' + planned.length + '，唯一键: ' + Object.keys(uniqueIds).length, 'i');
    if (planned.length !== 14 || Object.keys(uniqueIds).length !== 14) {
      L('任务数量异常，演练未通过', 'e');
      return Promise.resolve({ok:false, reason:'invalid_task_count'});
    }

    // Check all account tabs (v20.12.18: lenient — reuse any dgjapp tab as fallback)
    return new Promise(function(resolve) {
      chrome.tabs.query({url:'*://*.dgjapp.com/*'}, function(tabs) {
        var dgjTabs = tabs || [];
        var accounts = ['5820','7205','7207'].map(function(tail) {
          var profile = autoAccountProfile(tail);
          var found = dgjTabs.some(function(tab) {
            return tab.url && tab.url.indexOf(profile.token) >= 0;
          });
          var fallback = !found && dgjTabs.length > 0;
          var status = found ? '✓' : (fallback ? '↺' : '✗');
          var msg = found ? ' 已登录并打开' : (fallback ? ' 将复用现有tab导航' : ' 无可用tab');
          L(status + ' ' + profile.name + '-【' + tail + '】' + msg, found ? 'ok' : (fallback ? 'w' : 'e'));
          return {tail:tail, found:found || fallback};
        });
        if (dgjTabs.length === 0) {
          L('未找到任何店管家页面，请先打开至少一个店管家', 'e');
          resolve({ok:false, reason:'no_dgj_tabs'});
          return;
        }
        if (!accounts.every(function(a) { return a.found; })) {
          L('演练未通过：部分账号无法访问', 'e');
          resolve({ok:false, reason:'missing_accounts'});
          return;
        }

        // Execute rehearsal for each platform sequentially
        L('', 'i');
        L('开始逐平台筛选验证...', 's');
        var results = [];
        var index = 0;
        function nextTask() {
          if (index >= planned.length) {
            // All done
            var passed = results.filter(function(r) { return r.ok; }).length;
            var failed = results.filter(function(r) { return !r.ok; });
            L('', 'i');
            L('=== 演练结果 ===', 's');
            L('通过: ' + passed + '/' + planned.length, passed === planned.length ? 'ok' : 'w');
            if (failed.length > 0) {
              L('失败: ' + failed.map(function(r) { return r.task + ' (' + r.error + ')'; }).join(', '), 'e');
            }
            var ok = passed === planned.length;
            L(ok ? '=== 演练通过 ===' : '=== 演练未通过 ===', ok ? 'ok' : 'e');
            resolve({ok:ok, passed:passed, failed:failed.length, results:results});
            return;
          }
          var task = planned[index];
          var taskLabel = task.accountName + '-【' + task.accountTail + '】' + task.platform;
          L('[' + (index+1) + '/' + planned.length + '] 验证: ' + taskLabel, 'i');

          autoPrepareCommandPage({
            accountTail: task.accountTail,
            platform: task.platform
          }, 'rehearsal').then(function(result) {
            L('  ✓ ' + taskLabel + ' 筛选控件验证通过', 'ok');
            results.push({task:taskLabel, ok:true});
            index++;
            setTimeout(nextTask, 2000); // Delay between tasks - wait for page refresh
          }).catch(function(error) {
            L('  ✗ ' + taskLabel + ' 失败: ' + error.message, 'e');
            results.push({task:taskLabel, ok:false, error:error.message});
            index++;
            setTimeout(nextTask, 800);
          });
        }
        nextTask();
      });
    });
  }

  function autoRenderStatus() {
    return Promise.all([autoLoadConfig(), autoMessage({type:'getAutomationStatus'})]).then(function(results) {
      var config = results[0], status = results[1] || {};
      var timeInput = document.getElementById('alarmTime');
      var morningToggle = document.getElementById('alarmToggle');
      var pollToggle = document.getElementById('commandPollToggle');
      var webhookInput = document.getElementById('automationWebhook');
      var queueIdInput = document.getElementById('automationQueueTableId');
      if (timeInput) timeInput.value = config.morningTime || '08:10';
      if (morningToggle) morningToggle.checked = !!config.morningEnabled;
      if (pollToggle) pollToggle.checked = !!config.commandPollingEnabled;
      if (webhookInput) webhookInput.value = config.webhookUrl || '';
      if (queueIdInput) queueIdInput.value = config.queueTableId || '';
      var state = document.getElementById('automationState');
      if (state) {
        state.textContent = config.morningEnabled
          ? '上午 ' + config.morningTime + ' · 下午每分钟监听'
          : '自动化未启用';
        state.className = 'auto-state ' + (config.morningEnabled ? 'on' : 'off');
      }
      var nextRun = document.getElementById('automationNextRun');
      if (nextRun) nextRun.textContent = status.nextMorningAt
        ? new Date(status.nextMorningAt).toLocaleString('zh-CN', {hour12:false})
        : '尚未排程';
      if (!config.queueTableId) return {config:config, status:status};
      return getBitableAppToken().then(function(appToken) {
        return fetchAllRecordsFromTable(appToken, config.queueTableId);
      }).then(function(records) {
        var today = autoToday();
        var rows = records.filter(function(record) {
          return sv((record.fields || {})['业务日期']) === today;
        });
        var completed = rows.filter(function(record) {
          var fields = record.fields || {};
          return (sv(fields['执行状态']) || sv(fields['状态'])) === '已完成';
        }).length;
        var checked = rows.filter(function(record) {
          return (record.fields || {})['打单已完成'] === true;
        }).length;
        var progress = document.getElementById('automationDailyProgress');
        if (progress) progress.textContent = completed + '/14 已完成 · ' + checked + ' 个已勾选';
        return {config:config, status:status, daily:{rows:rows.length, completed:completed, checked:checked}};
      }).catch(function() {
        var progress = document.getElementById('automationDailyProgress');
        if (progress) progress.textContent = '控制台暂不可读';
        return {config:config, status:status};
      });
    });
  }

  function autoBindUi() {
    var saveButton = document.getElementById('saveAutomation');
    var initButton = document.getElementById('initAutomationQueue');
    var openQueueButton = document.getElementById('openAutomationQueue');
    var testButton = document.getElementById('testAutomationWebhook');
    var dryRunButton = document.getElementById('automationDryRun');
    var morningButton = document.getElementById('automationRunMorning');
    var pollButton = document.getElementById('automationPollNow');
    var ensureTodayButton = document.getElementById('automationEnsureToday');
    if (saveButton) saveButton.addEventListener('click', function() {
      console.log('[DGJ-CONFIG] Save button clicked');
      var webhook = String(document.getElementById('automationWebhook').value || '').trim();
      console.log('[DGJ-CONFIG] Webhook from UI:', webhook ? webhook.substring(0,20)+'...' : '(empty)');
      var queueId = String(document.getElementById('automationQueueTableId').value || '').trim();
      console.log('[DGJ-CONFIG] QueueTableId from UI:', queueId);
      if (webhook && !autoValidWebhook(webhook)) {
        L('Webhook 地址格式不正确，未保存', 'e');
        return;
      }
      autoLoadConfig().then(function(config) {
        config.morningEnabled = !!document.getElementById('alarmToggle').checked;
        config.morningTime = document.getElementById('alarmTime').value || '08:10';
        config.commandPollingEnabled = !!document.getElementById('commandPollToggle').checked;
        config.webhookUrl = webhook;
        config.queueTableId = queueId;
        console.log('[DGJ-CONFIG] Config to save:', JSON.stringify(config));
        return autoSaveConfig(config);
      }).then(function(savedConfig) {
        console.log('[DGJ-CONFIG] Save success, config:', JSON.stringify(savedConfig));
        L('自动化配置已保存并重新排程', 'ok');
        return autoRenderStatus();
      }).catch(function(error) {
        console.error('[DGJ-CONFIG] Save FAILED:', error);
        L('保存自动化失败: ' + error.message, 'e');
      });
    });
    if (initButton) initButton.addEventListener('click', function() {
      initButton.disabled = true;
      initButton.textContent = '初始化中...';
      ensureAutomationQueueTable().then(function(result) {
        L((result.created ? '已创建' : '已找到') + '飞书每日控制台: ' + result.tableId, 'ok');
        L('控制台字段新增: ' + (result.fieldsCreated || 0) + ' 个', 'i');
        return autoEnsureTodayRows();
      }).then(function(result) {
        L('今日13项就绪：新增 ' + result.created + '，已存在 ' + result.existing, 'ok');
        return autoRenderStatus();
      }).catch(function(error) {
        L('初始化任务表失败: ' + error.message, 'e');
      }).finally(function() {
        initButton.disabled = false;
        initButton.textContent = '升级每日控制台';
      });
    });
    if (ensureTodayButton) ensureTodayButton.addEventListener('click', function() {
      ensureTodayButton.disabled = true;
      autoEnsureTodayRows().then(function(result) {
        L('今日13项已补齐：新增 ' + result.created + '，已存在 ' + result.existing, 'ok');
        return autoRenderStatus();
      }).catch(function(error) {
        L('生成今日13项失败: ' + error.message, 'e');
      }).finally(function() {
        ensureTodayButton.disabled = false;
      });
    });
    if (openQueueButton) openQueueButton.addEventListener('click', function() {
      autoLoadConfig().then(function(config) {
        var tableId = String(config.queueTableId || DEFAULT_AUTO_CONFIG.queueTableId || '').trim();
        if (!tableId) throw new Error('请先初始化任务表或填写任务表 ID');
        return chrome.tabs.create({
          url: FEISHU_URL + '?table=' + encodeURIComponent(tableId)
        });
      }).catch(function(error) {
        L('打开飞书指令表失败: ' + error.message, 'e');
      });
    });
    if (testButton) testButton.addEventListener('click', function() {
      autoLoadConfig().then(function(config) {
        config.webhookUrl = String(document.getElementById('automationWebhook').value || '').trim();
        if (!autoValidWebhook(config.webhookUrl)) throw new Error('请先填写正确的飞书群 Webhook');
        return autoSaveConfig(config);
      }).then(function() {
        return autoNotify('🧪 采购自动化连接测试', [
          '群通知发送正常',
          '上午定时与下午指令将回执到本群'
        ], 'blue');
      }).then(function() { L('飞书群通知测试成功', 'ok'); })
        .catch(function(error) { L(error.message, 'e'); });
    });
    if (dryRunButton) dryRunButton.addEventListener('click', autoDryRun);
    if (morningButton) morningButton.addEventListener('click', function() {
      runMorningAutomation({retryFailed:true});
    });
    if (pollButton) pollButton.addEventListener('click', function() {
      pollAutomationQueue({force:true}).then(function(result) {
        L('勾选任务检查结果: ' + JSON.stringify(result), result.ok ? 'ok' : 'w');
        return autoRenderStatus();
      });
    });
    autoRenderStatus().catch(function(error) {
      L('读取自动化状态失败: ' + error.message, 'w');
    });
  }

  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    var isAutomationWorker = new URLSearchParams(location.search).has('automation');
    if (!isAutomationWorker) return false;
    if (message.type === 'automationMorningFired') {
      runMorningAutomation({forceNew:false}).then(sendResponse);
      return true;
    }
    if (message.type === 'automationPoll') {
      pollAutomationQueue({force:false}).then(sendResponse);
      return true;
    }
    if (message.type === 'automationBootstrap') {
      autoEnsureTodayRows().then(sendResponse).catch(function(error) {
        sendResponse({ok:false, error:error.message});
      });
      return true;
    }
  });

  autoBindUi();
  if (new URLSearchParams(location.search).has('automation')) {
    setTimeout(function() {
      autoEnsureTodayRows().catch(function() {}).then(function() {
        return pollAutomationQueue({force:false});
      });
    }, 900);
  }
})();
