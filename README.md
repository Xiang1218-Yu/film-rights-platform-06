# FrameLedger · 影视制作预算与资产版权协同平台

React + Vite + TypeScript 前端，Node.js + Express + TypeScript 服务端。面向中型影视制作团队，演示预算版本、成本预测、合同里程碑、资产版本、授权窗口冲突与审批审计的协同闭环。

## 启动

```bash
npm install
npm run dev
```

前端默认 Vite 端口 5175，API 默认 `http://localhost:4104`。

## 业务能力

- 项目 / 季 / 交付日期与预算基线；计划、承诺、实际、预测成本四账合一
- 供应商合同额度、付款里程碑与付款暴露额
- 母版、预告、海报、音频、字幕等资产版本和 checksum 登记
- 地域、平台、有效期、版权标签冲突检测
- 预算 / 资产 / 交付审批队列和审计事件
- 海外节展交付预检：范围选择、资产/授权/审批/合同快照、checksum 摘要、阻断原因、记录例外、幂等与中断重试
- React 控制台支持项目切换、预算表、风险雷达、审批操作、版权资产视图和交付 manifest 复核

当前使用内存业务数据；交付 manifest 与例外使用本地 JSON 原子持久化（默认 `.data/delivery-manifests.json`，可用 `DELIVERY_STORE_PATH` 覆盖），领域服务按模块设计，后续可替换 PostgreSQL、对象存储、工作流和版权方台账服务。

## 交付预检策略

- `ready` 只表示预检 manifest 已生成，`packageStatus` 始终为 `not_created`，`objectStorageVerified=false`；未接对象存储时不会宣称上传、下载或交付完成。
- critical 问题 fail-closed：资产未锁定/checksum 不合规/预检期间换版或授权窗口变化、授权证明缺失或失效、critical 版权冲突、交付或资产审批缺失/待处理/驳回、关键合同里程碑未处理、合同数据缺失。
- 仅有明确白名单的 warning 可由有申请人、批准人、事由、有效期和资产绑定的记录例外继续：非 critical 冲突、授权窗口尚未生效、非关键合同未结点；critical 不接受例外。
- 生成请求使用 idempotencyKey；相同键和相同范围返回同一份快照，相同键换范围或换版会拒绝。生成中断保留 `failed` 与快照，租约过期后可按同一快照重试；若源数据已经变化则阻断并要求新建 manifest。
