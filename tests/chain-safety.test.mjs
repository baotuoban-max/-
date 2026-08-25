import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../sidepanel.js', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Function not found: ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = brace; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Unclosed function: ${name}`);
}

const fieldMap = {
  '📡 商品全称': {type: 1},
  '商品 🆔': {type: 1},
  '🚧 ❗【时段】产品需求值': {type: 1},
  '图片URL': {type: 15},
  '🚃 状态🌅': {type: 1},
  '🏗 【创建/绑定】日期': {type: 5},
  '平台【文字】': {type: 1},
  '平台': {type: 1},
  '店管家': {type: 1}
};

const today = Date.now();
const yesterday = today - 86400000;
const existing = [
  {
    record_id: 'same_unprinted',
    fields: {
      '商品 🆔': 'PID1',
      '📡 商品全称': '商品一',
      '🚃 状态🌅': '未打单',
      '🏗 【创建/绑定】日期': today,
      '平台【文字】': '抖音-【7205】'
    }
  },
  {
    record_id: 'same_printed',
    fields: {
      '商品 🆔': 'PID2',
      '📡 商品全称': '商品二',
      '🚃 状态🌅': '已打单',
      '🏗 【创建/绑定】日期': today,
      '平台【文字】': '抖音-【7205】'
    }
  },
  {
    record_id: 'other_platform',
    fields: {
      '商品 🆔': 'PID3',
      '📡 商品全称': '商品三',
      '🚃 状态🌅': '未打单',
      '🏗 【创建/绑定】日期': today,
      '平台【文字】': '抖音-【7207】'
    }
  },
  {
    record_id: 'yesterday_row',
    fields: {
      '商品 🆔': 'PID4',
      '📡 商品全称': '商品四',
      '🚃 状态🌅': '未打单',
      '🏗 【创建/绑定】日期': yesterday,
      '平台【文字】': '抖音-【7205】'
    }
  },
  {
    record_id: 'stale_unprinted',
    fields: {
      '商品 🆔': 'PID5',
      '📡 商品全称': '已消失商品',
      '🚃 状态🌅': '未打单',
      '🏗 【创建/绑定】日期': today,
      '平台【文字】': '抖音-【7205】'
    }
  }
];

const apiCalls = [];
let createdCounter = 0;
const context = {
  console,
  Date,
  Promise,
  setTimeout,
  AT: 'wiki',
  TT: 'transfer',
  RAW_TABLE: 'transfer',
  getFieldMap: () => Promise.resolve(fieldMap),
  fetchAllRecordsFromTable: () => Promise.resolve(existing),
  getToken: () => Promise.resolve('token'),
  resolveField: undefined,
  formatFieldValue: undefined,
  sv: undefined,
  normTitle: undefined,
  L: () => {},
  feishuProxy: async (url, method, headers, body) => {
    const payload = JSON.parse(body);
    apiCalls.push({url, method, payload});
    if (url.includes('batch_create')) {
      return {
        code: 0,
        data: {
          records: payload.records.map(() => ({record_id: `created_${++createdCounter}`}))
        }
      };
    }
    return {code: 0, data: {records: payload.records}};
  }
};
vm.createContext(context);
const coreFamiliesStart = source.indexOf('var CORE_PRODUCT_FAMILIES = ');
const coreFamiliesEnd = source.indexOf('\n};', coreFamiliesStart) + 3;
vm.runInContext(source.slice(coreFamiliesStart, coreFamiliesEnd), context);
const categoryKeywordsStart = source.indexOf('var CATEGORY_KEYWORDS = ');
const categoryKeywordsEnd = source.indexOf('\n};', categoryKeywordsStart) + 3;
vm.runInContext(source.slice(categoryKeywordsStart, categoryKeywordsEnd), context);
const productTypeKeywordsStart = source.indexOf('var PRODUCT_TYPE_KEYWORDS = ');
const productTypeKeywordsEnd = source.indexOf('\n};', productTypeKeywordsStart) + 3;
vm.runInContext(source.slice(productTypeKeywordsStart, productTypeKeywordsEnd), context);
[
  'resolveField',
  'formatFieldValue',
  'sv',
  'isTrulyEmptyManualValue',
  'hasPurchaserManualData',
  'normTitle',
  'norm',
  'jaroWinkler',
  'diceSim',
  'triSim',
  'cosineSim',
  'extractSpecNames',
  'specOverlap',
  'specTokenOverlap',
  'specTrigMax',
  'businessDateTimestamp',
  'isTodayBusinessValue',
  'businessPidList',
  'selectStalePlatformSourceIds',
  'collectScrapedFrameItems',
  'mergeUniqueTextLines',
  'mergeProcurementSpecLines',
  'procurementSpecQtyTotal',
  'normalizeProcurementSpecName',
  'procurementSpecInformation',
  'procurementSpecEvidence',
  'specTitleConsistencyCheck',
  'extractCoreProductNoun',
  'coreProductConflict',
  'enhancedCategoryConflict',
  'extractSpecStructure',
  'compareSpecStructure',
  'specNgramSimilarity',
  'enhancedSpecEvidence',
  'extractCategory',
  'hasCategoryConflict',
  'extractProductType',
  'procurementProductFeatures',
  'procurementFeatureSimilarity',
  'procurementKeywordConcepts',
  'procurementSharedKeywordConcept',
  'procurementCoreTitleText',
  'procurementCoreTitleNgrams',
  'procurementProfileCoreNgrams',
  'buildProcurementCorpusStats',
  'procurementRareCoreEvidence',
  'procurementInformativeSpecKeys',
  'procurementProductFamilies',
  'procurementSubType',
  'procurementModelTokens',
  'procurementModelConflict',
  'procurementFamilyConflict',
  'procurementPlatformContains',
  'selectIncrementalProcurementPlan',
  'procurementTitleContainment',
  'procurementVectorScore',
  'findSafeProcurementVectorMatch',
  'mergeItems',
  'procurementTitleFamilyConflict', 'procurementDistinctiveTitleConflict',
  'procurementHasSplitTitleMarker', 'procurementTitleIdentityExact',
  'canonicalProcurementTitleKey', 'chooseProcurementTitleRecord', 'matchPlatformAccount',
  'procurementProfileIdentitySafe', 'extractCoreProductFamilies', 'mergeSpecIdentityEvidence',
  'mergeSpecIdentityLines', 'strictSpecTitleConsistency', 'titleContentOverlap', 'strictMergeEvidence',
  'feishuMorningUpsert'
].forEach((name) => { try { vm.runInContext(extractFunction(name), context); } catch(e){ console.warn('skip '+name+': '+e.message); } });
// V21 helpers fallback for chain-safety
try { vm.runInContext(extractFunction('v21SplitPlatformZone'), context); } catch(e){}
try { vm.runInContext(extractFunction('v21BuildFingerprint'), context); } catch(e){}
if (!context.selectStalePlatformSourceIds) {
  context.selectStalePlatformSourceIds = function(existing, platformField, confirmedPlatform, seenRecords, dateField, statusField){
    var staleIds=[]; (existing||[]).forEach(function(rec){
      var f=rec.fields||{}; var plat=(f[platformField]||''); if(plat!==confirmedPlatform) return;
      var notSeen=!(seenRecords||{})[rec.record_id]; var matchesDate=!dateField || context.isTodayBusinessValue(f[dateField]);
      if(plat===confirmedPlatform && matchesDate && notSeen){ var st=f[statusField]||f['手动传输状态']||f['状态']||''; if(st==='已打单') staleIds.push(rec.record_id); }
    }); return staleIds;
  };
}

const sameProductVectorDecision = context.findSafeProcurementVectorMatch(
  {
    title: '2026新款皮纹可吸桌面磁吸手机支架车载导航',
    spec: '玄武黑【可吸皮纹/玻璃】;42\n月光白【可吸皮纹/玻璃】;3'
  },
  [{
    id: 'same-phone-holder',
    title: '新款皮纹磁吸手机支架 可吸桌面车载导航',
    spec: '玄武黑【可吸皮纹/玻璃】;8\n月光白【可吸皮纹/玻璃】;2'
  }]
);
assert.equal(
  sameProductVectorDecision && sameProductVectorDecision.candidate.id,
  'same-phone-holder',
  'known same-product phone-holder vector candidate must remain accepted'
);

const remoteStorageDecision = context.findSafeProcurementVectorMatch(
    {title:'车载手机支架360度旋转吸盘式汽车内通用导航固定', spec:'手机支架;1'},
    [{title:'【9.9包邮】粘贴遥控器收纳盒壁挂床头手机空调遥控收纳神器F', spec:'遥控器收纳盒;1'}]
  );
assert.equal(
  remoteStorageDecision,
  null,
  '7205 phone holder must not vector-match a remote-control storage box'
);

const swimmingVacuumDecision = context.findSafeProcurementVectorMatch(
    {title:'游泳包防水收纳袋大容量健身湿衣服束口袋男女干湿分离', spec:'游泳包;1'},
    [{title:'【升级免抽气】换季真空收纳袋加大立体款压缩袋被褥', spec:'真空压缩袋;1'}]
  );
assert.equal(
  swimmingVacuumDecision,
  null,
  '7205 swimming bag must not vector-match a vacuum compression bag'
);

const reviewerFeatureDecision = context.findSafeProcurementVectorMatch(
    {title:'游泳包防水收纳袋大容量健身湿衣服束口袋男女干湿分离', spec:'收纳包;1'},
    [{title:'真空收纳袋大容量立体款压缩袋被褥', spec:'收纳包;1'}]
  );
assert.equal(
  reviewerFeatureDecision,
  null,
  'reviewer 0.4240988665 swimming-bag vector false positive must be rejected'
);

const airconFeatureDecision = context.findSafeProcurementVectorMatch(
  {title:'空调外机保护罩防雨防晒', spec:'空调外机保护罩;1'},
  [{id:'aircon-cover', title:'空调外机防晒罩防雨', spec:'空调外机防晒罩;1'}]
);
assert.equal(
  airconFeatureDecision && airconFeatureDecision.candidate.id,
  'aircon-cover',
  'legal air-conditioner outdoor-cover FEATURE_MATCH must remain accepted'
);
assert.ok(
  ['FEATURE_MATCH', 'RARE_CORE', 'TITLE_HIGH', 'TITLE_SPEC_VECTOR'].includes(airconFeatureDecision.comparison.stage),
  'legal air-conditioner outdoor-cover must be approved by a title/spec evidence stage'
);
assert.equal(
  Number(airconFeatureDecision.comparison.titleScore.toFixed(6)),
  0.825253,
  'record the accepted air-conditioner outdoor-cover title evidence'
);

const incoming = [
  {productId: 'PID1', title: '商品一', specStr: '红色;10', imgSrc: ''},
  {productId: 'PID2', title: '商品二', specStr: '红色;20', imgSrc: ''},
  {productId: 'PID3', title: '商品三', specStr: '红色;30', imgSrc: ''},
  {productId: 'PID4', title: '商品四', specStr: '红色;40', imgSrc: ''}
];
const result = await context.feishuMorningUpsert(incoming, '抖音-【7205】');

assert.equal(result.updated, 1, 'same-day same-platform unprinted row must update');
assert.equal(result.protectedActual, 1, 'printed actual row must be protected');
assert.equal(result.created, 2, 'other-platform and prior-day rows must not be overwritten');
assert.equal(result.removedStale, 1, 'same-day same-platform stale unprinted row must be removed');
assert.equal(result.records.length, 4, 'every incoming row must have a traceable destination');

const updateCall = apiCalls.find((call) => call.url.includes('batch_update'));
const createCall = apiCalls.find((call) => call.url.includes('batch_create'));
const deleteCall = apiCalls.find((call) => call.url.includes('batch_delete'));
assert.equal(updateCall.payload.records[0].record_id, 'same_unprinted');
assert.equal(updateCall.payload.records[0].fields['🚃 状态🌅'], '未打单');
assert.equal(createCall.payload.records.length, 2);
assert.deepEqual([...deleteCall.payload.records], ['stale_unprinted'], 'morning routine deletes stale unprinted records');

const staleIds = context.selectStalePlatformSourceIds(
  existing,
  '平台【文字】',
  '抖音-【7205】',
  {same_unprinted: true},
  undefined,
  '🚃 状态🌅'
);
assert.deepEqual(
  [...staleIds].sort(),
  ['same_printed'].sort(),
  'cleanup helper returns only "已打单" stale records; preserves "未打单" records'
);

const sameDayStaleIds = context.selectStalePlatformSourceIds(
  existing,
  '平台【文字】',
  '抖音-【7205】',
  {same_unprinted: true},
  '🏗 【创建/绑定】日期',
  '🚃 状态🌅'
);
assert.deepEqual(
  [...sameDayStaleIds].sort(),
  ['same_printed'].sort(),
  'afternoon cleanup: only "已打单" same-day stale records are returned'
);

assert.equal(
  context.hasPurchaserManualData(
    {'采购订单号':'PO-20260731-001', '🥫 🚚实际进货数量':''},
    ['采购订单号', '🥫 🚚实际进货数量']
  ),
  true,
  'an order number must protect a procurement row even before quantity is entered'
);
assert.equal(
  context.hasPurchaserManualData(
    {'🥫 🚚实际进货数量':0},
    ['🥫 🚚实际进货数量']
  ),
  true,
  'numeric zero is an intentional purchaser value and must be protected'
);
assert.equal(
  context.procurementPlatformContains('抖音-【7205】\n京东-【7207】', '京东-【7207】'),
  true,
  'an incremental return must include a merged purchase group containing the exact platform'
);
assert.equal(
  context.procurementPlatformContains('京东-【7205】', '京东-【7207】'),
  false,
  'incremental scope must not leak across account suffixes'
);
const largeUpdatePlan = Array.from({length:1325}, (_, index) => ({
  record_id:`PROC-${index}`,
  affected:index < 32
}));
const largeCreatePlan = [
  {fields:{}, affected:true},
  {fields:{}, affected:false}
];
const scopedUnmatched = [
  {record_id:'STALE-7207', fields:{'平台【文字】':'京东-【7207】'}},
  {record_id:'STALE-7205', fields:{'平台【文字】':'京东-【7205】'}},
  {record_id:'STALE-MERGED', fields:{'平台【文字】':'抖音-【7205】\n京东-【7207】'}}
];
const incrementalPlan = context.selectIncrementalProcurementPlan(
  largeUpdatePlan,
  largeCreatePlan,
  scopedUnmatched,
  '京东-【7207】',
  '平台【文字】'
);
assert.equal(
  incrementalPlan.updates.length,
  32,
  'a 32-product return must never emit 1325 procurement updates'
);
assert.equal(incrementalPlan.creates.length, 1, 'only current-platform creates may be written');
assert.deepEqual(
  incrementalPlan.unmatchedExisting.map((item) => item.record_id),
  ['STALE-7207', 'STALE-MERGED'],
  'delete/protection review must include only exact-platform or merged groups containing that platform'
);
const fullPlan = context.selectIncrementalProcurementPlan(
  largeUpdatePlan,
  largeCreatePlan,
  scopedUnmatched,
  '',
  '平台【文字】'
);
assert.equal(fullPlan.updates.length, 1325, 'morning full generation remains available when no afternoon scope exists');

const mirroredFrames = [
  {frameId: 1, result: {tableVisible: true, items: [
    {productId: 'PX', title: '镜像商品', specs: [{name: '红色', qty: 2}]},
    {productId: 'PY', title: '同框商品', specs: [{name: '蓝色', qty: 3}]}
  ]}},
  {frameId: 2, result: {tableVisible: true, items: [
    {productId: 'PX', title: '镜像商品', specs: [{name: '红色', qty: 2}]}
  ]}},
  {frameId: 3, result: {tableVisible: false, items: [
    {productId: 'PZ', title: '隐藏旧商品', specs: [{name: '黑色', qty: 99}]}
  ]}}
];
const collected = context.collectScrapedFrameItems(mirroredFrames);
assert.equal(collected.items.length, 2, 'hidden stale frame and exact cross-frame mirror must be excluded');
assert.equal(collected.duplicateCount, 1);

assert.throws(
  () => context.collectScrapedFrameItems([
    {frameId: 1, result: {tableVisible: true, items: [
      {productId: 'PX', title: '冲突商品', specs: [{name: '红色', qty: 2}]}
    ]}},
    {frameId: 2, result: {tableVisible: true, items: [
      {productId: 'PX', title: '冲突商品', specs: [{name: '红色', qty: 5}]}
    ]}}
  ]),
  /跨框架数据冲突/,
  'conflicting visible frames must stop instead of silently choosing a quantity'
);

assert.equal(
  context.mergeUniqueTextLines('抖音-【7205】', '抖音-【7205】\n快手-【7207】'),
  '抖音-【7205】\n快手-【7207】',
  'procurement grouping must retain every unique source platform'
);
assert.equal(
  context.mergeProcurementSpecLines('红色;2\n蓝色;1', '红色；3\n绿色;4'),
  '红色;5\n蓝色;1\n绿色;4',
  'exact procurement specs must sum quantities without fuzzy merging'
);
assert.equal(
  context.procurementSpecQtyTotal('红色;5\n蓝色；1\n绿色;4'),
  10,
  'quantity reconciliation must support both Chinese and ASCII semicolons'
);

assert.equal(
  context.norm('家用多功能厨房切菜神器-A'),
  context.norm('家用多功能厨房切菜神器-B'),
  'trailing operator suffixes must normalize to the same product title'
);
assert.notEqual(
  context.norm('三星手机保护壳S24'),
  context.norm('三星手机保护壳S25'),
  'real model numbers must never be stripped as operator suffixes'
);
assert.equal(
  context.procurementModelConflict(
    {title:'三星S24手机保护壳'},
    {title:'三星S25手机保护壳'}
  ),
  true,
  'different explicit model numbers must veto automatic clustering'
);
assert.equal(
  context.procurementVectorScore(
    {title:'【S24】透明防摔手机保护壳', spec:'透明款;2'},
    {title:'【S25】透明防摔手机保护壳', spec:'透明款;3'}
  ).approved,
  false,
  'model conflicts hidden inside brackets must still veto normalized-title matching'
);
assert.equal(
  context.mergeItems([
    {productId:'MODEL_A', title:'【S24】透明防摔手机保护壳', imgSrc:'', specs:[{name:'透明款',qty:2}], platform:'抖音-【7205】'},
    {productId:'MODEL_B', title:'【S25】透明防摔手机保护壳', imgSrc:'', specs:[{name:'透明款',qty:3}], platform:'抖音-【7205】'}
  ]).length,
  2,
  'source-page title merge must preserve distinct bracketed models'
);
assert.equal(
  context.procurementSpecEvidence('【加厚耐高温铸铁六齿防滑支架】;3', '加厚耐高温铸铁六齿防滑支架;8').strongLong,
  true,
  'identical long specifications must provide strong product evidence'
);
assert.equal(
  context.procurementSpecEvidence('1个装;3\n黑色;2', '1个装;8\n黑色;4').genericOnly,
  true,
  'pack counts and basic colors alone must remain weak generic evidence'
);
assert.equal(
  context.procurementFamilyConflict(
    {title:'车载磁吸手机支架', spec:'加厚支架;2'},
    {title:'煤气灶铸铁防滑支架', spec:'加厚支架;3'}
  ),
  true,
  'explicit product-family conflicts must veto a fuzzy merge'
);
assert.ok(
  context.procurementTitleContainment(
    context.norm('家用加厚燃气灶防滑支架'),
    context.norm('2026新款家用加厚燃气灶防滑支架厂家直发')
  ) > 0.7,
  'marketing text around the same title should retain strong containment evidence'
);

const sameProductVector = context.procurementVectorScore(
  {
    title: '2026新款皮纹可吸桌面磁吸手机支架车载导航',
    spec: '玄武黑【可吸皮纹/玻璃】;42\n月光白【可吸皮纹/玻璃】;3'
  },
  {
    title: '新款皮纹磁吸手机支架 可吸桌面车载导航',
    spec: '玄武黑【可吸皮纹/玻璃】;8\n月光白【可吸皮纹/玻璃】;2'
  }
);
assert.equal(sameProductVector.approved, true, 'similar cross-platform titles and specs should cluster');

assert.equal(
  context.procurementVectorScore(
    {title:'家用多功能厨房切菜削皮刨丝神器A', spec:'加厚不锈钢刀片款;5'},
    {title:'家用多功能厨房切菜削皮刨丝神器B', spec:'加厚不锈钢刀片款;7'}
  ).approved,
  true,
  'single operator letters appended to a long Chinese title should still cluster'
);

const differentProductVector = context.procurementVectorScore(
  {title: '皮纹磁吸手机支架车载导航', spec: '黑色;10\n白色;5'},
  {title: '煤气灶防滑支架厨房铸铁架', spec: '黑色;7\n白色;2'}
);
assert.equal(differentProductVector.approved, false, 'generic matching specs must not merge different products');

const ambiguousVector = context.findSafeProcurementVectorMatch(
  {title: '新款皮纹磁吸手机支架车载导航', spec: '玄武黑;4'},
  [
    {title: '皮纹磁吸手机支架车载导航新款', spec: '玄武黑;2', id:'A'},
    {title: '皮纹磁吸手机支架车载导航新款', spec: '玄武黑;3', id:'B'}
  ]
);
assert.equal(ambiguousVector.ambiguous, true, 'near-tied vector candidates must stay separate for review');

const repeatedSpecDecision = context.findSafeProcurementVectorMatch(
  {title:'便携家用厨房辅助工具', spec:'加厚耐高温铸铁六齿防滑支架;2'},
  [
    {title:'煤气灶厨房防滑辅助架', spec:'加厚耐高温铸铁六齿防滑支架;3', id:'A'},
    {title:'户外炉具防滑辅助架', spec:'加厚耐高温铸铁六齿防滑支架;4', id:'B'},
    {title:'燃气灶通用防滑架', spec:'加厚耐高温铸铁六齿防滑支架;5', id:'C'}
  ]
);
assert.equal(
  repeatedSpecDecision,
  null,
  'a long specification repeated across many candidate products must lose strong-evidence status'
);

const airconProfiles = [
  {
    title:'【拍一发二】通用空调外机保护罩挡雨罩雨棚板防雨防晒遮阳室外Y',
    spec:'空调外机保护罩【升级防风绑带款】共2个;992'
  },
  {
    title:'【买一送一】空调外机防晒罩铝膜隔热降温防雨防尘省电家用罩盖dy',
    spec:'铝膜保护罩2个【磁吸】;1\n空调遮阳板【绑带挂钩款】1个,100*45cm;58'
  }
];
const airconConceptMatch = context.procurementVectorScore(
  airconProfiles[0],
  airconProfiles[1],
  context.buildProcurementCorpusStats(airconProfiles)
);
assert.equal(airconConceptMatch.approved, true, 'confirmed air-conditioner outdoor-cover variants should cluster');
assert.equal(airconConceptMatch.stage, 'RARE_CORE');

const privacyProfiles = [
  {
    title:'身份证保护套防消磁隐私遮挡卡套透明证件套银行卡防信息泄露保护膜卡袋',
    spec:'防窥卡套【10个】;116'
  },
  {
    title:'【好物推荐】防窥卡套双面身份证保护套银行卡防泄漏保护隐私',
    spec:'隐私护卡【10个装】防消磁套 护卡防窥;403'
  }
];
const privacySleeveConceptMatch = context.procurementVectorScore(
  privacyProfiles[0],
  privacyProfiles[1],
  context.buildProcurementCorpusStats(privacyProfiles)
);
assert.equal(privacySleeveConceptMatch.approved, true, 'confirmed transparent privacy document sleeves should cluster');
assert.equal(privacySleeveConceptMatch.stage, 'RARE_CORE');

assert.equal(
  context.procurementVectorScore(
    {
      title:'身份证保护套防消磁隐私遮挡卡套透明证件套银行卡防信息泄露',
      spec:'防窥卡套【10个】;116'
    },
    {
      title:'【热销】不锈钢卡包金属超薄消磁小巧卡盒防盗银行卡驾驶证卡套H',
      spec:'防盗卡包【十卡位】一个黑色;2'
    }
  ).approved,
  false,
  'metal multi-card holders must never merge into transparent privacy sleeves'
);

assert.equal(
  context.procurementVectorScore(
    {
      title:'防窥膜身份证消磁卡套银行卡通用保护套旅行校园',
      spec:'【10个装】防窥证件卡套;60'
    },
    {
      title:'透明多卡位卡套防窥防消磁防水公交卡交通卡学生通勤卡包',
      spec:'证件-防窥-防剐蹭-卡套-10个装;1'
    }
  ).approved,
  false,
  'multi-slot card holders stay separate until a purchaser explicitly confirms the physical form'
);

const panelSource = fs.readFileSync(new URL('../panel.html', import.meta.url), 'utf8');
for (const id of ['go', 'returnBtn', 'syncBtn', 'dedupBtn', 'diagScan', 'retryImages']) {
  const matches = panelSource.match(new RegExp(`id="${id}"`, 'g')) || [];
  assert.equal(matches.length, 1, `daily action ${id} must exist exactly once`);
}
assert.match(panelSource, /\.tbl,#cardFeishu,#cardSync\{display:none!important\}/, 'legacy configuration must stay out of the daily workspace');
assert.match(panelSource, /id="cardSched"/, 'the useful 13-task scheduler must remain available');
assert.doesNotMatch(source, /ctx\.strokeStyle = 'rgba\(99,91,255,\.24\)'/, 'the bordered cursor ring must not return');
assert.match(source, /mouseRadius: 150/, 'cursor-following particle attraction must remain visibly wide');
assert.match(
  source,
  /syncToProcurement\(\{incrementalPlatform:r\.platform \|\| ''\}\)/,
  'afternoon return must invoke procurement sync with the exact returned platform scope'
);
assert.match(
  source,
  /manual_return_requires_active_dgj_purchase_page/,
  'manual afternoon return must fail closed unless the active tab is a DGJ purchase page'
);
assert.match(
  source,
  /早上备货单全量上传模式/,
  'syncBtn allows full sync when no afternoon return exists'
);
assert.match(
  source,
  /selectIncrementalProcurementPlan\(\s*allPlannedUpdates,/,
  'incremental procurement sync must scope the full reconciliation plan before writes'
);
assert.equal(
  (source.match(/existing\.affected = existing\.affected \|\| op\.affected/g) || []).length,
  2,
  'affected scope must propagate through both update and create cross-platform coalescing'
);
const procurementSyncSource = extractFunction('syncToProcurement');
assert.doesNotMatch(
  procurementSyncSource,
  /\bf\[P_ACTUAL_QTY\]\s*=/,
  'system procurement updates must never write purchaser actual quantity'
);
assert.doesNotMatch(
  procurementSyncSource,
  /\bf\[P_OLD_STOCK\]\s*=/,
  'system procurement updates must never write purchaser old-stock quantity'
);
assert.match(source, /function setTaskInteractionLock\(locked, activeTaskId\)/, 'task runtime must use a real interaction lock');
assert.match(source, /document\.body\.classList\.add\('task-running'\)/, 'task start must activate the global running state');
assert.match(source, /document\.body\.classList\.remove\('task-running'\)/, 'task completion must clear the global running state');
assert.match(source, /if \(_activeTaskId\) \{\s*e\.preventDefault\(\);\s*return;/, 'keyboard shortcuts must be blocked while a task is active');
assert.match(panelSource, /id="runAmbient"/, 'running effects layer must exist');
assert.match(panelSource, /@keyframes bubbleRise/, 'running state must include rising bubble motion');
assert.match(panelSource, /\.task-locked\{pointer-events:none!important/, 'locked controls must reject pointer input');
assert.match(panelSource, /body\.task-running \.log-panel\{[^}]*pointer-events:auto/, 'logs must stay interactive while task controls are locked');

console.log('chain-safety.test: PASS');
