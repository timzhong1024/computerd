<!-- DOC-TODO-START -->

## 当前 TODO

- [ ] P1: 在 `packages/core` 中定义 screen-oriented generic input contract，先覆盖 `pointer` / `keyboard`，再决定各 profile 的暴露范围。
- [ ] P2: 在 server 和 control plane 中落地 `console signal` 与 `touch` 输入面，并明确它们各自的 profile 适用范围。
<!-- DOC-TODO-END -->

# Input Action Design

## Status

本文聚焦 computerd 的输入动作设计。

除非明确说明，下面描述的是推荐接口边界与目标方向，不表示当前仓库已经全部实现。

它回答的核心问题是：

- 一个带屏幕输出的 computer，需要哪些基础输入抽象
- 一个带 console 输出的 computer，需要哪些基础输入抽象
- 这两类输入抽象有哪些共性，哪些必须分开

## Why This Document Exists

当前仓库已经有多种 attach surface：

- `monitor/ws`
- `console/ws`
- `automation/ws` for browser

但它们并不等价于“AI agent 通用操作协议”。

更准确地说，当前状态是：

- human-facing attach surface 基本可用
- browser-specialized automation surface 已有
- profile-independent 的 generic actuation contract 还没有真正落地

因此，需要单独把 input action 抽出来，避免把 human transport、specialized automation、generic input 混为一谈。

## Current Protocol State

| Surface         | 当前实现                             | 本质                           | 面向谁         | 是否是通用 input action contract |
| --------------- | ------------------------------------ | ------------------------------ | -------------- | -------------------------------- |
| `monitor/ws`    | VNC upstream passthrough             | monitor attach transport       | 人类客户端为主 | 否                               |
| `console/ws`    | `input(data)` + `resize(cols, rows)` | terminal byte stream + control | 人类和 agent   | 部分是，但只覆盖 console         |
| `automation/ws` | CDP passthrough                      | browser specialized surface    | agent 为主     | 否，它是 browser 专用协议        |
| `screenshot`    | 静态观测                             | observation                    | 人类和 agent   | 否                               |

相关实现参考：

- [apps/server/src/transport/http/create-app.ts](/Users/timzhong/computerd/apps/server/src/transport/http/create-app.ts)
- [docs/display-interface-model.md](/Users/timzhong/computerd/docs/display-interface-model.md)
- [docs/browser-computer.md](/Users/timzhong/computerd/docs/browser-computer.md)

## Screen Computer Input Actions

如果一个 computer 的主要输出面是 `monitor`，那么它的最小输入抽象应当围绕“空间输入事件系统”设计。

### Minimal Action Families

| Action family | 最小动作                                   | 作用                     | 当前状态 |
| ------------- | ------------------------------------------ | ------------------------ | -------- |
| `pointer`     | `move` `down` `up` `click` `scroll` `drag` | 覆盖鼠标型 GUI 操作      | 未做     |
| `keyboard`    | `down` `up` `press` `hotkey` `type`        | 覆盖文本输入和快捷键     | 未做     |
| `touch`       | `tap` `down` `move` `up` `swipe`           | 覆盖触屏设备和移动端 GUI | 未做     |

### Required Metadata

光有动作名称不够，screen-oriented input 还需要一组稳定元数据，否则 agent 无法可靠落点。

| 元数据                             | 作用                                    | 当前状态                   |
| ---------------------------------- | --------------------------------------- | -------------------------- |
| `width` / `height`                 | 定义坐标空间                            | 部分 observation 已有      |
| `viewport`                         | 定义当前可见区域                        | browser monitor 已部分具备 |
| `devicePixelRatio` / `scaleFactor` | 解决截图坐标与执行坐标映射问题          | 未形成稳定通用 contract    |
| focus / active target              | 保证键盘输入落到正确对象                | 未做                       |
| input mode                         | 区分 absolute / relative pointer 等模式 | 未做                       |

### Design Principle

screen input 的目标不是替 agent 推断 UI 元素，而是提供足够抽象、足够通用、可覆盖任意 GUI 的输入原语。

这意味着：

- `pointer` / `keyboard` / `touch` 应当是 core actuation contract
- OCR / grounding / parser 不应成为 input contract 的前置依赖
- specialized surface 存在时仍应优先使用 specialized surface

## Touch-First Mobile Input Actions

这一节专门讨论触屏设备，尤其是 Android phone。

目标不是覆盖 Android 暴露过的全部输入源，而是从手机交互的本质出发，判断 AI agent 要想稳定覆盖约 90% 常见场景，最小需要哪些输入抽象，以及哪些能力应明确排除在第一版之外。

### Android Input Capability Survey By Commonality

从 Android 平台能力看，底层输入源很多，但对手机 agent 的实际价值差异很大。更合理的排序方式不是按 API 是否存在，而是按手机真实交互频率排序。

| 常见等级 | 输入能力                 | Android 对应能力                                               | 对 agent 的意义                           |
| -------- | ------------------------ | -------------------------------------------------------------- | ----------------------------------------- |
| S        | 单指触屏                 | `MotionEvent` + `ACTION_DOWN/MOVE/UP`                          | 手机 GUI 的绝对核心能力                   |
| S        | 文本输入                 | IME / editor action / text field                               | 登录、搜索、表单填写的核心能力            |
| S        | 设备级按键               | `KeyEvent`，尤其 `BACK` `HOME` `APP_SWITCH` `ENTER`            | 系统导航和兜底恢复能力                    |
| S        | 滚动 / 拖拽              | 本质仍是 touch move 序列                                       | 列表浏览、滑块、排序等高频操作            |
| A        | 长按 / 双击 / 连续点击   | 由 touch 序列和时序解释出的 gesture                            | 菜单、编辑态、选择态经常依赖              |
| A        | 多指触控                 | `ACTION_POINTER_DOWN/UP`，pinch / zoom / rotate                | 地图、相册、画布会用到，但不是 90% 基础面 |
| B        | 物理键盘                 | `KeyEvent` + focus navigation                                  | 外接键盘或桌面模式才更重要                |
| B        | 鼠标 / 触控板            | hover / secondary button / wheel / drag and drop               | 大屏 Android 更常见，手机较少             |
| B        | 手写笔基础               | `SOURCE_STYLUS`                                                 | 平板和折叠屏才更常见                      |
| C        | 手写笔高级               | pressure / tilt / hover / handwriting                          | 明显长尾                                  |
| C        | DPAD / gamepad / joystick | `SOURCE_DPAD` / `SOURCE_GAMEPAD` / `SOURCE_JOYSTICK`           | TV、游戏、专用终端场景                    |
| C        | rotary / trackball       | `SOURCE_ROTARY_ENCODER` / `SOURCE_TRACKBALL`                   | 非手机主路径                              |
| C        | accessibility 特化手势   | accessibility service gesture / fingerprint gesture 等特化路径 | 不应直接进入通用 mobile input contract    |

这张表带来一个很直接的结论：

- 对手机而言，最重要的不是“支持所有 Android 输入源”
- 而是把高频交互压缩成足够小、足够稳定、足够可实现的 agent-facing 动作面

### The Essential Mobile Input Model

如果只看一台手机让人完成任务所依赖的最本质输入能力，其实可以压缩成三类：

| 本质能力             | 用户在做什么                 | 建议的 agent 抽象                              |
| -------------------- | ---------------------------- | ---------------------------------------------- |
| 对屏幕某处施加接触   | 点按、长按、滑动、拖动       | `touch`                                        |
| 向当前焦点提交文本   | 输入用户名、搜索词、表单内容 | `text`                                         |
| 触发少量系统级导航键 | 返回桌面、后退、切任务       | `device_key`                                   |

也就是说，对 Android phone 来说，第一版不需要把 mobile input 建模成完整 `InputDevice` 宇宙，而更适合建模成：

- touch-oriented spatial actuation
- focus-targeted text submission
- a very small set of system navigation keys

### Recommended Core Actions For 90 Percent Coverage

如果目标是覆盖 90% 手机场景，同时严格控制项目复杂度，推荐把 `touch-first` mobile input 收敛到下面这组稳定动作。

| Action family | 建议动作                                                       | 是否 core | 说明                                        |
| ------------- | -------------------------------------------------------------- | --------- | ------------------------------------------- |
| `touch`       | `tap(x,y)`                                                     | 是        | 最常见动作                                  |
| `touch`       | `long_press(x,y,durationMs)`                                   | 是        | 打开上下文菜单、进入编辑态                  |
| `touch`       | `swipe(x1,y1,x2,y2,durationMs)`                                | 是        | 滚动、翻页、抽屉、刷新                      |
| `touch`       | `drag(points,durationMs)`                                      | 是        | 滑块、排序、拖动物体                        |
| `text`        | `insert(text)`                                                 | 是        | 面向“向当前输入焦点提交文本”的高层能力      |
| `text`        | `replace(text)`                                                | 是        | 降低 agent 为清空旧文本而反复删除的复杂度   |
| `text`        | `editor_action(done/search/next/go/send)`                      | 是        | 提交搜索、进入下一项等                      |
| `device_key`  | `press(back/home/app_switch/enter/tab/escape/delete)`          | 是        | 限制在高价值、低歧义的少量按键              |
| `scroll`      | `scroll(up/down/left/right, amount)`                           | 可选宏    | 本质可由 `swipe` 表达，但单独暴露更利于规划 |

这里刻意把 `text` 与 `keyboard` 分开。

原因是：

- 在手机上，“提交文本”比“逐键敲击虚拟键盘”更接近稳定用户意图
- IME、布局、联想词、不同语言键盘会让低层键盘注入变得非常脆弱
- 对 agent 来说，`insert(text)` 往往比 `key_down/key_up` 更可预测

同理，`scroll` 更适合作为宏，而不是独立底层能力：

- 底层依然可以实现为一次受控 `swipe`
- 但 agent 规划层经常需要“向下滚一屏”这种语义，而不是每次自己猜坐标

### Optional Low-Level Touch Primitive

尽管上层推荐以 `tap`、`swipe`、`drag` 这类动作暴露，但 runtime 内部最好仍保留更低层的触摸序列能力：

| 低层动作 | 作用 |
| -------- | ---- |
| `down`   | 开始一段触摸序列 |
| `move`   | 在同一触摸序列中移动 |
| `up`     | 结束触摸序列 |

这样做的意义是：

- 允许 `tap` / `long_press` / `swipe` / `drag` 都被实现为统一时序模型
- 为未来多指触控预留扩展空间
- 让 runtime 在必要时可以精细控制 gesture 注入，而不把复杂性暴露给 agent

因此更合理的分层是：

- agent-facing contract 以高频语义动作为主
- runtime-facing actuation model 仍保留 touch event sequence

### Explicit Non-Goals For V1

下面这些能力虽然 Android 平台具备，但不应进入面向手机 agent 的第一版 core contract：

| 能力 | 不纳入第一版的原因 |
| ---- | ------------------ |
| 多指触控 | 价值有限，但会显著抬高状态机和注入复杂度 |
| 鼠标 hover / 右键 / pointer capture | 不是手机主路径，更偏大屏和桌面模式 |
| 手写笔 pressure / tilt / hover | 明显长尾，且实现与测试成本高 |
| gamepad / joystick / DPAD | 不是 phone-first 目标 |
| rotary / trackball | 不是现代手机主路径 |
| accessibility 特化动作全集 | 适合 specialized sidecar，不适合作为 generic input core |
| 原始 scan code / axis / button state 暴露 | 过于贴近平台底层，不利于稳定抽象 |

如果未来确实需要支持这些场景，更合理的做法也应是：

- 作为 profile-specific optional capability 增补
- 或作为 specialized Android surface 暴露

而不是在第一版把它们混进所有 screen computer 都必须理解的 core schema。

### Design Implications For Android Computer

这对 `android computer` 的直接设计含义是：

1. `touch` 应当是 mobile-first profile 的第一核心动作族。
2. `text` 应当作为独立抽象存在，而不是退化成“虚拟键盘按键回放”。
3. `device_key` 只应暴露少量高价值系统键，不应默认开放全部 Android keycode。
4. 多指、手写笔、鼠标、游戏手柄等能力应先排除在 v1 之外。
5. `scroll` 可以作为 agent-facing 宏保留，但不应被误认为新的底层输入本质。

因此，如果后续要在 `packages/core` 中定义通用 schema，对 mobile profile 更合理的第一版形态应当是：

- `pointer` / `keyboard` 继续服务 desktop-like screen computer
- `touch` / `text` / `device_key` 成为 touch-first computer 的核心动作面
- 两者共享坐标、时序、session、鉴权等基础框架，但不强行要求动作集合完全对称

## Desktop Window System Survey

这一节专门对齐主流桌面窗口体系的输入语义：

- Microsoft Windows
- X11
- Wayland

目标不是逐字复制各平台事件常量，而是提炼出 computerd 真正需要抽象的 pointer / keyboard action。

### Pointer Actions By Commonality

| 常见等级 | 抽象动作                     | Windows                                                                   | X11                                    | Wayland                                 | 说明                              |
| -------- | ---------------------------- | ------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------- | --------------------------------- |
| S        | 绝对移动 `move(x,y)`         | `WM_MOUSEMOVE`                                                            | `MotionNotify`                         | `wl_pointer.motion`                     | 三者都有，是最基础的 pointer 原语 |
| S        | 按钮按下 `button_down`       | `WM_LBUTTONDOWN` / `WM_RBUTTONDOWN` / `WM_MBUTTONDOWN` / `WM_XBUTTONDOWN` | `ButtonPress`                          | `wl_pointer.button(state=pressed)`      | 左中右及扩展键都属于这一层        |
| S        | 按钮抬起 `button_up`         | `WM_*BUTTONUP`                                                            | `ButtonRelease`                        | `wl_pointer.button(state=released)`     | 与 `button_down` 配对             |
| S        | 单击 `click`                 | 本质为 down + up                                                          | 本质为 `ButtonPress + ButtonRelease`   | 本质为 `button pressed + released`      | 更适合作为宏，不应是唯一基础原语  |
| S        | 拖拽 `drag`                  | `MOVE + DOWN/UP` 组合                                                     | `MotionNotify + ButtonPress/Release`   | `motion + button` 组合                  | 也是组合动作，不是一等底层原语    |
| S        | 垂直滚动                     | `WM_MOUSEWHEEL`                                                           | 常见映射为 Button4/5 或扩展轴          | `wl_pointer.axis(vertical_scroll)`      | 桌面 GUI 高频动作                 |
| S        | 水平滚动                     | `WM_MOUSEHWHEEL`                                                          | 常见依赖扩展或设备层                   | `wl_pointer.axis(horizontal_scroll)`    | 现代触控板和浏览器常用            |
| S        | modifier 辅助的 pointer 动作 | 鼠标消息携带 `MK_SHIFT` / `MK_CONTROL` 等                                 | 事件状态里带 modifier                  | 结合 `wl_keyboard.modifiers` 解释       | 多选、框选、缩放等依赖这一层      |
| A        | 进入 / 离开窗口              | `WM_MOUSELEAVE`                                                           | `EnterNotify` / `LeaveNotify`          | `wl_pointer.enter` / `wl_pointer.leave` | 更像 target/focus 变化            |
| A        | 悬停 `hover`                 | `WM_MOUSEHOVER`                                                           | 通常由 motion + timer 推导             | 通常由 compositor 或 toolkit 推导       | Windows 更显式                    |
| A        | 双击 `double_click`          | `WM_*DBLCLK`                                                              | 一般由 toolkit 推导                    | 一般由 toolkit 推导                     | 不适合作为最小跨平台原语          |
| A        | 额外鼠标按键                 | `XBUTTON1/2`                                                              | 扩展 button code                       | Linux input button code                 | 浏览器前进/后退等会用到           |
| B        | 高精度滚动                   | `WHEEL_DELTA` 细分                                                        | 依赖设备或扩展                         | `axis_value120` 等扩展值                | 对触控板更重要                    |
| B        | 相对移动 `move_rel(dx,dy)`   | `RAWMOUSE` relative motion                                                | XI2 raw motion / XTEST relative motion | 常见依赖 `relative-pointer` 扩展        | 游戏和锁定指针场景重要            |
| C        | 指针捕获 / 锁定 / 约束       | capture 等 Win32 语义                                                     | pointer grab                           | 常见依赖 `pointer-constraints` 扩展     | 游戏、远控、全屏应用更需要        |
| C        | 语义化触控板手势             | 非鼠标 core 主路径                                                        | 非 core 主路径                         | 常见依赖 `pointer-gestures` 扩展        | 不应进入最小通用 pointer contract |

### Keyboard Actions By Commonality

| 常见等级 | 抽象动作                           | Windows                                 | X11                                  | Wayland                                     | 说明                                          |
| -------- | ---------------------------------- | --------------------------------------- | ------------------------------------ | ------------------------------------------- | --------------------------------------------- |
| S        | 按键按下 `key_down`                | `WM_KEYDOWN` / `WM_SYSKEYDOWN`          | `KeyPress`                           | `wl_keyboard.key(state=pressed)`            | 最基础原语                                    |
| S        | 按键抬起 `key_up`                  | `WM_KEYUP` / `WM_SYSKEYUP`              | `KeyRelease`                         | `wl_keyboard.key(state=released)`           | 最基础原语                                    |
| S        | 修饰键组合 `hotkey/modifier combo` | `Shift` / `Ctrl` / `Alt` / `Win` 虚拟键 | modifier key + XKB 状态              | `wl_keyboard.modifiers`                     | GUI agent 高频使用                            |
| S        | 文本输入 `type(text)`              | `WM_CHAR` 等文本消息                    | 通常由 key event + keymap / XIM 产出 | 常常需要 text-input / input-method 体系配合 | 这是跨平台差异最大的点                        |
| S        | 控制键                             | Enter / Tab / Esc / Backspace 等虚拟键  | keycode / keysym                     | keycode + keymap                            | 表单、终端、对话框高频动作                    |
| A        | 自动重复 `repeat`                  | 长按触发重复键消息                      | 由服务器或 toolkit 处理              | `repeat_info` 等机制                        | 对长按方向键、删除键有用                      |
| A        | 系统键区分                         | `WM_SYSKEYDOWN` / `WM_SYSCHAR`          | 无单独 system key 层                 | 无同等 core 概念                            | Windows 特有差异                              |
| A        | modifier 状态同步                  | `GetKeyState` / `GetAsyncKeyState` 等   | XKB state                            | `wl_keyboard.modifiers`                     | 有利于显式同步状态                            |
| B        | 死键 / 组合键                      | `WM_DEADCHAR` / `WM_SYSDEADCHAR`        | XIM / XKB compose                    | 通常走 input-method                         | 国际键盘会用到                                |
| B        | IME 上屏 / 组合输入                | `WM_IME_CHAR` 等                        | XIM / 输入法框架                     | text-input / input-method                   | 东亚语言关键，但不宜混进最小物理键盘 contract |
| B        | 布局 / keymap 变化                 | layout API                              | XKB                                  | `wl_keyboard.keymap` / group                | 多语言环境重要                                |
| C        | 全局热键 / 抓键                    | `RegisterHotKey` 等                     | `XGrabKey`                           | 往往受 compositor policy 控制               | 不应作为 generic input 的基础能力             |
| C        | 快捷键抑制 / 键盘独占              | shell / window manager policy           | grab 相关                            | 常见依赖 `keyboard-shortcuts-inhibit` 扩展  | 全屏或远控场景才更需要                        |
| C        | 虚拟键盘注入                       | `SendInput` 类路径                      | `XTestFakeKeyEvent`                  | 常见依赖 `virtual-keyboard` 扩展            | 对 agent 很重要，但 Wayland 不是 core         |

### Cross-Platform Design Implications

对 computerd 来说，跨平台最稳定的 screen input 基础集合其实不大。

| 类别     | 建议作为 core 原语                            | 建议作为上层宏                | 建议作为可选能力                                      |
| -------- | --------------------------------------------- | ----------------------------- | ----------------------------------------------------- |
| pointer  | `move_abs` `button_down` `button_up` `scroll` | `click` `double_click` `drag` | `move_rel` `pointer_lock` `gesture` `high_res_scroll` |
| keyboard | `key_down` `key_up` `type(text)`              | `hotkey` `press(key)`         | `IME` `dead_key` `global_hotkey` `keyboard_grab`      |

这带来三个结论：

1. `click`、`drag`、`double_click` 看起来常见，但底层基本都是组合语义，更适合作为宏。
2. `type(text)` 虽然应成为 agent-facing 一等能力，但它在不同平台的实现差异最大，尤其 Wayland 往往需要额外协议或 compositor 授权。
3. `relative pointer`、`gesture`、`global hotkey` 这类能力不应阻塞第一版 generic input contract。

## VNC / RFB Input Survey

computerd 当前的 `monitor/ws` 本质上对接的是 VNC，也就是 RFB protocol passthrough。

这意味着，至少在当前 monitor 路径上，computerd 实际承接到的输入抽象首先不是 Windows / X11 / Wayland 的完整事件模型，而是 RFB 原生定义的 client-to-server 消息模型。

### What RFB Natively Defines

RFC 6143 定义的标准 client-to-server 消息里，和输入直接相关的核心只有三类：

- `KeyEvent`
- `PointerEvent`
- `ClientCutText`

另外 `FramebufferUpdateRequest` 虽然不是“输入设备动作”，但它是 client 主动请求观察更新的协议动作。

| RFB 消息 | 作用 | 对 computerd 的意义 |
| --- | --- | --- |
| `KeyEvent` | 表示一个键被按下或释放 | 对应 keyboard 的最小底层原语 |
| `PointerEvent` | 表示指针移动或按钮状态变化 | 对应 pointer 的最小底层原语 |
| `ClientCutText` | 向 server 发送剪贴板文本 | 更像 clipboard sync，不是通用文本输入 |
| `FramebufferUpdateRequest` | 请求 framebuffer 更新 | 属于 observation 协议，不属于 actuation |

### RFB Keyboard Abstraction

RFB 的键盘模型非常简单。

| 项目 | RFB 原生语义 | 设计含义 |
| --- | --- | --- |
| 基础事件 | `KeyEvent` | 只有 `key_down` / `key_up` 两态 |
| 键值表示 | X11 `keysym` | 即使 client/server 不跑 X11，也统一用 keysym |
| 字符输入 | 通过 keysym 表达 | 没有单独的 `type(text)` 协议原语 |
| 修饰键 | 也是普通 key event | `Ctrl-A` 之类要靠组合按下/释放表达 |
| 布局差异 | 由 server 侧解释 keysym | 跨布局字符输入存在语义复杂性 |

这意味着：

- RFB 原生非常适合承载 `key_down` / `key_up`
- `press(key)`、`hotkey(keys[])`、`type(text)` 都更适合作为 computerd 上层宏
- `type(text)` 不能直接等价成 `ClientCutText`

`ClientCutText` 的边界很窄。RFC 6143 只把它定义成 cut buffer 同步，而且文本限定为 ISO 8859-1（Latin-1），不能把它当成现代通用文本注入接口。

### RFB Pointer Abstraction

RFB 的 pointer 模型同样非常收敛。

| 项目 | RFB 原生语义 | 设计含义 |
| --- | --- | --- |
| 基础事件 | `PointerEvent` | 一个消息同时携带坐标和按钮状态 |
| 坐标模型 | `x-position` / `y-position` | 绝对坐标 |
| 按钮模型 | `button-mask` bits 0-7 | 只暴露 1 到 8 号按钮状态 |
| 移动 | 通过新坐标发送 | 没有独立 `move_rel(dx,dy)` |
| 按钮按下/抬起 | 通过 button mask 状态变化表达 | 没有独立 `button_down` / `button_up` 消息类型 |
| 滚轮 | wheel up/down 映射为 button 4/5 的按下+抬起 | 滚动本质上是合成按钮事件 |

这意味着：

- RFB 原生最稳定的 pointer 原语其实是 `move_abs(x,y)` 和 `set_buttons(mask)`
- `click`、`double_click`、`drag` 都是更上层的组合语义
- 高精度滚动、手势、相对移动、指针锁定等都不在 RFB core contract 里

### What RFB Does Not Give You

如果从 agent-facing input design 的角度看，RFB 原生缺的东西很多。

| 能力 | RFB core 是否直接提供 | 说明 |
| --- | --- | --- |
| 相对移动 `move_rel` | 否 | 只有绝对坐标 pointer event |
| 显式 `click` / `double_click` / `drag` | 否 | 都要靠事件序列组合 |
| 触控 / 多点触控 | 否 | core RFB 没有 touch 抽象 |
| 手势 | 否 | 没有 swipe / pinch / hold |
| 高级文本输入 | 否 | 没有现代 IME / Unicode text commit 抽象 |
| 通用 clipboard-rich text | 否 | `ClientCutText` 只有有限 cut buffer 同步 |
| 焦点 / active window 语义 | 否 | RFB 工作在 framebuffer 层，不理解窗口对象 |

### Implications For Computerd

由于 computerd 当前的 `monitor/ws` 是 VNC passthrough，所以现阶段 GUI 输入面天然受到 RFB 抽象边界约束。

| 判断 | 结论 |
| --- | --- |
| 当前 monitor 输入到底是什么 | 本质上是 RFB `KeyEvent` + `PointerEvent` 级别 |
| 当前 monitor 输入缺什么 | `touch`、`gesture`、`relative pointer`、稳定 `type(text)`、高层 click semantics |
| 为什么不能把 noVNC 输入直接当作完整 agent protocol | 因为它只是 human viewer 所使用的 RFB transport，不是 computerd 自己定义的 generic input contract |
| 对第一版 generic input 设计有什么启发 | 可以先对齐 RFB 最稳定的最小集合：绝对 pointer + key down/up，再在 computerd 上层补宏 |

因此，如果从当前仓库现实出发，第一版 screen input contract 更适合这样分层：

1. 底层 capability 对齐 RFB 可稳定表达的集合。
2. computerd 在其上定义 `click`、`drag`、`hotkey`、`type(text)` 这类 agent-friendly macro。
3. future profile 再逐步补 `touch`、`gesture`、`relative pointer` 等非 RFB 能力。

## Console Computer Input Actions

如果一个 computer 的主要输出面是 `console`，那么它的输入模型应当围绕“线性字节流”而不是“空间坐标事件”设计。

### Minimal Action Families

| Action family      | 最小动作                           | 作用                                   | 当前状态 |
| ------------------ | ---------------------------------- | -------------------------------------- | -------- |
| `stream`           | `write(data)`                      | 写入 stdin / serial byte stream        | 已做     |
| `terminal-control` | `resize(cols, rows)`               | 支持 TUI、shell、REPL 正确渲染         | 已做     |
| `signal`           | `interrupt` `eof` `suspend` `kill` | 补齐 agent 对 console session 的控制面 | 未做     |

相关实现参考：

- [apps/server/src/transport/http/create-app.ts#L741](/Users/timzhong/computerd/apps/server/src/transport/http/create-app.ts#L741)
- [docs/computer-profiles.md](/Users/timzhong/computerd/docs/computer-profiles.md)
- [docs/vm-computer.md](/Users/timzhong/computerd/docs/vm-computer.md)

## Shared And Unique Properties

### Shared Properties

| 共性              | Screen computer                           | Console computer                         |
| ----------------- | ----------------------------------------- | ---------------------------------------- |
| session 化 attach | `monitor session`                         | `console session`                        |
| 输出 + 输入闭环   | framebuffer / screenshot + input events   | text stream + input stream               |
| 顺序执行要求      | pointer / keyboard / touch 必须按时序生效 | write / resize / signal 也必须按时序生效 |
| 生命周期与鉴权    | 需要                                      | 需要                                     |

### Unique Properties

| 维度         | Screen computer 独有                   | Console computer 独有             |
| ------------ | -------------------------------------- | --------------------------------- |
| 空间模型     | 有二维坐标空间                         | 无坐标空间                        |
| 输入本质     | 事件系统                               | 字节流和 terminal control         |
| 关键元数据   | viewport / scale / focus / device type | cols / rows / encoding / tty mode |
| 适合的 agent | GUI / VLM agent                        | shell / code / CLI agent          |

## Current Repository Status

下面这张表只描述当前仓库状态，不描述目标方向。

| 项目                                | 当前状态 |
| ----------------------------------- | -------- |
| human-facing `monitor/ws`           | 已有     |
| human-facing `console/ws`           | 已有     |
| browser specialized `automation/ws` | 已有     |
| generic screen `pointer` contract   | 未做     |
| generic screen `keyboard` contract  | 未做     |
| generic screen `touch` contract     | 未做     |
| generic console `signal` contract   | 未做     |
| 统一的 input action schema          | 未做     |

因此，当前更准确的判断是：

- observation 已有一部分
- human attach transport 基本具备
- browser specialized automation 已有
- generic input action 还处于很早期阶段

## Design Implications

这套拆分带来的直接结论是：

1. `monitor/ws` 和 `console/ws` 不应被误认为 generic agent control protocol。
2. `CDP` 这类 specialized surface 应继续保留，并优先于 generic GUI input。
3. generic input action 应单独建模为 computerd 的基础 actuation layer。
4. perception / visual grounding 应保持 optional，不进入 core input contract。

## Recommended Next Step

更合理的推进顺序是：

1. 先在 `packages/core` 中定义 generic `input action` schema。
2. 第一阶段先覆盖 `pointer` 和 `keyboard`。
3. 第二阶段补 `touch` 和 `console signal`。
4. 最后再决定各个 computer profile 暴露哪些动作面。

## External References

- [RFC 6143: The Remote Framebuffer Protocol](https://www.rfc-editor.org/rfc/rfc6143)
- [Windows mouse input overview](https://learn.microsoft.com/windows/win32/inputdev/about-mouse-input)
- [Windows keyboard input overview](https://learn.microsoft.com/windows/win32/inputdev/about-keyboard-input)
- [Windows RAWMOUSE](https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-rawmouse)
- [Xlib event types and event handling](https://x.org/releases/X11R7.7/doc/libX11/libX11/libX11.html)
- [XTEST fake input](https://www.x.org/releases/X11R7.5/doc/man/man3/XTestFakeKeyEvent.3.html)
- [Wayland core protocol: `wl_pointer` / `wl_keyboard`](https://wayland.freedesktop.org/docs/html/apa.html)
- [Wayland pointer gestures](https://wayland.app/protocols/wayland-protocols/482)
- [Wayland relative pointer](https://wayland.app/protocols/relative-pointer-unstable-v1)
- [Wayland virtual keyboard](https://wayland.app/protocols/virtual-keyboard-unstable-v1)
- [Wayland pointer constraints](https://wayland.app/protocols/pointer-constraints-unstable-v1)
