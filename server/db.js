import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const db = new DatabaseSync(path.join(__dirname, 'sky.db'))

db.exec(`
CREATE TABLE IF NOT EXISTS team (
  id INTEGER PRIMARY KEY,
  name TEXT,
  money REAL DEFAULT 20000,
  rep INTEGER DEFAULT 50,
  level INTEGER DEFAULT 1,
  season INTEGER DEFAULT 1,
  season_pts INTEGER DEFAULT 0,
  season_pos INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS airships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  speed INTEGER DEFAULT 60,
  dur INTEGER DEFAULT 80,
  turn INTEGER DEFAULT 55,
  acc INTEGER DEFAULT 60,
  parts_dur INTEGER DEFAULT 100,
  hp INTEGER DEFAULT 100
);
CREATE TABLE IF NOT EXISTS pilots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  skill INTEGER DEFAULT 50,
  courage INTEGER DEFAULT 50,
  exp INTEGER DEFAULT 0,
  wage INTEGER DEFAULT 60,
  mood INTEGER DEFAULT 70
);
CREATE TABLE IF NOT EXISTS mechanics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  skill INTEGER DEFAULT 50,
  wage INTEGER DEFAULT 40,
  mood INTEGER DEFAULT 70
);
CREATE TABLE IF NOT EXISTS upgrades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slot TEXT NOT NULL,          -- 引擎/护甲/氮气/翼板/龙骨
  stat TEXT NOT NULL,          -- speed/dur/turn/acc 加成项
  bonus INTEGER NOT NULL,
  price INTEGER NOT NULL,
  level INTEGER DEFAULT 1,
  equipped INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS circuits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  diff INTEGER NOT NULL,       -- 1..5 难度
  weather TEXT NOT NULL,       -- 晴/风/雨/雾/雷暴
  bonus_pts INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  rank INTEGER,
  finished INTEGER DEFAULT 0
);
-- 赛季合约（取代固定积分型赞助）：条款为服务端配置快照（terms JSON），
-- 进度不入库——始终从本赛季已结算比赛记录（天气/名次/租约快照）现算，
-- 达成全部（或 need 指定数量）条款即在结算事务内一次性兑现奖励；earned=唯一闸门
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  season INTEGER NOT NULL DEFAULT 1,
  note TEXT DEFAULT '',            -- 合约一句话说明（展示用）
  terms TEXT NOT NULL,             -- {v,terms:[...]} 条款配置快照（服务端配置，客户端不可改写）
  need INTEGER NOT NULL,           -- 需达成的条款数（=条款总数即全部达成）
  reward INTEGER NOT NULL DEFAULT 0,
  rep INTEGER NOT NULL DEFAULT 0,
  earned INTEGER NOT NULL DEFAULT 0,
  paid_at TEXT
);
-- 赛季档案（排行榜的单一事实来源）：新赛季衔接时把刚结束赛季的最终战绩快照归档于此，
-- 老赛季的 races/race_log/contracts 原样保留供历史回放；team.season_pts 等滚动数据随之归零。
-- 一季一行（season 唯一），赛季之巅抽屉的历届赛季榜按本表 + 当前赛季滚动数据分层渲染。
CREATE TABLE IF NOT EXISTS seasons (
  season INTEGER PRIMARY KEY,
  pts INTEGER NOT NULL DEFAULT 0,        -- 本赛季最终积分
  money INTEGER NOT NULL DEFAULT 0,      -- 本赛季累计奖金
  rep INTEGER NOT NULL DEFAULT 0,        -- 本赛季累计声望
  wins INTEGER NOT NULL DEFAULT 0,       -- 夺冠（第 1 名）场次
  podiums INTEGER NOT NULL DEFAULT 0,    -- 登台（前 3 名）场次
  best_rank INTEGER,                     -- 本赛季最佳分站名次
  best_pos INTEGER NOT NULL DEFAULT 1,   -- 赛季车队最终名次
  races_n INTEGER NOT NULL DEFAULT 0,    -- 已结算赛站数（完季 = 赛站总数）
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS race_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circuit_id INTEGER,
  race_id INTEGER,             -- 对应 races.id，一场比赛一条流水
  season INTEGER,
  rank INTEGER,
  pts INTEGER,
  money REAL,
  note TEXT,
  ts TEXT
);
-- 飞艇租约：签约时快照艇型性能与费用口径，履行期间的比赛磨损记入租约，
-- 归还时按 wear_total × wear_rate 从押金中结算退款；status=active 履行中 | returned 已归还
CREATE TABLE IF NOT EXISTS rentals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ship_id INTEGER NOT NULL,          -- 租赁目录艇型 id（服务端配置）
  name TEXT NOT NULL,                -- 艇名快照
  speed INTEGER NOT NULL,
  turn INTEGER NOT NULL,
  acc INTEGER NOT NULL,
  dur INTEGER NOT NULL,
  deposit INTEGER NOT NULL,          -- 押金（签约时暂扣，归还时按磨损结算退还）
  rent_fee INTEGER NOT NULL,         -- 租金（签约时一次性收取，不退）
  wear_rate INTEGER NOT NULL,        -- 每点比赛磨损的计费（归还时从押金中扣）
  max_races INTEGER NOT NULL,        -- 租约包含的场次
  races_used INTEGER NOT NULL DEFAULT 0,
  parts_dur INTEGER NOT NULL DEFAULT 100,  -- 租约艇部件健康（比赛磨损实时扣减）
  wear_total INTEGER NOT NULL DEFAULT 0,   -- 租约期间累计磨损（归还计费依据）
  status TEXT NOT NULL DEFAULT 'active',   -- active | returned
  wear_fee INTEGER,                  -- 归还结算的磨损费
  refund INTEGER,                    -- 归还实际退款（押金-磨损费，下限 0）
  created_at TEXT,
  returned_at TEXT
);
-- 赛事排班（单行表，id 恒为 1）：车队为下一站安排的机师 / 技工 / 出赛艇。
-- 人员为 NULL = 自动（最强阵容）；ship_mode = auto（租约在履即租约艇）| own（自有艇）| rental（必须租约艇）。
-- 开赛瞬间解析并快照进 races.record.factors.lineup，结算与历史修复只认快照，事后改排班不影响已开赛记录
CREATE TABLE IF NOT EXISTS lineup (
  id INTEGER PRIMARY KEY CHECK (id=1),
  pilot_id INTEGER,                      -- 指定机师；NULL = 自动
  mechanic_id INTEGER,                   -- 指定技工；NULL = 自动
  ship_mode TEXT NOT NULL DEFAULT 'auto',
  updated_at TEXT
);
-- 赛事保险保单：按赛季投保（一季最多一份），保费投保即扣不退；赔付比例 / 免赔额 /
-- 声望救济比例在投保时快照。赛季衔接后老保单置 expired，但开赛快照（races.record.factors.policy）
-- 已承保的老赛季比赛仍可凭快照报案理赔；新赛季需重新投保。
CREATE TABLE IF NOT EXISTS insurance_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL,            -- 保险方案目录 id（服务端配置）
  name TEXT NOT NULL,
  season INTEGER NOT NULL,
  premium INTEGER NOT NULL,            -- 保费（投保一次性扣除，不退）
  cover INTEGER NOT NULL,              -- 定损金额赔付比例 %
  deductible INTEGER NOT NULL,         -- 免赔额（仅己方责任事故扣除）
  rep_relief INTEGER NOT NULL,         -- 赔付时恢复的事故声望损失比例 %
  status TEXT NOT NULL DEFAULT 'active',  -- active | expired
  created_at TEXT,
  expired_at TEXT
);
-- 保险理赔单：一场比赛最多一单（race_id 唯一）。状态机：
-- reported（已报案）→ assessed（已定损，待领取）→ paid（已赔付，终态）；
-- 定损金额不足免赔 → rejected（终态）；比赛被历史修复作废 → reversed（赔付对称冲回）。
-- 损伤 / 责任一律取自比赛记录（races.record.accident），客户端不可改写。
CREATE TABLE IF NOT EXISTS insurance_claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  race_id INTEGER NOT NULL UNIQUE,
  season INTEGER NOT NULL,
  policy_id INTEGER NOT NULL,
  rental_id INTEGER,                   -- 租约艇事故关联租约；赔付后该部分损伤免计押金（rentals.insured_wear）
  severity TEXT NOT NULL,              -- light | medium | heavy
  fault TEXT NOT NULL,                 -- rival | weather | pilot
  damage INTEGER NOT NULL,             -- 事故损伤点数（比赛记录快照）
  rep_loss INTEGER NOT NULL DEFAULT 0, -- 事故声望损失（比赛记录快照）
  loss INTEGER,                        -- 报案登记损失预估（损伤 × 维修/租约磨损费率）
  assessed_loss INTEGER,               -- 保险方核定损失
  deductible INTEGER NOT NULL DEFAULT 0,
  payable INTEGER,                     -- 核定赔付金额
  payout INTEGER,                      -- 实际到账赔付（领取时写入）
  rep_relief INTEGER NOT NULL DEFAULT 0,  -- 赔付时恢复的声望
  status TEXT NOT NULL,
  report_note TEXT,
  assess_note TEXT,
  created_at TEXT,
  assessed_at TEXT,
  paid_at TEXT,
  reversed_at TEXT
);
-- 比赛记录：动画 / 实时排名 / 最终奖励共用的唯一事实来源
-- status=running 未完赛（可中断续看）；settled=1 已结算（奖励只发一次，可历史回放）
CREATE TABLE IF NOT EXISTS races (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  circuit_id INTEGER NOT NULL,
  season INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'running',  -- running | settled
  settled INTEGER NOT NULL DEFAULT 0,
  rank INTEGER,
  pts INTEGER DEFAULT 0,
  money REAL DEFAULT 0,
  wear INTEGER DEFAULT 0,
  rep_gain INTEGER DEFAULT 0,
  record TEXT NOT NULL,                    -- 分段过程、快照因素、事件与奖励（JSON）
  watch_el REAL NOT NULL DEFAULT 0,        -- 最近观赛进度（秒），中断续看
  created_at TEXT,
  settled_at TEXT,
  voided_at TEXT                           -- 作废时间：越站迁移作废的记录，不再参与历史/结算
);
`)

// 老库兼容：为 race_log 增补 race_id 列（已存在则忽略）
try { db.exec('ALTER TABLE race_log ADD COLUMN race_id INTEGER') } catch (e) {}
// 老库兼容：races 增加 voided_at 列（越站历史修复作废记录用）
try { db.exec('ALTER TABLE races ADD COLUMN voided_at TEXT') } catch (e) {}
// 老库兼容：rentals 增加 insured_wear 列——已由保险赔付覆盖的事故损伤点数，
// 归还结算时从计费基数（wear_total）中剔除，与保险赔付不重复扣押金
try { db.exec('ALTER TABLE rentals ADD COLUMN insured_wear INTEGER NOT NULL DEFAULT 0') } catch (e) {}

export function run(sql, ...p) { return db.prepare(sql).run(...p) }
export function all(sql, ...p) { return db.prepare(sql).all(...p) }
export function get(sql, ...p) { return db.prepare(sql).get(...p) }