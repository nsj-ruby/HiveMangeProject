/**
 * 业务数据模型物理表定义 + 模拟数据生成（每张表 100 条）。
 * 本文件同时作为“模型注册元数据目录”，用于注册时自动识别中文名/敏感字段并给出建议。
 * 表结构与模拟数据在 MySQL 与内置 SQLite 两种数据源下完全一致。
 */
'use strict';

// ---------------- 码表（与自定义函数共用，保证“编码转中文”口径一致） ----------------
const PROVINCES = [
  ['110000', '北京'], ['120000', '天津'], ['130000', '河北'], ['210000', '辽宁'],
  ['310000', '上海'], ['320000', '江苏'], ['330000', '浙江'], ['350000', '福建'],
  ['370000', '山东'], ['410000', '河南'], ['420000', '湖北'], ['430000', '湖南'],
  ['440000', '广东'], ['450000', '广西'], ['500000', '重庆'], ['510000', '四川'],
  ['610000', '陕西'], ['620000', '甘肃'], ['640000', '宁夏'], ['650000', '新疆'],
];
const BIZS = [['SHFL', '主副卡共享流量'], ['LZ', '融合套餐'], ['KD', '家庭宽带'],
['5G', '5G畅享套餐'], ['QY', '权益产品'], ['GJ', '国际业务']];
const ORDER_TYPES = [['ZJ', '咨询'], ['GW', '故障报修'], ['BL', '业务办理'], ['TF', '退费'], ['TS', '服务投诉']];
const COMPLAINT_TYPES = [['FL', '流量类'], ['FY', '资费类'], ['FW', '服务类'], ['WL', '网络类']];
const TRACK_TYPES = [['CX', '咨询查费'], ['BL', '业务办理'], ['TS', '投诉反馈'], ['FK', '服务评价']];
const CHANNELS = [['APP', 'APP'], ['RX', '10086热线'], ['YT', '营业厅'], ['ZX', '在线客服']];
const ORDER_STATUS = [['OPEN', '处理中'], ['DONE', '已办结'], ['CLOSE', '已关闭']];
const TAG_POOL = [['GV', '高价值客户'], ['LD', '流失风险'], ['WL', '离网倾向'], ['ZS', '主副卡家庭'], ['LL', '流量敏感'], ['ZK', '资费敏感']];
const CITYS = ['郑州市', '洛阳市', '广州市', '深圳市', '成都市', '杭州市', '南京市', '武汉市', '长沙市', '福州市', '西安市', '沈阳市', '北京市', '上海市', '天津市', '重庆市', '南宁市', '济南市', '石家庄市', '乌鲁木齐市', '兰州市', '银川市'];
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '罗', '郑'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '军', '洋', '勇', '艳', '杰', '涛', '明', '超', '秀英', '霞', '平', '刚', '桂英', '鑫', '雨', '婷', '浩', '雪', '悦'];

// ---------------- 随机工具（固定种子，保证可复现） ----------------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260901);
const ri = (a, b) => Math.floor(rand() * (b - a + 1)) + a;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const pickW = (pairs) => { // [[value, weight],...]
  const total = pairs.reduce((s, p) => s + p[1], 0);
  let r = rand() * total;
  for (const p of pairs) { r -= p[1]; if (r <= 0) return p[0]; }
  return pairs[pairs.length - 1][0];
};
const pad4 = (n) => String(n).padStart(4, '0');

// ---------------- 11 张业务模型表定义 ----------------
// type 说明：使用 MySQL/SQLite 均兼容的类型（INT / VARCHAR / DECIMAL / CHAR / DATE / DATETIME）
// mask：默认脱敏算法建议（由 F3-2 脱敏配置生效，注册时可自动带入）
const TABLES = [
  {
    table: 'sj_customer_profile', cn: '客户基本信息模型', topic: '客户域', cycle: 'T+1',
    desc: '客户基础属性：标识、联系方式、身份信息、归属地、星级与在网状态',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识', pk: true },
      { name: 'phone', type: 'VARCHAR(20)', cn: '手机号码', sens: '高', mask: 'mask' },
      { name: 'cust_name', type: 'VARCHAR(32)', cn: '客户姓名', sens: '高', mask: 'mask' },
      { name: 'id_card', type: 'VARCHAR(20)', cn: '证件号码', sens: '高', mask: 'mask' },
      { name: 'gender', type: 'CHAR(1)', cn: '性别', dict: 'M男,F女' },
      { name: 'age', type: 'INT', cn: '年龄' },
      { name: 'province_code', type: 'VARCHAR(10)', cn: '省份编码' },
      { name: 'city', type: 'VARCHAR(32)', cn: '地市' },
      { name: 'star_level', type: 'VARCHAR(8)', cn: '星级' },
      { name: 'net_date', type: 'DATE', cn: '入网日期' },
      { name: 'cust_status', type: 'VARCHAR(8)', cn: '客户状态' },
    ],
  },
  {
    table: 'sj_cust_work_order', cn: '客户工单模型', topic: '服务域', cycle: 'T+1',
    desc: '客户在服务过程中产生的工单记录：工单类型、受理与处理时长、办理状态',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'order_no', type: 'VARCHAR(32)', cn: '工单编号' },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识' },
      { name: 'phone', type: 'VARCHAR(20)', cn: '手机号码', sens: '高', mask: 'mask' },
      { name: 'order_type_code', type: 'VARCHAR(10)', cn: '工单类型编码' },
      { name: 'biz_code', type: 'VARCHAR(10)', cn: '业务类型编码' },
      { name: 'province_code', type: 'VARCHAR(10)', cn: '省份编码' },
      { name: 'accept_time', type: 'DATETIME', cn: '受理时间' },
      { name: 'handle_minutes', type: 'INT', cn: '处理时长(分钟)' },
      { name: 'order_status', type: 'VARCHAR(8)', cn: '工单状态' },
    ],
  },
  {
    table: 'sj_cust_complaint', cn: '客户投诉模型', topic: '投诉域', cycle: 'T+1',
    desc: '客户投诉事件：投诉类型/等级、赔付金额、处理时长与结果',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'complaint_no', type: 'VARCHAR(32)', cn: '投诉编号' },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识' },
      { name: 'phone', type: 'VARCHAR(20)', cn: '手机号码', sens: '高', mask: 'mask' },
      { name: 'complaint_type_code', type: 'VARCHAR(10)', cn: '投诉类型编码' },
      { name: 'complaint_level', type: 'VARCHAR(8)', cn: '投诉等级' },
      { name: 'province_code', type: 'VARCHAR(10)', cn: '省份编码' },
      { name: 'complaint_time', type: 'DATETIME', cn: '投诉时间' },
      { name: 'compensation_amount', type: 'DECIMAL(12,2)', cn: '赔付金额(元)' },
      { name: 'handle_minutes', type: 'INT', cn: '处理时长(分钟)' },
      { name: 'handle_result', type: 'VARCHAR(32)', cn: '处理结果' },
    ],
  },
  {
    table: 'sj_cust_traffic_usage', cn: '客户流量使用模型', topic: '使用域', cycle: 'T+1',
    desc: '客户月度流量使用明细：套餐流量、实际使用与超套流量',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识' },
      { name: 'stat_month', type: 'VARCHAR(7)', cn: '统计月份' },
      { name: 'province_code', type: 'VARCHAR(10)', cn: '省份编码' },
      { name: 'package_traffic', type: 'DECIMAL(12,2)', cn: '套餐流量(GB)' },
      { name: 'actual_traffic', type: 'DECIMAL(12,2)', cn: '实际使用流量(GB)' },
      { name: 'over_traffic', type: 'DECIMAL(12,2)', cn: '超套流量(GB)' },
      { name: 'usage_days', type: 'INT', cn: '使用天数' },
    ],
  },
  {
    table: 'sj_plan_order', cn: '资费套餐订购模型', topic: '订购域', cycle: 'T+1',
    desc: '客户套餐/主副卡共享流量产品订购关系',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'order_no', type: 'VARCHAR(32)', cn: '订购编号' },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识' },
      { name: 'plan_name', type: 'VARCHAR(64)', cn: '套餐名称' },
      { name: 'biz_code', type: 'VARCHAR(10)', cn: '业务类型编码' },
      { name: 'shared_flag', type: 'CHAR(1)', cn: '是否共享套餐', dict: 'Y是,N否' },
      { name: 'province_code', type: 'VARCHAR(10)', cn: '省份编码' },
      { name: 'effective_date', type: 'DATE', cn: '生效日期' },
      { name: 'expire_date', type: 'DATE', cn: '失效日期' },
      { name: 'plan_status', type: 'VARCHAR(8)', cn: '订购状态' },
      { name: 'month_fee', type: 'DECIMAL(10,2)', cn: '月费(元)' },
    ],
  },
  {
    table: 'sj_cust_voice_track', cn: '客户轨迹模型', topic: '轨迹域', cycle: 'T+1',
    desc: '客户多渠道交互轨迹：渠道/轨迹类型/时长',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'track_id', type: 'VARCHAR(32)', cn: '轨迹编号' },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识' },
      { name: 'track_type_code', type: 'VARCHAR(10)', cn: '轨迹类型编码' },
      { name: 'channel_code', type: 'VARCHAR(10)', cn: '渠道编码' },
      { name: 'province_code', type: 'VARCHAR(10)', cn: '省份编码' },
      { name: 'visit_time', type: 'DATETIME', cn: '访问时间' },
      { name: 'duration_min', type: 'INT', cn: '交互时长(分钟)' },
    ],
  },
  {
    table: 'sj_cust_survey', cn: '客户满意度回访模型', topic: '回访域', cycle: 'T+1',
    desc: '服务后满意度回访结果',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'survey_no', type: 'VARCHAR(32)', cn: '回访编号' },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识' },
      { name: 'province_code', type: 'VARCHAR(10)', cn: '省份编码' },
      { name: 'survey_time', type: 'DATETIME', cn: '回访时间' },
      { name: 'satisfaction_score', type: 'INT', cn: '满意度评分(1-10)' },
      { name: 'complaint_mentioned', type: 'CHAR(1)', cn: '是否提及不满', dict: 'Y是,N否' },
    ],
  },
  {
    table: 'sj_service_volume', cn: '服务量数据模型', topic: '服务域', cycle: 'D',
    desc: '按省/月/服务类型的服务量、平均处理时长与满意度（可用于投诉率类派生计算）',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'province_code', type: 'VARCHAR(10)', cn: '省份编码' },
      { name: 'stat_month', type: 'VARCHAR(7)', cn: '统计月份' },
      { name: 'service_type_code', type: 'VARCHAR(10)', cn: '服务类型编码' },
      { name: 'service_count', type: 'INT', cn: '服务量(次)' },
      { name: 'avg_handle_min', type: 'DECIMAL(8,2)', cn: '平均处理时长(分钟)' },
      { name: 'satisfaction_rate', type: 'DECIMAL(5,2)', cn: '满意度(%)' },
    ],
  },
  {
    table: 'sj_cust_payment', cn: '客户缴费账务模型', topic: '账务域', cycle: 'T+1',
    desc: '客户月度账务与缴费信息',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'bill_no', type: 'VARCHAR(32)', cn: '账务编号' },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识' },
      { name: 'bill_month', type: 'VARCHAR(7)', cn: '账期月份' },
      { name: 'plan_fee', type: 'DECIMAL(10,2)', cn: '套餐费(元)' },
      { name: 'extra_fee', type: 'DECIMAL(10,2)', cn: '增值业务费(元)' },
      { name: 'pay_amount', type: 'DECIMAL(12,2)', cn: '实缴金额(元)' },
      { name: 'arrears_amount', type: 'DECIMAL(12,2)', cn: '欠费金额(元)' },
      { name: 'pay_time', type: 'DATETIME', cn: '缴费时间' },
    ],
  },
  {
    table: 'sj_marketing_contact', cn: '营销维系接触模型', topic: '营销域', cycle: 'T+1',
    desc: '针对高价值/流失风险客户的策略营销接触记录',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'contact_no', type: 'VARCHAR(32)', cn: '接触编号' },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识' },
      { name: 'campaign_code', type: 'VARCHAR(16)', cn: '策略编码' },
      { name: 'channel_code', type: 'VARCHAR(10)', cn: '渠道编码' },
      { name: 'province_code', type: 'VARCHAR(10)', cn: '省份编码' },
      { name: 'contact_time', type: 'DATETIME', cn: '接触时间' },
      { name: 'accept_flag', type: 'CHAR(1)', cn: '是否接受', dict: 'Y是,N否' },
      { name: 'result_note', type: 'VARCHAR(64)', cn: '接触结果' },
    ],
  },
  {
    table: 'sj_customer_tag', cn: '客户标签模型', topic: '标签域', cycle: 'T+1',
    desc: '客户画像标签（高价值/流失风险等）',
    columns: [
      { name: 'id', type: 'INT', cn: '主键', pk: true },
      { name: 'tag_id', type: 'VARCHAR(32)', cn: '标签编号' },
      { name: 'cust_id', type: 'VARCHAR(32)', cn: '客户标识' },
      { name: 'tag_code', type: 'VARCHAR(16)', cn: '标签编码' },
      { name: 'tag_name', type: 'VARCHAR(32)', cn: '标签名称' },
      { name: 'tag_source', type: 'VARCHAR(16)', cn: '标签来源' },
      { name: 'update_time', type: 'DATETIME', cn: '更新时间' },
    ],
  },
];

// ---------------- 主数据（100 位客户，各业务表围绕其生成，保证可关联） ----------------
function buildCustomers() {
  const customers = [];
  const usedPhones = new Set();
  const usedCards = new Set();
  for (let i = 1; i <= 100; i++) {
    const prov = pickW(PROVINCES.map((p, idx) => [p, idx === 0 ? 4 : idx < 5 ? 3 : idx < 12 ? 2 : 1])); // 加权：靠前省份概率更高
    let phone; do { phone = '1' + pick(['38', '39', '50', '51', '52', '59', '86', '87', '88', '89']) + String(ri(1000, 9999)) + String(ri(1000, 9999)).padStart(4, '0'); } while (usedPhones.has(phone));
    usedPhones.add(phone);
    let idCard; do {
      idCard = pick(['410101', '440101', '510101', '320101', '370101', '330101', '110101', '430101', '420101', '350101'])
        + String(ri(1950, 2005)).padStart(4, '0') + String(ri(1, 12)).padStart(2, '0') + String(ri(1, 28)).padStart(2, '0')
        + String(ri(0, 999)).padStart(3, '0') + ri(0, 9);
    } while (usedCards.has(idCard));
    usedCards.add(idCard);
    const name = pick(SURNAMES) + (rand() > 0.5 ? pick(GIVEN) : pick(GIVEN));
    const shared = rand() < 0.42; // 约四成客户有共享(主副卡)产品
    customers.push({
      cust_id: 'C' + pad4(i),
      phone, id_card: idCard, cust_name: name,
      gender: rand() > 0.5 ? 'M' : 'F',
      age: ri(18, 68),
      province_code: prov[0], province_name: prov[1],
      city: pick(CITYS), star_level: String(ri(1, 7)),
      net_date: `20${String(ri(14, 25)).padStart(2, '0')}-${String(ri(1, 12)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`,
      cust_status: pickW([['ACTIVE', 0.88], ['STOP', 0.08], ['CHURN', 0.04]]),
      shared,
    });
  }
  return customers;
}

function dt(month, d, hh, mm, ss) {
  const [y, m] = month.split('-');
  return `${y}-${m}-${String(d).padStart(2, '0')} ${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}

function buildRows() {
  const customers = buildCustomers();
  const rows = {};
  const newRows = (t) => (rows[t] = []);
  const cust = (i) => customers[i - 1];

  // 1) 客户基本信息模型
  newRows('sj_customer_profile');
  for (let i = 1; i <= 100; i++) {
    const c = cust(i);
    rows.sj_customer_profile.push({
      id: i, cust_id: c.cust_id, phone: c.phone, cust_name: c.cust_name, id_card: c.id_card,
      gender: c.gender, age: c.age, province_code: c.province_code, city: c.city,
      star_level: c.star_level, net_date: c.net_date, cust_status: c.cust_status,
    });
  }

  // 2) 客户工单模型（100 条，覆盖约 80 位客户）
  newRows('sj_cust_work_order');
  const WO_MONTHS = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07'];
  for (let i = 1; i <= 100; i++) {
    const c = cust((i % 80) + 1);
    const m = pick(WO_MONTHS);
    const ot = pick(ORDER_TYPES);
    const biz = pick(BIZS);
    rows.sj_cust_work_order.push({
      id: i, order_no: 'WO' + pad4(26000 + i), cust_id: c.cust_id, phone: c.phone,
      order_type_code: ot[0], biz_code: biz[0], province_code: c.province_code,
      accept_time: dt(m, ri(1, 28), ri(8, 21), ri(0, 59), ri(0, 59)),
      handle_minutes: ri(15, 60 * 36),
      order_status: pick(ORDER_STATUS)[0],
    });
  }

  // 3) 客户投诉模型（100 条，重点覆盖主副卡共享流量+流量类投诉场景客户）
  newRows('sj_cust_complaint');
  const C_MONTHS = ['2026-04', '2026-05', '2026-06', '2026-07'];
  const flowCusts = [];
  for (let i = 1; i <= 100; i++) {
    // 挑选“办理主副卡共享流量”的客户，构造流量类投诉
    if (cust(i).shared && (i % 3 !== 0)) flowCusts.push(cust(i).cust_id);
  }
  const hasFlow = new Set(flowCusts);
  for (let i = 1; i <= 100; i++) {
    const target = rand() < 0.62 ? pick([...hasFlow]) : cust(ri(1, 100)).cust_id;
    const cm = pick(C_MONTHS);
    const isFlow = hasFlow.has(target) && rand() < 0.55;
    const t = isFlow ? COMPLAINT_TYPES[0] : pick(COMPLAINT_TYPES);
    const c = customers.find((x) => x.cust_id === target) || cust(1);
    const comp = ri(0, 2000);
    rows.sj_cust_complaint.push({
      id: i, complaint_no: 'CP' + pad4(18000 + i), cust_id: target, phone: c.phone,
      complaint_type_code: t[0], complaint_level: pickW([['高', 0.3], ['中', 0.4], ['低', 0.3]]),
      province_code: c.province_code,
      complaint_time: dt(cm, ri(1, 28), ri(8, 22), ri(0, 59), ri(0, 59)),
      compensation_amount: comp,
      handle_minutes: ri(60, 60 * 72),
      handle_result: pickW([['已妥善处理', 0.6], ['已退费', 0.15], ['已升级', 0.1], ['处理中', 0.15]]),
    });
  }

  // 4) 客户流量使用模型（100 条：90 位客户单月 + 若干客户多月补足）
  newRows('sj_cust_traffic_usage');
  const U_MONTHS = ['2026-04', '2026-05', '2026-06'];
  const monthPlan = [];
  for (let i = 1; i <= 100; i++) {
    const base = customers[i - 1];
    const m1 = pick(U_MONTHS);
    monthPlan.push({ cust: base, months: rand() < 0.22 ? [m1, pick(U_MONTHS.filter((x) => x !== m1))] : [m1] });
  }
  let k = 0;
  outer: for (const mp of monthPlan) {
    for (const m of mp.months) {
      if (k >= 100) break outer;
      k += 1;
      const pkg = ri(20, 60);
      const act = ri(8, Math.max(10, pkg + 40));
      const over = Math.max(0, Number((act - pkg).toFixed(2)));
      rows.sj_cust_traffic_usage.push({
        id: k, cust_id: mp.cust.cust_id, stat_month: m, province_code: mp.cust.province_code,
        package_traffic: pkg, actual_traffic: act, over_traffic: over, usage_days: ri(3, 30),
      });
    }
  }

  // 5) 资费套餐订购模型（100 条，约七成客户至少一条，主副卡共享产品突出展示）
  newRows('sj_plan_order');
  const PLAN_NAMES = [
    ['主副卡共享流量包', 'SHFL', 'Y', 20], ['全家享融合套餐', 'LZ', 'Y', 60],
    ['5G畅享套餐', '5G', 'N', 128], ['家庭宽带融合包', 'KD', 'N', 50],
    ['权益随心选', 'QY', 'N', 15], ['国际漫游包', 'GJ', 'N', 30],
  ];
  let used = 0;
  for (let i = 1; i <= 100 && used < 100; i++) {
    const c = customers[i - 1];
    const cnt = c.shared ? (rand() < 0.3 ? 2 : 1) : (rand() < 0.55 ? 1 : 0);
    for (let j = 0; j < cnt && used < 100; j++) {
      used += 1;
      const p = c.shared && (j === 0 || rand() < 0.7)
        ? PLAN_NAMES[rand() < 0.7 ? 0 : 1]
        : pick(PLAN_NAMES);
      rows.sj_plan_order.push({
        id: used, order_no: 'PO' + pad4(12000 + used), cust_id: c.cust_id,
        plan_name: p[0], biz_code: p[1], shared_flag: p[2],
        province_code: c.province_code,
        effective_date: `2026-${String(ri(3, 7)).padStart(2, '0')}-${String(ri(1, 28)).padStart(2, '0')}`,
        expire_date: '2027-12-31', plan_status: 'ACTIVE', month_fee: p[3],
      });
    }
  }
  if (used < 100) { for (let i = used + 1; i <= 100; i++) rows.sj_plan_order.push({ id: i, order_no: 'PO' + pad4(12000 + i), cust_id: customers[((i - 1) % 60)].cust_id, plan_name: '主副卡共享流量包', biz_code: 'SHFL', shared_flag: 'Y', province_code: customers[((i - 1) % 60)].province_code, effective_date: '2026-06-10', expire_date: '2027-12-31', plan_status: 'ACTIVE', month_fee: 20 }); }

  // 6) 客户轨迹模型（100 条）
  newRows('sj_cust_voice_track');
  for (let i = 1; i <= 100; i++) {
    const c = customers[(i % 90)];
    const m = pick(['2026-05', '2026-06', '2026-07']);
    rows.sj_cust_voice_track.push({
      id: i, track_id: 'TK' + pad4(3000 + i), cust_id: c.cust_id,
      track_type_code: pick(TRACK_TYPES)[0], channel_code: pick(CHANNELS)[0],
      province_code: c.province_code, visit_time: dt(m, ri(1, 28), ri(8, 23), ri(0, 59), ri(0, 59)),
      duration_min: ri(1, 45),
    });
  }

  // 7) 客户满意度回访模型（100 条）
  newRows('sj_cust_survey');
  for (let i = 1; i <= 100; i++) {
    const c = customers[(i % 78) + 1];
    const m = pick(['2026-06', '2026-07']);
    rows.sj_cust_survey.push({
      id: i, survey_no: 'SV' + pad4(4000 + i), cust_id: c.cust_id, province_code: c.province_code,
      survey_time: dt(m, ri(1, 28), ri(9, 20), ri(0, 59), ri(0, 59)),
      satisfaction_score: ri(1, 10), complaint_mentioned: rand() < 0.22 ? 'Y' : 'N',
    });
  }

  // 8) 服务量数据模型（100 条：省份×月份×服务类型）
  newRows('sj_service_volume');
  const SVC_TYPES = [['QUERY', '查询'], ['HANDLE', '办理'], ['COMPLAINT', '投诉处理'], ['REPAIR', '故障'], ['CONSULT', '咨询']];
  let si = 0;
  for (let i = 1; i <= 100; i++) {
    const prov = PROVINCES[i % PROVINCES.length];
    const m = ['2026-03', '2026-04', '2026-05', '2026-06'][Math.floor(i / 25) % 4];
    const st = SVC_TYPES[i % SVC_TYPES.length];
    rows.sj_service_volume.push({
      id: i, province_code: prov[0], stat_month: m, service_type_code: st[0],
      service_count: ri(300, 48000), avg_handle_min: Number((ri(2, 200) / 10).toFixed(2)),
      satisfaction_rate: Number((ri(780, 995) / 10).toFixed(2)),
    });
  }

  // 9) 客户缴费账务模型（100 条）
  newRows('sj_cust_payment');
  for (let i = 1; i <= 100; i++) {
    const c = customers[i - 1];
    const m = i % 4 === 0 ? '2026-05' : '2026-06';
    const fee = Number((ri(59, 299)).toFixed(2));
    const extra = rand() < 0.4 ? Number((ri(5, 60)).toFixed(2)) : 0;
    const arrears = rand() < 0.15 ? Number((ri(20, 200)).toFixed(2)) : 0;
    rows.sj_cust_payment.push({
      id: i, bill_no: 'BILL' + pad4(5000 + i), cust_id: c.cust_id, bill_month: m,
      plan_fee: fee, extra_fee: extra, pay_amount: Number((fee + extra - arrears + ri(0, 100)).toFixed(2)),
      arrears_amount: arrears, pay_time: dt(m, ri(1, 25), ri(8, 20), ri(0, 59), ri(0, 59)),
    });
  }

  // 10) 营销维系接触模型（100 条）
  newRows('sj_marketing_contact');
  const CAMPS = [['RET', '离网挽留'], ['UP', '价值提升'], ['CARE', '关怀维系']];
  for (let i = 1; i <= 100; i++) {
    const c = customers[(i % 70)];
    const m = pick(['2026-06', '2026-07']);
    rows.sj_marketing_contact.push({
      id: i, contact_no: 'MC' + pad4(6000 + i), cust_id: c.cust_id,
      campaign_code: pick(CAMPS)[0], channel_code: pick(CHANNELS)[0],
      province_code: c.province_code, contact_time: dt(m, ri(1, 28), ri(9, 21), ri(0, 59), ri(0, 59)),
      accept_flag: rand() < 0.6 ? 'Y' : 'N',
      result_note: pick(['已推荐权益包', '已发送优惠券', '客户暂无意向', '已预约回访']),
    });
  }

  // 11) 客户标签模型（100 条）
  newRows('sj_customer_tag');
  for (let i = 1; i <= 100; i++) {
    const c = customers[(i % 82)];
    const tag = pick(TAG_POOL);
    rows.sj_customer_tag.push({
      id: i, tag_id: 'TG' + pad4(7000 + i), cust_id: c.cust_id,
      tag_code: tag[0], tag_name: tag[1], tag_source: pick(['标签工厂', '人工圈选', '模型挖掘']),
      update_time: dt('2026-07', ri(1, 28), ri(0, 23), ri(0, 59), ri(0, 59)),
    });
  }

  return { customers, rows };
}

// 生成 CREATE TABLE 语句（MySQL / SQLite 通用子集，列注释保留在元数据目录中）
function buildDDL() {
  const stmts = [];
  for (const t of TABLES) {
    const cols = t.columns.map((c) => `\`${c.name}\` ${c.type}` + (c.pk ? ' NOT NULL' : '')).join(', ');
    stmts.push(`CREATE TABLE IF NOT EXISTS \`${t.table}\` (${cols})`);
  }
  return stmts;
}

function getTableDef(table) {
  return TABLES.find((t) => t.table === table) || null;
}

module.exports = { TABLES, PROVINCES, BIZS, ORDER_TYPES, COMPLAINT_TYPES, TRACK_TYPES, CHANNELS, buildDDL, buildRows, getTableDef, pad4, rand };
