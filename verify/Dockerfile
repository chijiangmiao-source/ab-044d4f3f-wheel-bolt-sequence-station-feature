# 与 playwright npm 包版本保持一致，复用镜像内置浏览器
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

ENV CI=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

CMD ["node", "src/run.js"]
