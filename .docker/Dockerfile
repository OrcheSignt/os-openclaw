FROM node:22-slim AS base

RUN npm install -g openclaw@latest

# Create config directory
RUN mkdir -p /root/.openclaw

# Default config - gateway only, no channels
COPY openclaw.json /root/.openclaw/openclaw.json

EXPOSE 18789

CMD ["openclaw", "gateway", "--port", "18789"]
