/**
 * Step 6 — 事件流怎么变成消息。
 *
 * 场景：模型正在回答。服务器不是把整段答案发过来，而是一串事件：
 *   「开始了」「加了段文本」「加了段文本」「工具参数来了一段」「结束了」
 * 你要把这些事件攒成一条完整消息，并回答一个问题：这一轮完了吗？
 *
 * 对照 Codex：
 *   事件定义   codex-rs/codex-api/src/common.rs 的 enum ResponseEvent
 *   消费循环   codex-rs/core/src/session/turn.rs 的 run_sampling_request（L2658 起）
 *   结束分支   turn.rs:2967 ResponseEvent::Completed { end_turn, ... }
 *
 * 运行：node code/step6.mjs
 */

const say = (depth, ...rest) => console.log('  '.repeat(depth) + rest.join(' '))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Codex 的 ResponseEvent。真实枚举有十几个变体，这里留最核心的几个。
 * 注意和 DeepSeek Harness 的 StreamChunk 不同：Codex 用 item_id 而不是 index，
 * 而且把「推理摘要」和「推理正文」分成两件事。
 */
const ev = {
  created: (responseId) => ({ type: 'Created', responseId }),
  outputItemAdded: (item) => ({ type: 'OutputItemAdded', item }),
  outputTextDelta: (delta) => ({ type: 'OutputTextDelta', delta }),
  toolCallInputDelta: (itemId, callId, delta) => ({ type: 'ToolCallInputDelta', itemId, callId, delta }),
  outputItemDone: (item) => ({ type: 'OutputItemDone', item }),
  completed: (responseId, endTurn) => ({ type: 'Completed', responseId, endTurn }),
}

/** 把一段 JSON 切成碎片，模拟工具参数的分片到达。 */
function fragments(json, size) {
  const out = []
  for (let i = 0; i < json.length; i += size) out.push(json.slice(i, i + size))
  return out
}

/**
 * 假的事件流。scenario 决定模型这次说什么。
 */
async function* mockResponseStream(scenario) {
  yield ev.created('resp_001')

  if (scenario === 'tool') {
    const args = JSON.stringify({ path: 'src/parseDate.ts' })
    for (const piece of fragments(args, 5)) {
      await sleep(20)
      yield ev.toolCallInputDelta('item_1', 'call_1', piece)
    }
    yield ev.outputItemDone({ id: 'item_1', type: 'function_call', name: 'read_file', callId: 'call_1', args })
    // 有些提供方在这一步不给 end_turn
    yield ev.completed('resp_001', undefined)
    return
  }

  for (const text of ['parseDate ', '用了本地时区，', '改成 UTC 解析即可。']) {
    await sleep(20)
    yield ev.outputTextDelta(text)
  }
  yield ev.outputItemDone({ id: 'item_2', type: 'message', text: 'parseDate 用了本地时区，改成 UTC 解析即可。' })
  // scenario === 'noendturn' 时服务端不给 end_turn
  yield ev.completed('resp_001', scenario === 'noendturn' ? undefined : true)
}

/**
 * 消费事件流，产出 Codex 的 SamplingRequestResult。
 * 返回 { needsFollowUp, lastAgentMessage }。
 */
async function runSamplingRequest(scenario) {
  let text = ''
  let lastAgentMessage = null
  const toolCallArgs = new Map() // item_id → 拼接中的参数字符串
  const toolCalls = []
  let endTurn

  for await (const event of mockResponseStream(scenario)) {
    switch (event.type) {
      case 'Created':
        say(3, `事件 Created            response_id=${event.responseId}`)
        break

      case 'OutputTextDelta':
        text += event.delta
        say(3, `事件 OutputTextDelta     "${event.delta}"`)
        break

      case 'ToolCallInputDelta': {
        // 工具参数是【片段】，必须按 item_id 拼起来才能解析
        const joined = (toolCallArgs.get(event.itemId) ?? '') + event.delta
        toolCallArgs.set(event.itemId, joined)
        say(3, `事件 ToolCallInputDelta  "${event.delta}"（累计 ${joined.length} 字符）`)
        break
      }

      case 'OutputItemDone': {
        const item = event.item
        if (item.type === 'function_call') {
          say(3, `事件 OutputItemDone      工具调用 ${item.name}  参数=${toolCallArgs.get(item.id)}`)
          toolCalls.push({ name: item.name, args: JSON.parse(toolCallArgs.get(item.id)), callId: item.callId })
        } else {
          say(3, `事件 OutputItemDone      消息：${item.text}`)
          lastAgentMessage = item.text
        }
        break
      }

      case 'Completed':
        endTurn = event.endTurn
        say(3, `事件 Completed           end_turn=${endTurn === undefined ? '（服务端没给）' : endTurn}`)
        break

      default:
        break
    }
  }

  // ── 决定还要不要再来一次 ──────────────────────────────────────────
  // 有工具调用 → 一定还要问一次，因为工具结果得送回给模型
  if (toolCalls.length > 0) return { needsFollowUp: true, lastAgentMessage, toolCalls }
  // 没有工具调用，就看服务端有没有明说"我说完了"
  if (endTurn !== undefined) return { needsFollowUp: endTurn === false, lastAgentMessage }
  // 兜底：服务端什么都没说，且没有工具调用 → 当作说完了
  say(3, '兜底：服务端未提供 end_turn，且没有工具调用 → 判定为完成')
  return { needsFollowUp: false, lastAgentMessage }
}

// ── 场景 A：模型要调工具 ──────────────────────────────────────────────
say(0, '【场景 A · 模型要读文件】')
{
  const result = await runSamplingRequest('tool')
  say(1, `needs_follow_up = ${result.needsFollowUp}（因为有工具调用）`)
}

say(0, '')

// ── 场景 B：模型直接回答，服务端明说 end_turn=true ────────────────────
say(0, '【场景 B · 直接回答，end_turn=true】')
{
  const result = await runSamplingRequest('answer')
  say(1, `needs_follow_up = ${result.needsFollowUp}`)
  say(1, `last_agent_message = "${result.lastAgentMessage}"`)
}

say(0, '')

// ── 场景 C：服务端没给 end_turn ───────────────────────────────────────
say(0, '【场景 C · 服务端没给 end_turn】')
{
  const result = await runSamplingRequest('noendturn')
  say(1, `needs_follow_up = ${result.needsFollowUp}（走兜底逻辑）`)
}
