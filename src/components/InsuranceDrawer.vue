<script setup>
import { computed, ref } from 'vue'
import { useSkyStore } from '@/store/sky'
const store = useSkyStore()
const emit = defineEmits(['close'])

const plans = computed(() => store.insurance.plans || [])
const policy = computed(() => store.insurance.current)
const claims = computed(() => store.insurance.claims || [])
const pendings = computed(() => store.insurance.pendingAccidents || [])

const busy = ref(0)
const SEV = { light: '轻微', medium: '中度', heavy: '严重' }
const SEV_TAG = { light: 'b', medium: 'o', heavy: 'rose' }
const FAULT_TAG = { rival: 'b', weather: 'v', pilot: 'rose' }
const STATUS = {
  reported: { txt: '已报案 · 待定损', cls: 'o' },
  assessed: { txt: '已定损 · 待领取', cls: 'gold' },
  paid: { txt: '已赔付', cls: 'm' },
  rejected: { txt: '免赔拒赔', cls: 'gray' },
  reversed: { txt: '比赛作废 · 已冲回', cls: 'gray' }
}
const statusOf = s => STATUS[s] || { txt: s, cls: 'gray' }
const seasonTxt = c => c.season === store.team.season ? '' : `S${c.season} · `

async function buy(id) {
  if (busy.value) return
  busy.value++
  const r = await store.buyInsurance(id)
  if (r?.ok) store.tip(r.msg)
  busy.value--
}
async function report(raceId) {
  if (busy.value) return
  busy.value++
  const r = await store.reportClaim(raceId)
  if (r?.ok) store.tip(r.msg || '已受理报案，等待定损')
  busy.value--
}
async function assess(id) {
  if (busy.value) return
  busy.value++
  const r = await store.assessClaim(id)
  if (r?.ok) store.tip(r.msg)
  busy.value--
}
async function pay(id) {
  if (busy.value) return
  busy.value++
  const r = await store.payClaim(id)
  if (r?.ok) store.tip(r.msg)
  busy.value--
}
</script>

<template>
  <div class="drawer-mask" @click.self="emit('close')">
    <aside class="drawer">
      <header class="d-h">
        <div><h3>🛡️ 赛事保险</h3><div class="d-sub">投保 · 报案 · 定损 · 赔付，与车队资金声望和租约押金联动</div></div>
        <button class="d-x" @click="emit('close')">✕</button>
      </header>

      <div class="d-body">
        <!-- 当前赛季保单 -->
        <section>
          <div class="sec-h"><b>📜 第 {{ store.team.season }} 赛季保单</b><span class="d-sub">开赛瞬间快照承保</span></div>
          <div v-if="policy" class="ins-card active">
            <div class="rent-top">
              <b>{{ policy.name }}</b>
              <span class="tag m">保障中</span>
            </div>
            <div class="rent-rows">
              <div class="rent-row"><span>保费（投保即扣，不退）</span><b class="mono">¥{{ policy.premium.toLocaleString() }}</b></div>
              <div class="rent-row"><span>定损赔付比例</span><b class="mono">{{ policy.cover }}%</b></div>
              <div class="rent-row"><span>免赔额（仅己方责任）</span><b class="mono">¥{{ policy.deductible.toLocaleString() }}</b></div>
              <div class="rent-row"><span>事故声望救济</span><b class="mono">{{ policy.repRelief }}%</b></div>
            </div>
            <div class="rent-hint">保单对本赛季全部比赛有效；进入下赛季后需重新投保，已开赛事故仍可凭快照理赔</div>
          </div>
          <div v-else class="ins-card empty-ins">
            <div class="ei-ico">⚠️</div>
            <div>本赛季尚未投保，比赛事故（部件损伤 / 声望损失）将无法理赔</div>
          </div>
        </section>

        <!-- 保险方案目录 -->
        <section v-if="!policy">
          <div class="sec-h"><b>🧾 保险方案</b><span class="d-sub">保费与条款由云盾保险核定</span></div>
          <div class="rent-list">
            <div v-for="p in plans" :key="p.id" class="rent-card">
              <div class="rent-top">
                <b>{{ p.name }}</b>
                <span class="tag gray">保费 ¥{{ p.premium.toLocaleString() }}</span>
              </div>
              <div class="rent-rows">
                <div class="rent-row"><span>赔付比例</span><b class="mono">{{ p.cover }}%</b></div>
                <div class="rent-row"><span>免赔额（己方责任）</span><b class="mono">¥{{ p.deductible.toLocaleString() }}</b></div>
                <div class="rent-row"><span>声望救济</span><b class="mono">{{ p.repRelief }}%</b></div>
              </div>
              <button class="btn sm primary w-full" :disabled="busy || store.team.money < p.premium" @click="buy(p.id)">
                立即投保 ¥{{ p.premium.toLocaleString() }}
              </button>
            </div>
          </div>
        </section>

        <!-- 待报案事故（已结算、有保单、尚未建理赔单） -->
        <section v-if="pendings.length">
          <div class="sec-h"><b>🚨 待报案事故</b><span class="d-sub">{{ pendings.length }} 场可立即报案</span></div>
          <div class="rent-list">
            <div v-for="p in pendings" :key="p.raceId" class="rent-card claim-pending">
              <div class="rent-top">
                <b>{{ p.season !== store.team.season ? `S${p.season} · ` : '' }}{{ p.circuitName }}</b>
                <span class="tag" :class="SEV_TAG[p.severity]">{{ p.severityLabel }}</span>
              </div>
              <div class="claim-text">{{ p.text }}</div>
              <div class="rent-row"><span>事故损伤</span><b class="mono" style="color:var(--rose)">{{ p.damage }} 点</b></div>
              <button class="btn sm" :class="busy ? 'ghost' : 'primary'" :disabled="busy" @click="report(p.raceId)">📮 向保险方报案</button>
            </div>
          </div>
        </section>

        <!-- 理赔单 -->
        <section>
          <div class="sec-h"><b>🗂️ 理赔记录</b><span class="d-sub">报案 → 定损 → 赔付</span></div>
          <div v-if="claims.length" class="claim-list">
            <div v-for="c in claims" :key="c.id" class="rent-card claim-card">
              <div class="rent-top">
                <b>{{ seasonTxt(c) }}{{ c.circuitName }}</b>
                <span class="tag" :class="statusOf(c.status).cls">{{ statusOf(c.status).txt }}</span>
              </div>
              <div class="claim-meta">
                <span class="tag" :class="SEV_TAG[c.severity]">{{ c.severityLabel || SEV[c.severity] }}</span>
                <span class="tag" :class="FAULT_TAG[c.fault]">{{ c.faultLabel }}</span>
                <span class="tag gray" v-if="c.rentalId">🛟 租约艇事故</span>
                <span class="tag gray" v-else>🛠️ 自有艇事故</span>
              </div>
              <div v-if="c.accidentText" class="claim-text">{{ c.accidentText }}（{{ c.part }}）</div>
              <div class="rent-rows">
                <div class="rent-row"><span>事故损伤 / 声望损失</span><b class="mono">{{ c.damage }} 点 · {{ c.repLoss }}</b></div>
                <div class="rent-row" v-if="c.loss != null"><span>报案预估损失</span><b class="mono">¥{{ c.loss.toLocaleString() }}</b></div>
                <div class="rent-row" v-if="c.assessedLoss != null"><span>核定损失 / 免赔额</span><b class="mono">¥{{ c.assessedLoss.toLocaleString() }} / ¥{{ c.deductible.toLocaleString() }}</b></div>
                <div class="rent-row" v-if="c.payable != null && c.status !== 'rejected'"><span>应赔金额</span><b class="mono" style="color:var(--gold)">¥{{ c.payable.toLocaleString() }}</b></div>
                <div class="rent-row claim-paid-row" v-if="c.status === 'paid'"><span>实际到账 / 声望救济</span><b class="mono" style="color:var(--mint)">¥{{ (c.payout || 0).toLocaleString() }} / +{{ c.repRelief }}</b></div>
              </div>
              <div v-if="c.assessNote" class="claim-note">{{ c.assessNote }}</div>
              <button v-if="c.status === 'reported'" class="btn sm primary w-full" :disabled="busy" @click="assess(c.id)">🔍 申请定损</button>
              <button v-else-if="c.status === 'assessed'" class="btn sm mint w-full" :disabled="busy" @click="pay(c.id)">💰 领取赔付 ¥{{ c.payable.toLocaleString() }}</button>
            </div>
          </div>
          <div v-else class="empty">暂无理赔记录。平安是福 🍀</div>
        </section>
      </div>
    </aside>
  </div>
</template>
