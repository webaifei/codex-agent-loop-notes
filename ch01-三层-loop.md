# 一、三层 loop

> **代码**：`code/step1.mjs` `code/step2.mjs`  
> **对照**：`codex-rs/core/src/tasks/regular.rs`（第一层）、`codex-rs/core/src/session/turn.rs:424-660`（第二层）

## 我原以为 agent 就是一个循环

问模型，执行工具，再问模型——不就是一个 `while` 吗。

这个理解对了一半。码农写爬虫是这样的：一层循环，条件写清楚就行。但 agent 的循环有一个特点——**它自己不知道自己要不要继续**。那个答案在模型那边，得问完才知道。

于是就变成了三层。

## 第一层：还有没有用户的活

[`tasks/regular.rs`](https://github.com/openai/codex/blob/main/codex-rs/core/src/tasks/regular.rs) 里的 `RegularTask::run`，整个 agent 的入口：

```rust
loop {
    let last_agent_message = run_turn(...).await?;
    if ctx.terminal_error.lock().await.is_some() {
        return Ok(last_agent_message);
    }
    if !sess.input_queue.has_pending_input(&sess.active_turn).await {
        return Ok(last_agent_message);
    }
    next_input = Vec::new();
}
```

出口只有一个：**队列空了**。

用 Node 写出来是 `code/step1.mjs`：

```sh
node code/step1.mjs
```

```
【改 bug + 中途补一句】
  turn/start {turn:1}  input=["修一下 parseDate 的时区问题"]
  turn/end
  turn/start {turn:2}  input=["顺便把测试补上"]
  turn/end
最后一条回复：收到：顺便把测试补上
一共跑了 2 个 turn
```

用户在模型干活时补的那一句，没有插进第一轮，而是等第一轮结束、`hasPendingInput()` 发现队列里还有东西，才开了第二轮。

这就是 `next_input = Vec::new()` 那一行的含义：**第二轮不复用最初的输入，它去队列里领。**

## 第二层：模型还要不要再来一次

`regular.rs` 每转一圈都会调用 `run_turn`。而 `run_turn` 里面还有一个 `loop`。

两个 loop 长得很像，问的却是两件事：

- 外层问：**还有没有新的活**
- 内层问：**这一趟活干完了没有**

内层要处理的情况很具体：模型说"我得先读一下 `parseDate.ts`"，读完才能改。读了文件不是结束，是这一轮里的第一步。

[`turn.rs:566`](https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs#L566) 那一行是第二层的全部秘密：

```rust
let needs_follow_up = model_needs_follow_up || has_pending_input;
```

模型说还要继续，**或者**队列里又来了新东西——两种情况都要再走一步。

然后出口在 L653：

```rust
if !needs_follow_up {
    last_agent_message = sampling_request_last_agent_message;
    break;
}
```

`code/step2.mjs` 把这一层单独拎出来了：

```sh
node code/step2.mjs
```

```
  turn/start {turn:1}  input=["修一下 parseDate 的时区问题"]
    step/start {step:1}
      采样请求 → 模型要调工具 read_file(src/parseDate.ts)
      工具结果 → export function parseDate(input: string) { /* 本地时区 */ }
    step/end  needs_follow_up=true（模型=true）
    step/start {step:2}
      采样请求 → 模型给出最终答案
    step/end  needs_follow_up=false（模型=false）
  turn/end
```

**`turn:1` 没变，`step` 从 1 走到 2。** 这就是第二层。

## 一个布尔，省掉了多少判断

把两件事合成一个 `needs_follow_up`，看起来只是省了几行。但它带来的效果是：**内层循环只有一个出口，而且那个出口是提前算好的。**

对比一下 DeepSeek Harness 的写法：

```ts
if (turnEnds && this.inbox.nextStep.length === 0) break
```

两个条件分开写。DSH 需要这样做，因为它的 `turn/end` 事件要记原因——是正常结束、撞了 token 上限、还是被用户中止。那是一个枚举，不是一个布尔。

Codex 不需要区分这些的时候，就把它们压成一个布尔。

**循环的层数不重要，重要的是每一层在等什么。** 层数和布尔值都是表象，出口条件才是本体。

## 一个容易踩的坑

写 `step2.mjs` 的时候我踩了一个：假模型按"第几个 step"来决定要不要继续，但 `stepContext` 在两次 step 之间是**复用**的（Codex 的 `next_step_context`），所以那个变量永远不变，循环停不下来。

真实系统里不会出这个问题——**模型根本不知道自己是第几个 step**，它只看对话历史。这个 bug 恰好说明了一件事：step 是循环的记账单位，不是模型的输入。

---

下次再看到一段 agent 代码，先别读它调了什么模型、用了什么工具。先找 `loop`，看它的条件是什么、谁在里面改这个条件。
