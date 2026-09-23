BINARY=pantaw-agent
DIST=dist
VERSION?=$(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS=-s -w -X main.Version=$(VERSION)

.PHONY: build clean build-all

build:
	go build -ldflags="$(LDFLAGS)" -o $(BINARY) .

clean:
	rm -rf $(BINARY) $(DIST)

build-all: clean
	mkdir -p $(DIST)
	GOOS=linux GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o $(DIST)/pantaw-agent-linux-amd64 .
	GOOS=linux GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o $(DIST)/pantaw-agent-linux-arm64 .
	GOOS=darwin GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o $(DIST)/pantaw-agent-darwin-amd64 .
	GOOS=darwin GOARCH=arm64 go build -ldflags="$(LDFLAGS)" -o $(DIST)/pantaw-agent-darwin-arm64 .
	GOOS=freebsd GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o $(DIST)/pantaw-agent-freebsd-amd64 .
	GOOS=windows GOARCH=amd64 go build -ldflags="$(LDFLAGS)" -o $(DIST)/pantaw-agent-windows-amd64.exe .
