/**
 * Step 3 — 输入的两种来源。
 *
 * 场景：你在跑一个 codex 会话，同时另开了一个子 agent 帮你改 utils。
 * 子 agent 干完活会往你这边发一条消息。问题是：这条消息该现在插进来，
 * 还是等你这一轮跑完再说？
 *
 * Codex 的答案是把选择权交给调用方，提供一对显式动词：
 *   defer_mailbox_delivery_to_next_turn      延迟到下一轮
 *   accept_mailbox_delivery_for_current_turn 接受进当前轮
 *
 * 对照 Codex：codex-rs/core/src/session/input_queue.rs
 *
 * 运行：node code/step3.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))

class InputQueue {
  /** 用户插话：属于当前这一轮，下一步就该看到 */
  #steer = []
  /** agent 间通信：可能属于当前轮，也可能属于下一轮，看调用方怎么选 */
  #mailbox = []
  /** 被明确延迟到下一轮的 mailbox 消息 */
  #deferred = []

  enqueueSteer(text) {
    this.#steer.push(text)
  }

  enqueueMailbox(text) {
    this.#mailbox.push({ text, deferred: false })
  }

  /** ↓ Codex 的同名方法：这批消息留到下一轮再送 */
  deferMailboxToNextTurn() {
    for (const item of this.#mailbox) item.deferred = true
  }

  /** ↓ Codex 的同名方法：这批消息现在就送 */
  acceptMailboxForCurrentTurn() {
    for (const item of this.#mailbox) item.deferred = false
  }

  /** 取当前轮要用的输入：steer 全部 + 未被延迟的 mailbox。 */
  getPendingInput() {
    const accepted = this.#mailbox.filter((item) => !item.deferred).map((item) => item.text)
    this.#mailbox = this.#mailbox.filter((item) => item.deferred)
    return [...this.#steer.splice(0, this.#steer.length), ...accepted]
  }

  /** 当前轮跑完时，把延迟的 mailbox 释放成下一轮的输入。 */
  promoteDeferred() {
    const released = this.#mailbox.splice(0, this.#mailbox.length).map((item) => item.text)
    this.#deferred.push(...released)
    return released
  }

  /**
   * 当前这一步还有没有新输入。只数不取。
   * 注意不含 #deferred——那些是留给下一轮的，这一轮不该看到，
   * 否则 needs_follow_up 永远为真，循环停不下来。
   */
  countPendingInput() {
    return this.#steer.length + this.#mailbox.filter((item) => !item.deferred).length
  }

  get hasPendingInput() {
    return this.#steer.length > 0 || this.#mailbox.length > 0 || this.#deferred.length > 0
  }

  takeDeferred() {
    return this.#deferred.splice(0, this.#deferred.length)
  }
}

class Session {
  constructor() {
    this.inputQueue = new InputQueue()
    this.turnCount = 0
  }
}

let modelStep = 0
async function runSamplingRequest() {
  modelStep += 1
  // 第一步说"还要继续"，第二步给答案
  return modelStep % 2 === 1
    ? { needsFollowUp: true, lastAgentMessage: null }
    : { needsFollowUp: false, lastAgentMessage: '整理完了。' }
}

async function runTurn(session, input) {
  session.turnCount += 1
  const turn = session.turnCount
  say(1, `turn/start {turn:${turn}}`)

  let lastAgentMessage = null
  let turnInput = input // 轮次边界领到的输入，归入本轮的第一次采样
  for (let step = 1; ; step += 1) {
    const pendingInput = turnInput.length > 0 ? turnInput : session.inputQueue.getPendingInput()
    turnInput = []
    say(2, `step/start {step:${step}}  pending_input=${JSON.stringify(pendingInput)}`)

    const result = await runSamplingRequest()
    const needsFollowUp = result.needsFollowUp || session.inputQueue.countPendingInput() > 0
    say(2, `step/end  needs_follow_up=${needsFollowUp}`)

    if (!needsFollowUp) {
      lastAgentMessage = result.lastAgentMessage
      break
    }
  }

  // 这一轮结束：被延迟的消息现在解冻，成为下一轮的输入
  const promoted = session.inputQueue.promoteDeferred()
  if (promoted.length > 0) say(1, `（${promoted.length} 条延迟消息解冻）`)
  say(1, 'turn/end')
  return lastAgentMessage
}

async function runTask(session, input) {
  let nextInput = input
  for (;;) {
    await runTurn(session, nextInput)
    if (!session.inputQueue.hasPendingInput) return
    nextInput = session.inputQueue.takeDeferred()
  }
}

// ── 场景 A：子 agent 的消息被延迟到下一轮 ─────────────────────────────
say(0, '【场景 A · 延迟到下一轮】')
{
  const session = new Session()
  session.inputQueue.enqueueMailbox('[agent] 我改完了 utils/date.ts')
  session.inputQueue.deferMailboxToNextTurn() // ← 调用方选择延迟
  await runTask(session, ['改一下 parseDate'])
}

say(0, '')

// ── 场景 B：同一条消息被接受进当前轮 ─────────────────────────────────
say(0, '【场景 B · 接受进当前轮】')
{
  modelStep = 0
  const session = new Session()
  session.inputQueue.enqueueMailbox('[agent] 我改完了 utils/date.ts')
  session.inputQueue.acceptMailboxForCurrentTurn() // ← 调用方选择接受
  await runTask(session, ['改一下 parseDate'])
}
