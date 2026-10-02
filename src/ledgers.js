'use strict';

/*
 * 年度账册封存（annual ledger sealing）。
 *
 * 保管员可按展品与“已结束的自然年”封存用光账册。封存沿用现有固定时区（config.tzOffsetMs）
 * 与既有剂量口径（见 service.computeOccupancy）：
 *   合计 = 已确认实测剂量 + 各已批准/待复核计划“开灯窗 − 已确认实测覆盖 − 本计划停灯”的估算残余。
 * 账册原子记录：当年上限、已确认实测、各计划扣除实测覆盖与停灯后的估算残余、合计及逐项来源。
 *
 * 不变量：
 *  - 未登记上限、年份未结束（当前墙上自然年及未来年）一律 400 拒绝；
 *  - 已封存同年再次提交 409 拒绝，旧账永不覆盖（DB 层 (exhibit_id, year) 唯一约束兜底）；
 *  - 封存本身只是快照，不改变任何占用/计划/实测/上限；
 *  - 封存后实测纠错、计划状态或上限变化仍按既有流程生效，旧账不可改；
 *  - 查询账册时按“当前数据”重算同年值，给出上限/合计差额与按来源编号对齐的逐项差额，
 *    已消失来源仍列出（currentDose=null，状态 disappeared），零差额明确标示（zeroDifference=true）。
 * 封存与同展品占用变动经 withExhibitTransaction 的同一展品锁串行化，账册不会混入变动前后的数据。
 */

const { ValidationError, ConflictError } = require('./validation');
const { computeOccupancy, dateYmd } = require('./service');
const { round3, yearOfTs } = require('./dosing');
const config = require('./config');

/** 来源对齐键：实测与计划 id 各自独立，按 kind+id 对齐。 */
function sourceKey(kind, id) {
  return `${kind}:${Number(id)}`;
}

/** 展品在某自然年墙上时间所属年份（按现有固定时区口径）。 */
function currentWallYear(nowMs = Date.now()) {
  return yearOfTs(nowMs);
}

/** JSONB 读出兼容：真实 pg 给对象/数组，pg-mem 可能给字符串。 */
function parseJsonb(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (_) {
      return fallback;
    }
  }
  return value;
}

/**
 * 取某展品某年“当前口径”的封存快照（不写库）。
 * 口径与 computeOccupancy 完全一致：
 *  - sources 直接采用占用计算的逐项来源（已确认实测 + 各占用计划的估算残余）；
 *  - 仅保留在该年剂量非 0 的来源（剂量为 0 的覆盖/扣减后残余不构成账册来源）；
 *  - 停灯信息仅作为该年扣减合计留存，账册合计中不重复加（残余已扣停灯）。
 * 返回 { exhibitId, year, limitLxh, confirmedLxh, residueLxh, totalLxh,
 *        blackoutDeductionLxh, items, occupancy }。
 */
async function buildYearSnapshot(client, exhibitId, year) {
  const yearStr = String(year);
  const occupancy = await computeOccupancy(client, exhibitId);
  const limitLxh = occupancy.limits[yearStr];
  if (limitLxh === undefined || limitLxh === null) {
    throw new ValidationError(`${year} 年尚未登记年度上限，不能封存该年账册`);
  }

  const items = [];
  let confirmedLxh = 0;
  let residueLxh = 0;
  let blackoutDeductionLxh = 0;

  // 来源顺序与占用查询一致：先实测、后计划（computeOccupancy 内部即此顺序），再按 id 稳定。
  for (const s of occupancy.sources) {
    const dose = round3(s.yearly[yearStr] || 0);
    if (s.kind === 'measurement') {
      if (dose <= 0) continue;
      confirmedLxh = round3(confirmedLxh + dose);
      items.push({
        sourceKey: sourceKey('measurement', s.id),
        kind: 'measurement',
        id: Number(s.id),
        planId: Number(s.planId),
        label: `实测 #${s.id}`,
        start: s.start,
        end: s.end,
        lux: s.lux,
        doseLxh: dose,
        yearly: { [yearStr]: dose },
      });
    } else {
      // plan
      if (dose <= 0) continue;
      residueLxh = round3(residueLxh + dose);
      items.push({
        sourceKey: sourceKey('plan', s.id),
        kind: 'plan',
        id: Number(s.id),
        title: s.title,
        status: s.status,
        startDate: dateYmd(s.startDate),
        endDate: dateYmd(s.endDate),
        periods: Array.isArray(s.periods) ? s.periods : parseJsonb(s.periods, []),
        lux: s.lux,
        doseLxh: dose,
        yearly: { [yearStr]: dose },
      });
    }
  }

  // 该年停灯估算扣减合计（仅 deductionActive 的记录计入；与各计划残余口径一致）
  for (const b of occupancy.blackouts || []) {
    if (b.deductionActive === false) continue;
    blackoutDeductionLxh = round3(blackoutDeductionLxh + (b.yearly[yearStr] || 0));
  }

  const totalLxh = round3(confirmedLxh + residueLxh);
  return {
    exhibitId: Number(exhibitId),
    year,
    limitLxh: round3(limitLxh),
    confirmedLxh,
    residueLxh,
    totalLxh,
    blackoutDeductionLxh,
    items,
    occupancy,
  };
}

/**
 * 封存账册（由路由在展品锁事务内、已持有展品行锁后调用）。
 * 校验：年份为已结束自然年；该年已登记上限；同年尚未封存。
 * 成功原子写入 annual_ledgers 并返回账册行（含封存人姓名）。
 */
async function sealYearLedger(client, exhibitId, year, actor, { nowMs = Date.now() } = {}) {
  if (!Number.isInteger(year) || year < 1900 || year > 2999) {
    throw new ValidationError('年份必须是 1900-2999 之间的整数');
  }
  if (year >= currentWallYear(nowMs)) {
    throw new ValidationError(
      `${year} 年尚未结束，只能封存已结束自然年的账册（当前墙上自然年为 ${currentWallYear(nowMs)} 年）`
    );
  }

  const existing = await client.query(
    'SELECT id FROM annual_ledgers WHERE exhibit_id = $1 AND year = $2',
    [exhibitId, year]
  );
  if (existing.rows.length > 0) {
    throw new ConflictError(
      `展品 #${exhibitId} ${year} 年账册已封存（账册 #${existing.rows[0].id}），账册永久保留，重复提交不会覆盖旧账`,
      { existingLedgerId: Number(existing.rows[0].id), exhibitId: Number(exhibitId), year }
    );
  }

  const snapshot = await buildYearSnapshot(client, exhibitId, year);

  let inserted;
  try {
    inserted = await client.query(
      `INSERT INTO annual_ledgers
         (exhibit_id, year, limit_lxh, confirmed_lxh, residue_lxh, total_lxh,
          sources, blackout_deduction_lxh, tz_offset_minutes, sealed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10)
       RETURNING *`,
      [
        exhibitId,
        year,
        snapshot.limitLxh,
        snapshot.confirmedLxh,
        snapshot.residueLxh,
        snapshot.totalLxh,
        JSON.stringify(snapshot.items),
        snapshot.blackoutDeductionLxh,
        config.tzOffsetMinutes,
        actor.userId,
      ]
    );
  } catch (err) {
    // 唯一约束兜底：同年账册已存在（正常路径已先查，此处防御绕过应用锁的并发）
    if (err && (err.code === '23505' || /unique|duplicate/i.test(String(err.message)))) {
      const dup = await client.query(
        'SELECT id FROM annual_ledgers WHERE exhibit_id = $1 AND year = $2',
        [exhibitId, year]
      );
      throw new ConflictError(
        `展品 #${exhibitId} ${year} 年账册已封存（账册 #${dup.rows[0] ? dup.rows[0].id : '?'}），账册永久保留，重复提交不会覆盖旧账`,
        { existingLedgerId: dup.rows[0] ? Number(dup.rows[0].id) : null, exhibitId: Number(exhibitId), year }
      );
    }
    throw err;
  }
  const row = inserted.rows[0];

  return hydrateLedgerRow(client, row);
}

/** 给账册行附加封存人姓名与解析后的 sources。 */
async function hydrateLedgerRow(client, row) {
  let sealedByName = null;
  if (row.sealed_by) {
    const u = await client.query('SELECT display_name FROM users WHERE id = $1', [row.sealed_by]);
    sealedByName = u.rows[0] ? u.rows[0].display_name : null;
  }
  return serializeLedgerRow(row, { sealedByName });
}

/** 账册行 -> 对外字段（驼峰）。sealedByName 可由调用方补充。 */
function serializeLedgerRow(row, { sealedByName = null } = {}) {
  return {
    id: Number(row.id),
    exhibitId: Number(row.exhibit_id),
    year: Number(row.year),
    sealedLimitLxh: round3(Number(row.limit_lxh)),
    sealedConfirmedLxh: round3(Number(row.confirmed_lxh)),
    sealedResidueLxh: round3(Number(row.residue_lxh)),
    sealedTotalLxh: round3(Number(row.total_lxh)),
    sealedBlackoutDeductionLxh: round3(Number(row.blackout_deduction_lxh || 0)),
    sources: parseJsonb(row.sources, []),
    tzOffsetMinutes: Number(row.tz_offset_minutes),
    sealedBy: row.sealed_by != null ? Number(row.sealed_by) : null,
    sealedByName,
    sealedAt: row.sealed_at,
  };
}

/** 取单件展品的全部封存账册（按年份倒序）。 */
async function listLedgers(client, exhibitId) {
  const { rows } = await client.query(
    'SELECT * FROM annual_ledgers WHERE exhibit_id = $1 ORDER BY year DESC, id DESC',
    [exhibitId]
  );
  const out = [];
  for (const row of rows) out.push(await hydrateLedgerRow(client, row));
  return out;
}

/** 取单件展品某年账册（无则 null）。 */
async function getLedger(client, exhibitId, year) {
  const { rows } = await client.query(
    'SELECT * FROM annual_ledgers WHERE exhibit_id = $1 AND year = $2',
    [exhibitId, year]
  );
  return rows.length === 0 ? null : hydrateLedgerRow(client, rows[0]);
}

/**
 * 按来源编号对齐封存快照项与当前快照项。
 * 返回逐项数组，每项：
 *   { sourceKey, kind, id, label/title..., status,
 *     sealedDose, currentDose, difference, zeroDifference,
 *     sealed: <封存项或null>, current: <当前项或null> }
 * status: unchanged 两边都在且剂量相同 / changed 两边都在但剂量不同 /
 *         disappeared 封存时有、当前无贡献 / new 当前有贡献、封存时无。
 */
function diffSourceItems(sealedItems, currentItems) {
  const sealedMap = new Map(sealedItems.map((it) => [it.sourceKey, it]));
  const currentMap = new Map(currentItems.map((it) => [it.sourceKey, it]));
  const keys = new Set([...sealedMap.keys(), ...currentMap.keys()]);

  const describe = (it) => ({
    sourceKey: it.sourceKey,
    kind: it.kind,
    id: it.id,
    planId: it.planId != null ? Number(it.planId) : null,
    label: it.kind === 'measurement'
      ? (it.label || `实测 #${it.id}`)
      : `计划 #${it.id}「${it.title || ''}」`,
    start: it.start || null,
    end: it.end || null,
    lux: it.lux != null ? it.lux : null,
    title: it.title || null,
    status: it.status || null,
    startDate: it.startDate || null,
    endDate: it.endDate || null,
    periods: it.periods || null,
  });

  const out = [];
  for (const key of keys) {
    const sealed = sealedMap.get(key) || null;
    const current = currentMap.get(key) || null;
    const sealedDose = sealed ? round3(sealed.doseLxh) : null;
    const currentDose = current ? round3(current.doseLxh) : null;
    let status;
    let difference;
    if (sealed && current) {
      difference = round3(currentDose - sealedDose);
      status = difference === 0 ? 'unchanged' : 'changed';
    } else if (sealed) {
      difference = round3(0 - sealedDose);
      status = 'disappeared';
    } else {
      difference = round3(currentDose);
      status = 'new';
    }
    out.push({
      ...describe(current || sealed),
      status,
      sealedDose,
      currentDose,
      difference,
      zeroDifference: difference === 0,
      sealed,
      current,
    });
  }

  // 实测在前、计划在后；各自按 id 升序，便于逐项核对
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'measurement' ? -1 : 1;
    return a.id - b.id;
  });
  return out;
}

/**
 * 账册对比视图：封存值 + 按当前数据重算的同年值 + 顶层差额 + 逐项差额。
 * 返回 { ledger, sealed, current, differences }：
 *  - sealed / current 各含 { limitLxh, confirmedLxh, residueLxh, totalLxh, blackoutDeductionLxh }；
 *  - differences 含 limitDifference / totalDifference / confirmedDifference / residueDifference
 *    及逐项 items、allZero（顶层差额全为 0）、allItemDifferencesZero。
 */
async function buildLedgerView(client, ledger, { nowMs = Date.now() } = {}) {
  const exhibitId = Number(ledger.exhibitId);
  const year = Number(ledger.year);

  const snapshot = await buildYearSnapshot(client, exhibitId, year);
  void nowMs;

  const sealed = {
    limitLxh: ledger.sealedLimitLxh,
    confirmedLxh: ledger.sealedConfirmedLxh,
    residueLxh: ledger.sealedResidueLxh,
    totalLxh: ledger.sealedTotalLxh,
    blackoutDeductionLxh: ledger.sealedBlackoutDeductionLxh,
  };
  const current = {
    limitLxh: snapshot.limitLxh,
    confirmedLxh: snapshot.confirmedLxh,
    residueLxh: snapshot.residueLxh,
    totalLxh: snapshot.totalLxh,
    blackoutDeductionLxh: snapshot.blackoutDeductionLxh,
  };

  const limitDifference = round3(current.limitLxh - sealed.limitLxh);
  const confirmedDifference = round3(current.confirmedLxh - sealed.confirmedLxh);
  const residueDifference = round3(current.residueLxh - sealed.residueLxh);
  const totalDifference = round3(current.totalLxh - sealed.totalLxh);
  const blackoutDeductionDifference =
    round3(current.blackoutDeductionLxh - sealed.blackoutDeductionLxh);

  const items = diffSourceItems(ledger.sources, snapshot.items);
  const scalarZero =
    limitDifference === 0 &&
    totalDifference === 0 &&
    confirmedDifference === 0 &&
    residueDifference === 0 &&
    blackoutDeductionDifference === 0;
  const itemsZero = items.every((it) => it.zeroDifference);

  return {
    ledger,
    sealed,
    current,
    differences: {
      limitDifference,
      totalDifference,
      confirmedDifference,
      residueDifference,
      blackoutDeductionDifference,
      allZero: scalarZero,
      allItemDifferencesZero: itemsZero,
      items,
    },
  };
}

module.exports = {
  sourceKey,
  currentWallYear,
  buildYearSnapshot,
  sealYearLedger,
  serializeLedgerRow,
  listLedgers,
  getLedger,
  hydrateLedgerRow,
  diffSourceItems,
  buildLedgerView,
};
