package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"time"
)

// backoffSteps untuk retry pada 5xx atau network error.
// Sesuai RFC section 5.
var backoffSteps = []time.Duration{5 * time.Second, 15 * time.Second, 60 * time.Second, 5 * time.Minute}

type Sender struct {
	cfg    *Config
	url    string
	client *http.Client
}

func NewSender(cfg *Config) *Sender {
	return &Sender{
		cfg: cfg,
		url: cfg.HubURL + "/api/v1/ingest",
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// Send POST payload ke hub dengan retry exponential backoff.
// Return nil setelah sukses ATAU setelah drop (non-retryable error).
// Caller tidak perlu retry ulang — agent akan kirim payload baru di interval berikutnya.
func (s *Sender) Send(ctx context.Context, p *Payload) error {
	p.sanitize()
	body, err := json.Marshal(p)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}

	// Coba pertama, lalu retry sesuai backoffSteps
	for attempt := 0; attempt <= len(backoffSteps); attempt++ {
		if attempt > 0 {
			wait := backoffSteps[attempt-1]
			slog.Info("retry", "attempt", attempt, "wait", wait)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
		}

		retry, err := s.do(ctx, body)
		if err == nil {
			return nil
		}
		if !retry {
			// Non-retryable: drop this payload, jangan retry
			slog.Warn("dropping payload", "err", err)
			return err
		}
	}
	return fmt.Errorf("max retries exceeded")
}

// do mengirim satu request. Return (retry, error):
//   - retry=false, err=nil → sukses, stop loop
//   - retry=false, err!=nil → non-retryable, drop payload
//   - retry=true, err!=nil → retryable, lanjut ke backoff berikutnya
func (s *Sender) do(ctx context.Context, body []byte) (bool, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", s.url, bytes.NewReader(body))
	if err != nil {
		return false, fmt.Errorf("new request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+s.cfg.Token)
	req.Header.Set("User-Agent", "pantaw-agent/"+Version)

	resp, err := s.client.Do(req)
	if err != nil {
		// Network error → retryable
		return true, fmt.Errorf("http: %w", err)
	}
	defer resp.Body.Close()

	switch {
	case resp.StatusCode >= 200 && resp.StatusCode < 300:
		return false, nil
	case resp.StatusCode == 429:
		// Rate limited: honor Retry-After tapi jangan retry di sini
		// (interval polling agent jauh > Retry-After umumnya)
		retryAfter := resp.Header.Get("Retry-After")
		slog.Warn("rate limited", "retry_after", retryAfter)
		// Sleep manual sesuai Retry-After untuk hindari banjir
		if n, err := strconv.Atoi(retryAfter); err == nil && n > 0 && n < 300 {
			select {
			case <-ctx.Done():
			case <-time.After(time.Duration(n) * time.Second):
			}
		}
		return false, nil
	case resp.StatusCode >= 400 && resp.StatusCode < 500:
		// 4xx (selain 429) = client error: token invalid, payload malformed,
		// clock skew. Tidak akan sembuh dengan retry.
		errMsg := readBodySnippet(resp.Body)
		return false, fmt.Errorf("client error %d: %s", resp.StatusCode, errMsg)
	default:
		// 5xx → retryable
		errMsg := readBodySnippet(resp.Body)
		return true, fmt.Errorf("server error %d: %s", resp.StatusCode, errMsg)
	}
}

func readBodySnippet(r io.Reader) string {
	const max = 256
	buf := make([]byte, max)
	n, _ := io.ReadFull(io.LimitReader(r, max), buf)
	return string(buf[:n])
}
