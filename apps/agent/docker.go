package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"
)

// DockerClient query Docker daemon via Unix socket.
// Tidak pakai Docker SDK supaya binary tetap kecil (~no overhead).
type DockerClient struct {
	client *http.Client
	host   string // "http://localhost" untuk Unix socket, atau TCP URL

	// prevNet simpan counter network terakhir per container ID untuk hitung rate.
	prevNet map[string]netSample
}

type netSample struct {
	rx, tx uint64
	at     time.Time
}

func NewDockerClient() (*DockerClient, error) {
	socketPath := os.Getenv("DOCKER_HOST")
	if socketPath == "" {
		if runtime.GOOS == "windows" {
			socketPath = "//./pipe/docker_engine"
		} else {
			socketPath = "/var/run/docker.sock"
		}
	}
	socketPath = strings.TrimPrefix(socketPath, "unix://")

	// Verifikasi socket reachable
	if _, err := os.Stat(socketPath); err != nil {
		return nil, fmt.Errorf("docker socket not found: %w", err)
	}

	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{Timeout: 2 * time.Second}).DialContext(ctx, "unix", socketPath)
		},
	}
	return &DockerClient{
		client: &http.Client{Transport: transport, Timeout: 5 * time.Second},
		host:   "http://localhost",
	}, nil
}

type dockerContainer struct {
	ID    string   `json:"Id"`
	Names []string `json:"Names"`
	State string   `json:"State"`
}

// dockerStats: subset dari Docker API stats response.
type dockerStats struct {
	CPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs     int    `json:"online_cpus"`
	} `json:"cpu_stats"`
	PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemCPUUsage uint64 `json:"system_cpu_usage"`
	} `json:"precpu_stats"`
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Stats map[string]uint64 `json:"stats"`
		Limit uint64            `json:"limit"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
}

func (d *DockerClient) get(ctx context.Context, path string, v any) error {
	req, err := http.NewRequestWithContext(ctx, "GET", d.host+path, nil)
	if err != nil {
		return err
	}
	resp, err := d.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("docker API status %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(v)
}

// Stats fetch list container yang running + stats per container.
func (d *DockerClient) Stats() ([]ContainerStats, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var containers []dockerContainer
	if err := d.get(ctx, "/containers/json", &containers); err != nil {
		return nil, err
	}

	now := time.Now()
	newPrev := make(map[string]netSample, len(containers))
	result := make([]ContainerStats, 0, len(containers))
	for _, c := range containers {
		if c.State != "running" {
			continue
		}
		var stats dockerStats
		if err := d.get(ctx, "/containers/"+c.ID+"/stats?stream=false&one-shot=true", &stats); err != nil {
			continue
		}

		// CPU %: (delta_total / delta_system) * num_cpus * 100
		cpuDelta := float64(stats.CPUStats.CPUUsage.TotalUsage - stats.PreCPUStats.CPUUsage.TotalUsage)
		sysDelta := float64(stats.CPUStats.SystemCPUUsage - stats.PreCPUStats.SystemCPUUsage)
		numCPUs := stats.CPUStats.OnlineCPUs
		if numCPUs == 0 {
			numCPUs = 1
		}
		cpuPct := 0.0
		if sysDelta > 0 && cpuDelta > 0 {
			cpuPct = round2((cpuDelta / sysDelta) * float64(numCPUs) * 100.0)
		}

		// Memory: usage minus cache (Linux cgroup v1 reports cache as part of usage)
		memUsed := stats.MemoryStats.Usage
		if cache := stats.MemoryStats.Stats["cache"]; cache > 0 && cache < memUsed {
			memUsed -= cache
		} else if inactive := stats.MemoryStats.Stats["inactive_file"]; inactive > 0 && inactive < memUsed {
			memUsed -= inactive
		}

		// Network: counter Docker kumulatif sejak container start, ubah ke bytes/s
		var totalRx, totalTx uint64
		for _, n := range stats.Networks {
			totalRx += n.RxBytes
			totalTx += n.TxBytes
		}
		newPrev[c.ID] = netSample{rx: totalRx, tx: totalTx, at: now}
		var netRx, netTx uint64
		if prev, ok := d.prevNet[c.ID]; ok {
			if elapsed := now.Sub(prev.at).Seconds(); elapsed > 0 {
				if totalRx >= prev.rx {
					netRx = uint64(float64(totalRx-prev.rx) / elapsed)
				}
				if totalTx >= prev.tx {
					netTx = uint64(float64(totalTx-prev.tx) / elapsed)
				}
			}
		}

		name := c.ID
		if len(name) > 12 {
			name = name[:12]
		}
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}

		result = append(result, ContainerStats{
			Name:  name,
			CPU:   cpuPct,
			Mem:   memUsed,
			NetRx: netRx,
			NetTx: netTx,
		})
	}
	d.prevNet = newPrev
	return result, nil
}
