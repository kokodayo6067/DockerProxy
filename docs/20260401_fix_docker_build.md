# 2026-04-01 Docker 部署修复与优化

## 问题描述
用户在服务器上使用 `docker-compose up -d` 部署项目时，由于前端使用 `node:18-alpine` 环境构建导致 Vite 和 TailwindCSS 缺乏 `linux-musl` 相关的 native binding 可选依赖，从而在 `npm run build` 阶段执行失败（`Error: Cannot find native binding`）。同时 `docker-compose.yml` 发出了过时 `version` 属性的警告。

## 修复内容
1. **Dockerfile 依赖安装过程优化**：在 `Dockerfile` 中的 `RUN npm install` 之前增加对 `package-lock.json`（如果由于宿主机不同平台传入容器引起的跨平台锁文件）和 `node_modules` 的清理，强制 `npm` 在 Alpine Linux 环境中重新解析并获取对应的 native bindings （`linux-musl`）。
2. **新增 `.dockerignore` 文件**：添加了 `.dockerignore` 文件并排除了 `node_modules`、`dist`、`.git` 等文件，避免在执行 `COPY . .` 时将开发宿主机（如 MacOS/Windows 平台）残留的依赖包直接覆盖容器中的正确依赖。
3. **修复 docker-compose 警告**：移除了 `docker-compose.yml` 开头废弃的 `version` 属性，消除部署警告提示。
4. **修复启动时死循环崩溃问题（Missing script: start）**：排查发现 `Dockerfile` 最终指令设定为 `CMD ["npm", "start"]` 运行后端，但在 `package.json` 中遗漏了 `"start"` 脚本。已经补充了 `"start": "tsx server.ts"` 命令，使得容器不再一运行就抛错闪退。
5. **修复前端“容器管理”页面白屏崩溃与属性缺失**：原代码依据 Dockerode 的原始 PascalCase 属性（如 `c.Names`、`c.State`）进行结构数组渲染；但实际后端 API 对外暴露时已经将数据转化为了标准的 camelCase 小写格式（如 `c.name`, `c.state`）。这就导致前端不仅在请求异常容器时触发 `undefined` 报错，而且所有字段都因为大小写不匹配而渲染出“Unknown”或空文本。现已将 `src/types.ts` 及 `src/App.tsx` 中的渲染字段全部打平成和 API 一致的 `id`, `name`, `image`, `state`, `status`。
6. **重构 DNS Cloudflare Token 白名单权限控制**：系统现已从环境变量“盲猜死配置”升级为**实时刻画动态鉴权系统**。新增 `/api/dns/zones` 接口实时向云端获取并交叉对比过滤 `ALLOWED_DOMAINS`。同时增加了针对盲配只写 Token 权限被阻拦降级的预警界面与日志报错兜底（强提示配置和 Token 不符行为）。

## 验证
在服务器或本地重新运行 `docker compose up -d --build` 重新构建即可生效且不产生警告，后端监听 3000 端口。
