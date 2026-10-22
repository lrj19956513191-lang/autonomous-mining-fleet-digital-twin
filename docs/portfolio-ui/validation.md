# Portfolio UI 发布前验收

## 范围与身份

- UI运行/测试源码提交：`7f6ac4dacb6c236d582fbaff1d7fa83b2bf3c8cf`。
- 初始作品集快照：`d60fd8dac8a7f9df63d679c4b58d347ecb2b07ed`；不是原私有开发历史的替代提交。
- 本文档、截图与manifest由后续文档提交交付；最终交付提交用`git log -1`识别，不在manifest中自引用。
- 只审阅UI分支，无main合并、push或生产部署。本轮未修改后端、协议、仿真、数据库契约或既有Phase2D证据。

## 本轮自动检查

| 项目 | 命令/结果 |
|---|---|
| 前端完整回归 | `npm.cmd --prefix frontend test`；23文件，1152项PASS，exit 0 |
| TypeScript + production build | `npm.cmd --prefix frontend run build`；exit 0 |
| 新增测试 | 相对初始公开版新增11项（10项展示、1项缩放默认值），既有断言未删除/放宽 |
| 后端完整pytest | 本轮未重跑；原813项是历史Phase2D结果，不能标成此次重新执行 |

保留Vite configLoader/import扩展名提示和大bundle警告；没有升级依赖或执行audit fix。源码分段对照确认`createAppModeHost`和App的原生命周期逻辑保持不变；Viewer工厂另有用户授权的原生缩放控件及对应资源清理。

## 真实Chrome/Cesium

- Chrome：Chrome/155.0.8059.40，真实WebGL2、未丢失上下文。
- 真实浏览器运行于Vite开发服务（本次production build通过，但未将这些截图冒充production preview测试）。
- LIVE与REPLAY各检查1920×1080、1366×768、480×900，共6组视口；无页面水平溢出，地图有效显示，缩放滑条在画布区域内。
- LIVE选择、显式定位、跟踪、停止跟踪和清除选择通过；普通选择不改变相机。
- 回放Play、Pause、2×切换、数值seek至2秒、车辆选择和定位通过。其余倍率/BUFFERING/后台恢复/缺口语义沿用已有测试与历史证据，本轮不宣称全部重新实测。
- 新缩放滑条默认10.00×，范围0.25×–10.00×；真实键盘ArrowLeft/Home/End分别得到9.75/0.25/10，与实际Cesium zoomFactor和ARIA数值一致。每个新Viewer重置默认值。

### 资源及相机

| 阶段 | 活动Viewer | canvas | 当前页面Fleet WS | 缩放控件 |
|---|---:|---:|---:|---:|
| StrictMode setup→cleanup→setup后LIVE | 1 | 1 | 1 | 1 |
| 侧栏折叠后LIVE | 1 | 1 | 1 | 1 |
| REPLAY | 1 | 1 | 0 | 1 |
| 返回LIVE | 1 | 1 | 1 | 1 |

通过Chrome调试作用域只读取实际Viewer对象的公共API，不添加生产`window.viewer`或调试端点。捕获的旧Viewer均isDestroyed=true；旧滑条DOM已脱离，向旧input派发事件不能改变新Viewer。

连续3次真实遥测更新中Entity与position对象身份保持。停止跟踪后即时测量：位置差0.0m，direction差2.2607700092365553e-15rad，up差1.0358421028410385e-15rad，frustum一致；后续真实渲染帧和3次遥测更新的样本也均在原阈值0.01m/1e-6rad内。

### 截图与数据来源

`live.png`、`replay.png`均为本轮真实Chrome PNG原字节复制，无图像生成或后处理。截图是局部视角；16个Entity由实际对象计数验证，不能只凭图片推出集合完整性。

回放使用单独UI验收录制：session `d11cb135-4d67-49cb-9e90-a025d5a94bf3`，COMPLETED，seq0–5共6包，模拟0–5秒，通过正式lifespan/Recorder真实录制并正常结束。它不是Phase2D原260包会话，也不是Controlled Gap Fixture。LIVE截图对应的真实WS快照和seek=2的真实HTTP快照见browser-samples.json。

## 日志观察与限制

- 本轮页面Runtime.exceptionThrown为0。
- Network记录4条`net::ERR_ABORTED`，Chrome均标记`canceled=true`。本次操作包含重载/模式切换；取消事件原样保留，不据此宣称所有请求均成功。
- 后端在客户端关闭时记录`WebSocket resource stream-close failed: WebSocketDisconnect()`。源码的任务完成回调观察到了已完成close任务异常；本轮未见`unreleased resource`日志，实际页面WS/Viewer所有权符合上表。这不是关闭根因已经解决的证据，未修改后端处理。
- 本轮未验收服务最终shutdown、Recorder长期启动可靠性、Chrome collectionChanged fatal注入或新的生产部署。

## 双基线完整性

1. `docs/phase2d-evidence/manifest.json`保持原字节，94项记录限定于初始作品集提交`d60fd8d…`的Git blob；禁止拿这些旧摘要直接判定新版UI当前文件。
2. 新`docs/portfolio-ui/manifest.json`核验当前交付文件（不含自身），并记录本次UI运行提交、截图、公开样本及旧manifest的精确SHA。
3. 执行`python docs/portfolio-ui/verify.py`分别验证历史Git blob与当前交付工作树。脚本只读，不checkout/reset或联网。
4. 私有原始日志、完整测试数据库、CDP事件和其他视口截图保存在本地ignored证据目录，不随Git交付；公开材料仅含精简真实样本及其SHA索引。

## 独立审查

本轮独立只读Reviewer已检查main至运行提交的7个前端文件实际差异、README、新版验收文档、公开样本、真实Chrome原始事件、截图及测试/build日志。Spec Compliance、Code Quality、Evidence Quality、Documentation Quality均通过；新增Critical 0 / Important 0 / Minor 0。审查未扩大为整分支历史审查，也未将未执行的production preview、最终shutdown或Chrome fatal专项写成通过。

## 保留风险

- `RECORDER_START_TIMEOUT_UNRESOLVED`，root_cause: UNKNOWN。
- `SHUTDOWN_UNRESOLVED`，root_cause: UNKNOWN。
- `CHROME_FATAL_NOT_VERIFIED`，status: NOT VERIFIED。

本次UI发布准备不关闭这些风险，也不代表生产就绪。原历史Minor、npm安全提示及Vite/Starlette警告保留；项目LICENSE仍未选择。
