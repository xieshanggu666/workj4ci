/**
 * 赛事事故与保险理赔 功能验证
 * （投保 / 报案 / 定损 / 赔付 / 拒赔幂等 / 租约押金联动 / 自有艇损伤 / 声望救济 /
 *  跨赛季老保单快照承保 / 衔接阻塞 / 作废比赛对称冲回）
 *
 * 用法：node server/test-insurance.mjs（需要 Node ≥22.5 的 node:sqlite）
 * 在临时目录里起一份独立 DB 与独立端口的真实服务，跑完即销毁，不污染开发库。
 * 通过 SKY_FORCE_ACCIDENT / SKY_FORCE_FAULT 强制每场出指定类型事故（仅测试使用）。
 */
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { mkdtempSync, cpSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let pass = 0
const ok = (name, cond) => { assert.ok(cond, name); pass++; console.log(`  ✅ ${name}`) }
const eq = (name, a, b) => { assert.equal(a, b, `${name}（期望 ${b}，实际 ${a}）`); pass++; console.log(`  ✅ ${name}`) }

function api(port, p, opts) { return fetch(`http://127.0.0.1:${port}${p}`, opts).then(r => r.json()) }
const post = (port, p, b) => api(port, p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined })

function makeSandbox() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sky-ins-'))
  cpSync(path.join(__dirname, 'db.js'), path.join(dir, 'db.js'))
  cpSync(path.join(__dirname, 'index.js'), path.join(dir, 'index.js'))
  symlinkSync(path.join(__dirname, '..', 'node_modules'), path.join(dir, 'node_modules'), 'dir')
  return dir
}
function startServer(dir, port, env = {}) {
  return spawn(process.execPath, ['index.js'], { cwd: dir, env: { ...process.env, PORT: String(port), ...env }, stdio: 'ignore' })
}
async function waitReady(port) {
  for (let i = 0; i < 100; i++) {
    try { const s = await api(port, '/api/state'); if (s?.team) return s } catch { /* wait */ }
    await sleep(80)
  }
  throw new Error('server not ready')
}
// 打一站并结算（事故由环境变量强制）
async function playStation(port, cid) {
  const started = await post(port, `/api/races/start/${cid}`, {})
  assert.ok(started.ok, `第 ${cid} 站开赛失败：${started.msg || ''}`)
  const settled = await post(port, `/api/races/${started.race.id}/settle`, {})
  assert.ok(settled.ok, `第 ${cid} 站结算失败：${settled.msg || ''}`)
  return { started, settled }
}
// 报案 → 定损 → 赔付 全流程，返回各步响应
async function claimFullFlow(port, raceId) {
  const rep = await post(port, `/api/insurance/claims/report/${raceId}`)
  assert.ok(rep.ok, `报案失败：${rep.msg || ''}`)
  const ass = await post(port, `/api/insurance/claims/${rep.claim.id}/assess`)
  assert.ok(ass.ok, `定损失败：${ass.msg || ''}`)
  if (ass.claim.status !== 'assessed') return { rep, ass, pay: null }
  const pay = await post(port, `/api/insurance/claims/${rep.claim.id}/pay`)
  assert.ok(pay.ok, `赔付失败：${pay.msg || ''}`)
  return { rep, ass, pay }
}

/* ============ 场景 A：投保边界 + 自有艇事故报案定损赔付全流程 + 幂等 + 声望救济 ============ */
async function scenarioA() {
  console.log('\n[场景 A] 自有艇事故：投保 → 对手责任事故 → 全额定损 → 赔付入账/声望救济，各步幂等')
  const PORT = 4421
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT, { SKY_FORCE_ACCIDENT: '1', SKY_FORCE_FAULT: 'rival' })
    const s0 = await waitReady(PORT)
    eq('初始无保单', s0.insurance.current, null)
    const bad = await post(PORT, '/api/insurance/buy', { id: 99 })
    eq('非法方案拒绝投保', bad.ok, false)
    const buy = await post(PORT, '/api/insurance/buy', { id: 3 }) // 全险：4500 / 100% / 0免赔 / 100%声望
    ok('投保成功', buy.ok)
    const buyAgain = await post(PORT, '/api/insurance/buy', { id: 1 })
    eq('同季重复投保 409', buyAgain.ok, false)
    const s1 = await api(PORT, '/api/state')
    eq('投保即扣保费', s1.team.money, s0.team.money - 4500)
    eq('保单快照为本季 active', s1.insurance.current.status, 'active')

    const { started, settled } = await playStation(PORT, 1)
    const acc = started.race.record.accident
    ok('本场确定发生事故', !!acc)
    eq('事故责任=对手', acc.fault, 'rival')
    eq('结算响应携带事故视图', settled.accident?.insurable, true)
    eq('事故视图带保单名', settled.accident.policyName, '云盾·全险护航')
    const wear = started.race.record.result.wear
    const wearBase = started.race.record.result.wearBase
    eq('总磨损=常规+事故', wear, wearBase + acc.damage)
    const s2 = await api(PORT, '/api/state')
    eq('自有艇按总磨损扣健康', s2.airship.parts_dur, 100 - wear)
    // 第 1 站夺冠即 25 分，合约1（积分≥12）在结算事务内兑现 +8 声望；比赛净声望 + 合约声望
    const contractRep = s2.contracts.filter(c => c.earned).reduce((a, c) => a + c.rep, 0)
    eq('结算声望=比赛净声望（已扣事故损失）+当场合约声望',
      s2.team.rep, s1.team.rep + settled.race.record.result.repGain + contractRep)

    // 无事故比赛不能报案（后续站无强制环境也有随机事故风险，故只校验本场相关非法分支）
    const noPolicyReport = await post(PORT, '/api/insurance/claims/report/99999')
    eq('不存在比赛报案 404 语义', noPolicyReport.ok, false)

    const rep = await post(PORT, `/api/insurance/claims/report/${started.race.id}`)
    ok('报案成功', rep.ok && !rep.already)
    eq('报案预估损失=事故损伤×自有艇维修单价25', rep.claim.loss, acc.damage * 25)
    eq('报案登记损伤点数', rep.claim.damage, acc.damage)
    const rep2 = await post(PORT, `/api/insurance/claims/report/${started.race.id}`)
    ok('重复报案幂等', rep2.already)

    const ass = await post(PORT, `/api/insurance/claims/${rep.claim.id}/assess`)
    eq('对手责任免赔额为 0', ass.claim.deductible, 0)
    ok('定损系数后核定损失 ≤ 报案预估', ass.claim.assessedLoss <= rep.claim.loss)
    eq('全险赔付比例 100%', ass.claim.payable, ass.claim.assessedLoss)
    const ass2 = await post(PORT, `/api/insurance/claims/${rep.claim.id}/assess`)
    ok('重复定损幂等', ass2.already && ass2.claim.payable === ass.claim.payable)

    const mBefore = (await api(PORT, '/api/state')).team
    const pay = await post(PORT, `/api/insurance/claims/${rep.claim.id}/pay`)
    eq('赔付到账=定损应付', pay.payout, ass.claim.payable)
    eq('全险声望救济=全部事故损失', pay.repRelief, acc.repLoss)
    const mAfter = await api(PORT, '/api/state')
    eq('资金只增加一次赔付', mAfter.team.money, mBefore.money + ass.claim.payable)
    eq('声望救济到账', mAfter.team.rep, mBefore.rep + acc.repLoss)
    const pay2 = await post(PORT, `/api/insurance/claims/${rep.claim.id}/pay`)
    ok('重复领取赔付幂等、不二次打款', pay2.already)
    const s3 = await api(PORT, '/api/state')
    eq('幂等重放资金不变', s3.team.money, mAfter.team.money)
    eq('理赔单终态=paid', s3.insurance.claims[0].status, 'paid')
    eq('已赔事故不再出现在待报案', s3.insurance.pendingAccidents.some(p => p.raceId === started.race.id), false)
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ============ 场景 B：己方责任免赔额导致拒赔 ============ */
async function scenarioB() {
  console.log('\n[场景 B] 己方责任 + 基础险免赔额：轻微事故定损后净额为 0，拒赔为终态')
  const PORT = 4422
  const dir = makeSandbox()
  let proc
  try {
    // 基础险：60% 赔付 / 免赔 800；轻微事故 4-8 点 ×25 = 100~200，必然免赔
    proc = startServer(dir, PORT, { SKY_FORCE_ACCIDENT: 'light', SKY_FORCE_FAULT: 'pilot' })
    await waitReady(PORT)
    await post(PORT, '/api/insurance/buy', { id: 1 })
    const { started } = await playStation(PORT, 1)
    const acc = started.race.record.accident
    eq('事故为己方责任', acc.fault, 'pilot')
    ok('轻微事故预估损失低于免赔额', acc.damage * 25 < 800)
    const { rep, ass, pay } = await claimFullFlow(PORT, started.race.id)
    eq('定损结论为拒赔', ass.claim.status, 'rejected')
    eq('拒赔赔付额为 0', ass.claim.payable, 0)
    eq('拒赔后不进入赔付环节', pay, null)
    const payOnRejected = await post(PORT, `/api/insurance/claims/${rep.claim.id}/pay`)
    eq('对拒赔单领取赔付被拒绝', payOnRejected.ok, false)
    const assOnRejected = await post(PORT, `/api/insurance/claims/${rep.claim.id}/assess`)
    eq('对拒赔单重新定损被拒绝', assOnRejected.ok, false)
    // 待报案列表不再包含（已有理赔单，虽拒赔）
    const s = await api(PORT, '/api/state')
    eq('拒赔单不进待报案列表', s.insurance.pendingAccidents.some(p => p.raceId === started.race.id), false)
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ============ 场景 C：租约艇事故赔付 → 事故损伤免计押金；在履 / 已归还两种结算 ============ */
async function scenarioC() {
  console.log('\n[场景 C] 租约艇事故：赔付覆盖事故损伤，归还押金只按剩余磨损计费；已归还则补退差额')
  const PORT = 4423
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT, { SKY_FORCE_ACCIDENT: 'medium', SKY_FORCE_FAULT: 'weather' })
    const s0 = await waitReady(PORT)
    await post(PORT, '/api/insurance/buy', { id: 2 }) // 周全：2600 / 80% / 天气免赔0 / 60%声望
    const rent = await post(PORT, '/api/rentals/rent', { id: 1 }) // 雨燕：押金2400 租金600 费率35
    ok('签约雨燕', rent.ok)
    const { started } = await playStation(PORT, 1)
    const acc = started.race.record.accident
    eq('天气不可抗力责任', acc.fault, 'weather')
    eq('开赛快照租约带磨损费率', started.race.record.factors.rental.wearRate, 35)
    let s1 = await api(PORT, '/api/state')
    const wearTotal = s1.rental.wear_total
    eq('租约累计磨损=常规+事故', wearTotal, started.race.record.result.wear)

    const { rep, ass, pay } = await claimFullFlow(PORT, started.race.id)
    eq('天气事故免赔额 0', ass.claim.deductible, 0)
    eq('报案预估=损伤×租约费率35', rep.claim.loss, acc.damage * 35)
    eq('理赔单关联租约', !!rep.claim.rentalId, true)
    const s2 = await api(PORT, '/api/state')
    eq('在履租约登记保险覆盖损伤', s2.rental.insured_wear, acc.damage)
    eq('租约累计磨损不因赔付改变', s2.rental.wear_total, wearTotal)
    const expectedPayout = Math.round(ass.claim.assessedLoss * 0.8)
    eq('赔付=核定净额×80%', pay.payout, expectedPayout)
    eq('声望救济=事故损失×60%', pay.repRelief, Math.round(acc.repLoss * 0.6))

    // 在履状态归还：磨损费基数剔除保险覆盖损伤
    const ret = await post(PORT, '/api/rentals/return', {})
    const billable = wearTotal - acc.damage
    eq('归还磨损费只计剩余磨损', ret.wearFee, billable * 35)
    eq('归还款=押金−磨损费', ret.refund, Math.max(0, 2400 - billable * 35))
    const h1 = (await api(PORT, '/api/state')).rentalHistory[0]
    eq('归还记录保险覆盖点数落库', h1.insured_wear, acc.damage)
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ============ 场景 D：先归还再理赔 → 赔付同时补退押金磨损费 ============ */
async function scenarioD() {
  console.log('\n[场景 D] 租约先归还、事故后理赔：赔付时按覆盖损伤补退已结算押金差额')
  const PORT = 4424
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT, { SKY_FORCE_ACCIDENT: '1', SKY_FORCE_FAULT: 'rival' })
    await waitReady(PORT)
    await post(PORT, '/api/insurance/buy', { id: 3 })
    await post(PORT, '/api/rentals/rent', { id: 1 })
    const { started } = await playStation(PORT, 1)   // 默认 auto：租约艇出赛
    const acc = started.race.record.accident
    await post(PORT, '/api/lineup', { shipMode: 'own' }) // 赛后切自有艇，租约随后可提前归还
    const s1 = await api(PORT, '/api/state')
    const wearTotal = s1.rental.wear_total
    const ret1 = await post(PORT, '/api/rentals/return', {})
    eq('归还时事故损伤仍计入磨损费', ret1.wearFee, wearTotal * 35)
    const refund1 = ret1.refund

    const { ass, pay } = await claimFullFlow(PORT, started.race.id)
    // 补退 = 事故损伤 × 费率（赔付后押金计费基数下调）
    eq('补退押金=事故损伤×费率', pay.rentalRefund, acc.damage * 35)
    eq('赔付总额=理赔款+押金补退', pay.payout, ass.claim.payable + acc.damage * 35)
    const s2 = await api(PORT, '/api/state')
    const h = s2.rentalHistory[0]
    eq('租约行磨损费下调', h.wear_fee, (wearTotal - acc.damage) * 35)
    eq('租约行退款上调', h.refund, refund1 + acc.damage * 35)
    eq('租约行保险覆盖点数', h.insured_wear, acc.damage)

    // 重复赔付不二次补退
    const pay2 = await post(PORT, `/api/insurance/claims/${(await api(PORT, '/api/state')).insurance.claims[0].id}/pay`)
    ok('重复赔付幂等', pay2.already)
    const s3 = await api(PORT, '/api/state')
    eq('幂等后资金不变', s3.team.money, s2.team.money)
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ============ 场景 E：赛季衔接——未决理赔阻塞；保单过期但老事故仍可凭快照理赔 ============ */
async function scenarioE() {
  console.log('\n[场景 E] 赛季衔接：未决理赔阻塞衔接；衔接后老保单 expired，老赛季事故仍可报案理赔')
  const PORT = 4425
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT, { SKY_FORCE_ACCIDENT: '1', SKY_FORCE_FAULT: 'rival' })
    await waitReady(PORT)
    await post(PORT, '/api/insurance/buy', { id: 3 })
    // 前 5 站全部事故且当场了结理赔（不留下未决单）
    for (let cid = 1; cid <= 5; cid++) {
      const { started } = await playStation(PORT, cid)
      await claimFullFlow(PORT, started.race.id)
    }
    // 第 6 站事故只报案、不定损——未决理赔必须阻塞衔接
    const { started } = await playStation(PORT, 6)
    const rep = await post(PORT, `/api/insurance/claims/report/${started.race.id}`)
    ok('第 6 站事故已报案', rep.ok)
    const blocked = await post(PORT, '/api/seasons/advance', {})
    eq('存在未决理赔时拒绝衔接', blocked.ok, false)
    // 定损但不领取——仍阻塞
    await post(PORT, `/api/insurance/claims/${rep.claim.id}/assess`)
    const blocked2 = await post(PORT, '/api/seasons/advance', {})
    eq('定损未赔付仍拒绝衔接', blocked2.ok, false)
    await post(PORT, `/api/insurance/claims/${rep.claim.id}/pay`)
    const adv = await post(PORT, '/api/seasons/advance', {})
    ok('理赔了结后衔接成功', adv.ok && !adv.already)
    eq('衔接摘要含本季理赔统计', adv.summary.insurance.claims, 6)
    const s2 = await api(PORT, '/api/state')
    eq('新赛季无生效保单（老保单已过期）', s2.insurance.current, null)
    eq('老理赔单全部保留', s2.insurance.claims.length, 6)
    ok('老理赔单均为 paid 终态', s2.insurance.claims.every(c => c.status === 'paid'))

    // 新赛季第 1 站不投保出事故（环境强制），不能报案
    const ns = await playStation(PORT, 1)
    ok('新赛季比赛同样有事故', !!ns.started.race.record.accident)
    eq('未投保比赛无保单快照', ns.started.race.record.factors.policy, null)
    const noIns = await post(PORT, `/api/insurance/claims/report/${ns.started.race.id}`)
    eq('无保单事故拒绝报案', noIns.ok, false)

    // 老赛季（season=1）已结算事故…… 都已报案；另验证 expired 保单快照仍可承保老事故：
    // 直接给第 2 季新比赛补一个老赛季保单快照不可能；改为核对老事故报案走快照口径——
    // 取一条老比赛，删除其理赔单模拟「未及时报案」，凭 expired 保单快照仍应能走完理赔
    proc.kill('SIGKILL'); await sleep(150); proc = null
    const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
    const oldRace = dbh.prepare("SELECT r.id FROM races r JOIN insurance_claims c ON c.race_id=r.id WHERE r.season=1 ORDER BY r.id LIMIT 1").get()
    dbh.prepare('DELETE FROM insurance_claims WHERE race_id=?').run(oldRace.id)
    dbh.prepare("UPDATE insurance_policies SET status='expired'").run() // 幂等确认已是 expired
    dbh.close()
    proc = startServer(dir, PORT, { SKY_FORCE_ACCIDENT: '1', SKY_FORCE_FAULT: 'rival' })
    await waitReady(PORT)
    const late = await post(PORT, `/api/insurance/claims/report/${oldRace.id}`)
    ok('老保单过期后老事故仍可凭快照报案', late.ok)
    const ass = await post(PORT, `/api/insurance/claims/${late.claim.id}/assess`)
    ok('老快照口径定损成功', ass.ok)
    const pay = await post(PORT, `/api/insurance/claims/${late.claim.id}/pay`)
    ok('老快照口径赔付成功', pay.ok)
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ============ 场景 F：作废比赛（越站修复）→ 已领取赔付对称冲回，重启幂等 ============ */
async function scenarioF() {
  console.log('\n[场景 F] 越站作废比赛的已赔付理赔：资金/声望对称冲回，租约磨损重算，重启幂等')
  const PORT = 4426
  const dir = makeSandbox()
  let proc
  try {
    proc = startServer(dir, PORT)
    await waitReady(PORT)
    proc.kill('SIGKILL'); await sleep(150); proc = null
    const dbh = new DatabaseSync(path.join(dir, 'sky.db'))
    // 越站赛站 4：自有艇事故（损伤10），比赛奖金1500/积分18/净声望3，保险已赔 250/救济3
    const record = {
      v: 1, season: 1, circuit: { id: 4, name: '风暴裂谷', weather: '雨' },
      factors: { weather: '雨', rental: null, policy: { id: 1, planId: 3, name: '全险', premium: 4500, cover: 100, deductible: 0, repRelief: 100 }, pilot: { id: 1 } },
      accident: { severity: 'medium', severityLabel: '中度碰撞', fault: 'rival', faultLabel: '对手责任', segIdx: 1, segName: '中段云流', part: '龙骨', rival: '雷鸣环驾', damage: 10, repLoss: 3, text: 'x' },
      result: { rank: 2, pts: 18, money: 1500, wear: 19, wearBase: 9, accidentWear: 10, repGain: 3, repGainBase: 6, repLoss: 3 }
    }
    const ins = dbh.prepare(`INSERT INTO races (circuit_id,season,status,settled,record,watch_el,created_at,settled_at,rank,pts,money,wear,rep_gain)
      VALUES (4,1,'settled',1,?,0,'t0','t1',2,18,1500,19,3)`).run(JSON.stringify(record))
    const rid = Number(ins.lastInsertRowid)
    dbh.prepare(`INSERT INTO insurance_claims (race_id,season,policy_id,rental_id,severity,fault,damage,rep_loss,loss,assessed_loss,deductible,payable,payout,rep_relief,status,created_at,assessed_at,paid_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'paid','t0','t1','t2')`)
      .run(rid, 1, 1, null, 'medium', 'rival', 10, 3, 250, 250, 0, 250, 250, 3)
    dbh.prepare('INSERT INTO race_log (circuit_id,race_id,season,rank,pts,money,note,ts) VALUES (4,?,1,2,18,1500,?,?)')
      .run(rid, '脏流水', 't1')
    dbh.prepare('UPDATE circuits SET finished=1, rank=2 WHERE id=4').run()
    // 已发奖状态：奖金 1500 + 赔付 250；声望比赛 3 + 救济 3
    dbh.prepare('UPDATE team SET money=money+1500+250, rep=rep+3+3 WHERE id=1').run()
    const t0 = dbh.prepare('SELECT * FROM team').get()
    dbh.close()

    proc = startServer(dir, PORT)
    const s1 = await waitReady(PORT)
    eq('越站修复冲回奖金与赔付', s1.team.money, t0.money - 1500 - 250)
    eq('越站修复冲回比赛声望与救济', s1.team.rep, t0.rep - 3 - 3)
    eq('越站赛站重新开放', s1.circuits[3].finished, 0)
    const cl = s1.insurance.claims.find(c => c.raceId === rid)
    eq('赔付理赔单置 reversed', cl.status, 'reversed')
    eq('作废比赛不进历史', s1.races.some(r => r.id === rid), false)

    proc.kill('SIGKILL'); await sleep(150); proc = null
    proc = startServer(dir, PORT)
    const s2 = await waitReady(PORT)
    ok('重启资金不变（冲回幂等）', s2.team.money === s1.team.money)
    ok('重启声望不变', s2.team.rep === s1.team.rep)
    ok('重启理赔单仍为 reversed', s2.insurance.claims.every(c => c.status === 'reversed'))
  } finally {
    if (proc) proc.kill('SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
}

const run = async () => {
  await scenarioA(); await scenarioB(); await scenarioC(); await scenarioD(); await scenarioE(); await scenarioF()
  console.log(`\n🎉 全部 ${pass} 项断言通过：投保 / 报案 / 定损 / 赔付 / 押金联动 / 赛季衔接 / 越站冲回一致且幂等`)
}
run().catch(e => { console.error('\n❌ 验证失败：', e); process.exit(1) })
