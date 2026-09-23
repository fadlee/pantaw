package main

import (
	"fmt"
	"log/slog"
	"runtime"
	"strings"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/load"
	"github.com/shirou/gopsutil/v4/mem"
	psnet "github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/sensors"
)

// Payload adalah body JSON yang dikirim ke /api/v1/ingest.
// Lihat RFC section 6.
type Payload struct {
	Ts         int64            `json:"ts"`
	CPU        float64          `json:"cpu"`
	Mem        float64          `json:"mem"`
	MemUsed    uint64           `json:"mem_used"`
	MemTotal   uint64           `json:"mem_total"`
	Disk       float64          `json:"disk"`
	DiskUsed   uint64           `json:"disk_used"`
	DiskTotal  uint64           `json:"disk_total"`
	DiskRead   uint64           `json:"disk_read"`
	DiskWrite  uint64           `json:"disk_write"`
	NetRx      uint64           `json:"net_rx"`
	NetTx      uint64           `json:"net_tx"`
	Load       [3]float64       `json:"load,omitempty"`
	Temp       *float64         `json:"temp,omitempty"`
	Uptime     uint64           `json:"uptime"`
	Containers []ContainerStats `json:"containers,omitempty"`
}

// ContainerStats per-container, masuk ke `extra` JSON di D1
// (lihat RFC keputusan #5).
type ContainerStats struct {
	Name  string  `json:"name"`
	CPU   float64 `json:"cpu"`
	Mem   uint64  `json:"mem"`
	NetRx uint64  `json:"net_rx,omitempty"`
	NetTx uint64  `json:"net_tx,omitempty"`
}

// Collector mengumpulkan metrik dengan state untuk delta tracking.
type Collector struct {
	cfg       *Config
	docker    *DockerClient
	prevDisk  map[string]disk.IOCountersStat
	prevNet   map[string]psnet.IOCountersStat
	prevTime  time.Time
	rootMount string
}

func NewCollector(cfg *Config) (*Collector, error) {
	c := &Collector{cfg: cfg, rootMount: "/"}

	if runtime.GOOS == "windows" {
		c.rootMount = "C:\\"
	}

	if cfg.Docker {
		dc, err := NewDockerClient()
		if err != nil {
			slog.Warn("docker disabled", "err", err)
		} else {
			c.docker = dc
		}
	}
	return c, nil
}

// Init sets baseline values for delta tracking (CPU/disk/net).
// Wajib dipanggil sekali sebelum Collect pertama.
func (c *Collector) Init() {
	// CPU baseline: panggilan pertama cpu.Percent(0, false) selalu return 0,
	// jadi panggil sekarang biar Collect berikutnya dapat usage real.
	_, _ = cpu.Percent(0, false)

	if ios, err := disk.IOCounters(); err == nil {
		c.prevDisk = ios
	}
	if nets, err := psnet.IOCounters(true); err == nil {
		c.prevNet = make(map[string]psnet.IOCountersStat, len(nets))
		for _, n := range nets {
			c.prevNet[n.Name] = n
		}
	}
	c.prevTime = time.Now()
}

func (c *Collector) Collect() (*Payload, error) {
	now := time.Now()
	elapsed := now.Sub(c.prevTime).Seconds()
	if elapsed < 1 {
		elapsed = 1
	}

	p := &Payload{Ts: now.Unix()}

	// CPU overall
	if pcts, err := cpu.Percent(0, false); err == nil && len(pcts) > 0 {
		p.CPU = round2(pcts[0])
	}

	// Memory
	if vm, err := mem.VirtualMemory(); err == nil {
		p.Mem = round2(vm.UsedPercent)
		p.MemUsed = vm.Used
		p.MemTotal = vm.Total
	}

	// Root disk usage
	if du, err := disk.Usage(c.rootMount); err == nil {
		p.Disk = round2(du.UsedPercent)
		p.DiskUsed = du.Used
		p.DiskTotal = du.Total
	}

	// Disk I/O delta (bytes/s)
	if ios, err := disk.IOCounters(); err == nil {
		var dr, dw uint64
		for name, io := range ios {
			if isVirtualDisk(name) {
				continue
			}
			if prev, ok := c.prevDisk[name]; ok {
				if io.ReadBytes >= prev.ReadBytes {
					dr += io.ReadBytes - prev.ReadBytes
				}
				if io.WriteBytes >= prev.WriteBytes {
					dw += io.WriteBytes - prev.WriteBytes
				}
			}
		}
		p.DiskRead = uint64(float64(dr) / elapsed)
		p.DiskWrite = uint64(float64(dw) / elapsed)
		c.prevDisk = ios
	}

	// Network I/O delta (bytes/s)
	if nets, err := psnet.IOCounters(true); err == nil {
		var rx, tx uint64
		newPrev := make(map[string]psnet.IOCountersStat, len(nets))
		for _, n := range nets {
			newPrev[n.Name] = n
			if isVirtualInterface(n.Name) {
				continue
			}
			if prev, ok := c.prevNet[n.Name]; ok {
				if n.BytesRecv >= prev.BytesRecv {
					rx += n.BytesRecv - prev.BytesRecv
				}
				if n.BytesSent >= prev.BytesSent {
					tx += n.BytesSent - prev.BytesSent
				}
			}
		}
		p.NetRx = uint64(float64(rx) / elapsed)
		p.NetTx = uint64(float64(tx) / elapsed)
		c.prevNet = newPrev
	}

	// Load average (1, 5, 15 min)
	if la, err := load.Avg(); err == nil {
		p.Load = [3]float64{round2(la.Load1), round2(la.Load5), round2(la.Load15)}
	}

	// Temperature (best-effort, CPU sensor)
	if t := getCPUTemp(); t != nil {
		p.Temp = t
	}

	// Uptime
	if uptime, err := host.Uptime(); err == nil {
		p.Uptime = uptime
	}

	// Docker containers (optional)
	if c.docker != nil {
		if containers, err := c.docker.Stats(); err == nil {
			p.Containers = containers
		} else {
			slog.Debug("docker stats failed", "err", err)
		}
	}

	c.prevTime = now
	return p, nil
}

// getCPUTemp mencari sensor temperatur CPU dari berbagai sumber yang umum.
// Return nil jika tidak ada sensor yang cocok.
func getCPUTemp() *float64 {
	temps, err := sensors.SensorsTemperatures()
	if err != nil || len(temps) == 0 {
		return nil
	}
	// Prioritas sensor key yang umum mengindikasikan CPU temperature
	priorities := []string{"coretemp", "k10temp", "cpu_thermal", "cpu", "package", "tctl", "tdie"}
	var fallback *float64
	for _, t := range temps {
		if t.Temperature <= 0 || t.Temperature > 200 {
			continue
		}
		key := strings.ToLower(t.SensorKey)
		v := round2(t.Temperature)
		for _, p := range priorities {
			if strings.Contains(key, p) {
				return &v
			}
		}
		if fallback == nil {
			fallback = &v
		}
	}
	return fallback
}

// isVirtualDisk skip device yang biasanya bukan physical disk (loop, ram, dm-).
func isVirtualDisk(name string) bool {
	prefixes := []string{"loop", "ram", "dm-", "md"}
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// isVirtualInterface skip loopback dan interface virtual (docker, veth, br-).
func isVirtualInterface(name string) bool {
	if name == "lo" || name == "lo0" {
		return true
	}
	prefixes := []string{"docker", "veth", "br-", "tun", "tap", "virbr"}
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

func round2(f float64) float64 {
	return float64(int64(f*100+0.5)) / 100
}

// EnsurePayloadValid memastikan payload tidak punya nilai aneh
// (NaN/Inf) yang gagal di-marshal.
func (p *Payload) sanitize() {
	if isBadFloat(p.CPU) {
		p.CPU = 0
	}
	if isBadFloat(p.Mem) {
		p.Mem = 0
	}
	if isBadFloat(p.Disk) {
		p.Disk = 0
	}
	for i, v := range p.Load {
		if isBadFloat(v) {
			p.Load[i] = 0
		}
	}
}

func isBadFloat(f float64) bool {
	return f != f || f > 1e15 || f < -1e15 // NaN check + sanity
}

// String representation untuk logging
func (p *Payload) String() string {
	return fmt.Sprintf("cpu=%.1f mem=%.1f disk=%.1f net=%d/%d", p.CPU, p.Mem, p.Disk, p.NetRx, p.NetTx)
}
