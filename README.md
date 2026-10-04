# HarborGrid · 港口集装箱堆场作业协同与闸口调度系统

React + Vite + TypeScript 前端，Node.js + Express + TypeScript 服务端。面向中型集装箱码头，把船期、箱务、堆场区块、闸口预约、设备作业和异常闭环放在同一套作业控制台中。

## 启动

```bash
npm install
npm run dev
```

前端默认 Vite 端口 5178，API 默认 `http://localhost:4107`。

## 业务能力

- 船舶航次、泊位窗口、计划/已完成翻箱和延误风险
- 箱号、尺寸、冷藏温度、危险品级别、海关状态、进出口/中转流向
- 堆场区块容量、堆存热度、冷藏插座、危险品隔离和设备可达性
- 闸口预约时隙、车道、OCR/称重/封志校验状态与同车冲突检测
- 岸桥、场桥、集卡、正面吊设备池和约束感知任务队列
- 自动堆位推荐、冷藏/危险品约束、海关查验阻塞、任务指派审计
- React 控制台支持船期驾驶舱、闸口操作、堆场热区与设备任务操作
- **班次交接包**：按航次/区块/闸口车道/未闭环事件选择对象，冻结快照（未完成动作、阻塞原因、风险等级、待确认事项）；接班人逐项确认/退回/补充，确认只记录接管结论、不回写原始作业状态；自动处理源数据漂移、双包覆盖、交接包过期、部分确认、跨班次滚动交接、敏感备注按角色可见，控制台汇总仍无人负责的事项

当前使用内存种子数据，领域服务通过 REST API 暴露，后续可接入 TOS、OCR、称重、RTG 遥测、预约配额和优化求解器。

### 班次交接包 API

- `GET /api/handover/catalog` 可选对象：航次、区块、车道、未闭环事件（闸口冲突/阻塞任务/设备异常/冷藏/危险品/延误）
- `POST /api/handover/packages` 按范围生成交接包（冻结快照），响应附带覆盖与跨班次重复接管提醒
- `GET /api/handover/packages` / `/:id` 交接包列表与明细；请求头 `X-Handover-Role: outgoing|incoming|supervisor` 控制敏感备注可见范围
- `POST /api/handover/packages/:id/items/:itemId/confirm|return|supplement` 逐项确认（漂移须先知悉）、退回（必填原因）、补充现场信息
- `POST /api/handover/rollover` 把过期包中未确认/已退回事项滚动到新班次，已确认事项不重复接管
- `GET /api/handover/console` 交接控制台：无人负责事项、双重覆盖、过期包、重复接管链路、漂移计数
