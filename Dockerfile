# syntax=docker/dockerfile:1

FROM node:22-bookworm AS builder

WORKDIR /app

# 构建阶段需要编译工具链（better-sqlite3 / node-pty 可能需要）
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# 先复制依赖清单，利用 Docker layer cache
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json

RUN npm ci

# 再复制源码并构建
COPY apps ./apps
COPY packages ./packages

RUN npm run build

# 运行时不需要 devDependencies
RUN npm prune --omit=dev


FROM node:22-bookworm-slim AS runtime

WORKDIR /app

# 运行时依赖：git/ssh/证书/tmux（终端会话与导入仓库需要）
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash git openssh-client ca-certificates tmux tini curl locales vim nano less wget tree sudo \
  && apt-get install -y --no-install-recommends ripgrep jq yq diffutils patch file zip unzip openssl python3 python-is-python3 build-essential pkg-config \
  && echo "en_US.UTF-8 UTF-8" > /etc/locale.gen \
  && locale-gen \
  # 基础镜像里通常已存在 uid=1000 的用户（例如 node），因此不固定 uid，避免冲突
  && useradd -m -s /bin/bash dev \
  && mkdir -p /data \
  && chown -R dev:dev /home/dev /data \
  && echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev \
  && chmod 0440 /etc/sudoers.d/dev \
  && rm -rf /var/lib/apt/lists/*

ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV HOME=/home/dev
ENV NPM_CONFIG_PREFIX=/home/dev/.npm-global
ENV NPM_CONFIG_CACHE=/home/dev/.npm-cache
ENV AWB_HOST=0.0.0.0
ENV AWB_PORT=4310
ENV AWB_DATA_DIR=/data
ENV AWB_SERVE_WEB=1
ENV AWB_WEB_DIST_DIR=/app/apps/web/dist
ENV PATH=/home/dev/.npm-global/bin:$PATH

VOLUME ["/data", "/home/dev"]

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/package.json /app/package.json
COPY --from=builder /app/package-lock.json /app/package-lock.json

# workspace 目录需要存在（node_modules 里是 workspace link）
COPY --from=builder /app/apps/api /app/apps/api
COPY --from=builder /app/apps/web /app/apps/web
COPY --from=builder /app/packages/shared /app/packages/shared

EXPOSE 4310

USER dev

ENTRYPOINT ["tini","--","docker-entrypoint.sh"]
CMD ["node","apps/api/dist/main.js"]
