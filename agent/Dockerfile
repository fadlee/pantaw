# syntax=docker/dockerfile:1

FROM golang:1.24-alpine AS builder

WORKDIR /src

# Cache dependencies
COPY go.mod go.sum ./
RUN go mod download

# Build agent binary
COPY . .
ARG TARGETOS
ARG TARGETARCH
ARG VERSION=dev

RUN CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build \
    -ldflags="-s -w -X main.Version=${VERSION}" \
    -o /pantaw-agent .

# Final stage: minimal runtime
FROM alpine:3.21

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /pantaw-agent /usr/local/bin/pantaw-agent

# Set default env
ENV INTERVAL=30 \
    DOCKER=false \
    LOG_LEVEL=info

ENTRYPOINT ["/usr/local/bin/pantaw-agent"]
