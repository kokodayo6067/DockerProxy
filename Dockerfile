ARG NODE_IMAGE=node:20-alpine
FROM ${NODE_IMAGE}

# 安装 docker 客户端，以便在容器内调用宿主机的 docker
RUN apk add --no-cache docker-cli

WORKDIR /app

# 复制 package.json 和 package-lock.json
COPY package*.json ./

# 安装依赖前删除可能由于跨平台产生的 lock 文件，避免 native binding 报错
RUN rm -rf package-lock.json node_modules && npm install

# 复制所有源代码
COPY . .

# 构建前端产物
RUN npm run build

# 暴露 3000 端口
EXPOSE 3000

# 启动服务
CMD ["npm", "start"]
