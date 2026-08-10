FROM node:22-slim AS base

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Pin the version — @latest makes builds non-reproducible and each rebuild
# depends on internet access, which airgapped sites don't have.
ARG OPENCLAW_VERSION=2026.7.1-2
RUN npm install -g openclaw@${OPENCLAW_VERSION}

# Create config directory
RUN mkdir -p /root/.openclaw

# Default config - gateway only, no channels
COPY openclaw.json /root/.openclaw/openclaw.json

# Belt-and-braces for airgapped deployments: never self-update at runtime.
ENV OPENCLAW_NO_AUTO_UPDATE=1

EXPOSE 18789

CMD ["openclaw", "gateway", "--port", "18789"]
