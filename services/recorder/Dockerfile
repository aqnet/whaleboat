# AIS recorder for a Cloud Run worker pool (specs/deployment-plan.md).
# Build from this directory:  docker build -t whaleboat-recorder services/recorder
# Node runs the TypeScript file directly; there is nothing to install or compile.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY recorder.ts ./
USER node
CMD ["node", "recorder.ts"]
