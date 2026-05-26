// Package main implements the Pantaw agent.
//
// Agent mengumpulkan metrik sistem (CPU, memory, disk, network, load,
// temperature, dan optional Docker container stats) lalu mengirimkannya
// ke hub via HTTPS POST tiap INTERVAL detik.
//
// Konfigurasi via env var:
//   HUB_URL       — URL hub (mis. https://your-hub.workers.dev), required
//   AGENT_TOKEN   — Bearer token, required
//   INTERVAL      — interval detik, default 30
//   DOCKER        — "true" untuk enable container stats, default false
//   LOG_LEVEL     — debug | info | warn | error, default info
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// Version di-set saat build via -ldflags
var Version = "dev"

type Config struct {
	HubURL     string
	Token      string
	Interval   time.Duration
	Docker     bool
	LogLevel   slog.Level
}

func loadConfig() (*Config, error) {
	cfg := &Config{
		Interval: 30 * time.Second,
		LogLevel: slog.LevelInfo,
	}

	cfg.HubURL = strings.TrimRight(os.Getenv("HUB_URL"), "/")
	cfg.Token = os.Getenv("AGENT_TOKEN")
	if cfg.HubURL == "" {
		return nil, fmt.Errorf("HUB_URL is required")
	}
	if cfg.Token == "" {
		return nil, fmt.Errorf("AGENT_TOKEN is required")
	}

	if s := os.Getenv("INTERVAL"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n < 5 {
			return nil, fmt.Errorf("INTERVAL must be integer >= 5")
		}
		cfg.Interval = time.Duration(n) * time.Second
	}

	if s := os.Getenv("DOCKER"); s == "true" || s == "1" {
		cfg.Docker = true
	}

	switch strings.ToLower(os.Getenv("LOG_LEVEL")) {
	case "debug":
		cfg.LogLevel = slog.LevelDebug
	case "warn":
		cfg.LogLevel = slog.LevelWarn
	case "error":
		cfg.LogLevel = slog.LevelError
	}

	return cfg, nil
}

func main() {
	versionFlag := flag.Bool("version", false, "print version and exit")
	flag.Parse()
	if *versionFlag {
		fmt.Println("pantaw-agent", Version)
		return
	}

	cfg, err := loadConfig()
	if err != nil {
		fmt.Fprintln(os.Stderr, "config error:", err)
		os.Exit(2)
	}

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(logger)

	collector, err := NewCollector(cfg)
	if err != nil {
		slog.Error("init collector", "err", err)
		os.Exit(1)
	}
	sender := NewSender(cfg)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		s := <-sig
		slog.Info("shutting down", "signal", s.String())
		cancel()
	}()

	slog.Info("pantaw-agent starting",
		"version", Version,
		"hub", cfg.HubURL,
		"interval", cfg.Interval,
		"docker", cfg.Docker,
	)

	// Initial baseline collection (CPU/disk/net delta tracking butuh prev value)
	collector.Init()

	// Skip baseline send: tunggu interval pertama agar delta valid
	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			payload, err := collector.Collect()
			if err != nil {
				slog.Warn("collect failed", "err", err)
				continue
			}
			if err := sender.Send(ctx, payload); err != nil {
				slog.Warn("send failed", "err", err)
			} else {
				slog.Debug("sent", "ts", payload.Ts, "cpu", payload.CPU, "mem", payload.Mem)
			}
		}
	}
}
