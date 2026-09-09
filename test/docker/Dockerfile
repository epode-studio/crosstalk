FROM oven/bun:1-alpine
RUN apk add --no-cache curl
WORKDIR /app
COPY dist ./dist
COPY bin ./bin
# src as well, so a test can speak the daemon's control socket the same way an
# MCP tool does rather than reimplementing the protocol in shell.
COPY src ./src
COPY package.json ./
RUN chmod +x bin/crosstalk
ENV CROSSTALK_HOME=/data
RUN mkdir -p /data
