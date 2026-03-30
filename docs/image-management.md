# Image Management

## Status

本文定义当前仓库里第一版 `image` 对象。

`image` 是一个新的顶层受管对象，用来表示 computerd 可发现或可操作的镜像工件。它不是 `computer`，也不是 `template`。

当前覆盖两类来源：

- `vm image`
- `container image`

## Scope

当前明确管理：

- `qcow2` 基础镜像
- `iso` 安装介质
- Docker image inventory

当前明确不管理：

- VM per-computer `disk.qcow2`
- `cloud-init.iso`
- VM writable disk
- template
- image clone / copy / migration

## Object Model

第一版 `image` detail 至少包含：

- `id`
- `kind`
- `provider`
- `name`
- `status`
- `createdAt?`
- `lastSeenAt?`

当前 provider/kind 组合：

- `provider = "filesystem-vm"`
  - `kind = "qcow2" | "iso"`
- `provider = "docker"`
  - `kind = "container"`

## VM Image Inventory

VM image inventory 同时来自两类来源：

- computerd 受管 import
- 配置文件里的目录扫描

默认路径：

- `/etc/computerd/images.json`

可通过环境变量覆盖：

- `COMPUTERD_IMAGE_CONFIG`

配置文件当前支持两类声明：

```json
{
  "directories": ["/var/lib/images"],
  "files": ["/root/ubuntu-24.04-server-cloudimg-amd64.img"]
}
```

语义：

- `directories[]`
  - 单层扫描目录下的 `qcow2` / `iso` 文件
- `files[]`
  - 存储 computerd 已导入的受管 VM image 路径

当前 VM image 支持：

- `list`
- `get`
- `import`
- 删除受管 imported image

当前不支持：

- upload
- copy
- 删除目录扫描出来的只读 image

如果配置里的某个受管文件路径不存在或不可读：

- 不会拖垮整个 inventory
- 该 image 会以 `status = "broken"` 出现，便于排查

## Container Image Inventory

container image inventory 当前直接以 dockerd 为 source of truth。

第一版通过 `dockerode` 读取和操作 Docker image：

- `list`
- `get`
- `pull`
- `delete`

computerd 当前不维护额外的 container image metadata store。

## API

当前 HTTP API：

- `GET /api/images`
- `GET /api/images/:id`
- `POST /api/images/vm/import`
- `DELETE /api/images/vm/:id`
- `POST /api/images/container/pull`
- `DELETE /api/images/container/:id`

其中：

- VM image 支持 import 和删除受管 imported image
- container image 支持 pull/delete

## VM Create Flow

当前 VM create 已经不再接受直接 path：

- 不再接受 `runtime.source.baseImagePath`
- 不再接受 `runtime.source.isoPath`

现在改为：

- `runtime.source.imageId`

create 时流程是：

1. control-plane 用 `imageId` 解析 image detail
2. 校验 image provider/kind 与 VM source kind 匹配
3. 再把解析出的底层 path 传给现有 VM runtime 创建逻辑

也就是说：

- create contract 只面向 image inventory
- persisted VM detail 仍会展示 resolved path，便于诊断

## Container Create Flow

当前 container create 仍继续使用：

- `runtime.image: string`

container image inventory 第一版主要用于：

- 查看现有镜像
- 预拉取镜像
- Web UI 辅助选择

当前不要求 container create 必须引用 image object id。
