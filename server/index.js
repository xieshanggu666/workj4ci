import express from 'express'
import { db, run, all, get } from './db.js'

const app = express()
app.use(express.json())
const PORT = Number(process.env.PORT) || 4180
const PTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1]
// 天气对整场比赛的总体系数（用于部件磨损判定等）
const WEATHER = { '晴': 1.0, '风': 0.96, '雨': 0.9, '雾': 0.84, '雷暴': 0.78 }
// 天气对三个分段的发挥系数：雾/雷暴在「中段云流」「冲线段」压制更大
const SEG_WEATHER = {
  '晴':   [1.00, 1.00, 1.00],
  '风':   [0.99, 0.94, 0.96],
  '雨':   [0.94, 0.89, 0.91],
  '雾':   [0.92, 0.80, 0.85],
  '雷暴': [0.88, 0.72, 0.78]
}
// 三个分段：名称 + 四项性能在该段的权重（启航拼加速、中段拼极速转向、冲线拼极速爆发）
const SEGMENTS = [
  { key: 'start', name: '启航段', w: { speed: 0.28, turn: 0.14, acc: 0.30, dur: 0.10 } },
  { key: 'mid', name: '中段云流', w: { speed: 0.38, turn: 0.20, acc: 0.16, dur: 0.14 } },
  { key: 'finish', name: '冲线段', w: { speed: 0.40, turn: 0.14, acc: 0.20, dur: 0.14 } }
]
const SEG_K = 260           // 分段用时换算系数：t = SEG_K / pace（秒）
const AI_NAMES = ['苍穹极光', '翡翠之翼', '雷鸣环驾', '暮色猎手', '星尘漂流']
const AI_COLORS = ['#7ecbff', '#b19cff', '#6fe7d0', '#ff9fb0', '#ffb85c']
const PLAYER_COLOR = '#ffcf5c'
const FLAVOR = {
  '晴': ['晴空暖流，各艇全速巡航', '上升气流托举艇身，编队顺畅通航', '云絮拂面，引擎工况极佳'],
  '风': ['侧风突袭，舵面负荷加大！', '一阵横切气流扫过航线，队形被打乱', '逆风段来临，飞艇纷纷压低航向'],
  '雨': ['雨幕遮蔽视野，编队整体减速', '冰晶打在护甲上噼啪作响', '积雨云边缘湿滑，过弯需格外谨慎'],
  '雾': ['浓雾中能见度骤降，只能凭仪表飞行', '乳白雾气吞没了半个编队', '领航员紧盯着罗盘穿出雾团'],
  '雷暴': ['一道惊雷掠过，护甲承受冲击！', '雷暴电场干扰仪表，航向微微偏移', '闪电点亮云谷，众艇冒死突进']
}
const now = () => new Date().toLocaleString('zh-CN')
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
// 确定性伪随机：同一场比赛的分段过程与事件只生成一次，之后回放永远一致
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/* ================= 零件商店：商品配置（服务端唯一事实来源） =================
 * 客户端只能按 id 下单；名称、槽位、加成项、加成数值与价格一律由服务端从这份配置取值，
 * 请求体中夹带的 price/bonus/stat/slot/name 一律忽略，杜绝「1 元购入 +9999 性能件」
 * 之类越权改写经济与比赛性能的请求。
 */
const VALID_SLOTS = ['引擎', '翼板', '氮气', '龙骨', '护甲']
const VALID_STATS = ['speed', 'turn', 'acc', 'dur']
const SHOP_ITEMS = [
  { id: 1, name: '竞速涡轮', slot: '引擎', stat: 'speed', bonus: 14, price: 2600 },
  { id: 2, name: '流线翼板', slot: '翼板', stat: 'speed', bonus: 9, price: 1800 },
  { id: 3, name: '氮气助推', slot: '氮气', stat: 'acc', bonus: 16, price: 2200 },
  { id: 4, name: '回旋舵', slot: '龙骨', stat: 'turn', bonus: 12, price: 2000 },
  { id: 5, name: '云母护甲', slot: '护甲', stat: 'dur', bonus: 15, price: 2400 },
  { id: 6, name: '轻量合金', slot: '翼板', stat: 'acc', bonus: 11, price: 1900 },
  { id: 7, name: '蓝纹喷射引擎', slot: '引擎', stat: 'speed', bonus: 20, price: 3200 },
  { id: 8, name: '硬壳鳞甲', slot: '护甲', stat: 'dur', bonus: 22, price: 3400 }
]
const SHOP_MAP = new Map(SHOP_ITEMS.map(i => [i.id, i]))
// 启动即自检：非法商品配置应在上线前暴露，而不是等玩家下单
for (const it of SHOP_ITEMS) {
  const ok = VALID_SLOTS.includes(it.slot) && VALID_STATS.includes(it.stat) &&
    Number.isInteger(it.bonus) && it.bonus > 0 && it.bonus <= 100 &&
    Number.isInteger(it.price) && it.price > 0 && typeof it.name === 'string' && it.name.trim()
  if (!ok) throw new Error('[SKY] 商店商品配置非法：' + JSON.stringify(it))
}

/* ================= 飞艇租赁：艇型目录（服务端唯一事实来源） =================
 * 与商店同口径：客户端只能按 id 签约；性能、押金、租金、租约场次与磨损费率一律以这份
 * 配置为准，请求体夹带的任何价格/性能字段都不被采信。押金+租金在签约时一次扣除，
 * 归还时按「累计磨损 × 磨损费率」从押金中结算退款（租金不退）。
 */
const RENTAL_SHIPS = [
  { id: 1, name: '雨燕·轻竞技', speed: 66, turn: 62, acc: 72, dur: 64, deposit: 2400, rent: 600, maxRaces: 2, wearRate: 35 },
  { id: 2, name: '猎鹰·巡航者', speed: 76, turn: 72, acc: 74, dur: 80, deposit: 4500, rent: 1200, maxRaces: 3, wearRate: 50 },
  { id: 3, name: '雷霆·竞速型', speed: 88, turn: 76, acc: 88, dur: 70, deposit: 7200, rent: 2000, maxRaces: 3, wearRate: 65 },
  { id: 4, name: '星凰·旗舰', speed: 97, turn: 91, acc: 93, dur: 90, deposit: 11000, rent: 3200, maxRaces: 4, wearRate: 85 }
]
const RENTAL_MAP = new Map(RENTAL_SHIPS.map(s => [s.id, s]))
for (const s of RENTAL_SHIPS) {
  const ok = ['speed', 'turn', 'acc', 'dur', 'deposit', 'rent', 'maxRaces', 'wearRate']
    .every(k => Number.isInteger(s[k]) && s[k] > 0) && typeof s.name === 'string' && s.name.trim()
  if (!ok) throw new Error('[SKY] 租赁艇型配置非法：' + JSON.stringify(s))
}

/* ================= 赛事保险：方案目录（服务端唯一事实来源） =================
 * 车队每赛季可投保一份赛事险：保费投保即扣不退；保单在开赛瞬间快照进比赛记录，
 * 出事故（report）→ 保险方定损（assess：核定损失、免赔额、赔付比例）→ 领取赔付（pay：
 * 资金到账、声望救济；租约艇事故损伤转为出租方与保险方结算，不再计入押金磨损）。
 *  - cover      : 定损金额赔付比例（%）
 *  - deductible : 免赔额（仅「己方责任」事故扣除；对手责任 / 天气不可抗力全额定损）
 *  - repRelief  : 赔付时恢复的事故声望损失比例（%）
 */
const INSURANCE_PLANS = [
  { id: 1, name: '云盾·基础赛事险', premium: 1200, cover: 60, deductible: 800, repRelief: 30 },
  { id: 2, name: '云盾·周全保障', premium: 2600, cover: 80, deductible: 400, repRelief: 60 },
  { id: 3, name: '云盾·全险护航', premium: 4500, cover: 100, deductible: 0, repRelief: 100 }
]
const INSURANCE_MAP = new Map(INSURANCE_PLANS.map(p => [p.id, p]))
for (const p of INSURANCE_PLANS) {
  const ok = Number.isInteger(p.premium) && p.premium > 0 &&
    Number.isInteger(p.cover) && p.cover > 0 && p.cover <= 100 &&
    Number.isInteger(p.deductible) && p.deductible >= 0 &&
    Number.isInteger(p.repRelief) && p.repRelief >= 0 && p.repRelief <= 100 &&
    typeof p.name === 'string' && p.name.trim()
  if (!ok) throw new Error('[SKY] 保险方案配置非法：' + JSON.stringify(p))
}
// 自有艇事故损伤的维修报价口径（与 /api/maintain 每点 ¥25 一致）；
// 租约艇事故损伤按该场开赛快照租约的 wear_rate 计价（影响押金磨损费）
const OWN_REPAIR_RATE = 25

/* ================= 赛季合约：条款配置（服务端唯一事实来源） =================
 * 取代旧版「固定积分达标」赞助：每份合约由若干条款组成，进度按本赛季已结算比赛
 * （天气 / 最终名次 / 开赛时的租赁艇快照）累计，全部条款（或 need 指定条数）达成后，
 * 在结算事务内一次性兑现资金 + 声望。条款口径与奖励一律由这份配置核定，客户端不可改写。
 *
 * 条款类型：
 *  - points : 赛季积分累计达到 value
 *  - weather: 在 weather 指定天气下完赛 value 场（weather 省略或为 '*' = 任意天气）
 *  - rank   : 取得 rankMax 名以内（含）完赛 value 场（rankMax 省略 = 任意名次）
 *  - rental : 以租赁艇完赛 value 场；ship 指定租赁艇型 id；ship 省略 = 任意租赁艇
 *  - race   : 同一场比赛同时满足 weather/rankMax/ship 条件即计 1 场，value 场（复合条款）
 */
const VALID_TERM_TYPES = ['points', 'weather', 'rank', 'rental', 'race']
const CONTRACT_SEASON = 1
const CONTRACTS = [
  {
    id: 1, name: '云帆工坊 · 积分赞助', note: '赛季积分达标，基础赞助照常兑现',
    terms: [{ type: 'points', value: 12 }],
    reward: 4000, rep: 8
  },
  {
    id: 2, name: '星罗航空 · 全天候完赛', note: '在雨、雾、雷暴的恶劣云况下各完成一场分站赛',
    terms: [
      { type: 'weather', weather: '雨', value: 1 },
      { type: 'weather', weather: '雾', value: 1 },
      { type: 'weather', weather: '雷暴', value: 1 }
    ],
    reward: 8000, rep: 15
  },
  {
    id: 3, name: '流风动力 · 领奖台合约', note: '两次以前三名冲线，或至少一场以租赁艇代赛（任一达成即兑现）',
    need: 1,
    terms: [
      { type: 'rank', rankMax: 3, value: 2 },
      { type: 'rental', value: 1 }
    ],
    reward: 14000, rep: 22
  },
  {
    id: 4, name: '苍穹商会 · 赛季之巅', note: '积分 45 分，并在雷暴云谷租赁旗舰艇夺冠',
    terms: [
      { type: 'points', value: 45 },
      { type: 'race', weather: '雷暴', rankMax: 1, ship: 4, value: 1 }
    ],
    reward: 22000, rep: 32
  }
]
// 条款合法性自检：非法合约配置必须在启动时就暴露，而不是等玩家差一场才发现条款无效
function validateTerms(terms) {
  if (!Array.isArray(terms) || !terms.length) return false
  return terms.every(t => {
    if (!t || typeof t !== 'object' || !VALID_TERM_TYPES.includes(t.type)) return false
    if (!Number.isInteger(t.value) || t.value <= 0) return false
    if ('weather' in t && t.weather !== '*' && !(t.weather in WEATHER)) return false
    if ('rankMax' in t && (!Number.isInteger(t.rankMax) || t.rankMax < 1 || t.rankMax > 6)) return false
    if ('ship' in t && (!Number.isInteger(t.ship) || !RENTAL_MAP.has(t.ship))) return false
    // 天气白名单（不含 '*'）只对天气语义条款有意义；rental/race 额外条件用上面的字段校验
    return true
  })
}
for (const c of CONTRACTS) {
  const ok = typeof c.name === 'string' && c.name.trim() &&
    validateTerms(c.terms) &&
    Number.isInteger(c.reward) && c.reward >= 0 &&
    Number.isInteger(c.rep) && c.rep >= 0 &&
    (c.need === undefined || (Number.isInteger(c.need) && c.need >= 1 && c.need <= c.terms.length))
  if (!ok) throw new Error('[SKY] 赛季合约配置非法：' + JSON.stringify(c))
  c.need = c.need ?? c.terms.length
}

// 新赛季建档：按当前服务端配置为指定赛季复制一份合约（条款为配置快照）。
// 进度不入库，随后由对账按该赛季已结算战绩决定是否立即兑现，天然幂等——
// 仅在该赛季尚无合约时补建（老库升级到第 1 季、新赛季衔接时调用）。
function ensureContracts(season = CONTRACT_SEASON) {
  if (get('SELECT COUNT(*) c FROM contracts WHERE season=?', season).c > 0) return
  CONTRACTS.forEach(c => run(
    'INSERT INTO contracts (name,season,note,terms,need,reward,rep) VALUES (?,?,?,?,?,?,?)',
    c.name, season, c.note || '', JSON.stringify({ v: 1, terms: c.terms }), c.need, c.reward, c.rep))
}
function seed() {
  if (get('SELECT COUNT(*) c FROM team').c > 0) return
  run('INSERT INTO team (name) VALUES (?)', '苍穹疾风战队')
  run('INSERT INTO airships (name) VALUES (?)', '云雀·I').lastInsertRowid
  run('INSERT INTO pilots (name,skill,courage,exp,wage,mood) VALUES (?,?,?,?,?,?)', '奥罗·晨曦', 62, 58, 20, 80, 75)
  run('INSERT INTO pilots (name,skill,courage,exp,wage,mood) VALUES (?,?,?,?,?,?)', '莉娜·云涛', 55, 65, 8, 55, 82)
  run('INSERT INTO mechanics (name,skill,wage,mood) VALUES (?,?,?,?)', '格蕾丝·铆钉', 58, 45, 78)
  const ups = SHOP_ITEMS.map(i => [i.name, i.slot, i.stat, i.bonus, i.price])
  ups.forEach(([n, slot, stat, bonus, price]) => run('INSERT INTO upgrades (name,slot,stat,bonus,price) VALUES (?,?,?,?,?)', n, slot, stat, bonus, price))
  const cir = [['晨雾浮岛','1','雾'],['雷鸣云谷','2','雷暴'],['翡翠群岛','3','晴'],['风暴裂谷','3','雨'],['极光穹顶','4','风'],['星界之巅','5','雾']]
  cir.forEach(([n, d, w]) => run('INSERT INTO circuits (name,diff,weather,bonus_pts) VALUES (?,?,?,?)', n, Number(d), w, Number(d) * 4))
  CONTRACTS.forEach(c => run(
    'INSERT INTO contracts (name,season,note,terms,need,reward,rep) VALUES (?,?,?,?,?,?,?)',
    c.name, CONTRACT_SEASON, c.note || '',
    JSON.stringify({ v: 1, terms: c.terms }), c.need, c.reward, c.rep))
}
export function teamCore() { return get('SELECT * FROM team WHERE id=1') }
export function airship() { return all('SELECT * FROM airships')[0] || { speed: 60, dur: 80, turn: 55, acc: 60, parts_dur: 100, hp: 100, name: '云雀·I', id: 1 } }
// 当前生效的租约（每车队同时仅一份；null = 使用自有艇）
function activeRental() { return get("SELECT * FROM rentals WHERE status='active' ORDER BY id DESC LIMIT 1") || null }
// 当前赛季生效的赛事险保单（每赛季最多一份；null = 本季未投保）
function activePolicy(season = teamCore().season) {
  return get("SELECT * FROM insurance_policies WHERE season=? AND status='active' ORDER BY id DESC LIMIT 1", season) || null
}
// 比赛开赛快照保单：永远以快照为准（老保单赛季衔接后已 expired 仍承保当季已开赛的事故）
function racePolicy(rec) {
  const snap = rec?.factors?.policy
  if (!snap) return null
  return get('SELECT * FROM insurance_policies WHERE id=?', snap.id) || {
    // 保单行缺失（注入/老库）时用快照口径兜底，保证理赔仍可核定
    id: snap.id, plan_id: snap.planId, name: snap.name, premium: snap.premium,
    cover: snap.cover, deductible: snap.deductible, rep_relief: snap.repRelief, status: 'active'
  }
}
// 比赛开赛快照中本场出赛艇的租约（不区分 active/returned）。
// 结算与回滚的磨损归属、退款口径永远以这份快照为唯一依据，而不是「此刻是否在履租约」——
// 否则租约归还后再结算/回滚，会错扣自有艇磨损或漏退已钱货两讫的磨损费。
function raceRental(rec) {
  const rtId = rec?.factors?.rental?.id
  return rtId ? get('SELECT * FROM rentals WHERE id=?', rtId) : null
}
export function fleetStats(rt = activeRental()) {
  // 租约期间车队以租赁艇出赛：基础四项与部件健康取自租约快照，自有艇入库封存不磨损。
  // 出赛艇由调用方按排班解析结果传入（默认沿用旧行为：有在履租约即租约艇）
  const a = rt || airship()
  const up = all('SELECT * FROM upgrades WHERE equipped=1')
  const s = { speed: a.speed, dur: a.dur, turn: a.turn, acc: a.acc, name: a.name, id: a.id, parts_dur: a.parts_dur, hp: a.hp ?? 100 }
  up.forEach(u => { s[u.stat] = (s[u.stat] || 0) + u.bonus })
  if (rt) s.rental = { id: rt.id, shipId: rt.ship_id, name: rt.name, racesLeft: rt.max_races - rt.races_used, maxRaces: rt.max_races, wearTotal: rt.wear_total, wearRate: rt.wear_rate, insuredWear: rt.insured_wear || 0 }
  return s
}
function leadPilot() { return all('SELECT * FROM pilots ORDER BY (skill+courage) DESC')[0] || null }
function topMech() { return all('SELECT * FROM mechanics ORDER BY skill DESC')[0] || null }

/* ================= 赛事排班：机师 / 技工 / 出赛艇（服务端唯一事实来源） =================
 * 排班存于单行表 lineup（id=1），开赛瞬间由 resolveLineup 解析为实际出赛人选与出赛艇，
 * 并快照进比赛记录（factors.pilot / factors.mech / factors.rental / factors.lineup）。
 * 结算、越站回滚、历史回放一律只认快照——赛后调整排班绝不影响已开赛的比赛。
 */
const SHIP_MODES = ['auto', 'own', 'rental']
function lineupRow() { return get('SELECT * FROM lineup WHERE id=1') || { id: 1, pilot_id: null, mechanic_id: null, ship_mode: 'auto' } }
function ensureLineup() { run("INSERT OR IGNORE INTO lineup (id, ship_mode) VALUES (1, 'auto')") }
// 解析排班 → 本场实际出赛阵容。指定人员已离队（脏数据）时回落自动，绝不让比赛无法生成
function resolveLineup() {
  const l = lineupRow()
  const pilotSet = l.pilot_id ? get('SELECT * FROM pilots WHERE id=?', l.pilot_id) : null
  const mechSet = l.mechanic_id ? get('SELECT * FROM mechanics WHERE id=?', l.mechanic_id) : null
  const mode = SHIP_MODES.includes(l.ship_mode) ? l.ship_mode : 'auto'
  const rt = activeRental()
  // auto：租约在履即租约艇（沿用旧行为）；own：自有艇出赛（租约不消耗场次与磨损）；rental：必须租约艇
  const useRental = mode === 'own' ? false : !!rt
  return {
    row: l, mode,
    pilot: pilotSet || leadPilot(), pilotAuto: !pilotSet,
    mech: mechSet || topMech(), mechAuto: !mechSet,
    rental: useRental ? rt : null,
    rentalMissing: mode === 'rental' && !rt   // 排班指定租赁艇但无在履租约：开赛时拦截
  }
}
// 对外排班视图：原始排班 + 下一站实际出赛阵容（含自动回落标记与缺租约警告）
function lineupPayload() {
  const lu = resolveLineup()
  return {
    pilotId: lu.row.pilot_id, mechanicId: lu.row.mechanic_id, shipMode: lu.mode,
    resolved: {
      pilot: lu.pilot ? { id: lu.pilot.id, name: lu.pilot.name, auto: lu.pilotAuto } : null,
      mech: lu.mech ? { id: lu.mech.id, name: lu.mech.name, auto: lu.mechAuto } : null,
      ship: lu.rental
        ? { kind: 'rental', id: lu.rental.id, name: lu.rental.name }
        : { kind: 'own', name: airship().name }
    },
    rentalMissing: lu.rentalMissing
  }
}
function leadership(p) {
  if (!p) return 20
  return (p.skill + p.courage) / 2 * 0.4 + p.exp * 0.15 + (p.mood - 50) * 0.08
}
function mechBonus(m) {
  if (!m) return 10
  return m.skill * 0.12 + (m.mood - 50) * 0.06
}
// 赛站必须按 id（航线下行→上行）顺序参赛，前一站未完赛前后续赛站一律锁定
function orderedCircuits() { return all('SELECT * FROM circuits ORDER BY id ASC') }
// 当前唯一允许参赛的赛站：航线上第一个未完成的赛站；全部完赛时为 null
function nextCircuit() { return orderedCircuits().find(c => !c.finished) || null }
// 赛季是否已全部完赛（结算卡据此提示进入新赛季；已衔接归档的老赛季恒为 false）
function isSeasonComplete(season) {
  const cs = orderedCircuits()
  return !!cs.length && cs.every(c => c.finished) &&
    !get('SELECT season FROM seasons WHERE season=?', season)
}

/* ================= 比赛记录：动画 / 实时排名 / 最终奖励共用的唯一事实来源 ================= */

// 某分段内「性能发挥」→ pace：受天气、改装（已含在 st）、部件健康、机师/技工状态共同影响
function playerPace(st, seg, wF, lead, mech, grit, rng) {
  const statPts = st.speed * seg.w.speed + st.turn * seg.w.turn + st.acc * seg.w.acc + st.dur * seg.w.dur
  const parts = clamp(st.parts_dur / 100, 0.62, 1.12)
  const wEff = 1 - (1 - wF) * grit                    // 机师胆识越高，越能扛住坏天气
  const raw = (statPts * parts * wEff + lead + mech)
  return raw * (1 + (rng() * 0.22 - 0.11))
}
function aiPace(ai, seg, wF, rng) {
  const grit = 0.5 + ai.courage / 200                // 对手机师的天气抗性（与玩家同口径）
  const wEff = 1 - (1 - wF) * grit
  const statPts = 57 + 6 * ai.diff + ai.skill * 0.07
  const crew = ai.skill * 0.17 + ai.courage * 0.06 + (ai.mood - 50) * 0.04
  const profile = ai.profile[SEGMENTS.indexOf(seg)]  // 每艘 AI 艇的分段特长
  return (statPts + crew) * wEff * profile * (1 + (rng() * 0.18 - 0.09))
}

/* ================= 赛事事故：开赛记录内确定性生成（动画/结算/理赔共用同一份快照） =================
 * 概率随赛站难度与恶劣天气上升、随机师胆识下降；责任分对手剐蹭 / 天气不可抗力 / 己方操控，
 * 损伤分轻微 / 中度 / 严重三档；事故带来常规磨损之外的额外部件损伤与声望损失。
 * SKY_FORCE_ACCIDENT（1/light/medium/heavy）与 SKY_FORCE_FAULT（rival/weather/pilot）
 * 仅供自动化验证强制出事故，生产环境不设置时完全按上述概率模型生成。
 */
const ACCIDENT_PARTS = ['引擎罩', '翼板', '龙骨', '云母护甲', '氮气导管']
const ACCIDENT_SEV = {
  light: { label: '轻微剐蹭', dmg: [4, 8], repLoss: 1 },
  medium: { label: '中度碰撞', dmg: [9, 15], repLoss: 3 },
  heavy: { label: '严重损毁', dmg: [16, 26], repLoss: 6 }
}
const FORCE_SEV = { '1': '', true: '', light: 'light', medium: 'medium', heavy: 'heavy' }
function accidentText(segName, fault, sev, part, rival, weather) {  if (fault === 'rival') {
    if (sev === 'light') return `${segName}抢位时${rival}贴线过近，${part}擦出一串火花`
    if (sev === 'medium') return `${segName}编队过弯，${rival}抢占航道撞上${part}，护板凹陷变形`
    return `${segName}${rival}从侧后方强行切出气流，${part}护罩崩裂，艇身剧烈震颤！`
  }
  if (fault === 'weather') {
    if (sev === 'light') return `${segName}一阵乱流卷来，云屑在${part}上击出细密凹痕`
    if (sev === 'medium') return `${segName}${weather}突袭航线，${part}承压过载发出异响`
    return `${segName}${weather}正面扑来，${part}护板被击穿，飞艇险些失控！`
  }
  if (sev === 'light') return `${segName}艇身擦过云礁边缘，${part}留下一道剐痕`
  if (sev === 'medium') return `${segName}过弯走线过宽，${part}撞上漂浮云礁，铆钉崩飞`
  return `${segName}急速切弯时舵面失速，${part}重重拍在云礁上，碎片飞散！`
}
function buildAccident(c, pilot, rng) {
  const wF = WEATHER[c.weather] || 1
  const bad = 1 - wF                                 // 天气恶劣程度 0..0.22
  let chance = clamp(0.06 + c.diff * 0.03 + bad * 0.8 - ((pilot?.courage || 50) - 50) / 250, 0.03, 0.7)
  const forceEnv = process.env.SKY_FORCE_ACCIDENT
  const forced = Object.prototype.hasOwnProperty.call(FORCE_SEV, forceEnv)
  const forcedSev = FORCE_SEV[forceEnv]   // '' = 强制出事故但严重程度仍随机
  if (!forced && rng() >= chance) return null

  // 责任归属：对手剐蹭基础概率固定；天气越差，不可抗力占比越高；其余为己方操控责任
  const fRival = rng(), fWeather = rng(), fSev = rng()
  let fault
  const forceFault = ['rival', 'weather', 'pilot'].includes(process.env.SKY_FORCE_FAULT) ? process.env.SKY_FORCE_FAULT : null
  if (forceFault) fault = forceFault
  else if (fRival < 0.32) fault = 'rival'
  else if (fWeather < 0.18 + bad * 1.4) fault = 'weather'
  else fault = 'pilot'
  // 严重程度：难度与坏天气抬高中重度事故占比
  const heavyThr = 0.12 + c.diff * 0.02 + bad * 0.5
  const mediumThr = heavyThr + 0.38 + c.diff * 0.01
  const severity = forcedSev || (fSev < heavyThr ? 'heavy' : fSev < mediumThr ? 'medium' : 'light')

  const segIdx = Math.floor(rng() * 3)
  const part = ACCIDENT_PARTS[Math.floor(rng() * ACCIDENT_PARTS.length)]
  const rival = AI_NAMES[Math.floor(rng() * AI_NAMES.length)]
  const sevCfg = ACCIDENT_SEV[severity]
  const damage = sevCfg.dmg[0] + Math.floor(rng() * (sevCfg.dmg[1] - sevCfg.dmg[0] + 1))
  const segName = SEGMENTS[segIdx].name
  const text = accidentText(segName, fault, severity, part, rival, c.weather)
  const faultLabel = fault === 'rival' ? '对手责任' : fault === 'weather' ? '天气不可抗力' : '己方责任'
  return {
    severity, severityLabel: ACCIDENT_SEV[severity].label, fault, faultLabel,
    segIdx, segName, part, rival: fault === 'rival' ? rival : null,
    damage, repLoss: sevCfg.repLoss, text
  }
}

// 生成完整比赛记录（结果在开赛瞬间即确定，后续只是对这份记录的播放与结算）
function buildRace(c) {
  const t = teamCore()
  const lu = resolveLineup()                 // 排班决定本场出赛艇与机师/技工，随即快照进记录
  const st = fleetStats(lu.rental)
  const pilot = lu.pilot
  const mech = lu.mech
  const mods = all('SELECT * FROM upgrades WHERE equipped=1').map(u => ({ id: u.id, name: u.name, slot: u.slot, stat: u.stat, bonus: u.bonus }))
  const lead = leadership(pilot)
  const mechB = mechBonus(mech)
  const grit = 0.5 + (pilot?.courage || 50) / 200
  const segW = SEG_WEATHER[c.weather] || [1, 1, 1]
  const rng = mulberry32((Date.now() & 0xffffffff) ^ (c.id * 2654435761))

  // 5 名对手，共 6 艇竞技；各自带机师状态与分段特长，档位参差保证每场有慢艇也有快车
  const ais = AI_NAMES.map((name, i) => ({
    name, color: AI_COLORS[i], diff: c.diff,
    skill: 48 + c.diff * 4 + Math.floor(rng() * 10) + (-17 + Math.floor(rng() * 40)),
    courage: 40 + Math.floor(rng() * 40),
    mood: 58 + Math.floor(rng() * 38),
    profile: [0.97 + rng() * 0.06, 0.97 + rng() * 0.06, 0.97 + rng() * 0.06]
  }))

  const racers = [{ id: 'p', name: t.name, color: PLAYER_COLOR, isPlayer: true, paces: [], segW: [], times: [], entry: [0] }]
  ais.forEach(ai => racers.push({ id: 'ai' + ai.name, name: ai.name, color: ai.color, isPlayer: false, ai, skill: ai.skill, courage: ai.courage, mood: ai.mood, paces: [], segW: [], times: [], entry: [0] }))

  SEGMENTS.forEach((seg, si) => {
    racers.forEach(r => {
      const gritP = r.isPlayer ? grit : (0.5 + r.ai.courage / 200)
      const wF = segW[si]                            // 同一场天气对所有艇一致，差异只在机师抗性
      const wEff = 1 - (1 - wF) * gritP
      const pace = r.isPlayer
        ? playerPace(st, seg, wF, lead, mechB, grit, rng) * (1 + c.diff * 0.006)
        : aiPace(r.ai, seg, wF, rng)
      const time = SEG_K / Math.max(1, pace)
      r.paces.push(Math.round(pace * 100) / 100)
      r.segW.push(Math.round(wEff * 1000) / 1000)
      r.times.push(Math.round(time * 1000) / 1000)
      r.entry.push(Math.round((r.entry[si] + time) * 1000) / 1000)
    })
  })
  racers.forEach(r => { r.total = r.entry[3] })

  // 总用时排序得最终名次（玩家名次），动画、LIVE 榜、奖励全部以此为准
  const order = [...racers].sort((a, b) => a.total - b.total)
  const rank = order.findIndex(r => r.isPlayer) + 1
  const pts = PTS[rank - 1] || 1
  const money = Math.round((600 + (7 - rank) * 180) * (1 + c.diff * 0.05))
  const wearBase = 5 + c.diff * 3 + (WEATHER[c.weather] < 0.9 ? 4 : 0)
  const repGainBase = Math.max(1, 5 - rank + c.diff)

  // 赛事事故（与比赛记录同源确定性生成）：常规磨损之外的事故损伤与声望损失，
  // 结算/越站回滚/保险理赔全部以这份快照为唯一依据
  const accident = buildAccident(c, pilot, rng)
  const wear = wearBase + (accident ? accident.damage : 0)
  const repLoss = accident ? accident.repLoss : 0
  const repGain = Math.max(0, repGainBase - repLoss)

  // 分段事件：分段节点的名次变化（超车）+ 天气氛围事件，计时锚点取玩家艇自身时间轴
  const events = []
  const flavors = FLAVOR[c.weather] || FLAVOR['晴']
  let prevRank = null
  SEGMENTS.forEach((seg, si) => {
    const segOrder = [...racers].sort((a, b) => a.entry[si + 1] - b.entry[si + 1])
    const pRank = segOrder.findIndex(r => r.isPlayer) + 1
    const tEnd = racers[0].entry[si + 1]
    if (prevRank && pRank < prevRank) {
      const behind = segOrder[pRank] // segOrder 为 0 基；玩家位于 pRank-1，紧随其后的即索引 pRank
      events.push({ t: +(tEnd - 0.35).toFixed(2), type: 'overtake', text: `你在「${seg.name}」超越 ${behind ? behind.name : '对手'}，升至第 ${pRank} 位！` })
    }
    events.push({ t: +(racers[0].entry[si] + racers[0].times[si] * 0.5).toFixed(2), type: 'flavor', text: flavors[Math.floor(rng() * flavors.length)] })
    prevRank = pRank
  })
  // 事故横幅锚定在事故所在分段的玩家时间轴
  if (accident) {
    events.push({
      t: +(racers[0].entry[accident.segIdx] + racers[0].times[accident.segIdx] * 0.72).toFixed(2),
      type: 'crash',
      text: `⚠️ ${accident.text}（${accident.severityLabel} · ${accident.faultLabel}）`
    })
  }
  events.sort((a, b) => a.t - b.t)

  racers.forEach(r => { delete r.ai }) // ai 仅引擎内部使用，其字段已展开到记录顶层
  const duration = Math.max(...racers.map(r => r.total)) + 0.15
  return {
    v: 1,
    circuit: { id: c.id, name: c.name, diff: c.diff, weather: c.weather },
    season: t.season,
    segments: SEGMENTS.map(s => ({ key: s.key, name: s.name })),
    factors: {
      weather: c.weather,
      weatherCoeff: WEATHER[c.weather] || 1,
      segWeather: segW,
      base: { speed: st.speed - mods.filter(m => m.stat === 'speed').reduce((a, m) => a + m.bonus, 0),
        turn: st.turn - mods.filter(m => m.stat === 'turn').reduce((a, m) => a + m.bonus, 0),
        acc: st.acc - mods.filter(m => m.stat === 'acc').reduce((a, m) => a + m.bonus, 0),
        dur: st.dur - mods.filter(m => m.stat === 'dur').reduce((a, m) => a + m.bonus, 0) },
      parts_dur: st.parts_dur,
      // 本场出赛租约快照：结算时磨损记入该租约；shipId 供合约条款按指定艇型判定；null = 自有艇出赛
      rental: st.rental ? { id: st.rental.id, shipId: st.rental.shipId, name: st.rental.name, wearRate: st.rental.wearRate } : null,
      // 本场赛事险保单快照（含赔付口径）：事故后凭此报案理赔；null = 本季未投保，事故无法理赔
      policy: (() => {
        const p = activePolicy(t.season)
        return p ? { id: p.id, planId: p.plan_id, name: p.name, premium: p.premium, cover: p.cover, deductible: p.deductible, repRelief: p.rep_relief } : null
      })(),
      // 本场排班快照：排班原始配置（null = 自动），赛后改排班不影响这份记录
      lineup: { shipMode: lu.mode, pilotId: lu.row.pilot_id, mechanicId: lu.row.mechanic_id },
      mods,
      pilot: pilot ? { id: pilot.id, name: pilot.name, skill: pilot.skill, courage: pilot.courage, exp: pilot.exp, mood: pilot.mood } : null,
      mech: mech ? { id: mech.id, name: mech.name, skill: mech.skill, mood: mech.mood } : null,
      detail: { parts: +clamp(st.parts_dur / 100, 0.62, 1.12).toFixed(2), lead: +lead.toFixed(1), mech: +mechB.toFixed(1), grit: +grit.toFixed(2) }
    },
    racers,
    events,
    // 事故快照（null = 本场平安）：损伤/责任/声望损失的唯一事实来源，理赔与回滚都只认它
    accident,
    result: { rank, pts, money, wear, wearBase, accidentWear: accident ? accident.damage : 0, repGain, repGainBase, repLoss },
    duration: +duration.toFixed(2)
  }
}

// 读取/解析比赛记录
const parseRace = r => (r ? { ...r, settled: !!r.settled, record: JSON.parse(r.record) } : null)
function getRaceRow(id) { return get('SELECT * FROM races WHERE id=?', Number(id)) }
// 结算响应中的事故视图（幂等重放同样携带，前端据此恢复「报案/理赔」入口）
function accidentViewOf(row) {
  let rec = null
  try { rec = JSON.parse(row.record) } catch (e) { rec = null }
  const a = rec?.accident
  if (!a) return null
  return {
    ...a,
    insurable: !!rec.factors?.policy,
    policyName: rec.factors?.policy?.name || null,
    claimId: get('SELECT id FROM insurance_claims WHERE race_id=?', row.id)?.id || null
  }
}
// 单场已结算比赛的发奖口径（与 settleRace 完全一致）；历史修复按此逐项反向回滚
function raceEffect(row, c) {
  let rec = null
  try { rec = JSON.parse(row.record) } catch (e) { rec = null }
  const rank = row.rank ?? rec?.result?.rank ?? c?.rank ?? 6
  const pts = row.pts ?? rec?.result?.pts ?? (PTS[rank - 1] || 1)
  const money = row.money ?? rec?.result?.money ?? 0
  const accidentWear = rec?.accident?.damage ?? rec?.result?.accidentWear ?? 0
  const repLoss = rec?.accident?.repLoss ?? rec?.result?.repLoss ?? 0
  // wear 为总磨损（常规+事故）；老记录无拆分时整体视为常规磨损
  const wear = row.wear ?? rec?.result?.wear ?? 0
  const wearBase = rec?.result?.wearBase ?? (wear - accidentWear)
  const repGainBase = rec?.result?.repGainBase ?? Math.max(1, 5 - rank + (c?.diff || 0))
  const repGain = row.rep_gain ?? rec?.result?.repGain ?? Math.max(0, repGainBase - repLoss)
  return { row, rec, rank, pts, money, wear, wearBase, accidentWear, repGain, repGainBase, repLoss }
}
// 反向回滚单场已结算比赛：部件磨损（parts_dur/hp）与机师经验、心情同积分奖金一道冲回，
// 保证「资源状态」与「战绩」始终一致。维护等操作若已介入，恢复值以 100 为上限，不会溢出。
//
// 磨损归属以开赛快照为准（raceRental），与 settleRace 完全对称：
//  - 租约仍在履行：磨损与场次回滚到租约，不动钱（押金尚未结算）；
//  - 租约已归还：归还时已按累计磨损计费钱货两讫——先回滚累计磨损/场次，再按「本场磨损对应的
//    边际磨损费」补退（押金−磨损费的下限 0 效应按重算结果保留），并回写 wear_fee/refund，
//    使租约行与比赛结果重新自洽；自有艇封存未磨损，绝不回错对象；
//  - 无租约（自有艇出赛）：恢复自有艇 parts_dur/hp。
// 返回 refundAdd（需要在调用方统一补给车队资金的退款），资金改动只在单一边界发生，保证幂等。
// 保险理赔对称冲回：该场已领取的赔付资金/声望救济收回，租约艇事故损伤重新计入租约磨损
// （随后随常规磨损回滚逻辑一起重算押金）；未赔付的报案/定损单仅置 reversed。返回 { ..., claimPayBack, claimRepBack }
function reverseSettledRace(row, c) {
  const g = raceEffect(row, c)
  const rt = raceRental(g.rec)
  let refundAdd = 0
  const cl = get('SELECT * FROM insurance_claims WHERE race_id=?', row.id)
  let claimPayBack = 0, claimRepBack = 0
  if (cl && cl.status !== 'reversed') {
    if (cl.status === 'paid' && cl.payout) {
      claimPayBack += cl.payout
      claimRepBack += cl.rep_relief || 0
      if (cl.rental_id && cl.damage) {
        // 租约艇事故：赔付时这部分损伤已转为保险方承担（insured_wear、不计 wear_total），
        // 回滚时重新计入租约累计磨损，由下面的押金重算统一处理
        run('UPDATE rentals SET insured_wear=MAX(0,insured_wear-?), wear_total=wear_total+? WHERE id=?',
          cl.damage, cl.damage, cl.rental_id)
      }
      run("UPDATE insurance_claims SET status='reversed', payout=NULL, paid_at=NULL, reversed_at=? WHERE id=?", now(), cl.id)
    } else if (['reported', 'assessed', 'rejected'].includes(cl.status)) {
      run("UPDATE insurance_claims SET status='reversed', reversed_at=? WHERE id=?", now(), cl.id)
    }
  }
  if (rt && rt.status === 'active') {
    // 该场为租约艇出赛且租约仍在履行：磨损与已用场次一并回滚到租约（恢复以 100 为上限）
    run('UPDATE rentals SET parts_dur=MIN(100,parts_dur+?), wear_total=MAX(0,wear_total-?), races_used=MAX(0,races_used-1) WHERE id=?',
      g.wear, g.wear, rt.id)
  } else if (rt && rt.status === 'returned') {
    // 归还已结算：把本场磨损从「已计费基数」中剔除，按剩余磨损重算边际磨损费与押金退款。
    // 已赔付事故的损伤此前已重新计入 wear_total（见上），此处一并按重算结果补退押金差额。
    const wearTotal2 = Math.max(0, (rt.wear_total || 0) - g.wear)
    const wearFee2 = wearTotal2 * rt.wear_rate
    const refund2 = Math.max(0, (rt.deposit || 0) - wearFee2)
    refundAdd = Math.max(0, refund2 - (rt.refund || 0))
    run('UPDATE rentals SET parts_dur=MIN(100,parts_dur+?), wear_total=?, races_used=MAX(0,races_used-1), wear_fee=?, refund=? WHERE id=?',
      g.wear, wearTotal2, wearFee2, refund2, rt.id)
  } else if (!rt) {
    // 自有艇出赛：恢复自有艇磨损
    const a = airship()
    run('UPDATE airships SET parts_dur=MIN(100,parts_dur+?), hp=MIN(100,hp+?) WHERE id=?', g.wear, g.wear, a.id)
  }
  // 租约记录缺失：无归属可回（数据已不在），保持与正向口径一致，不动任何部件与资金
  const pilotId = g.rec?.factors?.pilot?.id
  if (pilotId) {
    const expGain = g.rank <= 4 ? 3 : 1   // 与 settleRace 的发奖口径逐字对应
    const moodLoss = g.rank > 8 ? 6 : 2
    run('UPDATE pilots SET exp=MAX(0,exp-?), mood=MIN(100,MAX(0,mood+?)) WHERE id=?',
      expGain, moodLoss, pilotId)
  }
  return { ...g, refundAdd, claimPayBack, claimRepBack }
}
function settleRace(id) {
  const row = getRaceRow(id)
  if (!row) return { ok: false, status: 404, msg: '比赛记录不存在' }
  if (row.status === 'void') return { ok: false, status: 409, msg: '该比赛已在历史修复中作废，不能再次结算' }
  // 幂等重放同样要告知前端「本季是否已 6 站完赛」（决定结算卡是否展示进入新赛季）
  if (row.settled) return { ok: true, already: true, race: parseRace(row), contractsPaid: [], contractsRevoked: [], accident: accidentViewOf(row), seasonComplete: isSeasonComplete(row.season) }

  const rec = JSON.parse(row.record)
  const c = get('SELECT * FROM circuits WHERE id=?', row.circuit_id)
  let result
  db.exec('BEGIN')
  try {
    // 事务内二次确认闸门：同步执行下杜绝并发/重放造成的重复发奖
    const again = getRaceRow(id)
    if (again.status === 'void') {
      result = { ok: false, status: 409, msg: '该比赛已在历史修复中作废，不能再次结算' }
    } else if (again.settled) {
      result = { ok: true, already: true, race: parseRace(again), contractsPaid: [], contractsRevoked: [], accident: accidentViewOf(again), seasonComplete: isSeasonComplete(again.season) }
    } else if (c?.finished) {
      // 极端兜底：赛站已被另一场比赛结算 → 本条记录作废，绝不重复发奖，也不混入历史战绩
      run("UPDATE races SET status='void', settled=0, voided_at=? WHERE id=?", now(), row.id)
      result = { ok: false, status: 409, msg: '该赛站已完赛，此条比赛记录已作废' }
    } else {
      // 顺序闸门：仅当前待赛站可结算；running 记录正常必然命中，越站脏数据在此被拦截
      const cur = nextCircuit()
      if (!cur || cur.id !== row.circuit_id) {
        result = { ok: false, status: 409, msg: '前置赛站尚未完赛，该比赛暂不能结算' }
      } else {
        const { rank, pts, money, wear, repGain } = rec.result
        // 磨损归属以开赛快照为唯一依据（与 reverseSettledRace 对称）：
        //  - 租约仍 active：磨损记入租约（归还时按 wear_total 计费）并计一场次，自有艇不磨损；
        //  - 租约已 returned：归还时磨损已钱货两讫，本场不再重复计费，更不得回扣封存的自有艇；
        //  - 无租约：自有艇出赛，正常磨损。
        const rt = raceRental(rec)
        if (rt && rt.status === 'active') {
          run('UPDATE rentals SET parts_dur=MAX(10,parts_dur-?), wear_total=wear_total+?, races_used=races_used+1 WHERE id=?',
            wear, wear, rt.id)
        } else if (!rt) {
          const a = airship()
          const newPd = Math.max(10, a.parts_dur - wear)
          run('UPDATE airships SET parts_dur=?, hp=? WHERE id=?', newPd, Math.max(20, a.hp - wear), a.id)
        }
        if (rec.factors.pilot) {
          run('UPDATE pilots SET exp=exp+?, mood=MIN(100,MAX(0,mood-?)) WHERE id=?',
            rank <= 4 ? 3 : 1, rank > 8 ? 6 : 2, rec.factors.pilot.id)
        }
        run('UPDATE team SET money=money+?, rep=MAX(0,rep+?), season_pts=season_pts+? WHERE id=1', money, repGain, pts)
        const ranksDone = all('SELECT rank FROM circuits WHERE finished=1')
        const best = Math.min(rank, ...ranksDone.map(r => r.rank))
        run('UPDATE team SET season_pos=? WHERE id=1', Math.max(1, best))
        run('UPDATE circuits SET finished=1, rank=? WHERE id=?', rank, row.circuit_id)
        const wx = rec.factors.weather === '晴' ? '晴空万里' : `${rec.factors.weather}天`
        const note = rec.accident ? `${wx}，${rec.circuit.name} · ⚠${rec.accident.severityLabel}` : `${wx}，${rec.circuit.name}`
        run('INSERT INTO race_log (circuit_id, race_id, season, rank, pts, money, note, ts) VALUES (?,?,?,?,?,?,?,?)',
          row.circuit_id, row.id, rec.season, rank, pts, money, note, now())
        run("UPDATE races SET status='settled', settled=1, rank=?, pts=?, money=?, wear=?, rep_gain=?, settled_at=? WHERE id=?",
          rank, pts, money, wear, repGain, now(), row.id)
        const contractSettle = reconcileContracts(rec.season) // 同一事务内对账赛季合约（累计进度→一次性兑现）
        const settledRow = parseRace(getRaceRow(id))
        // 事故与本季保单快照随结算响应返回：结算卡据此提示「报案理赔」入口
        const accView = accidentViewOf(getRaceRow(id))
        // 全部 6 站已结算（且尚未衔接新赛季）→ 结算卡展示赛季总结与「进入新赛季」
        const complete = orderedCircuits().every(x => x.finished)
        result = { ok: true, already: false, race: settledRow, contractsPaid: contractSettle.paid, contractsRevoked: contractSettle.revoked, accident: accView, seasonComplete: complete }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return result
}
/* ================= 赛季合约：进度引擎 + 一次性兑现对账 =================
 * 进度不入库：始终以本赛季「已结算且未作废」的比赛记录为唯一事实来源现算
 * （weather=赛道天气，rank=最终名次，rental=开赛快照中的租赁艇/艇型）。
 * 积分条款直接以 team.season_pts 为准——积分本身已由每场结算与越站回滚维护。
 * 全部条款（或 need 指定条数）达成即在结算事务内一次性兑现资金 + 声望；
 * 若因越站作废等导致进度跌破门槛，则冲回奖励，与正向口径完全对称，函数幂等。
 */
function parseTerms(row) {
  try {
    const j = JSON.parse(row.terms)
    return Array.isArray(j) ? j : (j?.terms || []) // 兼容裸数组老快照
  } catch (e) { return [] }
}
// 租赁艇型 id 的稳健解析：新记录快照带 shipId；老记录只有租约行 id，需查库回推目录艇型
function raceShipId(rec) {
  const rtSnap = rec?.factors?.rental
  if (!rtSnap) return null
  if (Number.isInteger(rtSnap.shipId)) return rtSnap.shipId
  const rtRow = get('SELECT ship_id FROM rentals WHERE id=?', rtSnap.id)
  return rtRow?.ship_id ?? null
}
// 单场比赛是否命中条款的附加条件（weather / rankMax / ship）
function raceMatch(rec, t) {
  const w = rec?.circuit?.weather ?? rec?.factors?.weather
  if (t.weather && t.weather !== '*' && w !== t.weather) return false
  if (Number.isInteger(t.rankMax) && (rec.result.rank ?? 6) > t.rankMax) return false
  if ('ship' in t && raceShipId(rec) !== t.ship) return false
  return true
}
// 计算一份条款在给定已结算比赛集合上的累计进度 { value, target }
function termProgress(term, races, pts) {
  const target = term.value
  let value = 0
  if (term.type === 'points') {
    value = pts
  } else if (term.type === 'weather') {
    value = races.filter(r => raceMatch(r, term)).length
  } else if (term.type === 'rank') {
    value = races.filter(r => raceMatch(r, term)).length
  } else if (term.type === 'rental') {
    // ship 缺省 = 任意租赁艇；指定 ship 时由 raceMatch 校验艇型
    value = races.filter(r => !!r.factors?.rental && raceMatch(r, term)).length
  } else if (term.type === 'race') {
    // 复合条款：天气 + 名次 + 租赁艇（可含指定艇型）必须在同一场比赛同时满足
    value = races.filter(r => !!r.factors?.rental && raceMatch(r, term)).length
  }
  return { value, target, reached: value >= target }
}
// 合约整体进度：每条条款的进度 + 是否满足 need 条
function contractView(row, races, pts) {
  const terms = parseTerms(row)
  const items = terms.map(t => ({ term: t, ...termProgress(t, races, pts) }))
  const need = Math.min(row.need || items.length || 1, items.length)
  const doneCount = items.filter(i => i.reached).length
  return { terms: items, need, doneCount, reached: items.length > 0 && doneCount >= need }
}
// 取某赛季全部已结算、未作废比赛的解析记录（合约进度的唯一统计口径）
function settledRaceRecs(season) {
  return all("SELECT * FROM races WHERE status='settled' AND settled=1 AND season=? ORDER BY id ASC", season)
    .map(r => { try { return JSON.parse(r.record) } catch (e) { return null } })
    .filter(Boolean)
}
// 合约对账（与旧赞助对账同一边界）：达成即一次性兑现，跌破即冲回；幂等。
// 返回 { paid:[...], revoked:[...] }，结算卡据此展示当场兑现的合约。
function reconcileContracts(season = teamCore().season) {
  const t = teamCore()
  const pts = Number(t.season_pts) || 0
  const races = settledRaceRecs(season)
  const paid = [], revoked = []
  all('SELECT * FROM contracts WHERE season=?', season).forEach(c => {
    if (!c.reward && !c.rep) return
    const view = contractView(c, races, pts)
    const wasEarned = !!c.earned
    if (view.reached && !wasEarned) {
      run('UPDATE team SET money=money+?, rep=rep+? WHERE id=1', c.reward, c.rep)
      run('UPDATE contracts SET earned=1, paid_at=? WHERE id=?', now(), c.id)
      paid.push({ id: c.id, name: c.name, reward: c.reward, rep: c.rep })
    } else if (!view.reached && wasEarned) {
      run('UPDATE team SET money=MAX(0,money-?), rep=MAX(0,rep-?) WHERE id=1', c.reward, c.rep)
      run('UPDATE contracts SET earned=0, paid_at=NULL WHERE id=?', c.id)
      revoked.push({ id: c.id, name: c.name, reward: c.reward, rep: c.rep })
    }
  })
  return { paid, revoked }
}
// 条款展示文案（服务端生成，前端直接渲染；目标值/艇型口径不在客户端拼接）
function termLabel(t) {
  const n = t.value
  switch (t.type) {
    case 'points': return `赛季积分达到 ${n}`
    case 'weather': return `${(t.weather && t.weather !== '*') ? t.weather : '任意天气'}完赛 ${n} 场`
    case 'rank': {
      const place = Number.isInteger(t.rankMax) ? `前 ${t.rankMax} 名` : '任意名次'
      return `${place}完赛 ${n} 场`
    }
    case 'rental': {
      const ship = 'ship' in t ? RENTAL_MAP.get(t.ship)?.name || '指定艇型' : '租赁艇'
      return `驾驶${ship}完赛 ${n} 场`
    }
    case 'race': {
      const parts = []
      if (t.weather && t.weather !== '*') parts.push(t.weather)
      parts.push(Number.isInteger(t.rankMax) ? `取得前 ${t.rankMax} 名` : '完赛')
      if ('ship' in t) parts.push(`驾驶${RENTAL_MAP.get(t.ship)?.name || '指定艇型'}`)
      else parts.push('驾驶租赁艇')
      return `${parts.join('、')} ${n} 场`
    }
    default: return '未知条款'
  }
}
// 对外合约视图：配置条款 + 实时累计进度 + 兑现状态
function contractsPayload(season = teamCore().season) {
  const t = teamCore()
  const pts = Number(t.season_pts) || 0
  const races = settledRaceRecs(season)
  return all('SELECT * FROM contracts WHERE season=? ORDER BY id ASC', season).map(c => {
    const view = contractView(c, races, pts)
    return {
      id: c.id, name: c.name, note: c.note, season: c.season,
      reward: c.reward, rep: c.rep, earned: !!c.earned, paidAt: c.paid_at,
      need: view.need, doneCount: view.doneCount,
      terms: view.terms.map(i => ({ type: i.term.type, label: termLabel(i.term), value: i.value, target: i.target, reached: i.reached }))
    }
  })
}

/* ================= 新赛季衔接：完季 → 归档排行榜 → 分层重置（老赛季原样可回放） =================
 * 6 站全部结算后由前端显式触发：
 *  - 积分（team.season_pts/season_pos）、赛站（circuits.finished/rank）、赛季合约（新季重签）、
 *    历史战绩与排行榜均按赛季分层——老赛季的 races / race_log / contracts 一行不删，继续回放；
 *  - 资金、声望、飞艇（含部件健康）、改装件、机师技工（含经验/心情）、租约（含押金/场次/磨损归属）
 *    属于车队跨赛季资产，全部保留；排行榜快照存入 seasons，供「历届赛季榜」分层展示。
 * 幂等：以 seasons 中是否已有该季档案为唯一闸门（事务内二次校验），并发/重复衔接不产生两份档案。
 */
// 某赛季滚动战绩统计（完季归档与「当前赛季行」共用同一口径）
function seasonLiveStats(season) {
  const rows = all(
    "SELECT rank,pts,money,rep_gain FROM races WHERE status='settled' AND settled=1 AND season=?", season)
  const ranks = rows.map(r => r.rank).filter(r => r != null)
  return {
    season,
    pts: rows.reduce((a, r) => a + (r.pts || 0), 0),
    money: rows.reduce((a, r) => a + Math.round(r.money || 0), 0),
    rep: rows.reduce((a, r) => a + (r.rep_gain || 0), 0),
    wins: ranks.filter(r => r === 1).length,
    podiums: ranks.filter(r => r <= 3).length,
    bestRank: ranks.length ? Math.min(...ranks) : null,
    racesN: rows.length
  }
}
// 历届赛季榜：seasons 归档行 + 当前赛季滚动行（未归档，标记 current），新季在前
function seasonsPayload() {
  const t = teamCore()
  const list = all('SELECT * FROM seasons ORDER BY season DESC').map(s => ({
    season: s.season, pts: s.pts, money: s.money, rep: s.rep, wins: s.wins,
    podiums: s.podiums, bestRank: s.best_rank, bestPos: s.best_pos,
    racesN: s.races_n, finishedAt: s.finished_at, current: false
  }))
  if (!list.some(s => s.season === t.season)) {
    const live = seasonLiveStats(t.season)
    list.unshift({
      season: t.season, pts: Number(t.season_pts) || 0, money: live.money, rep: live.rep,
      wins: live.wins, podiums: live.podiums, bestRank: live.bestRank,
      bestPos: Number(t.season_pos) || 1, racesN: live.racesN, finishedAt: null, current: true
    })
  }
  return list
}
// 完赛 6 站后的新赛季衔接（在独立事务内完成归档 + 分层重置）。返回 { status, body } 由路由映射
function advanceSeason() {
  if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
    return { status: 409, body: { ok: false, msg: '尚有比赛进行中，结算后才能进入新赛季' } }
  }
  // 保险联动：存在未了结的理赔单（已报案/已定损）时不允许衔接，先完成定损与赔付，
  // 避免跨赛季后事故处理半途而废；拒赔/已赔付/已冲回均为终态，不阻塞
  const pendingClaim = get("SELECT id FROM insurance_claims WHERE status IN ('reported','assessed') LIMIT 1")
  if (pendingClaim) {
    return { status: 409, body: { ok: false, msg: '尚有保险理赔未了结（报案/定损中），请先完成定损与赔付再进入新赛季' } }
  }
  const t = teamCore()
  const season = Number(t.season) || 1
  if (get('SELECT season FROM seasons WHERE season=?', season)) {
    // 幂等：已衔接（并发重放 / 重复点击）直接返回当前状态，绝不二次归档、二次重置
    return { status: 200, body: { ok: true, already: true, msg: '新赛季已经开启', season: season + 1 } }
  }
  // 新赛季刚衔接、一站未跑时再次调用：上一季已归档即视为本次请求的重复，幂等返回，
  // 不把「尚未参赛」误报为错误（刷新页面 / 双击按钮的常见落点）
  if (season > 1 && get('SELECT season FROM seasons WHERE season=?', season - 1) &&
    !get('SELECT id FROM races WHERE season=? AND settled=1 LIMIT 1', season)) {
    return { status: 200, body: { ok: true, already: true, msg: '新赛季已经开启', season } }
  }
  const cs = orderedCircuits()
  const finishedCount = cs.filter(c => c.finished).length
  if (!finishedCount) return { status: 400, body: { ok: false, msg: '本赛季尚未参赛，无需进入新赛季' } }
  if (finishedCount < cs.length) {
    return { status: 409, body: { ok: false, msg: `本赛季还有 ${cs.length - finishedCount} 站未完赛，暂不能进入新赛季` } }
  }

  let body
  db.exec('BEGIN IMMEDIATE')
  try {
    // 事务内二次闸门：同步并发下只有一个衔接请求能穿过
    if (get('SELECT season FROM seasons WHERE season=?', season)) {
      body = { ok: true, already: true, msg: '新赛季已经开启', season: season + 1 }
    } else {
      // 1) 归档老赛季最终战绩到排行榜（races/race_log/contracts 原样保留，回放不受影响）
      const live = seasonLiveStats(season)
      const bestPos = Math.max(1, Number(t.season_pos) || 1)
      run(`INSERT INTO seasons (season,pts,money,rep,wins,podiums,best_rank,best_pos,races_n,finished_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`,
        season, Number(t.season_pts) || 0, live.money, live.rep, live.wins, live.podiums,
        live.bestRank, bestPos, finishedCount, now())
      // 2) 滚动数据分层重置：积分/车队名次归零（money、rep 为跨赛季资产，保留）
      const nextSeason = season + 1
      run('UPDATE team SET season=?, season_pts=0, season_pos=1 WHERE id=1', nextSeason)
      // 3) 赛站重新开放（天气/难度配置不变，清完赛名次）
      run('UPDATE circuits SET finished=0, rank=NULL')
      // 4) 新赛季合约按当前配置重签（老合约行保留，进度按各自赛季的比赛记录现算，互不串账）
      ensureContracts(nextSeason)
      // 5) 老赛季保单置 expired（快照仍承保老赛季已开赛事故，可继续报案理赔；新赛季需重新投保）
      run("UPDATE insurance_policies SET status='expired', expired_at=? WHERE season=? AND status='active'", now(), season)
      // 本赛季保险理赔摘要（资金/声望已在各理赔事务内落账，这里仅做归档展示）
      const sClaims = all("SELECT status, payout, rep_relief FROM insurance_claims WHERE season=? AND status='paid'", season)
      const claimsSummary = {
        claims: sClaims.length,
        payout: sClaims.reduce((a, x) => a + (x.payout || 0), 0),
        repRelief: sClaims.reduce((a, x) => a + (x.rep_relief || 0), 0)
      }
      body = {
        ok: true, already: false, season: nextSeason,
        summary: {
          season, pts: Number(t.season_pts) || 0, money: live.money, rep: live.rep,
          wins: live.wins, podiums: live.podiums, bestRank: live.bestRank, bestPos,
          insurance: claimsSummary
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 新赛季衔接失败', e)
    return { status: 500, body: { ok: false, msg: '新赛季开启失败，请重试' } }
  }
  return { status: 200, body }
}

// 历史数据兼容（迁移补偿）：修复「跳站参赛」产生的脏数据——首个未完成赛站之后的
// 完赛记录一律视为越站。在同一事务内：
//   1) 按各场记录的发奖口径，回滚积分/奖金/声望/部件磨损（parts_dur、hp）/机师经验与心情；
//      租约艇比赛按开赛快照归属回滚：在履租约回滚磨损/场次（不动钱），已归还租约重算磨损费
//      并补退押金差额（与 settleRace / 归还结算共用同一磨损归属边界）；
//   2) 删除对应 race_log 流水（含无记录关联的老版残留流水）；
//   3) 将这些赛站的 races 记录一律置为 void（作废，不再出现在历史战绩、不能续看或再结算）；
//   4) 重置赛站，再统一重算赛季合约对账与赛季名次。
// 所有资金改动（奖金冲回、押金补退、合约兑现/冲回）在同一事务边界一次完成；函数天然幂等：
// 已作废的记录与已删流水在重启时不会被再次统计，已回写的租约退款也不会二次补退。
function reconcileLegacySkips() {
  const cs = orderedCircuits()
  const firstOpen = cs.findIndex(c => !c.finished)
  if (firstOpen === -1) return
  const skipped = cs.slice(firstOpen + 1).filter(c => c.finished)
  if (!skipped.length) return

  db.exec('BEGIN')
  try {
    let ptsBack = 0, moneyBack = 0, repBack = 0, refundBack = 0, claimPayBack = 0, claimRepBack = 0, racesVoided = 0
    skipped.forEach(c => {
      // 已被 races 记录认领的流水 id：其数额随记录回滚，兜底循环里不得再统计，避免双重回滚
      const claimedLogIds = new Set()
      // 该越站赛站的全部比赛记录：已结算的按记录反向回滚；running 仅作废（从未发奖）
      all('SELECT * FROM races WHERE circuit_id=? ORDER BY id ASC', c.id).forEach(rw => {
        if (rw.settled || rw.status === 'settled') {
          const g = reverseSettledRace(rw, c)
          ptsBack += g.pts; moneyBack += g.money; repBack += g.repGain
          refundBack += g.refundAdd   // 已归还租约需补退的磨损费（回写租约行，由这里统一给钱）
          claimPayBack += g.claimPayBack // 已领取的保险赔付（资金）对称收回
          claimRepBack += g.claimRepBack // 已发放的声望救济对称收回
          if (rw.id) all('SELECT id FROM race_log WHERE race_id=?', rw.id).forEach(l => claimedLogIds.add(l.id))
        }
        run("UPDATE races SET status='void', settled=0, voided_at=? WHERE id=?", now(), rw.id)
        racesVoided += 1
      })
      // 兜底：早期版本可能留下无 races 关联（或关联未结算记录）的流水，按其自身数额补偿，
      // 声望缺失时按名次/难度重算；已被上面的比赛记录认领的流水一律跳过，确保每条只回滚一次
      all('SELECT * FROM race_log WHERE circuit_id=?', c.id).forEach(l => {
        if (claimedLogIds.has(l.id)) { run('DELETE FROM race_log WHERE id=?', l.id); return }
        ptsBack += l.pts || 0
        moneyBack += l.money || 0
        repBack += Math.max(1, 5 - (l.rank || c.rank || 6) + c.diff)
        run('DELETE FROM race_log WHERE id=?', l.id)
      })
      console.log(`[SKY] 历史修复：赛站《${c.name}》在前置赛站未完成时已完赛（名次 ${c.rank}），回滚战绩、奖励、磨损与人员经验`)
      run('UPDATE circuits SET finished=0, rank=NULL WHERE id=?', c.id)
    })
    // 资金冲回口径：奖金冲回 + 已领保险赔付收回 − 押金磨损费补退（refundBack）；
    // 声望冲回：比赛净声望（已扣事故损失）+ 已领保险声望救济，全部在同一边界一次完成
    const netMoney = moneyBack + claimPayBack - refundBack
    const repTotal = repBack + claimRepBack
    if (ptsBack || netMoney || repTotal) {
      // netMoney 可能为负（押金补退大于奖金冲回时是净入账）：用 money+(-netMoney) 而非 money-netMoney，
      // 避免 SQLite 中 NULL 参与算术（某值为 NULL 时 money-? 整体变 NULL）；声望不低于 0
      run('UPDATE team SET season_pts=MAX(0,season_pts-?), money=money+?, rep=MAX(0,rep-?) WHERE id=1',
        ptsBack, -netMoney, repTotal)
    }

    reconcileContracts()
    const ranks = orderedCircuits().filter(x => x.finished && x.rank).map(x => x.rank)
    run('UPDATE team SET season_pos=? WHERE id=1', ranks.length ? Math.max(1, Math.min(...ranks)) : 1)
    db.exec('COMMIT')
    console.log(`[SKY] 历史修复完成：作废 ${racesVoided} 条越站比赛记录（${skipped.length} 个赛站），` +
      `积分 -${ptsBack}，奖金 -${moneyBack}，声望 -${repTotal}` +
      (refundBack ? `，补退已归还租约磨损费 +${refundBack}` : '') +
      (claimPayBack ? `，收回保险赔付 -${claimPayBack}` : '') +
      '，部件磨损、人员经验与保险理赔已按记录冲回')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 历史修复失败，已回滚本次迁移补偿', e)
    throw e
  }
}
seed()
ensureContracts()
ensureLineup()
reconcileLegacySkips()
// 启动兜底：无越站可修（或老库/注入数据导致合约状态与战绩不一致）时，上面的修复不会跑对账；
// 这里再幂等对账一次，使「已兑现」始终与本赛季已结算战绩一致（重复执行不产生二次发奖）
db.exec('BEGIN')
try { reconcileContracts(); db.exec('COMMIT') } catch (e) { db.exec('ROLLBACK'); throw e }
// 保险兜底：作废比赛若仍挂着非终态理赔单，按越站回滚同口径幂等收尾（已赔付的收回资金/声望）
db.exec('BEGIN')
try {
  const n = reconcileOrphanClaims()
  db.exec('COMMIT')
  if (n) console.log(`[SKY] 保险历史修复完成：${n} 单关联作废比赛的理赔已对称冲回`)
} catch (e) { db.exec('ROLLBACK'); throw e }

/* ================= 赛事事故与保险理赔：投保 / 报案 / 定损 / 赔付 =================
 * 事实边界：事故的损伤、责任、声望损失只存在于 races.record.accident（开赛快照）；
 * 赔付口径只存在于 races.record.factors.policy（开赛快照保单）。理赔单全程不接受客户端
 * 提交的金额字段，定损与赔付一律由服务端按两份快照核定，状态机推进幂等（每状态有唯一闸门）。
 */
// 本场事故损伤的单位维修成本：租约艇按开赛快照租约的磨损费率（影响押金），自有艇按维护单价
function raceDamageRate(rec) {
  const snap = rec?.factors?.rental
  if (snap) {
    if (Number.isInteger(snap.wearRate) && snap.wearRate > 0) return snap.wearRate
    const rt = get('SELECT wear_rate FROM rentals WHERE id=?', snap.id)
    if (rt?.wear_rate) return rt.wear_rate
  }
  return OWN_REPAIR_RATE
}
// 定损核定系数：按理赔单 id 稳定落在 0.88~1.0（保险方核定口径，同一单多次查看不变）
function assessFactor(claimId) {
  const h = Math.abs((claimId * 2654435761) % 100)
  return +(0.88 + (h % 13) / 100).toFixed(2)
}
// 理赔单对外视图（关联比赛/赛道/租约信息，供抽屉与结算卡渲染）
function claimRowPayload(cl) {
  const rw = get('SELECT * FROM races WHERE id=?', cl.race_id)
  let rec = null
  try { rec = rw ? JSON.parse(rw.record) : null } catch (e) { rec = null }
  const circuit = rec?.circuit || {}
  return {
    id: cl.id, raceId: cl.race_id, season: cl.season,
    policyId: cl.policy_id, rentalId: cl.rental_id,
    circuitId: circuit.id ?? rw?.circuit_id ?? null,
    circuitName: circuit.name || '未知赛站',
    weather: circuit.weather || rec?.factors?.weather || '',
    severity: cl.severity, severityLabel: rec?.accident?.severityLabel || '',
    fault: cl.fault, faultLabel: rec?.accident?.faultLabel || '',
    part: rec?.accident?.part || '', accidentText: rec?.accident?.text || '',
    damage: cl.damage, repLoss: cl.rep_loss,
    loss: cl.loss, assessedLoss: cl.assessed_loss, deductible: cl.deductible,
    payable: cl.payable, payout: cl.payout, repRelief: cl.rep_relief,
    status: cl.status, rank: rw?.rank ?? null,
    reportNote: cl.report_note, assessNote: cl.assess_note,
    createdAt: cl.created_at, assessedAt: cl.assessed_at, paidAt: cl.paid_at
  }
}
// 保险中心视图：当前赛季保单、三档方案目录、理赔单（新→旧）、本季「未报案事故」提醒
function insurancePayload() {
  const t = teamCore()
  const cur = activePolicy(t.season)
  const claims = all('SELECT * FROM insurance_claims ORDER BY id DESC').map(claimRowPayload)
  const claimedRaceIds = new Set(claims.map(c => c.raceId))
  // 已结算、有事故、无理赔单且开赛时带保单快照的比赛——可去理赔单列表上方的「待报案事故」里补报
  const pendingAccidents = all("SELECT * FROM races WHERE status='settled' AND settled=1 ORDER BY id DESC")
    .map(r => {
      let rec = null
      try { rec = JSON.parse(r.record) } catch (e) { rec = null }
      if (!rec?.accident || claimedRaceIds.has(r.id)) return null
      if (!rec.factors?.policy) return null
      return {
        raceId: r.id, season: rec.season, circuitName: rec.circuit?.name || '未知赛站',
        weather: rec.circuit?.weather || '', severity: rec.accident.severity,
        severityLabel: rec.accident.severityLabel, faultLabel: rec.accident.faultLabel,
        damage: rec.accident.damage, text: rec.accident.text
      }
    })
    .filter(Boolean)
  return {
    plans: INSURANCE_PLANS,
    current: cur ? {
      id: cur.id, planId: cur.plan_id, name: cur.name, season: cur.season,
      premium: cur.premium, cover: cur.cover, deductible: cur.deductible,
      repRelief: cur.rep_relief, status: cur.status, createdAt: cur.created_at
    } : null,
    claims, pendingAccidents
  }
}
// 取一条理赔单（不存在抛 404 由路由映射）
function getClaim(id) { return get('SELECT * FROM insurance_claims WHERE id=?', Number(id)) }
// 启动兜底对账：被历史修复作废（void）的比赛若仍挂着非 reversed 的理赔单，
// 按 reverseSettledRace 同口径收尾（已赔付的收回资金/声望），幂等不重复处理
function reconcileOrphanClaims() {
  const orphans = all(`SELECT c.* FROM insurance_claims c JOIN races r ON r.id=c.race_id
    WHERE r.status='void' AND c.status!='reversed'`)
  let payBack = 0, repBack = 0
  orphans.forEach(cl => {
    const rw = get('SELECT * FROM races WHERE id=?', cl.race_id)
    const circuit = get('SELECT * FROM circuits WHERE id=?', rw.circuit_id)
    const g = reverseSettledRace(rw, circuit)
    payBack += g.claimPayBack
    repBack += g.claimRepBack
  })
  if (payBack || repBack) run('UPDATE team SET money=MAX(0,money-?), rep=MAX(0,rep-?) WHERE id=1', payBack, repBack)
  return orphans.length
}

/* ---------- 共享响应 ---------- */
const payload = () => {
  const t = teamCore()
  const lu = resolveLineup()
  const st = fleetStats(lu.rental)  // 机库主卡展示「下一站实际出赛艇」（排班解析结果）
  const upgrades = all('SELECT * FROM upgrades')
  const pilots = all('SELECT * FROM pilots')
  const mechanics = all('SELECT * FROM mechanics')
  const circuits = orderedCircuits()
  const contracts = contractsPayload(t.season)
  const insurance = insurancePayload()
  const log = all('SELECT * FROM race_log ORDER BY id DESC')
  const done = circuits.filter(c => c.finished).length
  // 中断续看：当前未结算的比赛（每场仅一场 running）；history 供历史回放
  const activeRow = get("SELECT * FROM races WHERE status='running' ORDER BY id DESC LIMIT 1")
  const raceRows = all("SELECT * FROM races WHERE status='settled' ORDER BY id DESC")
  return {
    team: t, airship: st, upgrades, pilots, mechanics, circuits, contracts, insurance, log,
    shop: SHOP_ITEMS,
    // 赛事排班：原始排班 + 下一站实际出赛阵容（机师/技工/出赛艇）
    lineup: lineupPayload(),
    // 租赁：当前生效租约（null=自有艇出赛）、艇型目录与最近归还记录
    rental: activeRental(),
    rentalShop: RENTAL_SHIPS,
    rentalHistory: all("SELECT * FROM rentals WHERE status='returned' ORDER BY id DESC LIMIT 5"),
    activeRace: parseRace(activeRow),
    races: raceRows.map(parseRace),
    // 历届赛季榜（seasons 归档行 + 当前赛季滚动行）；6 站完赛、尚未衔接时提示进入新赛季
    seasons: seasonsPayload(),
    seasonComplete: done === circuits.length && circuits.length > 0,
    seasonDone: done, seasonTotal: circuits.length
  }
}

app.get('/api/state', (_, res) => res.json(payload()))
app.get('/api/overview', (_, res) => res.json(payload()))

// 商品目录（服务端配置，供前端渲染商店）：价格/属性均不在客户端可写
app.get('/api/shop', (_, res) => res.json({ ok: true, items: SHOP_ITEMS }))

// 购买改装件：客户端只能提交商品 id；名称、槽位、加成项、加成数值与价格全部以服务端
// SHOP_ITEMS 配置为准，请求体里任何 price/bonus/stat/slot/name 都不会被采信。
app.post('/api/shop', (req, res) => {
  const rawId = req.body?.id
  // 必须是 JSON 数值（拒绝字符串/布尔等可被 Number() 隐式转换的类型），且为正整数
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return res.status(400).json({ ok: false, msg: '商品编号无效' })
  }
  const item = SHOP_MAP.get(rawId)
  if (!item) return res.status(400).json({ ok: false, msg: '该商品不存在' })

  // 扣款与入库放在同一事务（BEGIN IMMEDIATE 立即取写锁）：余额检查与扣款原子完成，
  // 并发请求不会在「检查通过→实际扣款」之间把资金扣成负数
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const t = teamCore()
    if (t.money < item.price) {
      result = { status: 400, body: { ok: false, msg: '资金不足', price: item.price } }
    } else {
      run('UPDATE team SET money=money-? WHERE id=1', item.price)
      const r = run('INSERT INTO upgrades (name,slot,stat,bonus,price,level) VALUES (?,?,?,?,?,1)',
        item.name, item.slot, item.stat, item.bonus, item.price)
      result = { status: 200, body: { ok: true, msg: `已购入「${item.name}」`, id: Number(r.lastInsertRowid), price: item.price } }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 购买失败', e)
    result = { status: 500, body: { ok: false, msg: '购买失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})
// 装备/卸下
app.post('/api/equip/:id', (req, res) => {
  const up = get('SELECT * FROM upgrades WHERE id=?', Number(req.params.id))
  // 同槽位卸下其他
  all('SELECT id FROM upgrades WHERE slot=? AND equipped=1 AND id!=?', up.slot, up.id).forEach(u => run('UPDATE upgrades SET equipped=0 WHERE id=?', u.id))
  run('UPDATE upgrades SET equipped=1 WHERE id=?', up.id)
  res.json({ ok: true })
})
app.post('/api/unequip/:id', (req, res) => {
  run('UPDATE upgrades SET equipped=0 WHERE id=?', Number(req.params.id))
  res.json({ ok: true })
})

// 人员
app.post('/api/hire_pilot', (req, res) => {
  const t = teamCore(); const cost = 1500
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  const names = ['鹰眼·鸦', '风歌·岚', '铁羽·矶', '晨星·曦']
  const n = names[Math.floor(Math.random() * names.length)]
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('INSERT INTO pilots (name,skill,courage,wage,mood) VALUES (?,?,?,?,?)', n, 45 + Math.floor(Math.random() * 20), 48 + Math.floor(Math.random() * 18), 60, 72)
  res.json({ ok: true, msg: `已招募 ${n}` })
})
app.post('/api/hire_mech', (req, res) => {
  const t = teamCore(); const cost = 1000
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  const n = '工匠·' + ['铁锤', '螺丝', '风箱', '砧台'][Math.floor(Math.random() * 4)]
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('INSERT INTO mechanics (name,skill,wage,mood) VALUES (?,?,?,?)', n, 40 + Math.floor(Math.random() * 20), 40, 74)
  res.json({ ok: true, msg: `已招募 ${n}` })
})
app.post('/api/train', (req, res) => {
  const t = teamCore(); const cost = 800
  if (t.money < cost) return res.json({ ok: false, msg: '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE pilots SET skill=skill+2, mood=mood+2 WHERE id=?', Number(req.body.id) || all('SELECT id FROM pilots LIMIT 1')[0].id)
  res.json({ ok: true, msg: '完成特训，技巧+2' })
})

/* ---------- 赛事排班：安排下一站出赛的机师 / 技工 / 飞艇 ---------- */

// 当前排班 + 下一站实际出赛阵容（含自动回落与缺租约警告）
app.get('/api/lineup', (_, res) => res.json({ ok: true, ...lineupPayload() }))

// 更新排班：请求体只接受 pilotId / mechanicId / shipMode 三个字段（省略的字段保持原值，
// null = 恢复自动）；人员 id 必须在车队名册中，其余字段一律忽略。排班在开赛瞬间才快照进
// 比赛记录，比赛进行中修改只影响下一站，不影响正在播放/结算的记录。
app.post('/api/lineup', (req, res) => {
  const b = req.body || {}
  const cur = lineupRow()
  let pilotId = cur.pilot_id, mechanicId = cur.mechanic_id, shipMode = cur.ship_mode
  if ('pilotId' in b) {
    if (b.pilotId === null) pilotId = null
    else if (typeof b.pilotId === 'number' && Number.isInteger(b.pilotId) && b.pilotId > 0 &&
      get('SELECT id FROM pilots WHERE id=?', b.pilotId)) pilotId = b.pilotId
    else return res.status(400).json({ ok: false, msg: '该机师不在车队名册中' })
  }
  if ('mechanicId' in b) {
    if (b.mechanicId === null) mechanicId = null
    else if (typeof b.mechanicId === 'number' && Number.isInteger(b.mechanicId) && b.mechanicId > 0 &&
      get('SELECT id FROM mechanics WHERE id=?', b.mechanicId)) mechanicId = b.mechanicId
    else return res.status(400).json({ ok: false, msg: '该技工不在车队名册中' })
  }
  if ('shipMode' in b) {
    if (!SHIP_MODES.includes(b.shipMode)) return res.status(400).json({ ok: false, msg: '出赛艇排班无效（auto/own/rental）' })
    shipMode = b.shipMode
  }
  run(`INSERT INTO lineup (id,pilot_id,mechanic_id,ship_mode,updated_at) VALUES (1,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET pilot_id=excluded.pilot_id, mechanic_id=excluded.mechanic_id,
    ship_mode=excluded.ship_mode, updated_at=excluded.updated_at`,
    pilotId, mechanicId, shipMode, now())
  res.json({ ok: true, msg: '排班已更新，下一站生效', ...lineupPayload() })
})

// 维护
app.post('/api/maintain', (req, res) => {
  // 排班出赛艇为租约艇时：租赁艇由出租方整备（磨损在归还时计费），自有艇封存，均不可自行维护；
  // 排班为自有艇出赛时（即便有在履租约），自有艇正常磨损，可随时维护
  if (resolveLineup().rental) return res.json({ ok: false, msg: '租约艇由出租方整备；如需维护自有艇，请先将排班出赛艇调整为自有艇' })
  const t = teamCore(); const a = airship()
  const cost = Math.round((100 - a.parts_dur) * 25)
  if (cost < 200 || t.money < 200) return res.status(200).json({ ok: false, cost, msg: cost < 200 ? '部件状态良好，无需维护' : '资金不足' })
  run('UPDATE team SET money=money-? WHERE id=1', cost)
  run('UPDATE airships SET parts_dur=100, hp=100 WHERE id=?', a.id)
  res.json({ ok: true, cost })
})

/* ---------- 飞艇租赁：签约（扣押金+租金）/ 归还（按磨损结算退款，幂等） ---------- */

// 租赁目录与当前租约（目录为服务端配置，客户端不可改写）
app.get('/api/rentals', (_, res) => res.json({
  ok: true,
  items: RENTAL_SHIPS,
  active: activeRental(),
  history: all("SELECT * FROM rentals WHERE status='returned' ORDER BY id DESC LIMIT 5")
}))

// 签约租艇：客户端只提交艇型 id；押金、租金、性能与场次以服务端目录核定。
// 同一事务（BEGIN IMMEDIATE）内完成「无在履租约 → 资金校验 → 扣款 → 建约」，
// 并发/重复点击不会重复扣款或叠加多份租约。
app.post('/api/rentals/rent', (req, res) => {
  const rawId = req.body?.id
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return res.status(400).json({ ok: false, msg: '艇型编号无效' })
  }
  const cfg = RENTAL_MAP.get(rawId)
  if (!cfg) return res.status(400).json({ ok: false, msg: '该艇型不存在' })

  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const cur = activeRental()
    if (cur) {
      result = { status: 409, body: { ok: false, msg: `已有进行中的租约《${cur.name}》，归还后方可再租` } }
    } else if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
      // 比赛进行中签约会中途切换出赛艇，破坏比赛记录的唯一事实来源，一律拒绝
      result = { status: 409, body: { ok: false, msg: '比赛进行中，完赛结算后方可签约租艇' } }
    } else {
      const t = teamCore()
      const cost = cfg.deposit + cfg.rent
      if (t.money < cost) {
        result = { status: 400, body: { ok: false, msg: '资金不足，无法支付押金与租金', cost } }
      } else {
        run('UPDATE team SET money=money-? WHERE id=1', cost)
        const r = run(`INSERT INTO rentals (ship_id,name,speed,turn,acc,dur,deposit,rent_fee,wear_rate,max_races,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          cfg.id, cfg.name, cfg.speed, cfg.turn, cfg.acc, cfg.dur, cfg.deposit, cfg.rent, cfg.wearRate, cfg.maxRaces, now())
        result = { status: 200, body: { ok: true, msg: `已签约租用「${cfg.name}」（押金 ¥${cfg.deposit} + 租金 ¥${cfg.rent}）`, id: Number(r.lastInsertRowid) } }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 租艇签约失败', e)
    result = { status: 500, body: { ok: false, msg: '签约失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

// 归还租艇：按租约结算——磨损费 = 累计磨损 × 费率，退款 = 押金 − 磨损费（下限 0）。
// 以 status='active' 为唯一闸门（事务内判定并置 returned），重复请求/断线重放只结算一次；
// 已归还时返回同一份结算结果（幂等），绝不二次退款。
app.post('/api/rentals/return', (req, res) => {
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const r = activeRental()
    if (!r) {
      const last = get("SELECT * FROM rentals WHERE status='returned' ORDER BY id DESC LIMIT 1")
      if (last) {
        result = { status: 200, body: { ok: true, already: true, msg: `租约《${last.name}》已结算归还，不会重复退款`, refund: last.refund, wearFee: last.wear_fee, name: last.name } }
      } else {
        result = { status: 400, body: { ok: false, msg: '当前没有进行中的租约' } }
      }
    } else if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
      result = { status: 409, body: { ok: false, msg: '比赛进行中，完赛结算后方可归还租艇' } }
    } else {
      // 保险联动：已由保险赔付覆盖的事故损伤（insured_wear）不再计入押金磨损，
      // 计费基数 = 累计磨损 − 保险覆盖磨损；退款 = 押金 − 磨损费（下限 0）
      const wearBillable = Math.max(0, (r.wear_total || 0) - (r.insured_wear || 0))
      const wearFee = wearBillable * r.wear_rate
      const refund = Math.max(0, r.deposit - wearFee)
      run('UPDATE team SET money=money+? WHERE id=1', refund)
      run("UPDATE rentals SET status='returned', wear_fee=?, refund=?, returned_at=? WHERE id=?", wearFee, refund, now(), r.id)
      result = { status: 200, body: { ok: true, already: false, msg: `已归还「${r.name}」：磨损费 ¥${wearFee}（保险覆盖 ${r.insured_wear || 0} 点损伤），退还押金 ¥${refund}`, refund, wearFee, insuredWear: r.insured_wear || 0, name: r.name } }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 归还结算失败', e)
    result = { status: 500, body: { ok: false, msg: '归还结算失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

/* ---------- 赛事事故与保险：投保 / 报案 / 定损 / 赔付（金额一律服务端按快照核定） ---------- */

// 保险中心：方案目录 + 当前赛季保单 + 理赔单 + 待报案事故
app.get('/api/insurance', (_, res) => res.json({ ok: true, ...insurancePayload() }))

// 投保：客户端只能提交方案 id；保费与赔付口径以服务端方案配置为准。
// 每赛季最多一份保单（唯一闸门），比赛进行中拒绝（中途投保不溯及开赛快照）。
app.post('/api/insurance/buy', (req, res) => {
  const rawId = req.body?.id
  if (typeof rawId !== 'number' || !Number.isInteger(rawId) || rawId <= 0) {
    return res.status(400).json({ ok: false, msg: '保险方案编号无效' })
  }
  const plan = INSURANCE_MAP.get(rawId)
  if (!plan) return res.status(400).json({ ok: false, msg: '该保险方案不存在' })

  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const t = teamCore()
    if (activePolicy(t.season)) {
      result = { status: 409, body: { ok: false, msg: '本赛季已投保，无需重复购买' } }
    } else if (get("SELECT id FROM races WHERE status='running' LIMIT 1")) {
      result = { status: 409, body: { ok: false, msg: '比赛进行中，请在开赛前完成投保' } }
    } else if (t.money < plan.premium) {
      result = { status: 400, body: { ok: false, msg: '资金不足，无法支付保费', premium: plan.premium } }
    } else {
      run('UPDATE team SET money=money-? WHERE id=1', plan.premium)
      const r = run(`INSERT INTO insurance_policies (plan_id,name,season,premium,cover,deductible,rep_relief,created_at)
        VALUES (?,?,?,?,?,?,?,?)`,
        plan.id, plan.name, t.season, plan.premium, plan.cover, plan.deductible, plan.repRelief, now())
      result = { status: 200, body: { ok: true, msg: `已投保「${plan.name}」（保费 ¥${plan.premium}，本季有效）`, id: Number(r.lastInsertRowid) } }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 投保失败', e)
    result = { status: 500, body: { ok: false, msg: '投保失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

// 报案：为一场已结算且发生事故的比赛登记理赔单。能否承保只看开赛快照保单（跨赛季老事故也可报）。
// 客户端不提交任何金额；登记损失 = 事故损伤 × 该场维修/磨损费率，仅为报案预估，定损时重新核定。
app.post('/api/insurance/claims/report/:raceId', (req, res) => {
  const raceId = Number(req.params.raceId)
  if (!Number.isInteger(raceId) || raceId <= 0) return res.status(400).json({ ok: false, msg: '比赛编号无效' })
  const rw = getRaceRow(raceId)
  if (!rw) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  if (rw.status === 'void') return res.status(409).json({ ok: false, msg: '该比赛已作废，不能报案' })
  if (!rw.settled) return res.status(409).json({ ok: false, msg: '比赛尚未结算，完赛后才能报案' })

  let rec = null
  try { rec = JSON.parse(rw.record) } catch (e) { rec = null }
  const acc = rec?.accident
  if (!acc) return res.status(409).json({ ok: false, msg: '本场比赛未发生事故，无需报案' })
  const policy = racePolicy(rec)
  if (!policy) return res.status(409).json({ ok: false, msg: '开赛时未投保赛事险，本场事故无法理赔' })

  const exist = get('SELECT * FROM insurance_claims WHERE race_id=?', raceId)
  if (exist) return res.status(200).json({ ok: true, already: true, msg: '该场事故已报案，请勿重复报案', claim: claimRowPayload(exist) })

  const rentalSnap = rec.factors?.rental
  const rt = rentalSnap ? get('SELECT * FROM rentals WHERE id=?', rentalSnap.id) : null
  const rate = raceDamageRate(rec)
  const loss = acc.damage * rate
  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const dup = get('SELECT * FROM insurance_claims WHERE race_id=?', raceId)
    if (dup) {
      result = { status: 200, body: { ok: true, already: true, msg: '该场事故已报案，请勿重复报案', claim: claimRowPayload(dup) } }
    } else {
      const r = run(`INSERT INTO insurance_claims
        (race_id,season,policy_id,rental_id,severity,fault,damage,rep_loss,loss,status,report_note,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        raceId, rec.season ?? rw.season, policy.id, rt?.id ?? null,
        acc.severity, acc.fault, acc.damage, acc.repLoss || 0, loss, 'reported',
        `事故报案：${acc.text}（损伤 ${acc.damage} 点，预估损失 ¥${loss}）`, now())
      result = {
        status: 200, body: {
          ok: true, already: false, msg: `已受理报案：${acc.severityLabel}，预估损失 ¥${loss}，等待保险方定损`,
          claim: claimRowPayload(getClaim(Number(r.lastInsertRowid)))
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 报案失败', e)
    result = { status: 500, body: { ok: false, msg: '报案失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

// 定损：保险方核定损失（报案预估 × 核定系数）；对手责任 / 天气不可抗力免免赔额，
// 己方责任扣保单免赔额；赔付 = 核定净额 × 赔付比例。低于免赔（净额≤0）直接拒赔，状态终态。
// 以 status='reported' 为唯一闸门，重复定损返回同一份核定结果（幂等）。
app.post('/api/insurance/claims/:id/assess', (req, res) => {
  const cl = getClaim(req.params.id)
  if (!cl) return res.status(404).json({ ok: false, msg: '理赔单不存在' })
  if (cl.status === 'assessed' || cl.status === 'paid') {
    return res.json({ ok: true, already: true, msg: '该理赔单已定损', claim: claimRowPayload(cl.status === 'paid' ? cl : cl) })
  }
  if (cl.status === 'rejected') return res.status(409).json({ ok: false, msg: '该理赔单已拒赔', claim: claimRowPayload(cl) })
  if (cl.status === 'reversed') return res.status(409).json({ ok: false, msg: '该理赔单关联比赛已作废' })
  if (cl.status !== 'reported') return res.status(409).json({ ok: false, msg: '理赔单状态不允许定损' })

  const rw = getRaceRow(cl.race_id)
  if (!rw || rw.status === 'void') return res.status(409).json({ ok: false, msg: '关联比赛已作废，定损中止' })
  let rec = null
  try { rec = JSON.parse(rw.record) } catch (e) { rec = null }
  const policy = racePolicy(rec)

  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const again = getClaim(cl.id)
    if (again.status !== 'reported') {
      result = { status: 200, body: { ok: true, already: true, msg: '该理赔单已定损', claim: claimRowPayload(again) } }
    } else {
      const factor = assessFactor(cl.id)
      const assessedLoss = Math.round(cl.loss * factor)
      // 免赔额只对己方责任生效；对手剐蹭与天气不可抗力全额计入核定净额
      const deductible = cl.fault === 'pilot' ? Math.min(policy.deductible, assessedLoss) : 0
      const net = Math.max(0, assessedLoss - deductible)
      const payable = Math.round(net * policy.cover / 100)
      if (payable <= 0) {
        const note = `定损核结：核定损失 ¥${assessedLoss}，免赔额 ¥${deductible}，赔付比例 ${policy.cover}%，赔付 ¥0，不予赔付`
        run("UPDATE insurance_claims SET status='rejected', assessed_loss=?, deductible=?, payable=0, assess_note=?, assessed_at=? WHERE id=?",
          assessedLoss, deductible, note, now(), cl.id)
        result = { status: 200, body: { ok: true, rejected: true, msg: note, claim: claimRowPayload(getClaim(cl.id)) } }
      } else {
        const note = `定损完成：核定损失 ¥${assessedLoss}（系数 ×${factor}），免赔额 ¥${deductible}，赔付比例 ${policy.cover}%，应赔 ¥${payable}`
        run("UPDATE insurance_claims SET status='assessed', assessed_loss=?, deductible=?, payable=?, assess_note=?, assessed_at=? WHERE id=?",
          assessedLoss, deductible, payable, note, now(), cl.id)
        result = { status: 200, body: { ok: true, msg: note, claim: claimRowPayload(getClaim(cl.id)) } }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 定损失败', e)
    result = { status: 500, body: { ok: false, msg: '定损失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

// 领取赔付：以 status='assessed' 为唯一闸门，资金入账 + 按保单比例恢复事故声望损失；
// 租约艇事故：赔付后该部分损伤转为保险方与出租方结算，从押金磨损计费基数中剔除。
app.post('/api/insurance/claims/:id/pay', (req, res) => {
  const cl = getClaim(req.params.id)
  if (!cl) return res.status(404).json({ ok: false, msg: '理赔单不存在' })
  if (cl.status === 'paid') return res.json({ ok: true, already: true, msg: '赔付款已到账', claim: claimRowPayload(cl) })
  if (cl.status === 'rejected') return res.status(409).json({ ok: false, msg: '该理赔单已被拒赔', claim: claimRowPayload(cl) })
  if (cl.status === 'reversed') return res.status(409).json({ ok: false, msg: '该理赔单关联比赛已作废' })
  if (cl.status !== 'assessed') return res.status(409).json({ ok: false, msg: '请先完成定损，再领取赔付' })

  const rw = getRaceRow(cl.race_id)
  if (!rw || rw.status === 'void') return res.status(409).json({ ok: false, msg: '关联比赛已作废，赔付中止' })
  let rec = null
  try { rec = JSON.parse(rw.record) } catch (e) { rec = null }
  const policy = racePolicy(rec)

  let result
  db.exec('BEGIN IMMEDIATE')
  try {
    const again = getClaim(cl.id)
    if (again.status === 'paid') {
      result = { status: 200, body: { ok: true, already: true, msg: '赔付款已到账', claim: claimRowPayload(again) } }
    } else if (again.status !== 'assessed') {
      result = { status: 409, body: { ok: false, msg: '理赔单状态不允许领取赔付' } }
    } else {
      const payout = again.payable || 0
      const relief = Math.round((again.rep_loss || 0) * policy.rep_relief / 100)
      run('UPDATE team SET money=money+?, rep=rep+? WHERE id=1', payout, relief)
      if (again.rental_id && again.damage) {
        // 租约艇：事故损伤由保险覆盖，从押金计费基数剔除（归还时只对剩余磨损收费）；
        // active / returned 两种状态都处理——已钱货两讫的租约同时补退这部分磨损费
        const rt = get('SELECT * FROM rentals WHERE id=?', again.rental_id)
        if (rt) {
          if (rt.status === 'returned') {
            const insuredNew = Math.min(rt.wear_total, (rt.insured_wear || 0) + again.damage)
            const wearBillable = Math.max(0, rt.wear_total - insuredNew)
            const wearFee2 = wearBillable * rt.wear_rate
            const refund2 = Math.max(0, rt.deposit - wearFee2)
            const refundAdd = Math.max(0, refund2 - (rt.refund || 0))
            run('UPDATE rentals SET insured_wear=?, wear_fee=?, refund=? WHERE id=?', insuredNew, wearFee2, refund2, rt.id)
            if (refundAdd > 0) run('UPDATE team SET money=money+? WHERE id=1', refundAdd)
            run("UPDATE insurance_claims SET status='paid', payout=?, rep_relief=?, paid_at=? WHERE id=?",
              payout + refundAdd, relief, now(), cl.id)
            result = {
              status: 200, body: {
                ok: true, msg: `赔付款 ¥${payout} 已到账，声望 +${relief}；租约事故损伤由保险覆盖，另补退押金磨损费 ¥${refundAdd}`,
                payout: payout + refundAdd, claimPayout: payout, rentalRefund: refundAdd, repRelief: relief,
                claim: claimRowPayload(getClaim(cl.id))
              }
            }
          } else {
            run('UPDATE rentals SET insured_wear=insured_wear+? WHERE id=?', again.damage, rt.id)
            run("UPDATE insurance_claims SET status='paid', payout=?, rep_relief=?, paid_at=? WHERE id=?",
              payout, relief, now(), cl.id)
            result = {
              status: 200, body: {
                ok: true, msg: `赔付款 ¥${payout} 已到账，声望 +${relief}；事故损伤将不再计入租约押金磨损`,
                payout, repRelief: relief, claim: claimRowPayload(getClaim(cl.id))
              }
            }
          }
        }
      }
      if (!result) {
        run("UPDATE insurance_claims SET status='paid', payout=?, rep_relief=?, paid_at=? WHERE id=?",
          payout, relief, now(), cl.id)
        result = {
          status: 200, body: {
            ok: true, msg: `赔付款 ¥${payout} 已到账，声望 +${relief}，受损部件可回机库维护`,
            payout, repRelief: relief, claim: claimRowPayload(getClaim(cl.id))
          }
        }
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    console.error('[SKY] 赔付失败', e)
    result = { status: 500, body: { ok: false, msg: '赔付失败，请重试' } }
  }
  return res.status(result.status).json(result.body)
})

/* ---------- 分段比赛：开赛（生成记录）/ 续看 / 进度 / 结算（幂等） ---------- */

// 开赛：仅允许按航线顺序挑战当前未完成的第一站；比赛记录在这一刻完整生成并落库
app.post('/api/races/start/:cid', (req, res) => {
  const cid = Number(req.params.cid)
  // 已有进行中的比赛 → 直接返回原记录用于「中断续看」，绝不重开、不重复结算
  const active = get("SELECT * FROM races WHERE status='running' ORDER BY id DESC LIMIT 1")
  if (active) return res.json({ ok: true, resumed: true, race: parseRace(active) })

  const c = get('SELECT * FROM circuits WHERE id=?', cid)
  if (!c) return res.json({ ok: false, msg: '该赛站不存在' })
  if (c.finished) return res.json({ ok: false, msg: '该站已完赛' })
  // 排班联动：指定租赁艇出赛但无在履租约时拒绝开赛，须先签约或调整排班
  const lu = resolveLineup()
  if (lu.rentalMissing) {
    return res.json({ ok: false, msg: '排班指定租赁艇出赛，但当前没有在履租约，请先在机库签约或调整排班' })
  }
  // 租约联动：排班出赛艇为租约艇且场次用尽时，须先在机库归还结算，才能继续参赛
  const rt = lu.rental
  if (rt && rt.races_used >= rt.max_races) {
    return res.json({ ok: false, msg: `租约《${rt.name}》场次已用完（${rt.races_used}/${rt.max_races}），请先在机库归还租艇` })
  }
  const cur = nextCircuit()
  if (!cur) return res.json({ ok: false, msg: '本赛季已全部完赛' })
  if (cur.id !== cid) {
    const idx = orderedCircuits().findIndex(x => x.id === cid) + 1
    return res.json({ ok: false, msg: `请先完成第 ${orderedCircuits().findIndex(x => x.id === cur.id) + 1} 站《${cur.name}》，第 ${idx} 站尚未解锁` })
  }

  const record = buildRace(c)
  const r = run('INSERT INTO races (circuit_id, season, status, settled, record, watch_el, created_at) VALUES (?,?,?,?,?,?,?)',
    c.id, record.season, 'running', 0, JSON.stringify(record), 0, now())
  res.json({ ok: true, resumed: false, race: parseRace(getRaceRow(Number(r.lastInsertRowid))) })
})

// 单场比赛记录（历史回放 / 刷新续看进度）
app.get('/api/races/:id', (req, res) => {
  const row = getRaceRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  res.json({ ok: true, race: parseRace(row) })
})

// 上报观赛进度（中断续看锚点），只影响播放位置，与结算无关
app.post('/api/races/:id/progress', (req, res) => {
  const row = getRaceRow(req.params.id)
  if (!row) return res.status(404).json({ ok: false, msg: '比赛记录不存在' })
  if (row.settled) return res.json({ ok: true }) // 已结算无需再记进度
  const el = clamp(Number(req.body?.el) || 0, 0, JSON.parse(row.record).duration)
  run('UPDATE races SET watch_el=? WHERE id=?', el, row.id)
  res.json({ ok: true, watch_el: el })
})

// 结算：以比赛记录为唯一依据；幂等，重复/断线重放都只发一次奖；已作废记录返回 409
app.post('/api/races/:id/settle', (req, res) => {
  try {
    const r = settleRace(Number(req.params.id))
    if (r.status === 404) return res.status(404).json(r)
    if (r.status === 409) return res.status(409).json(r)
    res.json(r)
  } catch (e) {
    console.error('[SKY] 结算失败', e)
    res.status(500).json({ ok: false, msg: '结算失败，请重试' })
  }
})

// 新赛季衔接：6 站完赛后由玩家确认触发。归档老赛季排行榜快照、重置积分/赛站/合约滚动层，
// 老赛季 races/race_log/contracts 原样保留（历史战绩与回放不丢）；车队资金/声望/装备/人员/租约保留。
// 幂等：重复点击 / 并发重放只衔接一次（seasons 归档行为唯一闸门）
app.post('/api/seasons/advance', (_, res) => {
  const r = advanceSeason()
  return res.status(r.status).json(r.body)
})

// 重置（重置数据到初始种子）
app.post('/api/reset', (_, res) => {
  ['race_log', 'races', 'rentals', 'contracts', 'seasons', 'circuits', 'upgrades', 'mechanics', 'pilots', 'airships', 'team', 'lineup', 'insurance_policies', 'insurance_claims'].forEach(t => { try { run(`DELETE FROM ${t}`) } catch (e) {} })
  try { run('DELETE FROM sqlite_sequence') } catch (e) {}
  seed()
  ensureLineup()
  res.json({ ok: true })
})

app.listen(PORT, () => console.log(`[SKY] API running at http://localhost:${PORT}`))
