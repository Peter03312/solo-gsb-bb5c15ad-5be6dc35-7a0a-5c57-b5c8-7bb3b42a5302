'use strict';

/*
 * 年度账册封存路由（挂载于 /api/exhibits/:id/ledgers，见 app.js）。
 *  - GET  /        列出本展品全部封存账册（任何登录用户）
 *  - GET  /:year   取某年封存账册：封存值 + 按当前数据重算的同年值 + 顶层/逐项差额
 *  - POST /        保管员封存某已结束自然年的账册（未登记上限/年份未结束 400，已封存 409）
 * 既有查询字段与审批、实测接口均不改动；账册只附加在展品详情的 ledgers 字段。
 */

const express = require('express');
const { withExhibitTransaction } = require('../db');
const { requireRole } = require('../auth');
const { recordAudit } = require('../audit');
const { ValidationError } = require('../validation');
const {
  sealYearLedger,
  listLedgers,
  getLedger,
  buildLedgerView,
} = require('../ledgers');

const router = express.Router({ mergeParams: true });

router.use(require('../auth').requireAuth);

function exhibitIdFromReq(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('展品 ID 无效');
  return id;
}

/** 列出本展品全部封存账册（按年份倒序）。 */
router.get('/', async (req, res, next) => {
  try {
    const exhibitId = exhibitIdFromReq(req);
    const ledgers = await withExhibitTransaction(exhibitId, async (client) => {
      const ex = await client.query('SELECT id FROM exhibits WHERE id = $1', [exhibitId]);
      if (ex.rows.length === 0) throw new ValidationError('展品不存在');
      return listLedgers(client, exhibitId);
    });
    res.json({ ledgers });
  } catch (err) {
    next(err);
  }
});

/**
 * 封存某年账册（保管员）。
 * body: { year: 2025 }
 * 成功 201：返回 { ledger, sealed, current, differences }（current/differences 为封存当下口径，
 * 差额此时全为 0，便于调用方立即核对原子快照）。
 */
router.post('/', requireRole('conservator'), async (req, res, next) => {
  try {
    const exhibitId = exhibitIdFromReq(req);
    const year = Number((req.body || {}).year);
    if (!Number.isInteger(year) || year < 1900 || year > 2999) {
      throw new ValidationError('年份必须是 1900-2999 之间的整数');
    }

    const result = await withExhibitTransaction(exhibitId, async (client) => {
      const { lockExhibit } = require('../service');
      await lockExhibit(client, exhibitId);
      const ledger = await sealYearLedger(client, exhibitId, year, req.sessionUser);
      await recordAudit(client, req.sessionUser, 'ledger.seal', 'annual_ledger', ledger.id, {
        exhibitId,
        year,
        limitLxh: ledger.sealedLimitLxh,
        confirmedLxh: ledger.sealedConfirmedLxh,
        residueLxh: ledger.sealedResidueLxh,
        totalLxh: ledger.sealedTotalLxh,
        blackoutDeductionLxh: ledger.sealedBlackoutDeductionLxh,
        sourceCount: ledger.sources.length,
        tzOffsetMinutes: ledger.tzOffsetMinutes,
      });
      // 封存后立即按当前数据重算：同事务内数据未变，差额应全为 0
      const view = await buildLedgerView(client, ledger);
      return view;
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * 查看某年封存账册（任何登录用户）：
 * 封存值、按当前数据重算的同年值、上限/合计差额、按来源编号对齐的逐项差额
 * （已消失来源仍列出；零差额明确标示）。
 */
router.get('/:year', async (req, res, next) => {
  try {
    const exhibitId = exhibitIdFromReq(req);
    const year = Number(req.params.year);
    if (!Number.isInteger(year) || year < 1900 || year > 2999) {
      throw new ValidationError('年份必须是 1900-2999 之间的整数');
    }
    const view = await withExhibitTransaction(exhibitId, async (client) => {
      const ledger = await getLedger(client, exhibitId, year);
      if (!ledger) throw new ValidationError(`展品 #${exhibitId} ${year} 年账册尚未封存`);
      return buildLedgerView(client, ledger);
    });
    res.json(view);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
