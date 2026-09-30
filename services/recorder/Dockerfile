# AIS recorder for a Cloud Run worker pool (specs/deployment-plan.md).
# Build from the repo root:  docker build -f services/recorder/Dockerfile -t whaleboat-recorder .
# Node runs the TypeScript file directly; there is nothing to install or compile.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY services/recorder/recorder.ts ./
USER node
CMD ["node", "recorder.ts"]
