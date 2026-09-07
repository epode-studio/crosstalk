FROM oven/bun:1-alpine
WORKDIR /app
COPY dist ./dist
COPY bin ./bin
RUN chmod +x bin/crosstalk
ENV CROSSTALK_HOME=/data
RUN mkdir -p /data
