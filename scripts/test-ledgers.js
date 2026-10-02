'use strict';

/*
 * 年度账册封存（ledger sealing）专项集成测试（基于 pg-mem，不依赖真实 PostgreSQL）：
 *   node scripts/test-ledgers.js
 * 覆盖：
 *   - 权限（布展员只读）、未结束年份/未登记上限拒绝、不存在展品/年份 400
 *   - 封存原子快照：上限、已确认实测、各计划扣除实测覆盖与停灯后的估算残余、合计、逐项来源
 *   - 已封存拒绝且重复提交不覆盖旧账；旧账始终不可改
 *   - 封存后实测纠错、上限变化、计划取消按既有流程生效；账册值不变
 *   - GET 账册：封存值 vs 当前重算值，顶层差额、逐项按来源编号对齐差额，
 *     已消失来源仍列出（currentDose=null/disappeared）、新来源 new、零差额 zeroDifference 明确标示
 *   - 展品详情附加 ledgers 字段（既有字段不变）
 *   - 封存与同展品占用变动并发：账册合计=实测+残余恒等，不混入变动前后数据
 *   - 审计 ledger.seal
 */

process.env.SEED_DEMO = 'false';
process.env.PGHOST = 'memory';

const http = require('http');
const { newDb } = require('pg-mem');
const dbModule = require('../src/db');

const mem = newDb({ autoCreateForeignKeyIndices: true });
const { Pool: MemPool } = mem.adapters.createPg();
const fakePool = new MemPool();

dbModule.pool.connect = (...args) => fakePool.connect(...args);
dbModule.pool.query = (...args) => fakePool.query(...args);

const { createApp } = require('../src/app');
const { initializeDatabase } = require('../src/init');
const config = require('../src/config');
const dosing = require('../src/dosing');

let server;
let base;
const cookies = new Map();
let assertCount = 0;

function assert(cond, msg) {
  assertCount++;
  if (!cond) throw new Error('断言失败: ' + msg);
}

function call(method, urlPath, body, role) {
  const cookie = role ? cookies.get(role) : null;
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${base}${urlPath}`,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(cookie ? { Cookie: `lqsession=${cookie}` } : {}),
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (c) => (chunks += c));
        res.on('end', () => {
          if (role && res.headers['set-cookie']) {
            const m = res.headers['set-cookie'][0].match(/lqsession=([a-f0-9]+)/);
            if (m) cookies.set(role, m[1]);
          }
          let json = null;
          try {
            json = JSON.parse(chunks);
          } catch (_) {
            /* ignore */
          }
          resolve({ status: res.statusCode, body: json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function main() {
  await initializeDatabase();
  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
  await runFlow();
  server.close();
  console.log(`\n账册封存专项测试全部通过（${assertCount} 条断言）`);
  process.exit(0);
}

async function runFlow() {
  // ---- 登录 ----
  let r = await call('POST', '/api/auth/login',
    { username: config.seed.conservatorUsername, password: config.seed.conservatorPassword }, 'c');
  assert(r.status === 200, '保管员登录');
  r = await call('POST', '/api/auth/login',
    { username: config.seed.installerUsername, password: config.seed.installerPassword }, 'i');
  assert(r.status === 200, '布展员登录');

  const createExhibit = async (name) => {
    const cr = await call('POST', '/api/exhibits', { name }, 'c');
    assert(cr.status === 201, `登记展品 ${name}`);
    return cr.body.exhibit.id;
  };
  const submitPlan = async (exId, title, startDate, endDate, periods, lux) => {
    const cr = await call('POST', '/api/plans',
      { exhibitId: exId, title, startDate, endDate, periods, estimatedLux: lux }, 'i');
    assert(cr.status === 201, `提交计划 ${title}`);
    return cr.body.plan.id;
  };
  const approve = async (id) => {
    const cr = await call('POST', `/api/plans/${id}/approve`, {}, 'c');
    assert(cr.status === 200, `批准计划 #${id}（${cr.status} ${cr.body && cr.body.error}）`);
  };
  const addMeas = async (planId, d, sh, eh, lux) => {
    const cr = await call('POST', '/api/measurements', {
      planId, startDate: d, startTime: sh, endDate: d, endTime: eh, actualLux: lux,
    }, 'c');
    assert(cr.status === 201, `录入实测 ${d} ${sh}-${eh}`);
    const id = cr.body.measurement.id;
    const cf = await call('POST', `/api/measurements/${id}/confirm`, {}, 'c');
    assert(cf.status === 200, `确认实测 #${id}（${cf.status} ${cf.body && cf.body.error}）`);
    return id;
  };
  const addBlackout = async (planId, d, sh, eh, reason) => {
    const cr = await call('POST', '/api/blackouts', {
      planId, startDate: d, startTime: sh, endDate: d, endTime: eh, reason,
    }, 'c');
    assert(cr.status === 201, `登记停灯 ${d} ${sh}-${eh}（${cr.status} ${cr.body && cr.body.error}）`);
    return cr.body.blackout.id;
  };

  // ---- 时间锚点（墙上时间，固定时区）----
  const wallNow = dosing.tsToWall(Date.now());
  const cy = Number(wallNow.ymd.slice(0, 4));
  const py = cy - 1; // 已结束的上一自然年
  const d1 = `${py}-06-01`;
  const d2 = `${py}-06-02`;

  // =======================================================================
  // 1. 权限与组成性校验
  // =======================================================================
  const ex0 = await createExhibit('账册校验展品');
  await call('POST', `/api/exhibits/${ex0}/limits`, { year: py, limitLxh: 50000 }, 'c');

  r = await call('POST', `/api/exhibits/${ex0}/ledgers`, { year: py }, 'i');
  assert(r.status === 403, '布展员不能封存账册');

  r = await call('GET', `/api/exhibits/${ex0}/ledgers`, null, 'i');
  assert(r.status === 200 && Array.isArray(r.body.ledgers), '布展员可只读列出账册');

  // 年份未结束：当前年 / 未来年
  r = await call('POST', `/api/exhibits/${ex0}/ledgers`, { year: cy }, 'c');
  assert(r.status === 400 && /尚未结束/.test(r.body.error), '当前自然年未结束拒绝封存');
  r = await call('POST', `/api/exhibits/${ex0}/ledgers`, { year: cy + 3 }, 'c');
  assert(r.status === 400 && /尚未结束/.test(r.body.error), '未来年份拒绝封存');
  // 非法年份
  r = await call('POST', `/api/exhibits/${ex0}/ledgers`, { year: 1800 }, 'c');
  assert(r.status === 400, '非法年份拒绝封存');

  // 未登记上限：另一年份
  await call('POST', `/api/exhibits/${ex0}/limits`, { year: py - 2, limitLxh: 50000 }, 'c');
  const ex1 = await createExhibit('无上限展品');
  r = await call('POST', `/api/exhibits/${ex1}/ledgers`, { year: py }, 'c');
  assert(r.status === 400 && /尚未登记年度上限/.test(r.body.error), '未登记上限拒绝封存');

  // 查看不存在的账册/展品
  r = await call('GET', `/api/exhibits/${ex1}/ledgers/${py}`, null, 'c');
  assert(r.status === 400 && /尚未封存/.test(r.body.error), '未封存年份查看返回 400');
  r = await call('GET', '/api/exhibits/999999/ledgers', null, 'c');
  assert(r.status === 400, '不存在展品列出账册返回 400');

  // =======================================================================
  // 2. 封存原子快照（实测 + 各计划扣除覆盖与停灯后的估算残余 + 合计 + 逐项来源）
  // =======================================================================
  const ex2 = await createExhibit('封存快照展品');
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: py, limitLxh: 50000 }, 'c');

  // 计划：d1~d2 每天 09-17，100lx（毛 1600）
  const planA = await submitPlan(ex2, '封存计划A', d1, d2, ['09:00-17:00'], 100);
  await approve(planA);
  // d1 全天实测 150lx = 1200（替代当天 800 估算）
  const m1 = await addMeas(planA, d1, '09:00', '17:00', 150);
  // d2 停灯 10:00-12:00（200），残余 600
  const b1 = await addBlackout(planA, d2, '10:00', '12:00', '封存前停灯');

  // 封存
  r = await call('POST', `/api/exhibits/${ex2}/ledgers`, { year: py }, 'c');
  assert(r.status === 201, `封存成功（实际 ${r.status} ${r.body && r.body.error}）`);
  const sealResp = r.body;
  assert(sealResp.ledger.year === py, '响应账册年份');
  assert(sealResp.sealed.confirmedLxh === 1200, `已确认实测 1200，实际 ${sealResp.sealed.confirmedLxh}`);
  assert(sealResp.sealed.residueLxh === 600, `计划估算残余 600（1600-800实测-200停灯），实际 ${sealResp.sealed.residueLxh}`);
  assert(sealResp.sealed.totalLxh === 1800, `合计 1800，实际 ${sealResp.sealed.totalLxh}`);
  assert(sealResp.sealed.limitLxh === 50000, '封存上限 50000');
  assert(sealResp.sealed.blackoutDeductionLxh === 200, `停灯扣减 200，实际 ${sealResp.sealed.blackoutDeductionLxh}`);
  // 封存当下差额全 0，且逐项零差额明确标示
  assert(sealResp.differences.allZero === true, '封存当下顶层差额全 0');
  assert(sealResp.differences.allItemDifferencesZero === true, '封存当下逐项差额全 0');
  const itemKeys = sealResp.differences.items.map((it) => it.sourceKey).sort();
  assert(itemKeys.join(',') === [`measurement:${m1}`, `plan:${planA}`].sort().join(','),
    '逐项来源含实测与计划各一条：' + itemKeys.join(','));
  const measItem = sealResp.differences.items.find((it) => it.kind === 'measurement');
  assert(measItem.sealedDose === 1200 && measItem.currentDose === 1200 && measItem.zeroDifference === true,
    '实测项封存=当前=1200 且零差额标示');
  const planItem = sealResp.differences.items.find((it) => it.kind === 'plan');
  assert(planItem.sealedDose === 600 && planItem.zeroDifference === true, '计划项封存 600 且零差额标示');
  assert(sealResp.ledger.tzOffsetMinutes === config.tzOffsetMinutes, '记录封存时固定时区口径');

  // 列表 + 详情附加字段
  r = await call('GET', `/api/exhibits/${ex2}/ledgers`, null, 'i');
  assert(r.body.ledgers.length === 1 && r.body.ledgers[0].id === sealResp.ledger.id &&
    r.body.ledgers[0].sealedTotalLxh === 1800, '账册列表含该年封存摘要');
  r = await call('GET', `/api/exhibits/${ex2}`, null, 'i');
  assert(Array.isArray(r.body.ledgers) && r.body.ledgers[0].sealedTotalLxh === 1800,
    '展品详情附加 ledgers 字段');
  assert(r.body.years[`${py}`] && r.body.sources.length >= 1, '展品详情既有字段保持不变');

  // =======================================================================
  // 3. 重复提交拒绝且不覆盖旧账
  // =======================================================================
  r = await call('POST', `/api/exhibits/${ex2}/ledgers`, { year: py }, 'c');
  assert(r.status === 409 && /已封存/.test(r.body.error), '同年重复封存返回 409');
  assert(r.body.details && r.body.details.existingLedgerId === sealResp.ledger.id,
    '409 指明既有账册编号');
  r = await call('GET', `/api/exhibits/${ex2}/ledgers/${py}`, null, 'c');
  assert(r.body.ledger.id === sealResp.ledger.id && r.body.sealed.totalLxh === 1800,
    '重复提交后旧账未被覆盖');

  // =======================================================================
  // 4. 封存后上限变化：旧账不变，差额体现为 limitDifference
  // =======================================================================
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: py, limitLxh: 40000 }, 'c');
  r = await call('GET', `/api/exhibits/${ex2}/ledgers/${py}`, null, 'c');
  assert(r.body.sealed.limitLxh === 50000 && r.body.current.limitLxh === 40000,
    '封存上限保持 50000，当前上限 40000');
  assert(r.body.differences.limitDifference === -10000, '上限差额 -10000');
  assert(r.body.differences.totalDifference === 0, '占用未变：合计差额 0');
  assert(r.body.differences.allZero === false, '存在非零差额时 allZero=false');
  // 恢复
  await call('POST', `/api/exhibits/${ex2}/limits`, { year: py, limitLxh: 50000 }, 'c');

  // =======================================================================
  // 5. 封存后实测纠错：旧账不变；逐项差额（实测 changed、计划新增残余 new）
  // =======================================================================
  // 把 d1 全天 150lx(1200) 纠错为 d1 09:00-12:00 100lx = 300
  r = await call('POST', `/api/measurements/${m1}/correct`, {
    startDate: d1, startTime: '09:00', endDate: d1, endTime: '12:00',
    actualLux: 100, reason: '封存后核对发现照度与时段均录错',
  }, 'c');
  assert(r.status === 200, `封存后实测纠错成功（${r.status} ${r.body && r.body.error}）`);
  const m2 = r.body.correction.replacementMeasurementId;

  // 当前口径：实测 300；计划残余 = d1 剩余 5h*100=500 + d2(8-2停灯)h*100=600 = 1100；合计 1400
  r = await call('GET', `/api/exhibits/${ex2}/ledgers/${py}`, null, 'c');
  assert(r.body.sealed.confirmedLxh === 1200 && r.body.sealed.residueLxh === 600 &&
    r.body.sealed.totalLxh === 1800, '旧账封存值始终不变（1200/600/1800）');
  assert(r.body.current.confirmedLxh === 300, `当前实测 300，实际 ${r.body.current.confirmedLxh}`);
  assert(r.body.current.residueLxh === 1100, `当前计划残余 1100，实际 ${r.body.current.residueLxh}`);
  assert(r.body.current.totalLxh === 1400, `当前合计 1400，实际 ${r.body.current.totalLxh}`);
  assert(r.body.differences.confirmedDifference === -900, '实测差额 -900');
  assert(r.body.differences.residueDifference === 500, '残余差额 +500');
  assert(r.body.differences.totalDifference === -400, '合计差额 -400');

  // 逐项按来源编号对齐
  const items = r.body.differences.items;
  const oldMeas = items.find((it) => it.sourceKey === `measurement:${m1}`);
  const newMeas = items.find((it) => it.sourceKey === `measurement:${m2}`);
  const planRow = items.find((it) => it.sourceKey === `plan:${planA}`);
  assert(oldMeas && oldMeas.status === 'disappeared' && oldMeas.sealedDose === 1200 &&
    oldMeas.currentDose === null && oldMeas.difference === -1200,
    '旧实测来源已消失仍列出：currentDose=null, disappeared');
  assert(newMeas && newMeas.status === 'new' && newMeas.sealedDose === null &&
    newMeas.currentDose === 300 && newMeas.difference === 300,
    '新替代实测列为 new：sealedDose=null, 当前 300');
  assert(planRow && planRow.status === 'changed' && planRow.sealedDose === 600 &&
    planRow.currentDose === 1100 && planRow.difference === 500 && planRow.zeroDifference === false,
    '计划项 changed：600→1100，差额 +500，非零差额标示 false');
  assert(items.every((it) => typeof it.zeroDifference === 'boolean'), '每项都明确给出 zeroDifference 布尔');

  // 原实测记录已作废、替代记录确认，旧账仍只认 m1
  assert(oldMeas.sealedDose === 1200, '账册封存的实测来源仍指向旧记录剂量');

  // =======================================================================
  // 6. 计划取消后：来源消失仍列出（disappeared），停灯扣减不再计入
  // =======================================================================
  const ex3 = await createExhibit('封存取消展品');
  await call('POST', `/api/exhibits/${ex3}/limits`, { year: py, limitLxh: 50000 }, 'c');
  const planC = await submitPlan(ex3, '将取消计划', d1, d1, ['09:00-17:00'], 100);
  await approve(planC);
  await addBlackout(planC, d1, '10:00', '12:00', '取消前停灯'); // 残余 600
  r = await call('POST', `/api/exhibits/${ex3}/ledgers`, { year: py }, 'c');
  assert(r.status === 201 && r.body.sealed.residueLxh === 600 &&
    r.body.sealed.blackoutDeductionLxh === 200, '封存：残余 600、停灯扣减 200');
  const ledgerCId = r.body.ledger.id;

  await call('POST', `/api/plans/${planC}/cancel`, {}, 'c');
  r = await call('GET', `/api/exhibits/${ex3}/ledgers/${py}`, null, 'c');
  assert(r.body.ledger.id === ledgerCId && r.body.sealed.residueLxh === 600, '旧账残余仍为 600');
  assert(r.body.current.residueLxh === 0, '取消后当前残余 0');
  assert(r.body.current.blackoutDeductionLxh === 0, '取消后停灯不再计入扣减');
  const gone = r.body.differences.items.find((it) => it.sourceKey === `plan:${planC}`);
  assert(gone && gone.status === 'disappeared' && gone.currentDose === null &&
    gone.sealedDose === 600 && gone.difference === -600,
    '取消的计划来源仍列出并标记 disappeared');

  // =======================================================================
  // 7. 零差额场景：封存后无任何变化 -> 所有项 unchanged 且零差额
  // =======================================================================
  const ex4 = await createExhibit('零差额展品');
  await call('POST', `/api/exhibits/${ex4}/limits`, { year: py, limitLxh: 50000 }, 'c');
  const planD = await submitPlan(ex4, '零差额计划', d1, d1, ['09:00-17:00'], 100);
  await approve(planD);
  await addMeas(planD, d1, '09:00', '17:00', 100); // 800 实测，残余 0
  await call('POST', `/api/exhibits/${ex4}/ledgers`, { year: py }, 'c');
  // 不做任何变动
  r = await call('GET', `/api/exhibits/${ex4}/ledgers/${py}`, null, 'c');
  const z = r.body.differences;
  assert(z.allZero && z.allItemDifferencesZero, '无变化：顶层与逐项差额全 0');
  assert(z.items.length === 1 && z.items[0].status === 'unchanged' &&
    z.items[0].zeroDifference === true && z.items[0].difference === 0,
    '唯一来源 unchanged，差额 0 明确标示');

  // =======================================================================
  // 8. 封存与同展品占用变动并发：账册不得混入变动前后的数据
  // 用“封存”与“实测纠错（改变实测与残余两端）”并发；账册合计必须恒等于 实测+残余，
  // 且数值只可能是变动前或变动后两套一致快照之一。
  // =======================================================================
  const ex5 = await createExhibit('并发封存展品');
  await call('POST', `/api/exhibits/${ex5}/limits`, { year: py, limitLxh: 50000 }, 'c');
  const planE = await submitPlan(ex5, '并发计划', d1, d2, ['09:00-17:00'], 100);
  await approve(planE);
  await addBlackout(planE, d2, '10:00', '12:00', '并发前停灯'); // d2 残余 600
  const mE = await addMeas(planE, d1, '09:00', '17:00', 150); // d1 实测 1200
  // 变动前：实测 1200，残余 600，合计 1800
  // 纠错后（d1 09-12，100lx=300）：实测 300，残余 500+600=1100，合计 1400
  const BEFORE = { confirmed: 1200, residue: 600, total: 1800 };
  const AFTER = { confirmed: 300, residue: 1100, total: 1400 };

  const sealCall = call('POST', `/api/exhibits/${ex5}/ledgers`, { year: py }, 'c');
  const correctCall = call('POST', `/api/measurements/${mE}/correct`, {
    startDate: d1, startTime: '09:00', endDate: d1, endTime: '12:00',
    actualLux: 100, reason: '与封存并发的纠错',
  }, 'c');
  const [sealRes, correctRes] = await Promise.all([sealCall, correctCall]);

  // 两个写操作都应成功（各自串行化），其中一个先拿到展品锁、另一个后拿到
  assert(sealRes.status === 201, `并发封存成功（实际 ${sealRes.status} ${JSON.stringify(sealRes.body && sealRes.body.error)}）`);
  assert([200, 409].includes(correctRes.status), '并发纠错返回 200 或纠错后超限的 409');

  const s = sealRes.body.sealed;
  // 恒等：合计 = 实测 + 残余（若混入变动前后，该恒等可能被破坏）
  assert(Math.abs(s.totalLxh - (s.confirmedLxh + s.residueLxh)) < 1e-6,
    `账册合计恒等：${s.totalLxh} = ${s.confirmedLxh} + ${s.residueLxh}`);
  const matchesBefore = s.confirmedLxh === BEFORE.confirmed && s.residueLxh === BEFORE.residue &&
    s.totalLxh === BEFORE.total;
  const matchesAfter = s.confirmedLxh === AFTER.confirmed && s.residueLxh === AFTER.residue &&
    s.totalLxh === AFTER.total;
  assert(matchesBefore || matchesAfter,
    `封存快照只可能是变动前(${JSON.stringify(BEFORE)})或变动后(${JSON.stringify(AFTER)})一致状态，实际 ` +
    JSON.stringify({ confirmed: s.confirmedLxh, residue: s.residueLxh, total: s.totalLxh }));
  // 账册内逐项来源之和也必须与合计一致（防止来源层混入）
  const itemSum = sealRes.body.ledger.sources.reduce((a, it) => a + it.doseLxh, 0);
  assert(Math.abs(itemSum - s.totalLxh) < 1e-6,
    `账册逐项来源之和 ${itemSum} 等于合计 ${s.totalLxh}（无前后数据混入）`);

  // =======================================================================
  // 9. 封存不影响既有审批/实测流程：封存年后仍可批准新计划、录入实测
  // =======================================================================
  const ex6 = await createExhibit('封存后流程展品');
  await call('POST', `/api/exhibits/${ex6}/limits`, { year: py, limitLxh: 50000 }, 'c');
  const planF0 = await submitPlan(ex6, '封存年计划', d1, d1, ['09:00-12:00'], 100); // 300
  await approve(planF0);
  r = await call('POST', `/api/exhibits/${ex6}/ledgers`, { year: py }, 'c');
  assert(r.status === 201 && r.body.sealed.totalLxh === 300, '封存合计 300');
  // 封存后仍可对该年补批计划（占用变化照常生效，旧账不变）
  const planF1 = await submitPlan(ex6, '封存后补批计划', d2, d2, ['09:00-12:00'], 100); // 300
  await approve(planF1);
  await addMeas(planF1, d2, '09:00', '10:00', 200); // 200 实测替代
  r = await call('GET', `/api/exhibits/${ex6}/ledgers/${py}`, null, 'c');
  assert(r.body.sealed.totalLxh === 300, '旧账仍为封存时 300');
  // 当前：planF0 残余 300 + planF1 实测 200 + planF1 残余 200(2h*100) = 700
  assert(r.body.current.totalLxh === 700, `封存后补占用当前合计 700，实际 ${r.body.current.totalLxh}`);
  assert(r.body.differences.totalDifference === 400, '合计差额 +400');

  // =======================================================================
  // 10. 审计
  // =======================================================================
  r = await call('GET', '/api/audit?limit=2000', null, 'c');
  assert(r.body.events.some((e) => e.action === 'ledger.seal' &&
    Number(e.target_id) === sealResp.ledger.id), '操作流水记录账册封存 ledger.seal');
}

main().catch((err) => {
  console.error('账册封存专项测试失败:', err);
  process.exit(1);
});
