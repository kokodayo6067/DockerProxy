# Docker Proxy Platform

一个面向单管理员多 VPS 场景的 Docker 可视化运维平台，提供环境接入、主机监控、容器管理、DNS 管理、Nginx 路由转发、证书管理，以及服务级 Docker 迁移能力。

当前前端已统一到 `React 19 + Vite 6 + Tailwind CSS 4.2`，重点页面采用统一的控制台组件和明暗主题。

## 适用场景

- 在一个控制台中统一管理当前宿主机和远端 VPS 的 Docker 环境
- 快速生成并部署 `docker-compose.yml`
- 查看宿主机资源，而不仅仅是容器内部指标
- 将 Compose 项目或独立容器迁移到另一台机器，并保留计划、风险、日志、结果和目标机回滚能力

## 当前能力

### 1. 主机监控

- 支持按环境查看当前宿主机或远端 VPS 的 CPU、内存、磁盘、网络延迟和吞吐
- 展示最近一段时间的 CPU / 内存趋势
- 本机环境优先采集宿主机视角；远端环境通过 SSH 采集 `/proc` 与系统信息

### 2. 容器管理

- 支持按环境切换容器列表
- 自动区分 `Compose 项目` 和 `独立容器`
- Compose 容器按项目折叠展示，独立容器单独展示
- 支持搜索、状态筛选、分页
- 支持启动、停止、重启、删除、查看日志

### 3. 环境接入

- 自动注册当前宿主机为 `local-docker` 环境
- 支持新增 `remote-ssh-docker` 环境
- 支持密码或私钥接入
- 首次接入会记录主机指纹，并给出 `connect / inspect / operate / elevated` 权限分层结果

### 4. DNS 代理模块

- 对接 Cloudflare DNS 记录
- 支持域名切换、记录增删改查
- 支持按名称/内容/类型/代理状态筛选
- 支持分页
- 如果 Token 没有全局 `Zone:Read` 权限，会自动进入 fallback 模式，并结合 `ALLOWED_DOMAINS + CF_ZONE_ID` 兜底

### 5. 服务快速部署

- 根据镜像名、服务名、端口等参数生成 Compose 模板
- 提供在线编辑器，便于手工调整后部署
- 支持选择部署目标环境

### 6. 路由转发与证书

- 管理反向代理规则
- 管理证书状态与续签动作

### 7. Docker 服务级迁移

- 支持两类来源：
  - `Compose 项目`：按整个项目整组迁移
  - `独立容器`：按单容器迁移
- 迁移目标环境来自“环境接入”模块，不再在迁移页重复填写 SSH 凭据
- 支持迁移计划、影响面、风险与阻断项审查
- 支持执行进度、服务矩阵、传输进度、命令日志
- 支持结果查看、导出报告、目标机回滚

## 迁移设计原则

当前迁移页面遵循以下原则：

- 以 `Compose 项目` 或 `独立容器` 为迁移来源，而不是整机全量迁移
- 默认隔离 staging，不直接覆盖目标机现有内容
- 发现冲突即阻断，不隐式替换目标机容器、卷、网络、目录或端口
- 失败只回滚本次迁移触达的目标资源，不反向操作源机器

迁移流程是固定的四步：

1. 选择来源和目标主机
2. 审查计划、风险和阻断项
3. 执行迁移并观察实时日志
4. 查看结果、导出报告或回滚

这比直接暴露一组操作按钮更适合实际使用，能明显降低误操作概率。

## 技术栈

- 前端：React 19、Vite 6、Tailwind CSS 4.2、lucide-react、motion、recharts
- 后端：Express、Dockerode、node-ssh、better-sqlite3、jsonwebtoken
- 运行方式：同一个 Node 进程同时提供 API 和前端静态资源

## 环境要求

- Node.js 18+
- Docker 20.10+
- Docker Compose v2
- Linux 宿主机

如果要使用本平台部署和代理服务，建议预先创建外部网络：

```bash
docker network create proxy_net || true
```

## 快速开始

### 方式一：Docker Compose 运行

1. 克隆仓库

```bash
git clone <your-repo-url>
cd DockerProxy
```

2. 准备 `.env`

如果你没有现成配置，可以直接新建 `.env`：

```bash
touch .env
```

至少建议填写这些变量：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=123456
JWT_SECRET=change-me
APP_MASTER_KEY=change-me-too
NGINX_CONTAINER_NAME=nginx-gateway
CERT_AGENT_CONTAINER_NAME=cert-agent
VPS_PUBLIC_IP=
CF_API_TOKEN=
CF_ZONE_ID=
CF_PROXIED=true
CF_TTL=1
ALLOWED_DOMAINS=example.com
```

说明：

- 仓库里的 `.env.example` 目前还保留了一些 AI Studio 注释；部署本项目时以上面的实际变量为准。
- 如果不使用 Cloudflare，可暂时留空 `CF_*` 相关配置。
- `APP_MASTER_KEY` 用于加密保存 SSH 私钥、密码和后续集成凭据；如果不配置，将无法创建远端环境。

3. 启动

```bash
docker compose up -d --build
```

默认访问地址：

```text
http://localhost:3000
```

当前 `docker-compose.yml` 会挂载：

- `/var/run/docker.sock`：用于管理宿主机 Docker
- `./data`：用于持久化平台数据
- `./.env`：用于系统设置读写

当前 `./data` 下会保存：

- `app.db`：平台控制面数据库
- `projects/`：Compose 项目与部署产物
- `migrations/`：迁移快照、报告和事件流
- `nginx/`：Nginx 配置产物

### 方式二：源码运行

1. 安装依赖

```bash
npm install
```

2. 准备 `.env`

```bash
touch .env
```

3. 开发模式

```bash
npm run dev
```

4. 生产模式

```bash
npm run build
NODE_ENV=production npm run start
```

说明：

- `npm run build` 只构建前端静态资源
- `npm run start` 仍然通过 `tsx server.ts` 启动 Node 服务
- 当前服务端口固定为 `3000`

## 常用脚本

```bash
npm run dev
npm run build
npm run start
npm run lint
```

## 目录说明

```text
src/                    前端页面与组件
src/components/ui/      共享 UI primitives
server/routes/          API 路由
server/services/        Docker / DNS / 迁移 / 监控等服务逻辑
data/                   平台运行数据、项目配置、迁移快照等
```

## 页面说明

### 主机监控

- 查看宿主机资源和历史趋势
- 若采集不到宿主机，会显示回退告警

### 容器管理

- Compose 项目折叠展示
- 独立容器直接展示
- 支持日志查看和常用生命周期操作

### DNS 代理模块

- 先切换域名，再查看和编辑记录
- 适合多域名场景

### Docker 服务级迁移控制台

推荐使用顺序：

1. 在“选择来源”中选择 Compose 项目或独立容器
2. 填写目标主机 SSH
3. 点击“生成计划”
4. 在“审查计划”中确认影响范围和风险
5. 点击“开始迁移”
6. 在“执行监控”中查看阶段时间线、传输进度和日志
7. 在“结果与回滚”中确认结果，必要时导出报告或回滚

### 系统设置

- 在线查看和编辑 `.env`
- 查看当前系统加载配置
- 支持明暗主题切换

## 安全建议

1. 立即修改默认账号密码和 `JWT_SECRET`
2. 不要把平台直接暴露在公网裸奔，建议置于 HTTPS 反代之后
3. 给 Cloudflare Token 最小必要权限
4. 迁移前先确认目标机磁盘空间、Docker / Compose 可用性和 SSH 权限

## 当前限制

- 当前未内置自动化测试脚本
- 构建可通过，但前端主包仍偏大，后续建议做页面级拆包
- 迁移控制台目前更适合单主机到单主机的迁移场景，不适合双写、跨区域实时复制等复杂拓扑

## 验证命令

在当前仓库下可使用：

```bash
npm run lint
npm run build
```

## License

[MIT](./LICENSE)
