package main

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestPayloadSanitize(t *testing.T) {
	p := &Payload{
		Ts:   time.Now().Unix(),
		CPU:  math.NaN(),
		Mem:  math.Inf(1),
		Disk: -1e16,
		Load: [3]float64{math.NaN(), 1.5, math.Inf(-1)},
	}

	p.sanitize()

	if p.CPU != 0 {
		t.Errorf("expected CPU to be 0, got %f", p.CPU)
	}
	if p.Mem != 0 {
		t.Errorf("expected Mem to be 0, got %f", p.Mem)
	}
	if p.Disk != 0 {
		t.Errorf("expected Disk to be 0, got %f", p.Disk)
	}
	if p.Load[0] != 0 || p.Load[1] != 1.5 || p.Load[2] != 0 {
		t.Errorf("expected Load to be [0, 1.5, 0], got %v", p.Load)
	}
}

func TestSenderSuccess(t *testing.T) {
	receivedAuth := ""
	receivedContentType := ""
	var receivedPayload Payload

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/ingest" {
			http.NotFound(w, r)
			return
		}
		receivedAuth = r.Header.Get("Authorization")
		receivedContentType = r.Header.Get("Content-Type")
		_ = json.NewDecoder(r.Body).Decode(&receivedPayload)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	cfg := &Config{
		HubURL:     server.URL,
		Token:      "test-token-xyz",
		Interval:   30,
	}

	sender := NewSender(cfg)
	payload := &Payload{
		Ts:       1700000000,
		CPU:      42.5,
		Mem:      60.0,
		MemUsed:  6000,
		MemTotal: 10000,
		Disk:     25.0,
		NetRx:    1024,
		NetTx:    2048,
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := sender.Send(ctx, payload); err != nil {
		t.Fatalf("expected Send to succeed, got %v", err)
	}

	if receivedAuth != "Bearer test-token-xyz" {
		t.Errorf("unexpected Authorization header: %s", receivedAuth)
	}
	if receivedContentType != "application/json" {
		t.Errorf("unexpected Content-Type header: %s", receivedContentType)
	}
	if receivedPayload.CPU != 42.5 || receivedPayload.Ts != 1700000000 {
		t.Errorf("unexpected received payload: %+v", receivedPayload)
	}
}
