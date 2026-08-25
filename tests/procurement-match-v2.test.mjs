import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// ============================================================
// 采购表匹配决策树 V2 测试
// ============================================================
// 测试表ID（不直接写入，在mock中使用）
// 采购表副本: tblIhCczaXadtPgS
// 中转站副本: tblxtqyzCECY2L2E

// 模拟 canonicalProcurementTitleKey（去除[拆分]后缀后规范化）
function canonicalProcurementTitleKey(title) {
  var raw = String(title || '').trim()
    .replace(/(?:\[\s*拆分\s*\]|【\s*拆分\s*】)\s*$/i, '')
    .trim();
  return raw.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

// 模拟 procurementTitleIdentityExact
function procurementTitleIdentityExact(a, b) {
  var ka = canonicalProcurementTitleKey(a);
  var kb = canonicalProcurementTitleKey(b);
  return !!ka && ka.length >= 8 && ka === kb;
}

// 模拟产品族冲突检查（简化版）
function procurementFamilyConflict(source, target) {
  // 简化：如果标题中核心名词不同则冲突
  return false; // 测试中单独控制
}

// ============================================================
// 核心匹配函数（新方案）
// ============================================================
function matchRecordForUpdate(source, target, options) {
  options = options || {};
  var familyConflict = options.familyConflict || false;
  
  // Step 1: 规范化标题完全相同 → 直接更新
  if (procurementTitleIdentityExact(source.title, target.title)) {
    return { match: true, method: 'CANONICAL_TITLE', confidence: 1.0 };
  }
  
  // Step 2: PID相同 + 无产品族冲突 → 更新
  if (source.pid && target.pid) {
    var sourcePids = String(source.pid).split(/[\n,]/).map(function(p) { return p.trim(); }).filter(Boolean);
    var targetPids = String(target.pid).split(/[\n,]/).map(function(p) { return p.trim(); }).filter(Boolean);
    var pidMatch = sourcePids.some(function(sp) {
      return targetPids.some(function(tp) { return sp === tp; });
    });
    if (pidMatch && !familyConflict) {
      return { match: true, method: 'PID', confidence: 1.0 };
    }
  }
  
  // Step 3: 不确定 → 不匹配
  return { match: false, method: 'NONE', confidence: 0 };
}

// ============================================================
// 测试用例
// ============================================================

describe('采购表匹配决策树V2', function() {

  // --- Case 1: 5820 彩灯 - PID变化但标题相同 ---
  it('5820电动车彩灯: PID变化但标题完全相同时应更新', function() {
    var source = {
      title: '【好物推荐】电动车震动感应彩灯防追尾',
      pid: '10001265320970100012',  // 新PID
      spec: '升级材质/震动感应灯【5个装】;46',
      platform: '微信小店-【5820】'
    };
    var target = {
      title: '【好物推荐】电动车震动感应彩灯防追尾',
      pid: '10001239322198100012\n10001234572732100012',  // 旧PID
      spec: '5个装【震动感应彩灯】;564',
      platform: '微信小店-【5820】',
      status: '已打单'
    };
    var result = matchRecordForUpdate(source, target);
    assert.equal(result.match, true, '应该匹配更新');
    assert.equal(result.method, 'CANONICAL_TITLE');
  });

  // --- Case 2: 收纳袋 - [拆分]后缀 ---
  it('收纳袋[拆分]: 标题规范化后应匹配主记录', function() {
    var source = {
      title: '【出行好物】二合一便携防水收纳袋可悬挂大容量运动鞋拖鞋家用外用分装袋 [拆分]',
      pid: '10035696875956',
      spec: '二合一防水鞋袋【高级灰-1个装】;239',
      platform: '微信小店-【5820】'
    };
    var target = {
      title: '【出行好物】二合一便携防水收纳袋可悬挂大容量运动鞋拖鞋家用外用分装袋',
      pid: '10035696875956',
      spec: '二合一防水鞋袋【高级灰-1个装】;238',
      platform: '微信小店-【5820】',
      status: '已打单'
    };
    var result = matchRecordForUpdate(source, target);
    assert.equal(result.match, true, '[拆分]标题应匹配主记录');
    assert.equal(result.method, 'CANONICAL_TITLE');
  });

  // --- Case 3: 不同产品不应匹配 ---
  it('不同产品不应匹配', function() {
    var source = {
      title: '硅胶握力器腕力臂肌训练',
      pid: '12345',
      spec: '握力器;10',
      platform: '微信小店-【5820】'
    };
    var target = {
      title: '电动车震动感应彩灯防追尾',
      pid: '67890',
      spec: '彩灯;5',
      platform: '微信小店-【5820】',
      status: '未打单'
    };
    var result = matchRecordForUpdate(source, target);
    assert.equal(result.match, false, '不同产品不应匹配');
  });

  // --- Case 4: 同PID但产品族冲突 ---
  it('同PID但产品族冲突时不应匹配', function() {
    var source = {
      title: '硅胶握力器',
      pid: '12345',
      spec: '握力器;10',
      platform: '微信小店-【5820】'
    };
    var target = {
      title: '存单收纳本',
      pid: '12345',  // 同PID但不同产品
      spec: '收纳本;5',
      platform: '微信小店-【5820】',
      status: '未打单'
    };
    var result = matchRecordForUpdate(source, target, { familyConflict: true });
    assert.equal(result.match, false, '产品族冲突不应匹配');
  });

  // --- Case 5: 跨平台不应匹配 ---
  it('不同平台不应通过标题匹配', function() {
    // 这个测试验证平台过滤在外层完成
    var source = {
      title: '电动车震动感应彩灯防追尾',
      pid: '10001265320970100012',
      platform: '微信小店-【5820】'
    };
    var target = {
      title: '电动车震动感应彩灯防追尾',
      pid: '10001265320970100012',
      platform: '淘宝-【7207】',  // 不同平台
      status: '已打单'
    };
    // 平台过滤在外层，这里只测试匹配函数本身会匹配
    // 实际使用时外层会先过滤平台
    var result = matchRecordForUpdate(source, target);
    assert.equal(result.match, true, '匹配函数本身不检查平台（外层负责）');
  });

  // --- Case 6: 已打单状态不能被降级 ---
  it('已打单状态不能被未打单降级', function() {
    var existingStatus = '已打单';
    var incomingStatus = '未打单';
    var finalStatus = (existingStatus === '已打单' || incomingStatus === '已打单')
      ? '已打单' : (existingStatus || incomingStatus || '未打单');
    assert.equal(finalStatus, '已打单', '状态不能降级');
  });

  // --- Case 7: 空标题不应匹配 ---
  it('空标题且PID不同时不应匹配', function() {
    var source = { title: '', pid: '11111', platform: '微信小店-【5820】' };
    var target = { title: '电动车彩灯', pid: '22222', platform: '微信小店-【5820】' };
    var result = matchRecordForUpdate(source, target);
    assert.equal(result.match, false, '空标题且PID不同不应匹配');
  });
  it('空标题但PID相同时应通过PID匹配', function() {
    var source = { title: '', pid: '12345', platform: '微信小店-【5820】' };
    var target = { title: '电动车彩灯', pid: '12345', platform: '微信小店-【5820】' };
    var result = matchRecordForUpdate(source, target);
    assert.equal(result.match, true, 'PID相同应匹配');
    assert.equal(result.method, 'PID');
  });

  // --- Case 8: 标题带营销前缀 ---
  it('标题带不同营销前缀但核心相同应匹配', function() {
    var source = {
      title: '【抢！】电动车震动感应彩灯防追尾',
      pid: '99999',
      platform: '微信小店-【5820】'
    };
    var target = {
      title: '【好物推荐】电动车震动感应彩灯防追尾',
      pid: '88888',
      platform: '微信小店-【5820】',
      status: '已打单'
    };
    // canonicalProcurementTitleKey 只去[拆分]，不去营销前缀
    // 所以这两个标题规范化后不同
    var result = matchRecordForUpdate(source, target);
    // 这种情况需要PID匹配或模糊匹配
    assert.equal(result.match, false, '不同营销前缀需要PID或模糊匹配');
  });

  // --- Case 9: 同PID不同标题（真实场景：PID包含多个值） ---
  it('PID包含换行分隔的多个值时应正确匹配', function() {
    var source = {
      title: '收纳袋',
      pid: '10035696875956',
      platform: '微信小店-【5820】'
    };
    var target = {
      title: '收纳袋',
      pid: '10035696875956\n10035696875957\n10035696875958',
      platform: '微信小店-【5820】',
      status: '已打单'
    };
    var result = matchRecordForUpdate(source, target);
    assert.equal(result.match, true, '换行分隔PID应匹配');
  });

  // --- Case 10: 状态升级逻辑 ---
  it('未打单+已打单=已打单', function() {
    var cases = [
      ['未打单', '已打单', '已打单'],
      ['已打单', '未打单', '已打单'],
      ['已打单', '已打单', '已打单'],
      ['未打单', '未打单', '未打单'],
      ['', '已打单', '已打单'],
      ['未打单', '', '未打单'],
    ];
    cases.forEach(function(c) {
      var final = (c[0] === '已打单' || c[1] === '已打单') ? '已打单' : (c[0] || c[1] || '未打单');
      assert.equal(final, c[2], c[0] + '+' + c[1] + ' should be ' + c[2]);
    });
  });
});
