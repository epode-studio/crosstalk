# The relay, for when you want one always on rather than hosted for the minute
# it takes to pair. It routes ciphertext and never holds a key that can open it.
FROM oven/bun:1-alpine
WORKDIR /app
COPY relay/relay.ts relay/relay.ts
COPY src/crypto.ts src/config.ts src/protocol.ts src/
EXPOSE 8787
ENV PORT=8787
HEALTHCHECK --interval=30s CMD wget -qO- http://127.0.0.1:8787/health || exit 1
CMD ["bun", "relay/relay.ts", "--host", "0.0.0.0"]
