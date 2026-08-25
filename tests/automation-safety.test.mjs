import assert from 'node:assert/strict';
import fs from 'node:fs';

const automation = fs.readFileSync(new URL('../automation.js', import.meta.url), 'utf8');
const sidepanel = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');
const background = fs.readFileSync(new URL('../background.js', import.meta.url), 'utf8');
const panel = fs.readFileSync(new URL('../panel.html', import.meta.url), 'utf8');
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));

assert.equal(manifest.version, '21.0.75');
assert.match(panel, /<script src="automation\.js"><\/script>/);
assert.match(panel, /id="automationRunMorning"/);
assert.match(panel, /id="automationDryRun"/);
assert.match(panel, /id="commandPollToggle"/);
assert.match(panel, /id="automationWebhook"/);
assert.match(panel, /id="automationQueueTableId"/);
assert.match(panel, /id="automationEnsureToday"/);
assert.match(panel, /id="automationDailyProgress"/);

assert.match(sidepanel, /jobId: businessDate \+ ':morning:' \+ acct\.tail \+ ':' \+ plat/);
assert.match(sidepanel, /今日 19 项没有待执行任务，不会重复抓取/);
assert.match(sidepanel, /task\.status === 'running'\) \{\s*task\.status = 'pending'/);
assert.match(sidepanel, /task\.retries = \(task\.retries \|\| 0\) \+ 1/);
assert.match(sidepanel, /附件进入后台队列:/);
assert.doesNotMatch(
  sidepanel,
  /return downloadImages\(imgItems,[\s\S]{0,160}return count/,
  'morning attachment uploads must not block the next platform'
);

assert.match(automation, /var AUTO_MAX_COMMAND_RETRIES = 2/);
assert.match(automation, /queueTableId:'tblLpoliA366EPmS'/);
assert.match(automation, /AUTO_QUEUE_TABLE_NAME = '自动化任务队列'/);
assert.match(automation, /\{field_name:'打单已完成', type:7\}/);
assert.match(automation, /\{field_name:'仅演练不回传', type:7\}/);
assert.match(automation, /\{field_name:'执行状态', type:3/);
assert.match(automation, /today \+ ':return:' \+ task\.accountTail \+ ':' \+ task\.platform/);
assert.match(automation, /command\.checked && \(command\.status === '未打单'/);
assert.match(automation, /command\.retryRequested && command\.status === '失败·待重试'/);
assert.match(automation, /command\.checked && command\.status === '失败·待重试'/);
assert.match(automation, /'打单已完成':false,\s*'重试请求':false,\s*'完成时间':autoNowText\(\)/);
assert.match(automation, /autoEnsureTodayRows\(\)/);
assert.match(automation, /if \(command\.dryRun\)/);
assert.match(automation, /安全演练通过：筛选控件已验证，未生成备货单，未写中转站或采购表/);
assert.match(automation, /autoPrepareCommandPage\(command, 'rehearsal'\)/);
assert.match(automation, /if \(mode === 'rehearsal'\)/);
assert.match(automation, /autoWithAutomationLease\('queue'/);
assert.match(automation, /autoWithAutomationLease\('morning'/);
assert.match(automation, /records\/search\?page_size=100/);
assert.match(automation, /client_token=/);
assert.match(automation, /今日自动化任务存在重复唯一键，已停止执行/);
assert.match(automation, /Array\.from\(new Set\(duplicateIds\)\)/);
assert.match(automation, /\{field_name:'附件状态', type:3/);
assert.match(automation, /\{field_name:'附件失败数', type:2\}/);
assert.match(automation, /'附件状态':attachmentFailed \? '待补图片' : '已完成'/);
assert.match(automation, /'附件失败数':attachmentFailed/);
assert.doesNotMatch(
  automation.slice(
    automation.indexOf('function autoEnsureTodayRows'),
    automation.indexOf('function autoUpdateQueueRecord')
  ),
  /fetchAllRecordsFromTable/,
  'daily console must use a filtered search instead of a full-table scan'
);
assert.doesNotMatch(
  automation.slice(
    automation.indexOf('if (command.dryRun)'),
    automation.indexOf('if (completed[command.id])')
  ),
  /autoRunAfternoonCommand|syncToProcurement|autoRememberCompleted/,
  'dry-run branch must not execute return, procurement sync, or completion lock'
);
assert.match(automation, /command\.accountTail === '5820' && command\.platform !== '微信小店'/);
assert.match(automation, /completed\[command\.id\]/);
assert.match(automation, /'状态':'重复忽略'/);
assert.match(automation, /_forcedReturnExpectedPlatform = target\.expectedPlatform/);
assert.match(sidepanel, /与任务平台 .* 不一致/);
assert.match(automation, /\['下单时间','付款时间','发货时间'\], \['发货时间'\], 'ship_time_basis'/);
assert.match(automation, /\['今天','今日'\], 'ship_today'/);
assert.match(automation, /\['已付款','已付款\+已发货'\], \['已付款\+已发货','已付款＋已发货'\], 'paid_shipped'/);
assert.match(automation, /\['下单时间','付款时间','发货时间'\], \['下单时间'\], 'morning_time_basis'/);
assert.match(automation, /\['近3天','最近3天'\], 'morning_date_range'/);
assert.match(automation, /syncToProcurement\(\{incrementalPlatform:''\}\)/);

assert.match(background, /alarm\.name === 'dgj-automation-morning'/);
assert.match(background, /alarm\.name === 'dgj-automation-poll'/);
assert.match(background, /alarm\.name === 'dgj-automation-daily-console'/);
assert.match(background, /msg\.type === 'acquireAutomationLease'/);
assert.match(background, /msg\.type === 'releaseAutomationLease'/);
assert.match(background, /AUTOMATION_LEASE_KEY/);
assert.match(background, /expiresAt:nowLease \+ 4 \* 60 \* 60 \* 1000/);
assert.match(background, /chrome\.storage\.local\.remove\(AUTOMATION_LEASE_KEY/);
assert.match(background, /morningEnabled:false/);
assert.match(background, /commandPollingEnabled:false/);
assert.match(background, /requiredTokens/);
assert.match(background, /periodInMinutes:24 \* 60/);
assert.match(background, /periodInMinutes:1/);
assert.match(background, /Never reload the durable worker page/);
const automationLauncher = background.slice(
  background.indexOf('function launchAutomationPanel'),
  background.indexOf('function launchAlarmScheduler')
);
assert.doesNotMatch(
  automationLauncher,
  /if \(panelTabs && panelTabs\.length\) \{\s*chrome\.tabs\.reload/,
  'polling must never reload an active automation worker'
);
assert.match(background, /chrome\.alarms\.clear\('autoScrape'/);
assert.doesNotMatch(sidepanel, /if \(!targetTab\) targetTab = tabs\[0\]/);
assert.match(sidepanel, /no_dgj_tab:/);
assert.match(sidepanel, /options\.retryFailed && task\.status === 'failed'/);
assert.match(automation, /runMorningAutomation\(\{retryFailed:true\}\)/);

console.log('automation-safety.test: PASS');
