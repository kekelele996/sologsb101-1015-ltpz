# 古树名木复壮养护档案（sologsb101-1015）

面向园林部门的古树名木保护岗：为一树一档建立检查、复壮、加固与长势复评的完整记录，
按检查周期自动提示加固件超期，长势为衰弱 / 濒危时强制填写后续措施。

**纯前端单页应用**：无后端、无数据库服务、无 API 调用，数据全部保存在浏览器本地（IndexedDB），
容器完全无状态、不挂载任何数据卷。

---

## 一、Docker 一键启动（推荐）

```bash
cp .env.example .env && docker compose up -d --build
```

启动后访问：**http://localhost:22815**

常用命令：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f frontend    # 查看 nginx 日志
docker compose down                # 停止并移除容器
docker compose up -d --build       # 改完代码后重新构建
```

> 端口可通过 `.env` 里的 `FRONTEND_PORT` 覆盖；容器名与镜像名前缀由 `COMPOSE_PROJECT_NAME` 控制。
> `docker-compose.yml` 顶层已写 `name: gbheritagetree` 兜底，因此在任意目录名（含中文）下
> `docker compose config --quiet` 都不会报错。

---

## 二、技术栈

| 分层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | Vue 3 | `<script setup>` 组合式 API |
| 语言 | TypeScript 5 | `strict` 模式，`vue-tsc --noEmit` 零错误 |
| UI 组件库 | Element Plus 2 | 表格、表单、弹窗、日期选择、时间线、消息提示 |
| 图标 | @element-plus/icons-vue | 入口统一全局注册 |
| 构建 | Vite 6 | 开发端口与宿主端口一致（22815） |
| 路由 | Vue Router 4 | `createWebHistory` + 路由懒加载 |
| 状态管理 | Pinia 2 | setup store，跨页状态集中在 store，页面只读 store |
| 本地持久化 | Dexie 4（IndexedDB） | 库名 `gbheritagetree`，含 v1 → v2 → v3 升级迁移 |
| 容器 | node:20-alpine → nginx:alpine | 多阶段构建，`chmod -R a+rX` 规避静态资源 403 |

---

## 三、目录结构

```
sologsb101-1015/
├── README.md
├── docker-compose.yml          # name: gbheritagetree，不写 version 字段
├── .env / .env.example         # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── .gitignore
└── frontend/
    ├── Dockerfile              # 多阶段：node:20-alpine 构建 → nginx:alpine 托管
    ├── nginx.conf              # try_files $uri $uri/ /index.html; + gzip
    ├── .dockerignore
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    ├── public/favicon.svg
    └── src/
        ├── main.ts             # 入口：Pinia + Router + Element Plus + 初始化数据库
        ├── App.vue             # 外壳：顶部导航 + 当前古树上下文 + 页脚
        ├── env.d.ts
        ├── styles/main.css
        ├── types/              # tree.ts survey.ts measure.ts support.ts supportCheck.ts review.ts
        ├── stores/             # treeStore.ts measureStore.ts reviewStore.ts
        ├── components/common/  # VigorTag.vue FilterBar.vue StatBadge.vue EmptyPanel.vue
        ├── hooks/              # useTreeHistory.ts useIdbTable.ts
        ├── pages/              # 6 个模块页面（加固件台账 / 现场巡查分两页）
        ├── router/index.ts     # 路由表 + ROUTES 常量
        └── utils/              # dimension.ts supportCheck.ts db.ts export.ts seed.ts id.ts
```

---

## 四、路由与功能模块

| 路由 | 页面文件 | 功能 |
| --- | --- | --- |
| `/trees` | `pages/TreeList.vue` | 古树一树一档：新建/编辑/级联删除、按保护级别与树种筛选、回显检查次数与最新长势等级 |
| `/trees/:id/surveys` | `pages/TreeSurvey.vue` | 树体与立地检查：录树高/胸径/冠幅/倾斜/空洞并对比上次、年化生长量、古树历史时间线 |
| `/measures` | `pages/MeasureBoard.vue` | 复壮措施台账：按类型与实施状态筛选、行内草稿、批量改状态，完成即回写最近复壮日期 |
| `/supports` | `pages/SupportLedger.vue` | 加固件台账（档案室）：只登记安装日期与检查周期，展示最新巡查/下次检查、超期筛选、台账↔巡查对账差异、巡查记录 JSON 并入 |
| `/supports/checks` | `pages/SupportPatrol.vue` | 加固件现场巡查（巡查班组）：每次上树一条记录（检查日期、检查人、现场结论），按古树+类型核对台账 |
| `/reviews` | `pages/ReviewView.vue` | 长势复评与结构版本：衰弱/濒危强制填写后续措施、历史时间线、JSON 导入导出 |

`/` 重定向到 `/trees`，未匹配路径统一回落到 `/trees`。
**层级路由支持直接深链**：把 `http://localhost:22815/trees/tree-guozijian-0007/surveys` 直接粘贴到地址栏即可打开；
若 id 查不到，页面会给出「古树档案不存在或已被删除」的友好空态与返回入口，不会白屏。

---

## 五、数据存储说明

* **持久化方案**：IndexedDB，通过 Dexie 封装（`src/utils/db.ts`）。
* **数据库名**：`gbheritagetree`。
* **数据结构版本**：`DB_SCHEMA_VERSION = 3`：
  * `version(1)` 建立全部表；`version(2)` 补齐 `surveys [treeId+date]`、`measures.operator`、`reviews.trend` 等索引，
    回填 `revision` / `createdAt` / `updatedAt`、`trees.lastMeasureDate`、`reviews.followUp`；
  * `version(3)` 把**现场巡查记录从加固件台账拆出**：
    * 新增 `supportChecks` 表（`supportId, treeId, [treeId+type], date, inspector`）；台账 `supports` 去掉 `lastCheckDate` 字段与索引；
    * 旧台账按「安装日期 + 检查周期」补出**首条巡查记录**：优先沿用原 `lastCheckDate`，无则以安装日期作为安装即首检；
      安装日期缺失 / 非法补不出的，在台账上标 `backfillIssue` 并在对账差异中单列；
    * 导入 v2 旧存档（无 `supportChecks`）时执行同一套补录逻辑。
* **两本账的职责边界**：
  * **加固件台账 `supports`（档案室）**：只登记古树、类型、安装日期、检查周期（月）；
  * **现场巡查 `supportChecks`（巡查班组）**：每次上树一条，含检查日期、检查人、现场结论（正常 / 需关注 / 异常待处理）与现场情况；
  * 两侧按 **古树编号（treeId）+ 加固件类型** 对账（`src/utils/supportCheck.ts`）：
    * `ledger-only` 有台账无巡查、`check-only` 有巡查无台账、`backfill-failed` 旧数据补不出首条，三类差异单列；
  * **下次检查日期、顶部超期名单、超期筛选、古树档案与养护总览 CSV 的超期口径**全部按巡查侧**最新一条**记录计算；
    尚无巡查记录时以安装日期作为首次起算点。
  * **巡查记录并入**（`mergeSupportChecks`）：按条独立提交、天然幂等（古树+类型+日期+检查人+结论一致即跳过）；
    失败条目原样返回，只重试验收这侧即可，台账与已并入记录照留不动。
* **表结构**：

  | 表 | 主键 | 主要索引 |
  | --- | --- | --- |
  | `trees` | id | code, species, protectLevel, ageYears, createdAt, updatedAt, owner |
  | `surveys` | id | treeId, [treeId+date], date, siteNote |
  | `measures` | id | treeId, type, state, date, operator |
  | `supports` | id | treeId, type, installDate |
  | `supportChecks` | id | supportId, treeId, [treeId+type], date, inspector |
  | `reviews` | id | treeId, date, vigor, trend |

* **首屏演示数据**：`initDatabase()` 在打开数据库后检测 `trees` 表是否为空，为空则调用 `utils/seed.ts` 播种，
  幂等且只执行一次。播种链路为 **古树 → 树体检查 / 复壮措施 / 加固件台账 + 现场巡查 / 长势复评**：
  * 3 株古树（京-01-0007 国槐 一级 / 京-02-0113 银杏 一级 / 京-05-0246 侧柏 二级）；
  * 9 条树体检查、8 条复壮措施、6 件加固件台账（其中 1 件安装日期缺失，用于验证旧数据补录失败单列）、
    7 条现场巡查（**京-01-0007 支撑杆** 与 **京-05-0246 避雷** 最新一条已超周期，另含 1 条「有巡查无台账」、
    1 件「有台账无巡查」差异样本）、7 条长势复评。
  * 固定 id 如 `tree-guozijian-0007`、`tree-xiangshan-0113`、`tree-ritan-0246` 可直接用于深链验证。
* **其他本地数据**：`localStorage` 仅保存「最近选中的古树 id」这一界面偏好，不存业务数据。
* 删除古树会**级联清理**其下的树体检查、复壮措施、加固件台账、现场巡查与复评记录（同一 Dexie 事务内完成）；
  删除单件台账会清理其名下已关联的巡查记录，对不上台账的巡查记录保留并在差异区列出。

---

## 六、本地开发

```bash
cd frontend
npm install
npm run dev          # http://localhost:22815
```

其他命令：

```bash
npm run build        # vue-tsc --noEmit && vite build（零错误）
npm run typecheck    # 仅做 TypeScript 类型检查
npm run preview      # 预览 dist 产物
```

---

## 七、核心业务规则

* **倾斜安全阈值**：< 5° 正常；5°–10° 需关注；> 10° 超限（`src/utils/dimension.ts`）。
* **空洞风险**：1–2 处需关注，≥ 3 处判定为高风险，建议立即安排树洞修补与防腐处理。
* **生长量年化**：由最近两次检查的差值按实际天数折算为「每年」增量，间隔不足 30 天时退回直接差值。
* **加固件超期**：台账只管安装日期与检查周期；`最新一条现场巡查日期 + 检查周期（月）` 早于今天即为超期
  （无巡查记录时自安装日期起算）。台账列表自动高亮、顶部超期名单、超期筛选与养护总览 CSV 同口径；
  巡查班组在「现场巡查」页新登记一条记录后，下次检查日期与高亮按最新记录自动重算。
* **台账 ↔ 巡查对账**：按古树编号 + 类型核对，有台账无巡查 / 有巡查无台账 / 旧数据补录失败三类对不上的单列。
* **巡查记录并入**：JSON 批量并入按条独立提交、幂等去重；失败只重试验收（巡查）这侧，已并入口径照留。
* **复评强制校验**：长势为「衰弱」或「濒危」时，后续措施为必填项，未填写无法保存。
* **措施回写**：复壮措施状态改为「已完成」时，若实施日期晚于古树现有最近复壮日期，则自动回写该日期。
