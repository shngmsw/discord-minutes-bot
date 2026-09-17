# shngmsw-ubuntu（Docker 専用機）で常駐させるためのイメージ。
# ビルドと起動は手元の clone から `docker --context shngmsw-ubuntu` で行う（README「Docker での常駐」参照）。
# ffmpeg は ffmpeg-static のバイナリを使うので apt では入れない。
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# .env は bind mount で外から渡す（イメージに焼かない）
#   -v <host>/.env:/app/.env:ro   （dotenv/config が cwd の .env を読む）
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
