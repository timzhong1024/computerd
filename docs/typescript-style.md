# TypeScript Style Guide

这个文件定义 Computerd 的 TypeScript 编码规范。目标不是追求“写法自由”，而是让类型系统尽可能早地拦住错误，并让 agent 在局部上下文里也能稳定演进代码。

## 总原则

- 优先让类型表达业务边界，而不是只给实现补注解。
- 优先窄接口、窄输入、窄输出，不要把 `computer`、`host-unit`、runtime helper 混进一个宽泛 base type。
- 优先静态约束，不要把本该由 TypeScript 保证的事情留到运行时兜底。
- 优先显式收窄，再调用具体能力；不要把“先传进来再内部猜类型”当作默认设计。

## 数据建模

- 领域模型优先用判别联合（discriminated union）或一组彼此独立的精确类型。
- 如果两个对象的字段语义不同，即使字段名相似，也不要为了“复用”强行抽成一个宽泛 base interface。
- 只有稳定、通用、跨多处共享的字段才允许上提到公共类型；否则保留在具体类型上。
- 不要把不相关的可选字段堆到同一个接口里，再靠 `undefined` 组合出不同形态。

反例：

```ts
interface ManagedThing {
  kind: "computer" | "host-unit";
  name?: string;
  unitName?: string;
  runtime?: Record<string, unknown>;
  recentLogs?: string[];
}
```

推荐：

```ts
interface ComputerSummary {
  name: string;
  unitName: string;
  profile: "terminal" | "browser";
  state: "stopped" | "running";
}

interface HostUnitDetail {
  unitName: string;
  unitType: string;
  state: string;
  execStart: string;
  recentLogs: string[];
}
```

## API 设计

- 不要设计“接受一个抽象类型，然后在内部大段 `switch` / `if` 分发所有子类型”的大而全入口，除非这是不可避免的公共边界。
- 如果调用方其实知道自己处理的是哪一种具体类型，就直接暴露精确函数，而不是先升格到宽类型再降回来。
- 公共入口只做路由；真实逻辑应尽快转交给针对具体类型的窄函数。
- Web / HTTP / MCP 的共享契约必须来自 `packages/core`，不要在 app 层偷偷扩出平行字段。

## 类型收窄

- 编码时优先使用 assertion function 或 type guard 做显式收窄，再调用具体逻辑。
- 当输入来自 HTTP、MCP、文件系统、环境变量或任意 `unknown` 源时，先做收窄，后做业务逻辑。
- 收窄逻辑要靠近边界层，不要把 `unknown` 继续往核心逻辑扩散。
- 收窄失败要直接抛出明确错误，不要悄悄 fallback 成默认值掩盖问题。

推荐：

```ts
function assertBrowserComputer(detail: ComputerDetail): asserts detail is BrowserComputerDetail {
  if (detail.profile !== "browser") {
    throw new TypeError(`Expected browser computer, got ${detail.profile}`);
  }
}
```

## 类与继承

- 默认优先组合而不是继承。
- 不要为了抽象而引入 base class，尤其不要在 base class 上挂一组对子类并不真正通用的方法。
- 只有当共享状态、共享行为和替换关系都非常明确时，才允许引入继承层次。

## 函数边界

- 参数尽量具体，不要默认接收 `Record<string, unknown>`、`any` 或“万能 options 对象”。
- 返回值尽量稳定，不要返回过宽联合，除非调用方确实需要分支处理。
- 一个函数只做一层抽象的事。若既做解析又做分发又做执行，通常说明边界太宽。
- 优先小函数和具名中间变量，让类型错误能定位到具体步骤。

## 运行时校验

- 对外部输入统一使用解析函数或断言函数，把 `unknown` 收敛成精确领域类型。
- 解析函数的职责是“验证 + 生成精确类型”，不要顺手塞入业务副作用。
- 运行时校验产出的类型应直接被后续代码复用，避免第二套本地猜测逻辑。

## 禁止事项

- 不要新增 `any`，除非有无法避免的第三方边界，并且要把影响范围控制在最外层。
- 不要用类型断言 `as Foo` 去跳过本来应该存在的收窄逻辑。
- 不要通过在 base interface 上添加一堆可选字段来兼容未来场景。
- 不要引入“万能管理器”“万能执行器”“万能工厂”这类只能靠 `switch` 才能工作的抽象。

## 提交前自检

在提交 TypeScript 改动前，至少检查：

- 新增类型是否精确表达了具体业务对象，而不是把多个对象强行揉成一个宽接口。
- 业务函数是否接收了最小必要类型，而不是抽象父类型。
- 外部输入是否已经在边界层完成收窄或断言。
- 是否出现了本可拆分的 `switch` 分发入口。
- `pnpm verify:quick` 和 `pnpm verify` 是否通过。
