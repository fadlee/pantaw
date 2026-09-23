FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

ARG TARGETOS=linux
ARG TARGETARCH=amd64

# Copy pre-built binary matching target architecture
COPY binaries/pantaw-agent-${TARGETOS}-${TARGETARCH} /usr/local/bin/pantaw-agent
RUN chmod +x /usr/local/bin/pantaw-agent

ENV INTERVAL=30 \
    DOCKER=false \
    LOG_LEVEL=info

ENTRYPOINT ["/usr/local/bin/pantaw-agent"]
