# Codex 的 agent loop，就是三层 loop 加一个布尔

OpenAI 的 Codex 在 `codex-rs/` 下有 150 个 crate。但驱动它干活的，是三层嵌套的 `loop`，和一个叫 `needs_follow_up` 的布尔值。

这个仓库把那个骨架从 Rust 翻译成 Node.js 写了一遍——五个文件，每个都能 `node` 直接跑，输出会打印出和 Codex 源码一样的控制流。

读完它，你打开 `turn.rs` 那 3227 行，看到的不会是 3227 行代码，而是三个 `loop` 和它们各自的出口。

## 三层 loop，各问一句话

```
RegularTask::run         还有没有待处理输入？
└─ run_turn 里的 loop    模型还要不要再来一次？
   └─ 采样重试 loop       这次请求成功了吗？
```

三层问的是同一件事——**还欠不欠**——只是粒度一层比一层细。

第一层在 `tasks/regular.rs`，第二、三层都在 `session/turn.rs`。加起来不到 60 行。

那剩下的 3000 多行是什么？

是**出口条件和它们的前置检查**：上下文超了要不要压缩、额度用完了要不要立刻放弃、子 agent 发来的消息该塞进当前轮还是下一轮、用户按 Ctrl+C 时哪些子任务要一起停。

**循环是骨架，复杂度全在"什么时候可以停"上。**

## 怎么读

按顺序，每章配一个可运行文件：

```sh
node code/step1.mjs
```

**先跑，看输出，再读正文。**

| 章 | 代码 | 讲什么 |
|---|---|---|
| [一、三层 loop](ch01-三层-loop.md) | `step1` `step2` | turn / step 两层循环，以及 `needs_follow_up` 这一个布尔怎么决定一切 |
| [二、输入的两种来源](ch02-输入的两种来源.md) | `step3` | 用户插话 vs agent 来信；"延迟到下一轮"和"接受进当前轮" |
| [三、重试之前先分类](ch03-重试之前先分类.md) | `step4` | 哪两类错误重试没有意义 |
| [四、取消怎么传播](ch04-取消怎么传播.md) | `step5` | `child_token()`：取消自动向下传，不用满地的全局标志位 |
| [五、事件流不是分片的答案](ch05-事件流不是分片的答案.md) | `step6` | `ResponseEvent` 里除了文本还在传什么；`end_turn` 缺失时的兜底 |
| [六、让模型写程序调工具](ch06-让模型写程序调工具.md) | `step7` | code mode：一次往返跑完多步；可挂起的 cell |

对照的是 [openai/codex](https://github.com/openai/codex)。每章开头都标了对应的文件和行号。

## 它和 DeepSeek Harness 的差别

这两套系统的骨架几乎一样。真正的差别在三个地方：

**出口条件的表达。** Codex 把"模型还要不要继续"和"队列里还有没有东西"合成一个布尔：`needs_follow_up = model_needs_follow_up || has_pending_input`。DSH 拆成两个条件，因为它的 `turn/end` 要记原因，需要枚举而不是布尔。

**重试的入口。** Codex 是一个内置状态机加两条硬编码的不可重试错误。DSH 做成事件瀑布，插件可以接管。前者简单，后者可替换。

**取消。** Codex 用 `CancellationToken::child_token()`，取消从父到子自动传播。DSH 用 `AbortSignal` 手动组合。Rust 这套更省心。

## 网页版

[`index.html`](index.html) 是这四章的单文件网页版——侧边导航、阅读进度、代码高亮。双击就能打开，不依赖任何东西。

改完 Markdown 之后重新生成：

```sh
npm i -D marked shiki
node tools/build-page.mjs
```

## 最后

写完这五个文件之后，你再看任何 agent 框架，第一件事会是**先找它的 loop 在哪、出口条件是什么**。

语言和目录结构会变，那三层不会。
